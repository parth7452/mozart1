/**
 * The extraction a perfect reader would return for each fixture.
 *
 * Two jobs. It gives the pipeline tests a deterministic extractor, so they test
 * pipeline behaviour rather than model quality. And it is checked against each
 * fixture's `truth` map and against the document's own page text, so a fixture,
 * its ground truth and its expected extraction cannot drift apart silently.
 *
 * This is not a substitute for recorded cassettes. Cassettes record what a model
 * actually said, and that is what the evals score.
 */

import type { FixtureDocument } from './cases';

/** A field with provenance. Quotes must appear verbatim in the page text. */
function f<T>(value: T, quote: string, page = 1, confidence = 0.98) {
  return { value, confidence, source_page: page, source_quote: quote, source_bbox: null };
}

/**
 * "Not on this document": an optional field is a null *value* inside the same
 * object shape, never a missing key, so absence is stated rather than implied.
 */
function absent() {
  return { value: null, confidence: 0, source_page: 1, source_quote: '' };
}

const NOTICE_WALMART = {
  retailer_name: f('Walmart', 'WALMART STORES, INC.'),
  vendor_number: f('481207', 'Vendor Number: 481207'),
  claim_id: f('APDP-99812', 'Claim ID: APDP-99812'),
  invoice_number: f('HF-20418', 'Invoice Number: HF-20418'),
  po_number: f('7741-88203', 'Purchase Order: 7741-88203'),
  store_or_dc: f('DC 6094 - Sanger, TX', 'Distribution Center: DC 6094 - Sanger, TX'),
  gln: absent(),
  asn_number: absent(),
  lines: [
    {
      sku_upc: f('000-4471-08', '000-4471-08'),
      description: f('Case Pack Olive Oil', 'Case Pack Olive Oil'),
      qty_invoiced: f(30, '30'),
      qty_received: f(25, '25'),
      unit_cost: f('$624.00', '$624.00'),
      deduction_amount: f('$3,120.00', '$3,120.00'),
      reason_code: f('24', 'Reason Code 24'),
      reason_description: f(
        'Merchandise billed not received (carton shortage)',
        'Merchandise billed not received (carton shortage)',
      ),
    },
  ],
  deduction_total: f('$3,120.00', 'Total Deduction: $3,120.00'),
  deduction_date: f('08/14/2026', 'Deduction Date: 08/14/2026'),
  dispute_deadline: f('11/12/2026', 'Dispute Deadline: 11/12/2026'),
  remittance_or_check: f('CHK-4471902', 'Remittance Reference: CHK-4471902'),
};

const PO_WALMART = {
  po_number: f('7741-88203', 'PO Number: 7741-88203'),
  po_date: f('07/28/2026', 'PO Date: 07/28/2026'),
  buyer_name: f('Walmart Stores, Inc.', 'Buyer: Walmart Stores, Inc.'),
  ship_to: f('DC 6094 - Sanger, TX', 'Ship To: DC 6094 - Sanger, TX'),
  lines: [
    {
      sku_upc: f('000-4471-08', '000-4471-08'),
      qty_ordered: f(30, '30'),
      unit_cost: f('$624.00', '$624.00'),
    },
  ],
};

const INVOICE_HARBORLINE = {
  invoice_number: f('HF-20418', 'Invoice Number: HF-20418'),
  invoice_date: f('08/01/2026', 'Invoice Date: 08/01/2026'),
  po_number: f('7741-88203', 'Purchase Order: 7741-88203'),
  customer_name: f('Walmart Stores, Inc.', 'Bill To: Walmart Stores, Inc.'),
  invoice_total: f('$18,720.00', 'Invoice Total: $18,720.00'),
  lines: [
    {
      sku_upc: f('000-4471-08', '000-4471-08'),
      qty: f(30, '30'),
      unit_cost: f('$624.00', '$624.00'),
      extended_amount: f('$18,720.00', '$18,720.00'),
    },
  ],
};

const BOL_CARRIER = {
  document_number: f('MFL-553318', 'BOL Number: MFL-553318'),
  ship_date: f('08/05/2026', 'Ship Date: 08/05/2026'),
  carrier_name: f('Meridian Freight Lines', 'Carrier: Meridian Freight Lines'),
  po_number: f('7741-88203', 'Purchase Order: 7741-88203'),
  ship_from: f('Harborline Foods LLC, Modesto, CA', 'Ship From: Harborline Foods LLC, Modesto, CA'),
  ship_to: f('Walmart DC 6094, Sanger, TX', 'Ship To: Walmart DC 6094, Sanger, TX'),
  total_cartons_shipped: f(30, 'Total Cartons Shipped: 30'),
  total_cartons_received: f(25, 'Total Cartons Received: 25'),
  signed_by: f('R. Alvarez', 'Received By: R. Alvarez'),
  signature_present: f(true, 'Signature: /s/ R. Alvarez'),
  lines: [
    {
      sku_upc: f('000-4471-08', '000-4471-08'),
      qty_shipped: f(30, '30'),
      qty_received: absent(),
    },
  ],
};

const NOTICE_KEHE = {
  retailer_name: f('KeHE', 'KeHE DISTRIBUTORS'),
  vendor_number: f('NF-2231', 'Vendor: NF-2231'),
  claim_id: f('KS-774120', 'Claim: KS-774120'),
  invoice_number: f('NFC-9931', 'Invoice: NFC-9931'),
  po_number: absent(),
  store_or_dc: absent(),
  gln: absent(),
  asn_number: absent(),
  lines: [
    {
      sku_upc: f('884-2210', '884-2210'),
      description: f('Trail Mix 12ct', 'Trail Mix 12ct'),
      qty_invoiced: absent(),
      qty_received: absent(),
      unit_cost: absent(),
      deduction_amount: f('$1,847.50', '$1,847.50'),
      reason_code: f('UDR', 'UDR'),
      reason_description: f('Unsaleable / Damaged on Receipt', 'Unsaleable / Damaged on Receipt'),
    },
  ],
  deduction_total: f('$1,847.50', 'Total Deduction: $1,847.50'),
  deduction_date: f('09/02/2026', 'Deduction Date: 09/02/2026'),
  dispute_deadline: absent(),
  remittance_or_check: absent(),
};

const POD_UNSIGNED = {
  document_number: f('RL-DEL-88214', 'Report Number: RL-DEL-88214'),
  ship_date: f('08/28/2026', 'Delivery Date: 08/28/2026'),
  carrier_name: f('Ridgeway Logistics', 'Ridgeway Logistics - System Generated'),
  po_number: f('KH-55120', 'Purchase Order: KH-55120'),
  ship_from: absent(),
  ship_to: f('KeHE Aurora DC', 'Ship To: KeHE Aurora DC'),
  total_cartons_shipped: f(48, 'Total Cartons Shipped: 48'),
  total_cartons_received: f(48, 'Total Cartons Received: 48'),
  signed_by: absent(),
  signature_present: f(false, 'No consignee signature was captured for this delivery.'),
  lines: [],
};

const NOTICE_TARGET = {
  retailer_name: f('Target', 'TARGET CORPORATION'),
  vendor_number: f('VN-77120', 'Vendor: Northfork Components (VN-77120)'),
  claim_id: f('TGT-2026-41880', 'Claim Number: TGT-2026-41880'),
  invoice_number: f('NFC-10042', 'Invoice: NFC-10042'),
  po_number: f('0088-41200', 'PO: 0088-41200'),
  store_or_dc: absent(),
  gln: absent(),
  asn_number: absent(),
  lines: [
    {
      sku_upc: f('551-9930', '551-9930'),
      description: f('Insulated Bottle', 'Insulated Bottle'),
      qty_invoiced: f(120, '120'),
      qty_received: f(120, '120'),
      unit_cost: f('$14.25', '$14.25'),
      deduction_amount: f('$1,710.00', '$1,710.00'),
      reason_code: f('PD', 'Code PD'),
      reason_description: f(
        'Price discrepancy - billed above agreed cost',
        'Price discrepancy - billed above agreed cost',
      ),
    },
  ],
  deduction_total: f('$1,710.00', 'Total Deduction: $1,710.00'),
  deduction_date: f('09/09/2026', 'Deduction Date: 09/09/2026'),
  dispute_deadline: absent(),
  remittance_or_check: absent(),
};

const PO_TARGET = {
  po_number: f('0088-41200', 'PO Number: 0088-41200'),
  po_date: f('08/15/2026', 'PO Date: 08/15/2026'),
  buyer_name: f('Target Corporation', 'Buyer: Target Corporation'),
  ship_to: f('Target DC 0581', 'Ship To: Target DC 0581'),
  lines: [
    {
      sku_upc: f('551-9930', '551-9930'),
      qty_ordered: f(120, '120'),
      unit_cost: f('$14.25', '$14.25'),
    },
  ],
};

export const EXPECTED_EXTRACTIONS: Readonly<Record<string, unknown>> = {
  'walmart-apdp-notice': NOTICE_WALMART,
  'walmart-po': PO_WALMART,
  'harborline-invoice': INVOICE_HARBORLINE,
  'carrier-bol': BOL_CARRIER,
  'kehe-notice': NOTICE_KEHE,
  'unsigned-pod': POD_UNSIGNED,
  'target-price-notice': NOTICE_TARGET,
  'target-po': PO_TARGET,
};

export function expectedExtraction(document: FixtureDocument): unknown {
  const expected = EXPECTED_EXTRACTIONS[document.key];
  if (expected === undefined) {
    throw new Error(`no expected extraction for fixture ${document.key}`);
  }
  return expected;
}
