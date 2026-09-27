/**
 * Reading a spreadsheet's rows with code, through a person-confirmed mapping
 * (ADR 0056). No model, no formula evaluation: a cell's text is what the file
 * carried, and money is read from that text by `parseMoneyToCents`, never by
 * `Number()`.
 *
 * Pure: nothing here touches a store. `steps.ts` decides what the reading
 * opens and records.
 */

import {
  excelSerialToIso,
  formatCents,
  headerFingerprint,
  numberCellToMoneyText,
  parseMoneyToCents,
  parsePrintedDate,
  parseUnitPrice,
  type Cents,
  type SheetMapping,
} from '@recouple/core-domain';
import {
  DeductionNoticeSchema,
  flattenExtraction,
  moneyKindOf,
  RemittanceAdviceSchema,
  SCHEMA_VERSION,
  type DocType,
  type ExtractedField,
} from '@recouple/extraction';
import type { CellAddress, ParsedSheet, ParsedWorkbook, SheetCell } from '@recouple/ingest';

/** The extractor name a reading by mapping is recorded under, with its version. */
export const SHEET_EXTRACTOR = 'sheet-mapping';

/** How far down a sheet a header row is looked for. */
export const HEADER_SEARCH_ROWS = 10;

/** A reading made from rows, in the shape the pipeline stores a model's reading in, minus a call. */
export interface SheetDocumentReading {
  readonly docType: Extract<DocType, 'remittance_advice' | 'deduction_notice'>;
  readonly schemaVersion: string;
  readonly extractor: string;
  readonly document: unknown;
  readonly fields: readonly ExtractedField[];
  readonly validated: boolean;
  readonly issues: readonly { readonly path: string; readonly problem: string }[];
}

/** One line row of a deduction list, as its own one-line notice. */
export interface ReportRow {
  readonly row: number;
  readonly claimId: string;
  readonly notice: unknown;
}

export interface SheetRowsRead {
  readonly reading: SheetDocumentReading;
  /** The cell each stored field was read from, keyed by field path. */
  readonly cells: Map<string, SheetCell>;
  readonly unreadable: { row: number; reason: string }[];
  /** Rows the mapping's non-line rule skipped (subtotals, blanks). */
  readonly skipped: number[];
  /** For a `deduction_list`, every readable row as a one-line notice. */
  readonly rows: readonly ReportRow[];
  readonly sheet: ParsedSheet;
  readonly mapping: SheetMapping;
}

/** A header row found in a workbook, with its fingerprint. */
export interface FoundHeader {
  readonly sheet: ParsedSheet;
  readonly row: number;
  readonly fingerprint: string[];
}

/** Every candidate header row: each non-empty row among the first ten of each sheet. */
export function headerCandidates(wb: ParsedWorkbook): FoundHeader[] {
  const out: FoundHeader[] = [];
  for (const sheet of wb.sheets) {
    for (let row = 1; row <= HEADER_SEARCH_ROWS; row += 1) {
      const cells = rowCells(sheet, row);
      if (cells.length === 0) continue;
      out.push({ sheet, row, fingerprint: headerFingerprint(cells) });
    }
  }
  return out;
}

function rowCells(sheet: ParsedSheet, row: number): SheetCell[] {
  return sheet.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column);
}

/**
 * A money cell's cents, as printed in the cell. `flip` negates it (a sheet
 * whose deductions are printed negative). Throws `RangeError` rather than
 * answering zero for anything that is not money.
 */
export function moneyFromCell(cell: SheetCell, flip = false): Cents {
  let value: Cents;
  if (cell.type === 'number') {
    value = parseMoneyToCents(numberCellToMoneyText(cell.text));
  } else if (cell.type === 'shared_string' || cell.type === 'inline_string' || cell.type === 'csv_field') {
    value = parseMoneyToCents(cell.text);
  } else {
    throw new RangeError(`a ${cell.type} cell is not money`);
  }
  return (flip && value !== 0 ? -value : value) as Cents;
}

function unitPriceText(cell: SheetCell): string {
  if (cell.type === 'number') {
    if (!/^\d+(?:\.\d+)?$/.test(cell.text.trim())) throw new RangeError('not a plain unit price');
  } else if (cell.type === 'boolean' || cell.type === 'date_serial') {
    throw new RangeError(`a ${cell.type} cell is not a price`);
  }
  parseUnitPrice(cell.text);
  return cell.text.trim();
}

function dateFromCell(cell: SheetCell, wb: ParsedWorkbook, mapping: SheetMapping): string {
  if (cell.type === 'date_serial') return excelSerialToIso(cell.text, wb.date1904);
  if (cell.type === 'number' || cell.type === 'boolean') {
    throw new RangeError(`a ${cell.type} cell is not a date`);
  }
  return parsePrintedDate(cell.text, mapping.dateOrder);
}

const DATE_FIELDS = new Set(['deduction_date', 'dispute_deadline', 'payment_date']);
const QTY_FIELDS = new Set(['qty_invoiced', 'qty_received']);

/** Fields a remittance or a notice keeps at the top rather than on a line. */
const TOP_FIELDS: Record<SheetMapping['shape'], ReadonlySet<string>> = {
  remittance: new Set(['payer_name', 'payment_reference', 'payment_date', 'payment_total']),
  deduction_list: new Set([
    'retailer_name',
    'vendor_number',
    'invoice_number',
    'po_number',
    'store_or_dc',
    'gln',
    'asn_number',
    'deduction_date',
    'dispute_deadline',
    'remittance_or_check',
  ]),
};

/** Whether a mapped deduction amount is printed in the sheet's deduction sign. */
function flipsSign(field: string, mapping: SheetMapping): boolean {
  return mapping.sign === 'deductions_negative' && field === 'deduction_amount';
}

interface FieldObject {
  value: unknown;
  confidence: number;
  source_page: number;
  source_quote: string;
}

function fieldOf(value: unknown, cell: SheetCell, sheet: ParsedSheet): FieldObject {
  return { value, confidence: 1, source_page: sheet.ordinal + 1, source_quote: cell.text };
}

function absent(): FieldObject {
  return { value: null, confidence: 1, source_page: 0, source_quote: '' };
}

/** One row's mapped fields, read, or the reason it cannot be. */
function readRow(
  byColumn: Map<number, SheetCell>,
  wb: ParsedWorkbook,
  sheet: ParsedSheet,
  mapping: SheetMapping,
): { fields: Map<string, { field: FieldObject; cell: SheetCell }> } | { reason: string } {
  const out = new Map<string, { field: FieldObject; cell: SheetCell }>();
  for (const [name, column] of Object.entries(mapping.columns)) {
    const cell = byColumn.get(column);
    if (cell === undefined || cell.text.trim() === '') continue;
    try {
      let value: unknown;
      if (name === 'unit_cost') value = unitPriceText(cell);
      else if (moneyKindOf(name) === 'amount') value = formatCents(moneyFromCell(cell, flipsSign(name, mapping)));
      else if (DATE_FIELDS.has(name)) value = dateFromCell(cell, wb, mapping);
      else if (QTY_FIELDS.has(name)) {
        if (!/^-?\d+$/.test(cell.text.trim())) throw new RangeError('not a whole quantity');
        value = cell.text.trim();
      } else value = cell.text.trim();
      out.set(name, { field: fieldOf(value, cell, sheet), cell });
    } catch (error) {
      return { reason: `${name} at ${cell.ref}: ${error instanceof Error ? error.name : 'unreadable'}` };
    }
  }
  return { fields: out };
}

function isNonLine(byColumn: Map<number, SheetCell>, cells: readonly SheetCell[], mapping: SheetMapping): boolean {
  const rule = mapping.nonLineRule;
  if ('blankColumn' in rule) {
    const cell = byColumn.get(rule.blankColumn);
    return cell === undefined || cell.text.trim() === '';
  }
  const first = cells[0];
  return first !== undefined && rule.firstCellMatches.includes(first.text.trim());
}

const LINE_FIELDS: Record<SheetMapping['shape'], readonly string[]> = {
  remittance: ['invoice_number', 'gross_amount', 'deduction_amount', 'net_amount', 'reason_code'],
  deduction_list: [
    'sku_upc',
    'description',
    'qty_invoiced',
    'qty_received',
    'unit_cost',
    'deduction_amount',
    'reason_code',
    'deduction_reference',
    'reason_description',
  ],
};

/**
 * Reads every line row under the mapping's header in the sheet that carries
 * it. A row whose money (or claim, or date) will not read is `unreadable` —
 * never zero, never skipped silently. Rows the non-line rule names are
 * `skipped`.
 */
export function readSheetRows(wb: ParsedWorkbook, mapping: SheetMapping, sheetOrdinal?: number): SheetRowsRead {
  const sheet =
    (sheetOrdinal !== undefined ? wb.sheets.find((s) => s.ordinal === sheetOrdinal) : undefined) ??
    wb.sheets.find((s) => s.name === mapping.sheetName) ??
    wb.sheets[0];
  if (sheet === undefined) throw new RangeError('the workbook has no sheet');

  const rowNumbers = [...new Set(sheet.cells.map((c) => c.row))]
    .filter((r) => r > mapping.headerRow)
    .sort((a, b) => a - b);

  const unreadable: { row: number; reason: string }[] = [];
  const skipped: number[] = [];
  const read: { row: number; fields: Map<string, { field: FieldObject; cell: SheetCell }> }[] = [];

  for (const r of rowNumbers) {
    const cells = rowCells(sheet, r);
    const byColumn = new Map(cells.map((c) => [c.column, c]));
    if (isNonLine(byColumn, cells, mapping)) {
      skipped.push(r);
      continue;
    }
    const result = readRow(byColumn, wb, sheet, mapping);
    if ('reason' in result) {
      unreadable.push({ row: r, reason: result.reason });
      continue;
    }
    if (mapping.shape === 'deduction_list' && !result.fields.has('deduction_reference')) {
      unreadable.push({ row: r, reason: 'no deduction reference to key the claim on' });
      continue;
    }
    if (!result.fields.has('deduction_amount') && mapping.shape === 'deduction_list') {
      unreadable.push({ row: r, reason: 'no deduction amount' });
      continue;
    }
    read.push({ row: r, fields: result.fields });
  }

  const cells = new Map<string, SheetCell>();
  const top = TOP_FIELDS[mapping.shape];
  const lineNames = LINE_FIELDS[mapping.shape];

  // A top-level field is kept on the stored document only when every line row
  // that prints it prints the same text: a report of one payer's deductions.
  const topDoc: Record<string, FieldObject> = {};
  for (const name of top) {
    const printed = read.map((r) => r.fields.get(name)).filter((f) => f !== undefined);
    const first = printed[0];
    if (first !== undefined && printed.every((f) => f.cell.text === first.cell.text)) {
      topDoc[name] = first.field;
      cells.set(name, first.cell);
    } else {
      topDoc[name] = absent();
    }
  }

  const lines = read.map((r, index) => {
    const line: Record<string, FieldObject> = {};
    for (const name of lineNames) {
      const got = r.fields.get(name);
      line[name] = got?.field ?? absent();
      if (got !== undefined) cells.set(`lines[${index}].${name}`, got.cell);
    }
    return line;
  });

  let document: Record<string, unknown>;
  let docType: SheetDocumentReading['docType'];
  const rows: ReportRow[] = [];
  if (mapping.shape === 'remittance') {
    docType = 'remittance_advice';
    document = { ...topDoc, lines };
  } else {
    docType = 'deduction_notice';
    document = {
      ...topDoc,
      claim_id: absent(),
      deduction_total: absent(),
      lines,
    };
    read.forEach((r, index) => {
      const own: Record<string, FieldObject> = {};
      for (const name of top) own[name] = r.fields.get(name)?.field ?? absent();
      const line = lines[index] as Record<string, FieldObject>;
      const reference = line.deduction_reference as FieldObject;
      rows.push({
        row: r.row,
        claimId: String(reference.value),
        notice: {
          ...own,
          claim_id: reference,
          deduction_total: line.deduction_amount,
          lines: [line],
        },
      });
    });
  }

  const schema = docType === 'remittance_advice' ? RemittanceAdviceSchema : DeductionNoticeSchema;
  const parsed = schema.safeParse(document);
  const reading: SheetDocumentReading = {
    docType,
    schemaVersion: SCHEMA_VERSION,
    extractor: `${SHEET_EXTRACTOR}@v${mapping.version}`,
    document,
    fields: flattenExtraction(document),
    validated: parsed.success,
    issues: parsed.success
      ? []
      : parsed.error.issues.map((i) => ({ path: i.path.join('.'), problem: i.message })),
  };
  return { reading, cells, unreadable, skipped, rows, sheet, mapping };
}

/**
 * The one-line notice a stored deduction list holds for a claim: the line
 * whose `deduction_reference` is the claim, with the list's shared fields.
 * `undefined` when no line is that claim.
 */
export function reportRowNotice(listDocument: unknown, claimId: string): unknown {
  if (listDocument === null || typeof listDocument !== 'object') return undefined;
  const doc = listDocument as Record<string, unknown>;
  const lines = Array.isArray(doc.lines) ? (doc.lines as Record<string, { value?: unknown }>[]) : [];
  const line = lines.find((l) => l.deduction_reference?.value === claimId);
  if (line === undefined) return undefined;
  return { ...doc, claim_id: line.deduction_reference, deduction_total: line.deduction_amount, lines: [line] };
}

/**
 * Whether the quote is the cell at this address, exactly, and — for a money
 * field — whether the cell's money is `storedCents` (as printed in the cell,
 * before any sign the mapping applies). Never null: a spreadsheet always has
 * the cell to check against.
 */
export function verifyCellQuote(
  wb: ParsedWorkbook,
  addr: CellAddress,
  quote: string,
  field: string,
  storedCents?: Cents,
): boolean {
  const sheet = wb.sheets.find((s) => s.ordinal === addr.sheetOrdinal);
  const cell = sheet?.cells.find((c) => c.row === addr.row && c.column === addr.column);
  if (cell === undefined || cell.text.trim() !== quote.trim()) return false;
  if (moneyKindOf(field) !== 'amount') return true;
  if (storedCents === undefined) return false;
  try {
    return moneyFromCell(cell) === storedCents;
  } catch {
    // Not money: the check's answer is no, which is what it reports.
    return false;
  }
}
