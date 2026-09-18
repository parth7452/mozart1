/**
 * The held-out corpus.
 *
 * Twelve documents — six deduction notices and their matching remittance
 * advices — written by someone other than whoever wrote this code, in a layout,
 * vocabulary and reason-code set we did not choose. They are labelled synthetic
 * test data and involve fictional entities, so they are not real customer scans;
 * what they are is *unseen*, which is the property our own fixtures can never
 * have.
 *
 * Scored separately from the authored fixtures for exactly that reason: a
 * corpus you wrote measures whether the pipeline works, and a corpus you did not
 * measures whether it generalises.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authoredDocuments, type FixtureDocument, type TruthExpectation } from './cases';

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'corpus');

interface PageManifest {
  readonly filename: string;
  readonly docType: string;
  readonly pageText: readonly string[];
}

const manifest = JSON.parse(
  readFileSync(path.join(corpusDir, 'pages.json'), 'utf8'),
) as Record<string, PageManifest>;

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const money = (value: number): TruthExpectation => ({ kind: 'money_cents', value });
const int = (value: number): TruthExpectation => ({ kind: 'int', value });

/**
 * Ground truth, read off the documents by hand.
 *
 * Only fields whose correct answer is unambiguous on the page are asserted. Two
 * places where the documents are genuinely open to reading are deliberately left
 * out rather than guessed at: the unit cost on the price-variance case (the page
 * carries both the invoiced $30.00 and the customer's $28.50), and the quantity
 * on the damage case (30 damaged out of 400 invoiced is not a shortage pair).
 */
const TRUTH: Record<string, Record<string, TruthExpectation>> = {
  'hl-case-01-notice': {
    retailer_name: text('Harbor Lane Markets'),
    claim_id: text('DN-2609-001'),
    invoice_number: text('INV-260801'),
    po_number: text('PO-HLM-8042'),
    deduction_total: money(60_000),
    'lines[0].deduction_amount': money(60_000),
    'lines[0].reason_code': text('SHORT'),
    'lines[0].qty_invoiced': int(400),
    'lines[0].qty_received': int(380),
    'lines[0].unit_cost': money(3_000),
  },
  'hl-case-01-remittance': {
    payer_name: text('Harbor Lane Markets'),
    payment_reference: text('SIM-PAY-2609-001'),
    payment_total: money(1_140_000),
    'lines[0].invoice_number': text('INV-260801'),
    'lines[0].gross_amount': money(1_200_000),
    'lines[0].deduction_amount': money(60_000),
    'lines[0].net_amount': money(1_140_000),
    'lines[0].reason_code': text('SHORT'),
  },
  'hl-case-02-notice': {
    retailer_name: text('Cedar Point Grocers'),
    claim_id: text('DN-2609-002'),
    invoice_number: text('INV-260802'),
    po_number: text('PO-CPG-5170'),
    deduction_total: money(90_000),
    'lines[0].deduction_amount': money(90_000),
    'lines[0].reason_code': text('PRICE'),
  },
  'hl-case-02-remittance': {
    payer_name: text('Cedar Point Grocers'),
    payment_reference: text('SIM-PAY-2609-002'),
    payment_total: money(1_710_000),
    'lines[0].invoice_number': text('INV-260802'),
    'lines[0].gross_amount': money(1_800_000),
    'lines[0].deduction_amount': money(90_000),
    'lines[0].net_amount': money(1_710_000),
    'lines[0].reason_code': text('PRICE'),
  },
  'hl-case-03-notice': {
    retailer_name: text('Summit Basket Retail'),
    claim_id: text('DN-2609-003'),
    invoice_number: text('INV-260803'),
    po_number: text('PO-SBR-6631'),
    deduction_total: money(200_000),
    'lines[0].deduction_amount': money(200_000),
    'lines[0].reason_code': text('PROMO'),
  },
  'hl-case-03-remittance': {
    payer_name: text('Summit Basket Retail'),
    payment_reference: text('SIM-PAY-2609-003'),
    payment_total: money(2_300_000),
    'lines[0].invoice_number': text('INV-260803'),
    'lines[0].gross_amount': money(2_500_000),
    'lines[0].deduction_amount': money(200_000),
    'lines[0].net_amount': money(2_300_000),
    'lines[0].reason_code': text('PROMO'),
  },
  'hl-case-04-notice': {
    retailer_name: text('Willow Creek Wholesale'),
    claim_id: text('DN-2609-004'),
    invoice_number: text('INV-260804'),
    po_number: text('PO-WCW-9128'),
    deduction_total: money(72_000),
    'lines[0].deduction_amount': money(72_000),
    'lines[0].reason_code': text('DAMAGE'),
    'lines[0].unit_cost': money(2_400),
  },
  'hl-case-04-remittance': {
    payer_name: text('Willow Creek Wholesale'),
    payment_reference: text('SIM-PAY-2609-004'),
    payment_total: money(888_000),
    'lines[0].invoice_number': text('INV-260804'),
    'lines[0].gross_amount': money(960_000),
    'lines[0].deduction_amount': money(72_000),
    'lines[0].net_amount': money(888_000),
    'lines[0].reason_code': text('DAMAGE'),
  },
  'hl-case-05-notice': {
    retailer_name: text('Maple Gate Stores'),
    claim_id: text('DN-2609-005'),
    invoice_number: text('INV-260805'),
    po_number: text('PO-MGS-2084'),
    deduction_total: money(45_000),
    'lines[0].deduction_amount': money(45_000),
    'lines[0].reason_code': text('OTIF'),
  },
  'hl-case-05-remittance': {
    payer_name: text('Maple Gate Stores'),
    payment_reference: text('SIM-PAY-2609-005'),
    payment_total: money(1_455_000),
    'lines[0].invoice_number': text('INV-260805'),
    'lines[0].gross_amount': money(1_500_000),
    'lines[0].deduction_amount': money(45_000),
    'lines[0].net_amount': money(1_455_000),
    'lines[0].reason_code': text('OTIF'),
  },
  'hl-case-06-notice': {
    retailer_name: text('Pine Ridge Distribution'),
    claim_id: text('DN-2609-006'),
    invoice_number: text('INV-260806'),
    po_number: text('PO-PRD-3356'),
    deduction_total: money(44_000),
    'lines[0].deduction_amount': money(44_000),
    'lines[0].reason_code': text('DISC'),
  },
  'hl-case-06-remittance': {
    payer_name: text('Pine Ridge Distribution'),
    payment_reference: text('SIM-PAY-2609-006'),
    payment_total: money(2_156_000),
    'lines[0].invoice_number': text('INV-260806'),
    'lines[0].gross_amount': money(2_200_000),
    'lines[0].deduction_amount': money(44_000),
    'lines[0].net_amount': money(2_156_000),
    'lines[0].reason_code': text('DISC'),
  },
};

/**
 * What each case is really about, for the decision layer to be judged against
 * later. Case 06 is the one that matters most: a discount taken three weeks
 * after the discount window closed is unearned on the document's own dates.
 */
export const CORPUS_CASE_NOTES: Readonly<Record<string, string>> = {
  'hl-case-01': 'Quantity shortage: 380 of 400 cases received, 20 × $30.00 = $600.00. Disputable only with a signed POD showing full delivery.',
  'hl-case-02': 'Price variance: customer applied PO revision 2 at $28.50 against an invoice at $30.00. Turns on which price was in effect on the order date.',
  'hl-case-03': 'Promotional allowance: 8% of the whole invoice for a summer feature. Turns on whether a signed agreement covers these SKUs and dates.',
  'hl-case-04': 'Damage: 30 crushed cases claimed against an inspection record. Turns on freight terms — who owned the goods in transit.',
  'hl-case-05': 'OTIF charge: 3% for delivering 12 August against a 10 August request. Turns on the appointment record and the compliance rule cited.',
  'hl-case-06': 'Unearned early-payment discount: 2% taken on a 2/10 net 30 invoice, but the remittance is dated 14 September and eligibility ended 21 August. Invalid on the document’s own dates.',
};

let cache: readonly FixtureDocument[] | undefined;

export function corpusDocuments(): readonly FixtureDocument[] {
  if (cache !== undefined) return cache;
  cache = Object.entries(manifest).map(([key, entry]) => ({
    key,
    filename: entry.filename,
    mimeType: 'application/pdf' as const,
    docType: entry.docType,
    pageText: entry.pageText,
    bytes: new Uint8Array(readFileSync(path.join(corpusDir, entry.filename))),
    truth: TRUTH[key] ?? {},
    suite: 'held_out' as const,
  }));
  return cache;
}

/** Every document in both suites: what the recorder and the eval gate iterate. */
export function everyDocument(): readonly FixtureDocument[] {
  return [...authoredDocuments(), ...corpusDocuments()];
}
