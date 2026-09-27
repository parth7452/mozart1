/**
 * EvidenceSource (plan §10).
 *
 * V1 has exactly one implementation — the user uploads everything. V2 adds EDI
 * intermediaries, carriers and 3PL portals. Defining the interface now is what
 * makes that a new file rather than a refactor.
 */

import type { EvidenceType } from '@recouple/core-domain';

export { EVIDENCE_TYPES, type EvidenceType } from '@recouple/core-domain';

export interface EvidenceItem {
  readonly id: string;
  readonly orgId: string;
  readonly deductionId: string;
  readonly evidenceType: EvidenceType;
  readonly documentId: string;
  /** Which source produced it, so provenance survives into the packet. */
  readonly sourceKind: 'user_upload' | 'edi_intermediary' | 'carrier' | 'accounting' | 'portal';
  readonly collectedAt: string;
}

export interface CaseContext {
  readonly orgId: string;
  readonly deductionId: string;
  readonly retailerKey?: string;
  readonly poNumber?: string;
  readonly invoiceNumber?: string;
  readonly asnNumber?: string;
}

export interface EvidenceSource {
  readonly kind: EvidenceItem['sourceKind'];
  fetch(evidenceType: EvidenceType, ctx: CaseContext): Promise<readonly EvidenceItem[]>;
}

/** One checklist item: what is needed, whether we have it, and where to look. */
export interface EvidenceChecklistItem {
  readonly evidenceType: EvidenceType;
  readonly required: boolean;
  readonly satisfiedBy: readonly string[];
  readonly whereToFindIt: string;
}
