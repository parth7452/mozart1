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

function buildRows(count: number): Row[] {
  const random = seeded(20260918);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const grossCents = Math.round((2_000 + random() * 48_000) / 25) * 25 * 100;
    // Roughly a third of invoices are short-paid, which is the realistic shape.
    const deducted = random() < 0.35;
    const deductionCents = deducted
      ? Math.min(grossCents, Math.round((grossCents * (0.01 + random() * 0.08)) / 100) * 100)
      : 0;
    rows.push({
      invoice: `INV-27${String(1000 + i)}`,
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
