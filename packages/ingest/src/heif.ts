/**
 * HEIC / HEIF at the door: the ISO-BMFF `ftyp` box read for its brands, and
 * nothing decoded (ADR 0054 §5).
 *
 * An iPhone photographs a page as HEIC. Neither reader takes it, so, like a
 * TIFF, a read gets a rendition derived at read time and never stored — a JPEG
 * (`@recouple/ingest/rendition`). This module is structure only and has no
 * dependencies, so the door and a view can ask about a file without loading a
 * decoder.
 */

import { RejectedUploadError } from './sniff-errors';

/** The type a HEIC or HEIF file is stored as, whatever it was declared as. */
export const HEIC_MIME = 'image/heic' as const;

/** Brands that say the file carries HEVC-coded images. */
const HEVC_BRANDS: ReadonlySet<string> = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);

/** The generic HEIF brands: image and sequence, whatever the codec. */
const GENERIC_BRANDS: ReadonlySet<string> = new Set(['mif1', 'msf1']);

/** AV1 in a HEIF container. An AVIF also names `mif1`, and is not a HEIC. */
const AV1_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis']);

/** An `ftyp` box is a handful of brands; past this it is not one. */
const MAX_FTYP_BYTES = 4096;

/** A declared type that means HEIC to us: `image/heif` is stored as `image/heic`. */
export function normaliseHeifType(mimeType: string): string {
  return mimeType === 'image/heif' ? HEIC_MIME : mimeType;
}

function ascii(bytes: Uint8Array, start: number): string {
  return String.fromCharCode(bytes[start]!, bytes[start + 1]!, bytes[start + 2]!, bytes[start + 3]!);
}

/**
 * The brands the first box names — its major brand first, then every
 * compatible brand that fits inside the box and the file — or `undefined` when
 * the file does not begin with an `ftyp` box.
 */
function brandsOf(bytes: Uint8Array): { major: string; all: string[] } | undefined {
  if (bytes.length < 16 || ascii(bytes, 4) !== 'ftyp') return undefined;
  const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const end = Math.min(size, bytes.length, MAX_FTYP_BYTES);
  const all = [ascii(bytes, 8)];
  for (let at = 16; at + 4 <= end; at += 4) all.push(ascii(bytes, at));
  return { major: all[0]!, all };
}

/**
 * Whether the bytes begin as a HEIC or HEIF image: an `ftyp` box whose major
 * or a compatible brand is one of heic, heix, heim, heis, hevc, hevx, mif1 or
 * msf1 — and, when the only such brand is a generic one, no AV1 brand beside
 * it, so an AVIF-only file is not taken for one.
 */
export function isHeif(bytes: Uint8Array): boolean {
  const brands = brandsOf(bytes);
  if (brands === undefined) return false;
  if (brands.all.some((brand) => HEVC_BRANDS.has(brand))) return true;
  return (
    brands.all.some((brand) => GENERIC_BRANDS.has(brand)) &&
    !brands.all.some((brand) => AV1_BRANDS.has(brand))
  );
}

/**
 * The door's structural check, after `isHeif`: the `ftyp` box's own size is
 * sane — at least its header and major and minor brand, a whole number of
 * compatible brands, within the file and short — and something follows it.
 * Nothing is decoded; what a decoder will be asked to do is bounded at read
 * time, before any pixel is (`renderForReading`).
 */
export function inspectHeif(bytes: Uint8Array): void {
  const malformed = (why: string): never => {
    throw new RejectedUploadError(
      'content_does_not_match_type',
      `the file names a HEIF brand but is not a well-formed HEIF file: ${why}`,
    );
  };
  if (bytes.length < 16 || ascii(bytes, 4) !== 'ftyp') malformed('it does not begin with an ftyp box');
  const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  if (size < 16) malformed(`its ftyp box claims ${size} bytes`);
  if (size > MAX_FTYP_BYTES) malformed(`its ftyp box claims ${size} bytes`);
  if ((size - 16) % 4 !== 0) malformed('its ftyp box does not hold a whole number of brands');
  if (size + 8 > bytes.length) malformed('nothing follows its ftyp box');
}
