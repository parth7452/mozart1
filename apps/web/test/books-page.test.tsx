import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAccountingSource } from '@recouple/adapters/testing';
import {
  REASON_FAMILIES,
  cents,
  type GeneralLedgerLine,
  type LedgerAccount,
  type ReasonFamily,
  type TrialBalanceLine,
} from '@recouple/core-domain';
import { QboAuthError, QboMalformedResponse, QboReportTooLarge } from '@recouple/qbo';
import type { BooksCasesRead, PostingConnectionView } from '@recouple/store-postgres';

/**
 * `/books`, the page itself (ADR 0066 §1–§3), over the in-memory accounting
 * source: what each member is shown, what is asked of the ledger and as whom,
 * and what the page says when the ledger cannot be read. No test here reaches
 * a network or a database.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const REALM = '4620816365';
const CASE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CASE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function account(
  externalId: string,
  fullyQualifiedName: string,
  accountType: string,
  more: Partial<LedgerAccount> = {},
): LedgerAccount {
  return {
    sourceKind: 'qbo',
    externalId,
    name: fullyQualifiedName.split(':').pop() as string,
    fullyQualifiedName,
    accountType,
    active: true,
    ...more,
  };
}

const CHART: readonly LedgerAccount[] = [
  account('35', 'Checking', 'Bank', { code: '1000', accountSubType: 'Checking' }),
  account('84', 'Accounts Receivable (A/R)', 'Accounts Receivable', { code: '1200' }),
  account('91', 'Deductions Receivable', 'Other Current Asset', { code: '1250' }),
  account('96', 'Trade Deductions:Distributor Chargebacks', 'Income', {
    code: '4910',
    accountSubType: 'DiscountsRefundsGiven',
  }),
  account('97', 'Customer Deductions', 'Expense', { code: '6400' }),
  account('60', 'Freight Out', 'Expense', { active: false }),
];

const BALANCED: readonly TrialBalanceLine[] = [
  { accountExternalId: '35', accountName: 'Checking', debitCents: cents(1_825_040), creditCents: cents(0) },
  { accountExternalId: '84', accountName: 'Accounts Receivable (A/R)', debitCents: cents(413_025), creditCents: cents(0) },
  { accountExternalId: '79', accountName: 'Sales of Product Income', debitCents: cents(0), creditCents: cents(2_238_065) },
];

function posting(
  accountExternalId: string,
  accountName: string,
  date: string,
  debit: number,
  credit: number,
  more: Partial<GeneralLedgerLine> = {},
): GeneralLedgerLine {
  return { accountExternalId, accountName, date, debitCents: cents(debit), creditCents: cents(credit), ...more };
}

const LINES: readonly GeneralLedgerLine[] = [
  posting('96', 'Distributor Chargebacks', '2026-09-01', 127_000, 0, {
    transactionType: 'Credit Memo',
    documentNumber: 'CM-2210',
    name: 'Sysco Baltimore, LLC',
    memo: 'Shortage allowance, claim 4471',
  }),
  posting('35', 'Checking', '2026-09-05', 50_000, 0, { transactionType: 'Deposit' }),
  posting('96', 'Distributor Chargebacks', '2026-09-10', 50_000, 0, {
    transactionType: 'Credit Memo',
    documentNumber: 'CM-2211',
    name: 'US Foods, Inc.',
  }),
  posting('84', 'Accounts Receivable (A/R)', '2026-09-12', 240_000, 0, {
    transactionType: 'Invoice',
    documentNumber: '1052',
  }),
  posting('97', 'Customer Deductions', '2026-09-22', 32_000, 0, {
    transactionType: 'Journal Entry',
    documentNumber: 'RC-JE-2',
  }),
  // Outside the default window.
  posting('96', 'Distributor Chargebacks', '2026-08-01', 99_999, 0, { documentNumber: 'CM-OLD' }),
];

const CASES: BooksCasesRead = {
  rows: [
    {
      deductionId: CASE_A,
      state: 'classified',
      claimId: 'CLM-A',
      amountCents: 127_000,
      deductionDate: '2026-09-01',
      payerName: 'Sysco Baltimore, LLC',
      payerMatched: true,
    },
    {
      deductionId: CASE_B,
      state: 'classified',
      claimId: 'CLM-B',
      amountCents: 50_000,
      deductionDate: '2026-09-12',
      payerName: 'US FOODS INC',
      payerMatched: false,
    },
    { deductionId: CASE_C, state: 'classified', claimId: 'CLM-C', amountCents: 9_900, payerMatched: false },
  ],
  total: 3,
  limit: 500,
};

const MAP = {
  mapId: '66666666-6666-4666-8666-666666666666',
  arAccountId: '84',
  deductionsReceivableAccountId: '91',
  writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((family) => [family, '97'])) as Record<
    ReasonFamily,
    string
  >,
  unclassifiedWriteoff: '97',
};

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  mayWrite: true,
  connections: [] as unknown[],
  cases: undefined as unknown,
  trialBalanceLines: [] as unknown[],
  /** What a read throws, by which read. */
  fails: {} as { chart?: unknown; trialBalance?: unknown; ledger?: unknown },
  /** Whether a source can be built at all. */
  configured: true,
  sourcesAsked: [] as Array<{ identity: unknown; connectionId: string; mayRefresh: boolean }>,
  ledgerReads: [] as Array<{ window: unknown; accountIds: readonly string[] | undefined }>,
  trialBalanceReads: [] as string[],
  chartReads: 0,
  caseReads: [] as unknown[],
  connectionReads: [] as unknown[],
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'member@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role },
    orgs: [{ orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role }],
  }),
}));

vi.mock('../lib/env', () => ({ env: { databaseUrl: 'postgres://not-used.example/test' } }));

vi.mock('../lib/posting', () => ({
  postingStoreFor: (session: { org: { orgId: string }; userId: string }) => ({
    async postingConnections() {
      harness.connectionReads.push({ orgId: session.org.orgId, userId: session.userId });
      return harness.connections;
    },
    async memberMayWrite() {
      return harness.mayWrite;
    },
  }),
}));

vi.mock('@recouple/store-postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/store-postgres')>();
  return {
    ...actual,
    PostgresBooksStore: class {
      constructor(
        _config: unknown,
        private readonly tenant: unknown,
      ) {}
      async casesInWindow(window: unknown) {
        harness.caseReads.push({ tenant: this.tenant, window });
        return harness.cases;
      }
    },
  };
});

vi.mock('../lib/books', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/books')>();
  return {
    ...actual,
    booksSourcesFromEnv: () => ({
      sourceFor(
        identity: unknown,
        connection: { connectionId: string },
        options: { mayRefresh: boolean },
      ) {
        harness.sourcesAsked.push({
          identity,
          connectionId: connection.connectionId,
          mayRefresh: options.mayRefresh,
        });
        if (!harness.configured) return undefined;
        const memory = new InMemoryAccountingSource({
          accounts: CHART,
          trialBalanceLines: harness.trialBalanceLines as TrialBalanceLine[],
          ledgerLines: LINES,
        });
        return {
          async chartOfAccounts() {
            harness.chartReads += 1;
            if (harness.fails.chart !== undefined) throw harness.fails.chart;
            return memory.chartOfAccounts();
          },
          async trialBalance(asOf: string) {
            harness.trialBalanceReads.push(asOf);
            if (harness.fails.trialBalance !== undefined) throw harness.fails.trialBalance;
            return memory.trialBalance(asOf);
          },
          async generalLedger(
            window: { from: string; to: string },
            options?: { accountIds?: readonly string[] },
          ) {
            harness.ledgerReads.push({ window, accountIds: options?.accountIds });
            if (harness.fails.ledger !== undefined) throw harness.fails.ledger;
            return memory.generalLedger(window, options);
          },
        };
      },
    }),
  };
});

const { default: BooksRoute, maxDuration } = await import('../app/books/page');

async function page(params: Record<string, string | string[]> = {}): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(await BooksRoute({ searchParams: Promise.resolve(params) }));
}

/** The text of one `<section aria-label="…">`, so an assertion reads one card. */
function card(html: string, label: string): string {
  const start = html.indexOf(`aria-label="${label}`);
  expect(start, `no card labelled ${label}`).toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

const errors: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  harness.role = 'owner';
  harness.mayWrite = true;
  harness.connections = [
    { connectionId: CONNECTION, realmId: REALM, postingEnabled: false, map: MAP },
  ] satisfies PostingConnectionView[];
  harness.cases = CASES;
  harness.trialBalanceLines = [...BALANCED];
  harness.fails = {};
  harness.configured = true;
  harness.sourcesAsked = [];
  harness.ledgerReads = [];
  harness.trialBalanceReads = [];
  harness.chartReads = 0;
  harness.caseReads = [];
  harness.connectionReads = [];
  errors.length = 0;
});

describe('/books', () => {
  it('leaves the reads room to fail on their own bounds', () => {
    expect(maxDuration).toBe(90);
  });

  it('shows the chart with codes, and marks the accounts the map posts to', async () => {
    const chart = card(await page(), 'Chart of accounts');
    for (const text of ['1000', '1200', '1250', '4910', '6400', 'Checking', 'Freight Out', 'Inactive']) {
      expect(chart).toContain(text);
    }
    expect(chart).toContain('6 accounts, 1 of them inactive');
    // The two posting accounts, and only those, are highlighted.
    expect(chart.match(/data-posting-account="true"/g)).toHaveLength(2);
    expect(chart).toContain('<strong>Deductions Receivable</strong>');
    expect(chart).toContain('<strong>Customer Deductions</strong>');
    expect(chart).not.toContain('<strong>Checking</strong>');
    expect(chart).toContain('RECEIVABLE');
    expect(chart).toContain('LOOKS LIKE DEDUCTIONS');
    // The guess is written out where it is used.
    expect(chart).toContain('DiscountsRefundsGiven, AllowanceForBadDebts');
    expect(chart).toContain('chargeback');
  });

  it('asks for the trial balance as of today and says it balances', async () => {
    const html = await page();
    expect(harness.trialBalanceReads).toEqual(['2026-09-30']);
    const trialBalance = card(html, 'Trial balance');
    expect(trialBalance).toContain('As of 2026-09-30');
    expect(trialBalance).toContain('In balance: debits and credits are both $22,380.65.');
    expect(trialBalance).not.toContain('Out of balance');
    expect(trialBalance).toContain('$18,250.40');
  });

  it('says loudly, with the difference, when the ledger does not balance', async () => {
    harness.trialBalanceLines = [
      ...BALANCED,
      { accountExternalId: '60', accountName: 'Freight Out', debitCents: cents(10_050), creditCents: cents(0) },
    ];
    const trialBalance = card(await page(), 'Trial balance');
    expect(trialBalance).toContain('role="alert"');
    expect(trialBalance).toContain('<strong>Out of balance by $100.50.</strong>');
    expect(trialBalance).toContain('Debits are $22,481.15 and credits are $22,380.65');
    expect(trialBalance).toContain('debits are the larger');
    expect(trialBalance).not.toContain('In balance');
  });

  it('reads the ledger for the trailing 35 days, for the receivable, posting and deductions accounts', async () => {
    const html = await page();
    expect(harness.ledgerReads).toEqual([
      { window: { from: '2026-08-27', to: '2026-09-30' }, accountIds: ['84', '91', '96', '97'] },
    ]);
    const ledger = card(html, 'General ledger,');
    expect(ledger).toContain('4 postings across 3 accounts');
    expect(ledger).toContain('CM-2210');
    expect(ledger).toContain('RC-JE-2');
    // Checking is not one of those accounts, and the old posting is outside the window.
    expect(ledger).not.toContain('Deposit');
    expect(ledger).not.toContain('CM-OLD');
    expect(ledger).toContain('href="/books?from=2026-08-27&amp;to=2026-09-30&amp;accounts=all"');
  });

  it('reads every account one click away, with no account filter', async () => {
    const html = await page({ accounts: 'all' });
    expect(harness.ledgerReads).toEqual([
      { window: { from: '2026-08-27', to: '2026-09-30' }, accountIds: undefined },
    ]);
    const ledger = card(html, 'General ledger,');
    expect(ledger).toContain('5 postings across 4 accounts');
    expect(ledger).toContain('Deposit');
    expect(ledger).toContain('Every account is shown.');
  });

  it('reads the window the address names, once it is two real days in order', async () => {
    const html = await page({ from: '2026-08-01', to: '2026-08-31' });
    expect(harness.ledgerReads[0]?.window).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(harness.caseReads).toEqual([
      { tenant: { orgId: ORG_ID, userId: USER_ID }, window: { from: '2026-08-01', to: '2026-08-31' } },
    ]);
    expect(card(html, 'General ledger,')).toContain('CM-OLD');
  });

  it.each([
    [{ from: '2026-09-30', to: '2026-09-01' }, 'ended before it began'],
    [{ from: "2026-09-01' or 1=1", to: '2026-09-30' }, 'was not two dates'],
    [{ from: '2026-02-31', to: '2026-09-30' }, 'was not two dates'],
    [{ from: ['2026-09-01', '2026-09-02'], to: '2026-09-30' }, 'was not two dates'],
    [{ from: '2025-01-01', to: '2026-09-30' }, 'at most 186 days'],
    [{ to: '2026-09-30' }, 'was not two dates'],
  ])('falls back to the default window for %j, and says so', async (params, words) => {
    const html = await page(params as Record<string, string | string[]>);
    expect(html).toContain(words);
    expect(harness.ledgerReads[0]?.window).toEqual({ from: '2026-08-27', to: '2026-09-30' });
  });

  it('reconciles the deductions postings against our cases, exact matches only', async () => {
    const html = await page();
    expect(harness.caseReads).toEqual([
      { tenant: { orgId: ORG_ID, userId: USER_ID }, window: { from: '2026-08-27', to: '2026-09-30' } },
    ]);
    const reconciliation = card(html, 'Deductions reconciliation');
    // Three postings on the posting and deductions accounts; the A/R invoice is not one.
    expect(reconciliation).toContain('3 postings and 3 cases');
    expect(reconciliation).toContain('1 match, 2 in the books with no case, 2 cases not in the books');

    // $1,270.00 on 2026-09-01 is CLM-A's amount and day.
    const matched = reconciliation.split('<tr').find((row) => row.includes('data-reconciliation="matched"'));
    expect(matched).toContain(`Matches case <a href="/cases/${CASE_A}">CLM-A</a>`);
    expect(matched).toContain('$1,270.00');
    expect(matched).toContain('Sysco Baltimore, LLC');

    // $500.00 two days from CLM-B: a candidate, said to be one, not a match.
    const booksOnly = reconciliation
      .split('<tr')
      .filter((row) => row.includes('data-reconciliation="books_only"'));
    expect(booksOnly).toHaveLength(2);
    expect(booksOnly[0]).toContain('In books, no case');
    expect(booksOnly[0]).toContain('Candidate, not asserted');
    expect(booksOnly[0]).toContain(`<a href="/cases/${CASE_B}">CLM-B</a> (2026-09-12)`);
    expect(booksOnly[0]).not.toContain('Matches case');
    expect(booksOnly[1]).toContain('RC-JE-2');
    expect(booksOnly[1]).not.toContain('Candidate');

    const caseOnly = reconciliation
      .split('<tr')
      .filter((row) => row.includes('data-reconciliation="case_only"'));
    expect(caseOnly).toHaveLength(2);
    expect(caseOnly.join('')).toContain('No date printed');
    expect(caseOnly.join('')).toContain('Case, not in books');
    expect(reconciliation).toContain('A candidate is not a match.');
  });

  it('says when it compared only some of the window’s cases', async () => {
    harness.cases = { ...CASES, total: 812 };
    const reconciliation = card(await page(), 'Deductions reconciliation');
    expect(reconciliation).toContain('Only the first 3 of 812 cases in this window were compared');
  });

  it('links the proposal to keep snapshots, and has nothing to press but the window', async () => {
    const html = await page();
    expect(html).toContain('Nothing on this page is stored');
    expect(html).toContain('docs/adr/0066-the-books-are-read-through-and-a-snapshot-is-proposed.md');
    expect(html.match(/<form /g)).toHaveLength(2); // the window, and the shell's sign-out
    expect(html).toContain('<form action="/books" method="get">');
    expect(html).not.toMatch(/<form[^>]*action="\/books"[^>]*method="post"/);
    expect(html).not.toContain('<button type="submit" name=');
  });

  it.each(['owner', 'approver', 'analyst'])('reads as a %s, whose token refresh can be stored', async (role) => {
    harness.role = role;
    const html = await page();
    expect(harness.sourcesAsked).toEqual([
      { identity: { orgId: ORG_ID, userId: USER_ID }, connectionId: CONNECTION, mayRefresh: true },
    ]);
    expect(html).toContain('In balance');
  });

  it('reads for a read-only member too, and never lets their view refresh a token', async () => {
    harness.role = 'read_only';
    harness.mayWrite = false;
    const html = await page();
    expect(harness.sourcesAsked).toEqual([
      { identity: { orgId: ORG_ID, userId: USER_ID }, connectionId: CONNECTION, mayRefresh: false },
    ]);
    expect(card(html, 'Chart of accounts')).toContain('Deductions Receivable');
    expect(card(html, 'Trial balance')).toContain('In balance');
  });

  it('says there is no connection, and asks nothing of anyone', async () => {
    harness.connections = [];
    const html = await page();
    expect(html).toContain('No QuickBooks company is connected');
    expect(html).toContain('href="/settings/quickbooks"');
    expect(harness.sourcesAsked).toEqual([]);
    expect(harness.caseReads).toEqual([]);
    expect(html).not.toContain('Trial balance —');
  });

  it('says the deployment cannot read QuickBooks when no source can be built', async () => {
    harness.configured = false;
    const html = await page();
    expect(html).toContain('This deployment is not set up to read QuickBooks, so nothing was asked of it.');
    expect(harness.chartReads).toBe(0);
    expect(html).not.toContain('In balance');
    expect(html).not.toContain('Chart of accounts —');
  });

  it('names a refused sign-in by its code’s meaning and nothing Intuit said, asking once', async () => {
    const SECRET = 'intuit-said-this-AB12CD34';
    harness.fails.chart = new QboAuthError(`refresh refused: ${SECRET}`, 'grant_refused');
    const html = await page();

    expect(card(html, 'Chart of accounts')).toContain('QuickBooks refused the stored sign-in.');
    // The other reads would fail the same way: not asked, and said to be skipped.
    expect(harness.trialBalanceReads).toEqual([]);
    expect(harness.ledgerReads).toEqual([]);
    expect(card(html, 'Trial balance')).toContain('was not read');
    expect(card(html, 'Deductions reconciliation')).toContain('was not read');

    expect(html).not.toContain(SECRET);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('QboAuthError');
    expect(errors[0]).toContain(CONNECTION);
    expect(errors.join('\n')).not.toContain(SECRET);
  });

  it('shows no part of a report it could not read whole, and keeps the rest of the page', async () => {
    const QUOTED = '4130.255';
    harness.fails.trialBalance = new QboMalformedResponse(`amount ${QUOTED} is not exact cents`, 'x');
    harness.fails.ledger = new QboReportTooLarge('cut_short');
    const html = await page();

    expect(card(html, 'Chart of accounts')).toContain('Deductions Receivable');
    const trialBalance = card(html, 'Trial balance');
    expect(trialBalance).toContain('role="alert"');
    expect(trialBalance).toContain('answered in a shape this page does not read');
    expect(trialBalance).not.toContain('<table');
    const ledger = card(html, 'General ledger,');
    expect(ledger).toContain('larger than one read returns');
    expect(ledger).not.toContain('<table');
    // No ledger, so nothing to reconcile — said, not shown as "no postings".
    const reconciliation = card(html, 'Deductions reconciliation');
    expect(reconciliation).toContain('was not read');
    expect(reconciliation).not.toContain('Nothing to reconcile');

    expect(html).not.toContain(QUOTED);
    expect(errors.join('\n')).not.toContain(QUOTED);
    expect(errors.map((line) => /\((\w+)/.exec(line)?.[1]).sort()).toEqual([
      'QboMalformedResponse',
      'QboReportTooLarge',
    ]);
  });

  it('still reads the trial balance when only the chart is unreadable, and skips what needs the chart', async () => {
    harness.fails.chart = new QboMalformedResponse('Account[3].Active', 'Account[3].Active');
    const html = await page();
    expect(card(html, 'Chart of accounts')).toContain('could not be read');
    expect(card(html, 'Trial balance')).toContain('In balance');
    // Which accounts to ask for comes from the chart; with none, nothing is asked.
    expect(harness.ledgerReads).toEqual([]);
    expect(card(html, 'General ledger,')).toContain('was not read');

    // Every account needs no chart.
    await page({ accounts: 'all' });
    expect(harness.ledgerReads).toHaveLength(1);
  });

  it('is a section of the settings panel', async () => {
    const html = await page();
    expect(html).toContain('<a class="active" aria-current="page" href="/books">Books</a>');
  });
});
