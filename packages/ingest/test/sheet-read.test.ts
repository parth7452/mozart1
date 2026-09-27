import { describe, expect, it } from 'vitest';
import { CELL_TYPES, parseWorkbook, renderSheetText } from '../src/sheet-read';
import { CSV_MIME, TSV_MIME, XLSX_MIME } from '../src/sheet-limits';
import { buildXlsx, sheetXml } from './xlsx-builders';

const STYLES =
  '<?xml version="1.0"?><styleSheet xmlns="x"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>' +
  '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>';

const rows =
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Inv &amp; Co</t></is></c><c r="C1"><v>1234.5</v></c>' +
  '<c r="D1" t="b"><v>1</v></c><c r="E1" s="1"><v>45200</v></c><c r="F1" s="2"><v>3120</v></c></row>' +
  '<row r="2" hidden="1"><c r="A2"><f>SUM(C1,1)</f><v>1235.5</v></c><c r="B2" t="str"><f>"x"</f></c></row>';

describe('parseWorkbook: XLSX', () => {
  const wb = parseWorkbook(
    buildXlsx({
      sheets: [
        { name: 'Remit', xml: sheetXml(rows) },
        { name: 'Secret', xml: sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>'), state: 'hidden' },
      ],
      sharedStrings: ['Claim #'],
      styles: STYLES,
      date1904: true,
    }),
    XLSX_MIME,
  );
  const [remit, secret] = wb.sheets;
  const at = (ref: string) => remit!.cells.find((c) => c.ref === ref);

  it('keeps each cell verbatim, with its type', () => {
    expect(at('A1')).toMatchObject({ type: 'shared_string', text: 'Claim #', row: 1, column: 1 });
    expect(at('B1')).toMatchObject({ type: 'inline_string', text: 'Inv & Co' });
    expect(at('C1')).toMatchObject({ type: 'number', text: '1234.5' });
    expect(at('D1')).toMatchObject({ type: 'boolean', text: '1' });
    expect(at('E1')).toMatchObject({ type: 'date_serial', text: '45200', numberFormat: 'm/d/yyyy' });
    expect(at('F1')).toMatchObject({ type: 'number', text: '3120', numberFormat: '"$"#,##0.00' });
    expect(wb.date1904).toBe(true);
    expect(CELL_TYPES).toContain(at('A1')!.type);
  });

  it('reads a formula’s cached value, and none as empty text, never evaluating it', () => {
    expect(at('A2')).toMatchObject({ text: '1235.5', wasFormula: true });
    expect(at('B2')).toMatchObject({ text: '', wasFormula: true });
    expect(at('C1')!.wasFormula).toBe(false);
  });

  it('marks hidden sheets and rows', () => {
    expect(remit!.hidden).toBe(false);
    expect(remit!.hiddenRows).toEqual([2]);
    expect(at('A2')!.hidden).toBe(true);
    expect(at('A1')!.hidden).toBe(false);
    expect(secret).toMatchObject({ ordinal: 1, name: 'Secret', hidden: true });
    expect(secret!.cells[0]!.hidden).toBe(true);
  });

  it('renders deterministically', () => {
    const text = renderSheetText(remit!);
    expect(text).toBe(
      'A1: Claim # | B1: Inv & Co | C1: 1234.5 | D1: 1 | E1: 45200 | F1: 3120\n[hidden] A2: 1235.5 | B2: ',
    );
    expect(renderSheetText(remit!)).toBe(text);
  });
});

describe('parseWorkbook: CSV and TSV', () => {
  it('reads one sheet of csv fields', () => {
    const wb = parseWorkbook(new TextEncoder().encode('Claim,Amount\nCB-1,"$1,200.00"\n'), CSV_MIME);
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0]!.name).toBe('Sheet1');
    expect(wb.sheets[0]!.cells.find((c) => c.ref === 'B2')).toMatchObject({ type: 'csv_field', text: '$1,200.00' });
    expect(renderSheetText(wb.sheets[0]!)).toBe('A1: Claim | B1: Amount\nA2: CB-1 | B2: $1,200.00');
  });

  it('reads TSV by its type', () => {
    const wb = parseWorkbook(new TextEncoder().encode('a\tb,c\n'), TSV_MIME);
    expect(wb.sheets[0]!.cells.map((c) => c.text)).toEqual(['a', 'b,c']);
  });
});
