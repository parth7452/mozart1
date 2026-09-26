import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isHeif, normaliseHeifType } from '../src/heif';
import { hasRendition } from '../src/tiff';
import { describeRendition, renderForReading, renditionFilename } from '../src/rendition';
import { ALLOWED_MIME_TYPES, RejectedUploadError, acceptUpload, detectMimeType } from '../src/sniff';
import { ftypOnly, TINY_HEIC, TURNED_HEIC } from './heif-builders';

/** HEIC and HEIF at the door and through a rendition (ADR 0054 §5). */

function refusal(accept: () => unknown): string | undefined {
  try {
    accept();
    return undefined;
  } catch (error) {
    if (error instanceof RejectedUploadError) return error.code;
    throw error;
  }
}

describe('HEIC at the door', () => {
  it('is on the list, stored as image/heic', () => {
    expect(ALLOWED_MIME_TYPES).toContain('image/heic');
    expect(ALLOWED_MIME_TYPES).not.toContain('image/heif');
    expect(hasRendition('image/heic')).toBe(true);
  });

  it('accepts a real HEIC by its major brand', () => {
    expect(detectMimeType(TINY_HEIC)).toBe('image/heic');
    const accepted = acceptUpload(TINY_HEIC, 'IMG_0001.HEIC', { declaredMimeType: 'image/heic' });
    expect(accepted).toMatchObject({ mimeType: 'image/heic', pageCount: 1, warnings: [] });
  });

  it('maps a declared image/heif to image/heic without a warning', () => {
    expect(normaliseHeifType('image/heif')).toBe('image/heic');
    const accepted = acceptUpload(TINY_HEIC, 'IMG_0001.heif', { declaredMimeType: 'image/heif' });
    expect(accepted.mimeType).toBe('image/heic');
    expect(accepted.warnings).toEqual([]);
  });

  it('accepts every HEIF brand, as the major brand or as a compatible one', () => {
    for (const brand of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']) {
      expect(detectMimeType(ftypOnly(brand, []))).toBe('image/heic');
      expect(detectMimeType(ftypOnly('isom', ['iso8', brand]))).toBe('image/heic');
      expect(acceptUpload(ftypOnly('qqqq', [brand]), 'photo.heic').mimeType).toBe('image/heic');
    }
  });

  it('refuses an AVIF-only file, though an AVIF names mif1 too', () => {
    for (const avif of [ftypOnly('avif', ['mif1', 'miaf']), ftypOnly('mif1', ['avif', 'miaf']), ftypOnly('avis', ['msf1'])]) {
      expect(isHeif(avif)).toBe(false);
      expect(refusal(() => acceptUpload(avif, 'photo.avif'))).toBe('type_not_allowed');
    }
    // A file that carries HEVC as well as AV1 is a HEIC.
    expect(detectMimeType(ftypOnly('avif', ['mif1', 'heic']))).toBe('image/heic');
  });

  it('refuses garbage, and a video that is not a HEIF', () => {
    expect(refusal(() => acceptUpload(new Uint8Array(64).fill(0x41), 'photo.heic'))).toBe('type_not_allowed');
    expect(refusal(() => acceptUpload(ftypOnly('isom', ['iso2', 'mp41']), 'clip.heic'))).toBe('type_not_allowed');
    expect(refusal(() => acceptUpload(new Uint8Array([0, 0, 0, 24, 0x66, 0x74]), 'short.heic'))).toBe(
      'type_not_allowed',
    );
  });

  it('refuses a malformed ftyp box as content that does not match its type', () => {
    const tooSmall = ftypOnly('heic', ['mif1']);
    new DataView(tooSmall.buffer).setUint32(0, 12);
    expect(refusal(() => acceptUpload(tooSmall, 'a.heic'))).toBe('content_does_not_match_type');

    const ragged = ftypOnly('heic', ['mif1']);
    new DataView(ragged.buffer).setUint32(0, 22);
    expect(refusal(() => acceptUpload(ragged, 'b.heic'))).toBe('content_does_not_match_type');

    const huge = ftypOnly('heic', ['mif1']);
    new DataView(huge.buffer).setUint32(0, 0x7fff_fff0);
    expect(refusal(() => acceptUpload(huge, 'c.heic'))).toBe('content_does_not_match_type');

    const nothingAfter = ftypOnly('heic', ['mif1'], 0);
    expect(refusal(() => acceptUpload(nothingAfter, 'd.heic'))).toBe('content_does_not_match_type');
  });
});

describe('a HEIC rendition', () => {
  it('is a JPEG of the same size, the same bytes every time', async () => {
    const first = await renderForReading(TINY_HEIC, 'image/heic');
    expect(first).toMatchObject({ mimeType: 'image/jpeg', derivedFrom: 'image/heic', pageCount: 1 });
    const metadata = await sharp(first.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 64, height: 48 });
    // No EXIF, no ICC, no date: nothing that would make two renders differ.
    expect(metadata.exif).toBeUndefined();
    expect(describeRendition(first)).toBe('rendition image/heic→image/jpeg 1p');
    expect(renditionFilename('IMG_0001.HEIC', first)).toBe('IMG_0001.jpg');

    const second = await renderForReading(TINY_HEIC, 'image/heic');
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);

    // The page itself: white, with its black bar where it was drawn.
    const { data, info } = await sharp(first.bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[y * info.width + x]!;
    expect(at(2, 2)).toBeGreaterThan(200);
    expect(at(30, 15)).toBeLessThan(60);
  });

  it('is upright, turned once — not again by the EXIF that says the same turn', async () => {
    const rendition = await renderForReading(TURNED_HEIC, 'image/heic');
    const metadata = await sharp(rendition.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 48, height: 64 });
    expect(metadata.orientation).toBeUndefined();
  });

  it('decodes a HEIC the door took by a compatible brand alone', async () => {
    // Major brand `heim`, which heic-decode itself would refuse to look at.
    const other = Buffer.from(TINY_HEIC);
    other.write('heim', 8, 'latin1');
    expect(detectMimeType(other)).toBe('image/heic');
    const rendition = await renderForReading(other, 'image/heic');
    expect((await sharp(rendition.bytes).metadata()).width).toBe(64);
    // The stored bytes are not touched.
    expect(other.subarray(8, 12).toString('latin1')).toBe('heim');
  });

  it('refuses a HEIC that will not decode, by name', async () => {
    await expect(renderForReading(ftypOnly('heic', ['mif1']), 'image/heic')).rejects.toMatchObject({
      name: 'RenditionError',
    });
  });
});
