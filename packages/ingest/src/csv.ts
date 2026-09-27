/**
 * CSV and TSV at the door (ADR 0056): UTF-8 only (a BOM is allowed and
 * dropped), no NUL, no line past the cap, and RFC 4180 quoting. cp1252 and
 * every other legacy encoding are refused rather than guessed at.
 */
import { DEFAULT_SHEET_LIMITS, type SheetLimits } from './sheet-limits';

export class CsvRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvRefusedError';
  }
}

export function decodeCsvBytes(bytes: Uint8Array, limits: SheetLimits = DEFAULT_SHEET_LIMITS): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvRefusedError('not UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) throw new CsvRefusedError('contains a NUL byte');
  // A control character other than tab and the line ends is binary, not text.
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new CsvRefusedError('contains a control character');
  }
  const encoder = new TextEncoder();
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.length > limits.csvMaxLineBytes || encoder.encode(line).length > limits.csvMaxLineBytes) {
      throw new CsvRefusedError('a line is too long');
    }
  }
  return text;
}

/** RFC 4180: quoted fields may hold the delimiter, newlines and `""`. */
export function parseCsv(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = text[i];
        if (next !== undefined && next !== delimiter && next !== '\n' && next !== '\r') {
          throw new CsvRefusedError('text after a closing quote');
        }
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    fieldStarted = true;
    i++;
  }
  if (quoted) throw new CsvRefusedError('unterminated quote');
  if (fieldStarted || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A cell written out where a spreadsheet may open it never starts a formula. */
export function csvSafe(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}
