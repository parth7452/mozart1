import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  excelSerialToIso,
  headerFingerprint,
  numberCellToMoneyText,
  parseMoneyToCents,
  parsePrintedDate,
  SheetMappingSchema,
} from '../src';

describe('numberCellToMoneyText', () => {
  it('reads 1234.5 as 123450 cents', () => {
    expect(numberCellToMoneyText('1234.5')).toBe('1234.50');
    expect(parseMoneyToCents(numberCellToMoneyText('1234.5'))).toBe(123450);
  });
  it('refuses float noise and a fraction of a cent', () => {
    expect(() => numberCellToMoneyText('1234.4999999999998')).toThrow(RangeError);
    expect(() => numberCellToMoneyText('0.125')).toThrow(RangeError);
  });
  it('keeps zeros past the cents and whole numbers', () => {
    expect(numberCellToMoneyText('12.5000')).toBe('12.50');
    expect(numberCellToMoneyText('7')).toBe('7.00');
    expect(numberCellToMoneyText('-0.5')).toBe('-0.50');
  });
  it('expands an exponent', () => {
    expect(numberCellToMoneyText('1.2345E3')).toBe('1234.50');
    expect(numberCellToMoneyText('5E-2')).toBe('0.05');
    expect(numberCellToMoneyText('1e6')).toBe('1000000.00');
    expect(() => numberCellToMoneyText('1E-3')).toThrow(RangeError);
  });
  it('refuses what is not a number', () => {
    expect(() => numberCellToMoneyText('$1')).toThrow(RangeError);
    expect(() => numberCellToMoneyText('')).toThrow(RangeError);
  });
  it('round-trips any decimal string without a float', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 0, max: 2 }),
        fc.boolean(),
        (value, places, negative) => {
          const s = value.toString().padStart(3, '0');
          const whole = s.slice(0, -2).replace(/^0+(?=\d)/, '');
          const frac = s.slice(-2);
          const text = `${negative ? '-' : ''}${whole}${places === 0 ? '' : '.' + frac.slice(0, places)}`;
          const expected =
            places === 0 ? value / 100n * 100n : places === 1 ? value / 10n * 10n : value;
          const got = parseMoneyToCents(numberCellToMoneyText(text));
          const want = places === 0 ? BigInt(whole) * 100n : expected;
          expect(BigInt(got)).toBe(negative && want !== 0n ? -want : want);
        },
      ),
    );
  });
});

describe('excelSerialToIso', () => {
  it('reads the 1900 system with its leap bug', () => {
    expect(excelSerialToIso('1', false)).toBe('1900-01-01');
    expect(excelSerialToIso('59', false)).toBe('1900-02-28');
    expect(() => excelSerialToIso('60', false)).toThrow(RangeError);
    expect(excelSerialToIso('61', false)).toBe('1900-03-01');
    expect(excelSerialToIso('46248.75', false)).toBe('2026-08-14');
  });
  it('reads the 1904 system', () => {
    expect(excelSerialToIso('0', true)).toBe('1904-01-01');
    expect(excelSerialToIso('44786', true)).toBe('2026-08-14');
  });
});

describe('parsePrintedDate order', () => {
  it('is month first by default, day first or year first when told', () => {
    expect(parsePrintedDate('03/04/2026')).toBe('2026-03-04');
    expect(parsePrintedDate('03/04/2026', 'dmy')).toBe('2026-04-03');
    expect(parsePrintedDate('2026/04/03', 'ymd')).toBe('2026-04-03');
    expect(() => parsePrintedDate('2026/04/03')).toThrow();
  });
});

describe('SheetMappingSchema', () => {
  it('fingerprints trimmed headers in order and parses a mapping', () => {
    expect(headerFingerprint([{ text: ' Invoice ' }, { text: 'Amount' }])).toEqual(['Invoice', 'Amount']);
    const id = '00000000-0000-4000-8000-000000000001';
    expect(
      SheetMappingSchema.parse({
        id, orgId: id, debtorId: id, version: 1, effectiveFrom: '2026-09-27', headerRow: 1,
        sheetName: 'Sheet1', headerFingerprint: ['Invoice'], shape: 'remittance',
        columns: { invoice_number: 1 }, nonLineRule: { blankColumn: 1 },
        sign: 'deductions_positive', currency: 'USD', dateOrder: 'mdy',
        sourceDocumentId: null, confirmedBy: id,
      }).version,
    ).toBe(1);
  });
});
