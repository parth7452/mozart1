/**
 * Upload hardening (plan §7).
 *
 * Everything here runs before a byte reaches a model or a store: allow-listed
 * types checked against magic bytes rather than the client's claim, a size cap,
 * a real decompression check for zip bombs, and refusal of encrypted or
 * active-content PDFs.
 */

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { judgeOpenAction } from './pdf-open-action';
import { scanPdfNames } from './pdf-names';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The Messages API rejects a request payload above 32 MB. */
export const MAX_MODEL_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** Above this, a PDF must be split before it can be read in one request. */
export const MAX_PAGES_PER_READ = 100;

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/**
 * An email body is not an upload, and this is the type it gets.
 *
 * It is deliberately outside `ALLOWED_MIME_TYPES`: an uploaded file is opaque
 * bytes whose type we determine from magic bytes, because the sender's claim is
 * worthless. An email body is text the mail server already parsed and handed us
 * as text — there are no magic bytes to check and no file to have lied about its
 * type, so sniffing it would be checking the wrong thing. Only
 * `acceptEmailBody` produces it, so no upload path can reach it.
 */
export const EMAIL_BODY_MIME = 'text/plain' as const;

export type DocumentMimeType = AllowedMimeType | typeof EMAIL_BODY_MIME;

export type RejectionCode =
  | 'empty_file'
  | 'body_too_short'
  | 'too_large'
  | 'type_not_allowed'
  | 'content_does_not_match_type'
  | 'encrypted_pdf'
  | 'active_content_pdf'
  | 'decompression_bomb'
  | 'malformed_pdf';

export class RejectedUploadError extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

const SIGNATURES: Record<AllowedMimeType, (bytes: Uint8Array) => boolean> = {
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) =>
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  'image/webp': (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
};

/** What the bytes actually are, regardless of what the upload claimed. */
export function detectMimeType(bytes: Uint8Array): AllowedMimeType | undefined {
  for (const type of ALLOWED_MIME_TYPES) {
    if (SIGNATURES[type](bytes)) return type;
  }
  return undefined;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- PDF inspection ---------------------------------------------------------

/**
 * Names that make a PDF do something rather than show something. Each is
 * matched as a whole name, the way a reader parses it: `/AA` is the start of
 * a subset font's name (`/AAAAAB+Arial`, ISO 32000-1 §9.6.4) and of Apple's
 * `/AAPL:Keywords`, and a substring match refused ordinary invoices for their
 * fonts. `/EmbeddedFiles`, the attachments' name tree, is listed because the
 * substring match caught it through `/EmbeddedFile`.
 */
const PDF_ACTIVE_CONTENT = [
  '/JavaScript',
  '/JS',
  '/Launch',
  '/EmbeddedFile',
  '/EmbeddedFiles',
  '/OpenAction',
  '/AA',
  '/RichMedia',
  '/XFA',
];

/**
 * A name runs from its `/` to the next whitespace or delimiter (ISO 32000-1
 * §7.3.5), which is where pdf.js and MuPDF end one. PDFium also reads `0xFF`
 * as whitespace, so it ends a name here too: a byte one reader splits on and
 * we do not is a key that reader runs and we never saw.
 */
const PDF_NAME = /\/[^\x00\t\n\f\r ()<>[\]{}/%\xFF]*/g;

/**
 * The active-content names this PDF carries, in the list's order.
 *
 * `#` and two hex digits stand for one character inside a name, so `/J#53` is
 * `/JS` to a reader and is decoded before it is compared.
 */
function activeContentOf(latin1: string): string[] {
  const found = namesIn(latin1, new Set(PDF_ACTIVE_CONTENT));
  return PDF_ACTIVE_CONTENT.filter((marker) => found.has(marker));
}

/** Which of `wanted` appear anywhere in the bytes as whole, decoded names. */
function namesIn(latin1: string, wanted: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  for (const [raw] of latin1.matchAll(PDF_NAME)) {
    const name = raw.includes('#')
      ? raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      : raw;
    if (wanted.has(name)) found.add(name);
  }
  return found;
}

/** The names that mark an object stream, `/Type /ObjStm` or its `/First`. */
const OBJECT_STREAM_NAMES: ReadonlySet<string> = new Set(['/ObjStm', '/First']);

export interface PdfInspection {
  readonly encrypted: boolean;
  /** The markers that block this file, in `PDF_ACTIVE_CONTENT`'s order. */
  readonly activeContent: readonly string[];
  /**
   * Each `/OpenAction` whose value is a plain destination, and so does not
   * block (`pdf-open-action.ts`). Empty whenever the raw scan decided.
   */
  readonly allowedOpenActions: readonly string[];
  /**
   * How the markers were found: `tokenized` read names where a reader reads
   * them (`pdf-names.ts`); `raw` matched them anywhere in the bytes, because
   * tokenizing could not account for the file (`rawScanReason`).
   */
  readonly nameScan: 'tokenized' | 'raw';
  readonly rawScanReason?: string;
  /**
   * True when the raw scan decided and the file has object streams. The raw
   * scan cannot see inside them, and a file can be built to fall back on
   * purpose (one unterminated string), so such a file is refused rather than
   * read blind (`malformed_pdf`).
   */
  readonly objectStreamsUnread: boolean;
  readonly objectStreamsDecoded: number;
  readonly pageCount: number;
  readonly inflatedBytes: number;
  readonly streamsInspected: number;
}

const PDF_ACTIVE_CONTENT_SET: ReadonlySet<string> = new Set(PDF_ACTIVE_CONTENT);

/**
 * The most object-stream text the name scan will inflate and read, within the
 * bomb budget. The bomb loop inflates only a file's first 500 streams, so
 * without this a 2 MB file of ten thousand small object streams could have the
 * door read 256 MB of names — seconds of work for every upload. Past it, the
 * raw scan decides.
 */
export const MAX_OBJECT_STREAM_TEXT_BYTES = 64 * 1024 * 1024;

const OPEN_ACTION: ReadonlySet<string> = new Set(['/OpenAction']);

/**
 * The markers that block, read by the tokenizer where it can account for the
 * file and by the raw scan where it cannot. Over the file's own bytes the raw
 * scan is the stricter — it sees every name the tokenizer does, and refuses any
 * `/OpenAction`, because a value only it saw cannot be judged — but it cannot
 * see inside a compressed object stream. A file that falls back is exactly as
 * blind there as every file was before the tokenizer.
 */
function activeContentIn(
  bytes: Uint8Array,
  latin1: string,
  inflateBudget: number,
): Pick<
  PdfInspection,
  'activeContent' | 'allowedOpenActions' | 'nameScan' | 'rawScanReason' | 'objectStreamsUnread' | 'objectStreamsDecoded'
> {
  const scan = scanPdfNames(bytes, latin1, {
    wanted: PDF_ACTIVE_CONTENT_SET,
    valued: OPEN_ACTION,
    inflateBudget,
  });
  if (scan.mode === 'raw') {
    return {
      activeContent: activeContentOf(latin1),
      allowedOpenActions: [],
      nameScan: 'raw',
      rawScanReason: scan.reason,
      objectStreamsUnread: namesIn(latin1, OBJECT_STREAM_NAMES).size > 0,
      objectStreamsDecoded: 0,
    };
  }
  const blocking = new Set(scan.found);
  blocking.delete('/OpenAction');
  const allowedOpenActions: string[] = [];
  for (const site of scan.sites) {
    let verdict: ReturnType<typeof judgeOpenAction>;
    try {
      verdict = judgeOpenAction(site, scan);
    } catch {
      verdict = { allowed: false, reason: 'the value could not be read' };
    }
    if (verdict.allowed) allowedOpenActions.push(verdict.destination);
    else blocking.add('/OpenAction');
  }
  return {
    activeContent: PDF_ACTIVE_CONTENT.filter((marker) => blocking.has(marker)),
    allowedOpenActions,
    nameScan: 'tokenized',
    objectStreamsUnread: false,
    objectStreamsDecoded: scan.objectStreams,
  };
}

/** Budgets for the decompression check. A bomb blows one of these, not both. */
export interface BombLimits {
  readonly maxInflatedBytes: number;
  readonly maxRatio: number;
  readonly maxStreams: number;
}

export const DEFAULT_BOMB_LIMITS: BombLimits = {
  maxInflatedBytes: 256 * 1024 * 1024,
  maxRatio: 500,
  maxStreams: 500,
};

/**
 * Inflates the PDF's Flate streams under a byte budget.
 *
 * This is the check a size cap cannot do: a 40 KB file whose streams expand to
 * gigabytes is small on disk and fatal in a renderer. Streams that fail to
 * inflate are skipped — this is a safety check, not a parser, and a malformed
 * stream is the renderer's problem, not a reason to reject an otherwise good
 * document.
 *
 * Then reads the active-content markers where a reader reads names
 * (`pdf-names.ts`), object streams included, and falls back to matching them
 * anywhere in the bytes when it cannot account for the file.
 */
export function inspectPdf(
  bytes: Uint8Array,
  limits: BombLimits = DEFAULT_BOMB_LIMITS,
): PdfInspection {
  const latin1 = Buffer.from(bytes).toString('latin1');

  const trailerIndex = Math.max(latin1.lastIndexOf('trailer'), 0);
  const encrypted = latin1.includes('/Encrypt') && latin1.indexOf('/Encrypt') >= trailerIndex - 4096;

  const pageCount = (latin1.match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  let inflatedBytes = 0;
  let streamsInspected = 0;
  let cursor = 0;
  const budget = limits.maxInflatedBytes;

  while (streamsInspected < limits.maxStreams) {
    const start = latin1.indexOf('stream', cursor);
    if (start === -1) break;
    const end = latin1.indexOf('endstream', start);
    if (end === -1) break;

    let dataStart = start + 'stream'.length;
    if (latin1[dataStart] === '\r') dataStart += 1;
    if (latin1[dataStart] === '\n') dataStart += 1;

    const chunk = bytes.subarray(dataStart, end);
    cursor = end + 'endstream'.length;
    if (chunk.length === 0) continue;
    streamsInspected += 1;

    const remaining = budget - inflatedBytes;
    if (remaining <= 0) {
      throw new RejectedUploadError(
        'decompression_bomb',
        `PDF streams expand past the ${budget} byte budget`,
      );
    }

    try {
      const inflated = inflateSync(chunk, { maxOutputLength: remaining });
      inflatedBytes += inflated.byteLength;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ERR_BUFFER_TOO_LARGE') {
        throw new RejectedUploadError(
          'decompression_bomb',
          `a PDF stream inflates past the remaining ${remaining} byte budget`,
        );
      }
      // Not Flate, or not inflatable: not our business here.
    }
  }

  if (inflatedBytes > bytes.length * limits.maxRatio) {
    throw new RejectedUploadError(
      'decompression_bomb',
      `PDF streams expand ${Math.round(inflatedBytes / Math.max(1, bytes.length))}× — over the ${limits.maxRatio}× limit`,
    );
  }

  // After the bomb checks, so that a bomb is refused exactly as it always was.
  const names = activeContentIn(bytes, latin1, Math.min(limits.maxInflatedBytes, MAX_OBJECT_STREAM_TEXT_BYTES));

  return { encrypted, ...names, pageCount, inflatedBytes, streamsInspected };
}

export interface AcceptedUpload {
  readonly sha256: string;
  readonly mimeType: DocumentMimeType;
  readonly byteSize: number;
  readonly pageCount?: number;
  /** Things a reviewer should know that are not grounds for rejection. */
  readonly warnings: readonly string[];
  /** True when the file must be split before it can go to a reader in one call. */
  readonly requiresSplit: boolean;
}

export interface AcceptOptions {
  readonly declaredMimeType?: string;
  readonly maxBytes?: number;
  readonly bombLimits?: BombLimits;
}

/**
 * The front door. Either returns what we know about the bytes, or throws with a
 * code saying why they are not coming in.
 */
export function acceptUpload(
  bytes: Uint8Array,
  filename: string,
  options: AcceptOptions = {},
): AcceptedUpload {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const warnings: string[] = [];

  if (bytes.length === 0) {
    throw new RejectedUploadError('empty_file', `${filename} is empty`);
  }
  if (bytes.length > maxBytes) {
    throw new RejectedUploadError(
      'too_large',
      `${filename} is ${bytes.length} bytes, over the ${maxBytes} byte limit`,
    );
  }

  const detected = detectMimeType(bytes);
  if (detected === undefined) {
    throw new RejectedUploadError(
      'type_not_allowed',
      `${filename} is not one of ${ALLOWED_MIME_TYPES.join(', ')}`,
    );
  }
  // The declared type is a hint we check, never a fact we act on.
  if (options.declaredMimeType !== undefined && options.declaredMimeType !== detected) {
    warnings.push(
      `upload claimed ${options.declaredMimeType} but the bytes are ${detected}; using ${detected}`,
    );
  }

  let pageCount: number | undefined;
  let requiresSplit = bytes.length > MAX_MODEL_PAYLOAD_BYTES;

  if (detected === 'application/pdf') {
    const inspection = inspectPdf(bytes, options.bombLimits);
    if (inspection.encrypted) {
      throw new RejectedUploadError(
        'encrypted_pdf',
        `${filename} is encrypted: ask the sender for an unprotected copy`,
      );
    }
    if (inspection.activeContent.length > 0) {
      throw new RejectedUploadError(
        'active_content_pdf',
        `${filename} carries active content (${inspection.activeContent.join(', ')}): it must be flattened before ingest`,
      );
    }
    if (inspection.objectStreamsUnread) {
      throw new RejectedUploadError(
        'malformed_pdf',
        `${filename} could not be read the way a PDF reader reads it (${inspection.rawScanReason ?? 'unknown'}) ` +
          'and has compressed object streams, so what it would run cannot be checked: re-save or print it to PDF',
      );
    }
    pageCount = inspection.pageCount;
    if (inspection.pageCount > MAX_PAGES_PER_READ) {
      requiresSplit = true;
      warnings.push(
        `${inspection.pageCount} pages: this must be split into reads of ${MAX_PAGES_PER_READ} or fewer`,
      );
    }
    if (inspection.pageCount === 0) {
      warnings.push('no page objects found: the PDF may be malformed or use an unusual structure');
    }
  }

  return {
    sha256: sha256(bytes),
    mimeType: detected,
    byteSize: bytes.length,
    ...(pageCount !== undefined ? { pageCount } : {}),
    warnings,
    requiresSplit,
  };
}

/** A notice pasted into an email is a few hundred characters at least. */
export const MIN_EMAIL_BODY_CHARS = 200;

/** Above this an email body is not a notice; it is a thread, or an attack. */
export const MAX_EMAIL_BODY_BYTES = 1024 * 1024;

export interface AcceptBodyOptions {
  readonly minChars?: number;
  readonly maxBytes?: number;
}

/**
 * Accepts an email body as a document.
 *
 * Some retailers put the deduction in the message itself rather than attaching
 * it, and until now those emails were dropped without a word: the loop only read
 * attachments, so an inbox with a real notice in it produced nothing and said
 * nothing about why.
 *
 * The checks here are the ones that make sense for text. There is no type to
 * sniff — the mail server parsed it and handed us characters — so what is left
 * is: is there enough of it to be a notice, and not so much that it is a
 * forwarded thread or something trying to be expensive. The hash is taken over
 * the normalised text, so the same body arriving twice deduplicates the same way
 * a re-sent attachment does.
 */
export function acceptEmailBody(
  text: string,
  options: AcceptBodyOptions = {},
): { accepted: AcceptedUpload; bytes: Uint8Array; text: string } {
  const minChars = options.minChars ?? MIN_EMAIL_BODY_CHARS;
  const maxBytes = options.maxBytes ?? MAX_EMAIL_BODY_BYTES;

  // Normalised so that the same body through two mail servers hashes the same:
  // line endings differ, and trailing whitespace is nobody's content.
  const normalised = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

  if (normalised.length === 0) {
    throw new RejectedUploadError('empty_file', 'the email body is empty');
  }
  if (normalised.length < minChars) {
    throw new RejectedUploadError(
      'body_too_short',
      `the email body is ${normalised.length} characters, too short to be a notice ` +
        `(under ${minChars})`,
    );
  }

  const bytes = new TextEncoder().encode(normalised);
  if (bytes.length > maxBytes) {
    throw new RejectedUploadError(
      'too_large',
      `the email body is ${bytes.length} bytes, over the ${maxBytes} byte limit`,
    );
  }

  return {
    accepted: {
      sha256: sha256(bytes),
      mimeType: EMAIL_BODY_MIME,
      byteSize: bytes.length,
      warnings: [],
      requiresSplit: false,
    },
    bytes,
    text: normalised,
  };
}
