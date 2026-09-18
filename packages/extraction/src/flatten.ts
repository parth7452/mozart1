/**
 * Flattens a validated extraction into one row per field, which is how
 * `extraction_results` stores it — a reviewer inspects fields, not a blob.
 */

import type { ExtractedField } from './ports';

interface RawField {
  value: unknown;
  confidence: unknown;
  source_page: unknown;
  source_quote: unknown;
  source_bbox: unknown;
}

function isFieldObject(value: unknown): value is RawField {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    'value' in candidate &&
    'confidence' in candidate &&
    'source_page' in candidate &&
    'source_quote' in candidate
  );
}

function normaliseBbox(raw: unknown): readonly number[] | null {
  if (!Array.isArray(raw)) return null;
  const numbers = raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (numbers.length !== 4) return null;
  const [x0, y0, x1, y1] = numbers as [number, number, number, number];
  // A box outside the page, or inverted, is a box we do not trust. Drop it
  // rather than store something the UI would draw in the wrong place.
  if ([x0, y0, x1, y1].some((n) => n < 0 || n > 1)) return null;
  if (x1 < x0 || y1 < y0) return null;
  return [x0, y0, x1, y1];
}

function clampConfidence(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Walks the extraction object. Nulls are skipped: "this field is not on the
 * document" is recorded by the field's absence from `extraction_results`, not by
 * a row with no provenance.
 */
export function flattenExtraction(document: unknown): ExtractedField[] {
  const out: ExtractedField[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (isFieldObject(node)) {
      const page = typeof node.source_page === 'number' ? Math.trunc(node.source_page) : 0;
      const quote = typeof node.source_quote === 'string' ? node.source_quote.trim() : '';
      // Provenance is not optional: without a page and a quote there is nothing
      // for a reviewer to check, so the value does not become a field row.
      if (page < 1 || quote === '') return;
      out.push({
        fieldPath: path,
        value: node.value,
        confidence: clampConfidence(node.confidence),
        sourcePage: page,
        sourceQuote: quote.slice(0, 2000),
        sourceBbox: normaliseBbox(node.source_bbox),
        quoteVerified: null,
      });
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, path === '' ? key : `${path}.${key}`);
      }
    }
  };

  walk(document, '');
  return out;
}
