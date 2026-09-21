import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type {
  LedgerApplication,
  LedgerCredit,
  LedgerInvoice,
  LedgerPayment,
} from '@recouple/adapters';
import { cents } from '../src/money';
import { detectShortPays } from '../src/short-pay';
import type { LedgerAnomaly, ShortPayCandidate } from '../src/short-pay';

/**
 * The detector is the first thing in the build that finds a deduction nobody
 * told us about, so what it gets wrong is money either invented or missed.
 * These cases pin both halves: the gap it reports, and the ledger it refuses to
 * put a number on.
 */

interface InvoiceOverrides {
  readonly invoiceNumber?: string;
  readonly customerExternalId?: string;
  readonly customerName?: string;
  readonly issuedOn?: string;
  readonly totalCents?: number;
  readonly balanceCents?: number;
  readonly currency?: string;
}

function invoice(externalId: string, over: InvoiceOverrides = {}): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId,
    invoiceNumber: over.invoiceNumber ?? `INV-${externalId}`,
    customerExternalId: over.customerExternalId ?? 'cus-1',
    customerName: over.customerName ?? 'Sysco Baltimore, LLC',
    issuedOn: over.issuedOn ?? '2026-06-01',
    totalCents: cents(over.totalCents ?? 100_000),
    balanceCents: cents(over.balanceCents ?? 0),
    currency: over.currency ?? 'USD',
  };
}

function applied(pairs: readonly (readonly [string, number])[]): readonly LedgerApplication[] {
  return pairs.map(([invoiceExternalId, amount]) => ({
    invoiceExternalId,
    amountCents: cents(amount),
  }));
}

interface PaymentOverrides {
  readonly receivedOn?: string;
  readonly totalCents?: number;
  readonly reference?: string;
  readonly memo?: string;
}

function payment(
  externalId: string,
  pairs: readonly (readonly [string, number])[],
  over: PaymentOverrides = {},
): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cus-1',
    receivedOn: over.receivedOn ?? '2026-06-20',
    totalCents: cents(over.totalCents ?? pairs.reduce((a, [, n]) => a + n, 0)),
    appliedTo: applied(pairs),
    ...(over.reference === undefined ? {} : { reference: over.reference }),
    ...(over.memo === undefined ? {} : { memo: over.memo }),
  };
}

function credit(
  externalId: string,
  pairs: readonly (readonly [string, number])[],
  over: { readonly memo?: string; readonly issuedOn?: string } = {},
): LedgerCredit {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cus-1',
    issuedOn: over.issuedOn ?? '2026-06-21',
    totalCents: cents(pairs.reduce((a, [, n]) => a + n, 0)),
    appliedTo: applied(pairs),
    ...(over.memo === undefined ? {} : { memo: over.memo }),
  };
}

function only(candidates: readonly ShortPayCandidate[]): ShortPayCandidate {
  expect(candidates).toHaveLength(1);
  const first = candidates[0];
  if (first === undefined) throw new Error('unreachable: length was asserted');
  return first;
}

function kinds(anomalies: readonly LedgerAnomaly[]): readonly string[] {
  return anomalies.map((a) => a.kind);
}

describe('detectShortPays — the gap', () => {
  it('finds the deduction nobody surfaced: $1,000 invoiced, $920 received', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 8_000 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [],
    );
    const candidate = only(report.candidates);
    expect(candidate.invoiceExternalId).toBe('inv-1');
    expect(candidate.invoiceTotalCents).toBe(100_000);
    expect(candidate.appliedPaymentsCents).toBe(92_000);
    expect(candidate.appliedCreditsCents).toBe(0);
    expect(candidate.gapCents).toBe(8_000);
    expect(report.anomalies).toEqual([]);
    expect(report.invoicesExamined).toBe(1);
  });

  it('counts every payment against one invoice, not just the last', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 8_000 })],
      [
        payment('pay-1', [['inv-1', 50_000]], { receivedOn: '2026-06-10' }),
        payment('pay-2', [['inv-1', 42_000]], { receivedOn: '2026-06-20' }),
      ],
      [],
    );
    const candidate = only(report.candidates);
    expect(candidate.appliedPaymentsCents).toBe(92_000);
    expect(candidate.gapCents).toBe(8_000);
    expect(candidate.lastPaymentOn).toBe('2026-06-20');
  });

  it('carries the payment references and memos through verbatim and deduped', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 8_000 })],
      [
        payment('pay-1', [['inv-1', 50_000]], {
          reference: 'ACH 8841-A',
          memo: 'Deduction: code 24 shortage  ',
        }),
        payment('pay-2', [['inv-1', 42_000]], {
          reference: 'ACH 8841-A',
          memo: '',
        }),
      ],
      [credit('cm-1', [], { memo: 'not applied to this invoice' })],
    );
    const candidate = only(report.candidates);
    // Verbatim: the trailing spaces are the page's, not ours to tidy.
    expect(candidate.paymentMemos).toEqual(['Deduction: code 24 shortage  ']);
    expect(candidate.paymentReferences).toEqual(['ACH 8841-A']);
    expect(candidate.creditMemos).toEqual([]);
  });

  it('counts a split application across lines of one payment once for its reference', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 8_000 })],
      [
        payment(
          'pay-1',
          [
            ['inv-1', 40_000],
            ['inv-1', 52_000],
          ],
          { reference: 'CHK 1042' },
        ),
      ],
      [],
    );
    const candidate = only(report.candidates);
    expect(candidate.appliedPaymentsCents).toBe(92_000);
    expect(candidate.paymentReferences).toEqual(['CHK 1042']);
  });
});

describe('detectShortPays — gapStatus', () => {
  it("is 'open' when the gap is still on the invoice's balance", () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 8_000 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [],
    );
    expect(only(report.candidates).gapStatus).toBe('open');
  });

  it("is 'open' when a credit explains part of it and the rest is still owed", () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 5_000 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [credit('cm-1', [['inv-1', 3_000]])],
    );
    const candidate = only(report.candidates);
    expect(candidate.appliedCreditsCents).toBe(3_000);
    expect(candidate.gapCents).toBe(5_000);
    expect(candidate.gapStatus).toBe('open');
  });

  it("is 'credited' when the ledger closed the invoice anyway — money written off without a fight", () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 0 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [],
    );
    const candidate = only(report.candidates);
    expect(candidate.gapCents).toBe(8_000);
    expect(candidate.gapStatus).toBe('credited');
  });

  it("is 'credited' when a credit covers part and the balance is nevertheless zero", () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 0 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [credit('cm-1', [['inv-1', 3_000]], { memo: 'Spoilage allowance Q2' })],
    );
    const candidate = only(report.candidates);
    expect(candidate.gapCents).toBe(5_000);
    expect(candidate.gapStatus).toBe('credited');
    expect(candidate.creditMemos).toEqual(['Spoilage allowance Q2']);
  });

  it("is 'mixed' when part was written off and part is still open", () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 2_000 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [credit('cm-1', [['inv-1', 3_000]])],
    );
    const candidate = only(report.candidates);
    expect(candidate.gapCents).toBe(5_000);
    expect(candidate.gapStatus).toBe('mixed');
  });
});

describe('detectShortPays — what is not a short pay', () => {
  it('leaves an unpaid invoice alone: nobody deducted anything, nobody paid', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 100_000 })],
      [],
      [],
    );
    expect(report.candidates).toEqual([]);
    expect(report.invoicesExamined).toBe(1);
  });

  it('leaves an invoice alone when a payment names it for zero', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 100_000 })],
      [payment('pay-1', [['inv-1', 0]])],
      [],
    );
    expect(report.candidates).toEqual([]);
  });

  it('leaves an invoice alone when only a credit touched it — that is a write-off, not a short pay', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 0 })],
      [],
      [credit('cm-1', [['inv-1', 100_000]])],
    );
    expect(report.candidates).toEqual([]);
  });

  it('leaves an invoice paid in full alone', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 0 })],
      [payment('pay-1', [['inv-1', 100_000]])],
      [],
    );
    expect(report.candidates).toEqual([]);
  });

  it('leaves an invoice alone when payments and credits together close it', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 0 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [credit('cm-1', [['inv-1', 8_000]])],
    );
    expect(report.candidates).toEqual([]);
  });
});

describe('detectShortPays — anomalies are reported, never thrown', () => {
  it('reports an overapplied invoice and keeps going for the others', () => {
    const report = detectShortPays(
      [
        invoice('inv-bad', { invoiceNumber: 'INV-BAD' }),
        invoice('inv-ok', { invoiceNumber: 'INV-OK', balanceCents: 8_000 }),
      ],
      [
        payment('pay-1', [['inv-bad', 110_000]]),
        payment('pay-2', [['inv-ok', 92_000]]),
      ],
      [],
    );
    expect(kinds(report.anomalies)).toEqual(['overapplied']);
    expect(report.anomalies[0]?.invoiceExternalId).toBe('inv-bad');
    expect(report.anomalies[0]?.detail).toContain('INV-BAD');
    // The overapplied invoice gets no candidate, and the sound one still does.
    expect(only(report.candidates).invoiceExternalId).toBe('inv-ok');
    expect(report.invoicesExamined).toBe(2);
  });

  it('counts payments and credits together when deciding an invoice is overapplied', () => {
    const report = detectShortPays(
      [invoice('inv-1')],
      [payment('pay-1', [['inv-1', 92_000]])],
      [credit('cm-1', [['inv-1', 20_000]])],
    );
    expect(kinds(report.anomalies)).toEqual(['overapplied']);
    expect(report.candidates).toEqual([]);
  });

  it('reports an application naming an invoice that is not in the window', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 8_000 })],
      [
        payment('pay-1', [
          ['inv-1', 92_000],
          ['inv-elsewhere', 40_000],
        ]),
      ],
      [credit('cm-1', [['inv-elsewhere', 1_000]])],
    );
    expect(kinds(report.anomalies)).toEqual([
      'application_to_unknown_invoice',
      'application_to_unknown_invoice',
    ]);
    expect(report.anomalies[0]?.invoiceExternalId).toBe('inv-elsewhere');
    // The invoice we can see is still examined.
    expect(only(report.candidates).gapCents).toBe(8_000);
  });

  it('reports a negative application and refuses to put a number on that invoice', () => {
    const report = detectShortPays(
      [
        invoice('inv-1', { invoiceNumber: 'INV-1', balanceCents: 8_000 }),
        invoice('inv-2', { invoiceNumber: 'INV-2', balanceCents: 8_000 }),
      ],
      [
        payment('pay-1', [
          ['inv-1', 92_000],
          ['inv-1', -5_000],
        ]),
        payment('pay-2', [['inv-2', 92_000]]),
      ],
      [],
    );
    expect(kinds(report.anomalies)).toEqual(['negative_amount']);
    expect(report.anomalies[0]?.invoiceExternalId).toBe('inv-1');
    // inv-1 is untrustworthy, so it produces no candidate at all. inv-2 does.
    expect(only(report.candidates).invoiceExternalId).toBe('inv-2');
  });

  it('reports a negative amount on a credit application too', () => {
    const report = detectShortPays(
      [invoice('inv-1', { balanceCents: 8_000 })],
      [payment('pay-1', [['inv-1', 92_000]])],
      [credit('cm-1', [['inv-1', -1_000]])],
    );
    expect(kinds(report.anomalies)).toEqual(['negative_amount']);
    expect(report.candidates).toEqual([]);
  });

  it('reports a negative invoice total and a negative balance', () => {
    const report = detectShortPays(
      [
        invoice('inv-1', { invoiceNumber: 'INV-1', totalCents: -100_000 }),
        invoice('inv-2', { invoiceNumber: 'INV-2', balanceCents: -500 }),
      ],
      [payment('pay-1', [['inv-2', 92_000]])],
      [],
    );
    expect(kinds(report.anomalies)).toEqual(['negative_amount', 'negative_amount']);
    expect(report.anomalies[0]?.invoiceExternalId).toBe('inv-1');
    expect(report.anomalies[1]?.invoiceExternalId).toBe('inv-2');
    // The negative total is untrustworthy; the negative balance only changes
    // where the gap sits, so inv-2 is still reported — loudly, alongside it.
    const candidate = only(report.candidates);
    expect(candidate.invoiceExternalId).toBe('inv-2');
    expect(candidate.gapStatus).toBe('mixed');
  });

  it('reports the invoice whose currency differs from the rest of the window', () => {
    const report = detectShortPays(
      [
        invoice('inv-1', { balanceCents: 8_000 }),
        invoice('inv-2', { balanceCents: 8_000 }),
        invoice('inv-3', { invoiceNumber: 'INV-EUR', currency: 'EUR', balanceCents: 8_000 }),
      ],
      [
        payment('pay-1', [['inv-1', 92_000]]),
        payment('pay-2', [['inv-2', 92_000]]),
        payment('pay-3', [['inv-3', 92_000]]),
      ],
      [],
    );
    expect(kinds(report.anomalies)).toEqual(['currency_mismatch']);
    expect(report.anomalies[0]?.invoiceExternalId).toBe('inv-3');
    expect(report.anomalies[0]?.detail).toContain('EUR');
    // A currency the rest of the window does not share is a warning that the
    // gaps are not comparable, not a reason to drop the invoice.
    expect(report.candidates).toHaveLength(3);
  });

  it('picks the dominant currency the same way whatever order the ledger returns rows in', () => {
    const usd = invoice('inv-1');
    const eur = invoice('inv-2', { currency: 'EUR' });
    const gbp = invoice('inv-3', { currency: 'GBP' });
    // Two-all between USD and EUR, GBP alone: the alphabetically first of the
    // tied codes is the baseline, so USD and GBP are the odd ones out.
    const a = detectShortPays([usd, invoice('inv-4'), eur, invoice('inv-5', { currency: 'EUR' }), gbp], [], []);
    const b = detectShortPays([gbp, eur, invoice('inv-5', { currency: 'EUR' }), usd, invoice('inv-4')], [], []);
    const idsOf = (report: { anomalies: readonly LedgerAnomaly[] }): readonly string[] =>
      [...report.anomalies.map((x) => x.invoiceExternalId)].sort();
    expect(idsOf(a)).toEqual(['inv-1', 'inv-3', 'inv-4']);
    expect(idsOf(b)).toEqual(idsOf(a));
  });

  it('says nothing about currency when every invoice agrees', () => {
    const report = detectShortPays([invoice('inv-1'), invoice('inv-2')], [], []);
    expect(report.anomalies).toEqual([]);
  });
});

describe('detectShortPays — ordering', () => {
  it('sorts by gap descending, then invoice number ascending', () => {
    const invoices = [
      invoice('a', { invoiceNumber: 'INV-300', totalCents: 100_000, balanceCents: 5_000 }),
      invoice('b', { invoiceNumber: 'INV-100', totalCents: 100_000, balanceCents: 9_000 }),
      invoice('c', { invoiceNumber: 'INV-200', totalCents: 100_000, balanceCents: 5_000 }),
    ];
    const payments = [
      payment('p-a', [['a', 95_000]]),
      payment('p-b', [['b', 91_000]]),
      payment('p-c', [['c', 95_000]]),
    ];
    const report = detectShortPays(invoices, payments, []);
    expect(report.candidates.map((c) => [c.invoiceNumber, c.gapCents])).toEqual([
      ['INV-100', 9_000],
      ['INV-200', 5_000],
      ['INV-300', 5_000],
    ]);

    // Same ledger, different input order, same report.
    const shuffled = detectShortPays(
      [invoices[1], invoices[2], invoices[0]].filter((i) => i !== undefined),
      [payments[2], payments[0], payments[1]].filter((p) => p !== undefined),
      [],
    );
    expect(shuffled.candidates).toEqual(report.candidates);
  });

  it('breaks a tie on the invoice number with the ledger id, so the order is total', () => {
    const report = detectShortPays(
      [
        invoice('zz', { invoiceNumber: 'INV-1', balanceCents: 8_000 }),
        invoice('aa', { invoiceNumber: 'INV-1', balanceCents: 8_000 }),
      ],
      [payment('p-1', [['zz', 92_000]]), payment('p-2', [['aa', 92_000]])],
      [],
    );
    expect(report.candidates.map((c) => c.invoiceExternalId)).toEqual(['aa', 'zz']);
  });
});

describe('detectShortPays — a repeated ledger id', () => {
  it('treats one externalId as one invoice, first row wins, and still counts the rows', () => {
    const report = detectShortPays(
      [
        invoice('inv-1', { invoiceNumber: 'INV-FIRST', balanceCents: 8_000 }),
        invoice('inv-1', { invoiceNumber: 'INV-SECOND', balanceCents: 8_000 }),
      ],
      [payment('pay-1', [['inv-1', 92_000]])],
      [],
    );
    expect(only(report.candidates).invoiceNumber).toBe('INV-FIRST');
    expect(report.invoicesExamined).toBe(2);
  });
});

/**
 * Generated ledgers, deliberately malformed some of the time: applications to
 * invoices that are not there, negative amounts, invoices nobody paid, several
 * payments against one invoice. The detector has to survive all of it, because
 * a real QBO window will contain all of it.
 */
const rawLedger = fc.record({
  invoices: fc.uniqueArray(
    fc.record({
      id: fc.integer({ min: 0, max: 9 }),
      total: fc.integer({ min: 0, max: 50_000_000 }),
      balance: fc.integer({ min: 0, max: 50_000_000 }),
      currency: fc.constantFrom('USD', 'EUR', 'GBP'),
    }),
    { selector: (i) => i.id, maxLength: 8 },
  ),
  payments: fc.array(
    fc.record({
      id: fc.integer({ min: 0, max: 99 }),
      day: fc.integer({ min: 1, max: 28 }),
      apps: fc.array(
        fc.record({
          target: fc.integer({ min: 0, max: 12 }),
          amount: fc.integer({ min: -1_000_000, max: 50_000_000 }),
        }),
        { maxLength: 4 },
      ),
    }),
    { maxLength: 8 },
  ),
  credits: fc.array(
    fc.record({
      id: fc.integer({ min: 0, max: 99 }),
      apps: fc.array(
        fc.record({
          target: fc.integer({ min: 0, max: 12 }),
          amount: fc.integer({ min: -1_000_000, max: 50_000_000 }),
        }),
        { maxLength: 4 },
      ),
    }),
    { maxLength: 8 },
  ),
});

function buildLedger(raw: {
  invoices: readonly { id: number; total: number; balance: number; currency: string }[];
  payments: readonly {
    id: number;
    day: number;
    apps: readonly { target: number; amount: number }[];
  }[];
  credits: readonly { id: number; apps: readonly { target: number; amount: number }[] }[];
}): {
  invoices: readonly LedgerInvoice[];
  payments: readonly LedgerPayment[];
  credits: readonly LedgerCredit[];
} {
  return {
    invoices: raw.invoices.map((i) =>
      invoice(`inv-${i.id}`, {
        invoiceNumber: `INV-${i.id}`,
        totalCents: i.total,
        balanceCents: i.balance,
        currency: i.currency,
      }),
    ),
    payments: raw.payments.map((p, index) =>
      payment(
        `pay-${index}-${p.id}`,
        p.apps.map((a) => [`inv-${a.target}`, a.amount] as const),
        { receivedOn: `2026-06-${String(p.day).padStart(2, '0')}` },
      ),
    ),
    credits: raw.credits.map((c, index) =>
      credit(
        `cm-${index}-${c.id}`,
        c.apps.map((a) => [`inv-${a.target}`, a.amount] as const),
      ),
    ),
  };
}

/** Recomputed independently of the detector, so the assertion is a check. */
function appliedTo(
  docs: readonly { readonly appliedTo: readonly LedgerApplication[] }[],
  invoiceExternalId: string,
): number {
  let total = 0;
  for (const doc of docs) {
    for (const application of doc.appliedTo) {
      if (application.invoiceExternalId === invoiceExternalId) total += application.amountCents;
    }
  }
  return total;
}

describe('detectShortPays — properties', () => {
  it('never throws, whatever the ledger looks like', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        expect(() => detectShortPays(invoices, payments, credits)).not.toThrow();
      }),
    );
  });

  it('reports a strictly positive gap for every candidate', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        for (const candidate of detectShortPays(invoices, payments, credits).candidates) {
          expect(candidate.gapCents).toBeGreaterThan(0);
          expect(Number.isSafeInteger(candidate.gapCents)).toBe(true);
        }
      }),
    );
  });

  it('reports a gap that is exactly total − payments − credits', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        const report = detectShortPays(invoices, payments, credits);
        for (const candidate of report.candidates) {
          const paid = appliedTo(payments, candidate.invoiceExternalId);
          const credited = appliedTo(credits, candidate.invoiceExternalId);
          expect(candidate.appliedPaymentsCents).toBe(paid);
          expect(candidate.appliedCreditsCents).toBe(credited);
          expect(candidate.gapCents).toBe(candidate.invoiceTotalCents - paid - credited);
        }
      }),
    );
  });

  it('never reports the same invoice twice', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        const ids = detectShortPays(invoices, payments, credits).candidates.map(
          (c) => c.invoiceExternalId,
        );
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });

  it('never invents a candidate out of an invoice nobody paid', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        for (const candidate of detectShortPays(invoices, payments, credits).candidates) {
          expect(candidate.appliedPaymentsCents).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('examines every invoice row it is handed, and reports an invoice it knows about', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        const report = detectShortPays(invoices, payments, credits);
        expect(report.invoicesExamined).toBe(invoices.length);
        const known = new Set(invoices.map((i) => i.externalId));
        for (const candidate of report.candidates) {
          expect(known.has(candidate.invoiceExternalId)).toBe(true);
        }
      }),
    );
  });

  it('comes back in a total, deterministic order', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        const candidates = detectShortPays(invoices, payments, credits).candidates;
        for (let i = 1; i < candidates.length; i++) {
          const prev = candidates[i - 1];
          const next = candidates[i];
          if (prev === undefined || next === undefined) throw new Error('unreachable');
          if (prev.gapCents === next.gapCents) {
            if (prev.invoiceNumber === next.invoiceNumber) {
              expect(prev.invoiceExternalId < next.invoiceExternalId).toBe(true);
            } else {
              expect(prev.invoiceNumber < next.invoiceNumber).toBe(true);
            }
          } else {
            expect(prev.gapCents).toBeGreaterThan(next.gapCents);
          }
        }
      }),
    );
  });

  it('is a pure function: the same ledger gives the same report twice', () => {
    fc.assert(
      fc.property(rawLedger, (raw) => {
        const { invoices, payments, credits } = buildLedger(raw);
        expect(detectShortPays(invoices, payments, credits)).toEqual(
          detectShortPays(invoices, payments, credits),
        );
      }),
    );
  });
});
