import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  REASON_FAMILIES,
  cents,
  draftEntries,
  settlementLinesFrom,
  validateSettlementLines,
  type LedgerAccount,
  type SettlementLineInput,
  type StoredSettlementLine,
} from '@recouple/core-domain';
import {
  SettlementAlreadyApprovedError,
  SettlementApprovalRefusedError,
  SettlementLinesRefusedError,
  settlementAccountPolicy,
  type CasePosting,
  type PostingConnectionView,
  type SettlementChartReader,
} from '@recouple/store-postgres';

/**
 * ADR 0068's web half: the prepare form for a settlement's journal lines, the
 * route that takes it, and what the approver is shown. The store, the queue
 * and QuickBooks are stand-ins; the rule the fake store applies is the real
 * `validateSettlementLines`, over a chart read through the real reader.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const DECISION_ID = '55555555-5555-4555-8555-555555555555';
const AMOUNT = 50_000;

const MAP = {
  mapId: '66666666-6666-4666-8666-666666666666',
  arAccountId: '84',
  deductionsReceivableAccountId: '90',
  writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f, i) => [f, String(200 + i)])) as never,
  unclassifiedWriteoff: '299',
};
const CONNECTION: PostingConnectionView = {
  connectionId: CONNECTION_ID,
  realmId: '9130',
  postingEnabled: true,
  map: MAP,
};

const account = (externalId: string, name: string, accountType: string, active = true): LedgerAccount => ({
  sourceKind: 'qbo',
  externalId,
  name,
  fullyQualifiedName: name,
  accountType,
  active,
});
const CHART: readonly LedgerAccount[] = [
  account('84', 'Accounts Receivable (A/R)', 'Accounts Receivable'),
  account('90', 'Deductions Receivable', 'Other Current Asset'),
  ...REASON_FAMILIES.map((f, i) => account(String(200 + i), `Write-off ${f}`, 'Expense')),
  account('299', 'Customer Deductions', 'Expense'),
  account('300', 'Trade spend <b>&', 'Expense'),
  account('301', 'Old expense', 'Expense', false),
  account('35', 'Checking', 'Bank'),
  account('33', 'Accounts Payable (A/P)', 'Accounts Payable'),
];

const harness = vi.hoisted(() => ({
  role: 'analyst' as string,
  posting: true,
  mayWrite: true,
  calls: [] as Array<[string, ...unknown[]]>,
  casePosting: undefined as unknown,
  connections: [] as unknown[],
  chart: 'ok' as 'ok' | 'throws' | 'not_configured',
  chartReads: [] as Array<{ mayRefresh: boolean }>,
  prepareError: undefined as Error | undefined,
  approveError: undefined as Error | undefined,
}));

function ready(overrides: Partial<CasePosting> = {}): CasePosting {
  return {
    connection: { connectionId: CONNECTION_ID, postingEnabled: true, hasMap: true },
    ledgerInvoiceId: '71',
    writebacks: [],
    settlement: undefined,
    ...overrides,
  };
}

const postingStore = {
  async postingForCase(id: string) {
    harness.calls.push(['postingForCase', id]);
    return harness.casePosting;
  },
  async postingConnections() {
    return harness.connections;
  },
  async memberMayWrite() {
    return harness.mayWrite;
  },
  /** The store's own order: the chart first, then the real rule over it. */
  async prepareSettlementDecision(input: {
    outcome: 'won' | 'partial' | 'lost' | 'declined';
    recoveredCents: number;
    family: (typeof REASON_FAMILIES)[number] | undefined;
    lines?: { connectionId: string; lines: readonly SettlementLineInput[]; readChart: SettlementChartReader };
  }) {
    if (input.lines === undefined) throw new Error('the route always sends lines');
    const chart = await input.lines.readChart();
    if (harness.prepareError !== undefined) throw harness.prepareError;
    const computed = settlementLinesFrom(
      draftEntries({
        amountCents: cents(AMOUNT),
        recoveredCents: cents(input.recoveredCents),
        outcome: input.outcome,
        family: input.family,
      }),
      MAP,
      { includeFound: input.outcome === 'declined' },
    );
    const verdict = validateSettlementLines(input.lines.lines, chart, {
      computed,
      policy: settlementAccountPolicy(MAP),
    });
    if (!verdict.ok) throw new SettlementLinesRefusedError(verdict.problems);
    harness.calls.push(['prepareSettlementDecision', { ...input, lines: { ...input.lines, readChart: undefined } }, verdict.lines]);
    return { decisionId: DECISION_ID };
  },
  async approveSettlement(decisionId: string) {
    harness.calls.push(['approveSettlement', decisionId]);
    if (harness.approveError !== undefined) throw harness.approveError;
    return { deductionId: CASE_ID, writeoffCents: cents(0) };
  },
  async insertWriteoff() {
    return { writeoffId: 'x' };
  },
};

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'someone@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
}));
vi.mock('../lib/pipeline', () => ({ mayWrite: (role: string) => role !== 'read_only' }));
vi.mock('../lib/qbo-posting', () => ({
  qboPostingFromEnv: () => (harness.posting ? {} : undefined),
}));
vi.mock('../lib/posting', () => ({
  postingStoreFor: () => postingStore,
  queueDecisionPostings: async (_session: unknown, _store: unknown, input: unknown) => {
    harness.calls.push(['queueDecisionPostings', input]);
    return true;
  },
}));
vi.mock('../lib/books', () => ({
  booksSourcesFromEnv: () => ({
    sourceFor(_identity: unknown, _connection: unknown, options: { mayRefresh: boolean }) {
      harness.chartReads.push(options);
      if (harness.chart === 'not_configured') return undefined;
      return {
        async chartOfAccounts() {
          if (harness.chart === 'throws') throw new Error('Intuit said: customer Acme Foods, token abc123');
          return CHART;
        },
      };
    },
  }),
}));

const { POST: settle } = await import('../app/cases/[id]/settle/route');
const {
  SETTLE_PARAMS,
  centsAsText,
  echoedLinesFrom,
  echoedProblemsFrom,
  lineField,
  postedLinesFrom,
  settlementChartReader,
  settlementChoiceFrom,
  settlementEditorFor,
  settlementEditorPath,
} = await import('../lib/settlement-editor');
const { SettlementEditorForm, StoredSettlementLines } = await import('../components/settlement-editor');
const { CasePostingCard } = await import('../components/case-posting');
const { DraftJournal } = await import('../components/draft-journal');
const { parseMoneyToCents } = await import('@recouple/core-domain');

function post(fields: Record<string, string>, site = 'same-origin'): NextRequest {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(`https://app.example.test/cases/${CASE_ID}/settle`, {
    method: 'POST',
    body,
    headers: { 'sec-fetch-site': site },
  });
}
const params = { params: Promise.resolve({ id: CASE_ID }) };
const location = (response: Response): URL => new URL(response.headers.get('location') ?? 'https://x');

/** A prepare form as the editor draws it: the choice, then `lines` as rows. */
function prepareForm(
  lines: ReadonlyArray<{ account: string; debit?: string; credit?: string; memo?: string }>,
  choice: Record<string, string> = {},
): Record<string, string> {
  const fields: Record<string, string> = {
    intent: 'prepare',
    outcome: 'lost',
    recovered: '0.00',
    family: 'shortage',
    invoiceId: '71',
    ...choice,
  };
  lines.forEach((line, index) => {
    const n = index + 1;
    fields[lineField(n, 'account')] = line.account;
    fields[lineField(n, 'debit')] = line.debit ?? '';
    fields[lineField(n, 'credit')] = line.credit ?? '';
    fields[lineField(n, 'memo')] = line.memo ?? '';
  });
  return fields;
}

const MEMO = 'Agreed with the buyer on the phone';
const edited = [
  { account: '300', debit: '$300.00', memo: MEMO },
  { account: '200', debit: '200.00' },
  { account: '90', credit: '500.00' },
];

const editorInput = (overrides: Partial<Parameters<typeof settlementEditorFor>[0]> = {}) => ({
  deductionId: CASE_ID,
  amountCents: AMOUNT,
  params: {},
  defaults: { outcome: 'lost' as const, recoveredCents: cents(0), family: 'shortage' as const, invoiceId: '71' },
  settlement: undefined,
  connection: CONNECTION,
  mayAct: true,
  readChartFor: (connection: PostingConnectionView) =>
    settlementChartReader({ orgId: ORG_ID, userId: USER_ID }, connection, { mayRefresh: harness.mayWrite }),
  ...overrides,
});
const chosen = { so: 'lost', sr: '0.00', sf: 'shortage', si: '71' };

beforeEach(() => {
  harness.role = 'analyst';
  harness.posting = true;
  harness.mayWrite = true;
  harness.calls = [];
  harness.casePosting = ready();
  harness.connections = [CONNECTION];
  harness.chart = 'ok';
  harness.chartReads = [];
  harness.prepareError = undefined;
  harness.approveError = undefined;
});

describe('what an address or a form may state', () => {
  it('reads how a case settled, and calls anything else invalid', () => {
    expect(settlementChoiceFrom({ outcome: undefined, recovered: undefined, family: undefined, invoiceId: undefined })).toBeUndefined();
    expect(settlementChoiceFrom({ outcome: 'partial', recovered: '$1,200.50', family: 'freight', invoiceId: ' 71 ' })).toEqual({
      outcome: 'partial',
      recoveredCents: 120_050,
      family: 'freight',
      invoiceId: '71',
    });
    expect(settlementChoiceFrom({ outcome: 'lost', recovered: '', family: '', invoiceId: '71' })).toEqual({
      outcome: 'lost',
      recoveredCents: 0,
      family: undefined,
      invoiceId: '71',
    });
    for (const bad of [
      { outcome: 'settled', recovered: '', family: '', invoiceId: '71' },
      { outcome: 'lost', recovered: '', family: '', invoiceId: "71' or 1=1" },
      { outcome: 'lost', recovered: '', family: 'slotting', invoiceId: '71' },
      { outcome: 'partial', recovered: '12.5', family: '', invoiceId: '71' },
      { outcome: 'partial', recovered: '-5.00', family: '', invoiceId: '71' },
      { outcome: 'lost', recovered: ['1.00', '2.00'], family: '', invoiceId: '71' },
    ]) {
      expect(settlementChoiceFrom(bad)).toBe('invalid');
    }
  });

  it('echoes only ids and digits, and only refusals from the closed set', () => {
    expect(echoedLinesFrom(undefined)).toBeUndefined();
    expect(echoedLinesFrom(['300~30000~0', '~0~0', '90~0~50000'])).toEqual([
      { accountExternalId: '300', debitCents: 30_000, creditCents: 0 },
      { accountExternalId: '', debitCents: 0, creditCents: 0 },
      { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
    ]);
    expect(echoedLinesFrom(['<script>~1~0', '300~1.5~0', '300~1~0~memo', '300~-1~0', 'x y~1~0'])).toBeUndefined();
    expect(echoedLinesFrom(Array.from({ length: 30 }, () => '300~1~0'))).toHaveLength(20);

    expect(echoedProblemsFrom('unbalanced,account_unknown.2,made_up,account_unknown.99,<b>.1,unbalanced.1.2')).toEqual([
      { code: 'unbalanced' },
      { code: 'account_unknown', lineNo: 2 },
    ]);
    expect(echoedProblemsFrom(['unbalanced', 'unbalanced'])).toEqual([]);
  });

  it('writes money fields as text the money parser reads back to the same cents', () => {
    for (const amount of [0, 5, 99, 100, 123_456, 5_000_000_00]) {
      expect(parseMoneyToCents(centsAsText(amount))).toBe(amount);
    }
    expect(() => centsAsText(1.5)).toThrow(RangeError);
    expect(() => centsAsText(-1)).toThrow(RangeError);
  });

  it('reads a posted form: empty rows skipped, amounts by the money parser, a memo never in the echo', () => {
    const form = new FormData();
    const fields = prepareForm([
      { account: '300', debit: '$1,234.50', memo: MEMO },
      { account: '', debit: '', credit: '', memo: '   ' },
      { account: '90', credit: '1234.50' },
      { account: '200', debit: '12.5' },
      { account: '200', debit: '-3.00' },
      { account: '200', debit: '1e3' },
    ]);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const posted = postedLinesFrom(form);
    expect(posted.lines).toEqual([
      { accountExternalId: '300', debitCents: 123_450, creditCents: 0, memo: MEMO },
      { accountExternalId: '90', debitCents: 0, creditCents: 123_450 },
      { accountExternalId: '200', debitCents: 0, creditCents: 0 },
      { accountExternalId: '200', debitCents: 0, creditCents: 0 },
      { accountExternalId: '200', debitCents: 0, creditCents: 0 },
    ]);
    // One decimal place, a negative and an exponent are not dollars and cents.
    expect(posted.unreadable).toEqual([3, 4, 5]);
    expect(JSON.stringify(posted.echo)).not.toContain('Agreed');
    for (const line of posted.lines) {
      expect(Number.isSafeInteger(line.debitCents) && Number.isSafeInteger(line.creditCents)).toBe(true);
    }
  });

  it('builds an editor address that carries the choice and the lines and has nowhere for a memo', () => {
    const path = settlementEditorPath(
      CASE_ID,
      { outcome: 'lost', recoveredCents: cents(0), family: 'shortage', invoiceId: '71' },
      {
        lines: [{ accountExternalId: '300', debitCents: cents(1), creditCents: cents(0) }],
        problems: [{ code: 'unbalanced' }, { code: 'account_unknown', lineNo: 1 }],
        notice: 'settle_lines_refused',
      },
    );
    const url = new URL(path, 'https://app.example.test');
    expect(url.pathname).toBe(`/cases/${CASE_ID}`);
    expect(url.hash).toBe('#settlement');
    expect([...url.searchParams.keys()].sort()).toEqual(['action', 'sf', 'si', 'sl', 'so', 'sp', 'sr']);
    expect(url.searchParams.get('sp')).toBe('unbalanced,account_unknown.1');
  });
});

describe('the editor the page builds', () => {
  it('is not offered to a member who may not write, and reads no chart for them', async () => {
    expect(await settlementEditorFor(editorInput({ mayAct: false, params: chosen }))).toBeUndefined();
    expect(harness.chartReads).toEqual([]);
  });

  it('is not offered when posting is off, there is no map, or the settlement is approved', async () => {
    expect(await settlementEditorFor(editorInput({ connection: undefined, params: chosen }))).toBeUndefined();
    expect(
      await settlementEditorFor(editorInput({ connection: { ...CONNECTION, postingEnabled: false }, params: chosen })),
    ).toBeUndefined();
    expect(
      await settlementEditorFor(editorInput({ connection: { ...CONNECTION, map: undefined }, params: chosen })),
    ).toBeUndefined();
    expect(await settlementEditorFor(editorInput({ settlement: { approved: true }, params: chosen }))).toBeUndefined();
    expect(harness.chartReads).toEqual([]);
  });

  it('asks how the case settled first, and reads no chart until it is told', async () => {
    const editor = await settlementEditorFor(editorInput());
    expect(editor).toMatchObject({ kind: 'choose', invalid: false, supersedes: false });
    expect(harness.chartReads).toEqual([]);
    const garbled = await settlementEditorFor(editorInput({ params: { so: 'lost', si: 'seventy-one' } }));
    expect(garbled).toMatchObject({ kind: 'choose', invalid: true });
    expect(harness.chartReads).toEqual([]);
  });

  it('leaves a prepared settlement alone until somebody asks to prepare it again', async () => {
    expect(await settlementEditorFor(editorInput({ settlement: { approved: false } }))).toBeUndefined();
    expect(await settlementEditorFor(editorInput({ settlement: { approved: false }, params: { se: '1' } }))).toMatchObject({
      kind: 'choose',
      supersedes: true,
    });
  });

  it('draws the computed lines over the live chart: the receivable line fixed, no payable, bank or inactive account offered', async () => {
    const editor = await settlementEditorFor(
      editorInput({ params: { so: 'partial', sr: '200.00', sf: 'shortage', si: '71' } }),
    );
    if (editor?.kind !== 'ready') throw new Error(`expected the form, got ${editor?.kind}`);
    expect(editor.rows).toEqual([
      { lineNo: 1, accountExternalId: '84', accountName: 'Accounts Receivable (A/R)', accountType: 'Accounts Receivable', debit: '200.00', credit: '', locked: true },
      { lineNo: 2, accountExternalId: '90', accountName: 'Deductions Receivable', accountType: 'Other Current Asset', debit: '', credit: '200.00', locked: false },
      { lineNo: 3, accountExternalId: '200', accountName: 'Write-off shortage', accountType: 'Expense', debit: '300.00', credit: '', locked: false },
      { lineNo: 4, accountExternalId: '90', accountName: 'Deductions Receivable', accountType: 'Other Current Asset', debit: '', credit: '300.00', locked: false },
    ]);
    expect(editor.totals).toEqual({ debitCents: 50_000, creditCents: 50_000, balanced: true });
    expect(editor.echoed).toBe(false);
    expect(editor.blankRows).toBe(3);
    const offered = editor.accounts.map((a) => a.externalId);
    for (const refused of ['84', '33', '35', '301']) expect(offered).not.toContain(refused);
    expect(offered).toContain('300');
    expect(harness.chartReads).toEqual([{ mayRefresh: true }]);
  });

  it('reads the chart without a refresh for a member the database would not store one for', async () => {
    harness.mayWrite = false;
    await settlementEditorFor(editorInput({ params: chosen }));
    expect(harness.chartReads).toEqual([{ mayRefresh: false }]);
  });

  it('shows what a refused form sent back, with its totals and its refusals', async () => {
    const editor = await settlementEditorFor(
      editorInput({ params: { ...chosen, sl: ['300~30001~0', '200~20000~0', '90~0~50000'], sp: 'unbalanced' } }),
    );
    if (editor?.kind !== 'ready') throw new Error('expected the form');
    expect(editor.echoed).toBe(true);
    expect(editor.totals).toEqual({ debitCents: 50_001, creditCents: 50_000, balanced: false });
    expect(editor.problems).toEqual([{ code: 'unbalanced' }]);
    expect(editor.resetPath).not.toContain('sl=');
  });

  it('says the books cannot hold a choice, and that a chart could not be read, without throwing', async () => {
    expect(
      await settlementEditorFor(editorInput({ params: { so: 'won', sr: '1.00', si: '71' } })),
    ).toMatchObject({ kind: 'refused_choice' });
    harness.chart = 'throws';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await settlementEditorFor(editorInput({ params: chosen }))).toMatchObject({
        kind: 'chart_unreadable',
        reason: 'unreadable',
      });
      // The class name and ids: never what the accounting system said.
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Acme Foods|abc123/);
      expect(JSON.stringify(spy.mock.calls)).toContain(CONNECTION_ID);
    } finally {
      spy.mockRestore();
    }
    harness.chart = 'not_configured';
    expect(await settlementEditorFor(editorInput({ params: chosen }))).toMatchObject({
      kind: 'chart_unreadable',
      reason: 'not_configured',
    });
  });
});

describe('the prepare form, drawn', () => {
  it('is a POST with a select over the chart, money as text, a memo per line, totals and a reset — and no script', async () => {
    const editor = await settlementEditorFor(editorInput({ params: chosen }));
    if (editor === undefined) throw new Error('expected an editor');
    const html = renderToStaticMarkup(<SettlementEditorForm deductionId={CASE_ID} editor={editor} />);
    expect(html).toContain(`action="/cases/${CASE_ID}/settle" method="post"`);
    expect(html).toContain('name="intent" value="prepare"');
    expect(html).toContain('name="outcome" value="lost"');
    expect(html).toContain('<select name="account_1"');
    expect(html).toContain('<option value="200" selected="">Write-off shortage (Expense)</option>');
    expect(html).toContain('name="debit_1"');
    expect(html).toContain('value="500.00"');
    expect(html).toContain('name="memo_1"');
    expect(html).toContain('maxLength="500"');
    // Two computed lines and three empty rows.
    expect(html).toContain('name="account_5"');
    expect(html).not.toContain('name="account_6"');
    expect(html).toContain('Balances');
    expect(html).toContain('Reset to computed');
    expect(html).toContain('Prepare the settlement for approval');
    // An account's name is the chart's text, and is escaped.
    expect(html).toContain('Trade spend &lt;b&gt;&amp; (Expense)');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/ on[a-z]+="/);
  });

  it('shows the receivable line as fixed: sent with the form, with nothing to change', async () => {
    const editor = await settlementEditorFor(editorInput({ params: { so: 'won', sr: '500.00', si: '71' } }));
    if (editor === undefined) throw new Error('expected an editor');
    const html = renderToStaticMarkup(<SettlementEditorForm deductionId={CASE_ID} editor={editor} />);
    expect(html).toContain('<input type="hidden" name="account_1" value="84"/>');
    expect(html).toContain('<input type="hidden" name="debit_1" value="500.00"/>');
    expect(html).toContain('fixed by the case');
    expect(html).not.toContain('<select name="account_1"');
    expect(html).toContain('<select name="account_2"');
  });

  it('says a set that does not balance does not, with both totals, and lists the refusals', async () => {
    const editor = await settlementEditorFor(
      editorInput({ params: { ...chosen, sl: ['300~30001~0', '9999~20000~0', '90~0~50000'], sp: 'unbalanced,account_unknown.2' } }),
    );
    if (editor === undefined) throw new Error('expected an editor');
    const html = renderToStaticMarkup(<SettlementEditorForm deductionId={CASE_ID} editor={editor} />);
    expect(html).toContain('Does not balance: debits $500.01, credits $500.00');
    expect(html).toContain('The entry does not balance: total debits must equal total credits.');
    expect(html).toContain('Line 2: That account is not in your QuickBooks chart of accounts.');
    expect(html).toContain('Memos are not kept when a form comes back');
    // The account the chart does not report is not preselected as anything.
    expect(html).toContain('<select name="account_2" aria-label="Account, line 2"><option value="" selected="">');
  });

  it('asks how it settled with a GET that carries no memo field', async () => {
    const editor = await settlementEditorFor(editorInput());
    if (editor === undefined) throw new Error('expected an editor');
    const html = renderToStaticMarkup(<SettlementEditorForm deductionId={CASE_ID} editor={editor} />);
    expect(html).toContain(`action="/cases/${CASE_ID}#settlement" method="get"`);
    expect(html).toContain(`name="${SETTLE_PARAMS.outcome}"`);
    expect(html).toContain('<option value="lost" selected="">');
    expect(html).not.toContain('name="memo');
    expect(html).not.toContain('method="post"');
  });

  it('sits inside the draft-accounting card, which no longer says nothing is ever posted', () => {
    const html = renderToStaticMarkup(
      <DraftJournal amountCents={AMOUNT} outcome="lost" declined={false} editor={<p>the form</p>} />,
    );
    expect(html).toContain('<p>the form</p>');
    expect(html).toContain('posted only after a second person approves it');
    expect(html).toContain('Draft — not posted');
  });
});

describe('what the approver is shown', () => {
  const stored: readonly StoredSettlementLine[] = [
    { lineNo: 1, accountExternalId: '300', accountNameAsReported: 'Trade spend', accountTypeAsReported: 'Expense', debitCents: cents(30_000), creditCents: cents(0), memo: '<img src=x onerror=alert(1)> agreed' },
    { lineNo: 2, accountExternalId: '200', accountNameAsReported: 'Write-off shortage', accountTypeAsReported: 'Expense', debitCents: cents(20_000), creditCents: cents(0), memo: undefined },
    { lineNo: 3, accountExternalId: '90', accountNameAsReported: 'Deductions Receivable', accountTypeAsReported: 'Other Current Asset', debitCents: cents(0), creditCents: cents(50_000), memo: undefined },
  ];
  const computed = settlementLinesFrom(
    draftEntries({ amountCents: cents(AMOUNT), recoveredCents: cents(0), outcome: 'lost', family: 'shortage' }),
    MAP,
    { includeFound: false },
  );
  const settlement = {
    decisionId: DECISION_ID,
    preparedBy: OTHER_USER,
    outcome: 'lost' as const,
    recoveredCents: cents(0),
    invoiceId: '71',
    approved: false,
    family: 'shortage' as const,
    lines: stored,
    computedLines: computed,
  };

  it('the stored lines, what was edited, and a memo as text', () => {
    const html = renderToStaticMarkup(<StoredSettlementLines lines={stored} computed={computed} />);
    expect(html).toContain('Trade spend');
    expect(html).toContain('$300.00');
    expect(html).toContain('<strong>Edited:</strong> account on line 1, amount on line 1, memo on line 1, account on line 2, amount on line 2, line 3 added.');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; agreed');
    expect(html).not.toContain('<img');
    expect(renderToStaticMarkup(<StoredSettlementLines lines={[]} computed={undefined} />)).toContain(
      'could not be drawn to compare',
    );
  });

  it('says so when nothing was edited', () => {
    const unchanged = computed.map((line) => ({
      ...line,
      accountNameAsReported: 'x',
      accountTypeAsReported: 'Expense',
    }));
    expect(renderToStaticMarkup(<StoredSettlementLines lines={unchanged} computed={computed} />)).toContain(
      'These are the computed lines, unchanged.',
    );
  });

  it('an approver who did not prepare it gets the lines and the one button', () => {
    const html = renderToStaticMarkup(
      <CasePostingCard deductionId={CASE_ID} posting={ready({ settlement })} mayAct mayApprove viewerUserId={USER_ID} />,
    );
    expect(html).toContain('Edited:');
    expect(html).toContain('Approve the settlement and post it to QuickBooks');
    expect(html).toContain(`name="decisionId" value="${DECISION_ID}"`);
    expect(html).toContain('Prepare it again with different lines');
  });

  it('the preparer sees the lines and no approve button; a reader no link to prepare again', () => {
    const mine = renderToStaticMarkup(
      <CasePostingCard deductionId={CASE_ID} posting={ready({ settlement: { ...settlement, preparedBy: USER_ID } })} mayAct mayApprove viewerUserId={USER_ID} />,
    );
    expect(mine).toContain('Edited:');
    expect(mine).not.toContain('Approve the settlement');
    expect(mine).toContain('a second person approves it');
    const reader = renderToStaticMarkup(
      <CasePostingCard deductionId={CASE_ID} posting={ready({ settlement })} mayAct={false} mayApprove={false} viewerUserId={USER_ID} />,
    );
    expect(reader).toContain('Trade spend');
    expect(reader).not.toContain('Prepare it again');
    expect(reader).not.toContain('<form');
  });

  it('an approved settlement keeps its lines on the page and offers nothing', () => {
    const html = renderToStaticMarkup(
      <CasePostingCard deductionId={CASE_ID} posting={ready({ settlement: { ...settlement, approved: true } })} mayAct mayApprove viewerUserId={USER_ID} />,
    );
    expect(html).toContain('Settlement approved');
    expect(html).toContain('Trade spend');
    expect(html).not.toContain('Approve the settlement');
    expect(html).not.toContain('Prepare it again');
  });

  it('a settlement prepared before lines were stored says the computed entry is posted', () => {
    const html = renderToStaticMarkup(
      <CasePostingCard deductionId={CASE_ID} posting={ready({ settlement: { ...settlement, lines: undefined } })} mayAct mayApprove viewerUserId={USER_ID} />,
    );
    expect(html).toContain('the computed entry');
    expect(html).toContain('Approve the settlement and post it to QuickBooks');
  });
});

describe('POST /cases/[id]/settle, intent=prepare', () => {
  const prepared = () => harness.calls.filter(([name]) => name === 'prepareSettlementDecision');

  it('refuses cross-site, and does nothing where the deployment does not post', async () => {
    expect((await settle(post(prepareForm(edited), 'cross-site'), params)).status).toBe(403);
    harness.posting = false;
    expect(location(await settle(post(prepareForm(edited)), params)).searchParams.get('action')).toBe('posting_off');
    expect(harness.calls).toEqual([]);
    expect(harness.chartReads).toEqual([]);
  });

  it('a read-only member prepares nothing and causes no read of QuickBooks', async () => {
    harness.role = 'read_only';
    expect(location(await settle(post(prepareForm(edited)), params)).searchParams.get('action')).toBe('settle_role');
    expect(harness.calls).toEqual([]);
    expect(harness.chartReads).toEqual([]);
  });

  it('prepares with the lines as entered, the names and types from the chart, the memo only in the store call', async () => {
    const response = await settle(post(prepareForm(edited)), params);
    expect(location(response).searchParams.get('action')).toBe('settle_prepared');
    expect(response.headers.get('location')).not.toContain('Agreed');
    const [call] = prepared();
    expect(call?.[1]).toMatchObject({
      deductionId: CASE_ID,
      preparedBy: USER_ID,
      outcome: 'lost',
      recoveredCents: 0,
      family: 'shortage',
      invoiceId: '71',
      lines: {
        connectionId: CONNECTION_ID,
        lines: [
          { accountExternalId: '300', debitCents: 30_000, creditCents: 0, memo: MEMO },
          { accountExternalId: '200', debitCents: 20_000, creditCents: 0 },
          { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
        ],
      },
    });
    expect(call?.[2]).toMatchObject([
      { accountNameAsReported: 'Trade spend <b>&', accountTypeAsReported: 'Expense', memo: MEMO },
      { accountNameAsReported: 'Write-off shortage' },
      { accountNameAsReported: 'Deductions Receivable' },
    ]);
    expect(harness.chartReads).toEqual([{ mayRefresh: true }]);
  });

  it('takes the connection from the workspace, never from the form', async () => {
    await settle(post({ ...prepareForm(edited), connectionId: '00000000-0000-4000-8000-000000000000' }), params);
    expect((prepared()[0]?.[1] as { lines: { connectionId: string } }).lines.connectionId).toBe(CONNECTION_ID);
  });

  it('refuses a tampered account id that is not in the chart, and sends the form back without its memo', async () => {
    const tampered = [{ ...edited[0]!, account: '9999' }, edited[1]!, edited[2]!];
    const response = await settle(post(prepareForm(tampered)), params);
    const url = location(response);
    expect(url.pathname).toBe(`/cases/${CASE_ID}`);
    expect(url.hash).toBe('#settlement');
    expect(url.searchParams.get('action')).toBe('settle_lines_refused');
    expect(url.searchParams.get('sp')).toBe('account_unknown.1');
    expect(url.searchParams.getAll('sl')).toEqual(['9999~30000~0', '200~20000~0', '90~0~50000']);
    expect(url.searchParams.get('so')).toBe('lost');
    expect(response.headers.get('location')).not.toMatch(/Agreed|buyer/);
    expect(prepared()).toEqual([]);
  });

  it('refuses an account id that is not an id at all, and echoes nothing of it', async () => {
    const tampered = [{ ...edited[0]!, account: '"><script>alert(1)</script>' }, edited[1]!, edited[2]!];
    const response = await settle(post(prepareForm(tampered)), params);
    expect(location(response).searchParams.get('sp')).toBe('account_unknown.1');
    expect(response.headers.get('location')).not.toMatch(/script/i);
    expect(prepared()).toEqual([]);
  });

  it('refuses a bank, a payable, an inactive and a second receivable line', async () => {
    for (const [id, code] of [
      ['35', 'account_type_refused.1'],
      ['33', 'account_type_refused.1'],
      ['301', 'account_inactive.1'],
    ] as const) {
      const response = await settle(post(prepareForm([{ ...edited[0]!, account: id }, edited[1]!, edited[2]!])), params);
      expect(location(response).searchParams.get('sp')).toBe(code);
    }
    const receivable = await settle(
      post(prepareForm([{ account: '84', debit: '500.00' }, { account: '90', credit: '500.00' }])),
      params,
    );
    expect(location(receivable).searchParams.get('sp')).toBe('receivable_changed');
    expect(prepared()).toEqual([]);
  });

  it('refuses lines that do not balance, and says so back at the form', async () => {
    const response = await settle(
      post(prepareForm([{ ...edited[0]!, debit: '300.01' }, edited[1]!, edited[2]!])),
      params,
    );
    expect(location(response).searchParams.get('sp')).toBe('unbalanced,moves_more_than_computed');
    expect(location(response).searchParams.getAll('sl')[0]).toBe('300~30001~0');
    expect(prepared()).toEqual([]);
  });

  it('refuses an amount the money parser will not read before it reads QuickBooks or the store', async () => {
    const response = await settle(
      post(prepareForm([{ ...edited[0]!, debit: '300.5' }, edited[1]!, edited[2]!])),
      params,
    );
    expect(location(response).searchParams.get('sp')).toBe('not_integer_cents.1');
    expect(harness.chartReads).toEqual([]);
    expect(prepared()).toEqual([]);
  });

  it('refuses a form with no lines', async () => {
    const response = await settle(post(prepareForm([])), params);
    expect(location(response).searchParams.get('sp')).toContain('too_few_lines');
    expect(prepared()).toEqual([]);
  });

  it('prepares nothing when the chart cannot be read, and logs no word of the vendor\'s', async () => {
    harness.chart = 'throws';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await settle(post(prepareForm(edited)), params);
      expect(location(response).searchParams.get('action')).toBe('settle_chart_unreadable');
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Acme Foods|abc123|Agreed/);
    } finally {
      spy.mockRestore();
    }
    expect(prepared()).toEqual([]);
  });

  it('reads the chart without a refresh when the database would not store one for this member', async () => {
    harness.mayWrite = false;
    await settle(post(prepareForm(edited)), params);
    expect(harness.chartReads).toEqual([{ mayRefresh: false }]);
  });

  it('says an approved settlement takes no other, and that posting is off when the switch is', async () => {
    harness.prepareError = new SettlementAlreadyApprovedError(CASE_ID);
    expect(location(await settle(post(prepareForm(edited)), params)).searchParams.get('action')).toBe(
      'settle_already_approved',
    );
    harness.prepareError = undefined;
    harness.casePosting = ready({ connection: { connectionId: CONNECTION_ID, postingEnabled: false, hasMap: true } });
    expect(location(await settle(post(prepareForm(edited)), params)).searchParams.get('action')).toBe('posting_off');
    expect(prepared()).toEqual([]);
  });

  it('an invalid choice is refused before anything is read', async () => {
    const response = await settle(post(prepareForm(edited, { invoiceId: 'INV-71' })), params);
    expect(location(response).searchParams.get('action')).toBe('settle_invalid');
    expect(harness.calls).toEqual([]);
    expect(harness.chartReads).toEqual([]);
  });
});

describe('POST /cases/[id]/settle, intent=approve', () => {
  it('names a settlement that was replaced before it was approved', async () => {
    harness.role = 'approver';
    harness.casePosting = ready({
      settlement: { decisionId: DECISION_ID, preparedBy: OTHER_USER, outcome: 'lost', recoveredCents: cents(0), invoiceId: '71', approved: false },
    });
    harness.approveError = new SettlementApprovalRefusedError(DECISION_ID, 'superseded');
    const response = await settle(post({ intent: 'approve', decisionId: DECISION_ID }), params);
    expect(location(response).searchParams.get('action')).toBe('settle_superseded');
    expect(harness.calls.map(([name]) => name)).toEqual(['postingForCase', 'approveSettlement']);
  });

  it('approves the decision id and nothing else: no line travels with an approval', async () => {
    harness.role = 'approver';
    harness.casePosting = ready({
      settlement: { decisionId: DECISION_ID, preparedBy: OTHER_USER, outcome: 'lost', recoveredCents: cents(0), invoiceId: '71', approved: false },
    });
    const response = await settle(
      post({ intent: 'approve', decisionId: DECISION_ID, account_1: '35', debit_1: '999999.00' }),
      params,
    );
    expect(location(response).searchParams.get('action')).toBe('settle_approved');
    expect(harness.calls).toEqual([
      ['postingForCase', CASE_ID],
      ['approveSettlement', DECISION_ID],
      ['queueDecisionPostings', { decisionId: DECISION_ID, connectionId: CONNECTION_ID, withPayment: false }],
    ]);
  });
});
