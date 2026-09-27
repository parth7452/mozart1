import type { EvidenceType } from '@recouple/core-domain';
import type { DocType } from './ports';

type Evidence = { evidenceType: EvidenceType; strength: 'have' | 'possible' };

/**
 * What a linked document of each type counts as (ADR 0059). `bol` and `pod`
 * mean the record is on file; its signature is not checked. Correspondence is
 * only ever possible buyer approval. `packing_list` has no document type.
 */
export const EVIDENCE_FOR_DOC_TYPE: Readonly<Record<DocType, Evidence | null>> = {
  deduction_notice: null,
  remittance_advice: { evidenceType: 'remittance_advice', strength: 'have' },
  invoice: { evidenceType: 'invoice', strength: 'have' },
  po: { evidenceType: 'po', strength: 'have' },
  bol: { evidenceType: 'carrier_signed_bol', strength: 'have' },
  pod: { evidenceType: 'signed_pod', strength: 'have' },
  asn: { evidenceType: 'asn', strength: 'have' },
  correspondence: { evidenceType: 'buyer_approval_email', strength: 'possible' },
  promo_agreement: { evidenceType: 'promo_deal_sheet', strength: 'have' },
  price_agreement: { evidenceType: 'price_agreement', strength: 'have' },
  routing_guide: { evidenceType: 'routing_guide', strength: 'have' },
  other: null,
};

export function evidenceOfDocuments(
  docs: readonly { documentId: string; docType: DocType | null }[],
): { documentId: string; evidenceType: EvidenceType; strength: 'have' | 'possible' }[] {
  const out: { documentId: string; evidenceType: EvidenceType; strength: 'have' | 'possible' }[] = [];
  for (const d of docs) {
    const e = d.docType === null ? null : EVIDENCE_FOR_DOC_TYPE[d.docType];
    if (e) out.push({ documentId: d.documentId, ...e });
  }
  return out;
}
