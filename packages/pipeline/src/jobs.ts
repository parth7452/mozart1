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

import type { PipelineDeps, PipelineStore, StoredDocument } from './ports';
import {
  ingestDocument,
  readDocument,
  resolveAttachTarget,
  scanGateHalt,
  type DocumentRead,
  type IngestInput,
} from './steps';

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
export interface JobStore extends PipelineStore {
  getDocument(documentId: string): Promise<StoredDocument | undefined>;
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
}

/**
 * The read, run from an id.
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

  const document = await deps.store.getDocument(input.documentId);
  if (document === undefined) throw new DocumentNotFoundError(input.documentId);
  if (document.orgId !== input.orgId) {
    throw new InvalidJobPayloadError(
      `document ${input.documentId} does not belong to org ${input.orgId}`,
    );
  }

  // A web upload is an authenticated member's document, so it may open a case.
  // The one caller that must not — an email from a sender we could not
  // authenticate (ADR 0016) — does not go through a job, and when it does it
  // will pass `allowCaseOpen` through rather than inherit this default.
  const read: DocumentRead = await readDocument(document, deps, {
    ...(input.attachToCase !== undefined ? { attachToCase: input.attachToCase } : {}),
  });

  return {
    documentId: document.documentId,
    docType: read.classification?.docType ?? null,
    deductionId: read.case?.deductionId ?? null,
    haltedBecause: read.haltedBecause ?? null,
  };
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
