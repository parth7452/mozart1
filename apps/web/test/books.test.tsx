import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAccountingSource } from '@recouple/adapters/testing';
import { REASON_FAMILIES, cents, type LedgerAccount, type ReasonFamily } from '@recouple/core-domain';
import {
  INTUIT_TOKEN_URL,
  QBO_SANDBOX_BASE_URL,
  QboAccountingSource,
  QboAuthError,
  QboChartTooLarge,
  QboInvalidWindow,
  QboMalformedResponse,
  QboRateLimited,
  QboReportTooLarge,
  QboRequestFailed,
  type FetchLike,
  type QboTokens,
} from '@recouple/qbo';
import { InMemoryQboTokenStore } from '@recouple/qbo/testing';
import {
  CredentialUnreadableError,
  LedgerAccountBusyError,
  type BooksCasesRead,
  type PostingConnectionView,
} from '@recouple/store-postgres';

vi.mock('../lib/env', () => ({
  env: {
    get databaseUrl(): string {
      throw new Error('a deployment that cannot read QuickBooks must not reach for the database');
    },
  },
}));

const {
  BOOKS_CHART_MAX_PAGES,
  BOOKS_READ_TIMEOUT_MS,
  BooksRefreshRefusedError,
  booksFor,
  booksRequestFrom,
  booksSourcesFromEnv,
  failureOf,
  postingAccountIds,
  withoutRefresh,
} = await import('../lib/books');
type BooksSources = import('../lib/books').BooksSources;

/**
 * The Books page's read, below the page (ADR 0066 §1–§3): that a deployment
 * which cannot read QuickBooks builds no source rather than one that reads
 * without a token store; that a member whose refresh could not be stored never
 * causes one; and what a failure is shown as.
 */

const IDENTITY = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };
const CONNECTION = { connectionId: '44444444-4444-4444-8444-444444444444', realmId: '4620816365' };
const NOW = new Date('2026-09-30T12:00:00Z');
const NO_CASES: BooksCasesRead = { rows: [], total: 0, limit: 500 };

const APP = {
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_ENVIRONMENT: 'sandbox',
};

describe('booksSourcesFromEnv fails closed', () => {
  it('builds no source without the Intuit app, whoever asks', () => {
    for (const mayRefresh of [true, false]) {
      expect(booksSourcesFromEnv({}).sourceFor(IDENTITY, CONNECTION, { mayRefresh })).toBeUndefined();
      expect(
        booksSourcesFromEnv({ QBO_CLIENT_ID: 'only-this' }).sourceFor(IDENTITY, CONNECTION, { mayRefresh }),
      ).toBeUndefined();
    }
  });

  it('builds no source without the token key: never a reader with no token store', () => {
    // The database is never reached for either — `env.databaseUrl` throws here.
    expect(booksSourcesFromEnv(APP).sourceFor(IDENTITY, CONNECTION, { mayRefresh: true })).toBeUndefined();
    expect(
      booksSourcesFromEnv({ ...APP, QBO_TOKEN_KMS_KEY_ID: '  ' }).sourceFor(IDENTITY, CONNECTION, {
        mayRefresh: true,
      }),
    ).toBeUndefined();
  });

  it('does not wait on QBO_POSTING: reading the books is not posting to them', () => {
    const configured = {
      ...APP,
      QBO_TOKEN_KMS_KEY_ID: 'alias/recouple-qbo-tokens',
      AWS_REGION: 'us-east-1',
      DATABASE_URL: 'postgres://not-used.example/books',
    };
    expect(configured).not.toHaveProperty('QBO_POSTING');
    const source = booksSourcesFromEnv(configured).sourceFor(IDENTITY, CONNECTION, { mayRefresh: true });
    expect(source).toBeInstanceOf(QboAccountingSource);
  });

  it('shows a misconfigured deployment as unreadable rather than throwing at the member', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const books = await booksFor(
        booksSourcesFromEnv({ ...APP, QBO_ENVIRONMENT: 'prod' }),
        IDENTITY,
        [{ ...CONNECTION, postingEnabled: false, map: undefined }],
        { request: booksRequestFrom({}, NOW), asOf: '2026-09-30', mayRefresh: true, cases: NO_CASES },
      );
      expect(books).toEqual([
        {
          kind: 'read',
          ...CONNECTION,
          mapped: false,
          chart: { kind: 'unreadable', failure: 'failed' },
          trialBalance: { kind: 'skipped' },
          ledger: { kind: 'skipped' },
          reconciliation: { kind: 'skipped' },
        },
      ]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('says not_configured for every connection when no source can be built', async () => {
    const books = await booksFor(
      booksSourcesFromEnv({}),
      IDENTITY,
      [{ ...CONNECTION, postingEnabled: false, map: undefined }],
      { request: booksRequestFrom({}, NOW), asOf: '2026-09-30', mayRefresh: true, cases: NO_CASES },
    );
    expect(books).toEqual([{ kind: 'not_configured', ...CONNECTION }]);
  });

  it('bounds the reads the way Settings → QuickBooks bounds its chart read', () => {
    expect(BOOKS_READ_TIMEOUT_MS).toBe(10_000);
    expect(BOOKS_CHART_MAX_PAGES).toBe(2);
  });
});

describe('withoutRefresh', () => {
  const clock = new Date('2026-09-30T12:00:00Z');
  const tokens = (minutesLeft: number): QboTokens => ({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    accessExpiresAt: new Date(clock.getTime() + minutesLeft * 60_000).toISOString(),
    refreshExpiresAt: new Date(clock.getTime() + 90 * 24 * 3600_000).toISOString(),
  });

  function quickBooks() {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      urls.push(input);
      if (input === INTUIT_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: 'access-token-2',
            refresh_token: 'refresh-token-2',
            expires_in: 3600,
            x_refresh_token_expires_in: 8_640_000,
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ QueryResponse: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { urls, fetchImpl };
  }

  function sourceOver(store: InMemoryQboTokenStore, fetchImpl: FetchLike, refuse: boolean) {
    return new QboAccountingSource({
      realmId: CONNECTION.realmId,
      baseUrl: QBO_SANDBOX_BASE_URL,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenStore: refuse ? withoutRefresh(store) : store,
      fetchImpl,
      now: () => clock,
    });
  }

  it('refuses a stale token before anything is exchanged with Intuit', async () => {
    const store = new InMemoryQboTokenStore({ [CONNECTION.realmId]: tokens(1) });
    const { urls, fetchImpl } = quickBooks();

    await expect(sourceOver(store, fetchImpl, true).chartOfAccounts()).rejects.toBeInstanceOf(
      BooksRefreshRefusedError,
    );
    // Not the token endpoint, not the API: nothing left this process.
    expect(urls).toEqual([]);
    expect(store.saves).toEqual([]);
    expect((await store.load(CONNECTION.realmId))?.refreshToken).toBe('refresh-token-1');
  });

  it('is what stops it: the same stale token refreshes for a member who may write', async () => {
    const store = new InMemoryQboTokenStore({ [CONNECTION.realmId]: tokens(1) });
    const { urls, fetchImpl } = quickBooks();

    await expect(sourceOver(store, fetchImpl, false).chartOfAccounts()).resolves.toEqual([]);
    expect(urls[0]).toBe(INTUIT_TOKEN_URL);
    // Saved before it was used (ADR 0026), as every refresh is.
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.tokens.refreshToken).toBe('refresh-token-2');
  });

  it('reads with a token that is still good', async () => {
    const store = new InMemoryQboTokenStore({ [CONNECTION.realmId]: tokens(55) });
    const { urls, fetchImpl } = quickBooks();

    await expect(sourceOver(store, fetchImpl, true).chartOfAccounts()).resolves.toEqual([]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toBe(INTUIT_TOKEN_URL);
    expect(store.saves).toEqual([]);
  });

  it('refuses a save too, and quotes no token', async () => {
    const store = new InMemoryQboTokenStore();
    const error = await withoutRefresh(store)
      .save(CONNECTION.realmId, tokens(55))
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(BooksRefreshRefusedError);
    expect((error as Error).message).not.toContain('access-token-1');
    expect(store.saves).toEqual([]);
  });
});

describe('failureOf', () => {
  it('shows each failure as a fixed code, from its class and never its message', () => {
    expect(failureOf(new BooksRefreshRefusedError('1'))).toBe('refresh_needs_writer');
    expect(failureOf(new QboAuthError('x', 'grant_refused'))).toBe('sign_in_refused');
    expect(failureOf(new QboAuthError('x', 'refresh_expired'))).toBe('sign_in_expired');
    expect(failureOf(new QboAuthError('x'))).toBe('not_authorised');
    expect(failureOf(new QboRateLimited('x', undefined))).toBe('rate_limited');
    expect(failureOf(new QboChartTooLarge(2, 1000))).toBe('chart_too_large');
    expect(failureOf(new QboReportTooLarge('cut_short'))).toBe('report_too_large');
    expect(failureOf(new QboMalformedResponse('x', 'y'))).toBe('unexpected_shape');
    expect(failureOf(new QboInvalidWindow('x'))).toBe('window_refused');
    expect(failureOf(new QboRequestFailed('x', 503, undefined))).toBe('unreachable');
    expect(failureOf(new LedgerAccountBusyError('qbo', '1'))).toBe('busy');
    expect(failureOf(new Error('grant_refused'))).toBe('failed');
    expect(failureOf('a string')).toBe('failed');
    expect(failureOf(Object.create(CredentialUnreadableError.prototype))).toBe('credential_unreadable');
  });
});

describe('booksFor', () => {
  const account = (externalId: string, name: string, accountType: string): LedgerAccount => ({
    sourceKind: 'qbo',
    externalId,
    name,
    fullyQualifiedName: name,
    accountType,
    active: true,
  });
  const map = {
    mapId: '66666666-6666-4666-8666-666666666666',
    arAccountId: '84',
    deductionsReceivableAccountId: '91',
    writeoffByFamily: Object.fromEntries(
      REASON_FAMILIES.map((family, index) => [family, index === 0 ? '98' : '97']),
    ) as Record<ReasonFamily, string>,
    unclassifiedWriteoff: '97',
  };
  const connection: PostingConnectionView = { ...CONNECTION, postingEnabled: true, map };

  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errors.mockRestore();
  });

  it('names every account a map posts deductions to, once, and never the receivable', () => {
    expect([...postingAccountIds(connection)].sort()).toEqual(['91', '97', '98']);
    expect(postingAccountIds({ ...connection, map: undefined })).toEqual([]);
  });

  it('reconciles only the postings on posting and deductions accounts', async () => {
    const memory = new InMemoryAccountingSource({
      accounts: [
        account('84', 'Accounts Receivable', 'Accounts Receivable'),
        account('91', 'Held', 'Other Current Asset'),
        account('97', 'Write-offs', 'Expense'),
        account('35', 'Checking', 'Bank'),
      ],
      ledgerLines: [
        { accountExternalId: '84', accountName: 'Accounts Receivable', date: '2026-09-18', debitCents: cents(0), creditCents: cents(50_000) },
        { accountExternalId: '91', accountName: 'Held', date: '2026-09-18', debitCents: cents(50_000), creditCents: cents(0) },
        { accountExternalId: '35', accountName: 'Checking', date: '2026-09-18', debitCents: cents(50_000), creditCents: cents(0) },
      ],
    });
    const sources: BooksSources = { sourceFor: () => memory };
    const cases: BooksCasesRead = {
      rows: [{ deductionId: 'case-1', state: 'classified', amountCents: 50_000, deductionDate: '2026-09-18', payerMatched: false }],
      total: 1,
      limit: 500,
    };
    const [books] = await booksFor(sources, IDENTITY, [connection], {
      request: booksRequestFrom({ accounts: 'all' }, NOW),
      asOf: '2026-09-30',
      mayRefresh: true,
      cases,
    });
    if (books?.kind !== 'read' || books.reconciliation.kind !== 'read') throw new Error('expected a read');
    // Three postings of $500.00 on one day; only the one on the held account is
    // compared, so it is one line to one case — a match — and not three.
    expect(books.reconciliation.value.linesCompared).toBe(1);
    expect(books.reconciliation.value.rows).toHaveLength(1);
    expect(books.reconciliation.value.rows[0]).toMatchObject({
      kind: 'matched',
      line: { accountExternalId: '91' },
      case: { caseId: 'case-1' },
    });
    expect(books.mapped).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('reads nothing of the ledger when no account has a role, and asks the ledger nothing', async () => {
    const memory = new InMemoryAccountingSource({ accounts: [account('35', 'Checking', 'Bank')] });
    const asked: unknown[] = [];
    const sources: BooksSources = {
      sourceFor: () => ({
        chartOfAccounts: () => memory.chartOfAccounts(),
        trialBalance: (asOf) => memory.trialBalance(asOf),
        generalLedger: (window, options) => {
          asked.push(options?.accountIds);
          return memory.generalLedger(window, options);
        },
      }),
    };
    const [books] = await booksFor(sources, IDENTITY, [{ ...connection, map: undefined }], {
      request: booksRequestFrom({}, NOW),
      asOf: '2026-09-30',
      mayRefresh: true,
      cases: NO_CASES,
    });
    expect(asked).toEqual([[]]);
    if (books?.kind !== 'read' || books.ledger.kind !== 'read') throw new Error('expected a read');
    expect(books.ledger.value.ledger.accounts).toEqual([]);
  });

  it('logs a failure by class and ids, never by what it said', async () => {
    const sources: BooksSources = {
      sourceFor: () => ({
        chartOfAccounts: async () => {
          throw new QboRequestFailed('QuickBooks answered 503: <html>secret-body</html>', 503, undefined);
        },
        trialBalance: async () => {
          throw new QboRequestFailed('secret-body again', 0, undefined);
        },
        generalLedger: async () => {
          throw new Error('unreachable in this test');
        },
      }),
    };
    const [books] = await booksFor(sources, IDENTITY, [connection], {
      request: booksRequestFrom({}, NOW),
      asOf: '2026-09-30',
      mayRefresh: true,
      cases: NO_CASES,
    });
    expect(books).toMatchObject({
      chart: { kind: 'unreadable', failure: 'unreachable' },
      trialBalance: { kind: 'unreadable', failure: 'unreachable' },
      ledger: { kind: 'skipped' },
      reconciliation: { kind: 'skipped' },
    });
    const logged = errors.mock.calls.map((call) => call.join(' '));
    expect(logged).toEqual([
      `[recouple] books: chart of accounts unreadable (QboRequestFailed, HTTP 503), connection ${CONNECTION.connectionId} org ${IDENTITY.orgId}`,
      `[recouple] books: trial balance unreadable (QboRequestFailed), connection ${CONNECTION.connectionId} org ${IDENTITY.orgId}`,
    ]);
    expect(logged.join('\n')).not.toContain('secret-body');
  });
});
