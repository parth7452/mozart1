// The worker's HTTP plumbing: the bearer check, JSON answers, a capture's
// answer streamed, and a body read under a ceiling. An error answers
// `{ error: code }` and nothing else, never an echo of the request (the
// contract's `PORTAL_WORKER_ERRORS`).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HeldCapture } from './capture';
import { PORTAL_WORKER_ERRORS, type PortalWorkerErrorCode } from './portal';

/** How much of a capture is base64'd at a time as it is sent: a multiple of 3, so the pieces join into one encoding. */
const CAPTURE_PIECE_BYTES = 3 * 256 * 1024;

/**
 * A check of `Authorization: Bearer <token>` in constant time. Both sides are
 * hashed first, so the comparison is always of 32 bytes and says nothing about
 * the token's length (ADR 0047's inbound secret is compared the same way).
 */
export function bearerCheck(token: string): (header: string | undefined) => boolean {
  const expected = sha256(token);
  return (header) => {
    const presented = typeof header === 'string' && header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7) : '';
    // Hashed and compared even when nothing was presented, so a missing header costs what a wrong one does.
    const matches = timingSafeEqual(sha256(presented), expected);
    return matches && presented !== '';
  };
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

/** A JSON answer that no cache keeps and no browser sniffs. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

/**
 * A capture's answer, the contract's `RunCapture`, as JSON: its fields, then
 * `bodyBase64`, whose base64 is made from the held bytes a piece at a time as
 * the socket takes it. The length is known before the first byte is sent, and
 * base64 needs no escaping in a JSON string. A caller that goes away mid-answer
 * rejects the promise, and the socket is closed.
 */
export async function sendCapture(res: ServerResponse, held: HeldCapture): Promise<void> {
  const fields = JSON.stringify(held.capture);
  const head = `${fields.slice(0, -1)},"bodyBase64":"`;
  const tail = '"}';
  const bodyLength = 4 * Math.ceil(held.bytes.byteLength / 3);
  res.writeHead(200, { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(head) + bodyLength + tail.length) });
  // A byte stream, so what waits for the socket is bounded in bytes, not in pieces.
  await pipeline(Readable.from(pieces(head, held.bytes, tail), { objectMode: false }), res);
}

function* pieces(head: string, bytes: Buffer, tail: string): Generator<string> {
  yield head;
  for (let offset = 0; offset < bytes.byteLength; offset += CAPTURE_PIECE_BYTES) {
    yield bytes.subarray(offset, offset + CAPTURE_PIECE_BYTES).toString('base64');
  }
  yield tail;
}

/** One of the contract's errors, with the status it is sent with. */
export function sendError(res: ServerResponse, code: PortalWorkerErrorCode): void {
  const headers: Record<string, string> =
    code === 'unauthorized' ? { 'www-authenticate': 'Bearer' } : code === 'busy' ? { 'retry-after': '30' } : {};
  sendJson(res, PORTAL_WORKER_ERRORS[code], { error: code }, headers);
}

/**
 * A 413, and then the socket closed, after the answer is on the wire and never
 * before: a request destroyed first would reach the caller as a transport
 * failure, which cannot be told from a worker that is down.
 */
export function refuseTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('connection', 'close');
  res.on('finish', () => req.destroy());
  sendError(res, 'too_large');
}

export type ReadBody = { readonly tooLarge: false; readonly bytes: Buffer } | { readonly tooLarge: true };

/**
 * The body, or `tooLarge` once it passes `maxBytes`. Past the ceiling it stops
 * keeping bytes but reads on, so the answer can still be sent (a chunked body
 * declares no length to refuse it by).
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<ReadBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { tooLarge: false, bytes: Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}
