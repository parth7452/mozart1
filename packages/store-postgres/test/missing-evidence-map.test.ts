import { describe, expect, it } from 'vitest';
import { EVIDENCE_TYPES } from '@recouple/core-domain';
import { EVIDENCE_FOR_MISSING, MISSING_EVIDENCE_TYPES } from '../src/store';

describe('EVIDENCE_FOR_MISSING', () => {
  it('leaves the decline strings unchanged', () => {
    expect(MISSING_EVIDENCE_TYPES).toEqual([
      'proof_of_delivery',
      'bill_of_lading',
      'invoice',
      'purchase_order',
      'receiving_report',
      'timesheet',
      'rate_agreement',
      'correspondence',
    ]);
  });
  it('has exactly the decline strings as keys and maps to evidence types', () => {
    expect(Object.keys(EVIDENCE_FOR_MISSING).sort()).toEqual([...MISSING_EVIDENCE_TYPES].sort());
    for (const v of Object.values(EVIDENCE_FOR_MISSING)) if (v !== null) expect(EVIDENCE_TYPES).toContain(v);
  });
  it('has no type for a receiving report or a timesheet', () => {
    expect(EVIDENCE_FOR_MISSING.receiving_report).toBeNull();
    expect(EVIDENCE_FOR_MISSING.timesheet).toBeNull();
  });
});
