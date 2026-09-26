import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  describeRendition,
  hasRendition,
  MAX_RENDITION_EDGE_PX,
  RenditionError,
  renderForReading,
  renditionFilename,
} from '../src/rendition';
import { faxPage, headerOnlyTiff, realTiff } from './tiff-builders';

/**
 * A rendition is derived at read time and never stored (ADR 0054 §2). What the
 * readers are sent has to be a type they take, page for page the TIFF that
 * arrived, square-pixelled, and the same bytes every time it is made.
 */

async function sizeOf(bytes: Uint8Array): Promise<{ width: number; height: number; format: string }> {
  const metadata = await sharp(bytes).metadata();
  return { width: metadata.width, height: metadata.height, format: metadata.format };
}

describe('a rendition', () => {
  it('is the stored bytes themselves for every type a reader already takes', async () => {
    for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']) {
      const bytes = new Uint8Array([1, 2, 3]);
      const rendition = await renderForReading(bytes, type);
      expect(rendition.bytes).toBe(bytes);
      expect(rendition.mimeType).toBe(type);
      expect(rendition.derivedFrom).toBeUndefined();
      expect(describeRendition(rendition)).toBeUndefined();
      expect(renditionFilename('notice.pdf', rendition)).toBe('notice.pdf');
      expect(hasRendition(type)).toBe(false);
    }
    expect(hasRendition('image/tiff')).toBe(true);
  });

  it('makes a one-page TIFF a PNG of the same size', async () => {
    const tiff = await realTiff([{ width: 320, height: 200, colour: 'teal' }]);
    const rendition = await renderForReading(tiff, 'image/tiff');
    expect(rendition).toMatchObject({ mimeType: 'image/png', derivedFrom: 'image/tiff', pageCount: 1 });
    expect(await sizeOf(rendition.bytes)).toEqual({ width: 320, height: 200, format: 'png' });
    expect(describeRendition(rendition)).toBe('rendition image/tiff→image/png 1p');
    expect(renditionFilename('scan.TIF', rendition)).toBe('scan.png');
  });

  it('makes a multi-page TIFF a PDF with its pages in their order', async () => {
    const colours = ['red', 'lime', 'blue'] as const;
    const tiff = await realTiff(colours.map((colour) => ({ width: 90, height: 60, colour })));
    const rendition = await renderForReading(tiff, 'image/tiff');
    expect(rendition).toMatchObject({ mimeType: 'application/pdf', derivedFrom: 'image/tiff', pageCount: 3 });
    expect(describeRendition(rendition)).toBe('rendition image/tiff→application/pdf 3p');
    expect(renditionFilename('fax.tiff', rendition)).toBe('fax.pdf');

    const pdf = await PDFDocument.load(rendition.bytes);
    expect(pdf.getPageCount()).toBe(3);
    // The page as printed: sharp, told nothing, writes one pixel per
    // millimetre, so 90 px is 90 mm — 255.1 pt.
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo((90 / 25.4) * 72, 3);
      expect(page.getHeight()).toBeCloseTo((60 / 25.4) * 72, 3);
    }
    // In order: each PDF page's own image, inflated back, is that TIFF page's colour.
    expect(await pagesAsPixels(tiff)).toEqual(firstPixelOfEachPdfPage(pdf));
    // Red, then green, then blue: the brightest channel of each page's pixel.
    const brightest = firstPixelOfEachPdfPage(pdf).map((rgb) => rgb.indexOf(Math.max(...rgb)));
    expect(brightest).toEqual([0, 1, 2]);
  });

  it('decodes a CCITT Group 4 fax and makes its pixels square at the finer resolution', async () => {
    const fax = await faxPage(1728, 1100, { x: 204, y: 98 });
    const rendition = await renderForReading(fax, 'image/tiff');
    const size = await sizeOf(rendition.bytes);
    // 98 dpi down is stretched to 204: the page is as tall as it was printed.
    expect(size.width).toBe(1728);
    expect(size.height).toBe(Math.round(1100 * (204 / 98)));
    // The bar across the top survived the decode: black at the top, white below.
    const { data, info } = await sharp(rendition.bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(data[info.width * 10 + 100]).toBeLessThan(32);
    expect(data[info.width * (info.height - 10) + 100]).toBeGreaterThan(223);
  });

  it('keeps a multi-page fax’s printed page size', async () => {
    const page = await faxPage(1728, 1100, { x: 204, y: 98 });
    const two = new Uint8Array(
      await sharp([Buffer.from(page), Buffer.from(page)], { join: { animated: true } })
        .tiff({ xres: 204 / 25.4, yres: 98 / 25.4, resolutionUnit: 'inch' })
        .toBuffer(),
    );
    const rendition = await renderForReading(two, 'image/tiff');
    const pdf = await PDFDocument.load(rendition.bytes);
    const [first] = pdf.getPages();
    // 1728 px at 204 dpi is 8.47 in; 1100 px at 98 dpi is 11.22 in.
    expect(first!.getWidth()).toBeCloseTo((1728 / 204) * 72, 0);
    expect(first!.getHeight()).toBeCloseTo((1100 / 98) * 72, 0);
  });

  it('caps the longer edge at the API’s image limit', async () => {
    const tall = await realTiff([{ width: 100, height: 9000, colour: 'white' }]);
    const rendition = await renderForReading(tall, 'image/tiff');
    const size = await sizeOf(rendition.bytes);
    expect(size.height).toBe(MAX_RENDITION_EDGE_PX);
    expect(size.width).toBe(Math.round(100 * (MAX_RENDITION_EDGE_PX / 9000)));
  });

  it('applies the page’s orientation', async () => {
    const png = await sharp({ create: { width: 300, height: 100, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const turned = new Uint8Array(await sharp(png).withMetadata({ orientation: 6 }).tiff().toBuffer());
    expect((await sharp(turned).metadata()).orientation).toBe(6);
    const rendition = await renderForReading(turned, 'image/tiff');
    expect(await sizeOf(rendition.bytes)).toMatchObject({ width: 100, height: 300 });
  });

  it('is the same bytes every time it is made', async () => {
    const one = await realTiff([{ width: 200, height: 120, colour: 'orange' }]);
    const many = await realTiff([
      { width: 64, height: 64, colour: 'black' },
      { width: 64, height: 64, colour: 'white' },
    ]);
    for (const tiff of [one, many, await faxPage()]) {
      const a = await renderForReading(tiff, 'image/tiff');
      const b = await renderForReading(tiff, 'image/tiff');
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    }
  });

  it('is a named error when the pixels will not decode, saying which page', async () => {
    // A page chain that is fine and no pixel data behind it.
    const empty = headerOnlyTiff([{ width: 100, length: 100 }]);
    await expect(renderForReading(empty, 'image/tiff')).rejects.toBeInstanceOf(RenditionError);
    await expect(renderForReading(empty, 'image/tiff')).rejects.toThrow(/page 1 of the stored TIFF will not decode/);
  });

  it('holds a stored TIFF to the door’s caps, as a rendition error', async () => {
    const huge = headerOnlyTiff([{ width: 100_000, length: 100_000 }]);
    await expect(renderForReading(huge, 'image/tiff')).rejects.toThrow(RenditionError);
  });
});

/** The first pixel of each page of a TIFF, decoded by sharp: the colour it was made with. */
async function pagesAsPixels(tiff: Uint8Array): Promise<number[][]> {
  const pages = (await sharp(tiff).metadata()).pages ?? 1;
  const out: number[][] = [];
  for (let page = 0; page < pages; page += 1) {
    const { data } = await sharp(tiff, { page }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    out.push([data[0]!, data[1]!, data[2]!]);
  }
  return out;
}

/** The first pixel of the one image drawn on each page of a rendition PDF. */
function firstPixelOfEachPdfPage(pdf: PDFDocument): number[][] {
  return pdf.getPages().map((page) => {
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const [name] = xobjects?.keys() ?? [];
    const stream = name === undefined ? undefined : xobjects?.lookup(name);
    if (!(stream instanceof PDFRawStream)) throw new Error('page has no image');
    const pixels = inflateSync(stream.contents);
    return [pixels[0]!, pixels[1]!, pixels[2]!];
  });
}
