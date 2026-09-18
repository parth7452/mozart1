/**
 * OCR and layout, behind a port.
 *
 * A scan arrives as pixels: no text layer, so the quote check that catches an
 * invented value cannot run, and every field comes back unverifiable. An OCR
 * provider gives the document a text layer and, with it, that check back
 * (ADR 0009).
 *
 * OCR output is document content. It is untrusted, it goes through the same
 * quarantine wrapper as any other text layer, and the reader model that receives
 * it still has no tools.
 */

import type { DocumentPayload, ModelCallRecord } from './ports';

/** A laid-out region of a page. Boxes are normalised [x0, y0, x1, y1] in 0..1. */
export interface OcrBlock {
  readonly text: string;
  readonly page: number;
  readonly bbox: readonly [number, number, number, number];
  readonly kind: string;
  /** The provider's own confidence in this block, 0..1, when it reports one. */
  readonly confidence: number | null;
}

export interface OcrPage {
  readonly page: number;
  readonly text: string;
}

export interface OcrResult {
  readonly pages: readonly OcrPage[];
  readonly blocks: readonly OcrBlock[];
  readonly provider: string;
  readonly call: ModelCallRecord;
}

export interface OcrProvider {
  readonly name: string;
  ocr(document: DocumentPayload): Promise<OcrResult>;
}

export class OcrError extends Error {
  constructor(
    message: string,
    readonly call: ModelCallRecord,
  ) {
    super(message);
  }
}

/** Whitespace and case are presentation; everything else has to match. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Finds the one block a quote came from.
 *
 * Returns a box only when exactly one block on the cited page contains the
 * quote. An ambiguous match gets nothing: a reviewer follows a box to decide
 * whether to approve, so a box pointing at the wrong line is worse than no box
 * at all (ADR 0007, ADR 0009).
 */
export function locateQuote(
  quote: string,
  page: number,
  blocks: readonly OcrBlock[],
): OcrBlock | undefined {
  const needle = normalise(quote);
  if (needle === '') return undefined;

  const onPage = blocks.filter((block) => block.page === page);
  const containing = onPage.filter((block) => normalise(block.text).includes(needle));
  if (containing.length === 1) return containing[0];
  if (containing.length > 1) {
    // Several blocks contain it; the tightest one is the most specific, but only
    // if it is unambiguously tighter than the next.
    const byArea = [...containing].sort((a, b) => area(a) - area(b));
    const [smallest, next] = byArea;
    if (smallest !== undefined && next !== undefined && area(smallest) < area(next) * 0.9) {
      return smallest;
    }
  }
  return undefined;
}

function area(block: OcrBlock): number {
  const [x0, y0, x1, y1] = block.bbox;
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}
