/**
 * The Phase 1 steps: ingest → scan → classify → extract.
 *
 * Each one is separately callable and separately re-runnable. Re-ingesting the
 * same bytes returns the existing document rather than creating a second one,
 * which is what makes the whole chain safe to retry.
 */

import { applyTransition, parseMoneyToCents, tryParsePrintedDate } from '@recouple/core-domain';
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
  document: StoredDocument,
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
    for (const call of [...readable.calls, classification.call]) {
      await deps.store.recordModelCall(withCase(call, deductionId));
    }
    await deps.store.recordClassification(
      document.documentId,
      classification.docType,
      classification.confidence,
    );
    await recordExtraction(document, extraction, deps, deductionId);
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
    ...(classification.docType === 'deduction_notice' && caseRecord === undefined && !mayOpenCase
      ? { haltedBecause: 'a notice from an unauthenticated sender: filed for a human to attach' }
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
  field: 'deduction_date' | 'dispute_deadline',
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
function printedRetailerName(document: unknown): { name?: string; problem?: string } {
  const text = fieldValue(document, ['retailer_name', 'value']);
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

  const opened = await deps.store.openCase({
    orgId: document.orgId,
    ...(typeof claimId === 'string' ? { claimId } : {}),
    ...(retailer.name !== undefined ? { retailerName: retailer.name } : {}),
    ...(total !== undefined ? { deductionAmountCents: total } : {}),
    ...(deductionDate.date !== undefined ? { deductionDate: deductionDate.date } : {}),
    ...(disputeDeadline.date !== undefined ? { disputeDeadline: disputeDeadline.date } : {}),
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
