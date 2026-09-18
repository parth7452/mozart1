/**
 * The Phase 1 steps: ingest → scan → classify → extract.
 *
 * Each one is separately callable and separately re-runnable. Re-ingesting the
 * same bytes returns the existing document rather than creating a second one,
 * which is what makes the whole chain safe to retry.
 */

import { applyTransition } from '@recouple/core-domain';
import {
  type DocType,
  type ExtractionResult,
  type ModelCallRecord,
  reconcileNotice,
  type Reconciliation,
} from '@recouple/extraction';
import {
  acceptUpload,
  assertScannedClean,
  RejectedUploadError,
  type ScanVerdict,
} from '@recouple/ingest';
import type { CaseRecord, PipelineDeps, StoredDocument } from './ports';

export interface IngestInput {
  readonly orgId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly declaredMimeType?: string;
  readonly source: 'web_upload' | 'email_in';
  /** Known text layer, when the caller already has one. */
  readonly pageText?: readonly string[];
}

export interface IngestResult {
  readonly document: StoredDocument;
  readonly verdict: ScanVerdict;
  readonly deduplicated: boolean;
  readonly warnings: readonly string[];
}

/**
 * Hardens, stores and scans. Rejections come back as `RejectedUploadError` with
 * a code — the caller shows the user why, rather than a silent failure.
 */
export async function ingestDocument(
  input: IngestInput,
  deps: PipelineDeps,
): Promise<IngestResult> {
  const accepted = acceptUpload(input.bytes, input.filename, {
    ...(input.declaredMimeType !== undefined ? { declaredMimeType: input.declaredMimeType } : {}),
  });

  const existing = await deps.store.findDocumentByHash(input.orgId, accepted.sha256);
  if (existing !== undefined) {
    const verdict = (await deps.store.latestScan(existing.documentId)) ?? {
      status: 'error' as const,
      scanner: 'none',
      detail: 'previously stored document has no scan verdict',
    };
    return { document: existing, verdict, deduplicated: true, warnings: accepted.warnings };
  }

  const document = await deps.store.putDocument({
    orgId: input.orgId,
    sha256: accepted.sha256,
    filename: input.filename,
    mimeType: accepted.mimeType,
    byteSize: accepted.byteSize,
    bytes: input.bytes,
    ...(input.pageText !== undefined ? { pageText: input.pageText } : {}),
    requiresSplit: accepted.requiresSplit,
  });

  const verdict = await deps.scanner.scan(input.bytes);
  await deps.store.recordScan(document.documentId, verdict);

  return { document, verdict, deduplicated: false, warnings: accepted.warnings };
}

/** Turns a stored document into the payload a reader model is given. */
async function readablePayload(document: StoredDocument, deps: PipelineDeps) {
  const verdict = await deps.store.latestScan(document.documentId);
  // The gate. Nothing below this line runs on an unscanned or unclean file.
  assertScannedClean(verdict, document.documentId);

  return {
    documentId: document.documentId,
    orgId: document.orgId,
    filename: document.filename,
    mimeType: document.mimeType,
    base64: Buffer.from(document.bytes).toString('base64'),
    byteSize: document.byteSize,
    ...(document.pageText !== undefined ? { pageText: document.pageText } : {}),
  };
}

export interface ClassifyResult {
  readonly docType: DocType;
  readonly confidence: number;
  readonly call: ModelCallRecord;
}

export async function classifyDocument(
  document: StoredDocument,
  deps: PipelineDeps,
): Promise<ClassifyResult> {
  const payload = await readablePayload(document, deps);
  const result = await deps.classifier.classify(payload);
  await deps.store.recordModelCall(result.call);
  await deps.store.recordClassification(document.documentId, result.docType, result.confidence);
  return result;
}

export async function extractDocument(
  document: StoredDocument,
  docType: DocType,
  deps: PipelineDeps,
  deductionId?: string,
): Promise<ExtractionResult> {
  const payload = await readablePayload(document, deps);
  const result = await deps.extractor.extract(payload, docType);
  await deps.store.recordModelCall(result.call);
  await deps.store.recordExtraction({
    documentId: document.documentId,
    ...(deductionId !== undefined ? { deductionId } : {}),
    docType: result.docType,
    extractor: result.extractor,
    schemaVersion: result.schemaVersion,
    fields: result.fields,
    document: result.document,
  });
  return result;
}

export interface ProcessedDocument {
  readonly ingest: IngestResult;
  readonly classification?: ClassifyResult;
  readonly extraction?: ExtractionResult;
  readonly case?: CaseRecord;
  /** Why the document stopped where it did, when it did not go all the way. */
  readonly haltedBecause?: string;
}

/**
 * Ingest → classify → extract for one file, opening a case when the file turns
 * out to be a deduction notice.
 *
 * A file that is not clean stops here, with a reason. That is the invariant-4
 * gate doing its job, not an error to be worked around.
 */
export async function processUpload(
  input: IngestInput,
  deps: PipelineDeps,
  options: { readonly attachToCase?: string } = {},
): Promise<ProcessedDocument> {
  const ingest = await ingestDocument(input, deps);

  if (ingest.verdict.status !== 'clean') {
    return {
      ingest,
      haltedBecause: `not scanned clean: ${ingest.verdict.status} (${ingest.verdict.scanner})`,
    };
  }

  const classification = await classifyDocument(ingest.document, deps);

  let caseRecord: CaseRecord | undefined;
  if (options.attachToCase !== undefined) {
    caseRecord = await deps.store.getCase(options.attachToCase);
  }

  const extraction = await extractDocument(
    ingest.document,
    classification.docType,
    deps,
    caseRecord?.deductionId,
  );

  if (classification.docType === 'deduction_notice' && caseRecord === undefined) {
    caseRecord = await openCaseFromNotice(ingest.document, extraction, deps);
  } else if (caseRecord !== undefined) {
    await deps.store.linkDocument(caseRecord.deductionId, ingest.document.documentId, 'evidence');
    await deps.store.appendEvent({
      orgId: input.orgId,
      deductionId: caseRecord.deductionId,
      eventType: 'evidence.uploaded',
      payload: {
        document_id: ingest.document.documentId,
        doc_type: classification.docType,
        filename: input.filename,
      },
    });
  }

  return {
    ingest,
    classification,
    extraction,
    ...(caseRecord !== undefined ? { case: caseRecord } : {}),
  };
}

function fieldValue(document: unknown, path: readonly string[]): unknown {
  let node: unknown = document;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Opens a case from an extracted notice and walks it discovered → classified
 * through the state machine, so the transition table is what governs the case's
 * life rather than an ad-hoc string assignment.
 */
export async function openCaseFromNotice(
  document: StoredDocument,
  extraction: ExtractionResult,
  deps: PipelineDeps,
): Promise<CaseRecord> {
  const claimId = fieldValue(extraction.document, ['claim_id', 'value']);
  const retailer = fieldValue(extraction.document, ['retailer_name', 'value']);

  const opened = await deps.store.openCase({
    orgId: document.orgId,
    ...(typeof claimId === 'string' ? { claimId } : {}),
    ...(typeof retailer === 'string' ? { retailerName: retailer } : {}),
  });

  await deps.store.linkDocument(opened.deductionId, document.documentId, 'notice');
  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    eventType: 'case.discovered',
    payload: {
      document_id: document.documentId,
      claim_id: typeof claimId === 'string' ? claimId : null,
      retailer_name: typeof retailer === 'string' ? retailer : null,
    },
  });

  // The guard is doc_type_known; the classifier has just answered it.
  applyTransition(opened.state, 'classified', { doc_type_known: true });
  const classified = await deps.store.transitionCase(opened.deductionId, 'classified');
  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    eventType: 'case.classified',
    payload: { doc_type: extraction.docType, schema_version: extraction.schemaVersion },
  });

  return classified;
}

export { RejectedUploadError };

/**
 * Reconciles a case from whatever typed documents it already has. Returns
 * undefined when there is no notice yet — there is nothing to reconcile against.
 */
export async function reconcileCase(
  deductionId: string,
  deps: PipelineDeps,
): Promise<Reconciliation | undefined> {
  const documents = await deps.store.documentsForCase(deductionId);
  const byType = new Map<DocType, unknown>();

  for (const document of documents) {
    const extraction = await deps.store.latestExtraction(document.documentId);
    if (extraction === undefined) continue;
    if (!byType.has(extraction.docType)) byType.set(extraction.docType, extraction.document);
  }

  const notice = byType.get('deduction_notice');
  if (notice === undefined) return undefined;

  const shipment = byType.get('bol') ?? byType.get('pod');
  return reconcileNotice({
    notice: notice as never,
    ...(byType.has('invoice') ? { invoice: byType.get('invoice') as never } : {}),
    ...(byType.has('po') ? { po: byType.get('po') as never } : {}),
    ...(shipment !== undefined ? { shipment: shipment as never } : {}),
  });
}
