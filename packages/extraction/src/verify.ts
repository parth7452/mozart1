/**
 * Quote verification: did the value the model reported actually appear on the
 * page it cited?
 *
 * This is the cheap, strict grounding check that a bounding box does not give
 * us. A quote that is not in the page's text is the signature of an invented
 * value, and it is caught before a human ever sees the field.
 */

import {
  amountPrintedWhole,
  foldNumberGlyphs,
  moneyKindOf, readsAsMoney, spansOf, type MoneyKind, type Span } from './amounts';
import { withColumnRules, withoutInlineMarkup } from './markup';
import type { ExtractedField } from './ports';

/** Whitespace and case are presentation; everything else must match. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Compare letters and digits, for punctuation and spacing noise — keeping a
 * `.` or `,` that sits between two digits.
 *
 * Dropping every separator made "$60,000" verify against "$600.00" and
 * "$66,000.0" against "$6,600.00": a quote a hundred times the printed amount
 * checked out. A decimal point or a thousands separator inside a number is the
 * number, not punctuation, so it stays (spaces around it collapse); every
 * other mark still goes.
 */
function alphanumeric(text: string): string {
  return numeric(text.toLowerCase());
}

/** Keeps `.`/`,` between digits and drops everything else that is not a letter or a digit. */
function numeric(lowered: string): string {
  return lowered
    .replace(/(\d)\s*([.,])\s*(?=\d)/g, '$1$2')
    .replace(/[^a-z0-9.,]/g, '')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, '');
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

export interface QuoteCheck {
  readonly verified: boolean | null;
  readonly matchedBy?: 'exact' | 'separator' | 'punctuation' | 'ocr_confusion';
  readonly reason?: string;
  /**
   * For a money field whose value reads as money: whether the page prints that
   * amount whole, to the cent, where it was quoted (ADR 0050). Absent for any
   * other field, and when there was no text to check against.
   */
  readonly amountPrintedWhole?: boolean;
}

/** The value a money field reports, for `checkQuote` to find on the page. */
export interface MoneyToFind {
  readonly kind: MoneyKind;
  readonly value: string;
}

/**
 * Checks one quote against a page's text. Returns null — not false — when there
 * is no text layer for that page: an unverifiable quote and a false quote are
 * different facts, and treating a scan as a failed check would block every
 * scanned document.
 */
export function checkQuote(
  quote: string,
  sourcePage: number,
  pageText: readonly string[] | undefined,
  money?: MoneyToFind,
): QuoteCheck {
  if (pageText === undefined || pageText.length === 0) {
    return { verified: null, reason: 'no text layer' };
  }
  const page = pageText[sourcePage - 1];
  if (page === undefined) {
    return { verified: false, reason: `cited page ${sourcePage} does not exist` };
  }
  // Bold is presentation too, and so is `&amp;`. The Reducto adapter already
  // removes both from every text layer it writes; the check does it again
  // because a page stored before it did is read back by any later read of that
  // document, and because a tag's letters are not neutral here: the glyph fold
  // reads the `b` of `<b>` as an `8`, which verified an invented "$84,800.00"
  // against a bold "$4,800.00". Removing markup tightens the check; it is the
  // only thing this adds, and every tier below is unchanged.
  const unmarked = withoutInlineMarkup(page);
  const quotedUnmarked = withoutInlineMarkup(quote);
  // A money field must also find its amount there, whole and to the cent
  // (ADR 0050): the quote being on the page is not enough when the quote is
  // only a label, or stops short of the number the page prints.
  const found = (
    matchedBy: NonNullable<QuoteCheck['matchedBy']>,
    pageAsMatched: string,
    quoteAsMatched: string,
    positioned: boolean,
    reason?: string,
  ): QuoteCheck => {
    const matched: QuoteCheck = { verified: true, matchedBy, ...(reason === undefined ? {} : { reason }) };
    // A value with no digit in it ("-" on a line with no deduction) is not a
    // number, so there is no amount to find; its quote stands as it is.
    if (money === undefined || !/\d/.test(money.value)) return matched;
    // A number we cannot read to the cent ("$1,234.5") cannot be identical to
    // the cent to anything on the page.
    if (!readsAsMoney(money.kind, money.value)) {
      return {
        verified: false,
        amountPrintedWhole: false,
        reason: `the quote is on the page, but ${JSON.stringify(money.value)} cannot be read to the cent`,
      };
    }
    const spans: readonly Span[] | 'anywhere' = positioned
      ? spansOf(pageAsMatched, quoteAsMatched)
      : 'anywhere';
    if (
      amountPrintedWhole({
        kind: money.kind,
        value: money.value,
        quote: quoteAsMatched,
        page: pageAsMatched,
        spans,
      })
    ) {
      return { ...matched, amountPrintedWhole: true };
    }
    return {
      verified: false,
      amountPrintedWhole: false,
      reason:
        `the quote is on the page, but ${JSON.stringify(money.value)} is not printed there ` +
        'whole, to the cent',
    };
  };
  if (normalise(unmarked).includes(normalise(quotedUnmarked))) {
    return found('exact', normalise(unmarked), normalise(quotedUnmarked), true);
  }
  // Column rules next, and every tier after this one reads the text with its
  // rules made one glyph: a rule drawn as `I` is neither a letter to match nor
  // a `1` to fold (`withColumnRules`).
  const onPage = withColumnRules(unmarked);
  const quoted = withColumnRules(quotedUnmarked);
  if (normalise(onPage).includes(normalise(quoted))) {
    return found(
      'separator',
      normalise(onPage),
      normalise(quoted),
      true,
      'matched once each column rule was read as one glyph (|, I, l)',
    );
  }
  // Past this point the quote's position in the page's own text is lost, so
  // an amount may be printed anywhere on the cited page — but still whole.
  if (alphanumeric(onPage).includes(alphanumeric(quoted))) {
    return found('punctuation', normalise(onPage), normalise(quoted), false, 'matched ignoring punctuation');
  }
  if (glyphFolded(onPage).includes(glyphFolded(quoted))) {
    return found(
      'ocr_confusion',
      foldNumberGlyphs(normalise(onPage)),
      foldNumberGlyphs(normalise(quoted)),
      false,
      'matched only after allowing for glyphs OCR confuses (O/0, I/1, S/5)',
    );
  }
  return { verified: false, reason: 'quote not found on the cited page' };
}

export function verifyQuotes(
  fields: readonly ExtractedField[],
  pageText: readonly string[] | undefined,
): ExtractedField[] {
  return fields.map((field) => {
    const kind = moneyKindOf(field.fieldPath);
    const money =
      kind !== undefined && typeof field.value === 'string' ? { kind, value: field.value } : undefined;
    const check = checkQuote(field.sourceQuote, field.sourcePage, pageText, money);
    return {
      ...field,
      quoteVerified: check.verified,
      ...(check.verified === true && check.matchedBy !== undefined
        ? { quoteMatch: check.matchedBy }
        : {}),
      ...(check.amountPrintedWhole !== undefined
        ? { amountPrintedWhole: check.amountPrintedWhole }
        : {}),
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
  };
}
