/**
 * A deduction notice pasted into an email, with no attachment.
 *
 * Some retailers and brokers send the deduction as the message itself. It is the
 * format where every other assumption this pipeline makes stops applying: there
 * is no page, no layout, no image, and a reader gets nothing but the characters
 * that arrived. Whether extraction holds up without a page to look at is a
 * different question from whether it holds up on a scan, so this is its own
 * suite and its numbers are never averaged into the others.
 *
 * The body is written the way these actually arrive: a plain-text wrapper around
 * a fixed-width block that was a table before somebody's mail client flattened
 * it, with the amounts reading down the right-hand side.
 */

import type { FixtureDocument, TruthExpectation } from './cases';

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const moneyCents = (value: number): TruthExpectation => ({ kind: 'money_cents', value });
const int = (value: number): TruthExpectation => ({ kind: 'int', value });

const BODY = [
  'Good afternoon,',
  '',
  'Please see the deduction below, taken against your remittance of 09/08/2026.',
  'No attachment is available for this claim type; the detail is reproduced here.',
  '',
  'MERIDIAN GROCERY GROUP — DEDUCTION ADVICE',
  'Vendor Number: 55219',
  'Claim ID: MGG-2026-44817',
  'Invoice Number: HF-20933',
  'Purchase Order: 4410-77219',
  'Ship To: RDC 12 — Joliet, IL',
  'Deduction Date: 09/08/2026',
  '',
  'SKU            DESCRIPTION              INV   RCVD   UNIT COST      AMOUNT',
  '000-4471-08    Case Pack Olive Oil       48     40      $62.40      $499.20',
  '000-4471-22    Case Pack Balsamic        24     24      $41.10        $0.00',
  '',
  'Reason Code 24 — Shortage on receipt',
  'Total Deduction: $499.20',
  '',
  'Disputes must be submitted within 60 days of the deduction date.',
  'Dispute Deadline: 11/07/2026',
  '',
  'Regards,',
  'Deductions Desk, Meridian Grocery Group',
].join('\n');

/**
 * The truth is the same shape as for any notice. What changes is where it had to
 * be read from — and the columns here are alignment, not structure, so a reader
 * that leans on layout has nothing to lean on.
 */
const TRUTH: Record<string, TruthExpectation> = {
  retailer_name: text('Meridian Grocery Group'),
  vendor_number: text('55219'),
  claim_id: text('MGG-2026-44817'),
  invoice_number: text('HF-20933'),
  po_number: text('4410-77219'),
  'lines[0].sku_upc': text('000-4471-08'),
  'lines[0].qty_invoiced': int(48),
  'lines[0].qty_received': int(40),
  'lines[0].unit_cost': moneyCents(6_240),
  'lines[0].deduction_amount': moneyCents(49_920),
  'lines[0].reason_code': text('24'),
  deduction_total: moneyCents(49_920),
};

let cache: FixtureDocument | undefined;

function buildEmailBodyNotice(): FixtureDocument {
  const bytes = new TextEncoder().encode(BODY);
  return {
    key: 'meridian-email-body-notice',
    filename: 'Deduction advice MGG-2026-44817 (email body).txt',
    mimeType: 'text/plain',
    docType: 'deduction_notice',
    // The body *is* the page. There is nothing behind it to fall back on, which
    // is the property this fixture exists to measure.
    pageText: [BODY],
    bytes,
    truth: TRUTH,
    suite: 'email_body',
  };
}

export function emailBodyDocuments(): readonly FixtureDocument[] {
  cache ??= buildEmailBodyNotice();
  return [cache];
}
