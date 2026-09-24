/**
 * The HTTP half of the QuickBooks adapter: OAuth2, one query endpoint, and
 * pagination (ADR 0026).
 *
 * It knows nothing about deductions. It hands `map.ts` validated JSON objects
 * and lets that file decide what a `LedgerInvoice` is.
 *
 * Everything outbound goes through `request`, so there is one place that sets the
 * `Request-Id` header, one place with a timeout, and one place that turns a
 * transport failure into a typed error rather than an empty list.
 */

import { randomUUID } from 'node:crypto';
import type { LedgerWindow } from '@recouple/adapters';
import { DateParseError, parsePrintedDate } from '@recouple/core-domain';
import {
  QboAuthError,
  QboInvalidWindow,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
} from './errors';
import { defaultFetch, request, retryAfterMs, summarise, type FetchLike } from './http';
import { assertQboId } from './ids';
import { exchangeIntuitToken } from './oauth';
import { describe, isJsonObject, readArray, readObject, type JsonObject } from './reader';
import { ACCESS_TOKEN_REFRESH_SKEW_MS, type QboTokenStore, type QboTokens } from './tokens';

// Where these lived before the OAuth calls moved to `oauth.ts`, `http.ts` and
// `ids.ts` (ADR 0039). Re-exported so every import of them from here still
// resolves to the one definition.
export { INTUIT_TOKEN_URL } from './oauth';
export { assertQboId } from './ids';
export type { FetchLike } from './http';

/** Injected, never defaulted: production is not a fallback for a missing config. */
export const QBO_SANDBOX_BASE_URL = 'https://sandbox-quickbooks.api.intuit.com';
export const QBO_PRODUCTION_BASE_URL = 'https://quickbooks.api.intuit.com';

/** QBO's own ceiling on `MAXRESULTS`. */
export const QBO_MAX_PAGE_SIZE = 1000;

/**
 * How many ids go in one `Id in (…)` query.
 *
 * Well under `QBO_MAX_PAGE_SIZE`, so a chunk's answer always fits one page, and
 * short enough that the statement stays a modest GET query string.
 */
export const QBO_IDS_PER_QUERY = 100;

/** The entities this adapter reads. There is deliberately nothing else here. */
export type QboEntity = 'Invoice' | 'Payment' | 'CreditMemo';

export interface QboConnectionConfig {
  /** The customer's QuickBooks company id. */
  readonly realmId: string;
  /** `QBO_SANDBOX_BASE_URL` or `QBO_PRODUCTION_BASE_URL`, chosen by the caller. */
  readonly baseUrl: string;
  /** Our Intuit app's credentials. Never read from `process.env` in here. */
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenStore: QboTokenStore;
  /** Defaults to the global `fetch`; tests inject a fake and never touch a network. */
  readonly fetchImpl?: FetchLike;
  /** Injectable clock, so expiry behaviour is testable without waiting an hour. */
  readonly now?: () => Date;
  readonly pageSize?: number;
  readonly timeoutMs?: number;
  /**
   * Intuit's `minorversion`. Omitted by default: an unset minor version gets the
   * base response shape, which is the one the fields we map belong to, whereas a
   * guessed version number is a guess about someone else's API.
   */
  readonly minorVersion?: string;
  /** A ceiling on pagination, so a server that never shortens a page cannot loop us forever. */
  readonly maxPages?: number;
}

export class QboClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly baseUrl: string;

  constructor(private readonly config: QboConnectionConfig) {
    if (config.baseUrl.trim() === '') {
      throw new QboRequestFailed('a QuickBooks base URL is required', 0, undefined);
    }
    if (config.realmId.trim() === '') {
      throw new QboRequestFailed('a QuickBooks realm id is required', 0, undefined);
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? defaultFetch();
    this.now = config.now ?? (() => new Date());
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxPages = config.maxPages ?? 1_000;

    const pageSize = config.pageSize ?? QBO_MAX_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > QBO_MAX_PAGE_SIZE) {
      throw new QboRequestFailed(
        `page size must be an integer in [1, ${QBO_MAX_PAGE_SIZE}], got ${describe(pageSize)}`,
        0,
        undefined,
      );
    }
    this.pageSize = pageSize;
  }

  /**
   * Every row of one entity over an inclusive window, following
   * `STARTPOSITION`/`MAXRESULTS` until a short page says there are no more.
   */
  async queryWindow(entity: QboEntity, window: LedgerWindow): Promise<readonly JsonObject[]> {
    const from = assertWindowDate(window.from, 'from');
    const to = assertWindowDate(window.to, 'to');
    if (from > to) {
      throw new QboInvalidWindow(`window runs backwards: from ${from} to ${to}`);
    }
    // The dates are interpolated, so they are validated above: `from` and `to`
    // have been proven to be `YYYY-MM-DD` calendar days and cannot carry a
    // quote out of the literal.
    return this.queryAll(entity, `TxnDate >= '${from}' and TxnDate <= '${to}'`);
  }

  /**
   * Every row of one entity whose `Id` is one of these, whatever its date
   * (ADR 0035 §2).
   *
   * Chunked at `QBO_IDS_PER_QUERY`, deduplicated, and every id proven to be
   * digits first, because each is interpolated between single quotes. Rows come
   * back in QBO's order within a chunk and chunk by chunk; an id QBO does not
   * have is simply not among them, and deciding whether that matters is the
   * caller's business.
   */
  async queryByIds(entity: QboEntity, ids: readonly string[]): Promise<readonly JsonObject[]> {
    const unique = [...new Set(ids.map((id) => assertQboId(id)))];
    const rows: JsonObject[] = [];
    for (let at = 0; at < unique.length; at += QBO_IDS_PER_QUERY) {
      const chunk = unique.slice(at, at + QBO_IDS_PER_QUERY);
      const list = chunk.map((id) => `'${id}'`).join(', ');
      const found = await this.queryAll(entity, `Id in (${list})`, rows.length);
      if (found.length > chunk.length) {
        throw new QboMalformedResponse(
          `asked for ${chunk.length} ${entity} rows by id and got ${found.length}`,
          `QueryResponse.${entity}`,
        );
      }
      rows.push(...found);
    }
    return rows;
  }

  /**
   * Every row of one entity matching a `where` clause the caller has already
   * made safe, following `STARTPOSITION`/`MAXRESULTS` until a short page says
   * there are no more. `offset` is only for error paths, so an index names the
   * row's position in the list a caller finally sees.
   */
  private async queryAll(
    entity: QboEntity,
    where: string,
    offset = 0,
  ): Promise<readonly JsonObject[]> {
    const rows: JsonObject[] = [];
    let startPosition = 1;

    for (let page = 0; page < this.maxPages; page += 1) {
      const statement =
        `select * from ${entity} where ${where} ` +
        `STARTPOSITION ${startPosition} MAXRESULTS ${this.pageSize}`;

      const body = await this.query(statement);
      const queryResponse = readObject(body['QueryResponse'], 'QueryResponse');
      const pageRows = readArray(queryResponse[entity], `QueryResponse.${entity}`);

      if (pageRows.length > this.pageSize) {
        throw new QboMalformedResponse(
          `asked for at most ${this.pageSize} ${entity} rows and got ${pageRows.length}`,
          `QueryResponse.${entity}`,
        );
      }

      // The index in the error path is the row's position across the whole
      // result, not its position on this page, so it matches the list a caller
      // sees.
      const base = offset + rows.length;
      pageRows.forEach((row, index) => {
        rows.push(readObject(row, `QueryResponse.${entity}[${base + index}]`));
      });

      if (pageRows.length < this.pageSize) return rows;
      startPosition += pageRows.length;
    }

    // Only reachable if every page came back full. Better a loud stop than an
    // unbounded loop against a customer's ledger.
    throw new QboMalformedResponse(
      `pagination did not terminate for ${entity} within ${this.maxPages} pages`,
      `QueryResponse.${entity}`,
    );
  }

  /** One `GET /v3/company/{realmId}/query` round trip. */
  private async query(statement: string): Promise<JsonObject> {
    const token = await this.accessToken();

    const url = new URL(`${this.baseUrl}/v3/company/${encodeURIComponent(this.config.realmId)}/query`);
    url.searchParams.set('query', statement);
    if (this.config.minorVersion !== undefined) {
      url.searchParams.set('minorversion', this.config.minorVersion);
    }

    const { response, text } = await request(
      this.fetchImpl,
      url.toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          // A fresh one per request. Intuit treats `Request-Id` as an
          // idempotency key, so a reused id can be answered from another call's
          // cached response — which on a read means silently stale ledger rows,
          // and on Phase 4's write-back would mean a duplicated transaction.
          'Request-Id': randomUUID(),
        },
      },
      this.timeoutMs,
    );

    if (response.status === 401) {
      throw new QboAuthError(
        `QuickBooks rejected the access token for realm ${this.config.realmId}: ${summarise(text)}`,
      );
    }
    if (response.status === 429) {
      throw new QboRateLimited(
        `QuickBooks rate-limited realm ${this.config.realmId}: ${summarise(text)}`,
        retryAfterMs(response),
      );
    }
    if (!response.ok) {
      throw new QboRequestFailed(
        `QuickBooks answered ${response.status} for realm ${this.config.realmId}: ${summarise(text)}`,
        response.status,
        faultFrom(text),
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new QboMalformedResponse(
        `QuickBooks answered ${response.status} with a body that is not JSON: ${summarise(text)}`,
        'body',
      );
    }
    return readObject(payload, 'body');
  }

  /**
   * The access token to use right now, refreshing first if it is close to
   * expiry. Proactive by design: waiting for a 401 turns a read that would have
   * worked a minute earlier into a customer-visible failure.
   */
  private async accessToken(): Promise<string> {
    const stored = await this.loadTokens();
    if (!this.needsRefresh(stored)) return stored.accessToken;

    // A refresh is serialized per company (ADR 0039 §5). Intuit replaces the
    // refresh token on every refresh, so two refreshes racing on one token leave
    // one of them holding a token Intuit has already killed. Under the lock the
    // tokens are read again: whoever held it before us may have rotated them
    // already, and refreshing a second time with the token they replaced is the
    // exact race the lock is for.
    return this.config.tokenStore.withRefreshLock(this.config.realmId, async () => {
      const current = await this.loadTokens();
      if (!this.needsRefresh(current)) return current.accessToken;
      const rotated = await this.refresh(current);
      return rotated.accessToken;
    });
  }

  private async loadTokens(): Promise<QboTokens> {
    const stored = await this.config.tokenStore.load(this.config.realmId);
    if (stored === undefined) {
      throw new QboAuthError(
        `no QuickBooks tokens are stored for realm ${this.config.realmId}: the connection has not been authorised`,
      );
    }
    return stored;
  }

  private needsRefresh(tokens: QboTokens): boolean {
    const expiresAt = Date.parse(tokens.accessExpiresAt);
    // An expiry we cannot read is treated as expired. Refreshing early costs a
    // round trip; using a token that has in fact expired costs a failed sync.
    if (Number.isNaN(expiresAt)) return true;
    return expiresAt - this.now().getTime() <= ACCESS_TOKEN_REFRESH_SKEW_MS;
  }

  /**
   * Exchanges the refresh token, **persists the rotation, and only then returns
   * it for use.**
   *
   * The order is the whole point. Intuit replaces the refresh token on every
   * refresh and kills the old one immediately, so a crash between "used the new
   * access token" and "saved the new refresh token" strands the connection and
   * the only repair is asking the customer for consent again.
   */
  private async refresh(stored: QboTokens): Promise<QboTokens> {
    const refreshExpiresAt = Date.parse(stored.refreshExpiresAt);
    if (!Number.isNaN(refreshExpiresAt) && refreshExpiresAt <= this.now().getTime()) {
      // Intuit's own expiry for this token, recorded when it was issued: the
      // sign-in is dead for good, and saying so lets the job release the
      // company rather than hold it (ADR 0046 §1).
      throw new QboAuthError(
        `the QuickBooks refresh token for realm ${this.config.realmId} expired at ` +
          `${stored.refreshExpiresAt}: the customer has to reconnect`,
        'refresh_expired',
      );
    }

    const rotated = await exchangeIntuitToken(
      { clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      { grantType: 'refresh_token', refreshToken: stored.refreshToken },
      `realm ${this.config.realmId}`,
      // The OAuth call's own, shorter timeout rather than a ledger read's: this
      // runs while the company's lock is held, and everybody else waits on it.
      { fetchImpl: this.fetchImpl, now: this.now },
    );

    // Save first. Use second. Never the other way round.
    await this.config.tokenStore.save(this.config.realmId, rotated);
    return rotated;
  }
}

/**
 * A window bound, proven to be a calendar day in `YYYY-MM-DD`.
 *
 * This is not politeness. `from` and `to` are interpolated into QBO's query
 * language inside single quotes, so an unchecked string is query injection into
 * a customer's ledger. The ISO shape is required first, then core-domain's
 * `parsePrintedDate` rejects `2026-02-31` — the same validator the rest of the
 * system uses for a date.
 */
export function assertWindowDate(value: string, which: 'from' | 'to'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new QboInvalidWindow(
      `window.${which} must be an ISO date (YYYY-MM-DD), got ${describe(value)}`,
    );
  }
  try {
    return parsePrintedDate(value);
  } catch (error) {
    if (error instanceof DateParseError) {
      throw new QboInvalidWindow(`window.${which} is not a calendar day: ${error.message}`);
    }
    throw error;
  }
}

/** Intuit's `Fault` object, if the body carried one. */
function faultFrom(text: string): unknown {
  try {
    const payload: unknown = JSON.parse(text);
    if (isJsonObject(payload) && payload['Fault'] !== undefined) return payload['Fault'];
  } catch {
    // Not JSON. The message already carries the raw body.
  }
  return undefined;
}
