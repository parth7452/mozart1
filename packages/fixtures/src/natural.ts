/**
 * HL-NAT-001: the natural channel, as a brand selling through two natural and
 * specialty distributors actually receives it.
 *
 * Every other suite is grocery, staffing, freight or broadline foodservice. The
 * leads the pre-sell call is for (docs/onboarding/leads/tarazi-foods.md) sell
 * through a UNFI-shaped and a KeHE-shaped distributor, and what reaches them is
 * a direct deposit advice whose deduction lines are codes, a manufacturer
 * chargeback's backup page, and a deduction detail export. This suite is those
 * shapes, so the demo reads as the lead's own world:
 *
 *   natural-dda-remittance           five invoices paid, three short-paid by
 *                                    code: `(Invoice#)-111`, `MCB(yyyymmdd)`,
 *                                    `AVL(PO#)` — opens three cases (ADR 0028)
 *   natural-mcb-backup               the MCB's own backup: deal type, items,
 *                                    cases, allowance per case, the customer the
 *                                    discount went to; total = the MCB line
 *   natural-ksolve-deduction-detail  the second distributor's export: a
 *                                    warehouse spoils line and an MCB admin fee,
 *                                    each with its own deduction number
 *   natural-deal-confirmation        the signed deal the MCB is checked against;
 *                                    one item's agreed allowance is lower than
 *                                    the rate billed (`promo_rate_mismatch`)
 *   natural-bol, natural-pod         the `-111` shortage's PO: shipped = ordered,
 *                                    received in full, signed, no exceptions
 *
 * Every name is invented: "Northwind Natural Distribution" stands in for a
 * UNFI-shaped payer and "Keystone Specialty Distribution" for a KeHE-shaped one,
 * and neither real name is printed on any page. The code *patterns* are the
 * public ones in docs/plans/unfi-portal/research.md's seed list, unverified
 * against a real UNFI or KeHE document.
 *
 * Each document is generated from one table, so its page, its totals and its
 * ground truth cannot disagree, and every amount is built in integer cents.
 * No cassette is recorded yet (EXECUTION.md P2).
 */

import { renderTextPdf } from './pdf';
import type { FixtureCase, FixtureDocument, TruthExpectation } from './cases';

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const moneyCents = (value: number): TruthExpectation => ({ kind: 'money_cents', value });
const int = (value: number): TruthExpectation => ({ kind: 'int', value });
const bool = (value: boolean): TruthExpectation => ({ kind: 'bool', value });

/** Cents as the page prints them: `$1,234.56`. */
export const naturalMoney = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = naturalMoney;
const pad = (value: string, width: number): string => value.padEnd(width);
const padLeft = (value: string, width: number): string => value.padStart(width);

const SUPPLIER = 'Harborline Foods LLC';
const NORTHWIND = 'Northwind Natural Distribution';
const KEYSTONE = 'Keystone Specialty Distribution';
const NORTHWIND_SUPPLIER_NUMBER = '41207';
const PAYMENT_REFERENCE = 'EFT-0091827';
const PAYMENT_DATE = '09/04/2026';

// --- The shortage's purchase order ------------------------------------------

interface OrderedItem {
  readonly item: string;
  readonly description: string;
  readonly cases: number;
  readonly unitCents: number;
}

/**
 * The PO the `-111` shortage was taken against: what was ordered, which is
 * what the BOL says shipped and the POD says was received.
 */
export const NATURAL_SHORTAGE_PO = {
  po: '4180267',
  invoice: 'HF-30418',
  items: [
    { item: '210441', description: 'Sesame Tahini 16oz 12ct', cases: 80, unitCents: 5_400 },
    { item: '210495', description: 'Org Garbanzo Beans 15oz 12ct', cases: 60, unitCents: 2_160 },
  ] as readonly OrderedItem[],
} as const;

const SHORTAGE_PO_CASES = NATURAL_SHORTAGE_PO.items.reduce((sum, i) => sum + i.cases, 0);
const SHORTAGE_INVOICE_CENTS = NATURAL_SHORTAGE_PO.items.reduce(
  (sum, i) => sum + i.cases * i.unitCents,
  0,
);
/** Four cases of tahini claimed short, at the invoiced case price. */
const SHORTAGE_CLAIM_CENTS = 4 * 5_400;

// --- The MCB, as billed and as agreed ---------------------------------------

interface McbLine {
  readonly item: string;
  readonly description: string;
  readonly cases: number;
  /** The allowance per case the backup bills. */
  readonly billedRateCents: number;
  /** The allowance per case the signed deal confirmation agreed. */
  readonly agreedRateCents: number;
}

export const NATURAL_MCB_NUMBER = 'MCB20260815';
export const NATURAL_DEAL_NUMBER = 'WD-26-08-3317';

/**
 * The chargeback's lines. The first is billed at $3.00 a case against a deal
 * that agreed $2.50 — the line a `promo_rate_mismatch` is argued on.
 */
export const NATURAL_MCB_LINES: readonly McbLine[] = [
  {
    item: '210441',
    description: 'Sesame Tahini 16oz 12ct',
    cases: 96,
    billedRateCents: 300,
    agreedRateCents: 250,
  },
  {
    item: '210458',
    description: 'Org Sesame Tahini 16oz 12ct',
    cases: 48,
    billedRateCents: 300,
    agreedRateCents: 300,
  },
  {
    item: '210472',
    description: 'Falafel Mix 12oz 6ct',
    cases: 60,
    billedRateCents: 180,
    agreedRateCents: 180,
  },
];

const mcbLineCents = (line: McbLine): number => line.cases * line.billedRateCents;
export const NATURAL_MCB_TOTAL_CENTS = NATURAL_MCB_LINES.reduce(
  (sum, line) => sum + mcbLineCents(line),
  0,
);

// --- The direct deposit advice ----------------------------------------------

interface AdviceDeduction {
  readonly code: string;
  readonly cents: number;
  readonly legend: string;
}

interface AdviceLine {
  readonly invoice: string;
  readonly po: string;
  readonly date: string;
  readonly grossCents: number;
  readonly deduction?: AdviceDeduction;
}

const LATE_PO = '4180311';
const LATE_FEE_CENTS = 15_000;

/** The advice's five invoices, three of them short-paid by code. */
export const NATURAL_ADVICE_LINES: readonly AdviceLine[] = [
  { invoice: 'HF-30412', po: '4180255', date: '08/06/2026', grossCents: 345_600 },
  {
    invoice: NATURAL_SHORTAGE_PO.invoice,
    po: NATURAL_SHORTAGE_PO.po,
    date: '08/11/2026',
    grossCents: SHORTAGE_INVOICE_CENTS,
    deduction: {
      code: `${NATURAL_SHORTAGE_PO.invoice}-111`,
      cents: SHORTAGE_CLAIM_CENTS,
      legend: 'Shortage / pricing discrepancy - backup to follow',
    },
  },
  {
    invoice: 'HF-30421',
    po: '4180274',
    date: '08/12/2026',
    grossCents: 691_200,
    deduction: {
      code: NATURAL_MCB_NUMBER,
      cents: NATURAL_MCB_TOTAL_CENTS,
      legend: 'Manufacturer chargeback - see MCB backup',
    },
  },
  {
    invoice: 'HF-30425',
    po: LATE_PO,
    date: '08/17/2026',
    grossCents: 288_000,
    deduction: {
      code: `AVL${LATE_PO}`,
      cents: LATE_FEE_CENTS,
      legend: 'Late delivery fee - arrived more than 30 minutes past appointment',
    },
  },
  { invoice: 'HF-30430', po: '4180322', date: '08/21/2026', grossCents: 410_400 },
];

const adviceNet = (line: AdviceLine): number => line.grossCents - (line.deduction?.cents ?? 0);
export const NATURAL_ADVICE_GROSS_CENTS = NATURAL_ADVICE_LINES.reduce((s, l) => s + l.grossCents, 0);
export const NATURAL_ADVICE_DEDUCTION_CENTS = NATURAL_ADVICE_LINES.reduce(
  (s, l) => s + (l.deduction?.cents ?? 0),
  0,
);
export const NATURAL_ADVICE_NET_CENTS = NATURAL_ADVICE_LINES.reduce((s, l) => s + adviceNet(l), 0);

function buildDirectDepositAdvice(): FixtureDocument {
  const W = { invoice: 11, po: 10, date: 12, gross: 12, deduction: 12, code: 15, net: 12 } as const;
  const width = W.invoice + W.po + W.date + W.gross + W.deduction + 2 + W.code + W.net;

  const row = (line: AdviceLine): string =>
    `${pad(line.invoice, W.invoice)}${pad(line.po, W.po)}${pad(line.date, W.date)}` +
    `${padLeft(money(line.grossCents), W.gross)}` +
    `${padLeft(line.deduction === undefined ? '-' : money(line.deduction.cents), W.deduction)}  ` +
    `${pad(line.deduction?.code ?? '', W.code)}${padLeft(money(adviceNet(line)), W.net)}`;

  const deducted = NATURAL_ADVICE_LINES.filter((l) => l.deduction !== undefined);

  const page = [
    'NORTHWIND NATURAL DISTRIBUTION',
    'DIRECT DEPOSIT ADVICE',
    '',
    `Payee: ${SUPPLIER}`,
    `Supplier Number: ${NORTHWIND_SUPPLIER_NUMBER}`,
    `Payment Number: ${PAYMENT_REFERENCE}`,
    `Payment Date: ${PAYMENT_DATE}`,
    'Payment Method: ACH direct deposit to account ending 4410',
    '',
    `${pad('Invoice #', W.invoice)}${pad('PO #', W.po)}${pad('Inv Date', W.date)}` +
      `${padLeft('Gross', W.gross)}${padLeft('Deduction', W.deduction)}  ` +
      `${pad('Deduction Code', W.code)}${padLeft('Net Paid', W.net)}`,
    '-'.repeat(width),
    ...NATURAL_ADVICE_LINES.map(row),
    '-'.repeat(width),
    `${pad('TOTALS', W.invoice + W.po + W.date)}${padLeft(money(NATURAL_ADVICE_GROSS_CENTS), W.gross)}` +
      `${padLeft(money(NATURAL_ADVICE_DEDUCTION_CENTS), W.deduction)}  ${pad('', W.code)}` +
      `${padLeft(money(NATURAL_ADVICE_NET_CENTS), W.net)}`,
    '',
    `Total Payment: ${money(NATURAL_ADVICE_NET_CENTS)}`,
    `Invoices paid: ${NATURAL_ADVICE_LINES.length}`,
    `Invoices with deductions: ${deducted.length}`,
    '',
    'Deduction codes on this payment',
    ...deducted.map((l) => `${pad(l.deduction?.code ?? '', W.code)}${l.deduction?.legend ?? ''}`),
    '',
    'Backup for coded deductions is sent separately by email. Missing backup may be',
    'requested from the supplier deductions team. Disputes are accepted within',
    '12 months of the deduction date through the supplier dispute portal.',
  ];

  const truth: Record<string, TruthExpectation> = {
    payer_name: text(NORTHWIND),
    payment_reference: text(PAYMENT_REFERENCE),
    payment_date: text(PAYMENT_DATE),
    payment_total: moneyCents(NATURAL_ADVICE_NET_CENTS),
  };
  NATURAL_ADVICE_LINES.forEach((line, index) => {
    truth[`lines[${index}].invoice_number`] = text(line.invoice);
    truth[`lines[${index}].gross_amount`] = moneyCents(line.grossCents);
    truth[`lines[${index}].net_amount`] = moneyCents(adviceNet(line));
    if (line.deduction !== undefined) {
      truth[`lines[${index}].deduction_amount`] = moneyCents(line.deduction.cents);
      // As printed: the code carries the invoice, the date or the PO in it,
      // and the reader copies it whole.
      truth[`lines[${index}].reason_code`] = text(line.deduction.code);
    }
  });

  return document('natural-dda-remittance', 'remittance_advice', [page], truth);
}

// --- The MCB backup ----------------------------------------------------------

const MCB_CUSTOMER = 'Cascade Commons Co-op (customer 2210)';
const PROMO_FROM = '08/01/2026';
const PROMO_TO = '08/31/2026';

function buildMcbBackup(): FixtureDocument {
  const W = { item: 9, description: 30, deal: 6, cases: 7, rate: 11, amount: 12 } as const;
  const width = W.item + W.description + W.deal + W.cases + W.rate + W.amount;

  const page = [
    'NORTHWIND NATURAL DISTRIBUTION',
    'Manufacturer Chargeback (MCB) Backup',
    '',
    `Supplier: ${SUPPLIER}`,
    `Supplier Number: ${NORTHWIND_SUPPLIER_NUMBER}`,
    `Chargeback Number: ${NATURAL_MCB_NUMBER}`,
    'Chargeback Date: 08/15/2026',
    `Deal Number: ${NATURAL_DEAL_NUMBER}`,
    'Deal Type: E',
    `Promotion Period: ${PROMO_FROM} - ${PROMO_TO}`,
    `Discount Passed To: ${MCB_CUSTOMER}`,
    'Distribution Center: 07 - Ridgefield, WA (West)',
    'Applied to Invoice: HF-30421',
    `Deducted on Payment: ${PAYMENT_REFERENCE}`,
    '',
    `${pad('Item', W.item)}${pad('Description', W.description)}${pad('Deal', W.deal)}` +
      `${padLeft('Cases', W.cases)}${padLeft('Allow/Cs', W.rate)}${padLeft('Amount', W.amount)}`,
    '-'.repeat(width),
    ...NATURAL_MCB_LINES.map(
      (line) =>
        `${pad(line.item, W.item)}${pad(line.description, W.description)}${pad('E', W.deal)}` +
        `${padLeft(String(line.cases), W.cases)}${padLeft(money(line.billedRateCents), W.rate)}` +
        `${padLeft(money(mcbLineCents(line)), W.amount)}`,
    ),
    '-'.repeat(width),
    `${pad('Total Chargeback', width - W.amount)}${padLeft(money(NATURAL_MCB_TOTAL_CENTS), W.amount)}`,
    '',
    'Deal type E: customer-specific everyday low price, submitted by the supplier or broker.',
    'Allowances are billed on cases shipped to the customer above during the promotion period.',
    'Disputes are accepted within 12 months of the chargeback date.',
  ];

  const truth: Record<string, TruthExpectation> = {
    retailer_name: text(NORTHWIND),
    vendor_number: text(NORTHWIND_SUPPLIER_NUMBER),
    claim_id: text(NATURAL_MCB_NUMBER),
    invoice_number: text('HF-30421'),
    deduction_total: moneyCents(NATURAL_MCB_TOTAL_CENTS),
    deduction_date: text('08/15/2026'),
    remittance_or_check: text(PAYMENT_REFERENCE),
  };
  // The deal type `E` is printed on every row, but is not asserted as the
  // reason code: the scorer matches text by containment, and a one-letter
  // expectation would pass almost any answer.
  NATURAL_MCB_LINES.forEach((line, index) => {
    truth[`lines[${index}].sku_upc`] = text(line.item);
    truth[`lines[${index}].deduction_amount`] = moneyCents(mcbLineCents(line));
  });

  return document('natural-mcb-backup', 'deduction_notice', [page], truth);
}

// --- The second distributor's deduction detail export -----------------------

interface DetailRow {
  readonly reference: string;
  readonly date: string;
  readonly invoice: string;
  readonly code: string;
  readonly description: string;
  readonly cents: number;
}

export const NATURAL_KEYSTONE_ROWS: readonly DetailRow[] = [
  {
    reference: 'KSD-5520431',
    date: '09/02/2026',
    invoice: 'HF-30388',
    code: 'SPL-WH',
    description: 'Warehouse spoils / unsaleables',
    cents: 21_240,
  },
  {
    reference: 'KSD-5520432',
    date: '09/02/2026',
    invoice: 'HF-30388',
    code: 'MCB-ADM',
    description: 'MCB processing / admin fee (8%)',
    cents: 9_440,
  },
];

export const NATURAL_KEYSTONE_TOTAL_CENTS = NATURAL_KEYSTONE_ROWS.reduce((s, r) => s + r.cents, 0);

function buildKeystoneDetailExport(): FixtureDocument {
  const W = { reference: 13, date: 12, invoice: 10, code: 9, description: 33, amount: 10 } as const;
  const width = W.reference + W.date + W.invoice + W.code + W.description + W.amount;

  const page = [
    'KEYSTONE SPECIALTY DISTRIBUTION',
    'Supplier Hub - Deduction Detail Export',
    '',
    `Supplier: ${SUPPLIER}`,
    'Supplier No: HF-88120',
    'Deduction Batch: KB-260903-0417',
    'Export Date: 09/03/2026',
    'Payment Reference: KSD-EFT-883104',
    '',
    `${pad('Deduction #', W.reference)}${pad('Ded Date', W.date)}${pad('Invoice #', W.invoice)}` +
      `${pad('Reason', W.code)}${pad('Reason Description', W.description)}${padLeft('Amount', W.amount)}`,
    '-'.repeat(width),
    ...NATURAL_KEYSTONE_ROWS.map(
      (r) =>
        `${pad(r.reference, W.reference)}${pad(r.date, W.date)}${pad(r.invoice, W.invoice)}` +
        `${pad(r.code, W.code)}${pad(r.description, W.description)}${padLeft(money(r.cents), W.amount)}`,
    ),
    '-'.repeat(width),
    `${pad('Total Deductions', width - W.amount)}${padLeft(money(NATURAL_KEYSTONE_TOTAL_CENTS), W.amount)}`,
    `Rows exported: ${NATURAL_KEYSTONE_ROWS.length}`,
    '',
    'Disputes must be opened in the Supplier Hub within 180 days of the deduction date.',
    'Backup for each deduction is available as a spreadsheet from the Supplier Hub.',
  ];

  const truth: Record<string, TruthExpectation> = {
    retailer_name: text(KEYSTONE),
    vendor_number: text('HF-88120'),
    claim_id: text('KB-260903-0417'),
    invoice_number: text('HF-30388'),
    deduction_total: moneyCents(NATURAL_KEYSTONE_TOTAL_CENTS),
    deduction_date: text('09/02/2026'),
    remittance_or_check: text('KSD-EFT-883104'),
  };
  NATURAL_KEYSTONE_ROWS.forEach((r, index) => {
    truth[`lines[${index}].deduction_amount`] = moneyCents(r.cents);
    truth[`lines[${index}].reason_code`] = text(r.code);
    truth[`lines[${index}].deduction_reference`] = text(r.reference);
    truth[`lines[${index}].reason_description`] = text(r.description);
  });

  return document('natural-ksolve-deduction-detail', 'deduction_notice', [page], truth);
}

// --- The signed deal confirmation --------------------------------------------

function buildDealConfirmation(): FixtureDocument {
  const W = { item: 9, description: 32, allowance: 20 } as const;
  const width = W.item + W.description + W.allowance;

  const page = [
    'NORTHWIND NATURAL DISTRIBUTION',
    'Promotion Deal Confirmation',
    '',
    `Deal Number: ${NATURAL_DEAL_NUMBER}`,
    `Supplier: ${SUPPLIER} (Supplier Number ${NORTHWIND_SUPPLIER_NUMBER})`,
    `Submitted By: Pacific Crest Sales, broker for ${SUPPLIER}`,
    'Region: West',
    'Deal Type: E - customer-specific everyday low price',
    `Customer: ${MCB_CUSTOMER}`,
    `Promotion Period: ${PROMO_FROM} - ${PROMO_TO}`,
    'Billing Method: manufacturer chargeback (MCB) on cases shipped',
    '',
    `${pad('Item', W.item)}${pad('Description', W.description)}${padLeft('Allowance per Case', W.allowance)}`,
    '-'.repeat(width),
    ...NATURAL_MCB_LINES.map(
      (line) =>
        `${pad(line.item, W.item)}${pad(line.description, W.description)}` +
        `${padLeft(money(line.agreedRateCents), W.allowance)}`,
    ),
    '-'.repeat(width),
    '',
    'Allowances apply only to cases shipped to the customer named above during the',
    'promotion period. No other allowance is authorised under this deal.',
    '',
    'Approved for Northwind Natural Distribution:',
    '/s/ Dana Whitfield, Category Manager          Date: 07/22/2026',
    '',
    `Accepted for ${SUPPLIER}:`,
    '/s/ Marisol Ortiz, Director of Sales          Date: 07/20/2026',
  ];

  const truth: Record<string, TruthExpectation> = {
    agreement_type: text('Promotion Deal Confirmation'),
    counterparty: text(NORTHWIND),
    effective_from: text(PROMO_FROM),
    effective_to: text(PROMO_TO),
    approved_by: text('Dana Whitfield'),
  };
  NATURAL_MCB_LINES.forEach((line, index) => {
    truth[`terms[${index}].sku_upc`] = text(line.item);
    truth[`terms[${index}].amount`] = moneyCents(line.agreedRateCents);
  });

  // `promo_agreement`, not `price_agreement`: the classifier's definitions
  // send a signed deal sheet and its allowances there, and the evidence
  // checklist asks a promotion reason for a `promo_deal_sheet`, which is what
  // a `promo_agreement` counts as. Both read through `AgreementSchema`.
  return document('natural-deal-confirmation', 'promo_agreement', [page], truth);
}

// --- The shortage's BOL and POD ----------------------------------------------

const CARRIER = 'Sierra Ridge Transport';
const BOL_NUMBER = 'SRT-7730418';

function buildBol(): FixtureDocument {
  const W = { item: 9, description: 34, shipped: 14 } as const;
  const page = [
    'STRAIGHT BILL OF LADING - SHORT FORM',
    `Carrier: ${CARRIER}`,
    '',
    `BOL Number: ${BOL_NUMBER}`,
    'Ship Date: 08/11/2026',
    `Purchase Order: ${NATURAL_SHORTAGE_PO.po}`,
    `Shipper Reference: Invoice ${NATURAL_SHORTAGE_PO.invoice}`,
    `Ship From: ${SUPPLIER}, Fresno, CA`,
    'Ship To: Northwind Natural Distribution DC 07, Ridgefield, WA',
    '',
    `${pad('Item', W.item)}${pad('Description', W.description)}${padLeft('Cases Shipped', W.shipped)}`,
    '-'.repeat(W.item + W.description + W.shipped),
    ...NATURAL_SHORTAGE_PO.items.map(
      (i) => `${pad(i.item, W.item)}${pad(i.description, W.description)}${padLeft(String(i.cases), W.shipped)}`,
    ),
    '-'.repeat(W.item + W.description + W.shipped),
    `Total Cases Shipped: ${SHORTAGE_PO_CASES}`,
    'Pallets: 4',
    'Seal Number: SRT-55102',
    '',
    'Shipper: /s/ L. Moreno, Harborline Foods LLC     Date: 08/11/2026',
    'Carrier: /s/ R. Patel, driver                    Date: 08/11/2026',
  ];

  const truth: Record<string, TruthExpectation> = {
    document_number: text(BOL_NUMBER),
    ship_date: text('08/11/2026'),
    carrier_name: text(CARRIER),
    po_number: text(NATURAL_SHORTAGE_PO.po),
    total_cartons_shipped: int(SHORTAGE_PO_CASES),
  };
  NATURAL_SHORTAGE_PO.items.forEach((i, index) => {
    truth[`lines[${index}].sku_upc`] = text(i.item);
    truth[`lines[${index}].qty_shipped`] = int(i.cases);
  });

  return document('natural-bol', 'bol', [page], truth);
}

function buildPod(): FixtureDocument {
  const W = { item: 9, description: 34, ordered: 14, received: 15 } as const;
  const width = W.item + W.description + W.ordered + W.received;
  const page = [
    'SIERRA RIDGE TRANSPORT',
    'DELIVERY RECEIPT / PROOF OF DELIVERY',
    '',
    'POD Number: SRT-POD-7730418',
    `BOL Number: ${BOL_NUMBER}`,
    `Purchase Order: ${NATURAL_SHORTAGE_PO.po}`,
    'Consignee: Northwind Natural Distribution DC 07, Ridgefield, WA',
    'Appointment: 08/13/2026 06:00 PT',
    'Gate Check-In: 08/13/2026 05:41 PT',
    '',
    `${pad('Item', W.item)}${pad('Description', W.description)}` +
      `${padLeft('Cases Ordered', W.ordered)}${padLeft('Cases Received', W.received)}`,
    '-'.repeat(width),
    ...NATURAL_SHORTAGE_PO.items.map(
      (i) =>
        `${pad(i.item, W.item)}${pad(i.description, W.description)}` +
        `${padLeft(String(i.cases), W.ordered)}${padLeft(String(i.cases), W.received)}`,
    ),
    '-'.repeat(width),
    `Total Cases Shipped: ${SHORTAGE_PO_CASES}`,
    `Total Cases Received: ${SHORTAGE_PO_CASES}`,
    'Exceptions: NONE',
    'OS&D: no overage, shortage or damage noted',
    '',
    'RECEIVED IN FULL, IN GOOD ORDER',
    'Received By: T. Nguyen, Receiving Lead',
    'Signature: /s/ T. Nguyen     Date: 08/13/2026',
  ];

  const truth: Record<string, TruthExpectation> = {
    document_number: text('SRT-POD-7730418'),
    po_number: text(NATURAL_SHORTAGE_PO.po),
    appointment_at: text('08/13/2026 06:00 PT'),
    gate_check_in_at: text('08/13/2026 05:41 PT'),
    total_cartons_shipped: int(SHORTAGE_PO_CASES),
    total_cartons_received: int(SHORTAGE_PO_CASES),
    signed_by: text('T. Nguyen'),
    signature_present: bool(true),
  };
  NATURAL_SHORTAGE_PO.items.forEach((i, index) => {
    truth[`lines[${index}].sku_upc`] = text(i.item);
    truth[`lines[${index}].qty_received`] = int(i.cases);
  });

  return document('natural-pod', 'pod', [page], truth);
}

function document(
  key: string,
  docType: string,
  pages: readonly (readonly string[])[],
  truth: Record<string, TruthExpectation>,
): FixtureDocument {
  return {
    key,
    filename: `${key}.pdf`,
    mimeType: 'application/pdf',
    docType,
    pageText: pages.map((lines) => lines.join('\n')),
    bytes: renderTextPdf(pages),
    truth,
    suite: 'natural',
  };
}

let cache: readonly FixtureDocument[] | undefined;

/** The `natural` suite: six documents, one case. */
export function naturalDocuments(): readonly FixtureDocument[] {
  cache ??= [
    buildDirectDepositAdvice(),
    buildMcbBackup(),
    buildKeystoneDetailExport(),
    buildDealConfirmation(),
    buildBol(),
    buildPod(),
  ];
  return cache;
}

/** HL-NAT-001, for the demo script: the documents and what they argue. */
export const HL_NAT_001: FixtureCase = {
  key: 'HL-NAT-001',
  title: 'Harborline Foods natural channel: a coded direct deposit advice, its MCB backup, and a second distributor’s export',
  retailer: 'northwind_natural',
  get documents() {
    return naturalDocuments();
  },
  expectedOutcome:
    'The advice opens three cases, one per coded short-pay. The -111 shortage is disputable: the BOL shipped 140 cases against a 140-case PO and the POD is signed received in full with no exceptions. The MCB bills item 210441 at $3.00 a case where the signed deal agreed $2.50, so $48.00 of the $540.00 is arguable as a rate mismatch. The late fee needs an appointment record this pack does not hold. The second distributor’s spoils and MCB admin fee are notices to check against its own allowance terms. Filing is a human decision.',
};
