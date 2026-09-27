import { describe, expect, it } from 'vitest';
import { EVIDENCE_TYPES } from '@recouple/core-domain';
import { DOC_TYPES } from '../src/ports';
import { EVIDENCE_FOR_DOC_TYPE, evidenceOfDocuments } from '../src/evidence-map';

describe('EVIDENCE_FOR_DOC_TYPE', () => {
  it('has exactly the document types as keys', () => {
    expect(Object.keys(EVIDENCE_FOR_DOC_TYPE).sort()).toEqual([...DOC_TYPES].sort());
  });
  it('maps only to evidence types, and leaves only packing_list without a doc type', () => {
    const mapped = Object.values(EVIDENCE_FOR_DOC_TYPE).flatMap((v) => (v ? [v.evidenceType] : []));
    for (const t of mapped) expect(EVIDENCE_TYPES).toContain(t);
    expect(EVIDENCE_TYPES.filter((t) => !mapped.includes(t))).toEqual(['packing_list']);
  });
  it('treats correspondence as possible only', () => {
    expect(EVIDENCE_FOR_DOC_TYPE.correspondence).toEqual({ evidenceType: 'buyer_approval_email', strength: 'possible' });
  });
  it('drops unclassified, notices and other', () => {
    expect(
      evidenceOfDocuments([
        { documentId: 'a', docType: null },
        { documentId: 'b', docType: 'deduction_notice' },
        { documentId: 'c', docType: 'other' },
        { documentId: 'd', docType: 'pod' },
      ]),
    ).toEqual([{ documentId: 'd', evidenceType: 'signed_pod', strength: 'have' }]);
  });
});
