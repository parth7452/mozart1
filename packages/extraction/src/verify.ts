/**
 * Quote verification: did the value the model reported actually appear on the
 * page it cited?
 *
 * This is the cheap, strict grounding check that a bounding box does not give
 * us. A quote that is not in the page's text is the signature of an invented
 * value, and it is caught before a human ever sees the field.
 */

import type { ExtractedField } from './ports';

/** Whitespace and case are presentation; everything else must match. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Compare only letters and digits, for punctuation and spacing noise. */
function alphanumeric(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Collapses the glyph pairs OCR confuses, so a value read correctly from the
 * image still verifies against a transcription that misread a character.
 *
 * Deliberately narrow: only pairs that are visually near-identical in print. A
 * hallucinated value differs in far more than one glyph class, so this loosens
 * the check against OCR noise without loosening it against invention. Matches
 * found this way are reported as `ocr_confusion`, never as an exact match.
 */
function glyphFolded(text: string): string {
  return alphanumeric(text)
    .replace(/[o]/g, '0')
    .replace(/[il]/g, '1')
    .replace(/[s]/g, '5')
    .replace(/[b]/g, '8')
    .replace(/[z]/g, '2')
    .replace(/[g]/g, '6');
}

export interface QuoteCheck {
  readonly verified: boolean | null;
  readonly matchedBy?: 'exact' | 'punctuation' | 'ocr_confusion';
  readonly reason?: string;
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
): QuoteCheck {
  if (pageText === undefined || pageText.length === 0) {
    return { verified: null, reason: 'no text layer' };
  }
  const page = pageText[sourcePage - 1];
  if (page === undefined) {
    return { verified: false, reason: `cited page ${sourcePage} does not exist` };
  }
  if (normalise(page).includes(normalise(quote))) return { verified: true, matchedBy: 'exact' };
  if (alphanumeric(page).includes(alphanumeric(quote))) {
    return { verified: true, matchedBy: 'punctuation', reason: 'matched ignoring punctuation' };
  }
  if (glyphFolded(page).includes(glyphFolded(quote))) {
    return {
      verified: true,
      matchedBy: 'ocr_confusion',
      reason: 'matched only after allowing for glyphs OCR confuses (O/0, I/1, S/5)',
    };
  }
  return { verified: false, reason: 'quote not found on the cited page' };
}

export function verifyQuotes(
  fields: readonly ExtractedField[],
  pageText: readonly string[] | undefined,
): ExtractedField[] {
  return fields.map((field) => {
    const check = checkQuote(field.sourceQuote, field.sourcePage, pageText);
    return {
      ...field,
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
