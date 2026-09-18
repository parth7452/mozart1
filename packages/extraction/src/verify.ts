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

/** Last resort: compare only letters and digits, for OCR punctuation noise. */
function alphanumeric(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface QuoteCheck {
  readonly verified: boolean | null;
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
  if (normalise(page).includes(normalise(quote))) return { verified: true };
  if (alphanumeric(page).includes(alphanumeric(quote))) {
    return { verified: true, reason: 'matched ignoring punctuation' };
  }
  return { verified: false, reason: 'quote not found on the cited page' };
}

export function verifyQuotes(
  fields: readonly ExtractedField[],
  pageText: readonly string[] | undefined,
): ExtractedField[] {
  return fields.map((field) => ({
    ...field,
    quoteVerified: checkQuote(field.sourceQuote, field.sourcePage, pageText).verified,
  }));
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
  };
}
