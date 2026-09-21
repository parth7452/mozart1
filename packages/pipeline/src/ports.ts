/**
 * What the pipeline needs from the outside world.
 *
 * Steps are pure functions over these ports (ADR 0007), so the whole pipeline
 * runs in a test with no database, no network and no workflow runtime — and the
 * Inngest binding in Phase 1b is a thin adapter rather than a rewrite.
 */

import type { CanonicalReasonCode, CaseState } from '@recouple/core-domain';
import type {
  Classifier,
  DocType,
  ExtractedField,
  Extractor,
  ModelCallRecord,
  OcrProvider,
} from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';

/**
 * Every channel a deduction can reach us through — the closed set behind both
 * `uploads.source` and `declined_candidates.discovered_from` (migration 0014,
 * STRATEGY CH-4).
 *
 * One list, here, because coverage is attributed by it: a document's channel
 * and the channel a decline is counted under have to be the same word or the
 * numbers are about different things. `store-postgres` re-exports this as
 * `DISCOVERED_FROM` rather than keeping a second copy.
 */
export const UPLOAD_SOURCES = [
  'web_upload', // a person added it
  'email_in', // an attachment on an inbound email
  'email_body', // the message itself was the notice (ADR 0016)
  'erp_sync', // found in the accounting ledger, never surfaced by anyone
  'portal_fetch', // pulled from the retailer's own portal
  'edi_812', // the debit advice, which is the deduction document itself
] as const;

export type UploadSource = (typeof UPLOAD_SOURCES)[number];

/**
 * The three of those this pipeline can actually produce today.
 *
 * The other three are Phases 1.5, 2 and 2.5. They exist in the database's check
 * constraint because coverage has to be able to name them; nothing in this
 * package can write one, and a type that claimed otherwise would be a promise
 * to a caller that no code here keeps.
 */
export type IngestSource = Extract<UploadSource, 'web_upload' | 'email_in' | 'email_body'>;

/**
 * Where a document came from, written at the moment it arrives.
 *
 * One `uploads` row per arrival of new bytes (migration 0003). It is the only
 * thing in the database that says which channel found a deduction, so
 * `declined_candidates.discovered_from` is derived from it rather than assumed
 * by whichever caller happened to be declining.
 */
export interface UploadRecord {
  readonly uploadId: string;
  readonly orgId: string;
  readonly source: IngestSource;
  /**
   * The member who put it there, when a person did. An inbound email has none —
   * the sender is not one of our users, and `From:` is forgeable anyway.
   */
  readonly createdBy?: string;
}

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
  /**
   * The arrival that produced these bytes (`documents.upload_id`).
   *
   * Set by `ingestDocument` for everything stored since provenance started
   * being recorded. Absent on the rows that predate it, and that absence is
   * never papered over: a decline that cannot find a channel is refused rather
   * than attributed to a guess.
   */
  readonly uploadId?: string;
}

export interface CaseRecord {
  readonly deductionId: string;
  readonly orgId: string;
  readonly state: CaseState;
  readonly claimId?: string;
  /** The retailer as the page printed it. Display, never identity (ADR 0019). */
  readonly retailerName?: string;
  /**
   * Set only when exactly one of the tenant's debtors matched the printed name.
   * Undefined otherwise — the store never creates a debtor from document text.
   */
  readonly debtorId?: string;
  readonly deductionAmountCents?: number;
  /** `YYYY-MM-DD`, already parsed; undefined when the page said nothing readable. */
  readonly deductionDate?: string;
  readonly disputeDeadline?: string;
}

export interface PipelineStore {
  /** Returns an existing document with the same (org, sha256), if any. */
  findDocumentByHash(orgId: string, sha256: string): Promise<StoredDocument | undefined>;
  putDocument(document: Omit<StoredDocument, 'documentId'>): Promise<StoredDocument>;

  /**
   * Records that something arrived, before the bytes it carried are stored.
   *
   * Written first, and deliberately: a document row that names an upload row
   * that is not there is a document with no provenance, and provenance is what
   * coverage is attributed by. The other order can fail that way; this one can
   * only leave an `uploads` row nothing points at, which nothing counts.
   */
  recordUpload(input: {
    readonly orgId: string;
    readonly source: IngestSource;
    readonly createdBy?: string;
  }): Promise<UploadRecord>;

  /**
   * The channel a document arrived through, or `undefined` for one stored
   * before anything recorded it.
   *
   * `undefined` is an answer, not a default. A caller that needs the channel to
   * be true — attributing a decline, deciding whether a re-drive may open a
   * case — treats it as "this document does not say" and refuses or falls back
   * explicitly, rather than filling in the common case.
   */
  uploadSourceFor(documentId: string): Promise<UploadSource | undefined>;

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

  /**
   * Opens a case. Dates arrive already parsed to `YYYY-MM-DD` — the pipeline
   * does that with `parsePrintedDate`, so no store implementation has its own
   * idea of what "08/14/2026" means. The store resolves `debtorId` from
   * `retailerName` against the tenant's own debtors and aliases, and never
   * creates a debtor.
   */
  openCase(input: {
    orgId: string;
    claimId?: string;
    retailerName?: string;
    deductionAmountCents?: number;
    deductionDate?: string;
    disputeDeadline?: string;
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
  /**
   * The case a document is already filed against, if any — the reverse of
   * `documentsForCase`, and the only way to answer "has this document already
   * been read, and where did it land" from an id alone.
   *
   * Optional on this port and required on `JobStore` (jobs.ts). A job reads
   * from an id and has to be able to answer it; a store that cannot is one the
   * pipeline still works with, it just reports an already-read document without
   * naming the case. It is not optional to allow anyone to skip the check — the
   * check is on `latestExtraction`, which every store has.
   */
  caseForDocument?(documentId: string): Promise<string | undefined>;
  /** The tenant an inbound address belongs to, or undefined if there is none. */
  findOrgBySlug(slug: string): Promise<{ readonly orgId: string; readonly slug: string } | undefined>;
  documentsForCase(deductionId: string): Promise<readonly StoredDocument[]>;
}

/**
 * A document that got through the door and was never read.
 *
 * Stored, scanned clean, and with no extraction against it: the exact state a
 * document is left in when the read was handed to a queue that then did not
 * run it. Nothing about it is wrong — the bytes are in the database and the
 * verdict is recorded — but nothing is coming for it either, and until this
 * existed nothing in the product said so.
 *
 * It carries no page text and no extracted field, because there are none. The
 * filename is the one piece of somebody else's text on it, and it is text a
 * view escapes rather than markup.
 */
export interface UnreadDocument {
  readonly documentId: string;
  /** As uploaded, or empty when the row has none. Untrusted text. */
  readonly filename: string;
  /** When the bytes were stored, ISO-8601. */
  readonly createdAt: string;
  /** How long it has been waiting, whole minutes, by the store's own clock. */
  readonly ageMinutes: number;
  /**
   * Whether it is already filed against a case.
   *
   * A notice that opened nothing and a piece of evidence already attached to a
   * case are both unread here; only this tells them apart, and the difference
   * is what a reviewer needs to know before asking for it to be read again.
   */
  readonly onCase: boolean;
}

/**
 * Reads the documents nobody is coming for.
 *
 * A separate port from `PipelineStore` for `CaseWorkflowStore`'s reason: the
 * pipeline runs unattended and never asks this question. It is asked by a
 * person looking at a list, and answered — like every other read in this
 * system — under that person's own tenant claims rather than by a privileged
 * sweep over everybody's documents (invariant 6).
 */
export interface UnreadDocumentsStore {
  /**
   * Every document of this tenant that is scanned clean, has no extraction and
   * has been waiting longer than `olderThanMinutes`, oldest first.
   *
   * The age is a parameter rather than a constant here because the store is not
   * the place that decides what "stuck" means: a view shows five minutes, a
   * test asks for none, and neither should have to agree with the other.
   *
   * An age that is not a finite, non-negative number of minutes throws rather
   * than being coerced: it is a programming error, and the alternative is a
   * `where created_at < now() - NaN` that quietly answers nothing at all, which
   * reads exactly like "nothing is stuck".
   *
   * `limit` is checked the same way and for the same reason. `limit 0` and
   * `limit -1` are both things Postgres has an opinion about — one answers
   * nothing and the other is a syntax error — and a `NaN` reaches the driver as
   * a bind parameter that answers nothing at all. Every one of those reads to a
   * caller as "nothing is stuck", which is the one answer this list must never
   * give wrongly. It is also capped, because this is a page a person looks at:
   * a tenant with ten thousand stuck documents has a problem no list can show
   * them, and loading all ten thousand to draw the first screen is a second
   * problem on top of it.
   */
  unreadDocuments(olderThanMinutes: number, limit?: number): Promise<readonly UnreadDocument[]>;
}

/**
 * The most stuck documents one call will answer with, whatever it was asked
 * for. A screen, not a database dump.
 */
export const UNREAD_DOCUMENTS_MAX_LIMIT = 200;

/**
 * `unreadDocuments` was asked a question it will not answer.
 *
 * Named rather than a bare `Error` for `CaseWorkflowError`'s reason: a refusal
 * a caller can catch and tell apart from the database being down. Both stores
 * raise this one class, so a caller cannot be right about one store and wrong
 * about the other.
 */
export class UnreadDocumentsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadDocumentsQueryError';
  }
}

/**
 * The refusals, written once so the two stores cannot drift apart in what they
 * accept — the contract suite runs the same assertions against both.
 */
export function assertUnreadDocumentsQuery(olderThanMinutes: number, limit: number): void {
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
    throw new UnreadDocumentsQueryError(
      `unreadDocuments needs an age in whole minutes; this one is ${String(olderThanMinutes)}`,
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > UNREAD_DOCUMENTS_MAX_LIMIT) {
    throw new UnreadDocumentsQueryError(
      `unreadDocuments needs a limit that is a whole number of rows between 1 and ` +
        `${UNREAD_DOCUMENTS_MAX_LIMIT}; this one is ${String(limit)}`,
    );
  }
}

/**
 * One document's read, held by one caller at a time.
 *
 * `readDocumentJob`'s guard — has this document already been read? — is a
 * question asked of the database and then acted on, and between the asking and
 * the acting sits the whole read: OCR, a classify call, an extract call, and
 * for a notice an `openCase`. Two deliveries that overlap inside that window
 * both see "not read yet", and both read. The reviewer who proved it got four
 * model calls, two `extraction_results` rows and two cases for one document,
 * because `unique (org_id, debtor_id, claim_id)` does not fire while
 * `debtor_id` is null (ADR 0019).
 *
 * So the guard needs something the runtime cannot give it: a claim that is
 * held while the work runs, that two processes on two machines both see, and
 * that is released if the holder dies. That is a lock in the database, and it
 * is a *port* rather than a Postgres detail because the in-memory store has to
 * answer it too — a test that proves the serialisation against a store with no
 * lock in it is proving nothing.
 *
 * Not a queue and not a retry: a caller that does not get the claim is told so
 * and does nothing. The document is being read by somebody else, and the right
 * amount of money to spend on learning that is none.
 */
export type DocumentReadLease<T> =
  /** The claim was held for the whole of `work`, and this is what it returned. */
  | { readonly held: true; readonly result: T }
  /** Somebody else holds it. `work` did not run, and nothing was spent. */
  | { readonly held: false };

export interface DocumentReadLock {
  /**
   * Runs `work` while holding this document's read claim, or not at all.
   *
   * The claim is per document, not per tenant: two tenants' reads never
   * contend, and one tenant's two documents do not queue behind each other.
   */
  withDocumentRead<T>(
    documentId: string,
    work: () => Promise<T>,
  ): Promise<DocumentReadLease<T>>;
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

// ---------------------------------------------------------------------------
// Phase 3: the human-decided workflow (ADR 0020)
// ---------------------------------------------------------------------------
//
// A separate interface, deliberately not an extension of `PipelineStore`.
// Every existing implementation and test double would otherwise stop
// compiling, and the two have different lifetimes: the pipeline runs
// unattended, this one runs behind a person who is about to authorise money
// moving. All cents are integer `number` (invariant 3).
//
// Nothing here can reach the far side of the approval gate on its own. The
// database refuses a submission with no `approvals` row for that exact decision
// on that exact deduction, whatever an implementation of this interface
// believes (migration 0005, ADR 0012).

/**
 * How a dispute was filed: the subset of `ChannelKind` (`@recouple/adapters`)
 * that Phase 3 offers. Named apart from the adapters' `SubmissionChannel`,
 * which is the port that *does* the filing rather than the name of how it was
 * done.
 *
 * One member, on purpose. `manual_portal` is the only channel that exists: a
 * person files on the retailer's portal and records the confirmation number.
 * `email` is named in ADR 0020 §3 as what follows, and `portal_agent` is Phase
 * 6 — but a union member is a promise the type makes to every caller, and a
 * caller that passes `'email'` today would be refused by a store that has no
 * way to send one. Widening the type is the one-line change that lands with
 * the channel, so a value of this type can never name a way of filing we
 * cannot do.
 */
export type WorkflowSubmissionChannel = 'manual_portal';

/** What came back. `recoveredCents` is 0 for `lost`. */
export type CaseOutcome = 'won' | 'partial' | 'lost';

/** A human decision, as it sits in `decisions` with `provider = 'human'`. */
export interface HumanDecisionRecord {
  readonly decisionId: string;
  readonly deductionId: string;
  /** The canonical reason code the analyst says this deduction is invalid under. */
  readonly reason: CanonicalReasonCode;
  /** One line, in the analyst's words. It appears in the packet narrative. */
  readonly rationale: string;
  /** The analyst. Never null for a human decision — the SoD trigger reads it. */
  readonly preparedBy: string;
  readonly decidedAt: Date;
}

/**
 * An assembled packet: the notice, the evidence documents and a cover
 * narrative our code built from extracted fields. `contentHash` is the sha256
 * of the canonical contents — hex, lower case, 64 characters.
 */
export interface PacketRecord {
  readonly packetId: string;
  readonly decisionId: string;
  readonly contentHash: string;
  readonly narrative: string;
  /** Ordered: the notice first, then the evidence as the reviewer attached it. */
  readonly fileDocumentIds: readonly string[];
  readonly assembledBy: string;
  readonly assembledAt: Date;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly decisionId: string;
  readonly approverId: string;
  /** The packet this approval authorised, and nothing else. */
  readonly packetHash: string;
  readonly note?: string;
  readonly approvedAt: Date;
}

export interface SubmissionRecord {
  readonly submissionId: string;
  readonly decisionId: string;
  readonly channel: WorkflowSubmissionChannel;
  readonly packetHash: string;
  readonly confirmationNumber: string;
  readonly submittedAt: Date;
}

export interface OutcomeRecord {
  readonly eventId: string;
  readonly deductionId: string;
  readonly outcome: CaseOutcome;
  readonly recoveredCents: number;
  readonly recordedBy: string;
  readonly note?: string;
  readonly recordedAt: Date;
}

/** Everything the case page needs, in one read. Each part is absent until it happens. */
export interface CaseWorkflow {
  readonly deductionId: string;
  readonly state: CaseState;
  readonly decision?: HumanDecisionRecord;
  readonly packet?: PacketRecord;
  readonly approval?: ApprovalRecord;
  readonly submission?: SubmissionRecord;
  readonly outcome?: OutcomeRecord;
}

/**
 * The Phase 3 workflow, from a human's decision to the money coming back.
 *
 * Every method either does the whole thing or throws one of the errors below.
 * None of them returns a status a caller could ignore: a money path that
 * swallows a refusal is the first failure mode `CLAUDE.md` names.
 */
export interface CaseWorkflowStore {
  /**
   * Records an analyst's "dispute this" as a `decisions` row with
   * `provider = 'human'`, `prepared_by = preparedBy` and no model
   * probabilities. Writes a `decision.recorded` event and moves the case to
   * `analyst_review`.
   *
   * The rationale is checked against `MAX_RATIONALE_LENGTH` *before* the
   * insert, because `decisions` is append-only: one that only the packet could
   * have refused would leave the case in `analyst_review` with nothing able to
   * move it.
   *
   * @throws {WrongCaseStateError} the case is not in a state a decision may be made from
   * @throws {WrongRoleError} `preparedBy` is not an `owner` or `analyst` of the tenant
   * @throws {RationaleRequiredError} the rationale is empty or only whitespace
   * @throws {RationaleTooLongError} the rationale would not fit the packet narrative
   * @throws {NotACanonicalReasonError} the reason maps to no family
   */
  recordHumanDecision(input: {
    readonly deductionId: string;
    readonly preparedBy: string;
    readonly reason: CanonicalReasonCode;
    readonly rationale: string;
  }): Promise<{ readonly decisionId: string }>;

  /**
   * Builds the packet for a decision: the case's notice, the evidence
   * documents attached to it, and a cover narrative composed deterministically
   * from already-extracted, already-quote-verified fields. No model call
   * (ADR 0020 §2), so the hash is a pure function of the case.
   *
   * Assembling identical contents twice returns the existing packet rather
   * than failing — `unique (decision_id, content_hash)` is what makes that
   * safe. Writes a `packet.assembled` event and moves the case to
   * `awaiting_approval`.
   *
   * @throws {WrongCaseStateError} the case has no decision to assemble against
   * @throws {WrongRoleError} `assembledBy` may not write in the tenant
   */
  assemblePacket(input: {
    readonly deductionId: string;
    readonly decisionId: string;
    readonly assembledBy: string;
  }): Promise<{
    readonly packetId: string;
    readonly contentHash: string;
    readonly narrative: string;
    readonly fileDocumentIds: readonly string[];
  }>;

  /**
   * Records a human approving a specific packet for submission: one `approvals`
   * row with `action_type = 'submit'` and `packet_hash` set to that packet's
   * hash.
   *
   * The database refuses this if `approverId` prepared the decision, or is not
   * an `owner` or `approver` (migration 0005). This method surfaces those as
   * {@link PreparerCannotApproveError} and {@link WrongRoleError} rather than
   * letting a driver error through.
   *
   * Answers with the case the approval landed on as well as the approval's own
   * id. The store approves the *packet's* case, which the caller never names:
   * `decisionId` and `packetId` come off a form, and a stale tab or a forged
   * post can authorise a case of this tenant other than the one whose page the
   * reviewer is looking at. Without `deductionId` a caller has to read the case
   * back to find out where the write went, and a caller that does not read it
   * back shows a notice on a case where nothing happened.
   *
   * @throws {PreparerCannotApproveError} the approver prepared this decision
   * @throws {WrongRoleError} the approver is not an `owner` or `approver`
   * @throws {WrongCaseStateError} the case is not awaiting approval
   */
  approve(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approverId: string;
    readonly note?: string;
  }): Promise<{ readonly approvalId: string; readonly deductionId: string }>;

  /**
   * Records that a human filed the dispute and what the retailer gave back as a
   * confirmation. Writes a `submission.recorded` event and moves the case to
   * `submitted`.
   *
   * Refuses when the packet being submitted is not the packet that was
   * approved. That check is here and not in the approval trigger on purpose:
   * the trigger carries one rule — no submission without an approval — and
   * stays as narrow and as provable as it is (ADR 0020 §2).
   *
   * Answers with the case the filing was recorded against as well as the
   * submission's own id, for the reason {@link CaseWorkflowStore.approve} does:
   * the store files against the *decision's* case, and the ids it was handed
   * came off a form.
   *
   * @throws {PacketHashMismatchError} `packetId`'s hash differs from the approval's
   * @throws {DuplicateSubmissionError} this decision was already submitted on this channel
   * @throws {WrongCaseStateError} the case is not awaiting approval
   */
  recordSubmission(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approvalId: string;
    readonly channel: WorkflowSubmissionChannel;
    readonly confirmationNumber: string;
    readonly submittedAt: Date;
    readonly actorId: string;
  }): Promise<{ readonly submissionId: string; readonly deductionId: string }>;

  /**
   * Records what came back, as an `outcome.recorded` event plus the case state.
   * `recoveredCents` is an integer: 0 for `lost`, the full deduction for `won`,
   * and strictly between the two for `partial`. No new table — Phase 4's
   * attributable recoveries are read from this event stream.
   *
   * @throws {WrongCaseStateError} the case was never submitted
   * @throws {InvalidRecoveryAmountError} `recoveredCents` contradicts `outcome`,
   *   is not an integer, or is not a number of cents this case could have
   *   recovered
   */
  recordOutcome(input: {
    readonly deductionId: string;
    readonly outcome: CaseOutcome;
    readonly recoveredCents: number;
    readonly recordedBy: string;
    readonly note?: string;
  }): Promise<{ readonly eventId: string }>;

  /** Everything the case page shows, in one read. */
  getWorkflow(deductionId: string): Promise<CaseWorkflow | undefined>;
}

// --- Refusals ---------------------------------------------------------------
//
// One class per way the workflow says no, so a caller can tell a rule from a
// bug. Each carries the ids a reviewer would need to see what happened.

export class CaseWorkflowError extends Error {}

/**
 * The case is not one this session may see.
 *
 * A `CaseWorkflowError` rather than a bare `Error` so a route can render it as
 * a 404 instead of a 500: RLS hiding another tenant's case is the system
 * working, not a fault. The message says nothing about whether the case exists
 * anywhere else, because that is none of this tenant's business.
 */
export class CaseNotVisibleError extends CaseWorkflowError {
  constructor(readonly deductionId: string) {
    super(`case ${deductionId} is not visible to this tenant`);
    this.name = 'CaseNotVisibleError';
  }
}

/**
 * A method named somebody other than the person whose session this is.
 *
 * The store is constructed per request and carries one caller. On a money path
 * a call acting as another user is either a bug or a forgery, and the two look
 * identical from here.
 */
export class ActorIsNotTheSessionError extends CaseWorkflowError {
  constructor(
    readonly actorId: string,
    readonly callerId: string,
    readonly action: string,
  ) {
    super(`${action} refused: this session is ${callerId}, so it cannot act as ${actorId}`);
    this.name = 'ActorIsNotTheSessionError';
  }
}

/** A dispute with no rationale: the packet quotes it, so there has to be one. */
export class RationaleRequiredError extends CaseWorkflowError {
  constructor(readonly deductionId: string) {
    super('decide refused: a dispute decision needs a rationale');
    this.name = 'RationaleRequiredError';
  }
}

/**
 * A rationale longer than the packet narrative can hold.
 *
 * Refused *before* the decision is written, and that timing is the whole point.
 * `decisions` is append-only and the packet is assembled later, so a rationale
 * accepted here and refused there leaves the case in `analyst_review` with no
 * way forward and no way back: the decision cannot be amended, and
 * `assemblePacket` will refuse the same rationale every time. The cap is
 * `MAX_RATIONALE_LENGTH` in `@recouple/core-domain`, derived from the
 * `packets.narrative` check minus what the rest of the cover page spends.
 */
export class RationaleTooLongError extends CaseWorkflowError {
  constructor(
    readonly deductionId: string,
    readonly length: number,
    readonly maxLength: number,
  ) {
    super(
      `decide refused: the rationale is ${length} characters and the packet narrative holds ` +
        `${maxLength} — shorten it now rather than after the decision is recorded`,
    );
    this.name = 'RationaleTooLongError';
  }
}

/**
 * A reason code nothing can map to a family.
 *
 * The type says canonical; a form post is a string until something checks. A
 * code no playbook maps is a decision Phase 5 cannot count and a packet naming
 * a code that means nothing.
 */
export class NotACanonicalReasonError extends CaseWorkflowError {
  constructor(
    readonly deductionId: string,
    readonly reason: string,
  ) {
    super(`decide refused: ${reason} is not a canonical reason code`);
    this.name = 'NotACanonicalReasonError';
  }
}

/** The decision named is not a decision on this case. */
export class DecisionNotForCaseError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly deductionId: string,
  ) {
    super(
      `assemble refused: decision ${decisionId} is not a decision on case ${deductionId}`,
    );
    this.name = 'DecisionNotForCaseError';
  }
}

/** The decision named does not exist, or belongs to a tenant this is not. */
export class DecisionNotFoundError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly action: string,
    readonly detail?: string,
  ) {
    super(
      `${action} refused: decision ${decisionId} does not exist` +
        (detail === undefined ? '' : ` (${detail})`),
    );
    this.name = 'DecisionNotFoundError';
  }
}

/** A case with no notice is a case with nothing to file. */
export class NothingToSendError extends CaseWorkflowError {
  constructor(readonly deductionId: string) {
    super(`assemble refused: case ${deductionId} has no notice to send`);
    this.name = 'NothingToSendError';
  }
}

/**
 * A *different* packet for a decision that has already been approved.
 *
 * `unique (decision_id, action_type)` on `approvals` means there is no second
 * approval, so a packet assembled now could never be authorised — it would sit
 * next to an approval naming the packet it replaced. Refused here rather than
 * left for the hash check to turn into a puzzling mismatch at submission time.
 */
export class PacketAfterApprovalError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly approvedPacketHash: string,
  ) {
    super(
      `assemble refused: decision ${decisionId} was already approved as packet ` +
        `${approvedPacketHash} — a packet assembled now could never be approved`,
    );
    this.name = 'PacketAfterApprovalError';
  }
}

/**
 * The narrative could not be built from this case at all.
 *
 * `buildPacketNarrative` raises a `PacketError`, which is not a
 * `CaseWorkflowError` — it is `core-domain`'s own refusal and knows nothing
 * about cases or callers. Letting it out raw would reach a route as an
 * unclassified throw and be rendered as a fault. This is that refusal with the
 * case named and the original kept as `cause`, so nothing is swallowed.
 */
export class PacketNotBuildableError extends CaseWorkflowError {
  constructor(
    readonly deductionId: string,
    readonly decisionId: string,
    readonly detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `assemble refused: the packet for case ${deductionId} could not be built — ${detail}`,
      options,
    );
    this.name = 'PacketNotBuildableError';
  }
}

/** The packet named was not assembled for the decision named. */
export class PacketNotForDecisionError extends CaseWorkflowError {
  constructor(
    readonly packetId: string,
    readonly decisionId: string,
    readonly action: string,
  ) {
    super(
      `${action} refused: packet ${packetId} was not assembled for decision ${decisionId}`,
    );
    this.name = 'PacketNotForDecisionError';
  }
}

/**
 * A second approval for the same decision and action.
 *
 * `unique (decision_id, action_type)` on `approvals` (migration 0005): batch
 * approval in the UI writes one row each, never a blanket approval, and a
 * double-clicked approve button is not a second authorisation. One class, here,
 * so both stores refuse with the same one and a caller's `instanceof` holds
 * whichever store it was given.
 */
export class DuplicateApprovalError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly existingApprovalId: string,
  ) {
    super(
      `approval refused: decision ${decisionId} was already approved for submission ` +
        `as ${existingApprovalId}`,
    );
    this.name = 'DuplicateApprovalError';
  }
}

/**
 * A case we already decided not to fight cannot then be disputed.
 *
 * `declined_candidates` is the coverage denominator (STRATEGY ADD-1): a case
 * that is both declined and disputed is counted as given up on *and* acted on,
 * and the one number the counterfactual log exists to produce moves. The
 * decline stands; reversing it is a decision of its own and does not exist yet.
 */
export class CaseAlreadyDeclinedError extends CaseWorkflowError {
  constructor(
    readonly deductionId: string,
    readonly declinedCandidateId: string,
  ) {
    super(
      `decide refused: case ${deductionId} was declined (${declinedCandidateId}) and cannot ` +
        'now be disputed',
    );
    this.name = 'CaseAlreadyDeclinedError';
  }
}

/**
 * No approval for this decision, so there is nothing to file.
 *
 * The store asks first so a caller gets a name; the database asks last and
 * asks properly — `app.require_approval('submit')` refuses the insert whatever
 * this store believes (migration 0005, invariant 1).
 */
export class NoApprovalForSubmissionError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly detail?: string,
  ) {
    super(
      `submit refused: no submit approval row for decision ${decisionId}` +
        (detail === undefined ? '' : ` (${detail})`),
    );
    this.name = 'NoApprovalForSubmissionError';
  }
}

/**
 * A manual submission with no confirmation number.
 *
 * A manual filing is only evidence that it happened if it records what the
 * portal gave back; without it there is nothing to chase the retailer with.
 */
export class ConfirmationNumberRequiredError extends CaseWorkflowError {
  constructor(readonly decisionId: string) {
    super(
      'submit refused: a manual submission is recorded with the confirmation the portal gave',
    );
    this.name = 'ConfirmationNumberRequiredError';
  }
}

/** Separation of duties. The database refuses this too; this is its name here. */
export class PreparerCannotApproveError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly approverId: string,
  ) {
    super(
      `approval refused: ${approverId} prepared decision ${decisionId} and cannot approve it`,
    );
    this.name = 'PreparerCannotApproveError';
  }
}

/** The packet being submitted is not the packet that was approved. */
export class PacketHashMismatchError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly approvedHash: string,
    readonly submittedHash: string,
  ) {
    super(
      `submission refused for decision ${decisionId}: approved packet ${approvedHash}, ` +
        `submitted packet ${submittedHash}`,
    );
    this.name = 'PacketHashMismatchError';
  }
}

/** The actor's membership role does not permit the action. */
export class WrongRoleError extends CaseWorkflowError {
  constructor(
    readonly userId: string,
    readonly action: string,
    readonly requiredRoles: readonly string[],
  ) {
    super(
      `${action} refused: ${userId} is not one of ${requiredRoles.join(', ')} in this tenant`,
    );
    this.name = 'WrongRoleError';
  }
}

/** The case is not where this action can happen from (`state-machine.ts` is the spec). */
export class WrongCaseStateError extends CaseWorkflowError {
  constructor(
    readonly deductionId: string,
    readonly action: string,
    readonly state: CaseState,
    readonly expected: readonly CaseState[],
  ) {
    super(
      `${action} refused: case ${deductionId} is ${state}, expected ${expected.join(' or ')}`,
    );
    this.name = 'WrongCaseStateError';
  }
}

/**
 * The recovered amount is not one this outcome could have produced: a
 * non-integer, a negative, anything but 0 for `lost`, or a `partial` that is
 * not strictly between 0 and the deduction.
 *
 * A `CaseWorkflowError` and not a `RangeError`, which is what this was.
 * `RangeError` is thrown by the language — `toFixed(101)`, an out-of-range
 * array length — so a caller that catches it cannot tell a refusal on a money
 * path from a bug in the arithmetic above it, and `instanceof CaseWorkflowError`
 * (the one check a caller needs to sort rules from bugs) would miss it
 * entirely. Invariant 3 is the reason this refusal exists; it gets a name that
 * says so, and the cents that were offered are carried on the error rather
 * than only interpolated into the message.
 */
export class InvalidRecoveryAmountError extends CaseWorkflowError {
  constructor(
    readonly deductionId: string,
    readonly outcome: CaseOutcome,
    readonly recoveredCents: number,
    readonly reason: string,
  ) {
    super(
      `outcome refused for case ${deductionId}: ${outcome} with ${recoveredCents} cents — ${reason}`,
    );
    this.name = 'InvalidRecoveryAmountError';
  }
}

/** Exactly-once per channel, which the database also holds as a unique constraint. */
export class DuplicateSubmissionError extends CaseWorkflowError {
  constructor(
    readonly decisionId: string,
    readonly channel: WorkflowSubmissionChannel,
    readonly existingSubmissionId: string,
  ) {
    super(
      `submission refused: decision ${decisionId} was already submitted on ${channel} ` +
        `as ${existingSubmissionId}`,
    );
    this.name = 'DuplicateSubmissionError';
  }
}
