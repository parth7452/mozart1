/**
 * A dense remittance advice.
 *
 * Every document measured so far carries one deducted line. Real remittances
 * carry dozens: the build plan singles out "skewed/scanned multi-hundred-line
 * remittances" as the hard case, and nothing in the corpus tested it. This is
 * the format most likely to break the flat wire format (many repeating rows),
 * the token budget, and the cost model.
 *
 * The rows and the ground truth are generated from one table, so they cannot
 * disagree, and the amounts are built from integer cents so the arithmetic on
 * the page is exact.
 */

import { renderTextPdf } from './pdf';
import type { FixtureDocument, TruthExpectation } from './cases';

interface Row {
  readonly invoice: string;
  readonly grossCents: number;
  readonly deductionCents: number;
  readonly reason: string;
}

const REASONS = ['SHORT', 'PRICE', 'DAMAGE', 'PROMO', 'OTIF', 'DISC'] as const;

/** Deterministic pseudo-random, so the fixture is byte-identical every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function buildRows(count: number, seed = 20260918, prefix = 'INV-27'): Row[] {
  const random = seeded(seed);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const grossCents = Math.round((2_000 + random() * 48_000) / 25) * 25 * 100;
    // Roughly a third of invoices are short-paid, which is the realistic shape.
    const deducted = random() < 0.35;
    const deductionCents = deducted
      ? Math.min(grossCents, Math.round((grossCents * (0.01 + random() * 0.08)) / 100) * 100)
      : 0;
    rows.push({
      invoice: `${prefix}${String(1000 + i)}`,
      grossCents,
      deductionCents,
      reason: deducted ? (REASONS[Math.floor(random() * REASONS.length)] as string) : '',
    });
  }
  return rows;
}

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pad = (text: string, width: number): string => text.padEnd(width);
const padLeft = (text: string, width: number): string => text.padStart(width);

export const DENSE_REMITTANCE_ROWS = 42;

function buildDenseRemittance(): FixtureDocument {
  const rows = buildRows(DENSE_REMITTANCE_ROWS);
  const grossTotal = rows.reduce((sum, r) => sum + r.grossCents, 0);
  const deductionTotal = rows.reduce((sum, r) => sum + r.deductionCents, 0);
  const netTotal = grossTotal - deductionTotal;

  const header = [
    'CROSSWIND GROCERY DISTRIBUTION',
    'REMITTANCE ADVICE',
    '',
    'Advice Number: RA-CW-880412',
    'Payment Date: 09/15/2026',
    'Payment Reference: ACH-CW-880412',
    'Pay To: Northstar Pantry Co.',
    'Supplier Account: NSP-1048',
    'Currency: USD',
    '',
    `${pad('Invoice', 14)}${padLeft('Gross', 13)}${padLeft('Deduction', 13)}${padLeft('Net Paid', 13)}  Code`,
    '-'.repeat(60),
  ];

  const body = rows.map(
    (row) =>
      `${pad(row.invoice, 14)}${padLeft(money(row.grossCents), 13)}` +
      `${padLeft(row.deductionCents === 0 ? '-' : money(row.deductionCents), 13)}` +
      `${padLeft(money(row.grossCents - row.deductionCents), 13)}  ${row.reason}`,
  );

  const footer = [
    '-'.repeat(60),
    `${pad('TOTALS', 14)}${padLeft(money(grossTotal), 13)}${padLeft(money(deductionTotal), 13)}${padLeft(money(netTotal), 13)}`,
    '',
    `Invoices included: ${rows.length}`,
    `Invoices short-paid: ${rows.filter((r) => r.deductionCents > 0).length}`,
    'Deduction detail available in the supplier portal. Dispute within 90 days.',
  ];

  // Roughly 30 rows to a page, which is what a printed advice does.
  const lines = [...header, ...body, ...footer];
  const perPage = 46;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));

  const text = (value: string): TruthExpectation => ({ kind: 'text', value });
  const moneyCents = (value: number): TruthExpectation => ({ kind: 'money_cents', value });

  const truth: Record<string, TruthExpectation> = {
    payer_name: text('Crosswind Grocery Distribution'),
    payment_reference: text('ACH-CW-880412'),
    payment_total: moneyCents(netTotal),
  };

  // Ground truth for every row: the invoice, its gross, and — where there is
  // one — the deduction and its code. A dense document is only a useful test if
  // every line is checked, not just the first few.
  rows.forEach((row, index) => {
    truth[`lines[${index}].invoice_number`] = text(row.invoice);
    truth[`lines[${index}].gross_amount`] = moneyCents(row.grossCents);
    truth[`lines[${index}].net_amount`] = moneyCents(row.grossCents - row.deductionCents);
    if (row.deductionCents > 0) {
      truth[`lines[${index}].deduction_amount`] = moneyCents(row.deductionCents);
      truth[`lines[${index}].reason_code`] = text(row.reason);
    }
  });

  return {
    key: 'crosswind-dense-remittance',
    filename: 'crosswind-dense-remittance.pdf',
    mimeType: 'application/pdf',
    docType: 'remittance_advice',
    pageText: pages.map((page) => page.join('\n')),
    bytes: renderTextPdf(pages),
    truth,
    suite: 'dense',
  };
}

let cache: FixtureDocument | undefined;

export function denseDocuments(): readonly FixtureDocument[] {
  cache ??= buildDenseRemittance();
  return [cache];
}

/**
 * A remittance too dense for one reply: 190 rows over five pages (ADR 0053).
 *
 * A row costs the reader about 250 output tokens, so one call's 32,000-token
 * budget runs out near 120 rows. This advice is read in page ranges or not at
 * all, and its suite, `dense_paged`, is what says whether the ranges join up.
 *
 * Laid out the way a distributor prints one: the advice header and column heads
 * on page 1, a continuation heading and the column heads again on every later
 * page, and the totals under the last row. One invoice is printed twice, as the
 * last row of page 2 and the first row of page 3 — two deductions against one
 * invoice (ADR 0048), either side of the boundary where two-page parts meet.
 * Its first line carries the gross and the net after both deductions; its
 * second prints only its own deduction. Joining the parts must keep both, in
 * that order.
 */
export const DENSE_PAGED_ROWS = 190;
export const DENSE_PAGED_PAGES = 5;
/** The row index of the second line of the invoice printed across pages 2 and 3. */
export const DENSE_PAGED_SPLIT_ROW = 76;

/** Lines a page holds, and how many of them its heading takes. */
const PAGED_LINES_PER_PAGE = 46;
const PAGED_FIRST_PAGE_HEADING = 12;
const PAGED_LATER_PAGE_HEADING = 4;

interface PagedRow {
  readonly invoice: string;
  /** Null where the line prints `-`: the second line of the split invoice. */
  readonly grossCents: number | null;
  readonly deductionCents: number;
  readonly netCents: number | null;
  readonly reason: string;
}

function pagedRows(): PagedRow[] {
  const rows: PagedRow[] = buildRows(DENSE_PAGED_ROWS, 20261005, 'INV-31').map((row) => ({
    invoice: row.invoice,
    grossCents: row.grossCents,
    deductionCents: row.deductionCents,
    netCents: row.grossCents - row.deductionCents,
    reason: row.reason,
  }));
  // The invoice printed either side of the page 2 / page 3 boundary: its first
  // line takes a shortage and states the net after both deductions, and the
  // second line is a price deduction against the same invoice.
  const first = rows[DENSE_PAGED_SPLIT_ROW - 1] as PagedRow;
  const firstDeduction = 18_400;
  const secondDeduction = 9_600;
  const gross = first.grossCents as number;
  rows[DENSE_PAGED_SPLIT_ROW - 1] = {
    invoice: first.invoice,
    grossCents: gross,
    deductionCents: firstDeduction,
    netCents: gross - firstDeduction - secondDeduction,
    reason: 'SHORT',
  };
  rows[DENSE_PAGED_SPLIT_ROW] = {
    invoice: first.invoice,
    grossCents: null,
    deductionCents: secondDeduction,
    netCents: null,
    reason: 'PRICE',
  };
  return rows;
}

function pagedRowLine(row: PagedRow): string {
  return (
    `${pad(row.invoice, 14)}${padLeft(row.grossCents === null ? '-' : money(row.grossCents), 13)}` +
    `${padLeft(row.deductionCents === 0 ? '-' : money(row.deductionCents), 13)}` +
    `${padLeft(row.netCents === null ? '-' : money(row.netCents), 13)}  ${row.reason}`
  );
}

/** A field as a perfect reader reports it: value, verbatim quote, page. */
function expectedField(value: string, quote: string, page: number) {
  return { value, confidence: 0.98, source_page: page, source_quote: quote, source_bbox: null };
}

function absentField() {
  return { value: null, confidence: 0, source_page: 1, source_quote: '' };
}

export interface DensePagedRemittance {
  readonly document: FixtureDocument;
  /** The page each row is printed on, by row index. */
  readonly rowPages: readonly number[];
  /**
   * What a perfect reader returns, in `RemittanceAdviceSchema`'s shape: every
   * quote verbatim on the page it cites. The extraction tests replay it through
   * the paged read part by part.
   */
  readonly expected: unknown;
}

function buildDensePagedRemittance(): DensePagedRemittance {
  const rows = pagedRows();
  const grossTotal = rows.reduce((sum, r) => sum + (r.grossCents ?? 0), 0);
  const deductionTotal = rows.reduce((sum, r) => sum + r.deductionCents, 0);
  const netTotal = grossTotal - deductionTotal;
  if (rows.reduce((sum, r) => sum + (r.netCents ?? 0), 0) !== netTotal) {
    throw new Error('dense_paged: the net column does not add up to the net total');
  }

  const columns = [
    `${pad('Invoice', 14)}${padLeft('Gross', 13)}${padLeft('Deduction', 13)}${padLeft('Net Paid', 13)}  Code`,
    '-'.repeat(60),
  ];
  const pageLabel = (page: number) => `Page ${page} of ${DENSE_PAGED_PAGES}`;
  const heading = (page: number): string[] =>
    page === 1
      ? [
          'LAKESHORE FOODSERVICE DISTRIBUTION',
          'REMITTANCE ADVICE',
          pageLabel(1),
          'Advice Number: RA-LK-551207',
          'Payment Date: 09/28/2026',
          'Payment Reference: ACH-LK-551207',
          'Pay To: Northstar Pantry Co.',
          'Supplier Account: NSP-2291',
          'Currency: USD',
          '',
          ...columns,
        ]
      : [
          'LAKESHORE FOODSERVICE DISTRIBUTION - REMITTANCE ADVICE RA-LK-551207 (continued)',
          pageLabel(page),
          ...columns,
        ];
  const footer = [
    '-'.repeat(60),
    `${pad('TOTALS', 14)}${padLeft(money(grossTotal), 13)}${padLeft(money(deductionTotal), 13)}${padLeft(money(netTotal), 13)}`,
    '',
    `Lines on this advice: ${rows.length}`,
    `Lines short-paid: ${rows.filter((r) => r.deductionCents > 0).length}`,
    'Deduction detail available in the supplier portal. Dispute within 90 days.',
  ];

  const pages: string[][] = [];
  const rowPages: number[] = [];
  let next = 0;
  for (let page = 1; page <= DENSE_PAGED_PAGES; page++) {
    const lines = heading(page);
    const headingLines = page === 1 ? PAGED_FIRST_PAGE_HEADING : PAGED_LATER_PAGE_HEADING;
    if (lines.length !== headingLines) throw new Error(`dense_paged: page ${page}'s heading`);
    const take = page === DENSE_PAGED_PAGES ? rows.length - next : PAGED_LINES_PER_PAGE - lines.length;
    for (const row of rows.slice(next, next + take)) {
      lines.push(pagedRowLine(row));
      rowPages.push(page);
    }
    next += take;
    if (page === DENSE_PAGED_PAGES) lines.push(...footer);
    if (lines.length > PAGED_LINES_PER_PAGE) {
      throw new Error(`dense_paged: page ${page} has ${lines.length} lines`);
    }
    pages.push(lines);
  }
  if (rowPages[DENSE_PAGED_SPLIT_ROW - 1] !== 2 || rowPages[DENSE_PAGED_SPLIT_ROW] !== 3) {
    throw new Error('dense_paged: the split invoice is not printed across pages 2 and 3');
  }

  const text = (value: string): TruthExpectation => ({ kind: 'text', value });
  const moneyCents = (value: number): TruthExpectation => ({ kind: 'money_cents', value });
  const truth: Record<string, TruthExpectation> = {
    payer_name: text('Lakeshore Foodservice Distribution'),
    payment_reference: text('ACH-LK-551207'),
    payment_date: text('09/28/2026'),
    payment_total: moneyCents(netTotal),
  };
  rows.forEach((row, index) => {
    truth[`lines[${index}].invoice_number`] = text(row.invoice);
    if (row.grossCents !== null) truth[`lines[${index}].gross_amount`] = moneyCents(row.grossCents);
    if (row.netCents !== null) truth[`lines[${index}].net_amount`] = moneyCents(row.netCents);
    if (row.deductionCents > 0) {
      truth[`lines[${index}].deduction_amount`] = moneyCents(row.deductionCents);
      truth[`lines[${index}].reason_code`] = text(row.reason);
    }
  });

  const expected = {
    payer_name: expectedField(
      'Lakeshore Foodservice Distribution',
      'LAKESHORE FOODSERVICE DISTRIBUTION',
      1,
    ),
    payment_reference: expectedField('ACH-LK-551207', 'Payment Reference: ACH-LK-551207', 1),
    payment_date: expectedField('09/28/2026', 'Payment Date: 09/28/2026', 1),
    payment_total: expectedField(money(netTotal), money(netTotal), DENSE_PAGED_PAGES),
    lines: rows.map((row, index) => {
      const page = rowPages[index] as number;
      const amount = (cents: number | null) =>
        cents === null ? absentField() : expectedField(money(cents), money(cents), page);
      return {
        invoice_number: expectedField(row.invoice, row.invoice, page),
        gross_amount: amount(row.grossCents),
        deduction_amount: amount(row.deductionCents === 0 ? null : row.deductionCents),
        net_amount: amount(row.netCents),
        reason_code: row.reason === '' ? absentField() : expectedField(row.reason, row.reason, page),
      };
    }),
  };

  return {
    document: {
      key: 'lakeshore-dense-paged-remittance',
      filename: 'lakeshore-dense-paged-remittance.pdf',
      mimeType: 'application/pdf',
      docType: 'remittance_advice',
      pageText: pages.map((page) => page.join('\n')),
      bytes: renderTextPdf(pages),
      truth,
      suite: 'dense_paged',
    },
    rowPages,
    expected,
  };
}

let pagedCache: DensePagedRemittance | undefined;

/** The paged remittance with its row layout and expected extraction beside it. */
export function densePagedRemittance(): DensePagedRemittance {
  pagedCache ??= buildDensePagedRemittance();
  return pagedCache;
}

export function densePagedDocuments(): readonly FixtureDocument[] {
  return [densePagedRemittance().document];
}
