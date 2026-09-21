import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  cents,
  DEFAULT_MIN_DISPUTE_CENTS,
  assertMinDisputeCentsDirection,
  triageCandidate,
  ThresholdDirectionError,
  type IdentityResolution,
  type ShortPayCandidate,
} from '../src/index';

function candidate(gapCents: number): ShortPayCandidate {
  return {
    invoiceExternalId: 'inv-1',
    invoiceNumber: 'INV-1001',
    customerExternalId: 'cust-9',
    customerName: 'Sysco Baltimore, LLC',
    invoiceTotalCents: cents(gapCents + 92_000),
    appliedPaymentsCents: cents(92_000),
    appliedCreditsCents: cents(0),
    gapCents: cents(gapCents),
    gapStatus: 'open',
    paymentReferences: ['ACH-55512'],
    paymentMemos: ['deduction code 24'],
    creditMemos: [],
    lastPaymentOn: '2026-07-20',
  };
}

const options = { minDisputeCents: DEFAULT_MIN_DISPUTE_CENTS };

describe('triage over a short-pay candidate', () => {
  it('skips a deduction we already hold, and never opens a second case for it', () => {
    const resolution: IdentityResolution = {
      kind: 'exact',
      deductionId: 'ded-1',
      matchedOn: {
        deductionId: 'ded-1',
        source: 'web_upload',
        kind: 'invoice_number',
        identifier: 'INV-1001',
      },
    };
    const decision = triageCandidate(candidate(800_000), resolution, options);
    expect(decision).toEqual({
      kind: 'skip_exact_match',
      deductionId: 'ded-1',
      matchedKind: 'invoice_number',
    });
  });

  it('skips an exact match even when the gap is below the floor', () => {
    // Identity is asked first on purpose: a deduction we already hold is not a
    // small one we chose not to fight, and counting it as one would put its
    // dollars in the denominator twice.
    const resolution: IdentityResolution = {
      kind: 'exact',
      deductionId: 'ded-1',
      matchedOn: {
        deductionId: 'ded-1',
        source: 'erp_sync',
        kind: 'ledger_invoice_id',
        identifier: 'inv-1',
      },
    };
    expect(triageCandidate(candidate(5), resolution, options).kind).toBe('skip_exact_match');
  });

  it('declines an ambiguous match, naming the deductions a person should look at', () => {
    const resolution: IdentityResolution = {
      kind: 'ambiguous',
      deductionIds: ['ded-1', 'ded-2'],
      basis: ['invoice_number'],
    };
    const decision = triageCandidate(candidate(800_000), resolution, options);
    if (decision.kind !== 'decline') throw new Error('expected a decline');
    expect(decision.reason).toBe('duplicate_of_other');
    expect(decision.detail).toContain('ded-1');
    expect(decision.detail).toContain('ded-2');
    expect(decision.estimatedRecoverableCents).toBe(800_000);
  });

  it('declines a gap below the economic floor, with what it was worth', () => {
    const decision = triageCandidate(candidate(2), { kind: 'none' }, options);
    if (decision.kind !== 'decline') throw new Error('expected a decline');
    expect(decision.reason).toBe('below_economic_floor');
    expect(decision.estimatedRecoverableCents).toBe(2);
    expect(decision.detail).toContain(String(DEFAULT_MIN_DISPUTE_CENTS));
  });

  it('opens a case at exactly the floor', () => {
    expect(
      triageCandidate(candidate(DEFAULT_MIN_DISPUTE_CENTS), { kind: 'none' }, options).kind,
    ).toBe('open_case');
  });

  it('opens a fresh short-pay', () => {
    expect(triageCandidate(candidate(800_000), { kind: 'none' }, options)).toEqual({
      kind: 'open_case',
    });
  });

  /**
   * The asymmetry, asserted. Losing a deduction is the worse error (ADR 0027,
   * ADR 0028 §3): a duplicate case is visible and still disputable, a dropped
   * arrival is not.
   */
  it('opens a case on a probable match anyway, flagging what it may duplicate', () => {
    const resolution: IdentityResolution = {
      kind: 'probable',
      deductionId: 'ded-7',
      basis: ['invoice_number', 'amount_cents', 'deduction_date'],
    };
    const decision = triageCandidate(candidate(800_000), resolution, options);
    expect(decision).toEqual({
      kind: 'open_case',
      possibleDuplicateOf: {
        deductionId: 'ded-7',
        basis: ['invoice_number', 'amount_cents', 'deduction_date'],
      },
    });
  });

  it('declines a probable match that is below the floor, rather than opening it', () => {
    const resolution: IdentityResolution = {
      kind: 'probable',
      deductionId: 'ded-7',
      basis: ['invoice_number', 'amount_cents', 'deduction_date'],
    };
    const decision = triageCandidate(candidate(10), resolution, options);
    if (decision.kind !== 'decline') throw new Error('expected a decline');
    expect(decision.reason).toBe('below_economic_floor');
  });

  it('never opens a case for an exact match, and never throws', () => {
    const resolutions: fc.Arbitrary<IdentityResolution> = fc.oneof(
      fc.constant<IdentityResolution>({ kind: 'none' }),
      fc.record({
        kind: fc.constant<'exact'>('exact'),
        deductionId: fc.string({ minLength: 1 }),
        matchedOn: fc.record({
          deductionId: fc.string({ minLength: 1 }),
          source: fc.constantFrom('web_upload', 'erp_sync', 'edi_812'),
          kind: fc.constantFrom('invoice_number' as const, 'ledger_invoice_id' as const),
          identifier: fc.string({ minLength: 1 }),
        }),
      }),
      fc.record({
        kind: fc.constant<'probable'>('probable'),
        deductionId: fc.string({ minLength: 1 }),
        basis: fc.array(fc.string(), { maxLength: 4 }),
      }),
      fc.record({
        kind: fc.constant<'ambiguous'>('ambiguous'),
        deductionIds: fc.array(fc.string(), { minLength: 2, maxLength: 4 }),
        basis: fc.array(fc.string(), { maxLength: 4 }),
      }),
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        resolutions,
        // Including nonsense floors: a NaN or a negative must not decline
        // everything or throw.
        fc.oneof(fc.integer({ min: -1_000, max: 1_000_000 }), fc.constant(Number.NaN)),
        (gap, resolution, floor) => {
          const decision = triageCandidate(candidate(gap), resolution, {
            minDisputeCents: floor,
          });
          if (resolution.kind === 'exact') {
            expect(decision.kind).toBe('skip_exact_match');
          }
          if (decision.kind === 'open_case') {
            expect(resolution.kind).not.toBe('exact');
            expect(resolution.kind).not.toBe('ambiguous');
          }
          if (decision.kind === 'decline') {
            expect(decision.estimatedRecoverableCents).toBe(gap);
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('the dispute floor', () => {
  it('is $25.00, and moving it up needs an ADR', () => {
    expect(DEFAULT_MIN_DISPUTE_CENTS).toBe(2_500);
    // Lowering opens more cases and declines fewer: the tightening direction.
    expect(() => assertMinDisputeCentsDirection(DEFAULT_MIN_DISPUTE_CENTS, 1_000)).not.toThrow();
    expect(() => assertMinDisputeCentsDirection(DEFAULT_MIN_DISPUTE_CENTS, 50_000)).toThrow(
      ThresholdDirectionError,
    );
    expect(() =>
      assertMinDisputeCentsDirection(DEFAULT_MIN_DISPUTE_CENTS, 50_000, 'ADR 0028'),
    ).not.toThrow();
  });
});
