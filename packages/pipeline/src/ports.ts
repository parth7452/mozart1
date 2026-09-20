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
  /** The tenant an inbound address belongs to, or undefined if there is none. */
  findOrgBySlug(slug: string): Promise<{ readonly orgId: string; readonly slug: string } | undefined>;
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
   * @throws {WrongCaseStateError} the case is not in a state a decision may be made from
   * @throws {WrongRoleError} `preparedBy` is not an `owner` or `analyst` of the tenant
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
   * @throws {PreparerCannotApproveError} the approver prepared this decision
   * @throws {WrongRoleError} the approver is not an `owner` or `approver`
   * @throws {WrongCaseStateError} the case is not awaiting approval
   */
  approve(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approverId: string;
    readonly note?: string;
  }): Promise<{ readonly approvalId: string }>;

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
  }): Promise<{ readonly submissionId: string }>;

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
