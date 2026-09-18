/**
 * The canonical reason-code taxonomy.
 *
 * Retailer-specific codes never appear here — they map onto these via
 * retailer_code_maps playbook data (plan §8). The list is deliberately capped
 * well under the decision provider's 255-option ceiling; if it ever approaches
 * that, families become a first-stage choice and codes a second.
 */

export const REASON_FAMILIES = [
  'shortage',
  'pricing',
  'compliance',
  'duplicate',
  'returns',
  'promotion',
  'freight',
  'quality',
  'post_audit',
  'other',
] as const;

export type ReasonFamily = (typeof REASON_FAMILIES)[number];

export const CANONICAL_REASON_CODES = {
  shortage_quantity: 'shortage',
  shortage_carton: 'shortage',
  shortage_concealed: 'shortage',
  shortage_never_received: 'shortage',
  shortage_pallet: 'shortage',

  price_discrepancy: 'pricing',
  price_unauthorised_change: 'pricing',
  cost_increase_not_honoured: 'pricing',
  unauthorised_deduction_no_basis: 'pricing',
  substitution_price: 'pricing',

  compliance_otif: 'compliance',
  compliance_late_delivery: 'compliance',
  compliance_early_delivery: 'compliance',
  compliance_asn_missing: 'compliance',
  compliance_asn_inaccurate: 'compliance',
  compliance_label_barcode: 'compliance',
  compliance_packaging: 'compliance',
  compliance_routing_guide: 'compliance',
  compliance_appointment_missed: 'compliance',
  compliance_pallet_spec: 'compliance',

  duplicate_payment: 'duplicate',
  duplicate_claim: 'duplicate',
  duplicate_invoice_deduction: 'duplicate',

  return_unsaleable: 'returns',
  return_authorised: 'returns',
  return_unauthorised: 'returns',
  return_handling_fee: 'returns',

  promo_allowance_claimed: 'promotion',
  promo_not_agreed: 'promotion',
  promo_duplicate_allowance: 'promotion',
  promo_rate_mismatch: 'promotion',
  markdown_allowance: 'promotion',
  coop_advertising: 'promotion',
  new_store_allowance: 'promotion',

  freight_prepaid_billed: 'freight',
  freight_rate_mismatch: 'freight',
  freight_unauthorised_carrier: 'freight',
  detention_or_layover: 'freight',

  quality_damaged_in_transit: 'quality',
  quality_expired_short_dated: 'quality',
  quality_spec_mismatch: 'quality',

  post_audit_pricing: 'post_audit',
  post_audit_allowance: 'post_audit',
  post_audit_freight: 'post_audit',

  unknown_uncoded: 'other',
  administrative_fee: 'other',
  tax_adjustment: 'other',
} as const satisfies Record<string, ReasonFamily>;

export type CanonicalReasonCode = keyof typeof CANONICAL_REASON_CODES;

export const CANONICAL_REASON_CODE_LIST = Object.keys(
  CANONICAL_REASON_CODES,
) as CanonicalReasonCode[];

/** Kept far below the provider's 255-option limit on purpose (plan §8). */
export const REASON_CODE_CARDINALITY_CEILING = 60;

export function familyOf(code: CanonicalReasonCode): ReasonFamily {
  return CANONICAL_REASON_CODES[code];
}

export function isCanonicalReasonCode(value: string): value is CanonicalReasonCode {
  return Object.prototype.hasOwnProperty.call(CANONICAL_REASON_CODES, value);
}
