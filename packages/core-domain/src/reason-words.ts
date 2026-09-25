/**
 * Every canonical reason code, in words a person reads.
 *
 * One list, used twice: the decide form offers these as the choices, and the
 * dispute letter says the chosen one to the payer. So each is written to read
 * correctly in both places — a statement of what is wrong with the deduction,
 * from the supplier's side, naming no payer and no kind of payer. A payer's own
 * codes and rules are playbook data and never appear here.
 *
 * A `Record` over `CanonicalReasonCode` rather than a list, so a code added to
 * the taxonomy without words is a type error, not a letter that prints
 * `compliance_late_delivery` at a customer.
 */

import type { CanonicalReasonCode } from './reason-codes';

export const REASON_WORDS = {
  shortage_quantity: 'Shortage deducted for units that were shipped and delivered',
  shortage_carton: 'Carton shortage deducted on a shipment delivered in full',
  shortage_concealed: 'Concealed shortage claimed after a clean delivery receipt',
  shortage_never_received: 'Shipment deducted as never received, though delivery is documented',
  shortage_pallet: 'Pallet shortage deducted on a shipment delivered in full',

  price_discrepancy: 'Paid at a price other than the agreed price',
  price_unauthorised_change: 'Price changed without agreement',
  cost_increase_not_honoured: 'An agreed cost increase was not honoured',
  unauthorised_deduction_no_basis: 'Deduction taken with no stated basis or supporting documentation',
  substitution_price: 'Substituted item deducted at the wrong price',

  compliance_otif: 'On-time or fill-rate fine that the delivery records do not support',
  compliance_late_delivery: 'Late-delivery fine that the delivery records do not support',
  compliance_early_delivery: 'Early-delivery fine that the delivery records do not support',
  compliance_asn_missing: 'Missing-ASN fine that the transmission records do not support',
  compliance_asn_inaccurate: 'Inaccurate-ASN fine that the transmission records do not support',
  compliance_label_barcode: 'Labelling or barcode fine that the shipment records do not support',
  compliance_packaging: 'Packaging fine that the shipment records do not support',
  compliance_routing_guide: 'Routing-guide fine that the shipment records do not support',
  compliance_appointment_missed: 'Missed-appointment fine that the appointment records do not support',
  compliance_pallet_spec: 'Pallet-specification fine that the shipment records do not support',

  duplicate_payment: 'Deducted as a duplicate payment, though the invoice was paid once',
  duplicate_claim: 'The same claim deducted twice',
  duplicate_invoice_deduction: 'The same invoice deducted twice',

  return_unsaleable: 'Unsaleables deduction the agreement does not provide for',
  return_authorised: 'Return deducted beyond what was authorised',
  return_unauthorised: 'Return deducted without authorisation',
  return_handling_fee: 'Return handling fee the agreement does not provide for',

  promo_allowance_claimed: 'Promotional allowance deducted beyond what was agreed',
  promo_not_agreed: 'Promotion or allowance that was never agreed',
  promo_duplicate_allowance: 'The same allowance deducted twice',
  promo_rate_mismatch: 'Allowance deducted at a rate other than the agreed rate',
  markdown_allowance: 'Markdown allowance that was never agreed',
  coop_advertising: 'Co-op advertising deduction that was not agreed or not performed',
  new_store_allowance: 'New-store allowance that was never agreed',

  freight_prepaid_billed: 'Freight charged on a prepaid shipment',
  freight_rate_mismatch: 'Freight charged at a rate other than the agreed rate',
  freight_unauthorised_carrier: 'Carrier charge the routing instructions do not support',
  detention_or_layover: 'Detention or layover charge the delivery records do not support',

  quality_damaged_in_transit: 'Damage deducted that occurred after the goods left the supplier',
  quality_expired_short_dated: 'Deducted as short-dated, though shipped within the agreed date code',
  quality_spec_mismatch: 'Deducted as out of specification, though it met the agreed specification',

  post_audit_pricing: 'Post-audit pricing claim the invoices and agreements do not support',
  post_audit_allowance: 'Post-audit allowance claim the agreements do not support',
  post_audit_freight: 'Post-audit freight claim the freight records do not support',

  unknown_uncoded: 'Other — set out in the explanation',
  administrative_fee: 'Administrative fee the agreement does not provide for',
  tax_adjustment: 'Tax adjustment the invoices do not support',
} as const satisfies Record<CanonicalReasonCode, string>;

/**
 * The longest entry in {@link REASON_WORDS} may be, so the packet narrative's
 * worst-case budget can count on it. `reason-words.test.ts` holds every entry to
 * it.
 */
export const REASON_WORDS_MAX_LENGTH = 100;

/** A reason code, in words. */
export function reasonInWords(code: CanonicalReasonCode): string {
  return REASON_WORDS[code];
}

/**
 * The reasons the decide form offers, in the order it offers them, with the
 * words it shows. A subset of the taxonomy on purpose: it is what an analyst
 * picks from, not the whole list. The words are {@link REASON_WORDS}', so what a
 * person picks is exactly what the letter tells the payer.
 */
export const DISPUTE_REASON_CODES = [
  'shortage_quantity',
  'shortage_never_received',
  'shortage_concealed',
  'shortage_carton',
  'shortage_pallet',
  'price_discrepancy',
  'unauthorised_deduction_no_basis',
  'cost_increase_not_honoured',
  'compliance_otif',
  'compliance_late_delivery',
  'compliance_early_delivery',
  'compliance_appointment_missed',
  'compliance_asn_missing',
  'compliance_routing_guide',
  'duplicate_claim',
  'duplicate_invoice_deduction',
  'return_unauthorised',
  'return_unsaleable',
  'promo_not_agreed',
  'promo_rate_mismatch',
  'promo_duplicate_allowance',
  'freight_prepaid_billed',
  'freight_rate_mismatch',
  'detention_or_layover',
  'quality_damaged_in_transit',
  'quality_expired_short_dated',
  'quality_spec_mismatch',
  'post_audit_pricing',
  'post_audit_allowance',
  'administrative_fee',
  'unknown_uncoded',
] as const satisfies readonly CanonicalReasonCode[];

/** {@link DISPUTE_REASON_CODES}, each with its words. */
export const DISPUTE_REASONS: readonly (readonly [CanonicalReasonCode, string])[] =
  DISPUTE_REASON_CODES.map((code) => [code, REASON_WORDS[code]] as const);
