import { describe, expect, it } from 'vitest';
import {
  cents,
  detectShortPays,
  invoicesNamedBy,
  settlementLedger,
  type LedgerCredit,
  type LedgerInvoice,
  type LedgerPayment,
} from '../src';

function invoice(externalId: string, total: number, balance: number): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId,
    invoiceNumber: `INV-${externalId}`,
    customerExternalId: 'cust-9',
    customerName: 'Sysco Baltimore, LLC',
    // Months before any window: the point is that it does not matter.
    issuedOn: '2026-03-01',
    totalCents: cents(total),
    balanceCents: cents(balance),
    currency: 'USD',
  };
}

function payment(
  externalId: string,
  receivedOn: string,
  appliedTo: readonly [string, number][],
): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cust-9',
    receivedOn,
    totalCents: cents(appliedTo.reduce((sum, [, amount]) => sum + amount, 0)),
    appliedTo: appliedTo.map(([invoiceExternalId, amount]) => ({
      invoiceExternalId,
      amountCents: cents(amount),
    })),
  };
}

function credit(externalId: string, appliedTo: readonly [string, number][]): LedgerCredit {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cust-9',
    issuedOn: '2026-04-01',
    totalCents: cents(appliedTo.reduce((sum, [, amount]) => sum + amount, 0)),
    appliedTo: appliedTo.map(([invoiceExternalId, amount]) => ({
      invoiceExternalId,
      amountCents: cents(amount),
    })),
  };
}

describe('invoicesNamedBy', () => {
  it('is every invoice the window’s payments and credits name, once, sorted', () => {
    expect(
      invoicesNamedBy({
        payments: [payment('p2', '2026-09-01', [['inv-b', 1], ['inv-a', 1]]), payment('p1', '2026-09-02', [['inv-b', 1]])],
        credits: [credit('c1', [['inv-c', 1]])],
      }),
    ).toEqual(['inv-a', 'inv-b', 'inv-c']);
  });
});

describe('settlementLedger (ADR 0035 §3)', () => {
  it('tallies an old invoice against every application, not only the one in the window', () => {
    // $10,000.00 invoiced in March; $6,000.00 paid in April, $4,000.00 in
    // September. The window sees only September's payment.
    const april = payment('p-apr', '2026-04-15', [['inv-1', 600_000]]);
    const september = payment('p-sep', '2026-09-10', [['inv-1', 400_000]]);
    const activity = { payments: [september], credits: [] };

    // Tallied over the window alone it is a $6,000.00 short-pay that never
    // happened — the failure a by-id fetch without histories would introduce.
    const partial = detectShortPays([invoice('inv-1', 1_000_000, 0)], [september], []);
    expect(partial.candidates.map((c) => c.gapCents)).toEqual([600_000]);

    const ledger = settlementLedger(activity, {
      invoices: [invoice('inv-1', 1_000_000, 0)],
      payments: [april, september],
      credits: [],
    });
    const report = detectShortPays(ledger.invoices, ledger.payments, ledger.credits);
    expect(report.candidates).toEqual([]);
    expect(report.anomalies).toEqual([]);
  });

  it('counts a payment in both the window and the history once', () => {
    const shortPaid = payment('p-1', '2026-09-10', [['inv-1', 920_000]]);
    const ledger = settlementLedger(
      { payments: [shortPaid], credits: [] },
      { invoices: [invoice('inv-1', 1_000_000, 80_000)], payments: [shortPaid], credits: [] },
    );
    expect(ledger.payments).toHaveLength(1);

    const report = detectShortPays(ledger.invoices, ledger.payments, ledger.credits);
    // Counted twice this would be 1,840,000 applied to a 1,000,000 invoice.
    expect(report.anomalies).toEqual([]);
    expect(report.candidates.map((c) => c.gapCents)).toEqual([80_000]);
  });

  it('trims a history payment’s application to an invoice nobody asked about', () => {
    // A cheque from May paid inv-1 and inv-9. inv-9 has no activity in the
    // window; its line is not this run's business and must not be an anomaly.
    const may = payment('p-may', '2026-05-01', [['inv-1', 500_000], ['inv-9', 70_000]]);
    const september = payment('p-sep', '2026-09-10', [['inv-1', 420_000]]);
    const ledger = settlementLedger(
      { payments: [september], credits: [] },
      { invoices: [invoice('inv-1', 1_000_000, 80_000)], payments: [may, september], credits: [] },
    );

    const report = detectShortPays(ledger.invoices, ledger.payments, ledger.credits);
    expect(report.anomalies).toEqual([]);
    expect(report.candidates).toEqual([
      expect.objectContaining({ invoiceExternalId: 'inv-1', appliedPaymentsCents: 920_000, gapCents: 80_000 }),
    ]);
  });

  it('still reports an in-window payment to an invoice the ledger did not return', () => {
    const ghost = payment('p-ghost', '2026-09-12', [['inv-missing', 100]]);
    const ledger = settlementLedger(
      { payments: [ghost], credits: [] },
      { invoices: [], payments: [], credits: [] },
    );
    const report = detectShortPays(ledger.invoices, ledger.payments, ledger.credits);
    expect(report.anomalies).toEqual([
      expect.objectContaining({
        kind: 'application_to_unknown_invoice',
        invoiceExternalId: 'inv-missing',
        transactionExternalId: 'p-ghost',
      }),
    ]);
    expect(report.anomalies[0]?.detail).toContain('which the ledger did not return');
  });

  it('prefers the history’s copy of a credit, which was assembled for these invoices', () => {
    const windowCopy = credit('c-1', []);
    const historyCopy = credit('c-1', [['inv-1', 80_000]]);
    const ledger = settlementLedger(
      { payments: [payment('p-1', '2026-09-10', [['inv-1', 920_000]])], credits: [windowCopy] },
      {
        invoices: [invoice('inv-1', 1_000_000, 0)],
        payments: [payment('p-1', '2026-09-10', [['inv-1', 920_000]])],
        credits: [historyCopy],
      },
    );
    expect(ledger.credits).toEqual([historyCopy]);

    const report = detectShortPays(ledger.invoices, ledger.payments, ledger.credits);
    // Credits explain the gap; they never shrink it.
    expect(report.candidates).toEqual([
      expect.objectContaining({ gapCents: 80_000, appliedCreditsCents: 80_000, gapStatus: 'credited' }),
    ]);
  });

  it('keeps only requested invoices, once each', () => {
    const ledger = settlementLedger(
      { payments: [payment('p-1', '2026-09-10', [['inv-1', 1]])], credits: [] },
      {
        invoices: [invoice('inv-1', 10, 9), invoice('inv-1', 10, 9), invoice('inv-2', 10, 10)],
        payments: [],
        credits: [],
      },
    );
    expect(ledger.invoices.map((i) => i.externalId)).toEqual(['inv-1']);
  });
});
