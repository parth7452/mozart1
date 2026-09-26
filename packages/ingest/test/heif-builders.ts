/**
 * Two real HEIC files, made offline with libheif 1.23 and the x265 encoder
 * (pillow-heif): a 64 × 48 white page with a black bar, and the same page saved
 * with EXIF orientation 6, which libheif writes as an `irot` box *and* keeps
 * in the EXIF — the shape an iPhone writes.
 */

/** 64 × 48, HEVC, major brand `heic`, compatible `mif1 heic miaf`. */
export const TINY_HEIC: Uint8Array = Buffer.from(
  'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAX1tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoQABAAAAAAAAAE4AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/WlwcnAAAADdaXBjbwAAAHZodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq5Ka5uAhoMCAAAAMDIAAAAwAhYgABAAZEAcFzwIkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xhcAAAAEAAAAABAAAAMAAAAAEAAAAAAAAAAv////AAAAACAAAAEHBpeGkAAAAAAwgICAAAABhpcG1hAAAAAAAAAAEAAQWBAgMFhAAAAFZtZGF0AAAASigBrxOABgbdx6UtbvxNx9tCVABoPyPJvPW6Yq8QvXFSoqMaLT1MTpSvLoyvM/ZT0CiqwEXIl+AKPlNxds3Xo/sJhuBPPClY2W3g',
  'base64',
);

/** The same page turned a quarter: decodes 48 × 64, with EXIF orientation 6 too. */
export const TURNED_HEIC: Uint8Array = Buffer.from(
  'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAchtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAADRpbG9jAAAAAERAAAIAAQAAAAAB7AABAAAAAAAAAE4AAgAAAAACOgABAAAAAAAAACQAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAAA5waXRtAAAAAAABAAABB2lwcnAAAADmaXBjbwAAAHZodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq5Ka5uAhoMCAAAAMDIAAAAwAhYgABAAZEAcFzwIkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xhcAAAAEAAAAABAAAAMAAAAAEAAAAAAAAAAv////AAAAACAAAAEHBpeGkAAAAAAwgICAAAAAlpcm90AwAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhIYAAAAaaXJlZgAAAAAAAAAOY2RzYwACAAEAAQAAAHptZGF0AAAASigBrxOABgbdx6UtbvxNx9tCVABoPyPJvPW6Yq8QvXFSoqMaLT1MTpSvLoyvM/ZT0CiqwEXIl+AKPlNxds3Xo/sJhuBPPClY2W3gAAAABkV4aWYAAE1NACoAAAAIAAEBEgADAAAAAQAGAAAAAAAA',
  'base64',
);

/**
 * An `ftyp` box with the brands given, then an empty `mdat` box so that
 * something follows it. Structure only: it decodes to nothing.
 */
export function ftypOnly(major: string, compatible: readonly string[], trailing = 8): Uint8Array {
  const size = 16 + 4 * compatible.length;
  const bytes = new Uint8Array(size + trailing);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes.set(Buffer.from('ftyp' + major.padEnd(4, ' ').slice(0, 4), 'latin1'), 4);
  compatible.forEach((brand, i) => bytes.set(Buffer.from(brand, 'latin1'), 16 + 4 * i));
  if (trailing >= 8) {
    view.setUint32(size, trailing);
    bytes.set(Buffer.from('mdat', 'latin1'), size + 4);
  }
  return bytes;
}
