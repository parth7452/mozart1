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

export type RejectionCode =
  | 'empty_file'
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

const PDF_ACTIVE_CONTENT = [
  '/JavaScript',
  '/JS',
  '/Launch',
  '/EmbeddedFile',
  '/OpenAction',
  '/AA',
  '/RichMedia',
  '/XFA',
];

export interface PdfInspection {
  readonly encrypted: boolean;
  readonly activeContent: readonly string[];
  readonly pageCount: number;
  readonly inflatedBytes: number;
  readonly streamsInspected: number;
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
 */
export function inspectPdf(
  bytes: Uint8Array,
  limits: BombLimits = DEFAULT_BOMB_LIMITS,
): PdfInspection {
  const latin1 = Buffer.from(bytes).toString('latin1');

  const trailerIndex = Math.max(latin1.lastIndexOf('trailer'), 0);
  const encrypted = latin1.includes('/Encrypt') && latin1.indexOf('/Encrypt') >= trailerIndex - 4096;

  const activeContent = PDF_ACTIVE_CONTENT.filter((marker) => latin1.includes(marker));
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

  return { encrypted, activeContent, pageCount, inflatedBytes, streamsInspected };
}

export interface AcceptedUpload {
  readonly sha256: string;
  readonly mimeType: AllowedMimeType;
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
