import { describe, expect, it } from 'vitest';
import {
  GENERAL_LEDGER_MAX_WINDOW_DAYS,
  SIZING_WINDOW_DAYS,
  cents,
  trialBalanceDifferenceCents,
  windowDays,
} from '@recouple/core-domain';
import type {
  AccountingSource,
  GeneralLedgerLine,
  LedgerAccount,
  LedgerCredit,
  LedgerInvoice,
  LedgerPayment,
} from '../src/index';
import { InMemoryAccountingSource } from '../src/testing/index';

/**
 * Phase 1.5 ships the ERP seam before the ERP. These tests pin the two things
 * a later adapter can break without noticing: that the port is read-only, and
 * that a window means what a window means at both ends.
 */

function invoice(externalId: string, issuedOn: string): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId,
    invoiceNumber: `INV-${externalId}`,
    customerExternalId: 'cus-1',
    customerName: 'Sysco Baltimore, LLC',
    issuedOn,
    totalCents: cents(100_000),
    balanceCents: cents(0),
    currency: 'USD',
  };
}

function payment(externalId: string, receivedOn: string): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cus-1',
    receivedOn,
    totalCents: cents(92_000),
    appliedTo: [],
  };
}

function credit(externalId: string, issuedOn: string): LedgerCredit {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cus-1',
    issuedOn,
    totalCents: cents(8_000),
    appliedTo: [],
  };
}

describe('AccountingSource', () => {
  it('is read-only by construction: the port has no method that writes', () => {
    // A type-level test. `AccountingSource` is exhausted by `kind` and the three
    // list methods, so this alias is `never` unless something writeable is
    // added — at which point `keyof` grows and the assignment below fails to
    // compile. Write-back is Phase 4 and belongs behind its own port.
    // `getInvoiceHistories` is a read (ADR 0035), and naming it here is how a
    // fifth method is made to arrive with an ADR rather than without one.
    type ReadOnlySurface =
      | 'kind'
      | 'listInvoices'
      | 'listPayments'
      | 'listCredits'
      | 'getInvoiceHistories'
      // The books, read through and never written (ADR 0066 §1).
      | 'chartOfAccounts'
      | 'trialBalance'
      | 'generalLedger'
      // Read to size the deductions beside sales, and never written (ADR 0073).
      | 'profitAndLoss';
    type Unexpected = Exclude<keyof AccountingSource, ReadOnlySurface>;
    const noWriteMethods: Unexpected[] = [];
    expect(noWriteMethods).toEqual([]);

    // And the other direction, so a method cannot quietly be dropped either.
    type Missing = Exclude<ReadOnlySurface, keyof AccountingSource>;
    const nothingMissing: Missing[] = [];
    expect(nothingMissing).toEqual([]);
  });

  it('lets the in-memory double satisfy the port', () => {
    const source: AccountingSource = new InMemoryAccountingSource();
    expect(source.kind).toBe('qbo');
  });
});

describe('InMemoryAccountingSource', () => {
  const source = new InMemoryAccountingSource({
    invoices: [
      invoice('inv-before', '2026-05-31'),
      invoice('inv-from', '2026-06-01'),
      invoice('inv-middle', '2026-06-15'),
      invoice('inv-to', '2026-06-30'),
      invoice('inv-after', '2026-07-01'),
    ],
    payments: [
      payment('pay-before', '2026-05-31'),
      payment('pay-from', '2026-06-01'),
      payment('pay-to', '2026-06-30'),
      payment('pay-after', '2026-07-01'),
    ],
    credits: [
      credit('cm-before', '2026-05-31'),
      credit('cm-from', '2026-06-01'),
      credit('cm-to', '2026-06-30'),
      credit('cm-after', '2026-07-01'),
    ],
  });

  const june = { from: '2026-06-01', to: '2026-06-30' };

  it('filters invoices on issuedOn, inclusive at both ends', async () => {
    expect((await source.listInvoices(june)).map((i) => i.externalId)).toEqual([
      'inv-from',
      'inv-middle',
      'inv-to',
    ]);
  });

  it('filters payments on receivedOn, inclusive at both ends', async () => {
    expect((await source.listPayments(june)).map((p) => p.externalId)).toEqual([
      'pay-from',
      'pay-to',
    ]);
  });

  it('filters credits on issuedOn, inclusive at both ends', async () => {
    expect((await source.listCredits(june)).map((c) => c.externalId)).toEqual([
      'cm-from',
      'cm-to',
    ]);
  });

  it('returns rows in the order it was given them', async () => {
    const wide = { from: '2000-01-01', to: '2100-01-01' };
    expect((await source.listInvoices(wide)).map((i) => i.externalId)).toEqual([
      'inv-before',
      'inv-from',
      'inv-middle',
      'inv-to',
      'inv-after',
    ]);
  });

  it('returns nothing for a window that contains no rows, rather than everything', async () => {
    const empty = { from: '2026-08-01', to: '2026-08-31' };
    expect(await source.listInvoices(empty)).toEqual([]);
    expect(await source.listPayments(empty)).toEqual([]);
    expect(await source.listCredits(empty)).toEqual([]);

    // A window whose end precedes its start contains nothing. It does not
    // quietly widen to everything.
    const reversed = { from: '2026-06-30', to: '2026-06-01' };
    expect(await source.listInvoices(reversed)).toEqual([]);
  });

  it('starts empty when it is given nothing', async () => {
    const bare = new InMemoryAccountingSource();
    const wide = { from: '2000-01-01', to: '2100-01-01' };
    expect(await bare.listInvoices(wide)).toEqual([]);
    expect(await bare.listPayments(wide)).toEqual([]);
    expect(await bare.listCredits(wide)).toEqual([]);
  });

  it('reads invoice histories by id, ignoring every date (ADR 0035 §2)', async () => {
    const applied = (id: string, amount: number) => [{ invoiceExternalId: id, amountCents: cents(amount) }];
    const ledger = new InMemoryAccountingSource({
      invoices: [invoice('inv-old', '2025-01-15'), invoice('inv-other', '2026-06-15')],
      payments: [
        { ...payment('pay-long-ago', '2025-02-01'), appliedTo: applied('inv-old', 50_000) },
        { ...payment('pay-recent', '2026-09-01'), appliedTo: applied('inv-old', 42_000) },
        { ...payment('pay-elsewhere', '2026-09-01'), appliedTo: applied('inv-other', 1) },
      ],
      credits: [
        { ...credit('cm-old', '2025-03-01'), appliedTo: applied('inv-old', 8_000) },
        credit('cm-unapplied', '2026-09-01'),
      ],
    });

    const histories = await ledger.getInvoiceHistories(['inv-old', 'inv-nowhere']);
    expect(histories.invoices.map((i) => i.externalId)).toEqual(['inv-old']);
    // Every application to it, whatever the date — and nothing that touches
    // only some other invoice.
    expect(histories.payments.map((p) => p.externalId)).toEqual(['pay-long-ago', 'pay-recent']);
    expect(histories.credits.map((c) => c.externalId)).toEqual(['cm-old']);

    expect(await ledger.getInvoiceHistories([])).toEqual({ invoices: [], payments: [], credits: [] });
  });

  it('stands in for the other ledgers behind the same port', () => {
    expect(new InMemoryAccountingSource({ kind: 'netsuite' }).kind).toBe('netsuite');
    expect(new InMemoryAccountingSource({ kind: 'xero' }).kind).toBe('xero');
  });
});

describe('InMemoryAccountingSource, the books (ADR 0066 §1)', () => {
  const posting = (
    accountExternalId: string,
    accountName: string,
    date: string,
    debit: number,
    credit: number,
  ): GeneralLedgerLine => ({
    accountExternalId,
    accountName,
    date,
    debitCents: cents(debit),
    creditCents: cents(credit),
  });
  const receivable: LedgerAccount = {
    sourceKind: 'qbo',
    externalId: '84',
    code: '1200',
    name: 'Accounts Receivable',
    fullyQualifiedName: 'Accounts Receivable',
    accountType: 'Accounts Receivable',
    active: true,
  };
  const source = new InMemoryAccountingSource({
    accounts: [receivable],
    trialBalanceLines: [
      {
        accountExternalId: '84',
        accountName: 'Accounts Receivable',
        debitCents: cents(50_000),
        creditCents: cents(0),
      },
      {
        accountExternalId: '79',
        accountName: 'Sales',
        debitCents: cents(0),
        creditCents: cents(40_000),
      },
    ],
    ledgerLines: [
      posting('84', 'Accounts Receivable', '2026-08-31', 10_000, 0),
      posting('97', 'Customer Deductions', '2026-09-01', 2_500, 0),
      posting('84', 'Accounts Receivable', '2026-09-01', 0, 2_500),
      posting('84', 'Accounts Receivable', '2026-09-30', 7_000, 0),
      posting('84', 'Accounts Receivable', '2026-10-01', 9_000, 0),
    ],
  });
  const september = { from: '2026-09-01', to: '2026-09-30' };

  it('returns the chart whole', async () => {
    expect(await source.chartOfAccounts()).toEqual([receivable]);
    expect(await new InMemoryAccountingSource().chartOfAccounts()).toEqual([]);
  });

  it('totals each side of the trial balance and does not make them agree', async () => {
    const tb = await source.trialBalance('2026-09-30');
    expect(tb.asOf).toBe('2026-09-30');
    expect(tb.lines).toHaveLength(2);
    expect(tb.totalDebitCents).toBe(50_000);
    expect(tb.totalCreditCents).toBe(40_000);
    expect(trialBalanceDifferenceCents(tb)).toBe(10_000);
  });

  it('reads the general ledger inclusively at both ends, by account, in first-seen order', async () => {
    const ledger = await source.generalLedger(september);
    expect(ledger.window).toEqual(september);
    expect(ledger.accounts.map((account) => [account.accountExternalId, account.lines.length])).toEqual([
      ['97', 1],
      ['84', 2],
    ]);
    expect(ledger.accounts[1]?.lines.map((line) => line.date)).toEqual(['2026-09-01', '2026-09-30']);
  });

  it('narrows to the accounts asked for, and reads nothing for none', async () => {
    const only = await source.generalLedger(september, { accountIds: ['97'] });
    expect(only.accounts.map((account) => account.accountExternalId)).toEqual(['97']);
    expect((await source.generalLedger(september, { accountIds: [] })).accounts).toEqual([]);
    expect((await source.generalLedger(september, { accountIds: ['12'] })).accounts).toEqual([]);
  });

  it('refuses a window longer than the port reads, as a real adapter does', async () => {
    expect(windowDays({ from: '2026-03-29', to: '2026-09-30' })).toBe(GENERAL_LEDGER_MAX_WINDOW_DAYS);
    await expect(source.generalLedger({ from: '2026-03-29', to: '2026-09-30' })).resolves.toBeDefined();
    await expect(source.generalLedger({ from: '2026-03-28', to: '2026-09-30' })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it('returns its profit and loss over a year, and refuses a longer window (ADR 0073)', async () => {
    const lines = [
      { accountExternalId: '79', accountName: 'Sales of Product Income', section: 'Income', amountCents: cents(100) },
    ];
    const pnlSource = new InMemoryAccountingSource({ profitAndLossLines: lines });
    const year = { from: '2025-10-01', to: '2026-09-30' };
    expect(windowDays(year)).toBe(SIZING_WINDOW_DAYS);
    expect(await pnlSource.profitAndLoss(year)).toEqual({ sourceKind: 'qbo', window: year, lines });
    expect((await new InMemoryAccountingSource().profitAndLoss(year)).lines).toEqual([]);
    await expect(pnlSource.profitAndLoss({ from: '2025-09-30', to: '2026-09-30' })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('the testing entry point', () => {
  it('is not reachable from the package index', async () => {
    // CLAUDE.md: no mocks or fixtures reachable from production code paths. The
    // double lives behind `@recouple/adapters/testing` and nothing re-exports
    // it, so importing the package cannot hand you one by accident.
    const index: Record<string, unknown> = await import('../src/index');
    expect(Object.keys(index)).not.toContain('InMemoryAccountingSource');
  });
});
