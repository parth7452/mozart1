/** The evidence a dispute can rest on. Moved from `adapters` (ADR 0059). */
export const EVIDENCE_TYPES = [
  'signed_pod',
  'carrier_signed_bol',
  'po',
  'invoice',
  'asn',
  'packing_list',
  'promo_deal_sheet',
  'buyer_approval_email',
  'price_agreement',
  'routing_guide',
  'remittance_advice',
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
