/**
 * TIFFs built for tests.
 *
 * `headerOnlyTiff` writes a page chain and no pixels, so a test can claim any
 * size or number of pages for a few hundred bytes — which is exactly what a
 * hostile file does, and what the door's structural check has to refuse
 * without decoding anything. `realTiff` asks sharp for a file libvips will
 * actually decode.
 */

import sharp from 'sharp';

export interface HeaderPage {
  readonly width: number;
  readonly length: number;
  /** Pixels per unit, as rationals n/1. */
  readonly xres?: number;
  readonly yres?: number;
  /** 1 none, 2 inch (the default), 3 centimetre. */
  readonly unit?: number;
}

export function headerOnlyTiff(
  pages: readonly HeaderPage[],
  options: { readonly bigEndian?: boolean; readonly loop?: boolean } = {},
): Uint8Array {
  const le = options.bigEndian !== true;
  const chunks: number[] = [];
  const u16 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff]);
  const u32 = (v: number) =>
    le
      ? [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

  chunks.push(...(le ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a]), ...u32(8));
  const offsets: number[] = [];
  let at = 8;
  for (const page of pages) {
    offsets.push(at);
    const entries = 2 + (page.xres !== undefined ? 1 : 0) + (page.yres !== undefined ? 1 : 0) + (page.unit !== undefined ? 1 : 0);
    at += 2 + entries * 12 + 4 + 16; // the IFD, then room for two rationals
  }
  pages.forEach((page, index) => {
    const start = offsets[index]!;
    const entries: number[][] = [];
    const rationalsAt = start + 2 + (2 + (page.xres !== undefined ? 1 : 0) + (page.yres !== undefined ? 1 : 0) + (page.unit !== undefined ? 1 : 0)) * 12 + 4;
    entries.push([...u16(256), ...u16(4), ...u32(1), ...u32(page.width)]);
    entries.push([...u16(257), ...u16(4), ...u32(1), ...u32(page.length)]);
    if (page.xres !== undefined) entries.push([...u16(282), ...u16(5), ...u32(1), ...u32(rationalsAt)]);
    if (page.yres !== undefined) entries.push([...u16(283), ...u16(5), ...u32(1), ...u32(rationalsAt + 8)]);
    if (page.unit !== undefined) entries.push([...u16(296), ...u16(3), ...u32(1), ...u16(page.unit), 0, 0]);
    const next = index + 1 < pages.length ? offsets[index + 1]! : options.loop === true ? offsets[0]! : 0;
    chunks.push(...u16(entries.length), ...entries.flat(), ...u32(next));
    chunks.push(...u32(page.xres ?? 0), ...u32(1), ...u32(page.yres ?? 0), ...u32(1));
  });
  return new Uint8Array(chunks);
}

/** A real, decodable TIFF: one page per colour, each `width × height`. */
export async function realTiff(
  pages: readonly { readonly width: number; readonly height: number; readonly colour: string }[],
): Promise<Uint8Array> {
  const pngs = await Promise.all(
    pages.map((page) =>
      sharp({ create: { width: page.width, height: page.height, channels: 3, background: page.colour } })
        .png()
        .toBuffer(),
    ),
  );
  if (pngs.length === 1) return new Uint8Array(await sharp(pngs[0]!).tiff().toBuffer());
  // Pages of different sizes cannot be joined by sharp, so every page here is
  // one size: sharp writes a multi-page TIFF from a stack of equal pages.
  return new Uint8Array(await sharp(pngs, { join: { animated: true } }).tiff().toBuffer());
}

/**
 * A bilevel fax page, CCITT Group 4, with a black bar across its top, at a
 * fax's two resolutions: 204 dpi across and 98 down ("standard" mode), so its
 * pixels are about twice as tall as they are wide.
 */
export async function faxPage(
  width = 1728,
  height = 1100,
  dpi: { readonly x: number; readonly y: number } = { x: 204, y: 98 },
): Promise<Uint8Array> {
  const bar = await sharp({ create: { width, height: 40, channels: 3, background: 'black' } }).png().toBuffer();
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: 'white' } })
      .composite([{ input: bar, top: 0, left: 0 }])
      .removeAlpha()
      .toColourspace('b-w')
      .tiff({
        compression: 'ccittfax4',
        bitdepth: 1,
        // libvips takes pixels per millimetre and writes them in the unit asked.
        xres: dpi.x / 25.4,
        yres: dpi.y / 25.4,
        resolutionUnit: 'inch',
      })
      .toBuffer(),
  );
}
