import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DateParseError, parsePrintedDate, tryParsePrintedDate } from '../src/dates';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Any calendar day inside the accepted window. */
const anyDate = fc
  .record({
    year: fc.integer({ min: 2000, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayOffset: fc.integer({ min: 0, max: 30 }),
  })
  .map(({ year, month, dayOffset }) => ({
    year,
    month,
    day: (dayOffset % daysInMonth(year, month)) + 1,
  }));

function iso({ year, month, day }: { year: number; month: number; day: number }): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

describe('parsePrintedDate — the formats the corpus prints', () => {
  it('reads ISO', () => {
    expect(parsePrintedDate('2026-09-03')).toBe('2026-09-03');
  });

  it('reads US numeric month-first, with either separator and a padded or bare month', () => {
    expect(parsePrintedDate('08/14/2026')).toBe('2026-08-14');
    expect(parsePrintedDate('8/14/2026')).toBe('2026-08-14');
    expect(parsePrintedDate('08-14-2026')).toBe('2026-08-14');
    expect(parsePrintedDate('11/2/2026')).toBe('2026-11-02');
  });

  it('reads month names, abbreviated or not, either way round', () => {
    expect(parsePrintedDate('August 14, 2026')).toBe('2026-08-14');
    expect(parsePrintedDate('Aug. 14, 2026')).toBe('2026-08-14');
    expect(parsePrintedDate('Aug 14 2026')).toBe('2026-08-14');
    expect(parsePrintedDate('14 August 2026')).toBe('2026-08-14');
    expect(parsePrintedDate('14 Aug. 2026')).toBe('2026-08-14');
    expect(parsePrintedDate('Sept 1, 2026')).toBe('2026-09-01');
  });

  it('tolerates the whitespace a text layer adds', () => {
    expect(parsePrintedDate('  August   14,  2026 ')).toBe('2026-08-14');
    expect(parsePrintedDate('\n2026-08-14\t')).toBe('2026-08-14');
  });
});

describe('parsePrintedDate — what it refuses to guess', () => {
  it('rejects a relative window, which is a retailer rule and not a date', () => {
    expect(() => parsePrintedDate('180 days')).toThrow(DateParseError);
    expect(() => parsePrintedDate('60 days of deduction date')).toThrow(DateParseError);
    expect(() => parsePrintedDate('Net 30')).toThrow(DateParseError);
  });

  it('rejects a two-digit year rather than picking a century', () => {
    expect(() => parsePrintedDate('08/14/26')).toThrow(DateParseError);
    expect(() => parsePrintedDate('26-08-14')).toThrow(DateParseError);
    expect(() => parsePrintedDate('August 14, 26')).toThrow(DateParseError);
  });

  it('rejects a date with no year', () => {
    expect(() => parsePrintedDate('08/14')).toThrow(DateParseError);
    expect(() => parsePrintedDate('August 14')).toThrow(DateParseError);
  });

  it('has no day-first fallback: 14 is not a month', () => {
    expect(() => parsePrintedDate('14/08/2026')).toThrow(DateParseError);
  });

  it('rejects impossible calendar days, leap years included', () => {
    expect(() => parsePrintedDate('2026-02-29')).toThrow(DateParseError);
    expect(() => parsePrintedDate('2100-02-29')).toThrow(DateParseError);
    expect(parsePrintedDate('2024-02-29')).toBe('2024-02-29');
    expect(parsePrintedDate('2000-02-29')).toBe('2000-02-29');
    expect(() => parsePrintedDate('04/31/2026')).toThrow(DateParseError);
    expect(() => parsePrintedDate('13/01/2026')).toThrow(DateParseError);
  });

  it('rejects years outside 2000–2100', () => {
    expect(() => parsePrintedDate('1999-12-31')).toThrow(DateParseError);
    expect(() => parsePrintedDate('2101-01-01')).toThrow(DateParseError);
    expect(parsePrintedDate('2000-01-01')).toBe('2000-01-01');
    expect(parsePrintedDate('2100-12-31')).toBe('2100-12-31');
  });

  it('rejects empty, junk and unknown month names', () => {
    expect(() => parsePrintedDate('')).toThrow(DateParseError);
    expect(() => parsePrintedDate('   ')).toThrow(DateParseError);
    expect(() => parsePrintedDate('n/a')).toThrow(DateParseError);
    expect(() => parsePrintedDate('Augus 14, 2026')).toThrow(DateParseError);
    expect(() => parsePrintedDate('08/14/2026 and 09/01/2026')).toThrow(DateParseError);
  });

  it('rejects mixed separators, which would mean we are reading it two ways', () => {
    expect(() => parsePrintedDate('08/14-2026')).toThrow(DateParseError);
  });
});

describe('parsePrintedDate — properties', () => {
  it('reads every spelling of a date back to the same day', () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        const expected = iso(date);
        const name = MONTH_NAMES[date.month - 1] ?? '';
        expect(parsePrintedDate(expected)).toBe(expected);
        expect(parsePrintedDate(`${date.month}/${date.day}/${date.year}`)).toBe(expected);
        expect(
          parsePrintedDate(
            `${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}-${date.year}`,
          ),
        ).toBe(expected);
        expect(parsePrintedDate(`${name} ${date.day}, ${date.year}`)).toBe(expected);
        expect(parsePrintedDate(`${date.day} ${name} ${date.year}`)).toBe(expected);
      }),
    );
  });

  it('always returns YYYY-MM-DD, or throws DateParseError — never anything else', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        try {
          expect(parsePrintedDate(text)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        } catch (error) {
          expect(error).toBeInstanceOf(DateParseError);
        }
      }),
    );
  });

  it('never accepts a year outside the window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9999 }).filter((y) => y < 2000 || y > 2100),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (year, month, day) => {
          const padded = String(year).padStart(4, '0');
          expect(() => parsePrintedDate(`${padded}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)).toThrow(
            DateParseError,
          );
          expect(() => parsePrintedDate(`${month}/${day}/${padded}`)).toThrow(DateParseError);
        },
      ),
    );
  });
});

describe('tryParsePrintedDate', () => {
  it('gives the day when it can read one', () => {
    expect(tryParsePrintedDate('08/14/2026')).toEqual({ date: '2026-08-14' });
  });

  it('gives a reason rather than nothing, so a lost deadline is visible', () => {
    const result = tryParsePrintedDate('60 days of deduction date');
    expect(result).not.toHaveProperty('date');
    expect('problem' in result && result.problem).toMatch(/cannot parse a date/);
  });

  it('never throws on text a document could contain', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = tryParsePrintedDate(text);
        if ('date' in result) expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        else expect(result.problem.length).toBeGreaterThan(0);
      }),
    );
  });
});
