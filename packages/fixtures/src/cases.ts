/**
 * Synthetic cases with labelled ground truth (plan §19).
 *
 * The document text and the expected extraction live side by side so they cannot
 * drift. Every case is generated at run time, which means no binary fixtures in
 * git and no fixture that has quietly stopped matching its truth file.
 *
 * The Walmart case is the plan's fully-worked example: code 24 carton shortage,
 * $3,120, BOL shows 30 cartons shipped and the DC signed for 25 — five cartons
 * short at $624 each.
 */

import { renderTextPdf } from './pdf';

export type TruthExpectation =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'money_cents'; readonly value: number }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'date'; readonly value: string };

export interface FixtureDocument {
  readonly key: string;
  readonly filename: string;
  readonly mimeType: 'application/pdf' | 'image/jpeg';
  readonly docType: string;
  readonly pageText: readonly string[];
  readonly bytes: Uint8Array;
  /** field path → what a correct extraction must produce. */
  readonly truth: Readonly<Record<string, TruthExpectation>>;
  /**
   * `authored` fixtures were written alongside this code and measure whether the
   * pipeline works. `held_out` documents came from elsewhere and measure whether
   * it generalises. Never average the two into one headline number.
   */
  readonly suite: 'authored' | 'held_out' | 'scanned';
}

export interface FixtureCase {
  readonly key: string;
  readonly title: string;
  readonly retailer: string;
  readonly documents: readonly FixtureDocument[];
  /** What reconciliation should conclude, in prose, for the demo script. */
  readonly expectedOutcome: string;
}

function pdfDocument(input: {
  key: string;
  filename: string;
  docType: string;
  pages: readonly (readonly string[])[];
  truth: Record<string, TruthExpectation>;
}): FixtureDocument {
  return {
    key: input.key,
    filename: input.filename,
    mimeType: 'application/pdf',
    docType: input.docType,
    pageText: input.pages.map((lines) => lines.join('\n')),
    bytes: renderTextPdf(input.pages),
    truth: input.truth,
    suite: 'authored',
  };
}

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const moneyCents = (value: number): TruthExpectation => ({ kind: 'money_cents', value });
const int = (value: number): TruthExpectation => ({ kind: 'int', value });
const bool = (value: boolean): TruthExpectation => ({ kind: 'bool', value });

// --- Case 1: Walmart APDP code 24 carton shortage ---------------------------

const walmartNotice = pdfDocument({
  key: 'walmart-apdp-notice',
  filename: 'walmart-apdp-notice.pdf',
  docType: 'deduction_notice',
  pages: [
    [
      'WALMART STORES, INC.',
      'Accounts Payable Disputes Portal (APDP)',
      'DEDUCTION NOTICE',
      '',
      'Supplier: Harborline Foods LLC',
      'Vendor Number: 481207',
      'Claim ID: APDP-99812',
      'Invoice Number: HF-20418',
      'Purchase Order: 7741-88203',
      'Distribution Center: DC 6094 - Sanger, TX',
      'Deduction Date: 08/14/2026',
      'Remittance Reference: CHK-4471902',
      '',
      'DEDUCTION DETAIL',
      'Item              Description            Code  Inv Qty  Rcv Qty  Unit Cost   Amount',
      '000-4471-08       Case Pack Olive Oil     24        30       25    $624.00  $3,120.00',
      '',
      'Reason Code 24: Merchandise billed not received (carton shortage)',
      '',
      'Total Deduction: $3,120.00',
      '',
      'Disputes must be filed in APDP within 90 days of the deduction date.',
      'Dispute Deadline: 11/12/2026',
    ],
  ],
  truth: {
    retailer_name: text('Walmart'),
    vendor_number: text('481207'),
    claim_id: text('APDP-99812'),
    invoice_number: text('HF-20418'),
    po_number: text('7741-88203'),
    'lines[0].sku_upc': text('000-4471-08'),
    'lines[0].qty_invoiced': int(30),
    'lines[0].qty_received': int(25),
    'lines[0].unit_cost': moneyCents(62_400),
    'lines[0].deduction_amount': moneyCents(312_000),
    'lines[0].reason_code': text('24'),
    deduction_total: moneyCents(312_000),
  },
});

const walmartPo = pdfDocument({
  key: 'walmart-po',
  filename: 'walmart-po.pdf',
  docType: 'po',
  pages: [
    [
      'WALMART STORES, INC.',
      'PURCHASE ORDER',
      '',
      'PO Number: 7741-88203',
      'PO Date: 07/28/2026',
      'Buyer: Walmart Stores, Inc.',
      'Ship To: DC 6094 - Sanger, TX',
      'Supplier: Harborline Foods LLC (Vendor 481207)',
      '',
      'Item              Description            Qty Ordered   Unit Cost',
      '000-4471-08       Case Pack Olive Oil             30     $624.00',
      '',
      'Total PO Value: $18,720.00',
    ],
  ],
  truth: {
    po_number: text('7741-88203'),
    'lines[0].sku_upc': text('000-4471-08'),
    'lines[0].qty_ordered': int(30),
    'lines[0].unit_cost': moneyCents(62_400),
  },
});

const harborlineInvoice = pdfDocument({
  key: 'harborline-invoice',
  filename: 'harborline-invoice.pdf',
  docType: 'invoice',
  pages: [
    [
      'HARBORLINE FOODS LLC',
      'INVOICE',
      '',
      'Invoice Number: HF-20418',
      'Invoice Date: 08/01/2026',
      'Bill To: Walmart Stores, Inc.',
      'Purchase Order: 7741-88203',
      '',
      'Item              Description            Qty    Unit Price    Extended',
      '000-4471-08       Case Pack Olive Oil     30       $624.00   $18,720.00',
      '',
      'Invoice Total: $18,720.00',
      'Terms: Net 60',
    ],
  ],
  truth: {
    invoice_number: text('HF-20418'),
    po_number: text('7741-88203'),
    'lines[0].sku_upc': text('000-4471-08'),
    'lines[0].qty': int(30),
    'lines[0].unit_cost': moneyCents(62_400),
    invoice_total: moneyCents(1_872_000),
  },
});

const carrierBol = pdfDocument({
  key: 'carrier-bol',
  filename: 'carrier-bol.pdf',
  docType: 'bol',
  pages: [
    [
      'STRAIGHT BILL OF LADING',
      'Carrier: Meridian Freight Lines',
      '',
      'BOL Number: MFL-553318',
      'Ship Date: 08/05/2026',
      'Purchase Order: 7741-88203',
      'Ship From: Harborline Foods LLC, Modesto, CA',
      'Ship To: Walmart DC 6094, Sanger, TX',
      '',
      'Item              Description            Cartons Shipped',
      '000-4471-08       Case Pack Olive Oil                 30',
      '',
      'Total Cartons Shipped: 30',
      'Total Cartons Received: 25',
      '',
      'RECEIVED IN APPARENT GOOD ORDER EXCEPT AS NOTED',
      'Exception noted at delivery: 5 cartons short',
      'Received By: R. Alvarez (signature on file)',
      'Signature: /s/ R. Alvarez     Date: 08/08/2026',
    ],
  ],
  truth: {
    document_number: text('MFL-553318'),
    po_number: text('7741-88203'),
    total_cartons_shipped: int(30),
    total_cartons_received: int(25),
    signature_present: bool(true),
  },
});

export const WALMART_CODE_24: FixtureCase = {
  key: 'walmart-code-24-shortage',
  title: 'Walmart APDP code 24 carton shortage, $3,120',
  retailer: 'walmart_apdp',
  documents: [walmartNotice, walmartPo, harborlineInvoice, carrierBol],
  expectedOutcome:
    'The deduction is arithmetically correct on its own terms ((30 − 25) × $624 = $3,120) but the signed BOL shows 30 cartons shipped against 25 signed for, so the shortage is a delivery exception the carrier documented. Evidence supports disputing. Filing is a human decision.',
};

// --- Case 2: KeHE unsigned delivery report (evidence that will be rejected) ---

const keheNotice = pdfDocument({
  key: 'kehe-notice',
  filename: 'kehe-ksolve-notice.pdf',
  docType: 'deduction_notice',
  pages: [
    [
      'KeHE DISTRIBUTORS',
      'K-Solve Deduction Notice',
      '',
      'Supplier: Northfork Components',
      'Vendor: NF-2231',
      'Claim: KS-774120',
      'Invoice: NFC-9931',
      'Deduction Date: 09/02/2026',
      '',
      'Item          Description        Code   Amount',
      '884-2210      Trail Mix 12ct      UDR   $1,847.50',
      '',
      'UDR - Unsaleable / Damaged on Receipt',
      '',
      'Total Deduction: $1,847.50',
      'K-Solve disputes accepted within 180 days.',
    ],
  ],
  truth: {
    retailer_name: text('KeHE'),
    claim_id: text('KS-774120'),
    invoice_number: text('NFC-9931'),
    'lines[0].sku_upc': text('884-2210'),
    'lines[0].reason_code': text('UDR'),
    'lines[0].deduction_amount': moneyCents(184_750),
    deduction_total: moneyCents(184_750),
  },
});

const unsignedPod = pdfDocument({
  key: 'unsigned-pod',
  filename: 'carrier-delivery-report.pdf',
  docType: 'pod',
  pages: [
    [
      'CARRIER-GENERATED DELIVERY REPORT',
      'Ridgeway Logistics - System Generated',
      '',
      'Report Number: RL-DEL-88214',
      'Delivery Date: 08/28/2026',
      'Purchase Order: KH-55120',
      'Ship To: KeHE Aurora DC',
      '',
      'Total Cartons Shipped: 48',
      'Total Cartons Received: 48',
      '',
      'This report is generated from carrier scan data.',
      'No consignee signature was captured for this delivery.',
    ],
  ],
  truth: {
    document_number: text('RL-DEL-88214'),
    total_cartons_shipped: int(48),
    total_cartons_received: int(48),
    signature_present: bool(false),
  },
});

export const KEHE_UNSIGNED_POD: FixtureCase = {
  key: 'kehe-udr-unsigned-pod',
  title: 'KeHE K-Solve UDR claim with a carrier-generated, unsigned delivery report',
  retailer: 'kehe_ksolve',
  documents: [keheNotice, unsignedPod],
  expectedOutcome:
    'Reconciliation must flag the delivery document as unsigned (blocking): retailers reject carrier-generated reports without a consignee signature. The case needs a signed POD before a packet is worth assembling.',
};

// --- Case 3: Target price discrepancy (a claim the arithmetic contradicts) ---

const targetNotice = pdfDocument({
  key: 'target-price-notice',
  filename: 'target-synergy-notice.pdf',
  docType: 'deduction_notice',
  pages: [
    [
      'TARGET CORPORATION',
      'Partners Online - Deduction Advice',
      '',
      'Vendor: Northfork Components (VN-77120)',
      'Claim Number: TGT-2026-41880',
      'Invoice: NFC-10042',
      'PO: 0088-41200',
      'Deduction Date: 09/09/2026',
      '',
      'Item        Description       Code  Inv Qty  Rcv Qty  Unit Cost    Amount',
      '551-9930    Insulated Bottle   PD        120      120    $14.25    $1,710.00',
      '',
      'Code PD: Price discrepancy - billed above agreed cost',
      '',
      'Total Deduction: $1,710.00',
      'Disputes within 60 days of deduction date.',
    ],
  ],
  truth: {
    retailer_name: text('Target'),
    claim_id: text('TGT-2026-41880'),
    invoice_number: text('NFC-10042'),
    po_number: text('0088-41200'),
    'lines[0].sku_upc': text('551-9930'),
    'lines[0].qty_invoiced': int(120),
    'lines[0].qty_received': int(120),
    'lines[0].unit_cost': moneyCents(1_425),
    'lines[0].deduction_amount': moneyCents(171_000),
    'lines[0].reason_code': text('PD'),
    deduction_total: moneyCents(171_000),
  },
});

const targetPo = pdfDocument({
  key: 'target-po',
  filename: 'target-po.pdf',
  docType: 'po',
  pages: [
    [
      'TARGET CORPORATION',
      'PURCHASE ORDER',
      '',
      'PO Number: 0088-41200',
      'PO Date: 08/15/2026',
      'Buyer: Target Corporation',
      'Ship To: Target DC 0581',
      '',
      'Item        Description        Qty Ordered   Unit Cost',
      '551-9930    Insulated Bottle           120     $14.25',
      '',
      'Total PO Value: $1,710.00',
    ],
  ],
  truth: {
    po_number: text('0088-41200'),
    'lines[0].sku_upc': text('551-9930'),
    'lines[0].qty_ordered': int(120),
    'lines[0].unit_cost': moneyCents(1_425),
  },
});

export const TARGET_PRICE_DISCREPANCY: FixtureCase = {
  key: 'target-price-discrepancy',
  title: 'Target price-discrepancy claim where the PO matches the billed price',
  retailer: 'target_synergy',
  documents: [targetNotice, targetPo],
  expectedOutcome:
    'The deduction claims the supplier billed above the agreed cost, but the PO agrees the same $14.25. Nothing was short-shipped. This is the shape of an invalid deduction: the supporting document contradicts the stated basis.',
};

export const FIXTURE_CASES: readonly FixtureCase[] = [
  WALMART_CODE_24,
  KEHE_UNSIGNED_POD,
  TARGET_PRICE_DISCREPANCY,
];

export function fixtureCase(key: string): FixtureCase {
  const found = FIXTURE_CASES.find((c) => c.key === key);
  if (found === undefined) throw new Error(`no fixture case ${key}`);
  return found;
}

/** The fixtures written alongside this code. */
export function authoredDocuments(): readonly FixtureDocument[] {
  return FIXTURE_CASES.flatMap((c) => c.documents);
}

export function allFixtureDocuments(): readonly FixtureDocument[] {
  return authoredDocuments();
}

export function fixtureDocumentsBySuite(
  documents: readonly FixtureDocument[],
): Map<FixtureDocument['suite'], FixtureDocument[]> {
  const bySuite = new Map<FixtureDocument['suite'], FixtureDocument[]>();
  for (const document of documents) {
    bySuite.set(document.suite, [...(bySuite.get(document.suite) ?? []), document]);
  }
  return bySuite;
}

export function fixtureDocument(key: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no fixture document ${key}`);
  return found;
}
