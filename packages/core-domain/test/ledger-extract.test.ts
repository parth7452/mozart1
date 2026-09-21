import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import {
  buildLedgerExtract,
  cents,
  detectShortPays,
  LedgerExtractError,
  type LedgerCredit,
  type LedgerInvoice,
  type LedgerPayment,
} from '../src/index';

function invoice(overrides: Partial<LedgerInvoice> = {}): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId: 'inv-1',
    invoiceNumber: 'INV-1001',
    customerExternalId: 'cust-9',
    customerName: 'Sysco Baltimore, LLC',
    issuedOn: '2026-07-01',
    dueOn: '2026-07-31',
    totalCents: cents(100_000),
    balanceCents: cents(8_000),
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
    totalCents: cents(92_000),
    reference: 'ACH-55512',
    memo: 'deduction code 24 shortage',
    appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(92_000) }],
    ...overrides,
  };
}

function credit(overrides: Partial<LedgerCredit> = {}): LedgerCredit {
  return {
    sourceKind: 'qbo',
    externalId: 'cm-1',
    customerExternalId: 'cust-9',
    issuedOn: '2026-07-25',
    totalCents: cents(8_000),
    memo: 'write off short pay',
    appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(8_000) }],
    ...overrides,
  };
}

function candidateFor(
  invoices: readonly LedgerInvoice[],
  payments: readonly LedgerPayment[],
  credits: readonly LedgerCredit[],
  externalId = 'inv-1',
) {
  const report = detectShortPays(invoices, payments, credits);
  // By id, not by position: candidates come back sorted by gap descending, so
  // adding a second invoice to a fixture would otherwise silently change which
  // one the test is about.
  const found = report.candidates.find((c) => c.invoiceExternalId === externalId);
  if (found === undefined) throw new Error(`fixture produced no candidate for ${externalId}`);
  return found;
}

describe('a short-paid invoice, rendered as a document', () => {
  it('is byte-identical for the same ledger state', () => {
    const invoices = [invoice()];
    const payments = [payment()];
    const credits = [credit()];
    const candidate = candidateFor(invoices, payments, credits);

    const first = buildLedgerExtract(candidate, invoice(), payments, credits);
    const second = buildLedgerExtract(candidate, invoice(), payments, credits);

    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    // The hash is of the bytes, not of a second serialisation of the object:
    // a document stored under one hash and dedupable under another is worse
    // than no dedupe at all.
    expect(first.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));
  });

  /**
   * The property `findDocumentByHash` rests on. A vendor returns rows in
   * whatever order it likes, and the same ledger read twice must still be one
   * document — otherwise every sync stores a second copy and opens a second
   * case for it.
   */
  it('does not depend on the order the ledger returned rows in', () => {
    const invoices = [invoice()];
    const payments = [
      payment(),
      payment({
        externalId: 'pay-2',
        receivedOn: '2026-07-22',
        totalCents: cents(0),
        reference: 'ACH-55513',
        appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(0) }],
      }),
    ];
    const credits = [
      credit(),
      credit({ externalId: 'cm-2', totalCents: cents(0), appliedTo: [] }),
    ];
    const candidate = candidateFor(invoices, payments, credits);

    const forward = buildLedgerExtract(candidate, invoice(), payments, credits);
    const reversed = buildLedgerExtract(
      candidate,
      invoice(),
      [...payments].reverse(),
      [...credits].reverse(),
    );
    expect(reversed.sha256).toBe(forward.sha256);
  });

  it('carries only the rows that touched this invoice, and what they applied', () => {
    const invoices = [invoice(), invoice({ externalId: 'inv-2', invoiceNumber: 'INV-1002' })];
    const payments = [
      payment(),
      payment({
        externalId: 'pay-other',
        appliedTo: [{ invoiceExternalId: 'inv-2', amountCents: cents(500) }],
      }),
    ];
    const credits = [credit()];
    const candidate = candidateFor(invoices, payments, credits);

    const extract = buildLedgerExtract(candidate, invoice(), payments, credits);
    const body = JSON.parse(new TextDecoder().decode(extract.bytes)) as {
      payments: readonly { externalId: string; appliedCents: number }[];
      credits: readonly { externalId: string }[];
      candidate: { gapCents: number; gapStatus: string; paymentMemos: readonly string[] };
    };

    expect(body.payments.map((p) => p.externalId)).toEqual(['pay-1']);
    expect(body.payments[0]?.appliedCents).toBe(92_000);
    expect(body.credits.map((c) => c.externalId)).toEqual(['cm-1']);
    // The gap is total − payments; the credit explains it and does not shrink it.
    expect(body.candidate.gapCents).toBe(8_000);
    // The invoice still carries the gap on its balance, so the gap is open —
    // the credit here is a second document against the same invoice, not the
    // write-off that closed it.
    expect(body.candidate.gapStatus).toBe('open');
    // Verbatim: the only words a remittance gives about *why* money is missing.
    expect(body.candidate.paymentMemos).toEqual(['deduction code 24 shortage']);
  });

  it('records a timestamp of nothing: no "now" anywhere in the bytes', () => {
    const invoices = [invoice()];
    const payments = [payment()];
    const candidate = candidateFor(invoices, payments, []);
    const text = new TextDecoder().decode(
      buildLedgerExtract(candidate, invoice(), payments, []).bytes,
    );
    const thisYear = new Date().getUTCFullYear();
    // Every date in the extract is a ledger date from the fixture. A generated
    // one would be today's, and today is not 2026-07.
    for (const found of text.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
      expect(['2026-07-01', '2026-07-31', '2026-07-20', '2026-07-25']).toContain(found[0]);
    }
    expect(text).not.toContain(`${thisYear}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-${String(new Date().getUTCDate()).padStart(2, '0')}T`);
  });

  it('refuses an invoice that is not the candidate’s', () => {
    const invoices = [invoice()];
    const payments = [payment()];
    const candidate = candidateFor(invoices, payments, []);
    expect(() => buildLedgerExtract(candidate, invoice({ externalId: 'inv-9' }), payments, [])).toThrow(
      LedgerExtractError,
    );
  });

  it('writes every money field as an integer, for any short-pay the detector produces', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5_000_000 }),
        fc.integer({ min: 1, max: 4_999_999 }),
        (total, paid) => {
          fc.pre(paid < total);
          const invoices = [invoice({ totalCents: cents(total), balanceCents: cents(total - paid) })];
          const payments = [
            payment({
              totalCents: cents(paid),
              appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(paid) }],
            }),
          ];
          const candidate = candidateFor(invoices, payments, []);
          const extract = buildLedgerExtract(candidate, invoices[0] as LedgerInvoice, payments, []);
          const body = JSON.parse(new TextDecoder().decode(extract.bytes)) as Record<
            string,
            unknown
          >;
          const moneyFields: number[] = [];
          const walk = (node: unknown): void => {
            if (Array.isArray(node)) {
              for (const item of node) walk(item);
              return;
            }
            if (node !== null && typeof node === 'object') {
              for (const [key, value] of Object.entries(node)) {
                if (key.endsWith('Cents')) moneyFields.push(value as number);
                else walk(value);
              }
            }
          };
          walk(body);
          expect(moneyFields.length).toBeGreaterThan(0);
          for (const value of moneyFields) expect(Number.isInteger(value)).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
