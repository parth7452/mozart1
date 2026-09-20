/**
 * LOG-001: one freight dispute, told by five documents.
 *
 * Everything else in this corpus is a single document judged on its own. This
 * is a *case*: a $600 late-delivery fee and the four documents that say it is
 * wrong. It is here because the argument only exists across the documents —
 * no one of them refutes the charge, and together they refute it completely.
 *
 *   01 remittance   the customer withheld $600, citing appointment revision 1
 *   02 invoice      $4,800 billed, referencing revision 2
 *   03 rate con     the fee applies only if check-in is >30 min late AND
 *                   carrier-caused; written changes replace earlier appointments
 *   04 message      the customer approved revision 2 and wrote that no late
 *                   charge applies — customer-requested, not carrier-caused
 *   05 POD          gate check-in 13:42 against a 14:00 appointment
 *
 * Scored as its own suite. It measures something the other suites do not: not
 * whether a field was read, but whether reading the whole case produces the
 * argument. Blending it into a per-document accuracy number would hide that.
 *
 * Synthetic and fictional, per the pack's own README. Unlike the OCR starter
 * pack, these pages carry no "SYNTHETIC" banner, so a classifier cannot learn
 * that marker as a shortcut.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FixtureDocument, TruthExpectation } from './cases';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logistics');

interface PageManifest {
  readonly filename: string;
  readonly docType: string;
  readonly pageText: readonly string[];
}

const manifest = JSON.parse(
  readFileSync(path.join(dir, 'pages.json'), 'utf8'),
) as Record<string, PageManifest>;

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const money = (value: number): TruthExpectation => ({ kind: 'money_cents', value });

/**
 * Ground truth, read off the pages by hand.
 *
 * Only what the page states unambiguously. The timestamps are asserted as text
 * rather than parsed values on purpose — the document prints
 * "August 13, 2026, 1:42 PM Eastern", and turning that into an instant is our
 * job, not the reader's (see `timestamps.ts`).
 */
const TRUTH: Record<string, Record<string, TruthExpectation>> = {
  'log-001-short-pay-remittance': {
    payer_name: text('Brookfield Supply Co.'),
    payment_reference: text('ACH-91844'),
    payment_total: money(420_000),
    'lines[0].invoice_number': text('INV-AFS-260814'),
    'lines[0].gross_amount': money(480_000),
    'lines[0].deduction_amount': money(60_000),
    'lines[0].net_amount': money(420_000),
    'lines[0].reason_code': text('LATE-DEL'),
  },
  'log-001-carrier-invoice': {
    invoice_number: text('INV-AFS-260814'),
    po_number: text('PO-BSC-8841'),
    invoice_total: money(480_000),
  },
  'log-001-rate-confirmation': {
    counterparty: text('Brookfield Supply Co.'),
  },
  'log-001-appointment-change': {
    message_reference: text('MSG-BSC-0811-338'),
    // The two fields the whole dispute rests on — and a lesson in reading what
    // is printed rather than what would be convenient. The page says
    // "AP-BSC-771 revision 2 replaces revision 1": the new revision is named in
    // full, the old one is not. Asserting "AP-BSC-771 revision 1" would be
    // asserting a string that is not on the page.
    'commitments[0].supersedes': text('revision 1'),
    'commitments[0].establishes': text('AP-BSC-771 revision 2'),
  },
  'log-001-proof-of-delivery': {
    document_number: text('POD-771'),
    po_number: text('PO-BSC-8841'),
    // 13:42 against a 14:00 appointment. The $600 turns on these 18 minutes.
    gate_check_in_at: text('August 13, 2026, 1:42 PM Eastern'),
    appointment_at: text('August 13, 2026, 2:00 PM Eastern'),
  },
};

/**
 * What a correct reading of the whole case should conclude.
 *
 * Not a field-accuracy number: the finding codes deterministic reconciliation
 * must produce once the documents are read. This is the suite's actual claim.
 */
export const LOG_001_EXPECTED_FINDINGS = [
  'arrived_before_appointment',
  'appointment_superseded',
  'charge_waived_in_writing',
] as const;

/** The deduction under dispute, in cents. 4,800.00 − 600.00 = 4,200.00. */
export const LOG_001_DEDUCTION_CENTS = 60_000;
export const LOG_001_GROSS_CENTS = 480_000;
export const LOG_001_NET_CENTS = 420_000;

export function logisticsDocuments(): readonly FixtureDocument[] {
  return Object.entries(manifest).map(([key, entry]) => ({
    key,
    filename: entry.filename,
    mimeType: 'application/pdf' as const,
    docType: entry.docType as FixtureDocument['docType'],
    pageText: entry.pageText,
    bytes: new Uint8Array(readFileSync(path.join(dir, entry.filename))),
    truth: TRUTH[key] ?? {},
    suite: 'logistics' as const,
  }));
}
