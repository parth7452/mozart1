import { describe, expect, it } from 'vitest';
import { InMemoryAccountingSource } from '@recouple/adapters/testing';
import {
  cents,
  DEFAULT_MIN_DISPUTE_CENTS,
  type KnownDeduction,
  type KnownIdentifier,
  type LedgerCredit,
  type LedgerInvoice,
  type LedgerPayment,
  type LedgerWindow,
} from '@recouple/core-domain';
import { LedgerSyncError, syncLedger } from '../src/discovery';
import { InMemoryDiscoveryStore } from '../src/testing/memory-discovery';

const ORG = 'org-1';
const WINDOW: LedgerWindow = { from: '2026-07-01', to: '2026-07-31' };

function invoice(overrides: Partial<LedgerInvoice> = {}): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId: 'inv-1',
    invoiceNumber: 'INV-1001',
    customerExternalId: 'cust-9',
    customerName: 'Sysco Baltimore, LLC',
    issuedOn: '2026-07-01',
    totalCents: cents(1_000_000),
    balanceCents: cents(80_000),
    currency: 'USD',
    ...overrides,
  };
}

function payment(overrides: Partial<LedgerPayment> = {}): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId: 'pay-1',
    customerExternalId: 'cust-9',
    receivedOn: '2026-07-20',
    totalCents: cents(920_000),
    reference: 'ACH-55512',
    memo: 'shortage',
    appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(920_000) }],
    ...overrides,
  };
}

function ledger(options: {
  readonly invoices: readonly LedgerInvoice[];
  readonly payments: readonly LedgerPayment[];
  readonly credits?: readonly LedgerCredit[];
}): InMemoryAccountingSource {
  return new InMemoryAccountingSource({
    invoices: options.invoices,
    payments: options.payments,
    credits: options.credits ?? [],
  });
}

describe('syncing a customer’s ledger', () => {
  it('opens a case for a short-pay nobody surfaced', async () => {
    const store = new InMemoryDiscoveryStore();
    const report = await syncLedger({
      source: ledger({ invoices: [invoice()], payments: [payment()] }),
      window: WINDOW,
      store,
      orgId: ORG,
      minDisputeCents: DEFAULT_MIN_DISPUTE_CENTS,
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]?.gapCents).toBe(80_000);
    expect(report.declined).toEqual([]);
    expect(report.skipped).toEqual([]);

    // The case exists, with the ledger extract as its notice and the arrival
    // recorded as `erp_sync` on the event a reviewer reads.
    const opened = store.cases[0];
    expect(opened?.customerName).toBe('Sysco Baltimore, LLC');
    expect(opened?.deductionDate).toBe('2026-07-20');
    expect(opened?.events.map((e) => e.type)).toEqual(['case.discovered']);
    expect(opened?.events[0]?.payload.source).toBe('erp_sync');

    // And the names the ledger knows it by, so the next sync matches exactly.
    expect(store.identifiers.map((i) => i.kind).sort()).toEqual([
      'invoice_number',
      'ledger_invoice_id',
    ]);
  });

  it('skips an invoice whose ledger id we already hold, and records nothing but the name', async () => {
    const identifiers: KnownIdentifier[] = [
      {
        deductionId: 'ded-existing',
        source: 'erp_sync',
        kind: 'ledger_invoice_id',
        identifier: 'inv-1',
      },
    ];
    const store = new InMemoryDiscoveryStore({ identifiers });

    const report = await syncLedger({
      source: ledger({ invoices: [invoice()], payments: [payment()] }),
      window: WINDOW,
      store,
      orgId: ORG,
    });

    expect(report.opened).toEqual([]);
    expect(report.declined).toEqual([]);
    expect(report.skipped).toEqual([
      { invoiceExternalId: 'inv-1', deductionId: 'ded-existing', matchedKind: 'ledger_invoice_id' },
    ]);
    expect(store.cases).toHaveLength(0);
    // The only write: the invoice number the ledger also knows it by.
    expect(store.identifiers.map((i) => i.kind).sort()).toEqual([
      'invoice_number',
      'ledger_invoice_id',
    ]);
    expect(store.identifiers.every((i) => i.deductionId === 'ded-existing')).toBe(true);
  });

  it('declines a gap below the floor, with a row saying what it was worth', async () => {
    const store = new InMemoryDiscoveryStore();
    const report = await syncLedger({
      source: ledger({
        invoices: [invoice({ totalCents: cents(920_010), balanceCents: cents(10) })],
        payments: [payment()],
      }),
      window: WINDOW,
      store,
      orgId: ORG,
    });

    expect(report.opened).toEqual([]);
    expect(report.declined).toHaveLength(1);
    expect(report.declined[0]?.reason).toBe('below_economic_floor');
    expect(report.declined[0]?.estimatedRecoverableCents).toBe(10);
    expect(store.cases).toHaveLength(0);
    expect(store.declines[0]?.discoveredFrom).toBe('erp_sync');
    expect(store.declines[0]?.decidedBy).toBe('triage-rules');
    // Who deducted goes on the row too, verbatim: a declined candidate has no
    // deduction and so no debtor, and a per-debtor cut of coverage cannot be
    // reconstructed from anything else later (ADR 0030 §7).
    expect(store.declines[0]?.externalIds).toEqual({
      ledger_invoice_id: 'inv-1',
      invoice_number: 'INV-1001',
      customer_external_id: 'cust-9',
      customer_name: 'Sysco Baltimore, LLC',
    });
  });

  it('declines an ambiguous match rather than choosing between two deductions', async () => {
    const identifiers: KnownIdentifier[] = [
      { deductionId: 'ded-a', source: 'erp_sync', kind: 'ledger_invoice_id', identifier: 'inv-1' },
      { deductionId: 'ded-b', source: 'web_upload', kind: 'invoice_number', identifier: 'INV-1001' },
    ];
    const store = new InMemoryDiscoveryStore({ identifiers });

    const report = await syncLedger({
      source: ledger({ invoices: [invoice()], payments: [payment()] }),
      window: WINDOW,
      store,
      orgId: ORG,
    });

    expect(report.opened).toEqual([]);
    expect(report.declined[0]?.reason).toBe('duplicate_of_other');
    expect(store.declines[0]?.detail).toContain('ded-a');
    expect(store.declines[0]?.detail).toContain('ded-b');
    expect(store.cases).toHaveLength(0);
  });

  /**
   * The asymmetry. A probable match is a guess, and the guess that loses a
   * deduction is invisible; the guess that duplicates one is a row a reviewer
   * can see (ADR 0029 §3).
   */
  it('opens a case on a probable match, flagged with what it may duplicate', async () => {
    const deductions: KnownDeduction[] = [
      {
        deductionId: 'ded-notice',
        amountCents: cents(80_000),
        invoiceNumber: 'INV-1001',
        deductionDate: '2026-07-18',
      },
    ];
    const store = new InMemoryDiscoveryStore({ deductions });

    const report = await syncLedger({
      source: ledger({ invoices: [invoice()], payments: [payment()] }),
      window: WINDOW,
      store,
      orgId: ORG,
    });

    expect(report.opened).toHaveLength(1);
    expect(report.possibleDuplicates).toEqual([
      {
        deductionId: report.opened[0]?.deductionId,
        ofDeductionId: 'ded-notice',
        basis: ['invoice_number', 'amount_cents', 'deduction_date'],
      },
    ]);
    expect(store.cases[0]?.events.map((e) => e.type)).toEqual([
      'case.discovered',
      'case.possible_duplicate',
    ]);
    // Facts that agreed, never their values (invariant 4).
    expect(JSON.stringify(store.cases[0]?.events[1]?.payload)).not.toContain('INV-1001');
  });

  it('opens nothing new and declines nothing twice when the same sync runs again', async () => {
    const store = new InMemoryDiscoveryStore();
    const source = ledger({
      invoices: [invoice(), invoice({ externalId: 'inv-2', invoiceNumber: 'INV-1002', totalCents: cents(920_010), balanceCents: cents(10) })],
      payments: [
        payment(),
        payment({
          externalId: 'pay-2',
          appliedTo: [{ invoiceExternalId: 'inv-2', amountCents: cents(920_000) }],
        }),
      ],
    });

    const first = await syncLedger({ source, window: WINDOW, store, orgId: ORG });
    expect(first.opened).toHaveLength(1);
    expect(first.declined).toHaveLength(1);
    expect(first.declined[0]?.written).toBe(true);

    const second = await syncLedger({ source, window: WINDOW, store, orgId: ORG });
    // The deduction is now ours, so the second run resolves it exactly.
    expect(second.opened).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    // And the decline is the row the first run wrote, not a second one.
    expect(second.declined).toHaveLength(1);
    expect(second.declined[0]?.written).toBe(false);
    expect(second.declined[0]?.declinedCandidateId).toBe(first.declined[0]?.declinedCandidateId);

    expect(store.cases).toHaveLength(1);
    expect(store.declines).toHaveLength(1);
  });

  it('reports a ledger anomaly rather than dropping it', async () => {
    const store = new InMemoryDiscoveryStore();
    const report = await syncLedger({
      source: ledger({
        invoices: [invoice()],
        payments: [
          payment(),
          payment({
            externalId: 'pay-ghost',
            appliedTo: [{ invoiceExternalId: 'inv-missing', amountCents: cents(100) }],
          }),
        ],
      }),
      window: WINDOW,
      store,
      orgId: ORG,
    });

    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]?.kind).toBe('application_to_unknown_invoice');
    // The rest of the ledger is still examined.
    expect(report.opened).toHaveLength(1);
  });

  it('does not swallow a store failure', async () => {
    const store = new InMemoryDiscoveryStore();
    const failing = {
      ...store,
      knownIdentifiers: () => store.knownIdentifiers(),
      knownDeductions: () => store.knownDeductions(),
      ensureIdentifiers: (...args: Parameters<typeof store.ensureIdentifiers>) =>
        store.ensureIdentifiers(...args),
      declineCandidate: (...args: Parameters<typeof store.declineCandidate>) =>
        store.declineCandidate(...args),
      recordLedgerCase: async () => {
        throw new Error('write refused');
      },
    };

    await expect(
      syncLedger({
        source: ledger({ invoices: [invoice()], payments: [payment()] }),
        window: WINDOW,
        store: failing,
        orgId: ORG,
      }),
    ).rejects.toThrow('write refused');
  });

  it('refuses a triage provider, because v1 calls none', async () => {
    const store = new InMemoryDiscoveryStore();
    await expect(
      syncLedger({
        source: ledger({ invoices: [invoice()], payments: [payment()] }),
        window: WINDOW,
        store,
        orgId: ORG,
        triageProvider: { name: 'jev' },
      }),
    ).rejects.toThrow(LedgerSyncError);
  });

  it('examines only the window it was given', async () => {
    const store = new InMemoryDiscoveryStore();
    const report = await syncLedger({
      source: ledger({ invoices: [invoice()], payments: [payment()] }),
      window: { from: '2026-08-01', to: '2026-08-31' },
      store,
      orgId: ORG,
    });
    expect(report.invoicesExamined).toBe(0);
    expect(report.opened).toEqual([]);
  });
});
