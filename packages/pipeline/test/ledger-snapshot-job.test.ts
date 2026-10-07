import { describe, expect, it } from 'vitest';
import { InMemoryAccountingSource } from '@recouple/adapters/testing';
import {
  cents,
  snapshotSha256,
  type LedgerAccount,
  type LedgerInvoice,
  type LedgerPayment,
  type LedgerSnapshotContent,
} from '@recouple/core-domain';
import { InMemoryDiscoveryStore } from '../src/testing/memory-discovery';
import {
  syncLedgerJob,
  type LedgerBooksSource,
  type LedgerConnectionRecord,
  type LedgerSnapshotDeps,
  type LedgerSourceFactory,
  type LedgerSyncRunRecord,
  type LedgerSyncRunStore,
} from '../src/ledger-job';

/**
 * A completed ledger sync keeps a snapshot of the books (ADR 0074).
 *
 * What would matter if this were wrong: a snapshot that kept the whole ledger
 * rather than the deductions accounts; a books read that failed taking the
 * run's short-pay result with it; a refused snapshot that broke the chain; and
 * a snapshot taken at all when the switch is off.
 */

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CONNECTION = '33333333-3333-3333-3333-333333333333';
const AT = new Date('2026-09-22T07:00:00.000Z');
const WINDOW = { from: '2026-08-19', to: '2026-09-22' };

const connection: LedgerConnectionRecord = {
  connectionId: CONNECTION,
  orgId: ORG,
  provider: 'qbo',
  providerAccountId: 'realm-9',
  enabled: true,
  createdBy: USER,
};

const invoice: LedgerInvoice = {
  sourceKind: 'qbo',
  externalId: 'inv-1',
  invoiceNumber: 'INV-1001',
  customerExternalId: 'cust-9',
  customerName: 'Sysco Baltimore, LLC',
  issuedOn: '2026-09-01',
  totalCents: cents(1_000_000),
  balanceCents: cents(80_000),
  currency: 'USD',
};

const payment: LedgerPayment = {
  sourceKind: 'qbo',
  externalId: 'pay-1',
  customerExternalId: 'cust-9',
  receivedOn: '2026-09-10',
  totalCents: cents(920_000),
  reference: 'ACH-55512',
  appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(920_000) }],
};

function account(externalId: string, name: string, accountType: string): LedgerAccount {
  return {
    sourceKind: 'qbo',
    externalId,
    name,
    fullyQualifiedName: name,
    accountType,
    active: true,
  };
}

/** A ledger with a receivable, a deductions account, a mapped account and payroll. */
function ledger(): InMemoryAccountingSource {
  const posting = (accountExternalId: string, accountName: string, date: string, debit: number) => ({
    accountExternalId,
    accountName,
    date,
    transactionType: 'Journal Entry',
    transactionExternalId: `je-${accountExternalId}-${date}`,
    memo: 'a memo that is never kept',
    name: 'Sysco Baltimore, LLC',
    debitCents: cents(debit),
    creditCents: cents(0),
  });
  return new InMemoryAccountingSource({
    invoices: [invoice],
    payments: [payment],
    credits: [],
    accounts: [
      account('84', 'Accounts Receivable', 'Accounts Receivable'),
      account('91', 'Promotional Allowances', 'Income'),
      account('77', 'Deductions Clearing', 'Other Current Asset'),
      account('60', 'Payroll Expenses', 'Expense'),
    ],
    trialBalanceLines: [
      { accountExternalId: '84', accountName: 'Accounts Receivable', debitCents: cents(80_000), creditCents: cents(0) },
      { accountExternalId: '60', accountName: 'Payroll Expenses', debitCents: cents(500_000), creditCents: cents(0) },
      { accountExternalId: '91', accountName: 'Promotional Allowances', debitCents: cents(0), creditCents: cents(580_000) },
    ],
    ledgerLines: [
      posting('84', 'Accounts Receivable', '2026-09-01', 1_000_000),
      posting('91', 'Promotional Allowances', '2026-09-12', 25_000),
      posting('77', 'Deductions Clearing', '2026-09-13', 80_000),
      posting('60', 'Payroll Expenses', '2026-09-15', 500_000),
      posting('84', 'Accounts Receivable', '2026-07-01', 1),
    ],
  });
}

class RunStore implements LedgerSyncRunStore {
  readonly written: LedgerSyncRunRecord[] = [];
  async memberMayWrite(): Promise<boolean> {
    return true;
  }
  async connection(connectionId: string): Promise<LedgerConnectionRecord | undefined> {
    return connectionId === CONNECTION ? connection : undefined;
  }
  async recordLedgerSyncRun(input: LedgerSyncRunRecord): Promise<string> {
    this.written.push(input);
    return `run-${this.written.length}`;
  }
}

class SnapshotStore {
  readonly kept: { content: LedgerSnapshotContent; sha256: string; prevSha256: string | null }[] = [];
  failWith?: Error;
  async latestSnapshotSha(): Promise<string | undefined> {
    return this.kept.at(-1)?.sha256;
  }
  async recordLedgerSnapshot(input: {
    content: LedgerSnapshotContent;
    sha256: string;
    prevSha256: string | null;
  }): Promise<string> {
    if (this.failWith !== undefined) throw this.failWith;
    this.kept.push(input);
    return `snap-${this.kept.length}`;
  }
}

function snapshotDeps(store: SnapshotStore, posting: readonly string[] = ['77']): LedgerSnapshotDeps & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    store,
    asked,
    async postingAccountIds(connectionId) {
      asked.push(connectionId);
      return posting;
    },
  };
}

function ready(source: InMemoryAccountingSource, books: LedgerBooksSource | null = source): LedgerSourceFactory {
  return {
    resolve: () => ({
      kind: 'ready' as const,
      source,
      ...(books === null ? {} : { books }),
    }),
  };
}

const INPUT = { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } };

describe('a completed ledger sync keeps the books', () => {
  it('keeps the trial balance and only the receivable, posting and deductions accounts’ postings', async () => {
    const store = new SnapshotStore();
    const deps = snapshotDeps(store);
    const result = await syncLedgerJob(
      { runs: new RunStore(), discovery: new InMemoryDiscoveryStore(), sources: ready(ledger()), now: () => AT, snapshots: deps },
      INPUT,
    );

    expect(result.outcome).toBe('completed');
    expect(result.openedCount).toBe(1);
    expect(deps.asked).toEqual([CONNECTION]);
    expect(store.kept).toHaveLength(1);
    const [kept] = store.kept;
    expect(result.snapshot).toEqual({ snapshotId: 'snap-1', status: 'complete', sha256: kept?.sha256 });
    const content = kept!.content;
    expect(content).toMatchObject({
      run_id: 'run-1',
      connection_id: CONNECTION,
      org_id: ORG,
      as_of: WINDOW.to,
      window_from: WINDOW.from,
      window_to: WINDOW.to,
      status: 'complete',
      total_debit_cents: '580000',
      total_credit_cents: '580000',
    });
    // Every trial-balance row, payroll included: the totals are the ledger's.
    expect(content.trial_balance.map((line) => line.account_external_id)).toEqual(['84', '60', '91']);
    // Postings on the receivable, the deductions-like account and the mapped
    // account, inside the window — and never payroll.
    expect(content.ledger_postings.map((line) => [line.account_external_id, line.txn_date])).toEqual([
      ['84', '2026-09-01'],
      ['91', '2026-09-12'],
      ['77', '2026-09-13'],
    ]);
    expect(JSON.stringify(content)).not.toContain('never kept');
    expect(JSON.stringify(content)).not.toContain('Sysco');
    // The first snapshot names no predecessor, and its hash is over that.
    expect(kept?.prevSha256).toBeNull();
    expect(kept?.sha256).toBe(snapshotSha256(content, null));
  });

  it('chains the next run’s snapshot to the last one', async () => {
    const store = new SnapshotStore();
    const runs = new RunStore();
    const base = { runs, discovery: new InMemoryDiscoveryStore(), sources: ready(ledger()), now: () => AT, snapshots: snapshotDeps(store) };
    await syncLedgerJob(base, INPUT);
    await syncLedgerJob(base, INPUT);
    expect(store.kept).toHaveLength(2);
    expect(store.kept[1]?.prevSha256).toBe(store.kept[0]?.sha256);
    expect(store.kept[1]?.content.run_id).toBe('run-2');
  });

  it('keeps a refused snapshot when a books read fails, and the run’s result stands', async () => {
    class QboReportTooLarge extends Error {
      override readonly name = 'QboReportTooLarge';
    }
    const source = ledger();
    const books: LedgerBooksSource = {
      chartOfAccounts: () => source.chartOfAccounts(),
      trialBalance: (asOf) => source.trialBalance(asOf),
      generalLedger: async () => {
        throw new QboReportTooLarge('20,001 lines including Sysco Baltimore');
      },
    };
    const store = new SnapshotStore();
    // A refused one still chains to what came before it.
    store.kept.push({ content: {} as LedgerSnapshotContent, sha256: 'a'.repeat(64), prevSha256: null });
    const runs = new RunStore();
    const result = await syncLedgerJob(
      { runs, discovery: new InMemoryDiscoveryStore(), sources: ready(source, books), now: () => AT, snapshots: snapshotDeps(store) },
      INPUT,
    );

    expect(result.outcome).toBe('completed');
    expect(result.openedCount).toBe(1);
    expect(runs.written.map((row) => row.outcome)).toEqual(['completed']);
    expect(result.snapshot).toMatchObject({ status: 'refused', refusalClass: 'QboReportTooLarge' });
    const kept = store.kept[1]!;
    expect(kept.content).toMatchObject({
      status: 'refused',
      refusal_class: 'QboReportTooLarge',
      total_debit_cents: null,
      trial_balance: [],
      ledger_postings: [],
    });
    expect(JSON.stringify(kept.content)).not.toContain('Sysco');
    expect(kept.prevSha256).toBe('a'.repeat(64));
    expect(kept.sha256).toBe(snapshotSha256(kept.content, 'a'.repeat(64)));
  });

  it('keeps a refused snapshot when the source has no books reads', async () => {
    const store = new SnapshotStore();
    const result = await syncLedgerJob(
      { runs: new RunStore(), discovery: new InMemoryDiscoveryStore(), sources: ready(ledger(), null), now: () => AT, snapshots: snapshotDeps(store) },
      INPUT,
    );
    expect(result.snapshot).toMatchObject({ status: 'refused', refusalClass: 'LedgerBooksNotReadableError' });
  });

  it('fails the job when the snapshot cannot be recorded, after the run row is written', async () => {
    const store = new SnapshotStore();
    store.failWith = new Error('ledger snapshot blocked: prev_sha256 is not the chain head');
    const runs = new RunStore();
    await expect(
      syncLedgerJob(
        { runs, discovery: new InMemoryDiscoveryStore(), sources: ready(ledger()), now: () => AT, snapshots: snapshotDeps(store) },
        INPUT,
      ),
    ).rejects.toThrow(/chain head/);
    expect(runs.written.map((row) => row.outcome)).toEqual(['completed']);
  });

  it('reads no books and keeps nothing when snapshots are off', async () => {
    let asked = 0;
    const source = ledger();
    const books: LedgerBooksSource = {
      chartOfAccounts: async () => {
        asked += 1;
        return source.chartOfAccounts();
      },
      trialBalance: async (asOf) => {
        asked += 1;
        return source.trialBalance(asOf);
      },
      generalLedger: async (window, options) => {
        asked += 1;
        return source.generalLedger(window, options);
      },
    };
    const result = await syncLedgerJob(
      { runs: new RunStore(), discovery: new InMemoryDiscoveryStore(), sources: ready(source, books), now: () => AT },
      INPUT,
    );
    expect(result.outcome).toBe('completed');
    expect(result.snapshot).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('keeps nothing for a run that did not complete', async () => {
    const store = new SnapshotStore();
    const runs = new RunStore();
    const notConfigured: LedgerSourceFactory = { resolve: () => ({ kind: 'not_configured', reason: 'no key' }) };
    const result = await syncLedgerJob(
      { runs, discovery: new InMemoryDiscoveryStore(), sources: notConfigured, now: () => AT, snapshots: snapshotDeps(store) },
      INPUT,
    );
    expect(result.outcome).toBe('not_configured');
    expect(store.kept).toHaveLength(0);
  });
});
