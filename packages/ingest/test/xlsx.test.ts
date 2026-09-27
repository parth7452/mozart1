import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { inspectXlsx } from '../src/xlsx';
import { RejectedUploadError } from '../src/sniff-errors';
import { DEFAULT_SHEET_LIMITS } from '../src/sheet-limits';
import { buildXlsx, sheetXml, workbookParts } from './xlsx-builders';

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof RejectedUploadError) return e.code;
    throw e;
  }
  return undefined;
}

describe('inspectXlsx', () => {
  it('accepts a minimal workbook', () => {
    expect(codeOf(() => inspectXlsx(buildXlsx()))).toBeUndefined();
  });

  it('refuses entry names outside the package and nested archives', () => {
    for (const name of ['../evil.xml', '/abs.xml', '\\abs.xml', 'C:/x.xml', 'xl/inner.zip', 'xl/a.jar', 'xl/b.xlsx']) {
      const files = workbookParts();
      files[name] = strToU8('x');
      expect(codeOf(() => inspectXlsx(zipSync(files))), name).toBe('malformed_spreadsheet');
    }
  });

  it('refuses a cell whose reference names another row, or that sits outside any row', () => {
    for (const body of ['<row r="3"><c r="A7"><v>1</v></c></row>', '<c r="A1"><v>1</v></c>']) {
      const xlsx = buildXlsx({ sheets: [{ name: 'S', xml: sheetXml(body) }] });
      expect(codeOf(() => inspectXlsx(xlsx)), body).toBe('malformed_spreadsheet');
    }
  });

  it('refuses too many entries', () => {
    const files = workbookParts();
    for (let i = 0; i < 10; i++) files[`xl/media/f${i}.txt`] = strToU8('x');
    expect(codeOf(() => inspectXlsx(zipSync(files), { ...DEFAULT_SHEET_LIMITS, zipMaxEntries: 8 }))).toBe(
      'malformed_spreadsheet',
    );
  });

  it('counts a bomb by the bytes it inflates to, whatever the zip declares', () => {
    const files = workbookParts();
    files['xl/media/zeros.bin'] = new Uint8Array(4 * 1024 * 1024);
    const zip = zipSync(files, { level: 9 });
    // Declare every uncompressed size as 1 byte, in the local headers and the central directory.
    const lying = zip.slice();
    const view = new DataView(lying.buffer);
    for (let i = 0; i + 30 < lying.length; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x04034b50) view.setUint32(i + 22, 1, true);
      if (sig === 0x02014b50) view.setUint32(i + 24, 1, true);
    }
    const small = { ...DEFAULT_SHEET_LIMITS, zipMaxInflatedBytes: 1024 * 1024 };
    expect(codeOf(() => inspectXlsx(lying, small))).toBe('decompression_bomb');
    expect(codeOf(() => inspectXlsx(zip, small))).toBe('decompression_bomb');
    // And by ratio, inside the total budget.
    expect(codeOf(() => inspectXlsx(zip))).toBe('decompression_bomb');
  });

  it('refuses a package that is not a spreadsheet', () => {
    const bytes = buildXlsx({
      contentTypes:
        '<?xml version="1.0"?><Types xmlns="x"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    });
    expect(codeOf(() => inspectXlsx(bytes))).toBe('content_does_not_match_type');
  });

  it('refuses macros and a binary workbook', () => {
    expect(
      codeOf(() =>
        inspectXlsx(
          buildXlsx({
            contentTypes:
              '<?xml version="1.0"?><Types xmlns="x"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
          }),
        ),
      ),
    ).toBe('macro_enabled_spreadsheet');
    expect(codeOf(() => inspectXlsx(buildXlsx({ extra: { 'xl/vbaProject.bin': new Uint8Array([1, 2]) } })))).toBe(
      'macro_enabled_spreadsheet',
    );
    expect(codeOf(() => inspectXlsx(buildXlsx({ extra: { 'xl/workbook.bin': new Uint8Array([1]) } })))).toBe(
      'macro_enabled_spreadsheet',
    );
  });

  it('refuses external links, embeddings, ActiveX and external relationships', () => {
    for (const name of ['xl/externalLinks/externalLink1.xml', 'xl/embeddings/oleObject1.bin', 'xl/activeX/activeX1.xml']) {
      expect(codeOf(() => inspectXlsx(buildXlsx({ extra: { [name]: '<?xml version="1.0"?><x/>' } }))), name).toBe(
        'active_content_spreadsheet',
      );
    }
    const rels =
      '<?xml version="1.0"?><Relationships xmlns="x"><Relationship Id="r9" Type="t" Target="http://evil.example/" TargetMode="External"/></Relationships>';
    expect(codeOf(() => inspectXlsx(buildXlsx({ extra: { 'xl/worksheets/_rels/sheet1.xml.rels': rels } })))).toBe(
      'active_content_spreadsheet',
    );
  });

  it('refuses a DTD anywhere: billion laughs and XXE', () => {
    const laughs = sheetXml('').replace(
      '<worksheet',
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><worksheet',
    );
    expect(codeOf(() => inspectXlsx(buildXlsx({ sheets: [{ name: 'S', xml: laughs }] })))).toBe('xml_dtd_refused');
    const xxe = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><sst><si><t>&e;</t></si></sst>';
    expect(codeOf(() => inspectXlsx(buildXlsx({ extra: { 'xl/sharedStrings.xml': xxe } })))).toBe('xml_dtd_refused');
    const rels = '<!DOCTYPE r><Relationships/>';
    expect(codeOf(() => inspectXlsx(buildXlsx({ extra: { 'xl/x.rels': rels } })))).toBe('xml_dtd_refused');
  });

  it('refuses too many sheets, rows, columns or characters', () => {
    const limits = { ...DEFAULT_SHEET_LIMITS, maxSheets: 1, maxRows: 2, maxColumns: 3, cellMaxChars: 5 };
    const two = [{ name: 'A', xml: sheetXml('') }, { name: 'B', xml: sheetXml('') }];
    expect(codeOf(() => inspectXlsx(buildXlsx({ sheets: two }), limits))).toBe('spreadsheet_too_large');
    const rows = sheetXml('<row r="1"/><row r="2"/><row r="3"/>');
    expect(codeOf(() => inspectXlsx(buildXlsx({ sheets: [{ name: 'A', xml: rows }] }), limits))).toBe('spreadsheet_too_large');
    const cols = sheetXml('<row r="1"><c r="D1"><v>1</v></c></row>');
    expect(codeOf(() => inspectXlsx(buildXlsx({ sheets: [{ name: 'A', xml: cols }] }), limits))).toBe('spreadsheet_too_large');
    const long = sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>abcdef</t></is></c></row>');
    expect(codeOf(() => inspectXlsx(buildXlsx({ sheets: [{ name: 'A', xml: long }] }), limits))).toBe('spreadsheet_too_large');
    expect(codeOf(() => inspectXlsx(buildXlsx({ sharedStrings: ['abcdef'] }), limits))).toBe('spreadsheet_too_large');
  });

  it('refuses a truncated zip, and a plain zip, as a type it does not take', () => {
    expect(codeOf(() => inspectXlsx(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0])))).toBe('type_not_allowed');
    expect(codeOf(() => inspectXlsx(zipSync({ 'a.txt': strToU8('hello') })))).toBe('type_not_allowed');
  });
});
