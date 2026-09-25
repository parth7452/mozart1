/**
 * Quote verification: did the value the model reported actually appear on the
 * page it cited?
 *
 * This is the cheap, strict grounding check that a bounding box does not give
 * us. A quote that is not in the page's text is the signature of an invented
 * value, and it is caught before a human ever sees the field.
 */

import { asLaidOut, isDash, withoutInlineMarkup } from './markup';
import type { ExtractedField } from './ports';

/** Whitespace and case are presentation; everything else must match. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Compare letters and digits, for punctuation and spacing noise — keeping a
 * `.` or `,` that sits between two digits, a sign in front of or behind a
 * number, and the gap between two numbers.
 *
 * Dropping every separator made "$60,000" verify against "$600.00" and
 * "$66,000.0" against "$6,600.00": a quote a hundred times the printed amount
 * checked out. A decimal point or a thousands separator inside a number is the
 * number, not punctuation, so it stays, and a single space either side of it
 * collapses ("4, 800.00"); a line break or a table cell between them does not,
 * so a cell "$73." beside a cell "285" is not "$73.285". Every other mark still
 * goes.
 *
 * A sign is the number too. Dropping every `-` verified "-80.00" against a page
 * reading "80.00", and a credit against the debit it reverses is the opposite
 * claim, not the same one with noise. So a minus that is a sign — directly in
 * front of a number, and not joining two words or two numbers (`AP-BSC-771`,
 * `02062-2638`, `12/28/07-12/28/07`), or directly behind one at the end of a
 * word (`80.00-`, as ledgers print a credit) — stays as `-`, and every other
 * dash still goes. It runs on laid-out text, so an en dash, a minus sign and a
 * hyphen are one character by then (`withDashesAsHyphens`).
 *
 * And two numbers stay two. Dropping the space between them read "20 1" as
 * "201", and since a table's cells are spaces (`withTableCellsAsSpaces`), the
 * columns "$39" and "$175" as "$39175". Whitespace between two digits, with
 * whatever marks sit around it, becomes one space, so the numbers either side
 * of it are still apart.
 */
function alphanumeric(text: string): string {
  return numeric(text.toLowerCase());
}

const SIGN_MARK = '\uE000';
const NUMBER_GAP = '\uE001';
/** A minus in front of a number: not after a letter, a digit or another dash. */
const LEADING_SIGN = /(?<![\p{L}\p{N}-])-(?=[$€£¥]?\d)/gu;
/** A minus behind a number, ending its word: `80.00-`. */
const TRAILING_SIGN = /(?<=\d)-(?=\s|$)/g;
/**
 * Whitespace between two numbers, with whatever marks surround it (`$39 $175`,
 * `271001</td><td>$30,025.00` once the cells are spaces), up to a sign.
 */
const NUMBER_BREAK = /(\d)[^a-z0-9\uE000]*\s[^a-z0-9\uE000]*(?=\uE000|\d)/g;

/** Keeps `.`/`,` between digits, signs and the gap between numbers, and drops everything else that is not a letter or a digit. */
function numeric(lowered: string): string {
  return lowered
    .replace(/(\d)[ \t]?([.,])[ \t]?(?=\d)/g, '$1$2')
    .replace(LEADING_SIGN, SIGN_MARK)
    .replace(TRAILING_SIGN, SIGN_MARK)
    .replace(NUMBER_BREAK, `$1${NUMBER_GAP}`)
    .replace(/[^a-z0-9.,\uE000\uE001]/g, '')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, '')
    .replaceAll(SIGN_MARK, '-')
    .replaceAll(NUMBER_GAP, ' ');
}

/**
 * Collapses the glyph pairs OCR confuses, so a value read correctly from the
 * image still verifies against a transcription that misread a character.
 *
 * Deliberately narrow: only pairs that are visually near-identical in print. A
 * hallucinated value differs in far more than one glyph class, so this loosens
 * the check against OCR noise without loosening it against invention. Matches
 * found this way are reported as `ocr_confusion`, never as an exact match.
 *
 * Folded before the number's punctuation is judged, so an amount OCR read as
 * "6OO.OO" keeps its decimal point once its letters are digits. And it runs on
 * text whose column rules are already `|` (`withColumnRules`), so a rule read
 * as a lone `I` is dropped as punctuation rather than folded into a `1` — which
 * had verified an invented "Qty 201" against a page reading "Qty 20 I".
 */
function glyphFolded(text: string): string {
  return numeric(
    text
      .toLowerCase()
      .replace(/[o]/g, '0')
      .replace(/[il]/g, '1')
      .replace(/[s]/g, '5')
      .replace(/[b]/g, '8')
      .replace(/[z]/g, '2')
      .replace(/[g]/g, '6'),
  );
}

const DIGIT = /\d/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const CURRENCY = /[$€£¥]/;

/**
 * Whether `needle` occurs in `haystack` without losing a sign.
 *
 * `includes` alone is a substring test, and "80.00" is inside "-80.00", which
 * is a credit rather than a charge. So an occurrence counts only where
 *
 * - a quote that begins with a digit or a currency sign does not sit right
 *   after a minus sign, and
 * - a quote that ends with a digit is not followed by a minus sign that ends
 *   the word (`80.00-`, as ledgers print a credit).
 *
 * Only the sign. A quote may still begin or end inside a longer number, as it
 * always could — "$6,600" verifies against "$6,600.00", and a text layer that
 * glues a quantity onto the next word ("81,4-Dioxane" for "8" and
 * "1,4-Dioxane") still verifies both — because refusing a digit next to a digit
 * refused right quotes on real pages, and that is a different change.
 *
 * `signs` says how a minus is spelled in `haystack`: in page text (`'page'`) a
 * dash is a sign only when nothing word-like is glued to its front, and in the
 * letters-and-digits form (`'marked'`) every `-` left is one, because
 * `numeric` has already dropped every dash that is not.
 *
 * An empty needle matches nothing: a quote that is all punctuation says
 * nothing a page can confirm.
 */
function occursWithItsSign(haystack: string, needle: string, signs: 'page' | 'marked'): boolean {
  if (needle === '') return false;
  const isLeadingSign = (at: number): boolean => {
    const char = haystack[at];
    if (signs === 'marked') return char === '-';
    if (!isDash(char)) return false;
    const before = haystack[at - 1];
    return before === undefined || !(WORD_CHAR.test(before) || isDash(before));
  };
  const isTrailingSign = (at: number): boolean => {
    const char = haystack[at];
    if (signs === 'marked') return char === '-';
    if (!isDash(char)) return false;
    const after = haystack[at + 1];
    return after === undefined || /\s/.test(after);
  };
  const first = needle[0] as string;
  const last = needle[needle.length - 1] as string;
  const opensWithNumber = DIGIT.test(first) || CURRENCY.test(first);
  const closesWithNumber = DIGIT.test(last);

  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (opensWithNumber && at > 0 && isLeadingSign(at - 1)) continue;
    const end = at + needle.length;
    if (closesWithNumber && end < haystack.length && isTrailingSign(end)) continue;
    return true;
  }
  return false;
}

export type QuoteMatch = 'exact' | 'separator' | 'punctuation' | 'ocr_confusion';

export interface QuoteCheck {
  readonly verified: boolean | null;
  readonly matchedBy?: QuoteMatch;
  readonly reason?: string;
  /**
   * The page the quote was found on, when that is not the page it cited: set
   * only when the cited page does not exist and exactly one page that does
   * holds the quote. Absent on every other answer.
   */
  readonly foundOnPage?: number;
}

/** One page's answer: the tier that found the quote, or nothing. */
function matchOnPage(
  quote: string,
  page: string,
): { readonly matchedBy: QuoteMatch; readonly reason?: string } | undefined {
  // Bold is presentation too, and so is `&amp;`. The Reducto adapter already
  // removes both from every text layer it writes; the check does it again
  // because a page stored before it did is read back by any later read of that
  // document, and because a tag's letters are not neutral here: the glyph fold
  // reads the `b` of `<b>` as an `8`, which verified an invented "$84,800.00"
  // against a bold "$4,800.00".
  const unmarked = withoutInlineMarkup(page);
  const quotedUnmarked = withoutInlineMarkup(quote);
  if (occursWithItsSign(normalise(unmarked), normalise(quotedUnmarked), 'page')) {
    return { matchedBy: 'exact' };
  }
  // Layout next, and every tier after this one reads the text as laid out
  // (`asLaidOut`): a column rule is one glyph, however it was drawn, and
  // neither a letter to match nor a `1` to fold; a table's cell and row
  // boundaries are the spaces they print as, so a row quoted as it reads
  // matches a table OCR wrote as HTML; and every dash is a hyphen.
  const onPage = asLaidOut(unmarked);
  const quoted = asLaidOut(quotedUnmarked);
  if (occursWithItsSign(normalise(onPage), normalise(quoted), 'page')) {
    return {
      matchedBy: 'separator',
      reason:
        'matched once the layout was read as spacing: column rules (|, I, l) as one glyph, ' +
        'table cells as spaces, and every dash as a hyphen',
    };
  }
  if (occursWithItsSign(alphanumeric(onPage), alphanumeric(quoted), 'marked')) {
    return { matchedBy: 'punctuation', reason: 'matched ignoring punctuation' };
  }
  if (occursWithItsSign(glyphFolded(onPage), glyphFolded(quoted), 'marked')) {
    return {
      matchedBy: 'ocr_confusion',
      reason: 'matched only after allowing for glyphs OCR confuses (O/0, I/1, S/5)',
    };
  }
  return undefined;
}

/**
 * Checks one quote against a page's text. Returns null — not false — when there
 * is no text layer for that page: an unverifiable quote and a false quote are
 * different facts, and treating a scan as a failed check would block every
 * scanned document.
 *
 * A quote cited to a page the document does not have is looked for on the
 * pages it does have, with the same tiers, and verifies only when exactly one
 * of them holds it; the answer then names that page (`foundOnPage`). A page
 * out of range is a citation that cannot be right, so where the quote came
 * from is a question with at most one honest answer, and a quote two pages
 * hold has none. A page that exists is never second-guessed: a quote cited to
 * the wrong one fails, as it always has, because that is the citation the
 * model made and the one a reviewer would follow.
 */
export function checkQuote(
  quote: string,
  sourcePage: number,
  pageText: readonly string[] | undefined,
): QuoteCheck {
  if (pageText === undefined || pageText.length === 0) {
    return { verified: null, reason: 'no text layer' };
  }
  const page = Number.isInteger(sourcePage) ? pageText[sourcePage - 1] : undefined;
  if (page !== undefined) {
    const match = matchOnPage(quote, page);
    if (match === undefined) {
      return { verified: false, reason: 'quote not found on the cited page' };
    }
    return { verified: true, ...match };
  }

  const holding = pageText.flatMap((text, index) => {
    const match = matchOnPage(quote, text);
    return match === undefined ? [] : [{ page: index + 1, match }];
  });
  const [only] = holding;
  const pages = pageText.length === 1 ? 'one page' : `${pageText.length} pages`;
  if (holding.length === 1 && only !== undefined) {
    return {
      verified: true,
      matchedBy: only.match.matchedBy,
      foundOnPage: only.page,
      reason:
        `cited page ${sourcePage} does not exist (the document has ${pages}); ` +
        `the quote is on page ${only.page} and no other` +
        (only.match.reason === undefined ? '' : `, ${only.match.reason}`),
    };
  }
  if (holding.length > 1) {
    return {
      verified: false,
      reason:
        `cited page ${sourcePage} does not exist, and the quote is on pages ` +
        `${holding.map((h) => h.page).join(', ')}, so which one it came from would be a guess`,
    };
  }
  return {
    verified: false,
    reason: `cited page ${sourcePage} does not exist, and the quote is on none of the ${pages} that do`,
  };
}

/**
 * Checks every field's quote. A field cited to a page the document does not
 * have, whose quote is on exactly one page that it does, is attributed to that
 * page — `sourcePage` is where the quote is, which is what a reviewer, a box
 * and the stored row need — and keeps the model's own citation as `citedPage`,
 * so the correction is in the field rather than assumed away.
 */
export function verifyQuotes(
  fields: readonly ExtractedField[],
  pageText: readonly string[] | undefined,
): ExtractedField[] {
  return fields.map((field) => {
    const check = checkQuote(field.sourceQuote, field.sourcePage, pageText);
    const moved = check.foundOnPage !== undefined && check.foundOnPage !== field.sourcePage;
    return {
      ...field,
      quoteVerified: check.verified,
      ...(check.matchedBy !== undefined ? { quoteMatch: check.matchedBy } : {}),
      ...(moved ? { sourcePage: check.foundOnPage, citedPage: field.sourcePage } : {}),
    };
  });
}

/** Fields whose quote was checked and not found. These are the dangerous ones. */
export function ungroundedFields(fields: readonly ExtractedField[]): ExtractedField[] {
  return fields.filter((f) => f.quoteVerified === false);
}

export interface GroundingReport {
  readonly total: number;
  readonly verified: number;
  readonly unverifiable: number;
  readonly ungrounded: number;
  /** Share of *checkable* fields that checked out. Null when nothing was checkable. */
  readonly groundedRate: number | null;
  readonly lowestConfidence: number | null;
  /** Verified only by folding OCR glyph confusions — worth showing a reviewer. */
  readonly matchedThroughOcrNoise: number;
  /** Cited a page the document does not have, and found on exactly one it does (`citedPage`). */
  readonly pageCorrected: number;
}

export function groundingReport(fields: readonly ExtractedField[]): GroundingReport {
  const verified = fields.filter((f) => f.quoteVerified === true).length;
  const ungrounded = fields.filter((f) => f.quoteVerified === false).length;
  const unverifiable = fields.filter((f) => f.quoteVerified === null).length;
  const checkable = verified + ungrounded;
  const confidences = fields.map((f) => f.confidence);
  return {
    total: fields.length,
    verified,
    unverifiable,
    ungrounded,
    groundedRate: checkable === 0 ? null : verified / checkable,
    lowestConfidence: confidences.length === 0 ? null : Math.min(...confidences),
    matchedThroughOcrNoise: fields.filter((f) => f.quoteMatch === 'ocr_confusion').length,
    pageCorrected: fields.filter((f) => f.citedPage !== undefined).length,
  };
}
