/**
 * An amount is verified only when the page prints it, whole, identical to the
 * cent (ADR 0050).
 *
 * Finding a quote on the page says the model copied some text that is there.
 * It says nothing about the number the field reports: a quote of "Net payment"
 * is on the page whatever amount sits beside it, and a quote of "$6,721" is on
 * a page that prints "$6,721.85" — which then reads as $6,721.00. For a money
 * field, what has to be on the page is the amount itself: a number printed
 * inside the quoted text, read whole (never a prefix of a longer number), whose
 * value is the value the field reports, to the cent. A unit price is compared
 * at the digits it was printed with (ADR 0049), so a `$0.01` read off a page
 * printing `$0.0125` is not the same price, although both are stored as 1 cent.
 */

import {
  MoneyError,
  compareUnitPrices,
  parseMoneyToCents,
  parseUnitPrice,
} from '@recouple/core-domain';

/** How a money field is read: an amount to the cent, or a price per unit. */
export type MoneyKind = 'amount' | 'unit_price';

/**
 * Which money fields there are, by path: a `unit_cost` is a price per unit, and
 * a leaf naming an `_amount` or a `_total` is an amount. Anything else —
 * `terms[].amount`, whose text is "40¢" or "5% of balance" as often as money —
 * is not read as money here.
 */
export function moneyKindOf(fieldPath: string): MoneyKind | undefined {
  const leaf = fieldPath.split('.').at(-1) ?? fieldPath;
  if (leaf === 'unit_cost') return 'unit_price';
  if (leaf.includes('_amount') || leaf.includes('_total')) return 'amount';
  return undefined;
}

export function isMoneyFieldPath(fieldPath: string): boolean {
  return moneyKindOf(fieldPath) !== undefined;
}

/** One number printed in a text, read whole, with the marks that make it negative. */
export interface PrintedAmount {
  /** The number with its sign, currency and credit marks, as printed. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Every number printed in `text`, each read whole.
 *
 * A number is the longest run of digits in which a `.` or `,` counts only
 * between two digits, so "$6,721" is never read out of "$6,721.85" and a full
 * stop after "$1,275.00." is not part of it. Around it: a `$` (and one space
 * after it), accounting parentheses when both are there, a trailing `CR`/`DR`,
 * and a minus only when it stands alone — the hyphen in "CB-203", "5-$6.70"
 * or a leader of dashes is not a sign.
 */
export function printedAmounts(text: string): PrintedAmount[] {
  const pattern =
    /(\()?((?<![\p{L}\p{N}-])-)?(\$ ?)?((?<![\p{L}\p{N}-])-)?(\d+(?:[.,]\d+)*|\.\d+)(\))?(\s?(?:cr|dr)\b)?/giu;
  const found: PrintedAmount[] = [];
  for (const match of text.matchAll(pattern)) {
    const [whole, open, minusBefore, dollar, minusAfter, digits, close, credit] = match;
    if (digits === undefined) continue;
    // Parentheses only in pairs: "(5" is 5, and so is "5)".
    const paired = open !== undefined && close !== undefined;
    const printed =
      (paired ? '(' : '') +
      (minusBefore ?? '') +
      (dollar ?? '') +
      (minusAfter ?? '') +
      digits +
      (paired ? ')' : '') +
      (credit ?? '');
    const start = match.index + (open !== undefined && !paired ? 1 : 0);
    found.push({ text: printed, start, end: match.index + whole.length });
  }
  return found;
}

/** Whether printed money `a` is exactly the value `b`, read as `kind`. Unreadable is never equal. */
export function sameAmount(kind: MoneyKind, a: string, b: string): boolean {
  try {
    if (kind === 'unit_price') return compareUnitPrices(parseUnitPrice(a), parseUnitPrice(b)) === 0;
    return parseMoneyToCents(a) === parseMoneyToCents(b);
  } catch (error) {
    if (error instanceof MoneyError) return false;
    throw error;
  }
}

/** Whether a field's value can be read as money of this kind at all. */
export function readsAsMoney(kind: MoneyKind, value: string): boolean {
  return sameAmount(kind, value, value);
}

/** A span of the page's text: where a quote was found. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Whether the page prints `value`, whole and to the cent, where it was quoted.
 *
 * Two things must hold. The quote itself must print the amount — a label with
 * no number beside it does not. And the page must print it whole: a number on
 * the page, read to its own ends, inside the quoted span, whose value is the
 * value. Without spans (a quote matched only once punctuation or OCR glyphs
 * were set aside, whose position in the page's own text is lost), the number
 * may be anywhere on the cited page, but it must still be there whole.
 */
export function amountPrintedWhole(input: {
  readonly kind: MoneyKind;
  readonly value: string;
  readonly quote: string;
  readonly page: string;
  readonly spans: readonly Span[] | 'anywhere';
}): boolean {
  const { kind, value } = input;
  const quoted = printedAmounts(input.quote).some((n) => sameAmount(kind, n.text, value));
  if (!quoted) return false;
  return printedAmounts(input.page).some(
    (n) =>
      (input.spans === 'anywhere' ||
        input.spans.some((span) => n.start < span.end && n.end > span.start)) &&
      sameAmount(kind, n.text, value),
  );
}

/** Every place `needle` occurs in `haystack`, overlapping ones included. */
export function spansOf(haystack: string, needle: string): Span[] {
  const spans: Span[] = [];
  if (needle === '') return spans;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    spans.push({ start: at, end: at + needle.length });
  }
  return spans;
}

const NUMBER_GLYPHS: Readonly<Record<string, string>> = {
  o: '0', O: '0', i: '1', I: '1', l: '1', s: '5', S: '5', b: '8', B: '8', z: '2', Z: '2', g: '6',
};

/**
 * Reads a letter OCR confuses with a digit as that digit, but only where it
 * touches a digit or a point or comma inside a number: "$6OO.OO" is $600.00,
 * and "Total" and "PO 1" keep their letters. The same pairs the quote check's
 * `ocr_confusion` tier folds, and used only there.
 */
export function foldNumberGlyphs(text: string): string {
  const touching = /(?<=[\d.,])[oOiIlsSbBzZg]|[oOiIlsSbBzZg](?=[\d.,]\d|\d)/g;
  let folded = text;
  for (let previous = ''; previous !== folded; ) {
    previous = folded;
    folded = folded.replace(touching, (glyph) => NUMBER_GLYPHS[glyph] ?? glyph);
  }
  return folded;
}
