/**
 * The two halves of an upload, shaped for a workflow runtime (ADR 0021).
 *
 * `ingestForJob` is what a request does before it answers: harden the bytes,
 * store them, scan them. `readDocumentJob` is what a job does afterwards:
 * classify, OCR, extract, open or attach the case. Between them travels an id
 * and nothing else — no bytes, no page text, no extracted field — because the
 * thing in the middle is a third party's queue and document content is
 * untrusted content we do not hand out (invariant 4).
 *
 * Neither function is a second implementation of anything. `ingestForJob` wraps
 * `ingestDocument` and `readDocumentJob` wraps `readDocument`, which are the two
 * `processUpload` calls when there is no job. Steps stay pure functions over the
 * ports (ADR 0007): nothing here knows what Inngest is, and the whole job runs
 * in a test with no queue, no database and no network.
 */

import type {
  DocumentReadLock,
  PipelineDeps,
  PipelineStore,
  StoredDocument,
} from './ports';
import {
  ingestDocument,
  readDocument,
  recordedRead,
  resolveAttachTarget,
  scanGateHalt,
  type DocumentRead,
  type IngestInput,
  type ReadOptions,
} from './steps';
import { HELD_FOR_REVIEW, type HoldReason } from './hold';

/**
 * What a job needs from a store that a request does not: the document itself,
 * by its id.
 *
 * A request holds the bytes it just accepted; a job holds an id somebody sent
 * it. `PostgresStore` already answers this, under the tenant's claims — so a
 * document belonging to another tenant is not "forbidden", it is simply not
 * found, which is RLS doing the work rather than a filter this file remembered
 * to apply (invariant 6).
 */
export interface JobStore extends PipelineStore, DocumentReadLock {
  getDocument(documentId: string): Promise<StoredDocument | undefined>;

  /**
   * Whether this tenant can see this document at all — the same answer
   * `getDocument` gives by returning nothing, without fetching the bytes.
   *
   * A request handler that only needs to decide between "here" and "404" was
   * loading every byte of the document to find out, which on a scanned notice
   * is megabytes fetched and thrown away. This asks the policies the narrow
   * question instead: RLS still decides, and it still decides by the row not
   * being there, so a stale id, a mistyped one and another tenant's are one
   * answer.
   */
  documentIsVisible(documentId: string): Promise<boolean>;

  /**
   * Whether this member may write in this tenant — the question
   * `app.member_may_write()` answers in the database (migration 0010).
   *
   * A job needs it and a request does not, because the two are authenticated
   * differently. A request has a session: the member signed in, `requireSession`
   * resolved their memberships, and the org they are acting in is one the
   * database already said is theirs. A job has an event, and an event is a
   * signed message naming an org and a user — the signature says Inngest sent
   * it, not that the user in it belongs to the org in it.
   *
   * The write policies would refuse the first insert (`tenant_insert` is gated
   * on `app.member_may_write()`), but `tenant_read` is not gated on anything but
   * the org claim, so by then the document has been fetched, OCR'd and read by a
   * model. This is the question asked *before* any of that costs anything.
   *
   * Required here and absent from `PipelineStore`: every path that reaches a job
   * must be able to answer it.
   */
  memberMayWrite(actor: { readonly orgId: string; readonly userId: string }): Promise<boolean>;

  /** Required for a job (see `PipelineStore.caseForDocument`). */
  caseForDocument(documentId: string): Promise<string | undefined>;
}

export interface JobDeps extends PipelineDeps {
  readonly store: JobStore;
}

/** A payload that does not name what a job needs to do its work. */
export class InvalidJobPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobPayloadError';
  }
}

/** A job named a document this tenant cannot see, or that is not there at all. */
export class DocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`no document ${documentId} for this tenant`);
    this.name = 'DocumentNotFoundError';
  }
}

/**
 * Everything the ingest half produced, in values that survive being written to
 * an event: ids and flags, no bytes.
 *
 * `haltedBecause` is set when the scan gate stopped the document at the door.
 * The document row and its verdict are stored — that is what makes the refusal
 * auditable — and nothing is read, so a caller with this in hand must not go on
 * to ask for a read (invariant 4).
 */
export interface IngestedForJob {
  readonly documentId: string;
  readonly orgId: string;
  readonly sha256: string;
  readonly filename: string;
  /** True when these bytes were already stored for this tenant. */
  readonly deduplicated: boolean;
  readonly warnings: readonly string[];
  readonly haltedBecause?: string;
}

/**
 * The part of an upload a request should still do itself: accept the bytes,
 * store them, scan them.
 *
 * Milliseconds plus one scan, all of it fail-closed, and none of it a model
 * call. `RejectedUploadError` still comes back to the caller — a file we do not
 * accept is an answer for the person holding it, not a job for later.
 */
export async function ingestForJob(
  deps: PipelineDeps,
  input: IngestInput,
): Promise<IngestedForJob> {
  const ingest = await ingestDocument(input, deps);
  const halted = ingest.verdict.status !== 'clean';

  return {
    documentId: ingest.document.documentId,
    orgId: ingest.document.orgId,
    sha256: ingest.document.sha256,
    filename: ingest.document.filename,
    deduplicated: ingest.deduplicated,
    warnings: ingest.warnings,
    ...(halted ? { haltedBecause: scanGateHalt(ingest.verdict) } : {}),
  };
}

/**
 * Who asked for this read.
 *
 * Recorded and used to build the store the job reads through — never consulted
 * for permission here. Whether this member may see this document is the
 * database's answer, given under their claims, and it is given by the document
 * not being found.
 */
export interface JobActor {
  readonly userId: string;
}

export interface ReadDocumentJobInput {
  readonly documentId: string;
  readonly orgId: string;
  readonly actor: JobActor;
  readonly attachToCase?: string;
  /**
   * Whether this read may open a case for a notice that has none.
   *
   * Defaults to true, which is what an upload is: an authenticated member put
   * this document here, and a notice they uploaded is a case. The callers that
   * pass `false` are the ones re-driving a document that has already been read
   * once — a second read must not overturn a decision the first one made, and
   * the decision ADR 0016 makes is exactly this one, for a notice that arrived
   * on an email whose sender could not be authenticated.
   */
  readonly allowCaseOpen?: boolean;
}

/**
 * What a completed read amounts to, small enough to be a job's return value and
 * flat enough to read in a run's output.
 */
export interface ReadDocumentJobResult {
  readonly documentId: string;
  /** What the classifier said it was, or null when the read did not get there. */
  readonly docType: string | null;
  /** The case it opened or was filed against, or null when there is none. */
  readonly deductionId: string | null;
  /** Why it went no further, when it did not: null is a read that completed. */
  readonly haltedBecause: string | null;
  /**
   * True when this delivery found the document already read and did nothing:
   * no model call, no second case, no second row of anything.
   *
   * Reported rather than hidden, so a run whose output says a document was read
   * can be told apart from a run that only repeated what an earlier one said.
   */
  readonly alreadyRead: boolean;
  /**
   * True when another delivery was reading this document at that moment, and
   * this one stopped rather than reading it alongside.
   *
   * A narrower statement than `alreadyRead`, which it always accompanies:
   * nothing was spent here either, but the read this answer stands in for is
   * still running somewhere, so `docType` and `deductionId` are null rather
   * than repeated from a record that does not exist yet.
   */
  readonly beingRead: boolean;
  /**
   * Every case a remittance's lines opened or merged into, in page order.
   *
   * Empty for every other document — including a remittance that short-paid
   * nothing over the tenant's floor. `deductionId` stays null for a remittance
   * on purpose: one advice opens many cases, and naming one of them as *the*
   * case would be a choice the document did not make (ADR 0028).
   */
  readonly remittanceCases: readonly string[];
  /**
   * Why the document is held for a person, when it is (ADR 0044): a reason
   * from a closed set, never more. `haltedBecause` is `'held_for_review'`
   * beside it. Set both when this delivery decided the hold and when it found
   * one an earlier delivery recorded — in which case `alreadyRead` is true and
   * nothing was spent.
   */
  readonly held: HoldReason | null;
}

/**
 * The read, run from an id.
 *
 * Four questions come before the read, in this order, because each one is
 * cheaper than what follows it: may this member write in this org at all, is
 * this document theirs, is anybody else reading it right now, and has it
 * already been read? Only then is a page fetched and a model called.
 *
 * The last two are one claim, held in the database for the length of the read.
 * Asked separately they are a check and then a race: the reviewer who found
 * this ran two deliveries of one document at once and got four model calls,
 * two extractions and two cases, every one of them past a guard that had
 * truthfully answered "not read yet" a moment earlier.
 *
 * The document is fetched under the tenant's own claims, so a payload naming
 * another tenant's document finds nothing — and the org it claims is checked
 * against the org the row says, because a store that is not RLS-backed (a test's
 * in-memory one) would otherwise let the two disagree silently.
 *
 * Everything after that is `readDocument`: the same scan gate, the same single
 * read, the same recording order, the same `openCaseFromNotice`. Failures are
 * thrown, not summarised — a job that swallowed one would report a document as
 * read when nothing read it.
 */
export async function readDocumentJob(
  deps: JobDeps,
  input: ReadDocumentJobInput,
): Promise<ReadDocumentJobResult> {
  assertNamed(input.documentId, 'documentId');
  assertNamed(input.orgId, 'orgId');
  assertNamed(input.actor?.userId, 'actor.userId');

  // Before the document is fetched, and so before a byte is read or a micro-
  // dollar spent: is the user this event names a member of the org it names,
  // with write rights? Nothing upstream has established that. The event is
  // signed, which says Inngest delivered it; the ids inside it are still just
  // ids, and the read policy does not check them against each other. A payload
  // that pairs a victim's org with any user id would otherwise be read and paid
  // for, and only refused at the first write.
  //
  // Not retriable: a membership does not appear because we asked twice.
  if (!(await deps.store.memberMayWrite({ orgId: input.orgId, userId: input.actor.userId }))) {
    throw new InvalidJobPayloadError(
      `user ${input.actor.userId} is not a member of org ${input.orgId} who may add documents`,
    );
  }

  const document = await deps.store.getDocument(input.documentId);
  if (document === undefined) throw new DocumentNotFoundError(input.documentId);
  if (document.orgId !== input.orgId) {
    throw new InvalidJobPayloadError(
      `document ${input.documentId} does not belong to org ${input.orgId}`,
    );
  }

  // A web upload is an authenticated member's document, so it may open a case.
  // The callers that must not — an email from a sender we could not
  // authenticate (ADR 0016), and a re-drive of a document that was already read
  // once — pass `allowCaseOpen` through rather than inherit this default. The
  // same options go to `recordedRead` and to the read, so the two agree about
  // what this read would have been for.
  const options: ReadOptions = {
    ...(input.attachToCase !== undefined ? { attachToCase: input.attachToCase } : {}),
    ...(input.allowCaseOpen !== undefined ? { allowCaseOpen: input.allowCaseOpen } : {}),
  };

  // Everything from here to the end of the read happens while this job holds
  // the document's read claim, and it is one claim rather than two steps for
  // the reason the guard alone was not enough: the guard is a question about
  // the past and the read is what changes the answer, so anything that can run
  // between them can run twice. Two overlapping deliveries used to produce four
  // model calls, two extractions and two cases for one document.
  //
  // A delivery that does not get the claim stops, and stops without spending:
  // somebody else is reading this document right now, and the cheapest correct
  // thing to do about that is nothing. It is not queued behind them either —
  // waiting would hold a worker for the length of somebody else's model calls
  // to learn something it can be told immediately.
  const lease = await deps.store.withDocumentRead(document.documentId, async () => {
    // A read already recorded for this document is a read that happened: a
    // retried run, a redelivered event, or the same bytes uploaded twice.
    // Reading it again would classify, extract and — while `debtor_id` is null,
    // which is every tenant's starting state — open a second case, because the
    // unique constraint that catches a duplicate claim does not fire on a null
    // debtor (ADR 0019). So the recorded result is reported and nothing is
    // written.
    const already = await recordedRead(document, deps, options);
    if (already !== undefined) {
      return {
        documentId: document.documentId,
        docType: already.docType,
        deductionId: already.deductionId ?? null,
        // A hold an earlier read recorded is still why this document has no
        // case; it is said again rather than reported as a finished read.
        haltedBecause: already.held !== undefined ? HELD_FOR_REVIEW : null,
        alreadyRead: true,
        beingRead: false,
        // A read that is answered from the record did not open anything. What
        // the earlier one opened is on the cases themselves.
        remittanceCases: [],
        held: already.held?.reason ?? null,
      } satisfies ReadDocumentJobResult;
    }

    const read: DocumentRead = await readDocument(document, deps, options);

    return {
      documentId: document.documentId,
      docType: read.classification?.docType ?? null,
      deductionId: read.case?.deductionId ?? null,
      haltedBecause: read.haltedBecause ?? null,
      alreadyRead: false,
      beingRead: false,
      remittanceCases: [
        ...(read.remittance?.opened ?? []).map((c) => c.deductionId),
        ...(read.remittance?.mergedInto ?? []),
      ],
      held: read.held?.reason ?? null,
    } satisfies ReadDocumentJobResult;
  });

  if (!lease.held) {
    return {
      documentId: document.documentId,
      // Deliberately null rather than guessed: the read that is running has not
      // recorded anything yet, and reporting a doc type this delivery did not
      // establish would be inventing one.
      docType: null,
      deductionId: null,
      haltedBecause: null,
      alreadyRead: true,
      beingRead: true,
      remittanceCases: [],
      held: null,
    };
  }

  return lease.result;
}

/**
 * The case a document will be attached to, refused now rather than in a job.
 *
 * A reviewer attaching evidence is standing in front of the case page when they
 * press the button. If the case is not one their tenant can see, they should be
 * told while they are still there — not by a job failing somewhere they cannot
 * see it. Same function the read itself uses, so the two cannot disagree about
 * what "attachable" means.
 */
export async function assertCaseAttachable(
  deps: PipelineDeps,
  attachToCase: string | undefined,
): Promise<void> {
  await resolveAttachTarget(attachToCase, deps);
}

function assertNamed(value: string | undefined, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidJobPayloadError(`a read job needs ${field}; this one has none`);
  }
}
