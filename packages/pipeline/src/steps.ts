/**
 * The Phase 1 steps: ingest → scan → classify → extract.
 *
 * Each one is separately callable and separately re-runnable. Re-ingesting the
 * same bytes returns the existing document rather than creating a second one,
 * which is what makes the whole chain safe to retry.
 */

import { applyTransition, parseMoneyToCents, tryParsePrintedDate } from '@recouple/core-domain';
import {
  CorrespondenceSchema,
  DeductionNoticeSchema,
  InvoiceSchema,
  locateQuote,
  OcrError,
  PurchaseOrderSchema,
  restoreDocument,
  ShipmentDocumentSchema,
  type DeductionNotice,
  type DocType,
  type ExtractedField,
  type ExtractionResult,
  type ModelCallRecord,
  type OcrBlock,
  reconcileNotice,
  type Finding,
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
import type {
  CaseRecord,
  IngestSource,
  PipelineDeps,
  RemittanceSettings,
  RestoredExtraction,
  StoredDocument,
} from './ports';
import { LineProvenanceUnknownError } from './ports';

/**
 * The same claim, for the same debtor, is already a case.
 *
 * Part of the `PipelineStore.openCase` contract rather than of any one store,
 * which is why it lives beside the steps and not in the Postgres store: the
 * database refuses the second insert (`unique (org_id, debtor_id, claim_id)`,
 * ADR 0019), the in-memory store refuses it too, and a caller that wants to
 * point at the existing case gets the same class from both.
 *
 * Carries that case so a caller can name it instead of reporting a
 * unique-violation at the reviewer. Merging the two into one case is the
 * identity-resolution layer of STRATEGY §5.2 and is not done here.
 */
export class DuplicateCaseError extends Error {
  constructor(
    message: string,
    readonly existingDeductionId: string,
    readonly claimId: string,
  ) {
    super(message);
    this.name = 'DuplicateCaseError';
  }
}

/**
 * A caller named a case to attach this document to, and that case is not one
 * this tenant can see.
 *
 * `getCase` answers `undefined` for a case that does not exist and for one
 * belonging to another tenant — deliberately, because telling the two apart
 * would leak the existence of another tenant's case. That made the two
 * indistinguishable *here* too, and the pipeline used to treat both as "no case
 * given": it would open a brand new case from the notice, or file the evidence
 * against nothing at all. Either way the reviewer's document went somewhere they
 * did not ask for and nothing said so.
 *
 * So it is an error, and it is raised before the document is read, because a
 * read costs money and a case we cannot resolve is not one worth spending on.
 */
export class CaseNotFoundError extends Error {
  constructor(readonly deductionId: string) {
    super(`case ${deductionId} is not one this tenant can attach a document to`);
    this.name = 'CaseNotFoundError';
  }
}

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
   *
   * It is also what gets written to `uploads.source`, so it is the one thing
   * that later says which channel found this deduction. Coverage is attributed
   * by that (STRATEGY CH-4, ADD-1).
   */
  readonly source: IngestSource;
  /**
   * The member who put this document here, for `uploads.created_by`.
   *
   * A web upload has one — the signed-in reviewer — and an email does not: the
   * sender is not one of our users and `From:` is forgeable, so the column is
   * left null rather than filled with somebody's guess at who they were.
   */
  readonly uploadedBy?: string;
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
    // No second `uploads` row, on purpose. Provenance is a fact about the
    // arrival that produced these bytes, and that arrival already happened: the
    // document keeps the `upload_id` its first one wrote. A second row would
    // say the same deduction was discovered twice, which is exactly the kind of
    // double count `declined_candidates` exists to avoid — and if the second
    // arrival came through a different channel, crediting it would move
    // coverage to whichever channel re-sent a document we already had.
    const verdict = (await deps.store.latestScan(existing.documentId)) ?? {
      status: 'error' as const,
      scanner: 'none',
      detail: 'previously stored document has no scan verdict',
    };
    return { document: existing, verdict, deduplicated: true, warnings: accepted.warnings };
  }

  // Before the document, so a stored document always has an arrival behind it.
  // The reverse order can leave a document that says nothing about where it
  // came from, which is the state this whole change exists to end.
  const upload = await deps.store.recordUpload({
    orgId: input.orgId,
    source: input.source,
    ...(input.uploadedBy !== undefined ? { createdBy: input.uploadedBy } : {}),
  });

  const document = await deps.store.putDocument({
    orgId: input.orgId,
    sha256: accepted.sha256,
    filename: input.filename,
    mimeType: accepted.mimeType,
    byteSize: accepted.byteSize,
    bytes: input.bytes,
    uploadId: upload.uploadId,
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
  await recordExtractionRows(document, result, deps, deductionId);
}

/**
 * The extracted fields, without the call that produced them.
 *
 * Split out so `readDocument` can record all three of a read's model calls
 * together, before the first row that the database might refuse. The extract
 * call is the most expensive of the three and it was the one being lost: on the
 * `correspondence` failure the OCR and classify calls were committed, the
 * classification insert raised, and `recordExtraction` — which would have
 * recorded the extract call — never ran, so the read that cost the most was the
 * read least visible in `model_calls` (ADR 0027). That is the same rule
 * `openCaseFromNotice` already follows: a failure after the money is spent must
 * not lose the record of spending it.
 */
async function recordExtractionRows(
  document: StoredDocument,
  result: ExtractionResult,
  deps: PipelineDeps,
  deductionId?: string,
): Promise<void> {
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

/** What a read whose rows will not rebuild into their own document is called. */
const STORED_WITHOUT_PROVENANCE = 'document.stored_without_provenance';

/**
 * Fields the read had a value for that the stored rows will not give back.
 *
 * `extraction_results` is the record of record, and every store answers
 * `latestExtraction` by rebuilding the document from it (`restoreDocument`).
 * `flattenExtraction` writes no row for a value whose page is missing or whose
 * quote is blank — provenance is not optional — so a *required* field read
 * without provenance is a field that goes in and does not come out, and the
 * document that comes back no longer satisfies its schema.
 *
 * Named by path with the `.value` leg trimmed off, and empty when the round
 * trip is faithful, which is the normal case.
 */
export function fieldsLostOnStorage(result: ExtractionResult): readonly string[] {
  const restored = restoreDocument(result.docType, result.fields);
  if (restored.validated) return [];
  return [
    ...new Set(restored.issues.map((issue) => fieldPathOf(issue.path.split('.')))),
  ].sort();
}

/**
 * A validation path as a field path: `lines.0.deduction_amount.value` is the
 * field `lines[0].deduction_amount`.
 *
 * One function, because the same field is named at the write (the event) and at
 * the read (the finding), and a reviewer comparing the two should not have to
 * work out that they mean the same thing.
 */
function fieldPathOf(segments: readonly string[]): string {
  const withoutLeaf = segments.at(-1) === 'value' ? segments.slice(0, -1) : [...segments];
  return withoutLeaf.reduce(
    (path, segment) =>
      path === '' ? segment : /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`,
    '',
  );
}

/**
 * Says so when the rows just written will not rebuild into a typed document.
 *
 * Loudly, but not fatally: a scan whose one unquoted field is a date still has
 * to open a case, because refusing the read would lose the other twenty fields
 * and the money on the page along with them. So this records the divergence and
 * returns — the read stands, and the case page reconciles over what it has and
 * names what it could not read (`reconcileCase`).
 *
 * The event is a `deduction_events` row, which needs a case; a read that opened
 * none still logs. Nothing in the payload is document text: field paths come
 * from the schema and the problems come from Zod.
 */
async function reportProvenanceGap(
  document: StoredDocument,
  result: ExtractionResult,
  deps: PipelineDeps,
  deductionId?: string,
): Promise<void> {
  const lost = fieldsLostOnStorage(result);
  if (lost.length === 0) return;

  console.warn(
    `[recouple] read: document ${document.documentId} stored a ${result.docType} that does not ` +
      `rebuild into its own type; fields without usable provenance: ${lost.join(', ')}`,
  );
  if (deductionId === undefined) return;

  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId,
    eventType: STORED_WITHOUT_PROVENANCE,
    payload: {
      document_id: document.documentId,
      doc_type: result.docType,
      schema_version: result.schemaVersion,
      fields: lost,
    },
  });
}

/** A model call, told which case it was spent on. */
function withCase(call: ModelCallRecord, deductionId?: string): ModelCallRecord {
  return deductionId === undefined ? call : { ...call, deductionId };
}

/**
 * Everything the read produced: what the document turned out to be, what was on
 * it, and the case it opened or was filed against.
 *
 * Separate from `ProcessedDocument` because a read no longer has to happen in
 * the same process as the ingest that fed it (ADR 0021). `readDocument` returns
 * this, `processUpload` returns it with the ingest attached, and the Inngest job
 * returns a summary of it.
 */
export interface DocumentRead {
  readonly classification?: ClassifyResult;
  readonly extraction?: ExtractionResult;
  readonly case?: CaseRecord;
  /**
   * What a remittance's lines came to, when the document was one (ADR 0026).
   *
   * Absent for every other document type. Deliberately not folded into `case`:
   * one remittance opens many, and naming one of them would be a choice the
   * document did not make.
   */
  readonly remittance?: RemittanceRead;
  /** Why the document stopped where it did, when it did not go all the way. */
  readonly haltedBecause?: string;
}

export interface ProcessedDocument extends DocumentRead {
  readonly ingest: IngestResult;
}

export interface ReadOptions {
  readonly attachToCase?: string;
  /**
   * Whether this document may open a new case on its own. False for a document
   * that arrived by email from a sender we could not authenticate: the file is
   * still ingested, classified and extracted, but a human decides which case
   * it belongs to rather than an unauthenticated stranger creating one.
   */
  readonly allowCaseOpen?: boolean;
}

/**
 * Why a document stopped at the door, as a sentence somebody can act on.
 *
 * The detail is the whole message. Without it this reads `error (none)`, which
 * says a scan did not pass and not one word about why — and the two causes want
 * opposite responses: `none` is a variable nobody set, and a named signature is
 * a file nobody should open.
 *
 * One function because two paths ask the question now: the request that reads
 * the document itself, and the request that would otherwise hand the read to a
 * job. A document that did not scan clean is never handed to anything.
 */
export function scanGateHalt(verdict: ScanVerdict): string {
  return (
    `not scanned clean: ${verdict.status} (${verdict.scanner})` +
    (verdict.detail !== undefined ? ` — ${verdict.detail}` : '')
  );
}

/**
 * What a previous read of this document already recorded, when there was one.
 *
 * A read is not idempotent by itself. It classifies, extracts, records the
 * spend and — for a notice — opens a case, and only the last of those has a
 * constraint behind it: `unique (org_id, debtor_id, claim_id)`, which does not
 * fire while `debtor_id` is null (ADR 0019). A tenant that has not linked the
 * retailer yet is exactly that case, so a second read of the same document
 * opened a second case and paid for the page twice — on the job path whenever
 * an event was redelivered or a run retried, and on the request path whenever
 * the same file was uploaded again.
 *
 * So the recorded extraction is the gate: a document that has one has been
 * read. `undefined` means reading it again would produce something the first
 * read did not, and there are exactly two ways that happens:
 *
 * - it is being attached to a case it is not yet linked to. The read is how the
 *   link and the `evidence.uploaded` event get written — the same BOL is
 *   evidence for two deductions, and its second upload dedupes to the same
 *   document — so skipping it would lose a reviewer's attachment.
 * - it is a notice that has no case, and this read may open one. The earlier
 *   read was an unauthenticated email's (ADR 0016), which files the document
 *   and refuses to open a case from it, or it was one that failed on the way in.
 *
 * Nothing here writes. It is a question, asked before the first model call.
 */
export interface RecordedRead {
  readonly docType: DocType;
  /** The case the earlier read filed it against, when the store can say. */
  readonly deductionId?: string;
}

export async function recordedRead(
  // Only the id: everything this asks is a question about records, not about
  // bytes. Taking the narrower type is what lets a caller that has an id and no
  // document — the queued upload path, which stops before the read — ask it
  // without fetching the document to do so.
  document: Pick<StoredDocument, 'documentId'>,
  deps: PipelineDeps,
  options: ReadOptions = {},
): Promise<RecordedRead | undefined> {
  const recorded = await deps.store.latestExtraction(document.documentId);
  if (recorded === undefined) return undefined;

  if (options.attachToCase !== undefined) {
    const linked = await deps.store.documentsForCase(options.attachToCase);
    if (!linked.some((d) => d.documentId === document.documentId)) return undefined;
    return { docType: recorded.docType, deductionId: options.attachToCase };
  }

  const deductionId = await deps.store.caseForDocument?.(document.documentId);
  if (
    deductionId === undefined &&
    recorded.docType === 'deduction_notice' &&
    (options.allowCaseOpen ?? true)
  ) {
    return undefined;
  }

  return {
    docType: recorded.docType,
    ...(deductionId !== undefined ? { deductionId } : {}),
  };
}

/**
 * Ingest → classify → extract for one file, opening a case when the file turns
 * out to be a deduction notice.
 *
 * A file that is not clean stops here, with a reason. That is the invariant-4
 * gate doing its job, not an error to be worked around.
 *
 * Two halves, and since ADR 0021 they can run in two places: `ingestDocument`
 * stores and scans, `readDocument` reads. This is the one that does both in the
 * same call, and it is the same two functions the Inngest job runs — there is
 * one implementation of each, not a synchronous one and a background one that
 * drift.
 */
export async function processUpload(
  input: IngestInput,
  deps: PipelineDeps,
  options: ReadOptions = {},
): Promise<ProcessedDocument> {
  // Before the bytes are touched, and so before anything is read or paid for.
  // A case the tenant cannot resolve ends the request here rather than quietly
  // becoming "no case given" and opening a new one (`CaseNotFoundError`).
  // `readDocument` resolves it again, because a read that starts from an id
  // cannot inherit this one's answer; this call is what makes the refusal
  // arrive before the document is stored.
  await resolveAttachTarget(options.attachToCase, deps);

  const ingest = await ingestDocument(input, deps);

  if (ingest.verdict.status !== 'clean') {
    return { ingest, haltedBecause: scanGateHalt(ingest.verdict) };
  }

  // The same bytes we already hold. Only then can a read already have happened,
  // so this is the one path where the question is worth a query: if it has, the
  // upload is a re-upload and reading it again would open a second case and pay
  // for the page twice (`recordedRead`). The reviewer is sent to the case it
  // already opened rather than told nothing happened.
  if (ingest.deduplicated) {
    const already = await recordedRead(ingest.document, deps, options);
    if (already !== undefined) {
      const existing =
        already.deductionId === undefined
          ? undefined
          : await deps.store.getCase(already.deductionId);
      return {
        ingest,
        ...(existing !== undefined ? { case: existing } : {}),
        ...(existing === undefined
          ? {
              haltedBecause:
                `this document was already read as a ${already.docType}; ` +
                'it was not read again',
            }
          : {}),
      };
    }
  }

  return { ingest, ...(await readDocument(ingest.document, deps, options)) };
}

/**
 * The read half: classify, extract, and open or attach a case.
 *
 * Takes a document that is already stored and already scanned, so it is exactly
 * what a job can run from an id — and exactly what `processUpload` runs when
 * there is no job. The scan gate is inside `readablePayload`, and on this path
 * it throws rather than returning a reason: reaching here with an unclean
 * verdict is a caller that skipped the gate, which is a fault and not an
 * answer.
 */
export async function readDocument(
  document: StoredDocument,
  deps: PipelineDeps,
  options: ReadOptions = {},
): Promise<DocumentRead> {
  const attachedCase = await resolveAttachTarget(options.attachToCase, deps);
  let caseRecord: CaseRecord | undefined = attachedCase;

  // Read the document once. Classification and extraction both need the page
  // text, and on a scan that text costs money and carries the boxes a reviewer
  // follows — reading twice would pay twice and, because the second read finds
  // the stored text and so never calls OCR, would arrive with no boxes at all.
  const readable = await readablePayload(document, deps);

  const classification = await deps.classifier.classify(readable.payload);

  const extraction = await readExtraction(readable, classification.docType, deps);

  // Everything the read produced, written down. Kept as a closure so it can run
  // either side of `openCaseFromNotice`: the argument is the case the spend and
  // the fields belong to, or undefined when there is no case to belong to.
  const recordTheRead = async (deductionId?: string): Promise<void> => {
    // All three calls first — the OCR, the classification and the extraction —
    // and only then the rows they produced. By the time this closure runs the
    // money is already spent, and every statement after this loop is one the
    // database can refuse: `recordClassification` refuses a doc type its check
    // constraint has never heard of, which is what happened to a
    // `correspondence` JPEG in production, and what was lost with it was the
    // record of the most expensive of the three (ADR 0027). Spend is recorded
    // before anything that can reject it, on the same rule `openCaseFromNotice`
    // already follows below.
    for (const call of [...readable.calls, classification.call, extraction.call]) {
      await deps.store.recordModelCall(withCase(call, deductionId));
    }
    await deps.store.recordClassification(
      document.documentId,
      classification.docType,
      classification.confidence,
    );
    await recordExtractionRows(document, extraction, deps, deductionId);
    await reportProvenanceGap(document, extraction, deps, deductionId);
  };

  // The case is opened before anything is recorded, because the notice that
  // opens a case is read before the case exists and every fact read from it —
  // and every micro-dollar spent reading it — belongs to that case. Opening
  // needs the extraction (the claim id is on the page), so this is the earliest
  // the case can exist.
  //
  // But opening can now fail — a claim already open against that debtor raises
  // `DuplicateCaseError` (ADR 0019) — and the read has already happened and
  // already cost money by then. Losing the model call would understate spend and
  // losing the extraction would throw away a page we paid to read, so both are
  // written against no case before the failure is handed on. Nothing here
  // swallows it: the original error is what the caller sees.
  const mayOpenCase = options.allowCaseOpen ?? true;
  if (classification.docType === 'deduction_notice' && caseRecord === undefined && mayOpenCase) {
    try {
      caseRecord = await openCaseFromNotice(document, extraction, deps);
    } catch (error) {
      // If recording also fails the database is the problem, and that error is
      // the louder one — it is not caught here either.
      await recordTheRead();
      throw error;
    }
  }

  await recordTheRead(caseRecord?.deductionId);

  // A remittance opens its cases *after* the read is recorded, which is the
  // opposite order from a notice, and the reason is the same fact in both
  // directions: what a read's fields and its spend belong to. A notice's belong
  // to the one case it opens, so the case has to exist first. A remittance's
  // belong to none of the twelve it may open — attributing one read to one of
  // them would overstate that case's cost, which is the number a contingency
  // fee is set against (Phase 4). So they are recorded against no case, and the
  // lines run afterwards (ADR 0026).
  let remittance: RemittanceRead | undefined;
  if (classification.docType === 'remittance_advice' && caseRecord === undefined && mayOpenCase) {
    remittance = await openCasesFromRemittance(document, extraction, deps);
  }

  if (attachedCase !== undefined) {
    await deps.store.linkDocument(attachedCase.deductionId, document.documentId, 'evidence');
    await deps.store.appendEvent({
      // The document's tenant, not a caller's claim about it. They are the same
      // on every path that gets here — a document is only ever found or stored
      // under the org it belongs to — and this is the one the row itself says.
      orgId: document.orgId,
      deductionId: attachedCase.deductionId,
      eventType: 'evidence.uploaded',
      payload: {
        document_id: document.documentId,
        doc_type: classification.docType,
        // What the document is called, which is what it was uploaded as
        // (ADR 0011). A job reads this off the row rather than off an event.
        filename: document.filename,
      },
    });
  }

  return {
    classification,
    extraction,
    ...(caseRecord !== undefined ? { case: caseRecord } : {}),
    ...(remittance !== undefined ? { remittance } : {}),
    ...((classification.docType === 'deduction_notice' ||
      classification.docType === 'remittance_advice') &&
    caseRecord === undefined &&
    !mayOpenCase
      ? {
          haltedBecause: `a ${classification.docType} from an unauthenticated sender: filed for a human to attach`,
        }
      : {}),
  };
}

/**
 * The case a document is being attached to, resolved before anything is read.
 *
 * `undefined` only when no case was named. A named case that does not resolve
 * throws, because `getCase` cannot tell "no such case" from "another tenant's
 * case" and neither of those is a reason to open a new one.
 *
 * Exported because the check has to happen before the bytes are stored on every
 * path, including the one where the read happens later in a job and this is the
 * only part of it the reviewer is still around to be told about (ADR 0021).
 */
export async function resolveAttachTarget(
  attachToCase: string | undefined,
  deps: PipelineDeps,
): Promise<CaseRecord | undefined> {
  if (attachToCase === undefined) return undefined;
  const found = await deps.store.getCase(attachToCase);
  if (found === undefined) throw new CaseNotFoundError(attachToCase);
  return found;
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

/**
 * A date field off a notice: the day, or why we would not guess at one.
 *
 * Both halves can be empty — a notice that prints no deadline is not a problem,
 * it is a notice with no deadline. A notice that prints something we cannot read
 * *is* a problem, and it is recorded on `case.discovered` rather than swallowed
 * (CLAUDE.md: fail loud; a silently dropped deadline is how a filing window gets
 * missed).
 */
function printedDate(
  document: unknown,
  field: 'deduction_date' | 'dispute_deadline' | 'payment_date',
): { date?: string; problem?: string } {
  const text = fieldValue(document, [field, 'value']);
  if (typeof text !== 'string' || text.trim() === '') return {};
  const parsed = tryParsePrintedDate(text);
  return 'date' in parsed ? { date: parsed.date } : { problem: parsed.problem };
}

/**
 * How long a retailer name a case can hold: the cap migration 0015 puts on
 * `deductions.retailer_name_as_printed`.
 *
 * Checked here as well as there so a pathological reading is a finding on the
 * case rather than a driver error out of `openCase` — the constraint is still
 * the enforcement, this is only the message.
 */
const MAX_RETAILER_NAME_LENGTH = 500;

/**
 * The retailer as the page printed it, or why we would not store what we read.
 *
 * Trimmed, because a name padded by a layout is the same name. An empty string
 * is absence, not a value: a blank cell on the case list says the notice named
 * a retailer whose name is nothing, and what it actually says is that the
 * notice named nobody.
 *
 * A name past the column's cap is a reading we cannot keep, and it is never
 * truncated to fit: half a name is not what the page said, and a paragraph cut
 * down to "WALMART STORES" would go on to select a debtor the page never named
 * (ADR 0019 — untrusted text may select master data, so a wrong reading of it
 * is a wrong debtor). So the column stays null and the reason goes on
 * `case.discovered`, exactly the way an unparseable date does.
 */
function printedRetailerName(
  document: unknown,
  // A remittance calls the same party `payer_name`. One function, because a
  // name read off a remittance has to reach `deductions.retailer_name_as_printed`
  // under the same cap and the same "blank is absence" rule as one read off a
  // notice, or two document types would disagree about what a stored name means.
  field: 'retailer_name' | 'payer_name' = 'retailer_name',
): { name?: string; problem?: string } {
  const text = fieldValue(document, [field, 'value']);
  if (typeof text !== 'string') return {};
  const trimmed = text.trim();
  if (trimmed === '') return {};
  if (trimmed.length > MAX_RETAILER_NAME_LENGTH) {
    return {
      problem:
        `the printed retailer name is ${trimmed.length} characters, ` +
        `longer than the ${MAX_RETAILER_NAME_LENGTH} a case stores`,
    };
  }
  return { name: trimmed };
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
  // The name the page printed, blank treated as absent and an impossible length
  // reported rather than truncated — see `printedRetailerName`.
  const retailer = printedRetailerName(extraction.document);
  // The amount the retailer took is what the case is about: it decides what is
  // worth disputing first, what the work is costed against, and what a
  // contingency fee is a percentage of. The model reports the text exactly as
  // printed — "$3,120.00" — and we do the arithmetic, which is invariant 3 and
  // the reason a wrong reading shows up as an unparseable amount rather than as
  // a plausible wrong number.
  const total = deductionTotalCents(extraction.document);
  // Dates get the same treatment, for the same reason. A window we cannot read
  // ("60 days of deduction date" is a retailer's rule, not a date) leaves the
  // column null and the case still opens — better a case with no deadline than
  // no case — but the reason goes on the event rather than on the floor.
  const deductionDate = printedDate(extraction.document, 'deduction_date');
  const disputeDeadline = printedDate(extraction.document, 'dispute_deadline');
  // The invoice this deduction was taken against, when the notice prints one.
  // `DeductionNoticeSchema` has carried the field since Phase 1 and nothing has
  // ever stored it; it is stored now because it is the key the dedup window
  // matches on, and a window that only worked remittance→notice would let the
  // commoner order — the notice first, the remittance a week later — double-file
  // (ADR 0026 §8). A notice that prints none keeps exactly the behaviour it has
  // today: `claim_id` dedup and nothing else.
  const invoiceNumber = printedIdentifier(extraction.document, 'invoice_number');

  const opened = await deps.store.openCase({
    orgId: document.orgId,
    ...(typeof claimId === 'string' ? { claimId } : {}),
    ...(retailer.name !== undefined ? { retailerName: retailer.name } : {}),
    ...(total !== undefined ? { deductionAmountCents: total } : {}),
    ...(deductionDate.date !== undefined ? { deductionDate: deductionDate.date } : {}),
    ...(disputeDeadline.date !== undefined ? { disputeDeadline: disputeDeadline.date } : {}),
    ...(invoiceNumber !== undefined ? { invoiceNumber } : {}),
  });

  await deps.store.linkDocument(opened.deductionId, document.documentId, 'notice');
  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    eventType: 'case.discovered',
    payload: {
      document_id: document.documentId,
      claim_id: typeof claimId === 'string' ? claimId : null,
      retailer_name: retailer.name ?? null,
      // `discovered_via` is named on every `case.discovered` event, including
      // the notice path's, so the projection is rebuildable from the events
      // alone rather than from the events plus a column's default.
      discovered_via: 'notice',
      invoice_number: invoiceNumber ?? null,
      // Null, not absent, when no debtor matched: the projection is rebuildable
      // from the events, and "nobody matched" is itself the fact (ADR 0019 §8).
      debtor_id: opened.debtorId ?? null,
      deduction_date: deductionDate.date ?? null,
      dispute_deadline: disputeDeadline.date ?? null,
      ...(retailer.problem !== undefined ? { retailer_name_unread: retailer.problem } : {}),
      ...(deductionDate.problem !== undefined
        ? { deduction_date_unread: deductionDate.problem }
        : {}),
      ...(disputeDeadline.problem !== undefined
        ? { dispute_deadline_unread: disputeDeadline.problem }
        : {}),
    },
  });

  // The guard is doc_type_known; the classifier has just answered it. The
  // trigger is named because the table is keyed by (from, to, trigger) — this
  // edge is crossed by `document.classified` and by nothing else.
  applyTransition(opened.state, 'classified', 'document.classified', { doc_type_known: true });
  const classified = await deps.store.transitionCase(opened.deductionId, 'classified');
  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    eventType: 'case.classified',
    payload: { doc_type: extraction.docType, schema_version: extraction.schemaVersion },
  });

  return classified;
}

/**
 * The longest identifier a case stores — the cap migration 0021 puts on
 * `deductions.invoice_number` and `deductions.reason_code_as_printed`.
 *
 * Checked here as well as there for `MAX_RETAILER_NAME_LENGTH`'s reason: a
 * pathological reading is a line outcome somebody can read rather than a driver
 * error out of `openCase`. The constraint is still the enforcement.
 */
const MAX_IDENTIFIER_LENGTH = 200;

/**
 * A short identifier off a page — an invoice number, a reason code — trimmed,
 * with blank treated as absence and an impossible length treated as nothing
 * read at all.
 *
 * Never truncated. Half an invoice number is not the invoice number, and this
 * value is a lookup key: a shortened one would match the wrong case, which is
 * worse than matching none.
 */
function printedIdentifier(document: unknown, ...path: readonly string[]): string | undefined {
  const text = fieldValue(document, [...path, 'value']);
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_IDENTIFIER_LENGTH) return undefined;
  return trimmed;
}

/** Printed money, in cents, or `undefined` when the page said nothing readable. */
function printedMoneyCents(document: unknown, ...path: readonly string[]): number | undefined {
  const text = fieldValue(document, [...path, 'value']);
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    return parseMoneyToCents(text);
  } catch {
    return undefined;
  }
}

/** Whether the page printed anything at all in that field, readable or not. */
function fieldWasPrinted(document: unknown, ...path: readonly string[]): boolean {
  const text = fieldValue(document, [...path, 'value']);
  return typeof text === 'string' && text.trim() !== '';
}

/** What became of one line of a remittance advice. */
export type RemittanceLineOutcome =
  /** Over the floor, no recent case for this invoice: a new case. */
  | 'opened'
  /** The same invoice for the same amount was already a case, inside the window. */
  | 'merged'
  /** Under the tenant's floor; recorded in `declined_candidates`. */
  | 'below_tolerance'
  /**
   * Under the floor, and the document records no arrival, so the decline could
   * not be attributed to a channel. Counted, never guessed at.
   */
  | 'below_tolerance_unattributed'
  /** Paid in full, or overpaid. An overpayment is not a deduction. */
  | 'not_short_paid'
  /** Nothing on the line prices the short-pay, or what is there will not parse. */
  | 'unreadable';

export interface RemittanceLineResult {
  /** Position on the page, so a reviewer can find the row this is about. */
  readonly index: number;
  readonly outcome: RemittanceLineOutcome;
  /** As printed. Absent when the line printed none, which is itself a reason. */
  readonly invoiceNumber?: string;
  /** The short-pay in cents, once we had one. */
  readonly amountCents?: number;
  readonly reasonCode?: string;
  /** The case this line opened or merged into. */
  readonly deductionId?: string;
  /** Why, in a sentence, for the outcomes that need one. */
  readonly detail?: string;
}

/** What a whole remittance advice came to. */
export interface RemittanceRead {
  /** Cases these lines opened, in page order. */
  readonly opened: readonly CaseRecord[];
  /** Cases these lines merged into rather than duplicating. */
  readonly mergedInto: readonly string[];
  readonly lines: readonly RemittanceLineResult[];
}

/** The event naming what a whole remittance's lines came to. */
export const LINES_PROCESSED = 'remittance.lines_processed';
/** The event on a case a second document turned out to be about. */
export const MERGED_DUPLICATE_LINE = 'case.merged_duplicate_line';
/** What `declined_candidates.decided_by` says for a line under the floor. */
export const DECLINED_BY_TOLERANCE = 'remittance_tolerance';

/**
 * The short-pay on one line, and how we got it.
 *
 * `deduction_amount` as printed wins, because it is the payer's own statement
 * of what they withheld. `gross − net` is the fallback, and it is the case most
 * freight and foodservice advices are: they print what they paid and what they
 * owed, and the difference is left for the reader to do. That subtraction
 * happens here, in integer cents, never in the model (CLAUDE.md: models copy,
 * we compute).
 *
 * A field the page printed and we could not read comes back as a problem rather
 * than as an absence, and the caller reports the line as unreadable: a deduction
 * we cannot price is not a deduction of nothing.
 */
function shortPayOnLine(
  line: unknown,
):
  | { readonly cents: number; readonly basis: 'printed' | 'gross_minus_net' }
  | { readonly problem: string } {
  if (fieldWasPrinted(line, 'deduction_amount')) {
    const printed = printedMoneyCents(line, 'deduction_amount');
    if (printed === undefined) {
      return { problem: 'the line prints a deduction amount that will not parse as money' };
    }
    return { cents: printed, basis: 'printed' };
  }

  const grossPrinted = fieldWasPrinted(line, 'gross_amount');
  const netPrinted = fieldWasPrinted(line, 'net_amount');
  if (!grossPrinted || !netPrinted) {
    return {
      problem:
        'the line prints no deduction amount, and ' +
        (grossPrinted ? 'no net paid' : netPrinted ? 'no gross' : 'neither a gross nor a net paid') +
        ' to subtract one from',
    };
  }

  const gross = printedMoneyCents(line, 'gross_amount');
  const net = printedMoneyCents(line, 'net_amount');
  if (gross === undefined || net === undefined) {
    return {
      problem:
        'the line prints a ' +
        (gross === undefined ? 'gross' : 'net paid') +
        ' that will not parse as money, so the short-pay cannot be computed',
    };
  }
  return { cents: gross - net, basis: 'gross_minus_net' };
}

/**
 * Whether a short-pay clears the tenant's floor.
 *
 * Both halves, and the proportional one only when the gross is readable — a
 * delta over the absolute floor with nothing to proportion it against is still
 * a deduction, and refusing it would lose a real case over a missing column.
 *
 * The proportional comparison is a cross-multiplication in `BigInt`, not
 * `delta >= gross * bps / 10000`. There is then no division, no rounding, and
 * no question about which way a half-cent goes — and no overflow at any amount
 * a document could print (invariant 3, ADR 0026 §3).
 */
export function clearsRemittanceTolerance(
  deltaCents: number,
  grossCents: number | undefined,
  settings: Pick<RemittanceSettings, 'toleranceCents' | 'toleranceBps'>,
): boolean {
  if (deltaCents < settings.toleranceCents) return false;
  if (grossCents === undefined) return true;
  return BigInt(deltaCents) * 10_000n >= BigInt(grossCents) * BigInt(settings.toleranceBps);
}

/**
 * Opens a case for every line of a remittance advice that shows a short-pay.
 *
 * `openCaseFromNotice` is for a document that says "we took this from you".
 * This is for the document that says "here is what we paid", where the
 * deduction is the difference and nobody ever sent a notice — which in
 * staffing, freight and foodservice is most of them (ADR 0026).
 *
 * One remittance can open many cases, so lines are processed one at a time and
 * each gets its own `openCase`. A `DuplicateCaseError` on line 17 of a 42-line
 * advice costs line 17 and nothing else. Nothing else is caught: a database
 * that is down is not a line outcome.
 *
 * Every opened case, and every case a line merged into, gets the whole read's
 * summary appended as `remittance.lines_processed` — `deduction_events` has no
 * document-level row (its `deduction_id` is `not null`, migration 0004), and
 * making an append-only table's column nullable is its own ADR. So a reviewer
 * landing on any one of these cases can see what the read as a whole concluded.
 */
export async function openCasesFromRemittance(
  document: StoredDocument,
  extraction: ExtractionResult,
  deps: PipelineDeps,
): Promise<RemittanceRead> {
  const settings = await deps.store.remittanceSettings(document.orgId);
  const advice = extraction.document;

  const payer = printedRetailerName(advice, 'payer_name');
  const paymentReference = printedIdentifier(advice, 'payment_reference');
  const paymentDate = printedDate(advice, 'payment_date');

  const rows = fieldValue(advice, ['lines']);
  const lines: RemittanceLineResult[] = [];
  const opened: CaseRecord[] = [];
  const mergedInto: string[] = [];

  // Once per document, not once per line. A remittance stored before ingest
  // recorded arrivals cannot attribute a decline to a channel, and asking again
  // for each of forty-two lines would produce forty-two identical refusals. The
  // first one stops the attempts and the count says how many went uncounted.
  let attributionUnavailable: string | undefined;

  if (!Array.isArray(rows)) {
    // The document came back with no `lines` array at all — a read stored
    // without provenance, or a shape we do not understand. Said out loud rather
    // than treated as a remittance that happened to short-pay nothing.
    console.warn(
      `[recouple] remittance: document ${document.documentId} came back with no lines array; ` +
        'no case was opened from it',
    );
    return { opened, mergedInto, lines };
  }

  for (const [index, line] of rows.entries()) {
    const invoiceNumber = printedIdentifier(line, 'invoice_number');
    const reasonCode = printedIdentifier(line, 'reason_code');
    const grossCents = printedMoneyCents(line, 'gross_amount');
    const note = (result: Omit<RemittanceLineResult, 'index'>): void => {
      lines.push({
        index,
        ...(invoiceNumber !== undefined ? { invoiceNumber } : {}),
        ...(reasonCode !== undefined ? { reasonCode } : {}),
        ...result,
      });
    };

    const shortPay = shortPayOnLine(line);
    if ('problem' in shortPay) {
      note({ outcome: 'unreadable', detail: shortPay.problem });
      continue;
    }
    if (shortPay.cents <= 0) {
      note({ outcome: 'not_short_paid', amountCents: shortPay.cents });
      continue;
    }

    // Everything downstream is keyed by the invoice: the claim id, the dedup
    // window, the lock. A line with none is a short-pay we cannot tell apart
    // from the next one on the page, and a case we could never dedupe is how
    // the same deduction gets filed twice.
    if (invoiceNumber === undefined) {
      note({
        outcome: 'unreadable',
        amountCents: shortPay.cents,
        detail:
          'the line prints no invoice number, so this short-pay cannot be told apart ' +
          'from another on the same advice',
      });
      continue;
    }

    if (!clearsRemittanceTolerance(shortPay.cents, grossCents, settings)) {
      if (attributionUnavailable !== undefined) {
        note({
          outcome: 'below_tolerance_unattributed',
          amountCents: shortPay.cents,
          detail: attributionUnavailable,
        });
        continue;
      }
      try {
        // A discard is not a decision. Coverage is a ratio of dollars and has no
        // numerator without this (STRATEGY ADD-1) — and a floor whose cost
        // nobody can add up is a floor nobody can argue about.
        await deps.store.recordDeclinedLine({
          orgId: document.orgId,
          documentId: document.documentId,
          estimatedRecoverableCents: shortPay.cents,
          externalIds: {
            invoice_number: invoiceNumber,
            ...(paymentReference !== undefined ? { payment_reference: paymentReference } : {}),
            ...(reasonCode !== undefined ? { reason_code: reasonCode } : {}),
          },
          // The policy that decided, so a tenant that later lowers its floor can
          // evaluate the change against exactly what the old one declined.
          decidedByVersion: `${settings.toleranceCents}c/${settings.toleranceBps}bps`,
          detail:
            `short-pay of ${shortPay.cents} cents is under this tenant's remittance floor ` +
            `(${settings.toleranceCents} cents / ${settings.toleranceBps} bps)`,
        });
        note({ outcome: 'below_tolerance', amountCents: shortPay.cents });
      } catch (error) {
        if (!(error instanceof LineProvenanceUnknownError)) throw error;
        attributionUnavailable = error.message;
        console.warn(`[recouple] remittance: ${error.message}`);
        note({
          outcome: 'below_tolerance_unattributed',
          amountCents: shortPay.cents,
          detail: error.message,
        });
      }
      continue;
    }

    // The claim, the look-up and the insert are one decision. Two *different*
    // documents — a notice and this remittance — can reach this point for the
    // same invoice at the same moment, and `withDocumentRead` says nothing
    // about that: it claims a document, and these are two.
    const outcome = await deps.store.withInvoiceClaim(
      document.orgId,
      invoiceNumber,
      async (): Promise<RemittanceLineResult> => {
        const existing = await deps.store.findRecentCaseByInvoice(
          document.orgId,
          invoiceNumber,
          shortPay.cents,
          settings.dedupDays,
        );
        if (existing !== undefined) {
          await mergeIntoCase(existing.deductionId, document, extraction, deps, {
            invoiceNumber,
            amountCents: shortPay.cents,
            ...(reasonCode !== undefined ? { reasonCode } : {}),
          });
          return { index, invoiceNumber, outcome: 'merged', deductionId: existing.deductionId };
        }

        try {
          const opened = await openCaseForLine(document, deps, {
            invoiceNumber,
            amountCents: shortPay.cents,
            basis: shortPay.basis,
            ...(grossCents !== undefined ? { grossCents } : {}),
            ...(reasonCode !== undefined ? { reasonCode } : {}),
            ...(payer.name !== undefined ? { payerName: payer.name } : {}),
            ...(payer.problem !== undefined ? { payerProblem: payer.problem } : {}),
            ...(paymentReference !== undefined ? { paymentReference } : {}),
            ...(paymentDate.date !== undefined ? { paymentDate: paymentDate.date } : {}),
            ...(paymentDate.problem !== undefined
              ? { paymentDateProblem: paymentDate.problem }
              : {}),
          });
          return { index, invoiceNumber, outcome: 'opened', deductionId: opened.deductionId };
        } catch (error) {
          // The claim this line builds is already open against this debtor.
          // That is the same deduction arriving twice by a route the window did
          // not catch — an advice re-sent after it closed, most likely — and it
          // is a merge, not a failure. The other forty-one lines are unaffected.
          if (!(error instanceof DuplicateCaseError)) throw error;
          await mergeIntoCase(error.existingDeductionId, document, extraction, deps, {
            invoiceNumber,
            amountCents: shortPay.cents,
            ...(reasonCode !== undefined ? { reasonCode } : {}),
            detail: 'the claim this line builds is already open against this debtor',
          });
          return {
            index,
            invoiceNumber,
            outcome: 'merged',
            deductionId: error.existingDeductionId,
          };
        }
      },
    );

    lines.push({ ...outcome, ...(reasonCode !== undefined ? { reasonCode } : {}) });
    if (outcome.deductionId === undefined) continue;
    if (outcome.outcome === 'opened') {
      const record = await deps.store.getCase(outcome.deductionId);
      if (record !== undefined) opened.push(record);
    } else {
      mergedInto.push(outcome.deductionId);
    }
  }

  await reportLinesProcessed(document, extraction, deps, { opened, mergedInto, lines });
  return { opened, mergedInto, lines };
}

/** Opens one case from one short-paid line, and walks it discovered → classified. */
async function openCaseForLine(
  document: StoredDocument,
  deps: PipelineDeps,
  line: {
    readonly invoiceNumber: string;
    readonly amountCents: number;
    readonly basis: 'printed' | 'gross_minus_net';
    readonly grossCents?: number;
    readonly reasonCode?: string;
    readonly payerName?: string;
    readonly payerProblem?: string;
    readonly paymentReference?: string;
    readonly paymentDate?: string;
    readonly paymentDateProblem?: string;
  },
): Promise<CaseRecord> {
  // The remittance prints no claim id, because nobody filed a claim — they just
  // paid less. But `unique (org_id, debtor_id, claim_id)` is what stops the same
  // deduction opening two cases once a debtor resolves, and a null opts every
  // one of these out of it: Postgres does not compare nulls, which is the bug
  // ADR 0019 was written about. The payment reference and the invoice number are
  // both on the page, unique together within a payment, and readable by a person
  // holding the advice (ADR 0026 §7).
  const claimId =
    line.paymentReference === undefined
      ? line.invoiceNumber
      : `${line.paymentReference}:${line.invoiceNumber}`;

  const opened = await deps.store.openCase({
    orgId: document.orgId,
    claimId,
    discoveredVia: 'remittance_line',
    invoiceNumber: line.invoiceNumber,
    deductionAmountCents: line.amountCents,
    ...(line.reasonCode !== undefined ? { reasonCodeAsPrinted: line.reasonCode } : {}),
    ...(line.payerName !== undefined ? { retailerName: line.payerName } : {}),
    ...(line.paymentDate !== undefined ? { deductionDate: line.paymentDate } : {}),
    // No `disputeDeadline`, deliberately. A remittance prints no window, and
    // "dispute within 90 days" in its footer is a payer's rule — versioned,
    // effective-dated playbook data (Phase 2), not a date this code may infer.
  });

  // Role `notice`, not `evidence`. This document *is* the notice for this
  // deduction, and `declineCase` derives `discovered_from` from the case's
  // notice-role document — so filing it any other way would make every
  // remittance-originated case undeclinable, which is a provenance mechanism
  // breaking on a document whose provenance is perfectly well known.
  await deps.store.linkDocument(opened.deductionId, document.documentId, 'notice');
  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    eventType: 'case.discovered',
    payload: {
      document_id: document.documentId,
      claim_id: claimId,
      discovered_via: 'remittance_line',
      invoice_number: line.invoiceNumber,
      payment_reference: line.paymentReference ?? null,
      retailer_name: line.payerName ?? null,
      debtor_id: opened.debtorId ?? null,
      deduction_date: line.paymentDate ?? null,
      dispute_deadline: null,
      deduction_amount_cents: line.amountCents,
      reason_code_as_printed: line.reasonCode ?? null,
      // How the amount was arrived at, which is the one thing a reviewer cannot
      // see by looking at the row: `printed` means the payer said so, and
      // `gross_minus_net` means we subtracted and they never wrote it down.
      amount_basis: line.basis,
      gross_amount_cents: line.grossCents ?? null,
      ...(line.payerProblem !== undefined ? { retailer_name_unread: line.payerProblem } : {}),
      ...(line.paymentDateProblem !== undefined
        ? { deduction_date_unread: line.paymentDateProblem }
        : {}),
    },
  });

  // The same edge the notice path crosses, by the same trigger, checked against
  // the same table — so the state machine stays the spec for both.
  applyTransition(opened.state, 'classified', 'document.classified', { doc_type_known: true });
  const classified = await deps.store.transitionCase(opened.deductionId, 'classified');
  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    eventType: 'case.classified',
    payload: { doc_type: 'remittance_advice', schema_version: 'remittance' },
  });
  return classified;
}

/**
 * Files this document against a case that already holds the same deduction, and
 * says so on that case.
 *
 * As `evidence`, not `notice`: the case already has whichever document named it
 * first, and that first document is the one the deduction reached us through.
 * Crediting the second would move `declined_candidates.discovered_from` to
 * whichever channel re-sent something we already had — the same misattribution
 * `ingestDocument` refuses when it declines to write a second `uploads` row.
 */
async function mergeIntoCase(
  deductionId: string,
  document: StoredDocument,
  extraction: ExtractionResult,
  deps: PipelineDeps,
  line: {
    readonly invoiceNumber: string;
    readonly amountCents: number;
    readonly reasonCode?: string;
    readonly detail?: string;
  },
): Promise<void> {
  await deps.store.linkDocument(deductionId, document.documentId, 'evidence');
  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId,
    eventType: MERGED_DUPLICATE_LINE,
    payload: {
      document_id: document.documentId,
      // Which kind of document turned up second. Notice-then-remittance and
      // remittance-then-notice are both merges, and a reviewer wants to know
      // which one they are looking at.
      doc_type: extraction.docType,
      invoice_number: line.invoiceNumber,
      deduction_amount_cents: line.amountCents,
      reason_code_as_printed: line.reasonCode ?? null,
      ...(line.detail !== undefined ? { detail: line.detail } : {}),
    },
  });
}

/**
 * The whole read's outcome, on every case it touched.
 *
 * Counts and ids, plus invoice numbers and reason codes — which are already on
 * the case rows this event sits beside. No other document text: an event is not
 * a place untrusted content goes (invariant 4).
 *
 * A read that opened and merged nothing has nowhere to put this, because
 * `deduction_events.deduction_id` is `not null`. It is logged instead, and the
 * `declined_candidates` rows are the durable record of what it decided.
 */
async function reportLinesProcessed(
  document: StoredDocument,
  extraction: ExtractionResult,
  deps: PipelineDeps,
  read: RemittanceRead,
): Promise<void> {
  const counts: Record<string, number> = {};
  for (const line of read.lines) counts[line.outcome] = (counts[line.outcome] ?? 0) + 1;

  const payload = {
    document_id: document.documentId,
    doc_type: extraction.docType,
    lines_read: read.lines.length,
    counts,
    opened: read.opened.map((c) => c.deductionId),
    merged_into: [...new Set(read.mergedInto)],
    lines: read.lines.map((line) => ({
      index: line.index,
      outcome: line.outcome,
      invoice_number: line.invoiceNumber ?? null,
      deduction_amount_cents: line.amountCents ?? null,
      reason_code_as_printed: line.reasonCode ?? null,
      deduction_id: line.deductionId ?? null,
      detail: line.detail ?? null,
    })),
  };

  const touched = [...new Set([...read.opened.map((c) => c.deductionId), ...read.mergedInto])];
  if (touched.length === 0) {
    console.warn(
      `[recouple] remittance: document ${document.documentId} opened no case — ` +
        `${read.lines.length} line(s): ${JSON.stringify(counts)}`,
    );
    return;
  }

  for (const deductionId of touched) {
    await deps.store.appendEvent({
      orgId: document.orgId,
      deductionId,
      eventType: LINES_PROCESSED,
      payload,
    });
  }
}

export { RejectedUploadError };

/**
 * Reconciles a case from whatever typed documents it already has. Returns
 * undefined when there is no notice yet — there is nothing to reconcile against.
 *
 * Every document is parsed against its own schema before it is used, rather
 * than cast. The store rebuilds and validates what it returns
 * (`restoreDocument`), so this normally agrees with it immediately; what the
 * parse is here for is the case where it does not. A stored document that no
 * longer satisfies its schema is not quietly reconciled as if it did, and it is
 * not quietly dropped either — it becomes a finding, because a reviewer reading
 * this page needs to know that a document on the case could not be used.
 */
export async function reconcileCase(
  deductionId: string,
  deps: PipelineDeps,
): Promise<Reconciliation | undefined> {
  const documents = await deps.store.documentsForCase(deductionId);
  const byType = new Map<DocType, RestoredExtraction>();

  for (const document of documents) {
    const extraction = await deps.store.latestExtraction(document.documentId);
    if (extraction === undefined) continue;
    if (!byType.has(extraction.docType)) byType.set(extraction.docType, extraction);
  }

  const stored = byType.get('deduction_notice');
  if (stored === undefined) return undefined;

  const unusable: Finding[] = [];
  const notice = DeductionNoticeSchema.safeParse(stored.document);
  let noticeData: DeductionNotice;

  if (notice.success) {
    noticeData = notice.data;
  } else {
    const unreadable = unreadableFields(notice.error, stored.document);
    if (unreadable === undefined) {
      // A notice whose shape is wrong in some way that is not a missing value —
      // a number where a string belongs, a group that is not an array. Nothing
      // is reconciled against that, and nothing pretends it was. The fields are
      // still stored and still shown; it is the arithmetic that is refused.
      return {
        lines: [],
        claimedTotalCents: null,
        lineSumCents: null,
        findings: [unusableDocument('deduction_notice', stored)],
        internallyConsistent: false,
      };
    }
    // Every failure is a required field that came back with no value, which is
    // what a field stored without provenance looks like from here
    // (`fieldsLostOnStorage` says the same thing at the write). The rest of the
    // notice is intact and is worth more than the refusal: reconciliation runs,
    // and the fields that could not be read are named. `reconcileNotice` reads
    // no field object directly, so an absent one is a missing finding rather
    // than a throw.
    noticeData = stored.document as DeductionNotice;
    unusable.push(unreadableNotice(unreadable));
  }

  const supporting = <T>(
    docType: DocType,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  ): T | undefined => {
    const found = byType.get(docType);
    if (found === undefined) return undefined;
    const parsed = schema.safeParse(found.document);
    if (parsed.success) return parsed.data;
    unusable.push(unusableDocument(docType, found));
    return undefined;
  };

  const invoice = supporting('invoice', InvoiceSchema);
  const po = supporting('po', PurchaseOrderSchema);
  // Both are asked, and neither short-circuits the other: a `pod` on the case
  // that will not parse is a document a reviewer has to be told about whether
  // or not a `bol` happened to answer first.
  const bol = supporting('bol', ShipmentDocumentSchema);
  const pod = supporting('pod', ShipmentDocumentSchema);
  const shipment = bol ?? pod;
  // Correspondence is where a customer said in writing what they later charged
  // for — a moved appointment, a waived fee. Without it every
  // `reconcileAppointment` finding is unreachable from the case page, which is
  // most of what a freight case turns on.
  const correspondence = supporting('correspondence', CorrespondenceSchema);

  const reconciliation = reconcileNotice({
    notice: noticeData,
    ...(invoice !== undefined ? { invoice } : {}),
    ...(po !== undefined ? { po } : {}),
    ...(shipment !== undefined ? { shipment } : {}),
    ...(correspondence !== undefined ? { correspondence: [correspondence] } : {}),
  });

  if (unusable.length === 0) return reconciliation;
  const findings = [...unusable, ...reconciliation.findings];
  return {
    ...reconciliation,
    findings,
    // Recomputed, because a blocking finding added here is as blocking as one
    // `reconcileNotice` raised: a notice whose money we could not read is not
    // an internally consistent claim.
    internallyConsistent: !findings.some((finding) => finding.severity === 'blocking'),
  };
}

/**
 * Fields a stored document failed its schema on *only* because they came back
 * with no value, or `undefined` when anything else was wrong with it.
 *
 * The distinction is the whole of B1. A required field stored without
 * provenance gets no `extraction_results` row (`flatten.ts`), so the rebuilt
 * document states it as absent and Zod rejects the document — one unquoted date
 * on a scan used to cost the case every line of its reconciliation. Any other
 * failure is a shape we do not understand, and that one is still refused.
 */
function unreadableFields(
  error: { issues: readonly { code: string; path: readonly PropertyKey[] }[] },
  document: unknown,
): readonly string[] | undefined {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code !== 'invalid_type') return undefined;
    // Asked of the document rather than read off the message: "no value" is a
    // fact about the object, and a Zod message is a string that changes with
    // the library.
    if (valueAtPath(document, issue.path) !== null) return undefined;
    const segments = issue.path.map(String);
    // The failure is on the `value` inside a field object. A path with nothing
    // in front of it is the document itself, not a field of it, and that is not
    // something to reconcile around.
    if (segments.at(-1) !== 'value' || segments.length < 2) return undefined;
    fields.add(fieldPathOf(segments));
  }
  return fields.size === 0 ? undefined : [...fields].sort();
}

function valueAtPath(document: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = document;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/**
 * Money we could not read is a different kind of missing from a date we could
 * not read.
 *
 * A notice with no readable deduction amount has nothing to reconcile *to*: the
 * arithmetic that says whether the claim adds up is over these fields, and a
 * sum with a hole in it agreeing with a total is not agreement. Anything else
 * missing — a date, a claim id, a reason code — leaves the money intact, so the
 * reconciliation is still worth doing and the gap is still worth saying.
 */
function isMoneyField(fieldPath: string): boolean {
  const leaf = fieldPath.split('.').at(-1) ?? fieldPath;
  return leaf === 'unit_cost' || leaf.includes('_amount') || leaf.includes('_total');
}

/**
 * The notice was reconciled, and these fields were not in it.
 *
 * Blocking when one of them carries money, a warning otherwise — never silence,
 * and never the empty reconciliation that a refusal used to produce.
 */
function unreadableNotice(fields: readonly string[]): Finding {
  const money = fields.filter(isMoneyField);
  return {
    code: 'stored_document_not_typed',
    severity: money.length > 0 ? 'blocking' : 'warning',
    message:
      `the stored deduction_notice came back without ${fields.join(', ')} — ` +
      'stored with no page or no quote, so there is no row to rebuild it from. ' +
      (money.length > 0
        ? `${money.join(', ')} carries money, so the reconciliation below cannot be trusted ` +
          'to add up'
        : 'the rest of the notice reconciled normally'),
  };
}

/**
 * A document on the case that could not be read back as its own type.
 *
 * Said out loud, with what the rebuild objected to, because the alternative is
 * a page that silently reconciles less than the case contains.
 *
 * No `fieldPath`: that is a path into a document (`lines[0].unit_cost`), and
 * what is wrong here is the document itself. A doc type in that slot is a path
 * the reviewer UI cannot find a field for, and naming the document is the
 * message's job — which it does.
 */
function unusableDocument(docType: DocType, stored: RestoredExtraction): Finding {
  const why = stored.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.problem}`)
    .join('; ');
  return {
    code: 'stored_document_not_typed',
    severity: docType === 'deduction_notice' ? 'blocking' : 'warning',
    message:
      `the stored ${docType} no longer satisfies its schema, so it was not used in ` +
      `reconciliation${why === '' ? '' : ` (${why})`}`,
  };
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
            // The channel, recorded on the `uploads` row this opens. No
            // `uploadedBy`: the sender is not one of our members, and `From:`
            // is forgeable, so the column stays null rather than naming a
            // person on the strength of a header.
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
            // Its own channel, not `email_in`: a notice written in the message
            // and one attached to it are different things to have found, and
            // coverage counts them separately (migration 0014, ADR 0016).
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
