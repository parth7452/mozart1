/**
 * What a reader is given for a stored document: its bytes, or a rendition
 * derived from them at read time and never stored (ADR 0054).
 *
 * The Messages API reads PDF, PNG, JPEG, GIF and WebP, and nothing else, and
 * Reducto's support for anything else is unverified. A TIFF — what a fax server
 * or an office scanner writes — is none of those, so a read turns it into one:
 * a PNG for a single page, a PDF with one page per TIFF page for several. Page
 * *n* of the rendition is page *n* of the TIFF, so a field's `sourcePage` names
 * a page of the stored original and provenance needs no mapping.
 *
 * Never stored: `documents` is append-only and deduplicates on the hash of the
 * bytes that arrived, and it names the arrival that brought them. A converted
 * copy stored beside the original would hash differently, arrive from nowhere
 * and need a link table to say what it was. So the rendition lives in memory
 * for the length of one read or one request, and every run of this function
 * over the same bytes produces the same bytes — fixed encoder options, no
 * dates — so a replay, a "Read again" and the case page's view agree.
 *
 * This module imports sharp (native libvips) and is deliberately not
 * re-exported from the package index: it is reached as
 * `@recouple/ingest/rendition`, by server code only.
 */

import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { MAX_MODEL_PAYLOAD_BYTES, MAX_PAGES_PER_READ } from './sniff';
import { RejectedUploadError } from './sniff-errors';
import {
  hasRendition,
  inspectTiff,
  MAX_TIFF_PAGE_PIXELS,
  MAX_TIFF_TOTAL_PIXELS,
  type TiffPage,
} from './tiff';

/** The API's own ceiling on one image's bytes. */
export const MAX_RENDITION_IMAGE_BYTES = 5 * 1024 * 1024;

/** The API's own ceiling on an image's longer edge, in pixels. */
export const MAX_RENDITION_EDGE_PX = 8000;

/**
 * The resolution assumed for a page that names none, for the PDF's page size
 * only: a fax's horizontal resolution, near enough, and a size a viewer shows
 * as a page rather than a poster.
 */
export const ASSUMED_DPI = 200;

/** The PDF user-space ceiling on a page's side, in points (ISO 32000-1 C.2). */
const MAX_PAGE_POINTS = 14_400;

/** A resolution ratio closer to 1 than this is treated as square pixels. */
const SQUARE_TOLERANCE = 0.01;

export type RenditionMimeType = 'image/png' | 'image/jpeg' | 'application/pdf';

export interface Rendition {
  /** What the reader is sent. For a type that needs no rendition, the stored type. */
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  /**
   * The stored type this was derived from, present exactly when the bytes are
   * not the stored bytes.
   */
  readonly derivedFrom?: string;
  /** Pages in the rendition, when it was derived. */
  readonly pageCount?: number;
}

/**
 * A stored document that passed the door but will not render. Named, and
 * settled: the same bytes fail the same way every time, so a retry can only
 * pay to hear it again. The message names a page number and libvips's own
 * complaint about the encoding, never anything off the page.
 */
export class RenditionError extends Error {
  override readonly name = 'RenditionError';
}

export { hasRendition };

/**
 * The bytes a reader is given for a stored document.
 *
 * Identity — the same object — for every type that needs no rendition, so
 * nothing recorded before ADR 0054 can move.
 */
export async function renderForReading(bytes: Uint8Array, mimeType: string): Promise<Rendition> {
  if (!hasRendition(mimeType)) return { mimeType, bytes };
  return renderTiff(bytes);
}

/** A filename that says what the reader was sent: `fax.tif` → `fax.pdf`. */
export function renditionFilename(filename: string, rendition: Rendition): string {
  if (rendition.derivedFrom === undefined) return filename;
  const extension =
    rendition.mimeType === 'application/pdf' ? 'pdf' : rendition.mimeType === 'image/png' ? 'png' : 'jpg';
  const stem = filename.replace(/\.[^./\\]*$/, '');
  return `${stem === '' ? 'document' : stem}.${extension}`;
}

/** `rendition image/tiff→application/pdf 3p`: types and a count, nothing off the page. */
export function describeRendition(rendition: Rendition): string | undefined {
  if (rendition.derivedFrom === undefined) return undefined;
  return `rendition ${rendition.derivedFrom}→${rendition.mimeType} ${rendition.pageCount ?? 1}p`;
}

interface EncodedPage {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg';
  /** The page's printed size, in points. */
  readonly widthPt: number;
  readonly heightPt: number;
}

async function renderTiff(bytes: Uint8Array): Promise<Rendition> {
  let pages: readonly TiffPage[];
  try {
    // The door's own caps, asked again: a TIFF stored before a cap tightened
    // is held to the cap in force now.
    pages = inspectTiff(bytes, {
      maxPages: MAX_PAGES_PER_READ,
      maxPagePixels: MAX_TIFF_PAGE_PIXELS,
      maxTotalPixels: MAX_TIFF_TOTAL_PIXELS,
    }).pages;
  } catch (error) {
    if (error instanceof RejectedUploadError) {
      throw new RenditionError(`the stored TIFF will not render: ${error.message}`);
    }
    throw error;
  }

  // One page at a time, so a hundred-page fax never has two pages decoded at once.
  const encoded: EncodedPage[] = [];
  for (const [index, page] of pages.entries()) {
    encoded.push(await renderPage(bytes, index, page));
  }

  if (encoded.length === 1) {
    const only = encoded[0]!;
    return { mimeType: only.mimeType, bytes: only.bytes, derivedFrom: 'image/tiff', pageCount: 1 };
  }

  // No producer, no creator, no dates: `updateMetadata: false` is what makes
  // two renders of one TIFF the same bytes.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (const page of encoded) {
    const image =
      page.mimeType === 'image/png' ? await pdf.embedPng(page.bytes) : await pdf.embedJpg(page.bytes);
    const target = pdf.addPage([page.widthPt, page.heightPt]);
    target.drawImage(image, { x: 0, y: 0, width: page.widthPt, height: page.heightPt });
  }
  const out = await pdf.save({ updateFieldAppearances: false });

  // Base64 is what travels, and the request carries it.
  const base64Bytes = Math.ceil(out.byteLength / 3) * 4;
  if (base64Bytes > MAX_MODEL_PAYLOAD_BYTES) {
    throw new RenditionError(
      `the ${encoded.length}-page rendition is ${out.byteLength} bytes, over what one read may carry`,
    );
  }
  return { mimeType: 'application/pdf', bytes: out, derivedFrom: 'image/tiff', pageCount: encoded.length };
}

async function renderPage(bytes: Uint8Array, index: number, page: TiffPage): Promise<EncodedPage> {
  const pageNumber = index + 1;
  try {
    const input = { page: index, pages: 1, limitInputPixels: MAX_TIFF_PAGE_PIXELS, failOn: 'error' as const };
    const metadata = await sharp(bytes, input).metadata();

    // Orientation 5–8 turns the page a quarter: its horizontal axis is then the
    // stored vertical one, and so is that axis's resolution.
    const quarterTurn = metadata.orientation !== undefined && metadata.orientation >= 5;
    const width = quarterTurn ? page.length : page.width;
    const height = quarterTurn ? page.width : page.length;
    const aspectStored = page.aspect ?? 1;
    const aspect = quarterTurn ? 1 / aspectStored : aspectStored; // horizontal ÷ vertical resolution
    const dpiX = page.dpi === undefined ? undefined : quarterTurn ? page.dpi.y : page.dpi.x;
    const dpiY = page.dpi === undefined ? undefined : quarterTurn ? page.dpi.x : page.dpi.y;

    // Square pixels at the finer of the two resolutions: a 204 × 98 dpi fax is
    // stretched to its printed height rather than halved to its coarser width.
    let squareWidth = width;
    let squareHeight = height;
    if (Math.abs(aspect - 1) > SQUARE_TOLERANCE) {
      if (aspect > 1) squareHeight = Math.round(height * aspect);
      else squareWidth = Math.round(width / aspect);
    }
    const squareDpi =
      dpiX !== undefined && dpiY !== undefined ? Math.max(dpiX, dpiY) : ASSUMED_DPI;

    const shrink = Math.min(1, MAX_RENDITION_EDGE_PX / Math.max(squareWidth, squareHeight));
    const outWidth = Math.max(1, Math.round(squareWidth * shrink));
    const outHeight = Math.max(1, Math.round(squareHeight * shrink));

    let pipeline = sharp(bytes, { ...input, autoOrient: true }).flatten({ background: '#ffffff' });
    if (outWidth !== width || outHeight !== height) {
      pipeline = pipeline.resize(outWidth, outHeight, { fit: 'fill', kernel: 'lanczos3' });
    }

    // Lossless first, because a fax's text is the content. The JPEG is for a
    // greyscale photograph of a page, which PNG cannot bring under the limit.
    let encoded: Uint8Array = await pipeline
      .clone()
      .png({ compressionLevel: 6, adaptiveFiltering: false, palette: false })
      .toBuffer();
    let mimeType: 'image/png' | 'image/jpeg' = 'image/png';
    if (encoded.byteLength > MAX_RENDITION_IMAGE_BYTES) {
      encoded = await pipeline
        .clone()
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: false, progressive: false })
        .toBuffer();
      mimeType = 'image/jpeg';
    }
    if (encoded.byteLength > MAX_RENDITION_IMAGE_BYTES) {
      throw new RenditionError(
        `page ${pageNumber} renders to ${encoded.byteLength} bytes even as JPEG, over the ${MAX_RENDITION_IMAGE_BYTES} byte image limit`,
      );
    }

    // The page as printed: square pixels at the finer resolution, or at the
    // assumed one. Clamped to what a PDF page may be.
    let widthPt = (squareWidth * 72) / squareDpi;
    let heightPt = (squareHeight * 72) / squareDpi;
    const over = Math.max(widthPt, heightPt) / MAX_PAGE_POINTS;
    if (over > 1) {
      widthPt /= over;
      heightPt /= over;
    }

    return {
      bytes: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      mimeType,
      widthPt: Math.max(1, widthPt),
      heightPt: Math.max(1, heightPt),
    };
  } catch (error) {
    if (error instanceof RenditionError) throw error;
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new RenditionError(`page ${pageNumber} of the stored TIFF will not decode: ${reason}`);
  }
}
