import { describe, expect, it } from 'vitest';
import {
  acceptUpload,
  ALLOWED_MIME_TYPES,
  detectMimeType,
  inspectTiff,
  MAX_PAGES_PER_READ,
  MAX_TIFF_PAGE_PIXELS,
  RejectedUploadError,
  type RejectionCode,
} from '../src';
import { faxPage, headerOnlyTiff, realTiff } from './tiff-builders';

/**
 * The door for a TIFF (ADR 0054 §1): classic TIFF by signature, BigTIFF not at
 * all, and a page chain walked without decoding a pixel — refused when it lies
 * about its own structure or claims more pages or pixels than anyone scanned.
 */

function refusal(run: () => unknown): RejectionCode | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof RejectedUploadError) return error.code;
    throw error;
  }
  return undefined;
}

const LETTER_300DPI = { width: 2550, length: 3300 };

describe('the door and a TIFF', () => {
  it('is an allowed type', () => {
    expect(ALLOWED_MIME_TYPES).toContain('image/tiff');
  });

  it('knows a TIFF by its bytes, either byte order', () => {
    expect(detectMimeType(headerOnlyTiff([LETTER_300DPI]))).toBe('image/tiff');
    expect(detectMimeType(headerOnlyTiff([LETTER_300DPI], { bigEndian: true }))).toBe('image/tiff');
  });

  it('refuses a BigTIFF by signature', () => {
    const big = headerOnlyTiff([LETTER_300DPI]);
    big[2] = 0x2b; // II+\0
    expect(detectMimeType(big)).toBeUndefined();
    expect(refusal(() => acceptUpload(big, 'fax.tif'))).toBe('type_not_allowed');
  });

  it('accepts a real fax page and counts its pages', async () => {
    const accepted = acceptUpload(await faxPage(), 'fax.tif', { declaredMimeType: 'image/tiff' });
    expect(accepted).toMatchObject({ mimeType: 'image/tiff', pageCount: 1, warnings: [] });

    const three = await realTiff([
      { width: 120, height: 80, colour: 'red' },
      { width: 120, height: 80, colour: 'green' },
      { width: 120, height: 80, colour: 'blue' },
    ]);
    expect(acceptUpload(three, 'three.tiff').pageCount).toBe(3);
  });

  it('uses the bytes, not the claim, when a TIFF says it is a PDF', async () => {
    const accepted = acceptUpload(await faxPage(), 'notice.pdf', { declaredMimeType: 'application/pdf' });
    expect(accepted.mimeType).toBe('image/tiff');
    expect(accepted.warnings[0]).toMatch(/claimed application\/pdf but the bytes are image\/tiff/);
  });

  it('refuses a header whose page chain points outside the file', () => {
    const cut = headerOnlyTiff([LETTER_300DPI]).slice(0, 12);
    expect(refusal(() => acceptUpload(cut, 'cut.tif'))).toBe('content_does_not_match_type');

    const nowhere = headerOnlyTiff([LETTER_300DPI]);
    new DataView(nowhere.buffer).setUint32(4, 0xffff_fff0, true);
    expect(refusal(() => acceptUpload(nowhere, 'nowhere.tif'))).toBe('content_does_not_match_type');
  });

  it('refuses a page chain that loops', () => {
    const loop = headerOnlyTiff([LETTER_300DPI, LETTER_300DPI], { loop: true });
    expect(refusal(() => acceptUpload(loop, 'loop.tif'))).toBe('content_does_not_match_type');
  });

  it('refuses a page with no size', () => {
    const zero = headerOnlyTiff([{ width: 0, length: 3300 }]);
    expect(refusal(() => acceptUpload(zero, 'zero.tif'))).toBe('content_does_not_match_type');
  });

  it(`refuses more than ${MAX_PAGES_PER_READ} pages as a bomb, and takes exactly that many`, () => {
    const page = { width: 10, length: 10 };
    const most = headerOnlyTiff(Array.from({ length: MAX_PAGES_PER_READ }, () => page));
    expect(acceptUpload(most, 'long.tif').pageCount).toBe(MAX_PAGES_PER_READ);
    const over = headerOnlyTiff(Array.from({ length: MAX_PAGES_PER_READ + 1 }, () => page));
    expect(refusal(() => acceptUpload(over, 'longer.tif'))).toBe('decompression_bomb');
  });

  it('refuses a page claiming more pixels than any scan, in a file of a few hundred bytes', () => {
    const huge = headerOnlyTiff([{ width: 100_000, length: 100_000 }]);
    expect(huge.byteLength).toBeLessThan(200);
    expect(refusal(() => acceptUpload(huge, 'huge.tif'))).toBe('decompression_bomb');
    // One pixel under the page cap is a page.
    const edge = headerOnlyTiff([{ width: MAX_TIFF_PAGE_PIXELS / 10, length: 10 }]);
    expect(refusal(() => acceptUpload(edge, 'edge.tif'))).toBeUndefined();
  });

  it('refuses pages that are each fine but together are not', () => {
    const page = { width: 7000, length: 7000 }; // 49 million each
    const many = headerOnlyTiff(Array.from({ length: 9 }, () => page));
    expect(refusal(() => acceptUpload(many, 'many.tif'))).toBe('decompression_bomb');
  });

  it('reads each page’s resolution, and the ratio of the two', () => {
    const inspection = inspectTiff(
      headerOnlyTiff([
        { width: 1728, length: 1100, xres: 204, yres: 98 },
        { width: 1000, length: 1000, xres: 80, yres: 80, unit: 3 },
        { width: 1000, length: 1000, xres: 2, yres: 1, unit: 1 },
        { width: 1000, length: 1000 },
      ]),
      { maxPages: 10 },
    );
    const [fax, metric, unitless, none] = inspection.pages;
    expect(fax).toMatchObject({ dpi: { x: 204, y: 98 } });
    expect(fax?.aspect).toBeCloseTo(204 / 98, 6);
    expect(metric?.dpi?.x).toBeCloseTo(203.2, 6);
    expect(unitless).toMatchObject({ aspect: 2 });
    expect(unitless?.dpi).toBeUndefined();
    expect(none?.dpi).toBeUndefined();
    expect(none?.aspect).toBeUndefined();
  });
});
