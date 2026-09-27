import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cents } from '../src/money';
import { letterPayerTerms, payerTermsFor, type PayerTermsLine } from '../src/payer-terms';

const stripUndefined = (o: Record<string, unknown>): PayerTermsLine =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as PayerTermsLine;
const notice = (over: { [K in keyof PayerTermsLine]?: PayerTermsLine[K] | undefined } = {}): PayerTermsLine => stripUndefined({
  documentId: 'doc-n',
  docType: 'deduction_notice',
  index: 0,
  reasonCode: 'SHORT',
  deductionReference: 'CB-1',
  amountCents: cents(50000),
  quoteVerified: true,
  ...over,
});
const remit = (over: { [K in keyof PayerTermsLine]?: PayerTermsLine[K] | undefined } = {}): PayerTermsLine => stripUndefined({
  documentId: 'doc-r',
  docType: 'remittance_advice',
  index: 0,
  reasonCode: 'R1',
  amountCents: cents(50000),
  invoiceNumber: 'INV-1',
  quoteVerified: null,
  ...over,
});

describe('payerTermsFor', () => {
  it('derives both fields from a notice line of equal amount', () => {
    expect(payerTermsFor({ amountCents: cents(50000), invoiceKeys: [], lines: [notice()] })).toEqual({
      kind: 'derived',
      terms: {
        reasonCode: 'SHORT',
        deductionReference: 'CB-1',
        documentId: 'doc-n',
        fieldPath: 'lines[0].reason_code',
        quoteVerified: true,
        reasonCodeVerified: null,
        deductionReferenceVerified: null,
      },
    });
  });

  it('picks the equal-amount line of two on one invoice', () => {
    const a = payerTermsFor({
      amountCents: cents(30000),
      invoiceKeys: ['inv-1'],
      lines: [remit({ index: 0, reasonCode: 'A' }), remit({ index: 1, reasonCode: 'B', amountCents: cents(30000) })],
    });
    expect(a.kind === 'derived' && a.terms.reasonCode).toBe('B');
    expect(a.kind === 'derived' && a.terms.fieldPath).toBe('lines[1].reason_code');
  });

  it('answers none when the invoice matches and the amount does not', () => {
    expect(
      payerTermsFor({ amountCents: cents(1), invoiceKeys: ['inv-1'], lines: [remit()] }).kind,
    ).toBe('none');
  });

  it('requires the remittance invoice to be one of the case', () => {
    expect(payerTermsFor({ amountCents: cents(50000), invoiceKeys: ['other'], lines: [remit()] }).kind).toBe('none');
  });

  it('answers conflicting for two qualifying lines with different codes', () => {
    const a = payerTermsFor({
      amountCents: cents(50000),
      invoiceKeys: [],
      lines: [notice({ reasonCode: 'X' }), notice({ documentId: 'doc-m', reasonCode: 'Y' })],
    });
    expect(a.kind).toBe('conflicting');
    expect(a.kind === 'conflicting' && a.candidates.map((c) => c.reasonCode)).toEqual(['Y', 'X']);
  });

  it('derives from a line with only a deduction reference', () => {
    const a = payerTermsFor({
      amountCents: cents(50000),
      invoiceKeys: [],
      lines: [notice({ reasonCode: undefined })],
    });
    expect(a).toMatchObject({ kind: 'derived', terms: { deductionReference: 'CB-1', fieldPath: 'lines[0].deduction_reference' } });
    expect(a.kind === 'derived' && 'reasonCode' in a.terms).toBe(false);
  });

  it('ignores a deduction reference on a remittance line', () => {
    const only = payerTermsFor({
      amountCents: cents(50000),
      invoiceKeys: ['inv-1'],
      lines: [remit({ reasonCode: undefined, deductionReference: 'CB-9' })],
    });
    expect(only.kind).toBe('none');
    const withCode = payerTermsFor({
      amountCents: cents(50000),
      invoiceKeys: ['inv-1'],
      lines: [remit({ deductionReference: 'CB-9' })],
    });
    expect(withCode.kind === 'derived' && withCode.terms.deductionReference).toBeUndefined();
  });

  it('gives the same answer however the lines are ordered', () => {
    const lines = [
      notice({ index: 0, reasonCode: 'X' }),
      notice({ index: 1, reasonCode: 'Y' }),
      notice({ documentId: 'doc-a', index: 3, reasonCode: 'X' }),
      remit({ index: 2 }),
      notice({ index: 4, amountCents: cents(7) }),
    ];
    const expected = payerTermsFor({ amountCents: cents(50000), invoiceKeys: ['inv-1'], lines });
    fc.assert(
      fc.property(fc.shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length }), (shuffled) => {
        expect(payerTermsFor({ amountCents: cents(50000), invoiceKeys: ['inv-1'], lines: shuffled })).toEqual(expected);
      }),
    );
  });
});

describe('letterPayerTerms', () => {
  const terms = { reasonCode: 'SHORT-QTY', deductionReference: 'CB-77', documentId: 'd', fieldPath: 'lines[0].reason_code', quoteVerified: true };
  it('prints each field only when its own quote verified', () => {
    expect(letterPayerTerms({ kind: 'derived', terms: { ...terms, reasonCodeVerified: true, deductionReferenceVerified: true } }))
      .toEqual({ payerReasonCode: 'SHORT-QTY', deductionReference: 'CB-77' });
    expect(letterPayerTerms({ kind: 'derived', terms: { ...terms, reasonCodeVerified: false, deductionReferenceVerified: null } })).toEqual({});
    expect(letterPayerTerms({ kind: 'derived', terms: { ...terms, reasonCodeVerified: null, deductionReferenceVerified: true } }))
      .toEqual({ deductionReference: 'CB-77' });
    expect(letterPayerTerms({ kind: 'derived', terms })).toEqual({});
    expect(letterPayerTerms({ kind: 'own' })).toEqual({});
  });
});
