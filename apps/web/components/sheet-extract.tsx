/**
 * A case's row of a spreadsheet, shown in place of an embed (ADR 0056).
 *
 * Pure: everything it shows is in its props, and every cell is somebody
 * else's string, which React escapes. The header row and the case's row are
 * one grid; a cell a field was read from is outlined and named by its
 * address, and each field says whether its cell still says what was stored.
 */

export type CellVerdict = 'match' | 'amount_not_in_cell' | 'not_at_address';

export interface SheetExtractView {
  readonly documentId: string;
  readonly sheetName: string;
  readonly header: readonly string[];
  readonly rowNumber: number;
  readonly row: readonly string[];
  readonly fields: readonly {
    readonly fieldPath: string;
    readonly ref: string;
    readonly column: number;
    readonly verdict: CellVerdict;
  }[];
  readonly mapping?: { readonly version: number; readonly confirmedBy: string; readonly confirmedOn: string };
}

export const VERDICT_BADGE: Record<CellVerdict, string> = {
  match: 'cell matches',
  amount_not_in_cell: 'amount not in cell',
  not_at_address: 'cell not at address',
};

export function SheetExtract({ view }: { view: SheetExtractView }) {
  const outlined = new Set(view.fields.map((f) => f.column));
  return (
    <div className="sheet-extract">
      <a
        className="doc-view-link"
        href={`/api/document/${view.documentId}/sheet?row=${view.rowNumber}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open the whole sheet <span aria-hidden="true">↗</span>
      </a>{' '}
      <a className="doc-view-link" href={`/api/document/${view.documentId}`}>
        Download the original
      </a>
      <table className="sheet-grid">
        <thead>
          <tr>
            <th>Row</th>
            {view.header.map((text, i) => (
              <th key={i}>{text}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{view.rowNumber}</td>
            {view.row.map((text, i) => (
              <td key={i} className={outlined.has(i + 1) ? 'field-cell' : undefined}>
                {text}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <ul className="sheet-fields">
        {view.fields.map((f) => (
          <li key={f.fieldPath}>
            {f.fieldPath} — {view.sheetName}!{f.ref}{' '}
            <span className={`badge ${f.verdict === 'match' ? 'ok' : 'bad'}`}>{VERDICT_BADGE[f.verdict]}</span>
          </li>
        ))}
      </ul>
      {view.mapping !== undefined ? (
        <p className="hint">
          Read by mapping v{view.mapping.version}, confirmed by {view.mapping.confirmedBy} on{' '}
          {view.mapping.confirmedOn}.
        </p>
      ) : null}
    </div>
  );
}
