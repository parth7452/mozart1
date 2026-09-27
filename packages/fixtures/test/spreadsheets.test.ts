import { describe, expect, it } from 'vitest';
import { formatCents, parseMoneyToCents, type Cents, type SheetMapping } from '@recouple/core-domain';
import { CSV_MIME, XLSX_MIME, parseWorkbook, type SpreadsheetMime } from '@recouple/ingest';
import { readSheetRows } from '@recouple/pipeline';
import {
  SPREADSHEET_COLUMNS,
  SPREADSHEET_HEADER,
  SPREADSHEET_SUBTOTAL_LABEL,
  spreadsheetCsv,
  spreadsheetGroundTruth,
  spreadsheetXlsx,
} from '../src/spreadsheets';

/**
 * The spreadsheet fixtures read through the real door's parser and the real
 * mapping reader, and held to the table that generated them.
 */

function mapping(sheetName: string): SheetMapping {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: '00000000-0000-4000-8000-000000000002',
    debtorId: '00000000-0000-4000-8000-000000000003',
    version: 1,
    effectiveFrom: '2026-01-01',
    headerRow: 1,
    sheetName,
    headerFingerprint: [...SPREADSHEET_HEADER],
    shape: 'deduction_list',
    columns: { ...SPREADSHEET_COLUMNS },
    nonLineRule: { firstCellMatches: [SPREADSHEET_SUBTOTAL_LABEL] },
    sign: 'deductions_negative',
    currency: 'USD',
    dateOrder: 'dmy',
    sourceDocumentId: null,
    confirmedBy: '00000000-0000-4000-8000-000000000004',
  };
}

interface Line {
  deduction_amount: { value: string };
  deduction_reference: { value: string };
  reason_code: { value: string };
}
interface Notice {
  invoice_number: { value: string };
  deduction_date: { value: string };
  lines: Line[];
}

describe.each([
  ['csv', CSV_MIME as SpreadsheetMime, spreadsheetCsv()],
  ['xlsx', XLSX_MIME as SpreadsheetMime, spreadsheetXlsx()],
])('the %s fixture', (_name, mime, bytes) => {
  it('reads every row to its ground truth and skips the subtotal', () => {
    const wb = parseWorkbook(bytes, mime);
    const sheet = wb.sheets[0]!;
    const read = readSheetRows(wb, mapping(sheet.name));

    expect(read.unreadable).toEqual([]);
    expect(read.skipped).toEqual([spreadsheetGroundTruth().length + 2]);
    const truth = spreadsheetGroundTruth();
    expect(read.rows.map((r) => [r.row, r.claimId])).toEqual(truth.map((t) => [t.row, t.claimId]));
    read.rows.forEach((r, i) => {
      const t = truth[i]!;
      const notice = r.notice as Notice;
      const line = notice.lines[0]!;
      expect(parseMoneyToCents(line.deduction_amount.value)).toBe(t.amountCents);
      expect(line.deduction_amount.value).toBe(formatCents(t.amountCents as Cents));
      expect(line.reason_code.value).toBe(t.reason);
      expect(notice.invoice_number.value).toBe(t.invoice);
      expect(notice.deduction_date.value).toBe(t.date);
    });
  });
});
