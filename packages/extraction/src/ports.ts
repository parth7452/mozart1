/**
 * The ports the ingest/extraction pipeline talks through. Tests supply fakes;
 * production supplies Claude, Reducto, ClamAV and Supabase (ADR 0007).
 */

import type { ModelRole } from './models';

export const DOC_TYPES = [
  'deduction_notice',
  'remittance_advice',
  'invoice',
  'po',
  'bol',
  'pod',
  'asn',
  'promo_agreement',
  'price_agreement',
  'routing_guide',
  'other',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/** A document as the pipeline passes it around: bytes plus what we know. */
export interface DocumentPayload {
  readonly documentId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly mimeType: string;
  /** Base64, no newlines — the Messages API rejects wrapped base64. */
  readonly base64: string;
  readonly byteSize: number;
  /** Extracted text per page, 1-indexed by position, when a text layer exists. */
  readonly pageText?: readonly string[];
  /**
   * Where that text came from. `embedded` is the document's own text layer and
   * is exact. `ocr` is a machine transcription of an image and may carry
   * character-level errors, so the image — not the text — is authoritative.
   */
  readonly pageTextSource?: 'embedded' | 'ocr';
}

export type CallOutcome = 'ok' | 'schema_mismatch' | 'refusal' | 'error' | 'timeout';

/** One row of `model_calls`. Recorded whether the call succeeded or not. */
export interface ModelCallRecord {
  readonly purpose: ModelRole | 'decide' | 'playbook_draft';
  readonly provider: 'anthropic' | 'reducto' | 'jev';
  readonly modelVersion: string;
  readonly documentId?: string;
  readonly deductionId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly costMicros: number;
  readonly latencyMs: number;
  readonly outcome: CallOutcome;
  readonly detail?: string;
}

export interface ClassificationResult {
  readonly docType: DocType;
  readonly confidence: number;
  readonly call: ModelCallRecord;
}

export interface Classifier {
  classify(document: DocumentPayload): Promise<ClassificationResult>;
}

/** One extracted field, flattened out of the document schema. */
export interface ExtractedField {
  readonly fieldPath: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly sourcePage: number;
  readonly sourceQuote: string;
  readonly sourceBbox: readonly number[] | null;
  /**
   * How the quote was matched against the page. `ocr_confusion` means it matched
   * only after allowing for glyphs OCR routinely confuses (O/0, I/1, S/5), which
   * a reviewer should be told rather than shown as a plain tick.
   */
  readonly quoteMatch?: 'exact' | 'punctuation' | 'ocr_confusion';
  /**
   * Whether the quote was found in the page's own text. Null when the page has
   * no text layer to check against (a scan), which is not the same as false.
   */
  readonly quoteVerified: boolean | null;
}

export interface ExtractionResult {
  readonly docType: DocType;
  readonly schemaVersion: string;
  readonly extractor: string;
  readonly fields: readonly ExtractedField[];
  /** The reassembled document object, for callers that want it whole. */
  readonly document: unknown;
  /**
   * Whether `document` satisfied the typed schema. Fields are stored either
   * way — a partial read is still evidence — but only a validated document is
   * safe to reconcile against, since reconciliation reads typed paths.
   */
  readonly validated: boolean;
  readonly issues: readonly { readonly path: string; readonly problem: string }[];
  readonly call: ModelCallRecord;
}

export interface Extractor {
  readonly name: string;
  extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult>;
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly call: ModelCallRecord,
  ) {
    super(message);
  }
}

/** Raised when a model declines the request (`stop_reason: "refusal"`). */
export class ModelRefusalError extends ExtractionError {}
