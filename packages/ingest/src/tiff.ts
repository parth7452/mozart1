/**
 * A TIFF's structure, read without decoding a pixel (ADR 0054 §1).
 *
 * The door is synchronous and runs before a byte is stored, so it cannot hand
 * the file to libvips to find out what it is. What it can do is walk the
 * top-level IFD chain — the list of pages, each with its width, length and
 * resolution — in plain TypeScript, and refuse a file that lies about its own
 * structure or claims to be far larger than any page a person scanned. That
 * bounds the work the read-time decoder will be asked to do, the way
 * `inspectPdf`'s inflate budget bounds a PDF's.
 *
 * Only a classic TIFF (`II*\0` or `MM\0*`). BigTIFF (`II+\0`) has a different
 * layout and is not a format anyone faxes; it is refused by signature.
 */

import { RejectedUploadError } from './sniff-errors';

/** One page's pixels at most: a 600 dpi Letter page is about 34 million. */
export const MAX_TIFF_PAGE_PIXELS = 50_000_000;

/** Every page's pixels together: a 100-page 204 × 196 dpi fax is about 380 million. */
export const MAX_TIFF_TOTAL_PIXELS = 400_000_000;

/** Pixels per inch, when the page says. */
export interface TiffResolution {
  readonly x: number;
  readonly y: number;
}

export interface TiffPage {
  readonly width: number;
  readonly length: number;
  /** Absent when the page names no resolution, or a unit that is not a length. */
  readonly dpi?: TiffResolution;
  /**
   * The ratio of horizontal to vertical resolution, when both are stated —
   * with or without a unit. 1 for square pixels; about 2.08 for a 204 × 98
   * fax.
   */
  readonly aspect?: number;
}

export interface TiffInspection {
  readonly littleEndian: boolean;
  readonly pages: readonly TiffPage[];
  readonly totalPixels: number;
}

export interface TiffLimits {
  readonly maxPages: number;
  readonly maxPagePixels?: number;
  readonly maxTotalPixels?: number;
}

const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_X_RESOLUTION = 282;
const TAG_Y_RESOLUTION = 283;
const TAG_RESOLUTION_UNIT = 296;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/**
 * Whether a stored type is read, and viewed, through a rendition derived at
 * read time (ADR 0054). Here rather than beside `renderForReading` so a view
 * can ask without loading libvips.
 */
export function hasRendition(mimeType: string): boolean {
  return mimeType === 'image/tiff';
}

/** Whether the bytes begin as a classic TIFF, either byte order. */
export function isClassicTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const le = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  return le || be;
}

function malformed(detail: string): never {
  throw new RejectedUploadError('content_does_not_match_type', `the TIFF is malformed: ${detail}`);
}

/**
 * Walks the page chain. Throws `RejectedUploadError`:
 *
 * - `content_does_not_match_type` — not a classic TIFF, an offset outside the
 *   file, a chain that loops, an empty IFD, a page with no width or length.
 * - `decompression_bomb` — more pages than `maxPages`, a page over the pixel
 *   cap, or pages whose pixels together are over the total cap.
 */
export function inspectTiff(bytes: Uint8Array, limits: TiffLimits): TiffInspection {
  if (!isClassicTiff(bytes)) malformed('it does not begin with a classic TIFF header');
  const maxPagePixels = limits.maxPagePixels ?? MAX_TIFF_PAGE_PIXELS;
  const maxTotalPixels = limits.maxTotalPixels ?? MAX_TIFF_TOTAL_PIXELS;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = bytes[0] === 0x49;
  const u16 = (at: number): number => view.getUint16(at, littleEndian);
  const u32 = (at: number): number => view.getUint32(at, littleEndian);
  const within = (at: number, length: number): boolean => at >= 0 && at + length <= bytes.length;

  const pages: TiffPage[] = [];
  const visited = new Set<number>();
  let totalPixels = 0;
  let offset = u32(4);

  if (offset === 0) malformed('it has no pages');

  while (offset !== 0) {
    if (visited.has(offset)) malformed('its page chain loops');
    visited.add(offset);
    if (pages.length >= limits.maxPages) {
      throw new RejectedUploadError(
        'decompression_bomb',
        `the TIFF has more than ${limits.maxPages} pages`,
      );
    }
    if (offset < 8 || !within(offset, 2)) malformed('a page offset points outside the file');
    const count = u16(offset);
    if (count === 0) malformed('a page has no entries');
    const entriesEnd = offset + 2 + count * 12;
    if (!within(offset + 2, count * 12 + 4)) malformed('a page runs past the end of the file');

    let width: number | undefined;
    let length: number | undefined;
    let xres: number | undefined;
    let yres: number | undefined;
    let unit = 2; // The TIFF 6.0 default: inches.

    for (let entry = offset + 2; entry < entriesEnd; entry += 12) {
      const tag = u16(entry);
      const type = u16(entry + 2);
      const valueCount = u32(entry + 4);
      const scalar = (): number | undefined =>
        valueCount < 1
          ? undefined
          : type === TYPE_SHORT
            ? u16(entry + 8)
            : type === TYPE_LONG
              ? u32(entry + 8)
              : undefined;
      const rational = (): number | undefined => {
        if (type !== TYPE_RATIONAL || valueCount < 1) return undefined;
        const at = u32(entry + 8);
        if (!within(at, 8)) malformed('a resolution points outside the file');
        const numerator = u32(at);
        const denominator = u32(at + 4);
        return denominator === 0 || numerator === 0 ? undefined : numerator / denominator;
      };
      switch (tag) {
        case TAG_IMAGE_WIDTH:
          width = scalar();
          break;
        case TAG_IMAGE_LENGTH:
          length = scalar();
          break;
        case TAG_X_RESOLUTION:
          xres = rational();
          break;
        case TAG_Y_RESOLUTION:
          yres = rational();
          break;
        case TAG_RESOLUTION_UNIT:
          unit = scalar() ?? unit;
          break;
        default:
          break;
      }
    }

    if (width === undefined || width === 0 || length === undefined || length === 0) {
      malformed(`page ${pages.length + 1} names no width or length`);
    }
    const pixels = width * length;
    if (pixels > maxPagePixels) {
      throw new RejectedUploadError(
        'decompression_bomb',
        `page ${pages.length + 1} of the TIFF is ${width} × ${length} pixels, over the ${maxPagePixels} pixel limit`,
      );
    }
    totalPixels += pixels;
    if (totalPixels > maxTotalPixels) {
      throw new RejectedUploadError(
        'decompression_bomb',
        `the TIFF's pages total more than ${maxTotalPixels} pixels`,
      );
    }

    const perInch = unit === 2 ? 1 : unit === 3 ? 2.54 : undefined;
    const page: TiffPage = {
      width,
      length,
      ...(xres !== undefined && yres !== undefined && perInch !== undefined
        ? { dpi: { x: xres * perInch, y: yres * perInch } }
        : {}),
      ...(xres !== undefined && yres !== undefined ? { aspect: xres / yres } : {}),
    };
    pages.push(page);

    offset = u32(entriesEnd);
  }

  return { littleEndian, pages, totalPixels };
}
