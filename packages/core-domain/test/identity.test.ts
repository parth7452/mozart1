import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  IDENTIFIER_KINDS,
  IdentityError,
  identifierMatchKey,
  resolveIdentity,
  type ArrivalIdentity,
  type IdentifierKind,
  type KnownDeduction,
  type KnownIdentifier,
} from '../src/identity';
import { cents } from '../src/money';

const known = (
  deductionId: string,
  kind: IdentifierKind,
  identifier: string,
  source = 'erp_sync',
): KnownIdentifier => ({ deductionId, source, kind, identifier });

describe('identifierMatchKey', () => {
  it('trims, case-folds and collapses internal whitespace', () => {
    expect(identifierMatchKey('  APDP-99812 ')).toBe('apdp-99812');
    expect(identifierMatchKey('CM  8812')).toBe('cm 8812');
    expect(identifierMatchKey('cm\t8812')).toBe('cm 8812');
  });

  it('does not strip punctuation — that is a fact about a source, not code', () => {
    expect(identifierMatchKey('APDP-99812')).not.toBe(identifierMatchKey('APDP99812'));
    expect(identifierMatchKey('CM/8812')).not.toBe(identifierMatchKey('CM-8812'));
  });

  it('has no key for a value with nothing in it', () => {
    expect(identifierMatchKey('')).toBe('');
    expect(identifierMatchKey('   ')).toBe('');
  });
});

describe('resolveIdentity — exact', () => {
  const identifiers = [
    known('d-1', 'claim_id', 'APDP-99812'),
    known('d-1', 'credit_memo_id', 'CM-8812'),
    known('d-2', 'claim_id', 'APDP-11111'),
  ];

  it('resolves on an identifier of the same kind, however it was written', () => {
    const result = resolveIdentity(
      { identifiers: [{ kind: 'claim_id', identifier: '  apdp-99812 ' }] },
      identifiers,
      [],
    );
    expect(result.kind).toBe('exact');
    if (result.kind !== 'exact') throw new Error('unreachable');
    expect(result.deductionId).toBe('d-1');
    expect(result.matchedOn.identifier).toBe('APDP-99812');
    expect(result.matchedOn.source).toBe('erp_sync');
  });

  it('compares within a kind: the same string of another kind is another name', () => {
    expect(
      resolveIdentity(
        { identifiers: [{ kind: 'portal_claim_id', identifier: 'CM-8812' }] },
        identifiers,
        [],
      ),
    ).toEqual({ kind: 'none' });
  });

  it('ignores the source, because two sources may hold the same name', () => {
    const result = resolveIdentity(
      { identifiers: [{ kind: 'claim_id', identifier: 'APDP-99812' }] },
      [known('d-1', 'claim_id', 'APDP-99812', 'portal_fetch')],
      [],
    );
    expect(result.kind).toBe('exact');
  });

  it('is still exact when several identifiers point at the one deduction', () => {
    const result = resolveIdentity(
      {
        identifiers: [
          { kind: 'claim_id', identifier: 'APDP-99812' },
          { kind: 'credit_memo_id', identifier: 'CM-8812' },
        ],
      },
      identifiers,
      [],
    );
    expect(result.kind).toBe('exact');
    if (result.kind !== 'exact') throw new Error('unreachable');
    expect(result.deductionId).toBe('d-1');
  });

  it('never matches on a blank identifier', () => {
    expect(
      resolveIdentity({ identifiers: [{ kind: 'claim_id', identifier: '   ' }] }, [
        known('d-1', 'claim_id', ' '),
      ], []),
    ).toEqual({ kind: 'none' });
  });
});

describe('resolveIdentity — two exact matches is ambiguous', () => {
  it('holds rather than choosing between two deductions', () => {
    const result = resolveIdentity(
      {
        identifiers: [
          { kind: 'claim_id', identifier: 'APDP-99812' },
          { kind: 'credit_memo_id', identifier: 'CM-8812' },
        ],
      },
      [known('d-1', 'claim_id', 'APDP-99812'), known('d-2', 'credit_memo_id', 'CM-8812')],
      [],
    );
    expect(result).toEqual({
      kind: 'ambiguous',
      deductionIds: ['d-1', 'd-2'],
      basis: ['claim_id', 'credit_memo_id'],
    });
  });

  it('holds when one identifier was recorded against two deductions', () => {
    // The database refuses this per source; across sources it is allowed, and
    // two sources disagreeing about who owns a name is exactly a question.
    const result = resolveIdentity(
      { identifiers: [{ kind: 'claim_id', identifier: 'APDP-99812' }] },
      [
        known('d-1', 'claim_id', 'APDP-99812', 'erp_sync'),
        known('d-2', 'claim_id', 'apdp-99812', 'portal_fetch'),
      ],
      [],
    );
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('unreachable');
    expect(result.deductionIds).toEqual(['d-1', 'd-2']);
  });

  it('does not fall back to a probable match when the exact ones disagree', () => {
    const candidate: KnownDeduction = {
      deductionId: 'd-3',
      amountCents: cents(312_000),
      invoiceNumber: 'INV-1',
      deductionDate: '2026-08-14',
    };
    const result = resolveIdentity(
      {
        identifiers: [
          { kind: 'claim_id', identifier: 'APDP-99812' },
          { kind: 'credit_memo_id', identifier: 'CM-8812' },
        ],
        amountCents: cents(312_000),
        invoiceNumber: 'INV-1',
        deductionDate: '2026-08-14',
      },
      [known('d-1', 'claim_id', 'APDP-99812'), known('d-2', 'credit_memo_id', 'CM-8812')],
      [candidate],
    );
    expect(result.kind).toBe('ambiguous');
  });
});

describe('resolveIdentity — probable', () => {
  const candidate: KnownDeduction = {
    deductionId: 'd-1',
    amountCents: cents(312_000),
    invoiceNumber: 'INV-4471',
    deductionDate: '2026-08-14',
    debtorId: 'debtor-walmart',
  };
  const arrival: ArrivalIdentity = {
    identifiers: [{ kind: 'credit_memo_id', identifier: 'CM-NEVER-SEEN' }],
    amountCents: cents(312_000),
    invoiceNumber: 'inv-4471',
    deductionDate: '2026-08-18',
    debtorId: 'debtor-walmart',
  };

  it('holds a pair that agrees on invoice, amount, date and debtor', () => {
    const result = resolveIdentity(arrival, [], [candidate]);
    expect(result).toEqual({
      kind: 'probable',
      deductionId: 'd-1',
      basis: ['invoice_number', 'amount_cents', 'deduction_date', 'debtor_id'],
    });
  });

  it('reports no debtor in the basis when only one side knows it', () => {
    const { debtorId: _ignored, ...withoutDebtor } = arrival;
    const result = resolveIdentity(withoutDebtor, [], [candidate]);
    expect(result.kind).toBe('probable');
    if (result.kind !== 'probable') throw new Error('unreachable');
    expect(result.basis).toEqual(['invoice_number', 'amount_cents', 'deduction_date']);
  });

  it('is not probable when both know a debtor and they disagree', () => {
    expect(resolveIdentity({ ...arrival, debtorId: 'debtor-target' }, [], [candidate])).toEqual({
      kind: 'none',
    });
  });

  it('is not probable on the amount alone', () => {
    expect(
      resolveIdentity(
        { identifiers: [], amountCents: cents(312_000) },
        [],
        [candidate],
      ),
    ).toEqual({ kind: 'none' });
  });

  it('is not probable on the date alone', () => {
    expect(
      resolveIdentity({ identifiers: [], deductionDate: '2026-08-14' }, [], [candidate]),
    ).toEqual({ kind: 'none' });
  });

  it('is not probable on the invoice alone', () => {
    expect(resolveIdentity({ identifiers: [], invoiceNumber: 'INV-4471' }, [], [candidate])).toEqual(
      { kind: 'none' },
    );
  });

  it('is not probable when the amount differs by a cent', () => {
    expect(
      resolveIdentity({ ...arrival, amountCents: cents(312_001) }, [], [candidate]),
    ).toEqual({ kind: 'none' });
  });

  it('respects the date tolerance at its edge, and just past it', () => {
    const atEdge = { ...arrival, deductionDate: '2026-08-21' }; // +7
    const pastEdge = { ...arrival, deductionDate: '2026-08-22' }; // +8
    expect(resolveIdentity(atEdge, [], [candidate]).kind).toBe('probable');
    expect(resolveIdentity(pastEdge, [], [candidate]).kind).toBe('none');
    expect(
      resolveIdentity(pastEdge, [], [candidate], { dateToleranceDays: 8 }).kind,
    ).toBe('probable');
    expect(resolveIdentity(atEdge, [], [candidate], { dateToleranceDays: 0 }).kind).toBe('none');
  });

  it('counts a date backwards the same as a date forwards', () => {
    expect(
      resolveIdentity({ ...arrival, deductionDate: '2026-08-10' }, [], [candidate]).kind,
    ).toBe('probable');
  });

  it('cannot be probable on a date it cannot read', () => {
    expect(resolveIdentity({ ...arrival, deductionDate: '08/18/2026' }, [], [candidate])).toEqual({
      kind: 'none',
    });
    expect(resolveIdentity({ ...arrival, deductionDate: '2026-02-30' }, [], [candidate])).toEqual({
      kind: 'none',
    });
  });

  it('holds rather than choosing when two candidates are equally probable', () => {
    const twin: KnownDeduction = { ...candidate, deductionId: 'd-2' };
    const result = resolveIdentity(arrival, [], [candidate, twin]);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('unreachable');
    expect(result.deductionIds).toEqual(['d-1', 'd-2']);
    expect(result.basis).toEqual([
      'invoice_number',
      'amount_cents',
      'deduction_date',
      'debtor_id',
    ]);
  });

  it('refuses a tolerance that is not a whole number of days, rather than matching nothing', () => {
    expect(() => resolveIdentity(arrival, [], [candidate], { dateToleranceDays: -1 })).toThrow(
      IdentityError,
    );
    expect(() => resolveIdentity(arrival, [], [candidate], { dateToleranceDays: 1.5 })).toThrow(
      IdentityError,
    );
    expect(() =>
      resolveIdentity(arrival, [], [candidate], { dateToleranceDays: Number.NaN }),
    ).toThrow(IdentityError);
  });
});

describe('resolveIdentity — none', () => {
  it('answers none for an arrival that knows nothing', () => {
    expect(resolveIdentity({ identifiers: [] }, [], [])).toEqual({ kind: 'none' });
  });

  it('never throws on a missing field', () => {
    const candidate: KnownDeduction = { deductionId: 'd-1', amountCents: cents(1) };
    expect(() => resolveIdentity({ identifiers: [] }, [], [candidate])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------
const identifierText = fc
  .array(fc.constantFrom(...'AB90-/ '.split('')), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(''))
  .filter((text) => text.trim() !== '');

const anyKind = fc.constantFrom(...IDENTIFIER_KINDS);

describe('resolveIdentity — properties', () => {
  it('an arrival whose identifiers are known always resolves exact or ambiguous', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            deductionId: fc.constantFrom('d-1', 'd-2', 'd-3'),
            source: fc.constantFrom('erp_sync', 'portal_fetch', 'edi_812'),
            kind: anyKind,
            identifier: identifierText,
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.nat(),
        fc.boolean(),
        (identifiers, pick, perturb) => {
          const chosen = identifiers[pick % identifiers.length];
          if (chosen === undefined) throw new Error('unreachable');
          const arrival: ArrivalIdentity = {
            identifiers: [
              {
                kind: chosen.kind,
                // Normalisation folds case and surrounding space, so a
                // perturbed writing of a known name still has to resolve.
                identifier: perturb
                  ? `  ${chosen.identifier.toLowerCase()} `
                  : chosen.identifier,
              },
            ],
          };
          const result = resolveIdentity(arrival, identifiers, []);
          expect(['exact', 'ambiguous']).toContain(result.kind);
        },
      ),
    );
  });

  it('an arrival with no identifiers and no invoice number never resolves exact', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            deductionId: fc.constantFrom('d-1', 'd-2'),
            source: fc.constant('erp_sync'),
            kind: anyKind,
            identifier: identifierText,
          }),
          { maxLength: 6 },
        ),
        fc.array(
          fc.record({
            deductionId: fc.constantFrom('d-1', 'd-2'),
            amountCents: fc.integer({ min: 1, max: 5_000_000 }).map((n) => cents(n)),
            invoiceNumber: identifierText,
            deductionDate: fc.constantFrom('2026-08-14', '2026-01-02', '2026-12-31'),
          }),
          { maxLength: 6 },
        ),
        fc.option(fc.integer({ min: 1, max: 5_000_000 }).map((n) => cents(n)), {
          nil: undefined,
        }),
        fc.option(fc.constantFrom('2026-08-14', '2026-08-18'), { nil: undefined }),
        (identifiers, deductions, amountCents, deductionDate) => {
          const arrival: ArrivalIdentity = {
            identifiers: [],
            ...(amountCents === undefined ? {} : { amountCents }),
            ...(deductionDate === undefined ? {} : { deductionDate }),
          };
          const result = resolveIdentity(arrival, identifiers, deductions);
          expect(result.kind).not.toBe('exact');
          // Probable requires an invoice number, so with neither an identifier
          // nor one there is nothing left that could match.
          expect(result.kind).toBe('none');
        },
      ),
    );
  });
});
