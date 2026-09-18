import { describe, expect, it } from 'vitest';
import {
  CANONICAL_REASON_CODES,
  CANONICAL_REASON_CODE_LIST,
  REASON_CODE_CARDINALITY_CEILING,
  REASON_FAMILIES,
  familyOf,
  isCanonicalReasonCode,
} from '../src/reason-codes';

describe('the canonical reason-code taxonomy', () => {
  it('stays under the ceiling we set for ourselves', () => {
    // The comparison against the provider's own 255-option limit lives in
    // packages/decision, which is the package allowed to know about it.
    expect(CANONICAL_REASON_CODE_LIST.length).toBeLessThanOrEqual(
      REASON_CODE_CARDINALITY_CEILING,
    );
  });

  it('has unique codes, each in a known family', () => {
    expect(new Set(CANONICAL_REASON_CODE_LIST).size).toBe(CANONICAL_REASON_CODE_LIST.length);
    for (const code of CANONICAL_REASON_CODE_LIST) {
      expect(REASON_FAMILIES).toContain(familyOf(code));
    }
  });

  it('uses every family it declares', () => {
    const used = new Set(Object.values(CANONICAL_REASON_CODES));
    for (const family of REASON_FAMILIES) {
      expect(used.has(family), `family ${family} has no codes`).toBe(true);
    }
  });

  it('does not accept a retailer-specific code as canonical', () => {
    // '24' is Walmart's shortage code; it maps to a canonical code via playbook
    // data and must never be treated as one itself.
    expect(isCanonicalReasonCode('24')).toBe(false);
    expect(isCanonicalReasonCode('UDR')).toBe(false);
    expect(isCanonicalReasonCode('shortage_quantity')).toBe(true);
  });
});
