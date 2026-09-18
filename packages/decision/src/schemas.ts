/**
 * Decision schemas A–D (plan §9).
 *
 * A — classify at ingest
 * B — validity, once evidence is in
 * C — verifier / guardrail, the last gate before a packet can be approved
 * D — weekly root-cause analytics
 *
 * Schema versions are pinned and stored on every decision row; changing a
 * question set means bumping the version and re-running the eval suite.
 */

import { CANONICAL_REASON_CODE_LIST, REASON_FAMILIES } from '@recouple/core-domain';
import type { QuestionSet } from './types';

export const SCHEMA_VERSION = '1.0.0';

const RISK_LEVELS = ['very_low', 'low', 'medium', 'high', 'very_high'] as const;

export const SCHEMA_A_CLASSIFY = {
  canonical_reason_code: {
    kind: 'choice',
    prompt: 'Which canonical reason code does this deduction fall under?',
    options: CANONICAL_REASON_CODE_LIST,
  },
  deduction_family: {
    kind: 'choice',
    prompt: 'Which family does the reason code belong to?',
    options: REASON_FAMILIES,
  },
  is_post_audit: { kind: 'noul', prompt: 'Is this a post-audit claim?' },
  is_probable_duplicate: {
    kind: 'noul',
    prompt: 'Does this claim probably duplicate another claim or payment?',
  },
  requires_contract_review: {
    kind: 'noul',
    prompt: 'Does deciding this require reading a contract, deal sheet or routing guide?',
  },
  evidence_required: {
    kind: 'choice',
    prompt: 'Which evidence types are required to dispute this?',
    options: [
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
    ],
    multiple: true,
  },
  dispute_deadline_risk: {
    kind: 'score',
    prompt: 'How much deadline risk does this claim carry?',
    levels: RISK_LEVELS,
  },
  retailer_recognized: {
    kind: 'noul',
    prompt: 'Do we recognise this retailer from its identity signals?',
  },
} as const satisfies QuestionSet;

export const SCHEMA_B_VALIDITY = {
  validity: {
    kind: 'choice',
    prompt: 'Is the retailer’s deduction valid, invalid, or partly valid?',
    options: ['valid', 'invalid', 'partial'],
  },
  invalid_basis: {
    kind: 'choice',
    prompt: 'If the deduction is invalid, on what basis?',
    options: [
      'goods_were_delivered_in_full',
      'price_was_agreed',
      'allowance_was_not_agreed',
      'already_deducted',
      'compliance_requirement_was_met',
      'return_was_unauthorised',
      'freight_terms_were_prepaid',
      'not_applicable',
    ],
  },
  evidence_sufficiency: {
    kind: 'score',
    prompt: 'How well does the evidence on file support the dispute?',
    levels: ['insufficient', 'thin', 'adequate', 'strong', 'airtight'],
  },
  missing_evidence: {
    kind: 'choice',
    prompt: 'Which required evidence is still missing?',
    options: [
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
      'nothing_missing',
    ],
    multiple: true,
  },
  estimated_win_probability: {
    kind: 'score',
    prompt: 'How likely is this dispute to be accepted?',
    levels: RISK_LEVELS,
  },
  customer_dispute_friction: {
    kind: 'score',
    prompt: 'How much friction will disputing this create with the customer relationship?',
    levels: RISK_LEVELS,
  },
  recommended_action: {
    kind: 'choice',
    prompt: 'What should happen to this claim?',
    options: ['dispute', 'gather_more_evidence', 'write_off', 'escalate_to_analyst'],
  },
} as const satisfies QuestionSet;

/**
 * The guardrail. Every answer must come back true before a packet may be
 * approved; `submission_safe` is additionally cross-checked by the other
 * provider, and both must pass (plan §9).
 */
export const SCHEMA_C_VERIFIER = {
  extraction_matches_source: {
    kind: 'noul',
    prompt: 'Does every extracted field match the cited source span?',
  },
  claim_amount_arithmetic_correct: {
    kind: 'noul',
    prompt: 'Does the claim amount follow from the line-level arithmetic?',
  },
  evidence_supports_stated_basis: {
    kind: 'noul',
    prompt: 'Does the attached evidence actually support the stated basis for dispute?',
  },
  packet_complete_for_customer_format: {
    kind: 'noul',
    prompt: 'Is the packet complete and correctly formatted for this customer’s channel?',
  },
  submission_safe: {
    kind: 'noul',
    prompt: 'Is this packet safe to submit on the supplier’s behalf?',
  },
} as const satisfies QuestionSet;

export const SCHEMA_D_ROOT_CAUSE = {
  root_cause_family: {
    kind: 'choice',
    prompt: 'Across these cases, which family is the dominant root cause?',
    options: REASON_FAMILIES,
  },
  root_cause: {
    kind: 'choice',
    prompt: 'What is the most likely operational root cause?',
    options: [
      'warehouse_pick_accuracy',
      'carrier_handling',
      'asn_timing',
      'label_or_barcode_setup',
      'price_file_maintenance',
      'promo_agreement_capture',
      'order_acknowledgement_gaps',
      'retailer_process_error',
      'unclear',
    ],
  },
  preventable: { kind: 'noul', prompt: 'Is this root cause preventable by the supplier?' },
} as const satisfies QuestionSet;

export const SCHEMAS = {
  A: SCHEMA_A_CLASSIFY,
  B: SCHEMA_B_VALIDITY,
  C: SCHEMA_C_VERIFIER,
  D: SCHEMA_D_ROOT_CAUSE,
} as const;

export type SchemaId = keyof typeof SCHEMAS;

/** Every answer in Schema C must be true for a packet to be approvable. */
export const SCHEMA_C_REQUIRED_TRUE = Object.keys(SCHEMA_C_VERIFIER) as ReadonlyArray<
  keyof typeof SCHEMA_C_VERIFIER
>;
