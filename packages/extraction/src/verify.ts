/**
 * Quote verification: did the value the model reported actually appear on the
 * page it cited?
 *
 * This is the cheap, strict grounding check that a bounding box does not give
 * us. A quote that is not in the page's text is the signature of an invented
 * value, and it is caught before a human ever sees the field.
 */

import { withColumnRules, withoutInlineMarkup, withTableCellsAsSpace } from './markup';
import type { ExtractedField } from './ports';

/** Whitespace and case are presentation; everything else must match. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Compare letters and digits, for punctuation and spacing noise — keeping a
 * `.` or `,` that sits between two digits, and a gap between two numbers.
 *
 * Dropping every separator made "$60,000" verify against "$600.00" and
 * "$66,000.0" against "$6,600.00": a quote a hundred times the printed amount
 * checked out. A decimal point or a thousands separator inside a number is the
 * number, not punctuation, so it stays (spaces around it collapse); every
 * other mark still goes.
 *
 * Dropping every space did the same thing one step over: "Qty 2 $448.00" read
 * as `qty2448.00`, so an invented "$2,448.00" — or "Qty 201" against
 * "Qty 20 | 1" — checked out. Two numbers with anything but a decimal point
 * or a thousands separator between them are two numbers, so a gap between two
 * digits stays one space. Between letters, or a letter and a digit, spacing is
 * still noise: "ES-260901" and "ES 260901" read the same.
 */
function alphanumeric(text: string): string {
  return numeric(text.toLowerCase());
}

/**
 * Keeps `.`/`,` between digits and one space between two numbers, and drops
 * everything else that is not a letter or a digit.
 */
function numeric(lowered: string): string {
  return lowered
    .replace(/(\d)\s*([.,])\s*(?=\d)/g, '$1$2')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
    .replace(/[^a-z0-9.,]+/g, ' ')
    .replace(/(?<!\d) | (?!\d)/g, '');
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
 * had verified an invented "Qty 201" against a page reading "Qty 20 I". A gap
 * between two numbers survives the fold too (`numeric`), so "Qty 20 S" no
 * longer verifies an invented "Qty 205".
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
   * Set only when the cited page is past the last page of the text layer and
   * the quote was found on exactly one page that is in it: that page.
   * `verifyQuotes` stores it as the field's `sourcePage` and keeps the model's
   * number as `citedPage`.
   */
  readonly foundOnPage?: number;
}

/**
 * One text in each form a tier compares, worked out once.
 *
 * A form that comes out empty matches nothing. `"".includes` is true of every
 * page, so a quote of nothing but punctuation ("—") verified at the
 * punctuation tier, one of nothing but formatting (`<b></b>`) at the exact
 * tier, and one of nothing but table cells (`</td><td>`) at the separator
 * tier — against any page with any words on it.
 */
interface Forms {
  readonly exact: string;
  readonly separated: string;
  readonly alphanumeric: string;
  readonly folded: string;
}

function formsOf(text: string): Forms {
  // Bold is presentation too, and so is `&amp;`. The Reducto adapter already
  // removes both from every text layer it writes; the check does it again
  // because a page stored before it did is read back by any later read of that
  // document, and because a tag's letters are not neutral here: the glyph fold
  // reads the `b` of `<b>` as an `8`, which verified an invented "$84,800.00"
  // against a bold "$4,800.00". Removing markup tightens the check.
  //
  // Separators next, and every tier after the exact one reads the text with
  // them settled: a column rule is one glyph, so a rule drawn as `I` is neither
  // a letter to match nor a `1` to fold (`withColumnRules`); and a table cell's
  // edge is a space, so a row quoted as the page shows it matches the cells
  // Reducto wrote as HTML (`withTableCellsAsSpace`). The cells go before the
  // entities are decoded, so a page printing "&lt;td&gt;" keeps it as text.
  const separated = withColumnRules(withoutInlineMarkup(withTableCellsAsSpace(text)));
  return {
    exact: normalise(withoutInlineMarkup(text)),
    separated: normalise(separated),
    alphanumeric: alphanumeric(separated),
    folded: glyphFolded(separated),
  };
}

const holds = (page: string, quoted: string) => quoted !== '' && page.includes(quoted);

/** The tiers, in order, against one page. Undefined when none matches. */
function matchOnPage(quote: Forms, page: Forms): QuoteCheck | undefined {
  if (holds(page.exact, quote.exact)) {
    return { verified: true, matchedBy: 'exact' };
  }
  if (holds(page.separated, quote.separated)) {
    return {
      verified: true,
      matchedBy: 'separator',
      reason: 'matched once each column rule was read as one glyph (|, I, l) and each table cell edge as a space',
    };
  }
  if (holds(page.alphanumeric, quote.alphanumeric)) {
    return { verified: true, matchedBy: 'punctuation', reason: 'matched ignoring punctuation' };
  }
  if (holds(page.folded, quote.folded)) {
    return {
      verified: true,
      matchedBy: 'ocr_confusion',
      reason: 'matched only after allowing for glyphs OCR confuses (O/0, I/1, S/5)',
    };
  }
  return undefined;
}

/** A text layer whose pages are put into their forms the first time a check needs them. */
function pagesOf(pageText: readonly string[]): (index: number) => Forms {
  const forms = new Map<number, Forms>();
  return (index) => {
    const known = forms.get(index);
    if (known !== undefined) return known;
    const made = formsOf(pageText[index] as string);
    forms.set(index, made);
    return made;
  };
}

/**
 * Checks one quote against a page's text. Returns null — not false — when there
 * is no text layer for that page: an unverifiable quote and a false quote are
 * different facts, and treating a scan as a failed check would block every
 * scanned document.
 *
 * `pageText[i]` is page `i + 1` (`textByPage`), so a page with no text is `''`
 * and never shifts the pages after it.
 *
 * A quote cited to a page in the text layer is looked for there and nowhere
 * else: on the wrong page it is refused, because two pages can both print a
 * total and which one the model meant is the question. A quote cited to a page
 * *past the last one* is different. No page in the layer could have been meant,
 * so the citation is a numbering slip — Grainger's one-page scan came back
 * citing page 2 for every field, in three reads of four — and the quote is
 * looked for on every page there is. It is accepted only when exactly one page
 * holds it, which becomes `foundOnPage`; on none, or on several, it is refused
 * as before.
 */
export function checkQuote(
  quote: string,
  sourcePage: number,
  pageText: readonly string[] | undefined,
): QuoteCheck {
  if (pageText === undefined || pageText.length === 0) {
    return { verified: null, reason: 'no text layer' };
  }
  return checkAgainst(formsOf(quote), sourcePage, pageText.length, pagesOf(pageText));
}

function checkAgainst(
  quote: Forms,
  sourcePage: number,
  pageCount: number,
  page: (index: number) => Forms,
): QuoteCheck {
  if (Number.isInteger(sourcePage) && sourcePage >= 1 && sourcePage <= pageCount) {
    return (
      matchOnPage(quote, page(sourcePage - 1)) ?? {
        verified: false,
        reason: 'quote not found on the cited page',
      }
    );
  }
  if (!Number.isInteger(sourcePage) || sourcePage < 1) {
    return { verified: false, reason: `cited page ${sourcePage} does not exist` };
  }
  const past = `cited page ${sourcePage} is past the last page of the text layer (${pageCount})`;
  const holding: { readonly page: number; readonly match: QuoteCheck }[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const match = matchOnPage(quote, page(index));
    if (match !== undefined) holding.push({ page: index + 1, match });
  }
  const [only] = holding;
  if (holding.length === 1 && only !== undefined) {
    const found = `${past}; found on page ${only.page} and no other`;
    return {
      ...only.match,
      foundOnPage: only.page,
      reason: only.match.reason === undefined ? found : `${found}, ${only.match.reason}`,
    };
  }
  if (holding.length === 0) {
    return { verified: false, reason: `${past}, and the quote is on none of its pages` };
  }
  return {
    verified: false,
    reason: `${past}, and the quote is on pages ${holding.map((h) => h.page).join(', ')}: which one was meant is not ours to guess`,
  };
}

/**
 * Checks every field's quote. A field cited to a page past the end of the text
 * layer and found on exactly one page in it is *moved* there: `sourcePage`
 * becomes the page that holds the quote, and the model's number is kept as
 * `citedPage` rather than dropped.
 *
 * Moved rather than only marked, because `sourcePage` is what everything after
 * this follows — the reviewer's page, the OCR box (`locateQuote` looks on that
 * page), a packet's citation, and in a post-audit the stored page an auditor
 * is sent to. Page 2 of a one-page file sends every one of them nowhere. The
 * page it now names is not the model's word for it: it is the one page this
 * check found the quote on, which anyone can find again from the stored text.
 * The model's own number stays on the field, and `buildExtractionResult` writes
 * it into the extraction's `model_calls` row, so the correction is on the
 * record rather than silent.
 */
export function verifyQuotes(
  fields: readonly ExtractedField[],
  pageText: readonly string[] | undefined,
): ExtractedField[] {
  const page = pageText === undefined ? undefined : pagesOf(pageText);
  return fields.map((field) => {
    const check =
      pageText === undefined || pageText.length === 0 || page === undefined
        ? checkQuote(field.sourceQuote, field.sourcePage, pageText)
        : checkAgainst(formsOf(field.sourceQuote), field.sourcePage, pageText.length, page);
    return {
      ...field,
      ...(check.foundOnPage !== undefined
        ? { sourcePage: check.foundOnPage, citedPage: field.sourcePage }
        : {}),
      quoteVerified: check.verified,
      ...(check.matchedBy !== undefined ? { quoteMatch: check.matchedBy } : {}),
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
  /** Cited a page past the end of the text layer, and found on the one page that holds it. */
  readonly citedPageMissing: number;
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
    citedPageMissing: fields.filter((f) => f.citedPage !== undefined).length,
  };
}
