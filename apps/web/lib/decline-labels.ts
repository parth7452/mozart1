import type { DECLINE_REASONS, MissingEvidence } from '@recouple/store-postgres';

/**
 * The reasons a case can be declined, in the words a reviewer uses rather than
 * the enum's. The values are the enum's — the database is the referee, and an
 * unknown one is refused there.
 *
 * One copy for the decline form and the case's timeline, so the words a
 * reviewer chose from are the words the case reads back.
 */
export const DECLINE_LABELS: Readonly<Record<(typeof DECLINE_REASONS)[number], string>> = {
  below_economic_floor: 'Not worth the work',
  deadline_passed: 'The dispute window has closed',
  evidence_unavailable: 'What would prove it cannot be got',
  deduction_valid: 'They were right — nothing to recover',
  duplicate_of_other: 'Same deduction, already handled',
  below_confidence_floor: 'We could not read it well enough to act',
  tenant_declined: 'The customer said not to',
  other: 'Something else',
};

/**
 * Evidence a reviewer can say was missing, in a person's words. The values are
 * the canonical ones the store will accept — the point of recording them is to
 * add them up later, so "no POD" has to be one thing across a thousand declines
 * rather than a hundred spellings. `detail` is where the prose goes.
 */
export const MISSING_EVIDENCE_LABELS: Readonly<Record<MissingEvidence, string>> = {
  proof_of_delivery: 'Proof of delivery',
  bill_of_lading: 'Bill of lading',
  invoice: 'Invoice',
  purchase_order: 'Purchase order',
  receiving_report: 'Receiving report',
  timesheet: 'Timesheet',
  rate_agreement: 'Rate or pricing agreement',
  correspondence: 'Correspondence with the customer',
};

/**
 * A recorded reason in words, or the value itself when this app has no words
 * for it: a row read back may name a reason written by something newer than
 * this page, and showing the value beats showing nothing.
 */
export function declineReasonLabel(reason: string): string {
  return Object.prototype.hasOwnProperty.call(DECLINE_LABELS, reason)
    ? DECLINE_LABELS[reason as keyof typeof DECLINE_LABELS]
    : reason;
}

/** A recorded missing-evidence value in words, or the value itself. */
export function missingEvidenceLabel(item: string): string {
  return Object.prototype.hasOwnProperty.call(MISSING_EVIDENCE_LABELS, item)
    ? MISSING_EVIDENCE_LABELS[item as MissingEvidence]
    : item;
}
