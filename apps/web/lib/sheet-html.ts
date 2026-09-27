import type { ParsedWorkbook } from '@recouple/ingest';

/** Every character that could end a text node or an attribute, escaped. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The workbook as escaped HTML tables, one per sheet; `highlight` outlines a row. */
export function sheetHtml(wb: ParsedWorkbook, filename: string, highlight: number | undefined): string {
  const parts: string[] = [
    '<!doctype html><html><head><meta charset="utf-8"><title>',
    escapeHtml(filename),
    '</title><style>table{border-collapse:collapse;font:13px sans-serif}td,th{border:1px solid #ccc;padding:2px 6px}',
    'tr.highlight td{outline:2px solid #c60}tr.hidden td{color:#888;font-style:italic}</style></head><body>',
  ];
  for (const sheet of wb.sheets) {
    parts.push(`<h2>${escapeHtml(sheet.name)}${sheet.hidden ? ' (hidden sheet)' : ''}</h2><table>`);
    const rows = [...new Set(sheet.cells.map((c) => c.row))].sort((a, b) => a - b);
    const width = Math.max(1, ...sheet.cells.map((c) => c.column));
    const hiddenRows = new Set(sheet.hiddenRows);
    for (const row of rows) {
      const texts = Array.from({ length: width }, () => '');
      for (const c of sheet.cells) if (c.row === row) texts[c.column - 1] = c.text;
      const classes = [row === highlight ? 'highlight' : '', hiddenRows.has(row) ? 'hidden' : '']
        .filter((c) => c !== '')
        .join(' ');
      parts.push(
        `<tr${classes === '' ? '' : ` class="${classes}"`}><th>${row}${hiddenRows.has(row) ? ' (hidden row)' : ''}</th>`,
        ...texts.map((t) => `<td>${escapeHtml(t)}</td>`),
        '</tr>',
      );
    }
    parts.push('</table>');
  }
  parts.push('</body></html>');
  return parts.join('');
}
