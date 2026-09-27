/**
 * Which evidence a canonical reason needs (ADR 0059). Canonical default data,
 * versioned and effective-dated; payer overrides come later as playbook data.
 * The family lists are placeholders for founder review.
 */
import type { EvidenceType } from './evidence';
import { familyOf, type CanonicalReasonCode, type ReasonFamily } from './reason-codes';

export interface EvidenceRequirementProvenance {
  readonly kind: 'named_human';
  readonly source: string;
  readonly note?: string;
}
export interface EvidenceRequirement {
  readonly evidenceType: EvidenceType;
  readonly required: boolean;
  readonly why: string;
}
export interface EvidenceRequirementSet {
  readonly version: string;
  readonly effectiveFrom: string; // YYYY-MM-DD
  readonly provenance: EvidenceRequirementProvenance;
  readonly byFamily: Readonly<Record<ReasonFamily, readonly EvidenceRequirement[]>>;
  readonly byCode: Readonly<Partial<Record<CanonicalReasonCode, readonly EvidenceRequirement[]>>>;
}

const req = (evidenceType: EvidenceType, why: string): EvidenceRequirement => ({ evidenceType, required: true, why });
const opt = (evidenceType: EvidenceType, why: string): EvidenceRequirement => ({ evidenceType, required: false, why });

const APPOINTMENT: readonly EvidenceRequirement[] = [
  req('carrier_signed_bol', 'The signed bill of lading shows when the carrier took the load.'),
  req('signed_pod', 'The signed delivery receipt shows when the goods arrived.'),
  opt('buyer_approval_email', 'A buyer message can show the delivery time was agreed or changed.'),
];
const ASN: readonly EvidenceRequirement[] = [
  req('asn', 'The advance ship notice shows what was sent and when.'),
  req('invoice', 'The invoice ties the shipment to the amount billed.'),
];

export const CANONICAL_EVIDENCE_REQUIREMENTS: readonly EvidenceRequirementSet[] = [
  {
    version: '2026-09-27.1',
    effectiveFrom: '2000-01-01',
    provenance: { kind: 'named_human', source: 'ADR 0059' },
    byFamily: {
      shortage: [
        req('signed_pod', 'A clean signed delivery receipt shows the full quantity arrived.'),
        req('carrier_signed_bol', 'The signed bill of lading shows what the carrier took.'),
        req('invoice', 'The invoice shows the quantity billed.'),
        opt('po', 'The purchase order shows the quantity ordered.'),
        opt('asn', 'The advance ship notice shows the quantity sent.'),
        opt('packing_list', 'The packing list shows what was packed.'),
      ],
      pricing: [
        req('invoice', 'The invoice shows the price billed.'),
        req('price_agreement', 'The price agreement shows the price agreed.'),
        req('po', 'The purchase order shows the price the buyer ordered at.'),
      ],
      compliance: [
        req('routing_guide', 'The routing guide shows the rule the payer says was broken.'),
        req('asn', 'The advance ship notice shows what was sent and when.'),
        opt('carrier_signed_bol', 'The signed bill of lading shows how the load moved.'),
        opt('buyer_approval_email', 'A buyer message can show an exception was agreed.'),
      ],
      duplicate: [
        req('invoice', 'The invoice identifies the charge that was deducted.'),
        req('remittance_advice', 'The remittance shows the earlier deduction or payment.'),
      ],
      returns: [
        req('invoice', 'The invoice shows what was sold and at what price.'),
        opt('buyer_approval_email', 'A buyer message can show whether the return was authorised.'),
      ],
      promotion: [
        req('promo_deal_sheet', 'The deal sheet shows the promotion agreed and its terms.'),
        req('invoice', 'The invoice shows what was sold in the promotion period.'),
        opt('buyer_approval_email', 'A buyer message can show what was agreed.'),
      ],
      freight: [
        req('carrier_signed_bol', 'The signed bill of lading shows the carrier and freight terms.'),
        req('invoice', 'The invoice shows how freight was billed.'),
        opt('routing_guide', 'The routing guide shows which carrier the payer required.'),
      ],
      quality: [
        req('signed_pod', 'A clean signed delivery receipt shows the goods arrived in good order.'),
        opt('carrier_signed_bol', 'The signed bill of lading shows the condition at pickup.'),
        req('invoice', 'The invoice shows what was sold.'),
      ],
      post_audit: [
        req('invoice', 'The invoice shows what was billed at the time.'),
        opt('price_agreement', 'The price agreement shows the price in force then.'),
        opt('promo_deal_sheet', 'The deal sheet shows the allowance in force then.'),
        opt('remittance_advice', 'The remittance shows what was already settled.'),
      ],
      other: [req('invoice', 'The invoice identifies the charge that was deducted.')],
    },
    byCode: {
      compliance_asn_missing: ASN,
      compliance_asn_inaccurate: ASN,
      compliance_appointment_missed: APPOINTMENT,
      compliance_late_delivery: APPOINTMENT,
      compliance_early_delivery: APPOINTMENT,
      promo_not_agreed: [
        opt('promo_deal_sheet', 'A deal sheet, if one exists, shows what was actually agreed.'),
        opt('buyer_approval_email', 'A buyer message can show the promotion was never agreed.'),
        req('invoice', 'The invoice shows what was sold.'),
      ],
    },
  },
];

export const EVIDENCE_NOT_YET_TYPED: readonly string[] = [
  'carrier ELD/telematics log',
  'timesheet / time register',
  'receiving report',
  'temperature / shelf-life record',
];

export class NoEvidenceRequirementsError extends Error {
  override readonly name = 'NoEvidenceRequirementsError';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The set in force on `date`: the latest whose `effectiveFrom` is on or before it. */
export function requirementSetOn(
  date: string,
  sets: readonly EvidenceRequirementSet[] = CANONICAL_EVIDENCE_REQUIREMENTS,
): EvidenceRequirementSet {
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  }
  let found: EvidenceRequirementSet | undefined;
  for (const s of sets) {
    if (s.effectiveFrom <= date && (!found || s.effectiveFrom > found.effectiveFrom)) found = s;
  }
  if (!found) throw new NoEvidenceRequirementsError(`no evidence requirements in force on ${date}`);
  return found;
}

export function requirementsFor(code: CanonicalReasonCode, set: EvidenceRequirementSet): readonly EvidenceRequirement[] {
  return set.byCode[code] ?? set.byFamily[familyOf(code)];
}

export type ChecklistStatus = 'have' | 'possible' | 'missing';
export interface ChecklistRow {
  readonly evidenceType: EvidenceType;
  readonly required: boolean;
  readonly why: string;
  readonly status: ChecklistStatus;
  readonly documentIds: readonly string[];
}
export interface EvidenceChecklist {
  readonly reason: CanonicalReasonCode;
  readonly version: string;
  readonly rows: readonly ChecklistRow[];
  readonly missingRequired: number;
}

export function evidenceChecklist(input: {
  reason: CanonicalReasonCode;
  onDate: string;
  present: readonly { documentId: string; evidenceType: EvidenceType; strength: 'have' | 'possible' }[];
}): EvidenceChecklist {
  const set = requirementSetOn(input.onDate);
  const rows: ChecklistRow[] = requirementsFor(input.reason, set).map((r) => {
    const matching = input.present.filter((p) => p.evidenceType === r.evidenceType);
    const status: ChecklistStatus = matching.some((p) => p.strength === 'have')
      ? 'have'
      : matching.length > 0
        ? 'possible'
        : 'missing';
    return { evidenceType: r.evidenceType, required: r.required, why: r.why, status, documentIds: matching.map((p) => p.documentId) };
  });
  return {
    reason: input.reason,
    version: set.version,
    rows,
    missingRequired: rows.filter((r) => r.required && r.status !== 'have').length,
  };
}

/** Each evidence type in words (ADR 0059). */
export const EVIDENCE_TYPE_WORDS: Readonly<Record<EvidenceType, string>> = {
  signed_pod: 'Signed proof of delivery',
  carrier_signed_bol: 'Carrier-signed bill of lading',
  po: 'Purchase order',
  invoice: 'Invoice',
  asn: 'Advance ship notice',
  packing_list: 'Packing list',
  promo_deal_sheet: 'Promotion deal sheet',
  buyer_approval_email: 'Buyer approval',
  price_agreement: 'Price agreement',
  routing_guide: 'Routing guide',
  remittance_advice: 'Remittance advice',
};

