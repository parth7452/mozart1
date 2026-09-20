/**
 * Reading a date and time off a document, so two of them can be compared.
 *
 * A whole class of deduction turns on minutes: a late-delivery fee, detention,
 * an appointment window. Deciding those means comparing a timestamp the customer
 * recorded against one an agreement set — which means parsing both, exactly, and
 * refusing to compare them when the comparison would be meaningless.
 *
 * Same division of labour as money: the reader reports what is printed
 * ("August 13, 2026, 1:42 PM Eastern") and the arithmetic happens here.
 *
 * ## The trap
 *
 * Two timestamps are only comparable if they are in the same zone. A receiving
 * gate stamps local time; an agreement states an appointment in the facility's
 * zone; a carrier's own system may log UTC. Subtracting one from another without
 * checking is how an 18-minute-early arrival becomes a 4-hour-late one, and the
 * error is invisible because the result is still a plausible number.
 *
 * So a zone is parsed as an opaque label and never converted. Two timestamps
 * compare only when their labels agree, or when neither states one; anything
 * else is `not_comparable`, and the caller reports that it could not check
 * rather than guessing. This is deliberately stricter than a date library: we
 * would rather say "cannot tell" than be confidently wrong about whether a
 * carrier owes $600.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export interface Timestamp {
  /** Calendar date as `YYYY-MM-DD`. */
  readonly date: string;
  /** Minutes since midnight, 0–1439. */
  readonly minutesOfDay: number;
  /**
   * The zone exactly as the document labelled it, lowercased — `eastern`, `est`,
   * `utc`. Never converted, only compared. Null when the document stated none.
   */
  readonly zone: string | null;
  /** What was on the page, kept so a reviewer can always check the reading. */
  readonly asPrinted: string;
}

/** Minutes from the epoch date, for ordering. Only meaningful within one zone. */
function absoluteMinutes(stamp: Timestamp): number {
  const [y, m, d] = stamp.date.split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 60_000) + stamp.minutesOfDay;
}

function realDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** `2:05 PM` / `14:05` / `2 PM` -> minutes of day, or null if it is not a time. */
function minutesOf(hour: number, minute: number, meridiem: string | undefined): number | null {
  if (minute < 0 || minute > 59) return null;
  if (meridiem === undefined) {
    return hour >= 0 && hour <= 23 ? hour * 60 + minute : null;
  }
  if (hour < 1 || hour > 12) return null;
  const base = hour % 12;
  return (meridiem.toLowerCase().startsWith('p') ? base + 12 : base) * 60 + minute;
}

/**
 * Reads a date and time as printed.
 *
 * All-numeric dates are read month-first, the US convention these documents use.
 * Returns null rather than throwing: an unreadable timestamp is a thing to
 * report as unverifiable, not an exception to unwind a reconciliation with.
 */
export function parseTimestamp(text: string | null | undefined): Timestamp | null {
  if (typeof text !== 'string') return null;
  const working = text.trim().replace(/\s+/g, ' ');
  if (working === '') return null;

  // The zone is whatever trailing word is not part of the time. Kept opaque.
  const zoneMatch = /\b(utc|gmt|z|eastern|central|mountain|pacific|e[sd]t|c[sd]t|m[sd]t|p[sd]t)\b\.?$/i
    .exec(working);
  const zone = zoneMatch?.[1]?.toLowerCase() ?? null;
  const withoutZone = zoneMatch === null ? working : working.slice(0, zoneMatch.index).trim();

  // `at` and a trailing comma are noise between the date and the time.
  const body = withoutZone.replace(/,?\s+at\s+/i, ' ').replace(/,\s*/g, ' ').trim();

  const time = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/.exec(body);
  if (time === null) return null;
  const meridiem = time[3]?.replace(/\./g, '');
  const minutesOfDay = minutesOf(Number(time[1]), Number(time[2]), meridiem);
  if (minutesOfDay === null) return null;

  const datePart = body.slice(0, time.index).trim();

  // "August 13 2026"
  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/.exec(datePart);
  if (named?.[1] !== undefined) {
    const month = MONTHS[named[1].toLowerCase()];
    const date = month === undefined ? null : realDate(Number(named[3]), month, Number(named[2]));
    return date === null ? null : { date, minutesOfDay, zone, asPrinted: text.trim() };
  }

  // "2026-08-13"
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart);
  if (iso?.[1] !== undefined) {
    const date = realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date === null ? null : { date, minutesOfDay, zone, asPrinted: text.trim() };
  }

  // "08/13/2026" — month first. These are US logistics and retail documents.
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(datePart);
  if (numeric?.[1] !== undefined && numeric[3] !== undefined) {
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    const date = realDate(year, Number(numeric[1]), Number(numeric[2]));
    return date === null ? null : { date, minutesOfDay, zone, asPrinted: text.trim() };
  }

  return null;
}

export type Comparison =
  | { readonly comparable: true; readonly minutesLate: number }
  | { readonly comparable: false; readonly why: string };

/**
 * How late `actual` is against `due`, in minutes. Negative means early.
 *
 * Refuses when the two state different zones, because that subtraction is the
 * one that produces a confidently wrong answer.
 */
export function minutesLate(actual: Timestamp, due: Timestamp): Comparison {
  if (actual.zone !== due.zone) {
    return {
      comparable: false,
      why:
        `the two timestamps are in different zones (${actual.zone ?? 'unstated'} and ` +
        `${due.zone ?? 'unstated'}), so one cannot be measured against the other`,
    };
  }
  return { comparable: true, minutesLate: absoluteMinutes(actual) - absoluteMinutes(due) };
}
