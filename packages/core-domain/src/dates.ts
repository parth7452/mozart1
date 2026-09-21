/**
 * Dates as they are printed on a document.
 *
 * They follow the money rule (invariant 3, and "models copy, we compute"): the
 * extraction model reports the verbatim text off the page and deterministic
 * code turns it into something the database can hold. A model is never asked to
 * normalise a date (ADR 0019). Retailer names get the same treatment next door,
 * in `retailers.ts`.
 */

export class DateParseError extends Error {}

/** The earliest and latest years a deduction document can plausibly print. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const MONTHS: ReadonlyMap<string, number> = new Map([
  ['january', 1],
  ['jan', 1],
  ['february', 2],
  ['feb', 2],
  ['march', 3],
  ['mar', 3],
  ['april', 4],
  ['apr', 4],
  ['may', 5],
  ['june', 6],
  ['jun', 6],
  ['july', 7],
  ['jul', 7],
  ['august', 8],
  ['aug', 8],
  ['september', 9],
  ['sept', 9],
  ['sep', 9],
  ['october', 10],
  ['oct', 10],
  ['november', 11],
  ['nov', 11],
  ['december', 12],
  ['dec', 12],
]);

/** Days in a month, Gregorian, so 2100 is not a leap year and 2000 is. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function assemble(year: number, month: number, day: number, original: string): string {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new DateParseError(
      `year out of range [${MIN_YEAR}, ${MAX_YEAR}] in ${JSON.stringify(original)}`,
    );
  }
  if (month < 1 || month > 12) {
    throw new DateParseError(`month ${month} is not a month in ${JSON.stringify(original)}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new DateParseError(
      `${JSON.stringify(original)} is not a calendar day: ${year}-${month} has no day ${day}`,
    );
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parses a date as written on a document into `YYYY-MM-DD`.
 *
 * Accepts ISO (`2026-08-14`), US numeric with a four-digit year (`08/14/2026`,
 * `8/14/2026`, `08-14-2026`) and month names (`August 14, 2026`,
 * `Aug. 14, 2026`, `14 August 2026`).
 *
 * Numeric dates are read **month-first**. That is not an assumption about US
 * retailers, it is what the corpus says: the Walmart APDP notice prints
 * `Deduction Date: 08/14/2026`, `Dispute Deadline: 11/12/2026` and "Disputes
 * must be filed within 90 days" — and 14 Aug + 90 days is 12 Nov exactly. Read
 * day-first, those two dates are 119 days apart and the notice contradicts its
 * own stated window. There is no day-first fallback on purpose: a fallback is a
 * guess, and it would give `03/04/2026` two readings. `14/08/2026` is rejected
 * because 14 is not a month.
 *
 * Rejects everything it cannot read unambiguously — two-digit years, dates with
 * no year, impossible calendar days, years outside 2000–2100, and relative
 * windows such as `180 days` or `60 days of deduction date`, which are a
 * retailer's rule rather than a date (ADR 0019 §7). The caller leaves the column
 * null and the verbatim text stays in `extraction_results` with its quote.
 */
export function parsePrintedDate(text: string): string {
  const original = text;
  const working = text.trim().replace(/\s+/g, ' ');
  if (working === '') throw new DateParseError('cannot parse a date from an empty string');

  // ISO, exactly: 2026-08-14.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(working);
  if (iso !== null) {
    return assemble(Number(iso[1]), Number(iso[2]), Number(iso[3]), original);
  }

  // US numeric, month first, four-digit year: 08/14/2026, 8/14/2026, 08-14-2026.
  const numeric = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/.exec(working);
  if (numeric !== null) {
    return assemble(Number(numeric[4]), Number(numeric[1]), Number(numeric[3]), original);
  }

  // Month name first: August 14, 2026 · Aug. 14, 2026 · Aug 14 2026.
  const monthFirst = /^([A-Za-z]+)\.? ?(\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(working);
  if (monthFirst !== null) {
    const month = MONTHS.get((monthFirst[1] ?? '').toLowerCase());
    if (month === undefined) {
      throw new DateParseError(`unknown month name in ${JSON.stringify(original)}`);
    }
    return assemble(Number(monthFirst[3]), month, Number(monthFirst[2]), original);
  }

  // Day first with a month name: 14 August 2026 · 14 Aug. 2026.
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+)\.?,? (\d{4})$/i.exec(working);
  if (dayFirst !== null) {
    const month = MONTHS.get((dayFirst[2] ?? '').toLowerCase());
    if (month === undefined) {
      throw new DateParseError(`unknown month name in ${JSON.stringify(original)}`);
    }
    return assemble(Number(dayFirst[3]), month, Number(dayFirst[1]), original);
  }

  throw new DateParseError(`cannot parse a date from ${JSON.stringify(original)}`);
}

/**
 * A date read off a page: either the day, or why we would not guess at it.
 *
 * Callers use this rather than swallowing the error. A deadline that will not
 * parse must not lose the case — better a case with no deadline than no case —
 * but it must not vanish either: the reason is recorded on `case.discovered`
 * where a reviewer sees it (CLAUDE.md: do not swallow errors, fail loud).
 */
export type PrintedDate = { readonly date: string } | { readonly problem: string };

export function tryParsePrintedDate(text: string): PrintedDate {
  try {
    return { date: parsePrintedDate(text) };
  } catch (error) {
    // Only a parse failure is a `problem`. Anything else is a bug in our code
    // and belongs on the floor, not folded into a null column.
    if (error instanceof DateParseError) return { problem: error.message };
    throw error;
  }
}
