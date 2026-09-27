import type { ParsedWorkbook } from '@recouple/ingest';
import type { ResultCell } from '@recouple/pipeline';
import type { CellVerdict, SheetExtractView } from '../components/sheet-extract';

export interface SheetField {
  readonly fieldPath: string;
  readonly sourceQuote: string;
  readonly quoteVerified: boolean | null;
  readonly value?: unknown;
  readonly extractionResultId?: string;
}

/**
 * The case's row of a stored spreadsheet, with each field's cell (ADR 0056).
 * The row is the one its deduction amount was read from, else its first
 * field's. A field whose cell no longer reads as its quote is "not at
 * address"; one whose cell reads as its quote but was recorded unverified is
 * an amount the cell does not carry. Pure.
 */
export function buildSheetExtract(input: {
  documentId: string;
  wb: ParsedWorkbook;
  fields: readonly SheetField[];
  cells: readonly ResultCell[];
  mapping?: SheetExtractView['mapping'];
  /** The mapping's header row; else the sheet's first row with a cell. */
  headerRow?: number;
  /** The case's amount as `formatCents` prints it: picks its row among many. */
  amountValue?: string;
}): SheetExtractView | undefined {
  const cellOf = new Map(input.cells.map((c) => [c.extractionResultId, c]));
  const placed = input.fields
    .map((field) => ({ field, cell: field.extractionResultId === undefined ? undefined : cellOf.get(field.extractionResultId) }))
    .filter((p): p is { field: SheetField; cell: ResultCell } => p.cell !== undefined);
  const amounts = placed.filter((p) => p.field.fieldPath.endsWith('deduction_amount'));
  const anchor =
    amounts.find((p) => input.amountValue !== undefined && p.field.value === input.amountValue) ??
    amounts[0] ??
    placed[0];
  if (anchor === undefined) return undefined;
  const sheet = input.wb.sheets.find((s) => s.name === anchor.cell.sheetName);
  if (sheet === undefined) return undefined;
  const rowNumber = anchor.cell.rowNumber;
  const onRow = placed.filter((p) => p.cell.sheetName === sheet.name && p.cell.rowNumber === rowNumber);
  const headerRow = input.headerRow ?? Math.min(...sheet.cells.map((c) => c.row));
  const width = Math.max(1, ...sheet.cells.map((c) => c.column));
  const textsOf = (row: number): string[] => {
    const out = Array.from({ length: width }, () => '');
    for (const c of sheet.cells) if (c.row === row) out[c.column - 1] = c.text;
    return out;
  };
  return {
    documentId: input.documentId,
    sheetName: sheet.name,
    header: textsOf(headerRow),
    rowNumber,
    row: textsOf(rowNumber),
    fields: onRow.map(({ field, cell }) => {
      const at = sheet.cells.find((c) => c.row === cell.rowNumber && c.column === cell.columnNumber);
      const verdict: CellVerdict =
        at === undefined || at.text.trim() !== field.sourceQuote.trim()
          ? 'not_at_address'
          : field.quoteVerified === false
            ? 'amount_not_in_cell'
            : 'match';
      return { fieldPath: field.fieldPath, ref: cell.cellRef, column: cell.columnNumber, verdict };
    }),
    ...(input.mapping !== undefined ? { mapping: input.mapping } : {}),
  };
}
