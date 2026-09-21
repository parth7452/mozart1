/**
 * The HTTP half of the QuickBooks adapter: OAuth2, one query endpoint, and
 * pagination (ADR 0026).
 *
 * It knows nothing about deductions. It hands `map.ts` validated JSON objects
 * and lets that file decide what a `LedgerInvoice` is.
 *
 * Everything outbound goes through `send`, so there is one place that sets the
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
import { describe, isJsonObject, readArray, readObject, type JsonObject } from './reader';
import { ACCESS_TOKEN_REFRESH_SKEW_MS, type QboTokenStore, type QboTokens } from './tokens';

/** Injected, never defaulted: production is not a fallback for a missing config. */
export const QBO_SANDBOX_BASE_URL = 'https://sandbox-quickbooks.api.intuit.com';
export const QBO_PRODUCTION_BASE_URL = 'https://quickbooks.api.intuit.com';

/** One endpoint for both sandbox and production — Intuit does not split it. */
export const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/** QBO's own ceiling on `MAXRESULTS`. */
export const QBO_MAX_PAGE_SIZE = 1000;

/** The entities this adapter reads. There is deliberately nothing else here. */
export type QboEntity = 'Invoice' | 'Payment' | 'CreditMemo';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
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

    const rows: JsonObject[] = [];
    let startPosition = 1;

    for (let page = 0; page < this.maxPages; page += 1) {
      // The dates are interpolated, so they are validated above: `from` and `to`
      // have been proven to be `YYYY-MM-DD` calendar days and cannot carry a
      // quote out of the literal.
      const statement =
        `select * from ${entity} where TxnDate >= '${from}' and TxnDate <= '${to}' ` +
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
      // window, not its position on this page, so it matches the list a caller
      // sees.
      const base = rows.length;
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

    const response = await this.send(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        // A fresh one per request. Intuit treats `Request-Id` as an idempotency
        // key, so a reused id can be answered from another call's cached
        // response — which on a read means silently stale ledger rows, and on
        // Phase 4's write-back would mean a duplicated transaction.
        'Request-Id': randomUUID(),
      },
    });

    const text = await this.bodyText(response, url.toString());

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
    const stored = await this.config.tokenStore.load(this.config.realmId);
    if (stored === undefined) {
      throw new QboAuthError(
        `no QuickBooks tokens are stored for realm ${this.config.realmId}: the connection has not been authorised`,
      );
    }
    if (!this.needsRefresh(stored)) return stored.accessToken;
    const rotated = await this.refresh(stored);
    return rotated.accessToken;
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
      throw new QboAuthError(
        `the QuickBooks refresh token for realm ${this.config.realmId} expired at ` +
          `${stored.refreshExpiresAt}: the customer has to reconnect`,
      );
    }

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, 'utf8').toString(
      'base64',
    );

    const response = await this.send(INTUIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'Request-Id': randomUUID(),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
      }).toString(),
    });

    const text = await this.bodyText(response, INTUIT_TOKEN_URL);
    if (!response.ok) {
      throw new QboAuthError(
        `Intuit refused the token refresh for realm ${this.config.realmId} ` +
          `(${response.status}): ${summarise(text)}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new QboAuthError(
        `Intuit's token response was not JSON for realm ${this.config.realmId}: ${summarise(text)}`,
      );
    }
    if (!isJsonObject(payload)) {
      throw new QboAuthError(
        `Intuit's token response was not an object for realm ${this.config.realmId}: ${describe(payload)}`,
      );
    }

    const issuedAt = this.now().getTime();
    const rotated: QboTokens = {
      accessToken: tokenField(payload, 'access_token', this.config.realmId),
      refreshToken: tokenField(payload, 'refresh_token', this.config.realmId),
      accessExpiresAt: new Date(
        issuedAt + lifetimeField(payload, 'expires_in', this.config.realmId) * 1000,
      ).toISOString(),
      refreshExpiresAt: new Date(
        issuedAt + lifetimeField(payload, 'x_refresh_token_expires_in', this.config.realmId) * 1000,
      ).toISOString(),
    };

    // Save first. Use second. Never the other way round.
    await this.config.tokenStore.save(this.config.realmId, rotated);
    return rotated;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: abort.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new QboRequestFailed(
          `QuickBooks did not answer within ${this.timeoutMs}ms (${redactUrl(url)})`,
          0,
          undefined,
        );
      }
      throw new QboRequestFailed(
        `the request to QuickBooks failed before any response (${redactUrl(url)}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        0,
        undefined,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async bodyText(response: Response, url: string): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new QboRequestFailed(
        `could not read QuickBooks' response body (${redactUrl(url)}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        response.status,
        undefined,
      );
    }
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

function tokenField(payload: JsonObject, key: string, realmId: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') {
    throw new QboAuthError(
      `Intuit's token response for realm ${realmId} has no usable ${key}: ${describe(value)}`,
    );
  }
  return value;
}

function lifetimeField(payload: JsonObject, key: string, realmId: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QboAuthError(
      `Intuit's token response for realm ${realmId} has no usable ${key}: ${describe(value)}`,
    );
  }
  return value;
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date, or nothing. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim() === '') return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());

  // Unreadable. `undefined` says "we do not know", which beats inventing a
  // backoff the caller would then trust.
  return undefined;
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

function summarise(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '(empty body)';
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

/** A URL for an error message, without the query — it carries the ledger filter. */
function redactUrl(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}
