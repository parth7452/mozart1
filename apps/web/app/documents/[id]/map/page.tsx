import { notFound } from 'next/navigation';
import { isSpreadsheetMime, parseWorkbook, type ParsedSheet } from '@recouple/ingest';
import { HEADER_SEARCH_ROWS, headerCandidates, sheetFields } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isUuid } from '../../../../lib/request';

export const dynamic = 'force-dynamic';

const PREVIEW_ROWS = 10;

function rowTexts(sheet: ParsedSheet, row: number, width: number): string[] {
  const out = Array.from({ length: width }, () => '');
  for (const cell of sheet.cells) {
    if (cell.row === row && cell.column <= width) out[cell.column - 1] = cell.text;
  }
  return out;
}

/**
 * "Map these columns" for a spreadsheet held `no_mapping` (ADR 0056).
 *
 * The header row and the first ten rows under it, as text React escapes — a
 * cell is somebody else's string — and one select per field the shape can
 * carry. Posting it records the mapping under this member and opens the
 * document through it (`./route.ts`). The bytes come through
 * `servableDocument`, so a document that did not scan clean shows nothing.
 */
export default async function MapColumnsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const session = await requireSession();
  const store = storeFor(session);
  try {
    const served = await store.servableDocument(id);
    if (served === undefined) notFound();
    if (served.refusal !== undefined || !isSpreadsheetMime(served.document.mimeType)) {
      return (
        <main className="page">
          <h1>Map these columns</h1>
          <p className="empty">This document cannot be mapped: it is not a spreadsheet that scanned clean.</p>
        </main>
      );
    }
    const wb = parseWorkbook(served.document.bytes, served.document.mimeType);
    const header = headerCandidates(wb)[0];
    const keys = await store.retailerKeys();
    const debtors = (await Promise.all(keys.map((k) => store.debtorByRetailerKey(k)))).filter(
      (d): d is { debtorId: string; displayName: string } => d !== undefined,
    );
    const mayMap = mayWrite(session.org.role);

    if (header === undefined) {
      return (
        <main className="page">
          <h1>Map these columns</h1>
          <p className="empty">No row in the first {HEADER_SEARCH_ROWS} of any sheet has any text.</p>
        </main>
      );
    }
    const width = Math.max(1, ...header.sheet.cells.map((c) => c.column));
    const headerTexts = rowTexts(header.sheet, header.row, width);
    const preview = Array.from({ length: PREVIEW_ROWS }, (_, i) => header.row + 1 + i).map((row) => ({
      row,
      cells: rowTexts(header.sheet, row, width),
    }));
    const firstCells = [...new Set(preview.map((p) => (p.cells[0] ?? '').trim()).filter((t) => t !== ''))];
    const fields = [...new Set([...sheetFields('remittance'), ...sheetFields('deduction_list')])];

    return (
      <main className="page">
        <h1>Map these columns</h1>
        <p>
          {served.document.filename} — sheet “{header.sheet.name}”, header on row {header.row}. Each value is read
          from its cell by code; nothing is guessed.
        </p>
        <table className="sheet-preview">
          <thead>
            <tr>
              <th>Row</th>
              {headerTexts.map((text, i) => (
                <th key={i}>{text}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((p) => (
              <tr key={p.row}>
                <td>{p.row}</td>
                {p.cells.map((text, i) => (
                  <td key={i}>{text}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {mayMap ? (
          <form action={`/documents/${id}/map`} method="post" className="sheet-map">
            <input type="hidden" name="sheet" value={String(header.sheet.ordinal)} />
            <input type="hidden" name="header_row" value={String(header.row)} />
            <label>
              Shape{' '}
              <select name="shape" required>
                <option value="remittance">Remittance (lines under one payment)</option>
                <option value="deduction_list">Deduction list (one deduction per row)</option>
              </select>
            </label>
            <label>
              Deductions are printed{' '}
              <select name="sign" required>
                <option value="deductions_positive">positive</option>
                <option value="deductions_negative">negative</option>
              </select>
            </label>
            <label>
              Dates are{' '}
              <select name="date_order" required>
                <option value="mdy">month/day/year</option>
                <option value="dmy">day/month/year</option>
                <option value="ymd">year-month-day</option>
              </select>
            </label>
            <label>
              From{' '}
              <select name="debtor" required>
                {debtors.map((d) => (
                  <option key={d.debtorId} value={d.debtorId}>
                    {d.displayName}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>Which column carries each field</legend>
              {fields.map((field) => (
                <label key={field}>
                  {field.replace(/_/g, ' ')}{' '}
                  <select name={`col:${field}`} defaultValue="">
                    <option value="">not on this sheet</option>
                    {headerTexts.map((text, i) => (
                      <option key={i} value={String(i + 1)}>
                        {text === '' ? `column ${i + 1}` : text}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
            {firstCells.length > 0 ? (
              <fieldset>
                <legend>Rows that are not lines (a subtotal, a total), by their first cell</legend>
                {firstCells.map((text) => (
                  <label key={text}>
                    <input type="checkbox" name="non_line" value={text} /> {text}
                  </label>
                ))}
                <p className="hint">None ticked: a row with no amount is not a line.</p>
              </fieldset>
            ) : null}
            <button type="submit">Save this mapping and open cases</button>
          </form>
        ) : (
          <p className="empty">Your role can look at this spreadsheet but not map it.</p>
        )}
      </main>
    );
  } finally {
    await store.close();
  }
}
