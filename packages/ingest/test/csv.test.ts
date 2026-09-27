import { describe, expect, it } from 'vitest';
import { CsvRefusedError, csvSafe, decodeCsvBytes, parseCsv } from '../src/csv';
import { acceptUpload, RejectedUploadError } from '../src/sniff';
import { CSV_MIME, DEFAULT_SHEET_LIMITS, TSV_MIME } from '../src/sheet-limits';

const enc = (s: string) => new TextEncoder().encode(s);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RejectedUploadError) return e.code;
    throw e;
  }
  return undefined;
};

describe('CSV at the door', () => {
  it('accepts UTF-8 with a BOM, and drops the BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('a,b\n1,2\n')]);
    expect(decodeCsvBytes(bytes)).toBe('a,b\n1,2\n');
    expect(acceptUpload(bytes, 'remit.csv').mimeType).toBe(CSV_MIME);
  });

  it('lets the filename pick the delimiter only', () => {
    expect(acceptUpload(enc('a\tb\n1\t2\n'), 'remit.tsv').mimeType).toBe(TSV_MIME);
    expect(acceptUpload(enc('a,b\n1,2\n'), 'remit.pdf').mimeType).toBe(CSV_MIME);
  });

  it('refuses invalid UTF-8 and cp1252 as a type it does not take', () => {
    expect(codeOf(() => acceptUpload(new Uint8Array([0x61, 0x2c, 0xff, 0x0a]), 'x.csv'))).toBe('type_not_allowed');
    // "Café,€5" in cp1252.
    const cp1252 = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x80, 0x35, 0x0a]);
    expect(codeOf(() => acceptUpload(cp1252, 'x.csv'))).toBe('type_not_allowed');
  });

  it('refuses a NUL, a control character and a line past the cap', () => {
    expect(() => decodeCsvBytes(enc('a,\u0000b'))).toThrow(CsvRefusedError);
    expect(() => decodeCsvBytes(enc('a,\u0007b'))).toThrow(CsvRefusedError);
    const long = 'x'.repeat(DEFAULT_SHEET_LIMITS.csvMaxLineBytes + 1);
    expect(() => decodeCsvBytes(enc(`a,b\n${long}\n`))).toThrow(/too long/);
    expect(codeOf(() => acceptUpload(enc(`a,b\n${long}\n`), 'x.csv'))).toBe('type_not_allowed');
  });

  it('parses quoted delimiters, newlines and doubled quotes', () => {
    expect(parseCsv('a,"b,c","d\ne","say ""hi"""\r\n1,2,3,4', ',')).toEqual([
      ['a', 'b,c', 'd\ne', 'say "hi"'],
      ['1', '2', '3', '4'],
    ]);
    expect(parseCsv('a,,b\n', ',')).toEqual([['a', '', 'b']]);
    expect(parseCsv('a\t"b\tc"', '\t')).toEqual([['a', 'b\tc']]);
  });

  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n1,2', ',')).toThrow(/unterminated/);
    expect(codeOf(() => acceptUpload(enc('a,"b\n1,2'), 'x.csv'))).toBe('type_not_allowed');
  });

  it('never lets a cell start a formula', () => {
    for (const c of ['=SUM(A1)', '+1', '-1', '@x', '\tx', '\rx']) expect(csvSafe(c)).toBe(`'${c}`);
    expect(csvSafe('$1,234.00')).toBe('$1,234.00');
  });
});
