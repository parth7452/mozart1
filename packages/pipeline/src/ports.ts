/**
 * What the pipeline needs from the outside world.
 *
 * Steps are pure functions over these ports (ADR 0007), so the whole pipeline
 * runs in a test with no database, no network and no workflow runtime — and the
 * Inngest binding in Phase 1b is a thin adapter rather than a rewrite.
 */

import type { CaseState } from '@recouple/core-domain';
import type {
  Classifier,
  DocType,
  ExtractedField,
  Extractor,
  ModelCallRecord,
  OcrProvider,
} from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';

export interface StoredDocument {
  readonly documentId: string;
  readonly orgId: string;
  readonly sha256: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
  readonly pageText?: readonly string[];
  readonly requiresSplit: boolean;
}

export interface CaseRecord {
  readonly deductionId: string;
  readonly orgId: string;
  readonly state: CaseState;
  readonly claimId?: string;
  readonly retailerName?: string;
  readonly deductionAmountCents?: number;
}

export interface PipelineStore {
  /** Returns an existing document with the same (org, sha256), if any. */
  findDocumentByHash(orgId: string, sha256: string): Promise<StoredDocument | undefined>;
  putDocument(document: Omit<StoredDocument, 'documentId'>): Promise<StoredDocument>;

  recordScan(documentId: string, verdict: ScanVerdict): Promise<void>;
  latestScan(documentId: string): Promise<ScanVerdict | undefined>;

  recordClassification(
    documentId: string,
    docType: DocType,
    confidence: number,
  ): Promise<void>;
  recordExtraction(input: {
    documentId: string;
    deductionId?: string;
    docType: DocType;
    extractor: string;
    schemaVersion: string;
    fields: readonly ExtractedField[];
    document: unknown;
  }): Promise<void>;
  latestExtraction(documentId: string): Promise<{ docType: DocType; document: unknown } | undefined>;

  recordModelCall(call: ModelCallRecord): Promise<void>;

  /** The text layer for a document, once something has produced one. */
  recordPages(
    documentId: string,
    pages: readonly { readonly page: number; readonly text: string }[],
  ): Promise<void>;
  pagesFor(documentId: string): Promise<readonly string[] | undefined>;

  openCase(input: {
    orgId: string;
    claimId?: string;
    retailerName?: string;
    deductionAmountCents?: number;
  }): Promise<CaseRecord>;
  linkDocument(deductionId: string, documentId: string, role: 'notice' | 'evidence'): Promise<void>;
  transitionCase(deductionId: string, to: CaseState): Promise<CaseRecord>;
  appendEvent(input: {
    orgId: string;
    deductionId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  getCase(deductionId: string): Promise<CaseRecord | undefined>;
  documentsForCase(deductionId: string): Promise<readonly StoredDocument[]>;
}

export interface Scanner {
  readonly name: string;
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

export interface PipelineDeps {
  readonly store: PipelineStore;
  readonly scanner: Scanner;
  readonly classifier: Classifier;
  readonly extractor: Extractor;
  /**
   * Optional. When a document has no text layer and no provider is configured,
   * extraction still runs — the fields just come back unverifiable, which is
   * recorded rather than hidden (ADR 0009).
   */
  readonly ocr?: OcrProvider;
  /** Injected so tests are deterministic and events carry a real event_time. */
  readonly now: () => Date;
}
