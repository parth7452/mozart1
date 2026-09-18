/**
 * The Phase 1 steps: ingest → scan → classify → extract.
 *
 * Each one is separately callable and separately re-runnable. Re-ingesting the
 * same bytes returns the existing document rather than creating a second one,
 * which is what makes the whole chain safe to retry.
 */

import { applyTransition, parseMoneyToCents } from '@recouple/core-domain';
import {
  locateQuote,
  OcrError,
  type DocType,
  type ExtractedField,
  type ExtractionResult,
  type ModelCallRecord,
  type OcrBlock,
  reconcileNotice,
  type Reconciliation,
} from '@recouple/extraction';
import {
  acceptEmailBody,
  acceptUpload,
  assertScannedClean,
  InboundEmailError,
  parseInboundEmail,
  RejectedUploadError,
  type InboundEmail,
  type PostmarkInboundPayload,
  type ScanVerdict,
} from '@recouple/ingest';
import type { CaseRecord, PipelineDeps, StoredDocument } from './ports';

export interface IngestInput {
  readonly orgId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly declaredMimeType?: string;
  /**
   * Where this came from, and which door it goes through.
   *
   * `email_body` is the one that is not a file: the mail server handed us text,
   * so there are no magic bytes to check and sniffing would be checking the
   * wrong thing. The gate it gets is `acceptEmailBody`'s, and the distinction
   * lives here rather than in a flag a caller could set, so no upload path can
   * reach it by mistake.
   */
  readonly source: 'web_upload' | 'email_in' | 'email_body';
  /** Known text layer, when the caller already has one. */
  readonly pageText?: readonly string[];
  readonly pageTextSource?: 'embedded' | 'ocr';
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
  const accepted =
    input.source === 'email_body'
      ? acceptEmailBody(new TextDecoder().decode(input.bytes)).accepted
      : acceptUpload(input.bytes, input.filename, {
          ...(input.declaredMimeType !== undefined
            ? { declaredMimeType: input.declaredMimeType }
            : {}),
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

/**
 * Turns a stored document into the payload a reader model is given, OCRing it
 * first when it has no text layer of its own.
 *
 * The text layer is what makes an extracted quote checkable, so a scan without
 * one is a document whose fields we cannot verify. OCR is best-effort: if it
 * fails, extraction still runs and the fields come back unverifiable, with the
 * failure recorded on model_calls rather than swallowed (ADR 0009).
 */
/**
 * A document read once, with the model calls that reading it cost.
 *
 * The calls are handed back rather than written: a document that opens a case
 * is read before the case exists, and a spend nobody can attribute to a case is
 * a spend nobody can bill for. `processUpload` records them once it knows.
 */
interface ReadableDocument {
  readonly payload: DocumentPayloadShape;
  readonly blocks: readonly OcrBlock[];
  readonly calls: readonly ModelCallRecord[];
}

async function readablePayload(
  document: StoredDocument,
  deps: PipelineDeps,
): Promise<ReadableDocument> {
  const verdict = await deps.store.latestScan(document.documentId);
  // The gate. Nothing below this line runs on an unscanned or unclean file.
  assertScannedClean(verdict, document.documentId);

  let pageText = document.pageText ?? (await deps.store.pagesFor(document.documentId));
  let textSource: 'embedded' | 'ocr' = 'embedded';
  let blocks: readonly OcrBlock[] = [];
  const calls: ModelCallRecord[] = [];

  const payload = {
    documentId: document.documentId,
    orgId: document.orgId,
    filename: document.filename,
    mimeType: document.mimeType,
    base64: Buffer.from(document.bytes).toString('base64'),
    byteSize: document.byteSize,
  };

  const needsOcr = pageText === undefined || pageText.length === 0 || pageText.every((t) => t.trim() === '');
  if (needsOcr && deps.ocr !== undefined) {
    try {
      const result = await deps.ocr.ocr(payload);
      calls.push(result.call);
      await deps.store.recordPages(document.documentId, result.pages);
      pageText = result.pages.map((page) => page.text);
      textSource = 'ocr';
      blocks = result.blocks;
    } catch (error) {
      if (error instanceof OcrError) {
        // A failed read is still a read that cost something, and a recorded
        // failure is the difference between "unverifiable" and "unexplained".
        calls.push(error.call);
      } else {
        throw error;
      }
    }
  }

  return {
    payload: {
      ...payload,
      ...(pageText !== undefined ? { pageText, pageTextSource: textSource } : {}),
    },
    blocks,
    calls,
  };
}

interface DocumentPayloadShape {
  readonly documentId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly base64: string;
  readonly byteSize: number;
  readonly pageText?: readonly string[];
  readonly pageTextSource?: 'embedded' | 'ocr';
}

/**
 * Gives each field the box of the OCR block its quote came from.
 *
 * Only when the quote lands in exactly one block: a reviewer follows a box to
 * decide whether to approve, so an ambiguous box is worse than none.
 */
export function attachBoxes(
  fields: readonly ExtractedField[],
  blocks: readonly OcrBlock[],
): ExtractedField[] {
  if (blocks.length === 0) return [...fields];
  return fields.map((field) => {
    const block = locateQuote(field.sourceQuote, field.sourcePage, blocks);
    return block === undefined ? field : { ...field, sourceBbox: block.bbox };
  });
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
  const readable = await readablePayload(document, deps);
  const result = await deps.classifier.classify(readable.payload);
  for (const call of [...readable.calls, result.call]) {
    await deps.store.recordModelCall(call);
  }
  await deps.store.recordClassification(document.documentId, result.docType, result.confidence);
  return result;
}

export async function extractDocument(
  document: StoredDocument,
  docType: DocType,
  deps: PipelineDeps,
  deductionId?: string,
): Promise<ExtractionResult> {
  const readable = await readablePayload(document, deps);
  const result = await readExtraction(readable, docType, deps);
  for (const call of readable.calls) {
    await deps.store.recordModelCall(withCase(call, deductionId));
  }
  await recordExtraction(document, result, deps, deductionId);
  return result;
}

/**
 * The extraction itself, recording nothing.
 *
 * Boxes are attached here rather than at read time because they are a property
 * of a field: the box is the OCR block the field's quote landed in, and a field
 * that cannot be located gets no box at all (a wrong box is worse than none).
 */
async function readExtraction(
  readable: ReadableDocument,
  docType: DocType,
  deps: PipelineDeps,
): Promise<ExtractionResult> {
  const extracted = await deps.extractor.extract(readable.payload, docType);
  return { ...extracted, fields: attachBoxes(extracted.fields, readable.blocks) };
}

async function recordExtraction(
  document: StoredDocument,
  result: ExtractionResult,
  deps: PipelineDeps,
  deductionId?: string,
): Promise<void> {
  await deps.store.recordModelCall(withCase(result.call, deductionId));
  await deps.store.recordExtraction({
    documentId: document.documentId,
    ...(deductionId !== undefined ? { deductionId } : {}),
    docType: result.docType,
    extractor: result.extractor,
    schemaVersion: result.schemaVersion,
    fields: result.fields,
    document: result.document,
  });
}

/** A model call, told which case it was spent on. */
function withCase(call: ModelCallRecord, deductionId?: string): ModelCallRecord {
  return deductionId === undefined ? call : { ...call, deductionId };
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
  options: {
    readonly attachToCase?: string;
    /**
     * Whether this upload may open a new case on its own. False for a document
     * that arrived by email from a sender we could not authenticate: the file is
     * still ingested, classified and extracted, but a human decides which case
     * it belongs to rather than an unauthenticated stranger creating one.
     */
    readonly allowCaseOpen?: boolean;
  } = {},
): Promise<ProcessedDocument> {
  const ingest = await ingestDocument(input, deps);

  if (ingest.verdict.status !== 'clean') {
    return {
      ingest,
      haltedBecause: `not scanned clean: ${ingest.verdict.status} (${ingest.verdict.scanner})`,
    };
  }

  // Read the document once. Classification and extraction both need the page
  // text, and on a scan that text costs money and carries the boxes a reviewer
  // follows — reading twice would pay twice and, because the second read finds
  // the stored text and so never calls OCR, would arrive with no boxes at all.
  const readable = await readablePayload(ingest.document, deps);

  const classification = await deps.classifier.classify(readable.payload);

  let caseRecord: CaseRecord | undefined;
  if (options.attachToCase !== undefined) {
    caseRecord = await deps.store.getCase(options.attachToCase);
  }

  const extraction = await readExtraction(readable, classification.docType, deps);

  // The case is opened before anything is recorded, because the notice that
  // opens a case is read before the case exists and every fact read from it —
  // and every micro-dollar spent reading it — belongs to that case. Opening
  // needs the extraction (the claim id is on the page), so this is the earliest
  // the case can exist.
  const mayOpenCase = options.allowCaseOpen ?? true;
  if (classification.docType === 'deduction_notice' && caseRecord === undefined && mayOpenCase) {
    caseRecord = await openCaseFromNotice(ingest.document, extraction, deps);
  }

  const deductionId = caseRecord?.deductionId;
  for (const call of [...readable.calls, classification.call]) {
    await deps.store.recordModelCall(withCase(call, deductionId));
  }
  await deps.store.recordClassification(
    ingest.document.documentId,
    classification.docType,
    classification.confidence,
  );
  await recordExtraction(ingest.document, extraction, deps, deductionId);

  if (options.attachToCase !== undefined && caseRecord !== undefined) {
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
    ...(classification.docType === 'deduction_notice' && caseRecord === undefined && !mayOpenCase
      ? { haltedBecause: 'a notice from an unauthenticated sender: filed for a human to attach' }
      : {}),
  };
}

/**
 * The notice's total, in cents.
 *
 * Undefined when the notice does not say or says something we cannot read: the
 * case still opens, because a deduction we cannot price is still a deduction
 * that arrived, and reconciliation reports the unreadable amount as a blocking
 * finding where a reviewer will see it.
 */
function deductionTotalCents(document: unknown): number | undefined {
  const text = fieldValue(document, ['deduction_total', 'value']);
  if (typeof text === 'number' && Number.isSafeInteger(text) && text > 0) return text;
  if (typeof text !== 'string') return undefined;
  try {
    return parseMoneyToCents(text);
  } catch {
    return undefined;
  }
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
  // The amount the retailer took is what the case is about: it decides what is
  // worth disputing first, what the work is costed against, and what a
  // contingency fee is a percentage of. The model reports the text exactly as
  // printed — "$3,120.00" — and we do the arithmetic, which is invariant 3 and
  // the reason a wrong reading shows up as an unparseable amount rather than as
  // a plausible wrong number.
  const total = deductionTotalCents(extraction.document);

  const opened = await deps.store.openCase({
    orgId: document.orgId,
    ...(typeof claimId === 'string' ? { claimId } : {}),
    ...(typeof retailer === 'string' ? { retailerName: retailer } : {}),
    ...(total !== undefined ? { deductionAmountCents: total } : {}),
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

// ---------------------------------------------------------------------------
// Email-in
// ---------------------------------------------------------------------------

export interface InboundEmailResult {
  readonly orgId: string;
  readonly email: InboundEmail;
  readonly documents: readonly ProcessedDocument[];
  /**
   * Whether a case may be opened from this email without a human. False for an
   * unauthenticated sender: `From:` is forgeable, so an email that fails DKIM
   * and DMARC is filed for review rather than acted on.
   */
  readonly mayOpenCase: boolean;
  readonly skipped: readonly { readonly filename: string; readonly reason: string }[];
}

/**
 * Ingests an inbound email: its attachments, and its body when the body is what
 * the notice was written in.
 *
 * The tenant comes from the address the email was sent to — never from the
 * sender, and never from anything in the body. An attachment the front door
 * refuses (wrong type, too large, a bomb) is skipped with its reason rather than
 * failing the whole email: a supplier who attaches their signature image
 * alongside a notice should not lose the notice.
 */
export async function ingestInboundEmail(
  payload: PostmarkInboundPayload,
  deps: PipelineDeps,
): Promise<InboundEmailResult> {
  const email = parseInboundEmail(payload);

  const org = await deps.store.findOrgBySlug(email.orgSlug);
  if (org === undefined) {
    throw new InboundEmailError(
      `no tenant with inbound slug ${JSON.stringify(email.orgSlug)}; refusing to guess one`,
    );
  }

  const documents: ProcessedDocument[] = [];
  const skipped: { filename: string; reason: string }[] = [];

  for (const attachment of email.attachments) {
    const bytes = new Uint8Array(Buffer.from(attachment.base64, 'base64'));
    try {
      documents.push(
        await processUpload(
          {
            orgId: org.orgId,
            filename: attachment.filename,
            bytes,
            declaredMimeType: attachment.contentType,
            source: 'email_in',
          },
          deps,
          // `From:` is forgeable, so an email that fails DKIM and DMARC may not
          // open a case. The documents are still read — they may be perfectly
          // real — and wait for a human to attach them.
          { allowCaseOpen: email.authenticated },
        ),
      );
    } catch (error) {
      skipped.push({
        filename: attachment.filename,
        reason:
          error instanceof RejectedUploadError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  // Some retailers put the deduction in the message rather than attaching it.
  // Until this existed, such an email produced nothing and said nothing about
  // why — the loop above only reads attachments, so an inbox with a real notice
  // in it looked like an empty inbox.
  //
  // The body is read only when no attachment turned out to be the notice. If one
  // did, the body is a cover note ("please see attached") and reading it would
  // cost a model call to learn that.
  const foundNotice = documents.some(
    (d) => d.classification?.docType === 'deduction_notice',
  );
  if (!foundNotice) {
    try {
      const body = acceptEmailBody(email.textBody);
      documents.push(
        await processUpload(
          {
            orgId: org.orgId,
            filename: emailBodyFilename(email),
            bytes: body.bytes,
            source: 'email_body',
            pageText: [body.text],
          },
          deps,
          { allowCaseOpen: email.authenticated },
        ),
      );
    } catch (error) {
      // A body too short to be a notice is the ordinary case — most email is
      // "thanks" — so it is recorded as skipped rather than raised.
      skipped.push({
        filename: 'the email body',
        reason:
          error instanceof RejectedUploadError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  return {
    orgId: org.orgId,
    email,
    documents,
    mayOpenCase: email.authenticated,
    skipped,
  };
}

/**
 * A name for a document that arrived as a message rather than a file.
 *
 * It goes in front of a reviewer, so it says where the thing came from. The
 * subject is the sender's text and is trimmed and stripped of path characters
 * before it becomes part of a filename.
 */
function emailBodyFilename(email: InboundEmail): string {
  const subject = email.subject.replace(/[^\w .\-]+/g, ' ').trim().slice(0, 80);
  return subject === '' ? 'email body.txt' : `${subject} (email body).txt`;
}
