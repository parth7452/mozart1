// What a run captured, as the contract hands it to the job (ADR 0057 §9): one
// `RunCapture` per capture, with its bytes, and a `RunCaptureSummary` without
// them for the result. Built while the run's credential is still held, because
// the username is replaced in a capture's page path as the runner replaces it
// in a snapshot and a download's name.
//
// The worker holds a capture's bytes as they came, in a Buffer, which lives
// outside the JavaScript heap and costs its own length. They are base64'd only
// as they are sent, a piece at a time (http.ts), so holding a capture never
// costs a third again in a string, and sending one never builds the whole
// answer in memory.
import { createHash } from 'node:crypto';
import { PORTAL_LIMITS, withoutUsername, type RunCapture, type RunCaptureSummary, type RunnerCapture } from './portal';

/** A path segment ASP.NET's cookieless mode writes: `(S(…))`, `(F(…))`, `(X(1)S(…))`. Its `F` form is an authentication ticket. */
const COOKIELESS_SEGMENT = /\([A-Za-z]\(/;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
/** The longest extension a shortened filename keeps. */
const EXTENSION_MAX = 16;

/** A capture as the worker holds it: the contract's `RunCapture` less its body, and the bytes. */
export interface HeldCapture {
  readonly capture: Omit<RunCapture, 'bodyBase64'>;
  readonly bytes: Buffer;
}

/**
 * The path a capture was made on, as the contract's `pagePath` takes it. It is
 * the URL's pathname and nothing more. Each segment's `;` parameters go
 * (`;jsessionid=` is a session token), and so does every ASP.NET cookieless
 * segment. The username becomes the runner's placeholder, because a portal can
 * put the signed-in user in its paths. A path longer than the contract allows
 * is cut to fit.
 */
export function capturePagePath(pathname: string, username: string): string {
  if (!pathname.startsWith('/')) return '/';
  const segments = pathname
    .split('/')
    .map((segment) => segment.split(';')[0]!)
    .filter((segment, i) => i === 0 || !COOKIELESS_SEGMENT.test(segment));
  const path = withoutUsername(segments.join('/').replace(CONTROL_CHARACTERS, ''), username);
  const kept = path === '' ? '/' : path;
  return kept.length > PORTAL_LIMITS.pathMax ? kept.slice(0, PORTAL_LIMITS.pathMax) : kept;
}

/**
 * A capture's filename as the contract takes one: no control characters, and
 * at most `filenameMax` UTF-16 units. A longer name keeps its extension, and
 * a surrogate pair is never split. A name with nothing left is `fallback`.
 */
export function captureFilename(name: string, fallback: string): string {
  const clean = name.replace(CONTROL_CHARACTERS, '_').trim();
  const whole = clean === '' ? fallback : clean;
  if (whole.length <= PORTAL_LIMITS.filenameMax) return whole;
  const dot = whole.lastIndexOf('.');
  const extension = dot > 0 && whole.length - dot <= EXTENSION_MAX ? whole.slice(dot) : '';
  let base = '';
  for (const character of whole.slice(0, whole.length - extension.length)) {
    if (base.length + character.length + extension.length > PORTAL_LIMITS.filenameMax) break;
    base += character;
  }
  return `${base}${extension}`;
}

/**
 * One capture as the worker holds it until `GET /runs/:runId/captures/:index`
 * sends it. The bytes are the runner's own when they fill their buffer, and a
 * copy when they are a view into a larger one, so what is held is what is
 * counted.
 */
export function heldCapture(runId: string, index: number, capture: RunnerCapture, username: string): HeldCapture {
  const { bytes } = capture;
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  // A copy into memory of its own: `Buffer.from` would put a small one in Node's shared pool.
  const held = whole ? Buffer.from(bytes.buffer, 0, bytes.byteLength) : Buffer.alloc(bytes.byteLength);
  if (!whole) held.set(bytes);
  return {
    capture: {
      runId,
      index,
      kind: capture.kind,
      stepName: capture.stepName,
      filename: captureFilename(capture.filename, capture.kind === 'page_snapshot' ? `${capture.stepName}.html` : 'download'),
      contentType: capture.mimeType,
      pagePath: capturePagePath(capture.pagePath, username),
      snapshotRuleVersion: capture.snapshotRuleVersion,
      capturedAt: capture.capturedAt,
      sha256: createHash('sha256').update(held).digest('hex'),
    },
    bytes: held,
  };
}

/**
 * The capture as the contract's schema checks it. Its body is left empty
 * here: `bodyBase64` is Buffer's own encoding of the held bytes, made as they
 * are sent, and so is base64 by construction.
 */
export function checkableCapture(held: HeldCapture): RunCapture {
  return { ...held.capture, bodyBase64: '' };
}

/** A capture as the result lists it: no bytes, no filename and no path. */
export function captureSummary(held: HeldCapture): RunCaptureSummary {
  const { index, kind, stepName, sha256 } = held.capture;
  return { index, kind, stepName, sha256, byteLength: held.bytes.byteLength };
}
