import { describe, expect, it } from 'vitest';
import { EVIDENCE_TYPES } from '../src/evidence';
import {
  CANONICAL_EVIDENCE_REQUIREMENTS,
  NoEvidenceRequirementsError,
  evidenceChecklist,
  requirementSetOn,
  requirementsFor,
  type EvidenceRequirement,
  type EvidenceRequirementSet,
} from '../src/evidence-requirements';
import { CANONICAL_REASON_CODES, REASON_FAMILIES, type CanonicalReasonCode } from '../src/reason-codes';

function wellFormed(list: readonly EvidenceRequirement[]) {
  expect(list.length).toBeGreaterThan(0);
  expect(list.some((r) => r.required)).toBe(true);
  for (const r of list) expect(EVIDENCE_TYPES).toContain(r.evidenceType);
  expect(new Set(list.map((r) => r.evidenceType)).size).toBe(list.length);
}

describe('canonical evidence requirements', () => {
  for (const set of CANONICAL_EVIDENCE_REQUIREMENTS) {
    it(`${set.version}: every family is well formed`, () => {
      for (const f of REASON_FAMILIES) wellFormed(set.byFamily[f]);
    });
    it(`${set.version}: every override names a real code and is well formed`, () => {
      for (const [code, list] of Object.entries(set.byCode)) {
        expect(Object.keys(CANONICAL_REASON_CODES)).toContain(code);
        wellFormed(list!);
      }
    });
    it(`${set.version}: every canonical code resolves`, () => {
      for (const code of Object.keys(CANONICAL_REASON_CODES) as CanonicalReasonCode[]) {
        wellFormed(requirementsFor(code, set));
      }
    });
  }

  it('effectiveFrom strictly increases and the first starts 2000-01-01', () => {
    expect(CANONICAL_EVIDENCE_REQUIREMENTS[0]!.effectiveFrom).toBe('2000-01-01');
    for (let i = 1; i < CANONICAL_EVIDENCE_REQUIREMENTS.length; i++) {
      expect(CANONICAL_EVIDENCE_REQUIREMENTS[i]!.effectiveFrom > CANONICAL_EVIDENCE_REQUIREMENTS[i - 1]!.effectiveFrom).toBe(true);
    }
  });

  it('falls back to the family, overrides by code', () => {
    const set = CANONICAL_EVIDENCE_REQUIREMENTS[0]!;
    expect(requirementsFor('compliance_otif', set)).toBe(set.byFamily.compliance);
    expect(requirementsFor('compliance_asn_missing', set)).toBe(set.byCode.compliance_asn_missing);
  });
});

describe('requirementSetOn', () => {
  const base = CANONICAL_EVIDENCE_REQUIREMENTS[0]!;
  const sets: EvidenceRequirementSet[] = [
    { ...base, version: 'a', effectiveFrom: '2020-01-01' },
    { ...base, version: 'b', effectiveFrom: '2025-06-01' },
  ];
  it('picks the latest in force', () => {
    expect(requirementSetOn('2025-06-01', sets).version).toBe('b');
    expect(requirementSetOn('2025-05-31', sets).version).toBe('a');
  });
  it('throws before the first', () => {
    expect(() => requirementSetOn('2019-12-31', sets)).toThrow(NoEvidenceRequirementsError);
  });
  it('refuses a bad date', () => {
    expect(() => requirementSetOn('2026-9-21')).toThrow(RangeError);
    expect(() => requirementSetOn('2026-13-40')).toThrow(RangeError);
  });
  it('resolves a decision dated 2026-09-21', () => {
    expect(requirementSetOn('2026-09-21').version).toBe('2026-09-27.1');
  });
});

describe('evidenceChecklist', () => {
  it('grades have, possible and missing', () => {
    const c = evidenceChecklist({
      reason: 'compliance_late_delivery',
      onDate: '2026-09-21',
      present: [
        { documentId: 'd1', evidenceType: 'carrier_signed_bol', strength: 'have' },
        { documentId: 'd2', evidenceType: 'buyer_approval_email', strength: 'possible' },
        { documentId: 'd3', evidenceType: 'buyer_approval_email', strength: 'possible' },
        { documentId: 'd4', evidenceType: 'invoice', strength: 'have' },
      ],
    });
    expect(c.rows.map((r) => [r.evidenceType, r.status, r.documentIds])).toEqual([
      ['carrier_signed_bol', 'have', ['d1']],
      ['signed_pod', 'missing', []],
      ['buyer_approval_email', 'possible', ['d2', 'd3']],
    ]);
    expect(c.missingRequired).toBe(1);
    expect(c.version).toBe('2026-09-27.1');
  });
  it('have wins over possible for one type', () => {
    const c = evidenceChecklist({
      reason: 'promo_not_agreed',
      onDate: '2026-09-21',
      present: [
        { documentId: 'a', evidenceType: 'buyer_approval_email', strength: 'possible' },
        { documentId: 'b', evidenceType: 'buyer_approval_email', strength: 'have' },
      ],
    });
    expect(c.rows.find((r) => r.evidenceType === 'buyer_approval_email')!.status).toBe('have');
  });
  it('empty present is all missing', () => {
    const c = evidenceChecklist({ reason: 'shortage_quantity', onDate: '2026-09-21', present: [] });
    expect(c.rows.every((r) => r.status === 'missing')).toBe(true);
    expect(c.missingRequired).toBe(3);
  });
});
