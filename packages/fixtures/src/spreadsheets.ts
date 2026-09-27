import { strToU8, zipSync } from 'fflate';

/**
 * Spreadsheet fixtures (ADR 0056), generated from one table so the files and
 * their ground truth cannot drift. A distributor's deduction list, printed
 * with deductions negative and dates day-first, with a subtotal row the
 * mapping must skip. Written twice: as CSV, and as an XLSX whose text sits in
 * shared strings and whose amounts are number cells.
 *
 * No eval suite reads these and no baseline records them: a spreadsheet is
 * read by code, not by a model.
 */

export interface SpreadsheetRow {
  readonly reference: string;
  readonly invoice: string;
  /** The deduction, positive, in cents. Printed negative. */
  readonly amountCents: number;
  readonly reason: string;
  /** ISO date; printed day-first. */
  readonly date: string;
}

export const SPREADSHEET_HEADER = ['Reference', 'Invoice', 'Amount', 'Reason', 'Date'] as const;
export const SPREADSHEET_SUBTOTAL_LABEL = 'Subtotal';

export const SPREADSHEET_ROWS: readonly SpreadsheetRow[] = [
  { reference: 'CB-40117', invoice: 'INV-88120', amountCents: 18_425, reason: 'SHORT', date: '2026-09-03' },
  { reference: 'CB-40118', invoice: 'INV-88120', amountCents: 5_000, reason: 'PRICE', date: '2026-09-03' },
  { reference: 'CB-40131', invoice: 'INV-88164', amountCents: 123_450, reason: 'DAMAGE', date: '2026-09-11' },
  { reference: 'CB-40140', invoice: 'INV-88201', amountCents: 99, reason: 'SHORT', date: '2026-09-14' },
];

/** The mapping a person would confirm for these files: 1-based columns. */
export const SPREADSHEET_COLUMNS = {
  deduction_reference: 1,
  invoice_number: 2,
  deduction_amount: 3,
  reason_code: 4,
  deduction_date: 5,
} as const;

/** Cents as the page prints them, negative, with no thousands separator. */
function printedAmount(cents: number): string {
  return `-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function dayFirst(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function totalCents(): number {
  return SPREADSHEET_ROWS.reduce((sum, r) => sum + r.amountCents, 0);
}

/** The table as printed: header, one row per deduction, then the subtotal. */
function printedTable(): string[][] {
  return [
    [...SPREADSHEET_HEADER],
    ...SPREADSHEET_ROWS.map((r) => [r.reference, r.invoice, printedAmount(r.amountCents), r.reason, dayFirst(r.date)]),
    [SPREADSHEET_SUBTOTAL_LABEL, '', printedAmount(totalCents()), '', ''],
  ];
}

export function spreadsheetCsv(): Uint8Array {
  return strToU8(printedTable().map((row) => row.join(',')).join('\r\n') + '\r\n');
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const columnLetter = (i: number): string => String.fromCharCode(65 + i);

export function spreadsheetXlsx(): Uint8Array {
  const strings: string[] = [];
  const stringIndex = (s: string): number => {
    const at = strings.indexOf(s);
    if (at >= 0) return at;
    strings.push(s);
    return strings.length - 1;
  };
  const rows = printedTable()
    .map((cells, r) => {
      const xml = cells
        .map((text, c) => {
          if (text === '') return '';
          const ref = `${columnLetter(c)}${r + 1}`;
          // An amount is a number cell: the text of the number, never a float's.
          if (c === 2 && r > 0) return `<c r="${ref}"><v>${text}</v></c>`;
          return `<c r="${ref}" t="s"><v>${stringIndex(text)}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join('');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Deductions" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0"?><worksheet xmlns="${ns}"><sheetData>${rows}</sheetData></worksheet>`),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0"?><sst xmlns="${ns}">${strings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}</sst>`,
    ),
  });
}

/** What reading either file through the mapping must give: one line per row, in order. */
export function spreadsheetGroundTruth(): {
  readonly claimId: string;
  readonly invoice: string;
  readonly amountCents: number;
  readonly reason: string;
  readonly date: string;
  readonly row: number;
}[] {
  return SPREADSHEET_ROWS.map((r, i) => ({
    claimId: r.reference,
    invoice: r.invoice,
    amountCents: r.amountCents,
    reason: r.reason,
    date: r.date,
    row: i + 2,
  }));
}
