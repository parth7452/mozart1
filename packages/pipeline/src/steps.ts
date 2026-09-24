/**
 * The Phase 1 steps: ingest → scan → classify → extract.
 *
 * Each one is separately callable and separately re-runnable. Re-ingesting the
 * same bytes returns the existing document rather than creating a second one,
 * which is what makes the whole chain safe to retry.
 */

import {
  applyTransition,
  identifierMatchKey,
  parseMoneyToCents,
  resolveIdentity,
  subCents,
  tryParsePrintedDate,
} from '@recouple/core-domain';
import type { Cents, IdentityResolution } from '@recouple/core-domain';
import {
  CorrespondenceSchema,
  DeductionNoticeSchema,
  InvoiceSchema,
  locateQuote,
  OcrError,
  PurchaseOrderSchema,
  RemittanceAdviceSchema,
  restoreDocument,
  ShipmentDocumentSchema,
  type DeductionNotice,
  type DocType,
  type ExtractedField,
  type ExtractionResult,
  type ModelCallRecord,
  type OcrBlock,
  reconcileNotice,
  reconcileRemittanceLine,
  type Finding,
  type Reconciliation,
  type RemittanceAdvice,
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
import { CaseMergedAwayError, LineProvenanceUnknownError } from './ports';
import { fieldPathOf } from './field-path';
import {
  HELD_FOR_REVIEW,
  holdFor,
  opensCaseOnItsOwn,
  type DocumentHold,
  type HoldConfirmation,
} from './hold';

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
 * The arrival looks like more than one deduction we already hold, and choosing
 * between them is not ours to do (ADR 0025 §6).
 *
 * Beside `DuplicateCaseError` for the same reason: it is part of the
 * `PipelineStore.openCase` contract rather than of any one store. Two matches
 * count as none — the rule `resolveDebtorId` applies to debtors — because the
 * two failures are not symmetric. A duplicate case is visible and the money is
 * still disputable; a wrong merge destroys a disputable deduction quietly, and
 * post-audit claims reach back about two years. So the case is not opened and
 * the candidates are named, for a person.
 */
export class AmbiguousIdentityError extends Error {
  constructor(
    message: string,
    /** Every case the arrival could be. Ids only — never what agreed. */
    readonly deductionIds: readonly string[],
    /** Which facts agreed (`'claim_id'`, `'invoice_number'`), never their values. */
    readonly basis: readonly string[],
  ) {
    super(message);
    this.name = 'AmbiguousIdentityError';
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
    //
    // A clean or infected verdict is final. A document stored without one —
    // the request died between storing and scanning, or the scanner answered
    // `error` during an outage — is scanned again, here, with the bytes that
    // just arrived (they hash to the same document). Answering from the missing
    // verdict instead meant no retry, on any door, could ever get the document
    // read (ADR 0047 §10). The new verdict is appended; nothing is mutated.
    const recorded = await deps.store.latestScan(existing.documentId);
    if (recorded !== undefined && recorded.status !== 'error') {
      return {
        document: existing,
        verdict: recorded,
        deduplicated: true,
        warnings: accepted.warnings,
      };
    }
    const verdict = await deps.scanner.scan(input.bytes);
    await deps.store.recordScan(existing.documentId, verdict);
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
   * What a remittance's lines came to, when the document was one (ADR 0028).
   *
   * Absent for every other document type. Deliberately not folded into `case`:
   * one remittance opens many, and naming one of them would be a choice the
   * document did not make.
   */
  readonly remittance?: RemittanceRead;
  /**
   * Why the document stopped where it did, when it did not go all the way.
   * `'held_for_review'` (`HELD_FOR_REVIEW`) for a held document, which `held`
   * then describes — a caller branches on `held`, never on this sentence.
   */
  readonly haltedBecause?: string;
  /**
   * The hold that stopped this document opening a case (ADR 0044): the read
   * would have opened one, and the classifier was below the tenant's floor or
   * the reading did not fit its type. Present for a hold this read decided and
   * for one an earlier read recorded.
   */
  readonly held?: DocumentHold;
}

export interface ProcessedDocument extends DocumentRead {
  readonly ingest: IngestResult;
  /**
   * True when these bytes were a document already read, uploaded to a case
   * that did not hold it, and its recorded reading was filed there instead of
   * being read again (`answerFromRecord`). `case` is that case.
   */
  readonly filedFromRecord?: true;
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
 * read did not, and there is exactly one way that happens: it is a notice that
 * has no case, and this read may open one. The earlier read was an
 * unauthenticated email's (ADR 0016), which files the document and refuses to
 * open a case from it, or it was one that failed on the way in.
 *
 * A document being attached to a case it is not on yet is *not* that. The same
 * BOL is evidence for two deductions, and its second upload dedupes to the same
 * document; what the second case needs is a link, and the reading that link
 * files is already recorded. That used to go through the read — the read was
 * where an upload's link and event were written — which paid for the page a
 * second time to learn nothing new. Now the answer says which case to file it
 * on (`fileOnCase`), and `answerFromRecord` files it there without a model
 * call. Skipping the link would lose a reviewer's attachment, so an answer
 * with `fileOnCase` is never one to report and stop at.
 *
 * Except when a read *held* it (ADR 0044). A held notice has no case on
 * purpose: the classifier doubted it, or the reading did not fit, and a person
 * decides. Reading it again would pay for another sample of the same doubt, so
 * a hold is answered from the record — on a redelivered job, a "Read again" and
 * the same file uploaded twice alike. The person's way forward is "Open a case
 * from it", which reads nothing (`openHeldDocument`).
 *
 * Nothing here writes. It is a question, asked before the first model call.
 */
export interface RecordedRead {
  readonly docType: DocType;
  /** The case the earlier read filed it against, when the store can say. */
  readonly deductionId?: string;
  /** The hold an earlier read recorded, when it is still standing and no case holds the document. */
  readonly held?: DocumentHold;
  /**
   * The case the caller named, when that case does not hold the document yet.
   * The recorded reading is what files it there — `answerFromRecord` does,
   * with no model call — so this is work still to do, not a finished answer.
   * `deductionId` is absent beside it: the case does not hold the document.
   */
  readonly fileOnCase?: string;
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
    if (!linked.some((d) => d.documentId === document.documentId)) {
      return { docType: recorded.docType, fileOnCase: options.attachToCase };
    }
    return { docType: recorded.docType, deductionId: options.attachToCase };
  }

  const deductionId = await deps.store.caseForDocument?.(document.documentId);

  // A case first: a document on a case is on that case, whatever a hold row
  // says. The one way both can stand is a release whose case opened and whose
  // `document.hold_released` row was never written (`openHeldDocument`), and
  // there the case is the truth.
  if (deductionId === undefined) {
    const held = await deps.store.documentHold(document.documentId);
    if (held !== undefined) return { docType: recorded.docType, held };
  }

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

/** What `answerFromRecord` settled without reading anything. */
export interface AnsweredFromRecord {
  readonly docType: DocType;
  /** The case the document is on — the one this call filed it on, when it did. */
  readonly deductionId?: string;
  /** The hold an earlier read recorded (ADR 0044), as `recordedRead` says it. */
  readonly held?: DocumentHold;
  /**
   * The case this call filed the recorded reading on, when it did: one
   * `deduction_documents` link and one `evidence.attached` event, written
   * together, and no model call. Absent for everything else — including a race
   * another request won, where the case already holds the document and
   * `deductionId` says so.
   */
  readonly filedOn?: CaseRecord;
}

/**
 * `recordedRead`, acted on: what a previous read already settles, with the one
 * write it can still owe.
 *
 * That write is an attachment. A reviewer uploading, on a case page, a file
 * this tenant has already read — the BOL that is evidence for two deductions,
 * the same receipt pressed twice from two cases — is asking for a link, and
 * the reading the link files is recorded. So the case gets that reading
 * through `attachEvidence`, the one transaction the case list's Attach button
 * uses, and nothing is fetched, classified, extracted or paid for. The event
 * is `evidence.attached` with `read_again: false`, because that is what
 * happened: nothing was read for this case.
 *
 * Every path that would otherwise start a read asks this first — the inline
 * upload, the request that would queue one, and the job — so the three cannot
 * disagree about when a page is paid for twice. `undefined` is the same answer
 * `recordedRead` gives: nothing recorded settles it, and the caller reads.
 *
 * The case is resolved again before the write, with the refusals every attach
 * has (`resolveAttachTarget`): a case that has gone or was merged away while
 * the upload was in flight is refused by name rather than linked, and the
 * database would refuse a merged one anyway (`RCM01`).
 */
export async function answerFromRecord(
  document: Pick<StoredDocument, 'documentId'>,
  deps: PipelineDeps,
  options: ReadOptions = {},
): Promise<AnsweredFromRecord | undefined> {
  const recorded = await recordedRead(document, deps, options);
  if (recorded === undefined) return undefined;

  if (recorded.fileOnCase === undefined) {
    return {
      docType: recorded.docType,
      ...(recorded.deductionId !== undefined ? { deductionId: recorded.deductionId } : {}),
      ...(recorded.held !== undefined ? { held: recorded.held } : {}),
    };
  }

  const target = await resolveAttachTarget(recorded.fileOnCase, deps);
  if (target === undefined) throw new CaseNotFoundError(recorded.fileOnCase);
  const filed = await deps.store.attachEvidence({
    // The case's tenant, as its row says — the org the claims name, since the
    // case was found under them.
    orgId: target.orgId,
    deductionId: target.deductionId,
    documentId: document.documentId,
    docType: recorded.docType,
  });
  // Ids and a doc type: nothing off the page (invariant 4).
  console.info(
    `[recouple] read: document ${document.documentId} was already read as a ${recorded.docType}; ` +
      (filed
        ? `its recorded reading was filed on case ${target.deductionId} without reading it again`
        : `case ${target.deductionId} already held it, so nothing was written`),
  );
  return {
    docType: recorded.docType,
    deductionId: target.deductionId,
    ...(filed ? { filedOn: target } : {}),
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
  // already opened rather than told nothing happened — or, uploading it to a
  // case that does not hold it yet, to that case, where the recorded reading
  // has just been filed (`answerFromRecord`).
  if (ingest.deduplicated) {
    const already = await answerFromRecord(ingest.document, deps, options);
    if (already?.filedOn !== undefined) {
      return { ingest, case: already.filedOn, filedFromRecord: true };
    }
    if (already?.held !== undefined) {
      // Held for a person by the first read (ADR 0044). The same bytes again are
      // not a reason to pay for a second opinion from the same classifier; the
      // reviewer is told where the document is waiting instead.
      return { ingest, held: already.held, haltedBecause: HELD_FOR_REVIEW };
    }
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
  const mayOpenCase = options.allowCaseOpen ?? true;

  // The tenant's classification floor, when this read might open a case (ADR
  // 0044). Asked before the page is fetched or a model is called: a tenant with
  // no readable floor is refused loudly, and the refusal costs nothing. A read
  // attached to a named case, or one that may not open a case at all, never
  // opens one on the classifier's say-so, so it has no use for the floor.
  const floor =
    caseRecord === undefined && mayOpenCase ? await deps.store.classificationFloor() : undefined;

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

  // The gate (ADR 0044). Only where a case would otherwise open by itself — a
  // notice or a remittance, no case named, and a read that may open one — and
  // only then does the classifier's confidence decide anything: at or above the
  // tenant's floor, and a reading that fits the type it was read as, or nobody
  // opens a case until a person says so.
  //
  // A held document is read exactly as any other: the spend, the classification
  // and the extraction are recorded, against no case. Then the hold is written,
  // naming the member whose read it was — after the read, because the read is
  // what the hold is about and it is already paid for. Nothing else happens: no
  // case, no identifier, no declined line.
  if (floor !== undefined && opensCaseOnItsOwn(classification.docType)) {
    const hold = holdFor({
      docType: classification.docType,
      confidence: classification.confidence,
      floor,
      reading: extraction,
    });
    if (hold !== undefined) {
      await recordTheRead();
      const held: DocumentHold = {
        documentId: document.documentId,
        orgId: document.orgId,
        docType: classification.docType,
        confidence: classification.confidence,
        floor,
        reason: hold.reason,
        ...(hold.fields !== undefined ? { fields: hold.fields } : {}),
      };
      await deps.store.recordHold(held);
      // Ids, a doc type and a reason: nothing off the page (invariant 4).
      console.info(
        `[recouple] read: document ${document.documentId} read as a ${classification.docType} ` +
          `was held for review (${hold.reason}); no case was opened`,
      );
      return { classification, extraction, held, haltedBecause: HELD_FOR_REVIEW };
    }
  }

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
  // lines run afterwards (ADR 0028).
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
 * case" and neither of those is a reason to open a new one. A case merged into
 * another throws too (ADR 0042): the database would refuse the link after the
 * read had been paid for, so it is refused here, before the bytes are stored.
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
  if (found.state === 'merged') throw new CaseMergedAwayError(attachToCase);
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
 * What opening a case from a document needs of that document: its ids, not its
 * bytes. A case opened from a held reading (ADR 0044) is opened from an id and a
 * recorded reading, and fetching a scan's megabytes to learn its tenant would be
 * a cost with nothing bought.
 */
export type CaseOpeningDocument = Pick<StoredDocument, 'documentId' | 'orgId'>;

/**
 * What opening a case needs of a reading: what it was read as and what it says.
 * `ExtractionResult` from a read, or `RestoredExtraction` from the store — the
 * same object except where `restoreDocument` says otherwise.
 */
export type CaseOpeningReading = Pick<ExtractionResult, 'docType' | 'document'> & {
  readonly schemaVersion?: string;
};

/**
 * What opening a case needs of the pipeline: the store and nothing else. No
 * classifier and no extractor, so a caller that opens a case from a recorded
 * reading cannot call a model by accident — there is none to call.
 */
export type CaseOpeningDeps = Pick<PipelineDeps, 'store'>;

/** Options for opening a case from a reading. */
export interface CaseOpeningOptions {
  /**
   * Set when a person opened this case from a held document (ADR 0044): each
   * `case.discovered` then says the reading was doubted, by how much, and who
   * decided to open it anyway.
   */
  readonly confirmation?: HoldConfirmation;
}

/**
 * The fields a person's confirmation adds to `case.discovered` (and to a
 * remittance line's merge event): ids, two numbers, a reason from a closed set
 * and schema field paths — never a value off the page.
 */
function confirmationFields(confirmation: HoldConfirmation | undefined): Record<string, unknown> {
  if (confirmation === undefined) return {};
  return {
    held: {
      confidence: confirmation.held.confidence,
      floor: confirmation.held.floor,
      reason: confirmation.held.reason,
      // Which fields the read could not fit, as the hold recorded them — so the
      // case says what was missing when a person chose to open it anyway.
      ...(confirmation.held.fields !== undefined ? { fields: [...confirmation.held.fields] } : {}),
    },
    confirmed_by: confirmation.confirmedBy,
    ...(confirmation.missingOnOpen !== undefined
      ? { fields_missing_on_open: [...confirmation.missingOnOpen] }
      : {}),
  };
}

/**
 * Opens a case from an extracted notice and walks it discovered → classified
 * through the state machine, so the transition table is what governs the case's
 * life rather than an ad-hoc string assignment.
 */
export async function openCaseFromNotice(
  document: CaseOpeningDocument,
  extraction: CaseOpeningReading,
  deps: CaseOpeningDeps,
  options: CaseOpeningOptions = {},
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
  // Preserve the printed identifier and the observed arrival source (ADRs 0024/0028).
  const invoiceNumber = printedIdentifier(extraction.document, 'invoice_number');
  const source = await deps.store.uploadSourceFor(document.documentId);

  const opened = await deps.store.openCase({
    orgId: document.orgId,
    ...(typeof claimId === 'string' ? { claimId } : {}),
    ...(typeof invoiceNumber === 'string' && invoiceNumber.trim() !== ''
      ? { invoiceNumber }
      : {}),
    ...(source !== undefined ? { source } : {}),
    ...(retailer.name !== undefined ? { retailerName: retailer.name } : {}),
    ...(total !== undefined ? { deductionAmountCents: total } : {}),
    ...(deductionDate.date !== undefined ? { deductionDate: deductionDate.date } : {}),
    ...(disputeDeadline.date !== undefined ? { disputeDeadline: disputeDeadline.date } : {}),
  });

  // Every name this case is known by, in the table built for them (ADR 0025).
  // Nothing but that migration's own backfill has ever written a row; this is
  // the `openCase` wiring it left as follow-up.
  const names = await deps.store.recordIdentifiers({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    documentId: document.documentId,
    identifiers: [
      ...(typeof claimId === 'string' && claimId.trim() !== ''
        ? [{ kind: 'claim_id' as const, identifier: claimId }]
        : []),
      ...(invoiceNumber !== undefined
        ? [{ kind: 'invoice_number' as const, identifier: invoiceNumber }]
        : []),
    ],
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
      // How many names were recorded, and why none were when none were. Said on
      // the event rather than swallowed: a case with no identifier rows is a
      // case the matcher cannot recognise a second copy of.
      identifiers_recorded: names.written,
      ...(names.skippedBecause !== undefined
        ? { identifiers_unrecorded: names.skippedBecause }
        : {}),
      // Null, not absent, when no debtor matched: the projection is rebuildable
      // from the events, and "nobody matched" is itself the fact (ADR 0019 §8).
      debtor_id: opened.debtorId ?? null,
      deduction_date: deductionDate.date ?? null,
      dispute_deadline: disputeDeadline.date ?? null,
      // A claim id we could not record as an identifier, because nothing says
      // which channel the notice arrived through and `deduction_identifiers`
      // is source-qualified. Said out loud rather than filed under a guessed
      // channel: only documents stored before provenance existed land here.
      ...(typeof claimId === 'string' && source === undefined
        ? { claim_identifier_unrecorded: 'the notice names no arrival, so no source could be given' }
        : {}),
      ...(retailer.problem !== undefined ? { retailer_name_unread: retailer.problem } : {}),
      ...(deductionDate.problem !== undefined
        ? { deduction_date_unread: deductionDate.problem }
        : {}),
      ...(disputeDeadline.problem !== undefined
        ? { dispute_deadline_unread: disputeDeadline.problem }
        : {}),
      ...confirmationFields(options.confirmation),
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
    payload: { doc_type: extraction.docType, schema_version: extraction.schemaVersion ?? null },
  });

  return classified;
}

/**
 * The longest identifier a case stores — the cap migration 0022 puts on
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
function printedMoneyCents(document: unknown, ...path: readonly string[]): Cents | undefined {
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
  /** An identifier matched a case exactly: the same deduction, arriving twice. */
  | 'merged'
  /**
   * A case for this invoice, amount and date already exists, but not exactly —
   * so it is opened anyway and the probable duplicate is named on its event. A
   * person decides (ADR 0025: a wrong merge is invisible, a duplicate is not).
   */
  | 'probable_duplicate'
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
  /** For a probable duplicate: the case that might be this one already. */
  readonly probableDuplicateOf?: readonly string[];
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
  | { readonly cents: Cents; readonly basis: 'printed' | 'gross_minus_net' }
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
  // `subCents`, not `-`: core-domain's own integer-cents subtraction, the same
  // one `detectShortPays` computes its ledger gap with. It keeps the `Cents`
  // brand and refuses a result outside the safe integer range rather than
  // producing one (invariant 3, ADR 0028 §9).
  return { cents: subCents(gross, net), basis: 'gross_minus_net' };
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
 * a document could print (invariant 3, ADR 0028 §3).
 */
export function clearsRemittanceTolerance(
  deltaCents: number,
  grossCents: number | undefined,
  settings: Pick<RemittanceSettings, 'toleranceCents' | 'toleranceBps'>,
): boolean {
  // `applyBps` was the other candidate and is the wrong tool: it rounds half-up,
  // which is right for a fee and wrong for a threshold — a line exactly on the
  // boundary would fall one side or the other depending on the cent, and nobody
  // reading this could say which without working the rounding out (ADR 0028 §3).
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
 * staffing, freight and foodservice is most of them (ADR 0028).
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
  document: CaseOpeningDocument,
  extraction: CaseOpeningReading,
  deps: CaseOpeningDeps,
  options: CaseOpeningOptions = {},
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

  // Every line's claim key, computed over the whole advice at once, because
  // whether a line's invoice repeats is a fact about the page and not the line
  // (ADR 0048 §1).
  const keys = lineClaimIds(rows, paymentReference);
  // Each line's short-pay, up front, so which line of a repeated invoice owns a
  // case opened under the old key does not depend on the order lines are
  // processed in (ADR 0048 §3).
  const shortPays = rows.map((row) => shortPayOnLine(row));
  // Cases this advice opened. Its own lines are never candidates for each
  // other, exact or probable (ADR 0048 §2).
  const openedHere = new Set<string>();

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

    const key = keys[index];
    if (key?.sharesGrossAndNet === true && !fieldWasPrinted(line, 'deduction_amount')) {
      // `gross − net` here is the whole invoice's short-pay, which another line
      // of this advice also claims. Given to every line it would count the same
      // dollars once per line (ADR 0048 §4).
      note({
        outcome: 'unreadable',
        detail:
          'the line repeats its invoice\'s gross and net alongside another line of this advice ' +
          'and prints no deduction of its own, so its share of the short-pay cannot be told',
      });
      continue;
    }

    const shortPay = shortPays[index] ?? shortPayOnLine(line);
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
        // The claim id this line builds, which is what an exact match is on.
        // `key` is defined for every line that prints an invoice number, and this
        // one does; the fallback is ADR 0028's key, never a guess.
        const claimId = key?.claimId ?? lineClaimId(paymentReference, invoiceNumber);
        const legacyClaimId = key?.legacyClaimId;
        // Deliberately only the claim id. The invoice number is *recorded* as an
        // identifier, because it is a name this deduction is known by — but it
        // is not matched on exactly, because one invoice legitimately carries
        // many deductions and a shortage and a price claim against the same
        // invoice are two. It reaches the matcher as `invoiceNumber` below,
        // where it is the probable branch's field and has to agree with the
        // amount and the date before it means anything (ADR 0028 §6).
        const arrivalIdentifiers = [{ kind: 'claim_id' as const, identifier: claimId }];
        const found = await deps.store.identityCandidates({
          orgId: document.orgId,
          identifiers:
            legacyClaimId === undefined
              ? arrivalIdentifiers
              : [...arrivalIdentifiers, { kind: 'claim_id' as const, identifier: legacyClaimId }],
          invoiceNumber,
        });
        // The cases this advice opened are not candidates for its own later
        // lines: two deductions printed side by side are two (ADR 0048 §2).
        const knownDeductions = found.knownDeductions.filter(
          (known) => !openedHere.has(known.deductionId),
        );
        const claimKey = identifierMatchKey(claimId);
        const legacyKey = legacyClaimId === undefined ? undefined : identifierMatchKey(legacyClaimId);
        const knownIdentifiers = found.knownIdentifiers.filter(
          (known) =>
            !openedHere.has(known.deductionId) &&
            known.kind === 'claim_id' &&
            identifierMatchKey(known.identifier) === claimKey,
        );
        const resolution = resolveIdentity(
          {
            identifiers: arrivalIdentifiers,
            amountCents: shortPay.cents,
            invoiceNumber,
            ...(paymentDate.date !== undefined ? { deductionDate: paymentDate.date } : {}),
          },
          knownIdentifiers,
          knownDeductions,
          { dateToleranceDays: settings.dedupDays },
        );

        // Only `exact` merges. `probable` and `ambiguous` open the case and say
        // so on its event, which is ADR 0025's asymmetry applied literally: a
        // duplicate case is visible and mergeable, a wrong merge destroys a
        // disputable deduction and leaves no record that it was ever seen.
        if (resolution.kind === 'exact') {
          await mergeIntoCase(resolution.deductionId, document, extraction, deps, {
            invoiceNumber,
            amountCents: shortPay.cents,
            ...(reasonCode !== undefined ? { reasonCode } : {}),
            matchedOn: [resolution.matchedOn.kind],
            ...(options.confirmation !== undefined ? { confirmation: options.confirmation } : {}),
          });
          return {
            index,
            invoiceNumber,
            outcome: 'merged',
            deductionId: resolution.deductionId,
          };
        }

        // A case opened under ADR 0028's key before this invoice's lines were
        // told apart (ADR 0048 §3). It is this line's when their amounts agree
        // and no earlier line of the group owns it; any other line of the group
        // leaves it alone when some line owns it, and names it when none does.
        const legacyIds =
          legacyKey === undefined
            ? []
            : [
                ...new Set(
                  found.knownIdentifiers
                    .filter(
                      (known) =>
                        !openedHere.has(known.deductionId) &&
                        known.kind === 'claim_id' &&
                        identifierMatchKey(known.identifier) === legacyKey,
                    )
                    .map((known) => known.deductionId),
                ),
              ];
        const legacyFlagged: string[] = [];
        for (const legacyId of legacyIds) {
          const amount = found.knownDeductions.find((d) => d.deductionId === legacyId)?.amountCents;
          const owner =
            amount === undefined ? undefined : legacyOwner(key?.group ?? [], shortPays, amount);
          if (owner === index) {
            await mergeIntoCase(legacyId, document, extraction, deps, {
              invoiceNumber,
              amountCents: shortPay.cents,
              ...(reasonCode !== undefined ? { reasonCode } : {}),
              matchedOn: ['claim_id'],
              detail:
                'this case was opened under the claim id the whole invoice shared before its ' +
                'lines were told apart (ADR 0048), and its amount is this line\'s',
              ...(options.confirmation !== undefined ? { confirmation: options.confirmation } : {}),
            });
            return { index, invoiceNumber, outcome: 'merged', deductionId: legacyId };
          }
          if (owner === undefined) legacyFlagged.push(legacyId);
        }

        const probableDuplicateOf = withLegacy(probableDuplicates(resolution), legacyFlagged);
        const probableBasis =
          legacyFlagged.length === 0
            ? resolution.kind === 'none'
              ? undefined
              : resolution.basis
            : [...(resolution.kind === 'none' ? [] : resolution.basis), 'legacy_claim_id'];

        try {
          const opened = await openCaseForLine(document, deps, {
            invoiceNumber,
            claimId,
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
            ...(probableDuplicateOf !== undefined && probableBasis !== undefined
              ? { probableDuplicateOf, probableBasis }
              : {}),
            ...(options.confirmation !== undefined ? { confirmation: options.confirmation } : {}),
          });
          return {
            index,
            invoiceNumber,
            outcome: probableDuplicateOf === undefined ? 'opened' : 'probable_duplicate',
            deductionId: opened.deductionId,
            ...(probableDuplicateOf !== undefined ? { probableDuplicateOf } : {}),
          };
        } catch (error) {
          // The claim this line builds is already open against this debtor, and
          // the matcher did not see it — which happens when the earlier case
          // carries no identifier rows, the state every case opened before this
          // change is in. The constraint caught what the matcher could not, and
          // it caught it on the same string, so this is an exact match by
          // another route. The other forty-one lines are unaffected.
          if (!(error instanceof DuplicateCaseError)) throw error;
          await mergeIntoCase(error.existingDeductionId, document, extraction, deps, {
            invoiceNumber,
            amountCents: shortPay.cents,
            ...(reasonCode !== undefined ? { reasonCode } : {}),
            matchedOn: ['claim_id'],
            detail:
              'the claim this line builds is already open against this debtor; ' +
              'the unique constraint caught what the identifier matcher could not',
            ...(options.confirmation !== undefined ? { confirmation: options.confirmation } : {}),
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
    if (outcome.outcome === 'opened' || outcome.outcome === 'probable_duplicate') {
      openedHere.add(outcome.deductionId);
      const record = await deps.store.getCase(outcome.deductionId);
      if (record !== undefined) opened.push(record);
    } else {
      mergedInto.push(outcome.deductionId);
    }
  }

  await reportLinesProcessed(document, extraction, deps, { opened, mergedInto, lines });
  return { opened, mergedInto, lines };
}

/**
 * The claim id a remittance line builds, from the advice's own identifiers.
 *
 * A remittance prints no claim id, because nobody filed a claim — they paid
 * less. But `unique (org_id, debtor_id, claim_id)` is what stops the same
 * deduction opening two cases once a debtor resolves, and a null opts every one
 * of these out of it: Postgres does not compare nulls, which is the bug ADR 0019
 * was written about. Payment reference plus invoice number is on the page,
 * unique per line within a payment, and readable by a person holding the advice.
 *
 * It is also what `resolveIdentity`'s exact branch fires on when the same advice
 * is read twice, which is the one duplicate we are certain about (ADR 0028 §7).
 */
function lineClaimId(paymentReference: string | undefined, invoiceNumber: string): string {
  return paymentReference === undefined
    ? invoiceNumber
    : `${paymentReference}:${invoiceNumber}`;
}

/** One line's claim key, and what the rest of the advice says about it. */
interface LineKey {
  /** What this line's case is keyed by, and what an exact match is on. */
  readonly claimId: string;
  /**
   * ADR 0028's key, when this line's invoice repeats on the advice and so no
   * longer keys it: the claim id a case opened before ADR 0048 carries.
   */
  readonly legacyClaimId?: string;
  /** Indices of every line printing this invoice, this one included, in page order. */
  readonly group: readonly number[];
  /** Another line of the group prints the same gross and the same net. */
  readonly sharesGrossAndNet: boolean;
}

/**
 * Every line's claim key, keyed by index; undefined for a line with no invoice.
 *
 * `lineClaimId` for an invoice printed on one line — unchanged, so every case
 * already opened from such a line still matches exactly (ADR 0048 §3). For an
 * invoice printed on several, each line is `…#n`, its 1-based ordinal among
 * them in page order: two deductions against one invoice are two, and the old
 * key would have made the second an exact match for the first (ADR 0048 §1).
 */
function lineClaimIds(
  rows: readonly unknown[],
  paymentReference: string | undefined,
): readonly (LineKey | undefined)[] {
  const groups = new Map<string, number[]>();
  const invoices = rows.map((row) => printedIdentifier(row, 'invoice_number'));
  invoices.forEach((invoice, index) => {
    if (invoice === undefined) return;
    const key = identifierMatchKey(invoice);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });

  return invoices.map((invoice, index) => {
    if (invoice === undefined) return undefined;
    const group = groups.get(identifierMatchKey(invoice)) ?? [index];
    const base = lineClaimId(paymentReference, invoice);
    if (group.length === 1) return { claimId: base, group, sharesGrossAndNet: false };
    const gross = printedMoneyCents(rows[index], 'gross_amount');
    const net = printedMoneyCents(rows[index], 'net_amount');
    const sharesGrossAndNet =
      gross !== undefined &&
      net !== undefined &&
      group.some(
        (other) =>
          other !== index &&
          printedMoneyCents(rows[other], 'gross_amount') === gross &&
          printedMoneyCents(rows[other], 'net_amount') === net,
      );
    return {
      claimId: `${base}#${group.indexOf(index) + 1}`,
      legacyClaimId: base,
      group,
      sharesGrossAndNet,
    };
  });
}

/**
 * Which line of a repeated invoice owns a case opened under the old key: the
 * first, in page order, whose short-pay is that case's amount. Undefined when
 * none is. Pure over the whole group, so every line of it gets one answer.
 */
function legacyOwner(
  group: readonly number[],
  shortPays: readonly ReturnType<typeof shortPayOnLine>[],
  amountCents: number,
): number | undefined {
  return group.find((i) => {
    const pay = shortPays[i];
    return pay !== undefined && 'cents' in pay && pay.cents === amountCents;
  });
}

function withLegacy(
  probable: readonly string[] | undefined,
  legacy: readonly string[],
): readonly string[] | undefined {
  if (legacy.length === 0) return probable;
  return [...new Set([...(probable ?? []), ...legacy])].sort();
}

/**
 * The cases this arrival might already be, when the matcher would not commit.
 *
 * `undefined` for `exact` — which never reaches here, it merges — and for
 * `none`. Both `probable` and `ambiguous` come back as a list, because from the
 * point of view of the case being opened they mean the same thing: somebody has
 * to look. Ids only; a basis is reported beside this and a basis names facts,
 * never their values (`identity.ts`).
 */
function probableDuplicates(resolution: IdentityResolution): readonly string[] | undefined {
  if (resolution.kind === 'probable') return [resolution.deductionId];
  if (resolution.kind === 'ambiguous') return resolution.deductionIds;
  return undefined;
}

/** Opens one case from one short-paid line, and walks it discovered → classified. */
async function openCaseForLine(
  document: CaseOpeningDocument,
  deps: CaseOpeningDeps,
  line: {
    readonly invoiceNumber: string;
    readonly claimId: string;
    readonly amountCents: number;
    readonly basis: 'printed' | 'gross_minus_net';
    readonly grossCents?: number;
    readonly reasonCode?: string;
    readonly payerName?: string;
    readonly payerProblem?: string;
    readonly paymentReference?: string;
    readonly paymentDate?: string;
    readonly paymentDateProblem?: string;
    readonly probableDuplicateOf?: readonly string[];
    readonly probableBasis?: readonly string[];
    /** A person opened this from a held remittance (ADR 0044). */
    readonly confirmation?: HoldConfirmation;
  },
): Promise<CaseRecord> {
  const claimId = line.claimId;

  const opened = await deps.store.openCase({
    orgId: document.orgId,
    claimId,
    discoveredVia: 'remittance_line',
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

  // Both names this case is known by, in `deduction_identifiers` (ADR 0025).
  // The invoice number is recorded here and never matched on alone: one invoice
  // carries many deductions, and an exact match on it would merge two of them
  // (ADR 0028 §6).
  const names = await deps.store.recordIdentifiers({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    documentId: document.documentId,
    identifiers: [
      { kind: 'claim_id' as const, identifier: claimId },
      { kind: 'invoice_number' as const, identifier: line.invoiceNumber },
    ],
  });

  await deps.store.appendEvent({
    orgId: document.orgId,
    deductionId: opened.deductionId,
    eventType: 'case.discovered',
    payload: {
      document_id: document.documentId,
      claim_id: claimId,
      discovered_via: 'remittance_line',
      invoice_number: line.invoiceNumber,
      identifiers_recorded: names.written,
      ...(names.skippedBecause !== undefined
        ? { identifiers_unrecorded: names.skippedBecause }
        : {}),
      // A case the matcher thinks might already exist, opened anyway because
      // only an exact match may merge without a person (ADR 0025). The basis
      // names the facts that agreed and never their values.
      ...(line.probableDuplicateOf !== undefined
        ? {
            probable_duplicate_of: [...line.probableDuplicateOf],
            probable_duplicate_basis: [...(line.probableBasis ?? [])],
          }
        : {}),
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
      ...confirmationFields(line.confirmation),
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
  document: CaseOpeningDocument,
  extraction: CaseOpeningReading,
  deps: CaseOpeningDeps,
  line: {
    readonly invoiceNumber: string;
    readonly amountCents: number;
    readonly reasonCode?: string;
    /** The identifier kinds that agreed exactly. Names, never values. */
    readonly matchedOn: readonly string[];
    readonly detail?: string;
    /** A person filed this from a held remittance (ADR 0044). */
    readonly confirmation?: HoldConfirmation;
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
      matched_on: [...line.matchedOn],
      ...(line.detail !== undefined ? { detail: line.detail } : {}),
      ...confirmationFields(line.confirmation),
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
  document: CaseOpeningDocument,
  extraction: CaseOpeningReading,
  deps: CaseOpeningDeps,
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
      probable_duplicate_of: line.probableDuplicateOf ? [...line.probableDuplicateOf] : null,
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
 * Reconciles a case from whatever typed documents it already has, against the
 * claim that opened it: a notice, or — for a case a remittance line opened —
 * that line (ADR 0040). Returns undefined when there is neither — there is
 * nothing to reconcile against.
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
  // Every remittance, not only the first. The line that opened this case is on
  // one of them, and the same advice arriving again — a scan of the PDF — is
  // filed here as evidence by `mergeIntoCase`, after the one that opened it.
  const remittances: RestoredExtraction[] = [];

  for (const document of documents) {
    const extraction = await deps.store.latestExtraction(document.documentId);
    if (extraction === undefined) continue;
    if (extraction.docType === 'remittance_advice') remittances.push(extraction);
    if (!byType.has(extraction.docType)) byType.set(extraction.docType, extraction);
  }

  const unusable: Finding[] = [];
  let claim:
    | { readonly notice: DeductionNotice }
    | { readonly line: { readonly advice: RemittanceAdvice; readonly index: number } | undefined };

  const stored = byType.get('deduction_notice');
  if (stored !== undefined) {
    const notice = DeductionNoticeSchema.safeParse(stored.document);
    if (notice.success) {
      claim = { notice: notice.data };
    } else {
      const unreadable = unreadableFields(notice.error, stored.document);
      if (unreadable === undefined) {
        // A notice whose shape is wrong in some way that is not a missing value —
        // a number where a string belongs, a group that is not an array. Nothing
        // is reconciled against that, and nothing pretends it was. The fields are
        // still stored and still shown; it is the arithmetic that is refused.
        return refusedClaim(unusableDocument('deduction_notice', stored, 'blocking'));
      }
      // Every failure is a required field that came back with no value, which is
      // what a field stored without provenance looks like from here
      // (`fieldsLostOnStorage` says the same thing at the write). The rest of the
      // notice is intact and is worth more than the refusal: reconciliation runs,
      // and the fields that could not be read are named. `reconcileNotice` reads
      // no field object directly, so an absent one is a missing finding rather
      // than a throw.
      claim = { notice: stored.document as DeductionNotice };
      unusable.push(unreadableClaim('deduction_notice', unreadable, unreadable.filter(isMoneyField)));
    }
  } else {
    const opened = await remittanceLineOfCase(deductionId, remittances, deps);
    if (opened === undefined) return undefined;
    if (opened.found === undefined) {
      claim = { line: undefined };
    } else {
      const { stored: advice, index } = opened.found;
      const parsed = RemittanceAdviceSchema.safeParse(advice.document);
      if (parsed.success) {
        claim = { line: { advice: parsed.data, index } };
      } else {
        const unreadable = unreadableFields(parsed.error, advice.document);
        if (unreadable === undefined) {
          return refusedClaim(unusableDocument('remittance_advice', advice, 'blocking'));
        }
        // The notice's rule, narrowed to the line: the rest of an advice is
        // other invoices, and a net amount nobody could quote on one of them is
        // no reason to distrust the arithmetic on this one.
        const onThisLine = `lines[${index}].`;
        claim = { line: { advice: advice.document as RemittanceAdvice, index } };
        unusable.push(
          unreadableClaim(
            'remittance_advice',
            unreadable,
            unreadable.filter((field) => field.startsWith(onThisLine) && isMoneyField(field)),
          ),
        );
      }
    }
  }

  const supporting = <T>(
    docType: DocType,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  ): T | undefined => {
    const found = byType.get(docType);
    if (found === undefined) return undefined;
    const parsed = schema.safeParse(found.document);
    if (parsed.success) return parsed.data;
    unusable.push(unusableDocument(docType, found, 'warning'));
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

  const evidence = {
    ...(invoice !== undefined ? { invoice } : {}),
    ...(shipment !== undefined ? { shipment } : {}),
    ...(correspondence !== undefined ? { correspondence: [correspondence] } : {}),
  };
  const reconciliation =
    'notice' in claim
      ? reconcileNotice({ notice: claim.notice, ...evidence, ...(po !== undefined ? { po } : {}) })
      : // A remittance names no PO, so there is nothing to match one against.
        reconcileRemittanceLine({ line: claim.line, ...evidence });

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
 * The claim was reconciled, and these fields were not in it.
 *
 * Blocking when one of the fields the claim's arithmetic runs over (`money`) is
 * among them, a warning otherwise — never silence, and never the empty
 * reconciliation that a refusal used to produce.
 */
function unreadableClaim(
  docType: 'deduction_notice' | 'remittance_advice',
  fields: readonly string[],
  money: readonly string[],
): Finding {
  return {
    code: 'stored_document_not_typed',
    severity: money.length > 0 ? 'blocking' : 'warning',
    message:
      `the stored ${docType} came back without ${fields.join(', ')} — ` +
      'stored with no page or no quote, so there is no row to rebuild it from. ' +
      (money.length > 0
        ? `${money.join(', ')} carries money, so the reconciliation below cannot be trusted ` +
          'to add up'
        : `the rest of the ${docType === 'deduction_notice' ? 'notice' : 'line'} reconciled normally`),
  };
}

/** The claim document itself could not be used: nothing is reconciled against it. */
function refusedClaim(finding: Finding): Reconciliation {
  return {
    lines: [],
    claimedTotalCents: null,
    lineSumCents: null,
    findings: [finding],
    internallyConsistent: false,
  };
}

/**
 * The remittance line a case was opened from (ADR 0040), found the way it was
 * made: the line whose `lineClaimId` is the case's claim id.
 *
 * `undefined` when the case was not opened from a remittance line — a case with
 * no notice and no such line has nothing to reconcile against, as before.
 * `found: undefined` when it was, and no line on any of its remittances builds
 * that claim id any more: said as a finding, never guessed at.
 */
async function remittanceLineOfCase(
  deductionId: string,
  remittances: readonly RestoredExtraction[],
  deps: PipelineDeps,
): Promise<
  | { readonly found: { readonly stored: RestoredExtraction; readonly index: number } | undefined }
  | undefined
> {
  if (remittances.length === 0) return undefined;
  const record = await deps.store.getCase(deductionId);
  if (record === undefined || record.discoveredVia !== 'remittance_line') return undefined;

  for (const stored of remittances) {
    const rows = fieldValue(stored.document, ['lines']);
    if (!Array.isArray(rows)) continue;
    const reference = printedIdentifier(stored.document, 'payment_reference');
    const keys = lineClaimIds(rows, reference);
    // The line whose key is the case's own; failing that, a case opened under
    // ADR 0028's key before its invoice's lines were told apart, which is the
    // line that owns it by amount (ADR 0048 §3).
    let index = keys.findIndex((key) => key?.claimId === record.claimId);
    if (index === -1) {
      const shortPays = rows.map((row) => shortPayOnLine(row));
      const legacy = keys.find((key) => key?.legacyClaimId === record.claimId);
      index =
        legacy === undefined || record.deductionAmountCents === undefined
          ? -1
          : (legacyOwner(legacy.group, shortPays, record.deductionAmountCents) ?? -1);
    }
    if (index !== -1) return { found: { stored, index } };
  }
  return { found: undefined };
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
function unusableDocument(
  docType: DocType,
  stored: RestoredExtraction,
  // Blocking for the document the claim is on, a warning for evidence.
  severity: 'blocking' | 'warning',
): Finding {
  const why = stored.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.problem}`)
    .join('; ');
  return {
    code: 'stored_document_not_typed',
    severity,
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
