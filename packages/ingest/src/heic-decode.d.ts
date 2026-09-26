/** The part of `heic-decode` (ISC; libheif-js underneath, LGPL-3.0) that `rendition.ts` uses. */
declare module 'heic-decode' {
  interface DecodedImage {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  }
  interface ImageHandle {
    readonly width: number;
    readonly height: number;
    decode(): Promise<DecodedImage>;
  }
  type Images = ImageHandle[] & { dispose(): void };
  function decode(input: { buffer: Uint8Array }): Promise<DecodedImage>;
  namespace decode {
    function all(input: { buffer: Uint8Array }): Promise<Images>;
  }
  export default decode;
}
