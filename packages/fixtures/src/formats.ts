/**
 * Two formats Phase 1 has never read: a distributor's dense table with merged
 * cells, and a supplier portal's printout of an EDI 812.
 *
 * Both are the beachhead's own documents — a foodservice manufacturer selling
 * through a broadline distributor — where every other suite so far is grocery,
 * staffing or freight. STRATEGY §10 names both as worth more than more of what
 * we already have, and CLAUDE.md leaves Phase 1 open until they exist.
 *
 * **Merged cells.** A distributor's chargeback statement groups its lines by
 * program. The program cell is merged down the group, so on the page — and in
 * any text layer or OCR of it — the reason code is printed once, on the group's
 * first row, and every row beneath it is blank in that column. A reader that
 * takes each row on its own gives every line after the first no reason code at
 * all, or the wrong one. The same item appears in two groups under two codes,
 * and each group ends in a subtotal row that is not a line.
 *
 * **An EDI-derived portal export.** Distributors send the 812 over EDI and show
 * it to suppliers in a portal, which prints a formatted view and, beneath it,
 * the raw segments it came from. The segments carry every amount with an
 * implied decimal point — `184250` is $1,842.50 — so the page states each
 * number twice, once in a form that is money and once in a form that is not.
 * Models copy, we compute: the reading has to take the printed money, and a
 * reading that takes the segment instead is off by a factor of a hundred,
 * which the arithmetic catches.
 *
 * Every name here is invented. Each document is generated from one table, so
 * its page, its totals and its ground truth cannot disagree, and the amounts
 * are built in integer cents.
 *
 * The suite is `formats`, recorded 2026-09-24: both read in full, and the one
 * cost the format carries is grounding — a reason description a merged cell
 * prints across two rows comes back joined, and a joined quote is not on the
 * page.
 */

import { renderTextPdf } from './pdf';
import type { FixtureDocument, TruthExpectation } from './cases';

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const moneyCents = (value: number): TruthExpectation => ({ kind: 'money_cents', value });
const int = (value: number): TruthExpectation => ({ kind: 'int', value });

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (value: string, width: number): string => value.padEnd(width);
const padLeft = (value: string, width: number): string => value.padStart(width);

// --- A chargeback statement with merged program cells ------------------------

interface ChargebackRow {
  readonly item: string;
  readonly description: string;
  readonly cases: number;
  readonly rateCents: number;
}

interface ChargebackGroup {
  readonly code: string;
  /** The rest of the merged cell, one printed line per entry, under the code. */
  readonly label: readonly string[];
  readonly rows: readonly ChargebackRow[];
}

const CHARGEBACK_GROUPS: readonly ChargebackGroup[] = [
  {
    code: 'DPB-0917',
    label: ['Deviated price', 'billback', 'Contract NG-2231'],
    rows: [
      { item: '44102', description: 'Chicken Breast 4oz IQF', cases: 40, rateCents: 310 },
      { item: '44108', description: 'Chicken Tender Brd 5lb', cases: 25, rateCents: 275 },
      { item: '44115', description: 'Wing Sections 10lb', cases: 60, rateCents: 190 },
      { item: '44121', description: 'Chicken Thigh Bnls 5lb', cases: 32, rateCents: 240 },
      { item: '44130', description: 'Popcorn Chicken 4lb', cases: 18, rateCents: 220 },
      { item: '44137', description: 'Chicken Strips Hmstyl', cases: 22, rateCents: 265 },
    ],
  },
  {
    code: 'SWELL-Q3',
    label: ['Shelf-life / swell', 'allowance'],
    rows: [
      { item: '44210', description: 'Turkey Breast Sliced', cases: 14, rateCents: 485 },
      { item: '44214', description: 'Turkey Breast Smoked', cases: 10, rateCents: 510 },
      { item: '44219', description: 'Ham Black Forest Sl', cases: 12, rateCents: 440 },
      { item: '44225', description: 'Roast Beef Top Rnd Sl', cases: 8, rateCents: 630 },
    ],
  },
  {
    code: 'OSD-SHORT',
    label: ['Shortage at', 'receiving (OS&D)'],
    rows: [
      // The same item as the first group's first row, under another code.
      { item: '44102', description: 'Chicken Breast 4oz IQF', cases: 5, rateCents: 6_240 },
      { item: '44310', description: 'Beef Patty 4:1 80/20', cases: 3, rateCents: 7_125 },
      { item: '44318', description: 'Beef Patty 6:1 80/20', cases: 2, rateCents: 6_890 },
    ],
  },
];

const lineCents = (row: ChargebackRow): number => row.cases * row.rateCents;
const groupCents = (group: ChargebackGroup): number =>
  group.rows.reduce((sum, row) => sum + lineCents(row), 0);

/** The chargeback's total, in cents: every line of every group. */
export const NORTHGATE_CHARGEBACK_TOTAL_CENTS = CHARGEBACK_GROUPS.reduce(
  (sum, group) => sum + groupCents(group),
  0,
);

/** How many lines the chargeback carries — subtotal rows are not lines. */
export const NORTHGATE_CHARGEBACK_LINES = CHARGEBACK_GROUPS.reduce(
  (sum, group) => sum + group.rows.length,
  0,
);

function buildMergedCellChargeback(): FixtureDocument {
  // Columns: program (merged down its group) | item | description | cases |
  // rate per case | amount. The two right-hand columns sit under one header
  // cell merged across them, printed the way a text layer flattens it.
  const W = { program: 20, item: 8, description: 24, cases: 7, rate: 10, amount: 12 } as const;
  const width = W.program + W.item + W.description + W.cases + W.rate + W.amount;

  const table: string[] = [
    `${' '.repeat(W.program + W.item + W.description + W.cases)}${pad('|------ Billback -----|', W.rate + W.amount)}`,
    `${pad('Program / Reason', W.program)}${pad('Item', W.item)}${pad('Description', W.description)}` +
      `${padLeft('Cases', W.cases)}${padLeft('Rate/Cs', W.rate)}${padLeft('Amount', W.amount)}`,
    '-'.repeat(width),
  ];

  for (const group of CHARGEBACK_GROUPS) {
    // The merged cell: the code on the first row, the rest of its label on the
    // rows beneath, and nothing at all after that.
    const cell = [group.code, ...group.label];
    group.rows.forEach((row, index) => {
      table.push(
        `${pad(cell[index] ?? '', W.program)}${pad(row.item, W.item)}${pad(row.description, W.description)}` +
          `${padLeft(String(row.cases), W.cases)}${padLeft(money(row.rateCents), W.rate)}` +
          `${padLeft(money(lineCents(row)), W.amount)}`,
      );
    });
    table.push(
      `${pad('', W.program)}${pad(`Subtotal ${group.code}`, W.item + W.description + W.cases + W.rate)}` +
        `${padLeft(money(groupCents(group)), W.amount)}`,
    );
    table.push('');
  }

  const page = [
    'NORTHGATE FOODSERVICE DISTRIBUTION',
    'Manufacturer Chargeback Statement',
    '',
    'Supplier: Bramblewood Provisions Co.',
    'Vendor Number: BWP-20417',
    'Chargeback Number: NFD-CB-60318',
    'Invoice Number: BWP-INV-88214',
    'Purchase Order: NFD-PO-551907',
    'Distribution Center: DC 14 - Harrisburg, PA',
    'Chargeback Date: 09/12/2026',
    '',
    ...table,
    '-'.repeat(width),
    `${pad('TOTAL CHARGEBACK', width - W.amount)}${padLeft(money(NORTHGATE_CHARGEBACK_TOTAL_CENTS), W.amount)}`,
    '',
    'This amount has been deducted from your next payment.',
    'Disputes must be submitted through the supplier portal by 11/11/2026.',
  ];

  const truth: Record<string, TruthExpectation> = {
    retailer_name: text('Northgate Foodservice Distribution'),
    vendor_number: text('BWP-20417'),
    claim_id: text('NFD-CB-60318'),
    invoice_number: text('BWP-INV-88214'),
    po_number: text('NFD-PO-551907'),
    deduction_total: moneyCents(NORTHGATE_CHARGEBACK_TOTAL_CENTS),
    deduction_date: text('09/12/2026'),
    dispute_deadline: text('11/11/2026'),
  };

  // Every line, in page order: its item, its amount, and the code of the group
  // it sits in — the one fact a row does not print for itself.
  let index = 0;
  for (const group of CHARGEBACK_GROUPS) {
    for (const row of group.rows) {
      truth[`lines[${index}].sku_upc`] = text(row.item);
      truth[`lines[${index}].deduction_amount`] = moneyCents(lineCents(row));
      truth[`lines[${index}].reason_code`] = text(group.code);
      index += 1;
    }
  }

  return {
    key: 'northgate-chargeback-merged-cells',
    filename: 'northgate-chargeback-merged-cells.pdf',
    mimeType: 'application/pdf',
    docType: 'deduction_notice',
    pageText: [page.join('\n')],
    bytes: renderTextPdf([page]),
    truth,
    suite: 'formats',
  };
}

// --- An 812 as a supplier portal prints it ----------------------------------

interface AdjustmentLine {
  readonly code: string;
  readonly reason: string;
  readonly item: string;
  readonly description: string;
  readonly qtyInvoiced?: number;
  readonly qtyReceived?: number;
  readonly unitCents?: number;
  readonly amountCents: number;
}

const ADJUSTMENT_LINES: readonly AdjustmentLine[] = [
  {
    code: '03',
    reason: 'QUANTITY CONTESTED',
    item: '44102',
    description: 'Chicken Breast 4oz IQF',
    qtyInvoiced: 120,
    qtyReceived: 105,
    unitCents: 7_500,
    amountCents: 15 * 7_500,
  },
  {
    code: '01',
    reason: 'PRICING ERROR',
    item: '44115',
    description: 'Wing Sections 10lb',
    amountCents: 50_000,
  },
  {
    code: '07',
    reason: 'ALLOWANCE NOT RECEIVED',
    item: '44121',
    description: 'Chicken Thigh Bnls 5lb',
    amountCents: 21_750,
  },
];

/** The adjustment's total, in cents. */
export const NORTHGATE_812_TOTAL_CENTS = ADJUSTMENT_LINES.reduce(
  (sum, line) => sum + line.amountCents,
  0,
);

/** An EDI amount: cents with the decimal point implied, as the segments carry it. */
const ediAmount = (cents: number): string => String(cents);

function buildEdi812PortalExport(): FixtureDocument {
  const W = { line: 6, code: 6, reason: 24, item: 8, description: 24, amount: 12 } as const;
  const width = W.line + W.code + W.reason + W.item + W.description + W.amount;

  const formatted = [
    'NORTHGATE SUPPLIER PORTAL',
    'EDI 812 Credit/Debit Adjustment - Export',
    '',
    'Buyer (N1*BY): Northgate Foodservice Distribution',
    'Vendor (N1*VN): Bramblewood Provisions Co.',
    'Vendor Number: BWP-20417',
    'Adjustment Number: NFD-812-44017',
    'Adjustment Date: 09/11/2026',
    'Credit/Debit: D (debit to vendor)',
    'Invoice Reference (REF*IV): BWP-INV-87930',
    'Purchase Order (REF*PO): NFD-PO-550816',
    'Payment Reference: ACH-NFD-771305',
    '',
    `${pad('Line', W.line)}${pad('Code', W.code)}${pad('Reason', W.reason)}${pad('Item', W.item)}` +
      `${pad('Description', W.description)}${padLeft('Amount', W.amount)}`,
    '-'.repeat(width),
    ...ADJUSTMENT_LINES.flatMap((line, index) => {
      const row =
        `${pad(String(index + 1), W.line)}${pad(line.code, W.code)}${pad(line.reason, W.reason)}` +
        `${pad(line.item, W.item)}${pad(line.description, W.description)}${padLeft(money(line.amountCents), W.amount)}`;
      // Quantities and a unit price, where the adjustment turns on them, on a
      // detail row of their own — as a portal prints the CDD's sub-segments.
      return line.qtyInvoiced === undefined
        ? [row]
        : [
            row,
            `${' '.repeat(W.line + W.code)}Qty invoiced: ${line.qtyInvoiced}   ` +
              `Qty received: ${line.qtyReceived}   Unit price: ${money(line.unitCents as number)}`,
          ];
    }),
    '-'.repeat(width),
    `${pad('Total Adjustment Amount', width - W.amount)}${padLeft(money(NORTHGATE_812_TOTAL_CENTS), W.amount)}`,
    '',
    'Disputes must be submitted within 60 days of the adjustment date.',
  ];

  // The raw transaction the portal was built from. Amounts carry an implied
  // decimal point, and the segment terminator is `~`.
  const segments = [
    'SEGMENT TRACE (as received)',
    'ST*812*0001~',
    `BCD*20260911*NFD-812-44017*D*${ediAmount(NORTHGATE_812_TOTAL_CENTS)}*****BWP-INV-87930~`,
    'N1*BY*NORTHGATE FOODSERVICE DISTRIBUTION~',
    'N1*VN*BRAMBLEWOOD PROVISIONS CO*92*BWP-20417~',
    'REF*PO*NFD-PO-550816~',
    ...ADJUSTMENT_LINES.flatMap((line) => [
      `CDD*${line.code}*D**${ediAmount(line.amountCents)}~`,
      `LIN**VN*${line.item}~`,
    ]),
    `SE*${5 + ADJUSTMENT_LINES.length * 2}*0001~`,
  ];

  const page = [...formatted, '', ...segments];

  const truth: Record<string, TruthExpectation> = {
    retailer_name: text('Northgate Foodservice Distribution'),
    vendor_number: text('BWP-20417'),
    claim_id: text('NFD-812-44017'),
    invoice_number: text('BWP-INV-87930'),
    po_number: text('NFD-PO-550816'),
    deduction_total: moneyCents(NORTHGATE_812_TOTAL_CENTS),
    deduction_date: text('09/11/2026'),
    remittance_or_check: text('ACH-NFD-771305'),
  };
  ADJUSTMENT_LINES.forEach((line, index) => {
    truth[`lines[${index}].sku_upc`] = text(line.item);
    truth[`lines[${index}].deduction_amount`] = moneyCents(line.amountCents);
    truth[`lines[${index}].reason_code`] = text(line.code);
    if (line.qtyInvoiced !== undefined) {
      truth[`lines[${index}].qty_invoiced`] = int(line.qtyInvoiced);
      truth[`lines[${index}].qty_received`] = int(line.qtyReceived as number);
      truth[`lines[${index}].unit_cost`] = moneyCents(line.unitCents as number);
    }
  });

  return {
    key: 'northgate-edi-812-portal-export',
    filename: 'northgate-edi-812-portal-export.pdf',
    mimeType: 'application/pdf',
    docType: 'deduction_notice',
    pageText: [page.join('\n')],
    bytes: renderTextPdf([page]),
    truth,
    suite: 'formats',
  };
}

/** The raw 812 segments a portal export prints, for tests that check them. */
export function northgate812Segments(): readonly string[] {
  const page = buildEdi812PortalExport().pageText[0] ?? '';
  return page.split('\n').filter((line) => /^[A-Z0-9]{2,3}\*/.test(line));
}

let cache: readonly FixtureDocument[] | undefined;

/** The `formats` suite: two documents. */
export function formatsDocuments(): readonly FixtureDocument[] {
  cache ??= [buildMergedCellChargeback(), buildEdi812PortalExport()];
  return cache;
}
