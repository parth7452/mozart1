import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  isIsoDate,
  isStorablePayerCode,
  normalisePayerCode,
  PAYER_CODE_MAX_LENGTH,
  proposedPayerCodeMapsFromDraft,
  resolveCanonicalCode,
  type PayerCodeMapRow,
} from '../src/payer-code-map';
import { CANONICAL_REASON_CODE_LIST } from '../src/reason-codes';

const DAY_0 = Date.UTC(2026, 0, 1);
const iso = (offset: number): string => new Date(DAY_0 + offset * 86_400_000).toISOString().slice(0, 10);

function row(over: Partial<PayerCodeMapRow> = {}): PayerCodeMapRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: 'org',
    debtorId: 'debtor',
    payerCode: 'CB-203',
    canonicalCode: 'price_discrepancy',
    effectiveFrom: '2026-01-01',
    source: 'customer_confirmed',
    confidence: 'high',
    recordedBy: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('normalisePayerCode', () => {
  it('trims, collapses whitespace and uppercases, and nothing else', () => {
    expect(normalisePayerCode('  cb-203 ')).toBe('CB-203');
    expect(normalisePayerCode('premium \t\n noauth')).toBe('PREMIUM NOAUTH');
    expect(normalisePayerCode('No Call No Show (NCNS)')).toBe('NO CALL NO SHOW (NCNS)');
    // Punctuation is the payer's: these stay two codes.
    expect(normalisePayerCode('CB-203')).not.toBe(normalisePayerCode('CB203'));
  });

  it('is idempotent on any string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const once = normalisePayerCode(s);
        expect(normalisePayerCode(once)).toBe(once);
      }),
      { numRuns: 2000 },
    );
  });

  it('never leaves what the database check refuses', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (s) => {
        const code = normalisePayerCode(s);
        expect(code).not.toMatch(/^ | $| {2}|[a-z]|[\t\n\r\f\v]/);
      }),
      { numRuns: 2000 },
    );
  });

  it('answers the same for any spacing or casing of one code', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9-]{1,8}$/), { minLength: 1, maxLength: 4 }),
        fc.array(fc.constantFrom(' ', '  ', '\t', ' \n '), { minLength: 5, maxLength: 5 }),
        (words, gaps) => {
          const messy =
            gaps[0] + words.map((w, i) => w.toLowerCase() + (i < words.length - 1 ? gaps[i + 1] : '')).join('') + gaps[4];
          expect(normalisePayerCode(messy)).toBe(words.join(' ').toUpperCase());
        },
      ),
    );
  });
});

describe('isStorablePayerCode', () => {
  it('refuses empty, over-long, control characters and anything not in normal form', () => {
    expect(isStorablePayerCode('CB-203')).toBe(true);
    expect(isStorablePayerCode('')).toBe(false);
    expect(isStorablePayerCode('cb-203')).toBe(false);
    expect(isStorablePayerCode('CB  203')).toBe(false);
    expect(isStorablePayerCode('CB\u0000203')).toBe(false);
    expect(isStorablePayerCode('A'.repeat(PAYER_CODE_MAX_LENGTH))).toBe(true);
    expect(isStorablePayerCode('A'.repeat(PAYER_CODE_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('isIsoDate', () => {
  it('takes a real calendar date and nothing else', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});

describe('resolveCanonicalCode', () => {
  const first = row();
  const dated = row({
    id: '00000000-0000-4000-8000-000000000002',
    canonicalCode: 'unauthorised_deduction_no_basis',
    effectiveFrom: '2026-03-01',
    effectiveTo: '2026-03-31',
  });
  const latest = row({
    id: '00000000-0000-4000-8000-000000000003',
    canonicalCode: 'promo_not_agreed',
    effectiveFrom: '2026-06-01',
  });
  const maps = [latest, first, dated];
  const at = (asOf: string) => resolveCanonicalCode(maps, { payerCode: ' cb-203', asOf })?.canonicalCode;

  it('answers the SQL suite\'s five dates the same way', () => {
    expect(at('2025-12-31')).toBeUndefined();
    expect(at('2026-02-15')).toBe('price_discrepancy');
    expect(at('2026-03-31')).toBe('unauthorised_deduction_no_basis');
    expect(at('2026-04-01')).toBe('price_discrepancy');
    expect(at('2026-06-01')).toBe('promo_not_agreed');
  });

  it('matches exactly: no prefix, no nearest', () => {
    expect(resolveCanonicalCode(maps, { payerCode: 'CB-20', asOf: '2026-06-01' })).toBeUndefined();
    expect(resolveCanonicalCode(maps, { payerCode: 'CB203', asOf: '2026-06-01' })).toBeUndefined();
    expect(resolveCanonicalCode(maps, { payerCode: 'CB-2033', asOf: '2026-06-01' })).toBeUndefined();
  });

  it('keeps one debtor\'s rows from answering for another', () => {
    const other = row({ debtorId: 'other', canonicalCode: 'shortage_carton', effectiveFrom: '2026-07-01' });
    expect(
      resolveCanonicalCode([...maps, other], { payerCode: 'CB-203', asOf: '2026-08-01', debtorId: 'debtor' })
        ?.canonicalCode,
    ).toBe('promo_not_agreed');
  });

  it('refuses a date that is not one', () => {
    expect(() => resolveCanonicalCode(maps, { payerCode: 'CB-203', asOf: 'today' })).toThrow(RangeError);
  });

  const anyRow: fc.Arbitrary<PayerCodeMapRow> = fc
    .record({
      id: fc.uuid(),
      payerCode: fc.constantFrom('CB-203', 'MCB', 'PREMIUM-NOAUTH'),
      canonicalCode: fc.constantFrom(...CANONICAL_REASON_CODE_LIST),
      from: fc.integer({ min: 0, max: 400 }),
      length: fc.option(fc.integer({ min: 0, max: 200 }), { nil: undefined }),
      created: fc.integer({ min: 0, max: 400 }),
    })
    .map(({ id, payerCode, canonicalCode, from, length, created }) =>
      row({
        id,
        payerCode,
        canonicalCode,
        effectiveFrom: iso(from),
        ...(length === undefined ? {} : { effectiveTo: iso(from + length) }),
        createdAt: `${iso(created)}T00:00:00.000Z`,
      }),
    );
  const anyQuery = fc.record({
    payerCode: fc.constantFrom('CB-203', 'MCB', 'PREMIUM-NOAUTH', 'UNSEEN'),
    asOf: fc.integer({ min: -10, max: 650 }).map(iso),
  });

  it('never answers an expired row, a row not yet in force, or another code', () => {
    fc.assert(
      fc.property(fc.array(anyRow, { maxLength: 12 }), anyQuery, (rows, query) => {
        const hit = resolveCanonicalCode(rows, query);
        if (hit === undefined) {
          // Nothing in force was passed over.
          expect(
            rows.some(
              (r) =>
                r.payerCode === query.payerCode &&
                r.effectiveFrom <= query.asOf &&
                (r.effectiveTo === undefined || r.effectiveTo >= query.asOf),
            ),
          ).toBe(false);
          return;
        }
        expect(hit.payerCode).toBe(query.payerCode);
        expect(hit.effectiveFrom <= query.asOf).toBe(true);
        expect(hit.effectiveTo === undefined || hit.effectiveTo >= query.asOf).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('answers the latest effective row among those in force', () => {
    fc.assert(
      fc.property(fc.array(anyRow, { maxLength: 12 }), anyQuery, (rows, query) => {
        const hit = resolveCanonicalCode(rows, query);
        if (hit === undefined) return;
        for (const r of rows) {
          if (r.payerCode !== query.payerCode) continue;
          if (r.effectiveFrom > query.asOf) continue;
          if (r.effectiveTo !== undefined && r.effectiveTo < query.asOf) continue;
          expect(r.effectiveFrom <= hit.effectiveFrom).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('does not depend on the order of the rows', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(anyRow, { maxLength: 10, selector: (r) => r.id }),
        anyQuery,
        (rows, query) => {
          const forward = resolveCanonicalCode(rows, query);
          const backward = resolveCanonicalCode([...rows].reverse(), query);
          expect(backward?.id).toBe(forward?.id);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('gives way to a later row, and comes back when that row expires', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 0, max: 100 }), (gap, length) => {
        const older = row({ effectiveFrom: iso(0) });
        const newer = row({
          id: '00000000-0000-4000-8000-000000000009',
          canonicalCode: 'shortage_carton',
          effectiveFrom: iso(gap),
          effectiveTo: iso(gap + length),
        });
        const ask = (day: number) =>
          resolveCanonicalCode([older, newer], { payerCode: 'CB-203', asOf: iso(day) })?.id;
        expect(ask(gap - 1)).toBe(older.id);
        expect(ask(gap)).toBe(newer.id);
        expect(ask(gap + length)).toBe(newer.id);
        expect(ask(gap + length + 1)).toBe(older.id);
      }),
    );
  });
});

describe('proposedPayerCodeMapsFromDraft', () => {
  const draft = {
    retailer_key: 'acme',
    version: '0.1.0-draft',
    drafted_from: [{ id: 'post', source_url: 'https://example.test/post' }],
    code_map: {
      categories_claimed: [{ label: 'Shortages', canonical_candidates: ['shortage_quantity'] }],
      entries: [
        { printed: 'No Call No Show (NCNS)', canonical: 'compliance_appointment_missed', source: 'post' },
        { printed: 'MCB(yyyymmdd)', canonical: 'promo_allowance_claimed', source: 'post' },
        { printed: 'LCPV(PO#)', canonical: 'compliance_pallet_spec', source: 'post' },
        { printed: '<invoice#>-111', canonical: null, why_unmapped: 'two meanings', source: 'post' },
        { printed: 'Mystery', canonical: 'not_a_code', source: 'post' },
        { printed: 'no call  no show (ncns)', canonical: 'compliance_appointment_missed', source: 'post' },
        { printed: 'Pallet', canonical: 'compliance_pallet_spec', source: 'post' },
        { printed: 'pallet', canonical: 'quality_damaged_in_transit', source: 'post' },
      ],
      freight_accessorials_claimed: {
        source: 'post',
        entries: [{ printed: 'Layover at shipper', canonical: 'detention_or_layover' }],
      },
    },
  };

  it('proposes each literal pair at low confidence, sourced to the guide', () => {
    const table = proposedPayerCodeMapsFromDraft(draft);
    expect(table.retailerKey).toBe('acme');
    expect(table.proposed).toEqual([
      {
        printed: 'No Call No Show (NCNS)',
        payerCode: 'NO CALL NO SHOW (NCNS)',
        canonicalCode: 'compliance_appointment_missed',
        source: 'glimpse_guide',
        confidence: 'low',
        sourceNote: 'Glimpse playbook draft acme 0.1.0-draft: https://example.test/post',
      },
      {
        printed: 'Layover at shipper',
        payerCode: 'LAYOVER AT SHIPPER',
        canonicalCode: 'detention_or_layover',
        source: 'glimpse_guide',
        confidence: 'low',
        sourceNote: 'Glimpse playbook draft acme 0.1.0-draft: https://example.test/post',
      },
    ]);
  });

  it('says why every other entry was not proposed', () => {
    const { skipped } = proposedPayerCodeMapsFromDraft(draft);
    expect(skipped.map((s) => [s.printed, s.reason])).toEqual([
      ['MCB(yyyymmdd)', 'shape_not_code'],
      ['LCPV(PO#)', 'shape_not_code'],
      ['<invoice#>-111', 'unmapped_in_draft'],
      ['Mystery', 'not_canonical'],
      ['no call  no show (ncns)', 'repeated_in_draft'],
      ['pallet', 'conflicting_in_draft'],
      ['Pallet', 'conflicting_in_draft'],
    ]);
  });

  it('reads a draft with no entries as nothing to propose', () => {
    expect(proposedPayerCodeMapsFromDraft({ retailer_key: 'kehe', code_map: { entries: [] } })).toEqual({
      retailerKey: 'kehe',
      proposed: [],
      skipped: [],
    });
    expect(proposedPayerCodeMapsFromDraft({})).toEqual({ proposed: [], skipped: [] });
    expect(() => proposedPayerCodeMapsFromDraft('text')).toThrow(TypeError);
  });
});
