/**
 * A spreadsheet read by code (ADR 0056): every cell's text exactly as stored,
 * with where it was, what kind it was and whether a formula produced it. No
 * formula is evaluated, no number is converted and no date is interpreted;
 * a number cell keeps the digits the file wrote (`1234.5`) and a date keeps
 * its serial. Call only on bytes the door accepted.
 */
import { decodeCsvBytes, parseCsv } from './csv';
import { DEFAULT_SHEET_LIMITS, TSV_MIME, XLSX_MIME, type SpreadsheetMime } from './sheet-limits';
import { tokenizeXml, type XmlToken } from './sheet-xml';
import { columnOf, rowOfRef, unzipBounded } from './xlsx';

export type CellType = 'shared_string' | 'inline_string' | 'number' | 'boolean' | 'date_serial' | 'csv_field';
export const CELL_TYPES: readonly CellType[] = [
  'shared_string',
  'inline_string',
  'number',
  'boolean',
  'date_serial',
  'csv_field',
];

export interface SheetCell {
  row: number;
  column: number;
  ref: string;
  type: CellType;
  text: string;
  numberFormat: string | null;
  wasFormula: boolean;
  hidden: boolean;
}
export interface ParsedSheet {
  ordinal: number;
  name: string;
  hidden: boolean;
  hiddenRows: number[];
  cells: SheetCell[];
}
export interface ParsedWorkbook {
  mime: SpreadsheetMime;
  date1904: boolean;
  sheets: ParsedSheet[];
}
export interface CellAddress {
  sheetOrdinal: number;
  row: number;
  column: number;
}

export class MalformedSpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedSpreadsheetError';
  }
}

/** `3` → `C`, `28` → `AB`. */
export function columnLetters(column: number): string {
  let s = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export const cellRef = (row: number, column: number): string => `${columnLetters(column)}${row}`;

export function parseWorkbook(bytes: Uint8Array, mime: SpreadsheetMime, delimiter?: ',' | '\t'): ParsedWorkbook {
  if (mime === XLSX_MIME) return parseXlsx(bytes);
  const rows = parseCsv(decodeCsvBytes(bytes, DEFAULT_SHEET_LIMITS), delimiter ?? (mime === TSV_MIME ? '\t' : ','));
  const cells: SheetCell[] = [];
  rows.forEach((fields, r) =>
    fields.forEach((text, c) => {
      if (text === '') return;
      cells.push({
        row: r + 1,
        column: c + 1,
        ref: cellRef(r + 1, c + 1),
        type: 'csv_field',
        text,
        numberFormat: null,
        wasFormula: false,
        hidden: false,
      });
    }),
  );
  return { mime, date1904: false, sheets: [{ ordinal: 0, name: 'Sheet1', hidden: false, hiddenRows: [], cells }] };
}

type Open = Extract<XmlToken, { kind: 'open' }>;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function parseXlsx(bytes: Uint8Array): ParsedWorkbook {
  const entries = unzipBounded(bytes, DEFAULT_SHEET_LIMITS);
  const xml = (name: string): XmlToken[] | undefined => {
    const data = entries.get(name);
    return data ? tokenizeXml(utf8.decode(data)) : undefined;
  };
  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new MalformedSpreadsheetError('no workbook part');
  const rels = relationships(xml('xl/_rels/workbook.xml.rels') ?? []);
  const shared = sharedStrings(xml('xl/sharedStrings.xml') ?? []);
  const styles = cellFormats(xml('xl/styles.xml') ?? []);

  let date1904 = false;
  const sheets: ParsedSheet[] = [];
  for (const t of workbook) {
    if (t.kind !== 'open') continue;
    if (t.name === 'workbookPr') date1904 = t.attrs.date1904 === '1' || t.attrs.date1904 === 'true';
    if (t.name !== 'sheet') continue;
    const rid = t.attrs['r:id'] ?? Object.entries(t.attrs).find(([k]) => k.endsWith(':id'))?.[1];
    const target = rid ? rels.get(rid) : undefined;
    if (!target) throw new MalformedSpreadsheetError(`sheet ${t.attrs.name ?? ''} has no part`);
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const tokens = xml(path);
    if (!tokens) throw new MalformedSpreadsheetError(`sheet part ${path} is missing`);
    const hidden = t.attrs.state === 'hidden' || t.attrs.state === 'veryHidden';
    sheets.push(readSheet(sheets.length, t.attrs.name ?? `Sheet${sheets.length + 1}`, hidden, tokens, shared, styles));
  }
  return { mime: XLSX_MIME, date1904, sheets };
}

function relationships(tokens: XmlToken[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tokens) if (t.kind === 'open' && t.name === 'Relationship' && t.attrs.Id && t.attrs.Target) map.set(t.attrs.Id, t.attrs.Target);
  return map;
}

function sharedStrings(tokens: XmlToken[]): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let inT = false;
  let skip = 0;
  for (const t of tokens) {
    if (t.kind === 'open') {
      if (t.name === 'si') current = t.selfClosing ? (out.push(''), null) : '';
      else if (t.name === 'rPh') skip += t.selfClosing ? 0 : 1;
      else if (t.name === 't') inT = !t.selfClosing;
    } else if (t.kind === 'close') {
      if (t.name === 'si' && current !== null) {
        out.push(current);
        current = null;
      } else if (t.name === 'rPh') skip--;
      else if (t.name === 't') inT = false;
    } else if (inT && skip === 0 && current !== null) current += t.text;
  }
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_FORMAT_CODES: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 49: '@',
};

interface CellFormat {
  code: string | null;
  isDate: boolean;
}

function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%E+\-\s]*$/.test(bare);
}

function cellFormats(tokens: XmlToken[]): CellFormat[] {
  const custom = new Map<number, string>();
  const formats: CellFormat[] = [];
  let inXfs = false;
  for (const t of tokens) {
    if (t.kind === 'open' && t.name === 'numFmt') custom.set(Number.parseInt(t.attrs.numFmtId ?? '-1', 10), t.attrs.formatCode ?? '');
    else if (t.kind === 'open' && t.name === 'cellXfs') inXfs = !t.selfClosing;
    else if (t.kind === 'close' && t.name === 'cellXfs') inXfs = false;
    else if (inXfs && t.kind === 'open' && t.name === 'xf') {
      const id = Number.parseInt(t.attrs.numFmtId ?? '0', 10);
      const code = custom.get(id) ?? BUILTIN_FORMAT_CODES[id] ?? null;
      formats.push({ code, isDate: BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!)) });
    }
  }
  return formats;
}

function readSheet(
  ordinal: number,
  name: string,
  sheetHidden: boolean,
  tokens: XmlToken[],
  shared: string[],
  formats: CellFormat[],
): ParsedSheet {
  const cells: SheetCell[] = [];
  const hiddenRows: number[] = [];
  const hiddenCols: [number, number][] = [];
  let row = 0;
  let rowHidden = false;
  let nextColumn = 1;
  let cell: { attrs: Open['attrs']; column: number; v: string | null; is: string | null; f: boolean } | null = null;
  let capture: 'v' | 'is' | null = null;

  for (const t of tokens) {
    if (t.kind === 'open') {
      if (t.name === 'col' && (t.attrs.hidden === '1' || t.attrs.hidden === 'true')) {
        hiddenCols.push([Number.parseInt(t.attrs.min ?? '0', 10), Number.parseInt(t.attrs.max ?? '0', 10)]);
      } else if (t.name === 'row') {
        row = t.attrs.r ? Number.parseInt(t.attrs.r, 10) : row + 1;
        if (!Number.isInteger(row) || row < 1) throw new MalformedSpreadsheetError('a row number is malformed');
        rowHidden = t.attrs.hidden === '1' || t.attrs.hidden === 'true';
        if (rowHidden) hiddenRows.push(row);
        nextColumn = 1;
      } else if (t.name === 'c') {
        if (row === 0) throw new MalformedSpreadsheetError('a cell is outside any row');
        let column = nextColumn;
        if (t.attrs.r !== undefined) {
          const c = columnOf(t.attrs.r);
          if (c === undefined) throw new MalformedSpreadsheetError('a cell reference is malformed');
          // A cell's row is its <row r>; a reference naming another row would
          // put provenance on a cell the workbook does not have.
          if (rowOfRef(t.attrs.r) !== row) throw new MalformedSpreadsheetError('a cell reference names another row');
          column = c;
        }
        nextColumn = column + 1;
        cell = { attrs: t.attrs, column, v: null, is: null, f: false };
        if (t.selfClosing) cell = null;
      } else if (cell && t.name === 'f') cell.f = true;
      else if (cell && t.name === 'v' && !t.selfClosing) capture = 'v';
      else if (cell && t.name === 't' && !t.selfClosing && cell.is !== null) capture = 'is';
      else if (cell && t.name === 'is') cell.is = '';
      else if (cell && t.name === 'rPh') capture = null;
    } else if (t.kind === 'text') {
      if (!cell || capture === null) continue;
      if (capture === 'v') cell.v = (cell.v ?? '') + t.text;
      else cell.is += t.text;
    } else if (t.name === 'v' || t.name === 't') capture = null;
    else if (t.name === 'c' && cell) {
      const done = finishCell(cell, row, shared, formats);
      if (done) {
        const colHidden = hiddenCols.some(([a, b]) => cell!.column >= a && cell!.column <= b);
        cells.push({ ...done, row, column: cell.column, ref: cellRef(row, cell.column), hidden: sheetHidden || rowHidden || colHidden });
      }
      cell = null;
    }
  }
  return { ordinal, name, hidden: sheetHidden, hiddenRows, cells };
}

function finishCell(
  cell: { attrs: Record<string, string>; v: string | null; is: string | null; f: boolean },
  row: number,
  shared: string[],
  formats: CellFormat[],
): Pick<SheetCell, 'type' | 'text' | 'numberFormat' | 'wasFormula'> | null {
  if (row < 1) throw new MalformedSpreadsheetError('a cell sits outside a row');
  const t = cell.attrs.t ?? 'n';
  const style = formats[Number.parseInt(cell.attrs.s ?? '0', 10)];
  const numberFormat = style?.code ?? null;
  const wasFormula = cell.f;
  if (cell.v === null && cell.is === null && !wasFormula) return null;
  switch (t) {
    case 's': {
      const index = Number.parseInt(cell.v ?? '', 10);
      const text = shared[index];
      if (!/^\d+$/.test(cell.v ?? '') || text === undefined) throw new MalformedSpreadsheetError('a shared string index is out of range');
      return { type: 'shared_string', text, numberFormat, wasFormula };
    }
    case 'inlineStr':
      return { type: 'inline_string', text: cell.is ?? cell.v ?? '', numberFormat, wasFormula };
    case 'str':
    case 'e':
    case 'd':
      return { type: 'inline_string', text: cell.v ?? '', numberFormat, wasFormula };
    case 'b':
      return { type: 'boolean', text: cell.v ?? '', numberFormat, wasFormula };
    case 'n':
      return { type: style?.isDate ? 'date_serial' : 'number', text: cell.v ?? '', numberFormat, wasFormula };
    default:
      throw new MalformedSpreadsheetError(`unknown cell type ${t}`);
  }
}

/** One line per row, `REF: text` joined ` | `; a hidden row is prefixed `[hidden] `. Deterministic. */
export function renderSheetText(sheet: ParsedSheet): string {
  const byRow = new Map<number, SheetCell[]>();
  for (const c of sheet.cells) {
    const list = byRow.get(c.row);
    if (list) list.push(c);
    else byRow.set(c.row, [c]);
  }
  const hidden = new Set(sheet.hiddenRows);
  return [...byRow.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const line = byRow
        .get(r)!
        .slice()
        .sort((a, b) => a.column - b.column)
        .map((c) => `${c.ref}: ${c.text}`)
        .join(' | ');
      return hidden.has(r) ? `[hidden] ${line}` : line;
    })
    .join('\n');
}
