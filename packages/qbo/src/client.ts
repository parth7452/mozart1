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
  QboAccountReadBackError,
  QboAuthError,
  QboChartTooLarge,
  QboInvalidWindow,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
  type QboError,
} from './errors';
import { defaultFetch, request, retryAfterMs, summarise, type FetchLike } from './http';
import { assertQboId } from './ids';
import { exchangeIntuitToken } from './oauth';
import { describe, isJsonObject, readArray, readObject, type JsonObject } from './reader';
import type { QboReportName } from './reports';
import {
  SETUP_ACCOUNTS,
  accountReadBackMismatch,
  readAccountId,
  setupRowOf,
  toQboAccount,
  type QboAccount,
  type SetupAccountSpec,
} from './setup';
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

/** The entities a write-back creates (ADR 0060 §1). */
export type QboWriteEntity = 'JournalEntry' | 'Payment';

/**
 * Every entity this client creates and reads back: a write-back's, and the
 * `Account` setup creates (ADR 0063). `Account` stays out of `QboWriteEntity`
 * on purpose: the posting job is typed on that one, so it cannot create an
 * account, and `findByReference` has no reference to find one by.
 */
type QboCreatedEntity = QboWriteEntity | 'Account';

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
    entity: QboEntity | 'Account',
    where: string,
    offset = 0,
    /**
     * What a read still going at `maxPages` is: a server that never shortens a
     * page, unless the caller says otherwise — `listAccounts` says a chart
     * longer than the pages it was allowed.
     */
    unended?: () => QboError,
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
    throw (
      unended?.() ??
      new QboMalformedResponse(
        `pagination did not terminate for ${entity} within ${this.maxPages} pages`,
        `QueryResponse.${entity}`,
      )
    );
  }

  /** One `GET /v3/company/{realmId}/query` round trip. */
  private async query(statement: string): Promise<JsonObject> {
    // A fresh request id per read. Intuit treats `Request-Id` as an
    // idempotency key, so a reused id can be answered from another call's
    // cached response — which on a read means silently stale ledger rows.
    return this.call('GET', 'query', { query: statement }, randomUUID(), undefined);
  }

  /**
   * Creates one entity (ADR 0060 §3). `requestId` is the caller's — the
   * `writebacks` row id — and is sent as both the `requestid` query parameter
   * and the `Request-Id` header, so a resend of the same row is the same
   * request to Intuit whichever one it honours. Returns the created entity.
   */
  async post(entity: QboWriteEntity, body: JsonObject, requestId: string): Promise<JsonObject> {
    return this.create(entity, body, requestId);
  }

  /**
   * The company's whole chart of accounts, inactive accounts included, for
   * setting up posting (ADR 0063 §1). QuickBooks answers an `Account` query
   * with active accounts only unless asked for both, and an inactive account
   * still holds its name — which is what setup has to know before it creates
   * one. Paged like every other read, each row read by `toQboAccount`, and an
   * id listed twice refused rather than counted twice.
   *
   * A chart that has not ended by the client's `maxPages` is
   * `QboChartTooLarge`, never the part of it read: a settings request builds
   * its client with a page or two, so that its read ends inside its route's
   * time (ADR 0063 §2), and a name missing from part of a chart is not missing
   * from the company.
   */
  async listAccounts(): Promise<readonly QboAccount[]> {
    const rows = await this.listAccountRows();
    return rows.map((row, index) => toQboAccount(row, `Account[${index}]`));
  }

  /**
   * `listAccounts`' read, as the rows QuickBooks sent: the same query, the
   * same bound (`QboChartTooLarge`), and the same refusal of an id listed
   * twice. For a reader that wants more of a row than setup does — the Books
   * page's account code and classification (`toLedgerAccount`, ADR 0066 §1).
   * Every row has been read once by `toQboAccount` before it is returned.
   */
  async listAccountRows(): Promise<readonly JsonObject[]> {
    const rows = await this.queryAll(
      'Account',
      'Active in (true, false)',
      0,
      () => new QboChartTooLarge(this.maxPages, this.pageSize),
    );
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const path = `Account[${index}]`;
      const account = toQboAccount(row, path);
      if (seen.has(account.id)) {
        throw new QboMalformedResponse(`account ${account.id} is listed twice`, `${path}.Id`);
      }
      seen.add(account.id);
    });
    return rows;
  }

  /**
   * One `GET /v3/company/{realmId}/reports/{name}` round trip (ADR 0066 §1):
   * a read, under a fresh request id like every other. The Reports API does
   * not paginate, so this is the whole report or — past Intuit's cell limit —
   * one that says it was cut short, which `reports.ts` refuses.
   *
   * `params` are the caller's and are sent as query parameters, so each value
   * is proven here to be dates, digits, commas and Intuit's own column keys:
   * nothing a customer typed reaches the URL.
   */
  async report(
    name: QboReportName,
    params: Readonly<Record<string, string>>,
  ): Promise<JsonObject> {
    for (const [key, value] of Object.entries(params)) {
      if (!/^[a-z_]{1,40}$/.test(key) || !/^[A-Za-z0-9_,-]{1,4000}$/.test(value)) {
        throw new QboRequestFailed(`a report parameter is not one this client sends: ${key}`, 0, undefined);
      }
    }
    return this.call('GET', `reports/${name}`, params, randomUUID(), undefined);
  }

  /**
   * Creates one of setup's two accounts, then reads it back (ADR 0063 §2).
   *
   * `spec` must be one of `SETUP_ACCOUNTS` exactly, or `QboInvalidAccountSpec`
   * refuses it before a request is built: this client creates no other
   * account. `requestId` is the caller's `postingSetupRequestId` for this
   * attempt, sent the way `post` sends a write-back's, so a press that sends
   * again a create no answer came for is the same request to Intuit. Nothing
   * here retries: a 5xx or a timeout is an unknown outcome, thrown as
   * `QboRequestFailed`, and the next press re-reads the chart and finds the
   * account if it was made.
   *
   * The account is read back by the id QuickBooks answered with, under a fresh
   * request id, and returned only if its id, name, type and `Active` are what
   * was sent. `QboAccountReadBackError` names the fields that are not; nothing
   * is changed in QuickBooks to put them right.
   */
  async createAccount(spec: SetupAccountSpec, requestId: string): Promise<QboAccount> {
    const fixed = SETUP_ACCOUNTS[setupRowOf(spec)];
    const created = await this.create(
      'Account',
      { Name: fixed.name, AccountType: fixed.accountType, AccountSubType: fixed.accountSubType },
      requestId,
    );
    const accountId = readAccountId(created, 'Account');
    const got = await this.read('Account', accountId);
    const mismatch = accountReadBackMismatch(fixed, accountId, got);
    if (mismatch.length > 0) throw new QboAccountReadBackError(accountId, mismatch);
    return toQboAccount(got, 'Account');
  }

  /** `post`'s request, for any entity this client creates. */
  private async create(
    entity: QboCreatedEntity,
    body: JsonObject,
    requestId: string,
  ): Promise<JsonObject> {
    const id = assertRequestId(requestId);
    const payload = await this.call(
      'POST',
      entity.toLowerCase(),
      { requestid: id },
      id,
      JSON.stringify(body),
    );
    return readObject(payload[entity], entity);
  }

  /**
   * Finds what we posted by the reference we stamped on it (`DocNumber` on a
   * JournalEntry, `PaymentRefNum` on a Payment), so a person's retry can read
   * back before it sends again (ADR 0060 §3). Refuses anything that is not
   * one of our own references, since it is spliced into a query. Answers the
   * rows found: none, one, or — never ours to resolve — more.
   */
  async findByReference(entity: QboWriteEntity, reference: string): Promise<readonly JsonObject[]> {
    if (!/^RC[0-9a-f]{19}$/.test(reference)) {
      throw new QboMalformedResponse('a posting reference is RC plus 19 hex digits', 'reference');
    }
    const field = entity === 'JournalEntry' ? 'DocNumber' : 'PaymentRefNum';
    const body = await this.query(`select * from ${entity} where ${field} = '${reference}'`);
    const queryResponse = readObject(body['QueryResponse'], 'QueryResponse');
    return readArray(queryResponse[entity], `QueryResponse.${entity}`).map((row, index) =>
      readObject(row, `QueryResponse.${entity}[${index}]`),
    );
  }

  /**
   * Each named account's `AccountType`, read live, for checking an account
   * map before it is saved (ADR 0060 §4). An id QuickBooks does not have is
   * absent from the answer. It creates nothing: the only accounts this client
   * ever creates are setup's two (`createAccount`, ADR 0063).
   */
  async accountTypes(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(ids.map((id) => assertQboId(id)))];
    const types = new Map<string, string>();
    for (let at = 0; at < unique.length; at += QBO_IDS_PER_QUERY) {
      const chunk = unique.slice(at, at + QBO_IDS_PER_QUERY);
      const list = chunk.map((id) => `'${id}'`).join(', ');
      for (const row of await this.queryAll('Account', `Id in (${list})`)) {
        const id = row['Id'];
        const type = row['AccountType'];
        if (typeof id === 'string' && typeof type === 'string') types.set(id, type);
      }
    }
    return types;
  }

  /** Reads one entity back by its QuickBooks id, with a fresh request id. */
  async getById(entity: QboWriteEntity, id: string): Promise<JsonObject> {
    return this.read(entity, id);
  }

  /** `getById`'s request, for any entity this client creates. */
  private async read(entity: QboCreatedEntity, id: string): Promise<JsonObject> {
    const qboId = assertQboId(id);
    const payload = await this.call(
      'GET',
      `${entity.toLowerCase()}/${qboId}`,
      {},
      randomUUID(),
      undefined,
    );
    return readObject(payload[entity], entity);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    params: Readonly<Record<string, string>>,
    requestId: string,
    body: string | undefined,
  ): Promise<JsonObject> {
    const token = await this.accessToken();

    const url = new URL(
      `${this.baseUrl}/v3/company/${encodeURIComponent(this.config.realmId)}/${path}`,
    );
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (this.config.minorVersion !== undefined) {
      url.searchParams.set('minorversion', this.config.minorVersion);
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'Request-Id': requestId,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const { response, text } = await request(
      this.fetchImpl,
      url.toString(),
      { method, headers, ...(body !== undefined ? { body } : {}) },
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
/** A caller's idempotency key: a UUID (the `writebacks` row id), nothing else. */
export function assertRequestId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new QboRequestFailed(
      `a QuickBooks request id must be a UUID, got ${describe(value)}`,
      0,
      undefined,
    );
  }
  return value.toLowerCase();
}

function faultFrom(text: string): unknown {
  try {
    const payload: unknown = JSON.parse(text);
    if (isJsonObject(payload) && payload['Fault'] !== undefined) return payload['Fault'];
  } catch {
    // Not JSON. The message already carries the raw body.
  }
  return undefined;
}
