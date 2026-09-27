/**
 * The ceilings a spreadsheet is held to at the door (ADR 0056). Every one is
 * counted over what the file actually holds, never over what it declares.
 */
export interface SheetLimits {
  maxRows: number;
  maxColumns: number;
  maxSheets: number;
  cellMaxChars: number;
  csvMaxLineBytes: number;
  zipMaxEntries: number;
  zipMaxInflatedBytes: number;
  zipMaxEntryRatio: number;
}

export const DEFAULT_SHEET_LIMITS: SheetLimits = {
  maxRows: 5000,
  maxColumns: 256,
  maxSheets: 32,
  cellMaxChars: 2000,
  csvMaxLineBytes: 64 * 1024,
  zipMaxEntries: 2000,
  zipMaxInflatedBytes: 200 * 1024 * 1024,
  zipMaxEntryRatio: 200,
};

/** Rows read per job step, so one step stays inside the 300 s route limit. */
export const SHEET_ROWS_PER_STEP = 250;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv';
export const TSV_MIME = 'text/tab-separated-values';
export type SpreadsheetMime = typeof XLSX_MIME | typeof CSV_MIME | typeof TSV_MIME;
export const isSpreadsheetMime = (m: string): m is SpreadsheetMime =>
  m === XLSX_MIME || m === CSV_MIME || m === TSV_MIME;
