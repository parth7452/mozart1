/**
 * Small, real PDFs for the upload door's tests: every object where its
 * cross-reference entry says it is, so a reader opens them the way it would
 * open a customer's file, and a test that says "a reader would run this"
 * means it.
 */

import { deflateSync } from 'node:zlib';

export type Body = string | Buffer;

const HEADER = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');

const bytesOf = (body: Body): Buffer => (typeof body === 'string' ? Buffer.from(body, 'latin1') : body);

/** A catalog, a page tree and one page: objects 1, 2 and 3. `catalog` and `page` add keys. */
export function onePage(catalog = '', page = ''): Map<number, Body> {
  return new Map<number, Body>([
    [1, `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${page} >>`],
  ]);
}

/** A stream object's body: its dictionary, with `/Length` set, and its data. */
export function stream(dictionary: string, data: Body): Buffer {
  const bytes = bytesOf(data);
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

/** Objects numbered as given, a classic `xref` table and a trailer naming object 1 as the root. */
export function classicPdf(objects: ReadonlyMap<number, Body>): Uint8Array {
  const parts: Buffer[] = [HEADER];
  let offset = HEADER.length;
  const offsets = new Map<number, number>();
  for (const [number, body] of [...objects].sort(([a], [b]) => a - b)) {
    const chunk = Buffer.concat([
      Buffer.from(`${number} 0 obj\n`, 'latin1'),
      bytesOf(body),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.set(number, offset);
    parts.push(chunk);
    offset += chunk.length;
  }
  const size = Math.max(...objects.keys()) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n += 1) {
    const at = offsets.get(n);
    xref += at === undefined ? '0000000000 65535 f \n' : `${String(at).padStart(10, '0')} 00000 n \n`;
  }
  parts.push(
    Buffer.from(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'),
  );
  return new Uint8Array(Buffer.concat(parts));
}

export interface ObjectStreamOptions {
  /** The object stream's dictionary, less `/N`, `/First` and `/Length`. */
  readonly dictionary?: string;
  /** How its data is encoded. */
  readonly encode?: (text: Buffer) => Buffer;
  /** Written in place of the offset the header would give each object. */
  readonly offsets?: readonly number[];
  /**
   * Cross-reference rows that name another object's slot in the object
   * stream: `[4, 5]` sends a reader looking for object 4 to the slot object 5
   * is labelled with, whatever the body says object 4 is.
   */
  readonly slotFor?: ReadonlyMap<number, number>;
}

/**
 * `plain` objects in the body, `compressed` ones inside one object stream,
 * and a cross-reference stream (type 2 entries) that is the only way to find
 * them, as a modern writer lays a file out.
 */
export function objectStreamPdf(
  plain: ReadonlyMap<number, Body>,
  compressed: ReadonlyMap<number, string>,
  options: ObjectStreamOptions = {},
): Uint8Array {
  const all = [...plain.keys(), ...compressed.keys()];
  const streamNumber = Math.max(...all) + 1;
  const xrefNumber = streamNumber + 1;

  const members = [...compressed].sort(([a], [b]) => a - b);
  const bodies: string[] = [];
  const pairs: string[] = [];
  let at = 0;
  members.forEach(([number, body], i) => {
    pairs.push(`${number} ${options.offsets?.[i] ?? at}`);
    bodies.push(body);
    at += body.length + 1;
  });
  const head = `${pairs.join(' ')}\n`;
  const text = Buffer.from(head + bodies.join('\n'), 'latin1');
  const data = (options.encode ?? ((t: Buffer) => deflateSync(t)))(text);
  const objectStream = stream(
    `${options.dictionary ?? '/Type /ObjStm /Filter /FlateDecode'} /N ${members.length} /First ${head.length}`,
    data,
  );

  const parts: Buffer[] = [HEADER];
  let offset = HEADER.length;
  const offsets = new Map<number, number>();
  const write = (number: number, body: Body) => {
    const chunk = Buffer.concat([
      Buffer.from(`${number} 0 obj\n`, 'latin1'),
      bytesOf(body),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.set(number, offset);
    parts.push(chunk);
    offset += chunk.length;
  };
  for (const [number, body] of [...plain].sort(([a], [b]) => a - b)) write(number, body);
  write(streamNumber, objectStream);

  // One row per object: type, then two fields, widths [1 4 2].
  const size = xrefNumber + 1;
  const rows = Buffer.alloc(size * 7);
  const row = (n: number, type: number, a: number, b: number) => {
    rows.writeUInt8(type, n * 7);
    rows.writeUInt32BE(a, n * 7 + 1);
    rows.writeUInt16BE(b, n * 7 + 5);
  };
  row(0, 0, 0, 65535);
  for (const [n, at] of offsets) row(n, 1, at, 0);
  members.forEach(([n], i) => row(n, 2, streamNumber, i));
  for (const [n, target] of options.slotFor ?? []) {
    row(n, 2, streamNumber, members.findIndex(([m]) => m === target));
  }
  row(xrefNumber, 1, offset, 0);
  const xrefAt = offset;
  write(xrefNumber, stream(`/Type /XRef /Size ${size} /W [1 4 2] /Root 1 0 R`, rows));
  parts.push(Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

/** Random-looking bytes from a fixed seed, so a test's "compressed data" is the same every run. */
export function noise(length: number, seed = 0x9e3779b9): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
