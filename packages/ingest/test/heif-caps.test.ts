import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The caps a HEIC rendition holds to, against a mocked decoder: a real HEIC
 * past 50 MP or 8000 px is megabytes of fixture, and the caps are ours, not
 * the decoder's. The decode path itself is tested against real files in
 * `heif.test.ts`.
 */

const decoder = vi.hoisted(() => ({
  width: 0,
  height: 0,
  decoded: 0,
  disposed: 0,
}));

vi.mock('heic-decode', () => {
  const all = async () => {
    const images = [
      {
        width: decoder.width,
        height: decoder.height,
        decode: async () => {
          decoder.decoded += 1;
          return {
            width: decoder.width,
            height: decoder.height,
            data: new Uint8ClampedArray(decoder.width * decoder.height * 4).fill(255),
          };
        },
      },
    ];
    Object.defineProperty(images, 'dispose', { value: () => (decoder.disposed += 1) });
    return images;
  };
  const one = async () => undefined;
  return { default: Object.assign(one, { all }) };
});

const { MAX_HEIC_PIXELS, MAX_RENDITION_EDGE_PX, renderForReading } = await import('../src/rendition');
const { TINY_HEIC } = await import('./heif-builders');

beforeEach(() => {
  decoder.decoded = 0;
  decoder.disposed = 0;
});

describe('a HEIC rendition’s caps', () => {
  it('refuses past 50 MP as a decompression bomb, before a pixel is decoded', async () => {
    expect(MAX_HEIC_PIXELS).toBe(50_000_000);
    decoder.width = 10_000;
    decoder.height = 5_001;
    await expect(renderForReading(TINY_HEIC, 'image/heic')).rejects.toMatchObject({
      name: 'RenditionError',
      code: 'decompression_bomb',
    });
    expect(decoder.decoded).toBe(0);
    expect(decoder.disposed).toBe(1);
  });

  it('caps the long edge at 8000 px', async () => {
    decoder.width = 9_000;
    decoder.height = 300;
    const rendition = await renderForReading(TINY_HEIC, 'image/heic');
    const metadata = await sharp(rendition.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: MAX_RENDITION_EDGE_PX, height: 267 });
    expect(decoder.decoded).toBe(1);
    expect(decoder.disposed).toBe(1);
  });
});
