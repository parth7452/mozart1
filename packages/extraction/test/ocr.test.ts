import { describe, expect, it } from 'vitest';
import { locateQuote, type OcrBlock } from '../src/ocr';
import { checkQuote, groundingReport, verifyQuotes } from '../src/verify';
import { flattenExtraction } from '../src/flatten';
import { buildReadContent } from '../src/prompt';
import type { DocumentPayload } from '../src/ports';

const block = (
  text: string,
  bbox: [number, number, number, number],
  page = 1,
): OcrBlock => ({ text, page, bbox, kind: 'Text', confidence: 0.9 });

describe('placing a quote on the page', () => {
  const blocks = [
    block('Notice: DN-2609-001\nReason code: SHORT', [0.05, 0.08, 0.36, 0.37]),
    block('Deduction: $600.00', [0.05, 0.45, 0.4, 0.48]),
    block('RECEIVED', [0.73, 0.15, 0.89, 0.22]),
  ];

  it('gives a field the box of the block its quote came from', () => {
    expect(locateQuote('Deduction: $600.00', 1, blocks)?.bbox).toEqual([0.05, 0.45, 0.4, 0.48]);
  });

  it('matches regardless of whitespace and case', () => {
    expect(locateQuote('reason   code: short', 1, blocks)).toBeDefined();
  });

  it('gives no box when the quote is on another page', () => {
    expect(locateQuote('Deduction: $600.00', 2, blocks)).toBeUndefined();
  });

  it('gives no box for a quote no block contains', () => {
    expect(locateQuote('Deduction: $9,999.00', 1, blocks)).toBeUndefined();
  });

  it('prefers the tighter block when one clearly encloses the value', () => {
    const nested = [
      block('page header and Deduction: $600.00 and much more text besides', [0, 0, 1, 1]),
      block('Deduction: $600.00', [0.05, 0.45, 0.4, 0.48]),
    ];
    expect(locateQuote('Deduction: $600.00', 1, nested)?.bbox).toEqual([0.05, 0.45, 0.4, 0.48]);
  });

  it('gives no box when two blocks are equally plausible', () => {
    // A reviewer follows a box to decide whether to approve, so an ambiguous
    // box is worse than none.
    const duplicated = [
      block('Deduction: $600.00', [0.05, 0.45, 0.4, 0.48]),
      block('Deduction: $600.00', [0.05, 0.8, 0.4, 0.83]),
    ];
    expect(locateQuote('Deduction: $600.00', 1, duplicated)).toBeUndefined();
  });

  it('ignores an empty quote', () => {
    expect(locateQuote('   ', 1, blocks)).toBeUndefined();
  });
});

describe('verifying a quote against OCR text', () => {
  // Reducto read the letter O in this PO number as a zero.
  const ocrPage = ['Purchase order: P0-PRD-3356\nInvoice: INV-260806'];

  it('still verifies a value read correctly from the image', () => {
    const check = checkQuote('Purchase order: PO-PRD-3356', 1, ocrPage);
    expect(check.verified).toBe(true);
    expect(check.matchedBy).toBe('ocr_confusion');
    expect(check.reason).toMatch(/glyphs OCR confuses/);
  });

  it('reports an exact match as exact, not as OCR noise', () => {
    expect(checkQuote('Invoice: INV-260806', 1, ocrPage).matchedBy).toBe('exact');
  });

  it('still catches a value that is simply not on the page', () => {
    // Folding glyph confusions must not turn into "anything matches".
    expect(checkQuote('Purchase order: XX-QQQ-9999', 1, ocrPage).verified).toBe(false);
    expect(checkQuote('Invoice: INV-999999', 1, ocrPage).verified).toBe(false);
  });

  it('counts how many fields leaned on OCR tolerance', () => {
    const fields = verifyQuotes(
      flattenExtraction({
        po: { value: 'PO-PRD-3356', confidence: 0.9, source_page: 1, source_quote: 'Purchase order: PO-PRD-3356', source_bbox: null },
        inv: { value: 'INV-260806', confidence: 0.9, source_page: 1, source_quote: 'Invoice: INV-260806', source_bbox: null },
      }),
      ocrPage,
    );
    const report = groundingReport(fields);
    expect(report.verified).toBe(2);
    expect(report.matchedThroughOcrNoise).toBe(1);
  });

  it('catches an unfaithful citation even when the value is right', () => {
    // Measured on a real scan: the model extracted qty_invoiced 400 correctly
    // but cited it to "400 of 400 cases" when the page reads "380 of 400".
    const page = ['Customer reports receiving 380 of 400 cases of Citrus Sparkling Water'];
    expect(checkQuote('400 of 400 cases', 1, page).verified).toBe(false);
  });
});

describe('what each reader is shown', () => {
  const payload: DocumentPayload = {
    documentId: 'd1',
    orgId: 'o1',
    filename: 'scan.jpg',
    mimeType: 'image/jpeg',
    base64: '/9j/4AAQ',
    byteSize: 6,
    pageText: ['Purchase order: P0-PRD-3356'],
    pageTextSource: 'ocr',
  };

  const hasTextLayer = (blocks: Array<Record<string, unknown>>) =>
    blocks.some((b) => b.type === 'text' && String(b.text).includes('untrusted_document'));

  it('withholds an OCR transcription from the extractor', () => {
    // The model anchors on it and inherits its character errors.
    expect(hasTextLayer(buildReadContent(payload, 'Extract.', { includeTextLayer: false }))).toBe(
      false,
    );
  });

  it('shows it to the classifier, where it disambiguates the document type', () => {
    const blocks = buildReadContent(payload, 'Classify.');
    expect(hasTextLayer(blocks)).toBe(true);
    expect(String(blocks.find((b) => b.type === 'text')?.text)).toMatch(/IMAGE IS AUTHORITATIVE/);
  });

  it('labels an embedded text layer differently from a transcription', () => {
    const embedded = buildReadContent(
      { ...payload, pageTextSource: 'embedded' },
      'Extract.',
    );
    expect(String(embedded.find((b) => b.type === 'text')?.text)).toMatch(/own text layer/);
  });
});
