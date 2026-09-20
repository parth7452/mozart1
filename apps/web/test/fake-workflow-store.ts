import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_RATIONALE_LENGTH,
  isCanonicalReasonCode,
  type CanonicalReasonCode,
  type CaseState,
} from '@recouple/core-domain';
import {
  CaseAlreadyDeclinedError,
  CaseNotVisibleError,
  DecisionNotForCaseError,
  DecisionNotFoundError,
  DuplicateApprovalError,
  DuplicateSubmissionError,
  NoApprovalForSubmissionError,
  NotACanonicalReasonError,
  NothingToSendError,
  PacketAfterApprovalError,
  PacketNotForDecisionError,
  RationaleRequiredError,
  RationaleTooLongError,
  InvalidRecoveryAmountError,
  PacketHashMismatchError,
  PreparerCannotApproveError,
  WrongCaseStateError,
  WrongRoleError,
  type ApprovalRecord,
  type CaseOutcome,
  type CaseWorkflow,
  type CaseWorkflowStore,
  type HumanDecisionRecord,
  type OutcomeRecord,
  type PacketRecord,
  type SubmissionRecord,
  type WorkflowSubmissionChannel,
} from '@recouple/pipeline';

/**
 * A `CaseWorkflowStore` that lives in a Map and refuses the same things the
 * real one does.
 *
 * The routes are what these tests are about: which check runs first, what
 * reaches the store, and what a reviewer is told when the answer is no. Running
 * them against Postgres would test the store twice and the handler once, and
 * the store's half — the gate, separation of duties, the packet foreign key —
 * belongs in `packages/store-postgres/test` against a real database, where the
 * triggers are.
 *
 * So this enforces the *rules*, not the storage: the state a case must be in,
 * the roles that may act, the preparer who may not approve, the packet that
 * must be the approved one, and one filing per channel. Every refusal it raises
 * is the named `CaseWorkflowError` the port declares, because a route that
 * translated a message string would go on compiling after the store stopped
 * producing it.
 *
 * It is test-only and lives under `test/`, which is the one place it cannot be
 * imported from a production path.
 */

/** Who may do what, as ADR 0020 §5 splits it between the database and the store. */
const MAY_WRITE: ReadonlySet<string> = new Set(['owner', 'approver', 'analyst']);
/**
 * Deciding and assembling are ordinary writes by a writer.
 *
 * The same set as `MAY_WRITE`, by name rather than by coincidence: the real
 * store passes `WRITER_ROLES` to `lockCase` for both `decide` and `assemble`
 * (`packages/store-postgres/src/workflow.ts`), because a `decisions` row is not
 * an outbound act and nothing about it needs a second person. An `approver` who
 * writes the decision simply cannot be the one who approves it — that is
 * `PreparerCannotApproveError`'s job, not this set's. A narrower set here would
 * make this double refuse what the real store allows, and a route tested
 * against it would be tested against a rule that does not exist.
 */
const MAY_DECIDE: ReadonlySet<string> = MAY_WRITE;
const MAY_APPROVE: ReadonlySet<string> = new Set(['owner', 'approver']);

export interface SeededCase {
  readonly deductionId: string;
  readonly state: CaseState;
  readonly deductionAmountCents: number;
  /** The notice first, then evidence — the order the packet keeps. */
  readonly documentIds?: readonly string[];
}

interface CaseRow {
  state: CaseState;
  readonly deductionAmountCents: number;
  documentIds: string[];
}

export class FakeWorkflowStore implements CaseWorkflowStore {
  closed = 0;

  private readonly cases = new Map<string, CaseRow>();
  /** Cases already logged as declined, by the row that logged them. */
  private readonly declined = new Map<string, string>();
  private readonly roles = new Map<string, string>();
  private readonly decisions = new Map<string, HumanDecisionRecord>();
  private readonly packets = new Map<string, PacketRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly outcomes = new Map<string, OutcomeRecord>();

  /** Every call that reached the store, in order, for ordering assertions. */
  readonly calls: { readonly method: string; readonly input: unknown }[] = [];

  /** What the next call should do instead of its usual answer. */
  throws: unknown;

  /** Fixed so a rendered page and an asserted string do not drift by a second. */
  now = new Date('2026-09-20T09:30:00Z');

  seedCase(input: SeededCase): this {
    this.cases.set(input.deductionId, {
      state: input.state,
      deductionAmountCents: input.deductionAmountCents,
      documentIds: [...(input.documentIds ?? [])],
    });
    return this;
  }

  /**
   * One more document on the case, as attaching evidence does.
   *
   * It changes what a packet assembled now would contain, and therefore its
   * hash — which is the whole reason a packet assembled after an approval
   * cannot be the packet that was approved.
   */
  attach(deductionId: string, documentId: string): this {
    this.caseOf(deductionId).documentIds.push(documentId);
    return this;
  }

  /** A case already in the counterfactual log, which cannot then be disputed. */
  seedDecline(deductionId: string, declinedCandidateId: string): this {
    this.declined.set(deductionId, declinedCandidateId);
    return this;
  }

  /** The membership the database would look up. Unknown users are analysts. */
  setRole(userId: string, role: string): this {
    this.roles.set(userId, role);
    return this;
  }

  private roleOf(userId: string): string {
    return this.roles.get(userId) ?? 'analyst';
  }

  /**
   * A packet for a decision that is not the one that was approved.
   *
   * Real, not a hack: `packets` is unique on `(decision_id, content_hash)`, so
   * assembling *different* contents for the same decision is a second row that
   * can be told apart from the first (ADR 0020 §2). That is exactly what a
   * reviewer who re-assembles after approval produces, and what
   * `PacketHashMismatchError` exists to refuse.
   */
  seedPacket(input: {
    readonly decisionId: string;
    readonly narrative: string;
    readonly fileDocumentIds?: readonly string[];
    readonly assembledBy?: string;
  }): PacketRecord {
    const packet: PacketRecord = {
      packetId: randomUUID(),
      decisionId: input.decisionId,
      contentHash: hashOf(input.decisionId, input.narrative, input.fileDocumentIds ?? []),
      narrative: input.narrative,
      fileDocumentIds: [...(input.fileDocumentIds ?? [])],
      assembledBy: input.assembledBy ?? randomUUID(),
      assembledAt: this.now,
    };
    this.packets.set(packet.packetId, packet);
    return packet;
  }

  private caseOf(deductionId: string): CaseRow {
    const row = this.cases.get(deductionId);
    // The same answer the real store gives: a case this tenant cannot see is
    // absent, by name, so a route can render it as a 404 rather than a fault.
    if (row === undefined) throw new CaseNotVisibleError(deductionId);
    return row;
  }

  private take(method: string, input: unknown): void {
    this.calls.push({ method, input });
    if (this.throws !== undefined) throw this.throws;
  }

  async recordHumanDecision(input: {
    readonly deductionId: string;
    readonly preparedBy: string;
    readonly reason: CanonicalReasonCode;
    readonly rationale: string;
  }): Promise<{ readonly decisionId: string }> {
    this.take('recordHumanDecision', input);
    const row = this.caseOf(input.deductionId);
    if (!MAY_DECIDE.has(this.roleOf(input.preparedBy))) {
      throw new WrongRoleError(input.preparedBy, 'decide', [...MAY_DECIDE]);
    }
    const declined = this.declined.get(input.deductionId);
    if (declined !== undefined) {
      throw new CaseAlreadyDeclinedError(input.deductionId, declined);
    }
    if (row.state !== 'classified') {
      throw new WrongCaseStateError(input.deductionId, 'decide', row.state, ['classified']);
    }
    const rationale = input.rationale.trim();
    if (rationale === '') throw new RationaleRequiredError(input.deductionId);
    // Before the insert, because `decisions` is append-only: a rationale the
    // packet could not hold would wedge the case where nothing can move it.
    if (rationale.length > MAX_RATIONALE_LENGTH) {
      throw new RationaleTooLongError(input.deductionId, rationale.length, MAX_RATIONALE_LENGTH);
    }
    if (!isCanonicalReasonCode(input.reason)) {
      throw new NotACanonicalReasonError(input.deductionId, input.reason);
    }

    const decision: HumanDecisionRecord = {
      decisionId: randomUUID(),
      deductionId: input.deductionId,
      reason: input.reason,
      rationale: input.rationale,
      preparedBy: input.preparedBy,
      decidedAt: this.now,
    };
    this.decisions.set(decision.decisionId, decision);
    row.state = 'analyst_review';
    return { decisionId: decision.decisionId };
  }

  async assemblePacket(input: {
    readonly deductionId: string;
    readonly decisionId: string;
    readonly assembledBy: string;
  }): Promise<{
    readonly packetId: string;
    readonly contentHash: string;
    readonly narrative: string;
    readonly fileDocumentIds: readonly string[];
  }> {
    this.take('assemblePacket', input);
    const row = this.caseOf(input.deductionId);
    if (!MAY_DECIDE.has(this.roleOf(input.assembledBy))) {
      throw new WrongRoleError(input.assembledBy, 'assemble', [...MAY_DECIDE]);
    }
    const decision = this.decisions.get(input.decisionId);
    if (decision === undefined) {
      throw new DecisionNotFoundError(input.decisionId, 'assemble');
    }
    if (decision.deductionId !== input.deductionId) {
      throw new DecisionNotForCaseError(input.decisionId, input.deductionId);
    }
    // An approved decision cannot be re-packeted into something else: there is
    // one approval per decision, so a different packet could never be approved.
    const standing = [...this.approvals.values()].find(
      (candidate) => candidate.decisionId === decision.decisionId,
    );
    if (row.state !== 'analyst_review' && standing === undefined) {
      throw new WrongCaseStateError(input.deductionId, 'assemble', row.state, ['analyst_review']);
    }
    if (row.documentIds.length === 0) throw new NothingToSendError(input.deductionId);

    const narrative = narrativeFor(decision);
    const contentHash = hashOf(decision.decisionId, narrative, row.documentIds);
    if (standing !== undefined && standing.packetHash !== contentHash) {
      throw new PacketAfterApprovalError(decision.decisionId, standing.packetHash);
    }
    // Identical contents twice is the same packet, not a second one — the
    // unique index is what makes re-assembly safe rather than a mistake.
    const existing = [...this.packets.values()].find(
      (candidate) =>
        candidate.decisionId === decision.decisionId && candidate.contentHash === contentHash,
    );
    const packet: PacketRecord = existing ?? {
      packetId: randomUUID(),
      decisionId: decision.decisionId,
      contentHash,
      narrative,
      fileDocumentIds: [...row.documentIds],
      assembledBy: input.assembledBy,
      assembledAt: this.now,
    };
    this.packets.set(packet.packetId, packet);
    row.state = 'awaiting_approval';
    return {
      packetId: packet.packetId,
      contentHash: packet.contentHash,
      narrative: packet.narrative,
      fileDocumentIds: packet.fileDocumentIds,
    };
  }

  async approve(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approverId: string;
    readonly note?: string;
  }): Promise<{ readonly approvalId: string }> {
    this.take('approve', input);
    const decision = this.decisions.get(input.decisionId);
    if (decision === undefined) throw new DecisionNotFoundError(input.decisionId, 'approve');
    const packet = this.packets.get(input.packetId);
    if (packet === undefined || packet.decisionId !== decision.decisionId) {
      throw new PacketNotForDecisionError(input.packetId, input.decisionId, 'approve');
    }
    const row = this.caseOf(decision.deductionId);

    // The order the database enforces it in: role, then separation of duties,
    // then the state. An analyst is refused before they can be told they
    // prepared it.
    if (!MAY_APPROVE.has(this.roleOf(input.approverId))) {
      throw new WrongRoleError(input.approverId, 'approve', [...MAY_APPROVE]);
    }
    if (decision.preparedBy === input.approverId) {
      throw new PreparerCannotApproveError(input.decisionId, input.approverId);
    }
    if (row.state !== 'awaiting_approval') {
      throw new WrongCaseStateError(decision.deductionId, 'approve', row.state, [
        'awaiting_approval',
      ]);
    }
    // `unique (decision_id, action_type)` on `approvals`: a double-clicked
    // button is not a second authorisation.
    const already = [...this.approvals.values()].find(
      (candidate) => candidate.decisionId === input.decisionId,
    );
    if (already !== undefined) {
      throw new DuplicateApprovalError(input.decisionId, already.approvalId);
    }

    const approval: ApprovalRecord = {
      approvalId: randomUUID(),
      decisionId: input.decisionId,
      approverId: input.approverId,
      packetHash: packet.contentHash,
      ...(input.note === undefined ? {} : { note: input.note }),
      approvedAt: this.now,
    };
    this.approvals.set(approval.approvalId, approval);
    return { approvalId: approval.approvalId };
  }

  async recordSubmission(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approvalId: string;
    readonly channel: WorkflowSubmissionChannel;
    readonly confirmationNumber: string;
    readonly submittedAt: Date;
    readonly actorId: string;
  }): Promise<{ readonly submissionId: string }> {
    this.take('recordSubmission', input);
    const decision = this.decisions.get(input.decisionId);
    if (decision === undefined) throw new DecisionNotFoundError(input.decisionId, 'submit');
    const packet = this.packets.get(input.packetId);
    if (packet === undefined || packet.decisionId !== input.decisionId) {
      throw new PacketNotForDecisionError(input.packetId, input.decisionId, 'submit');
    }
    const approval = this.approvals.get(input.approvalId);
    // An approval given for some other decision is not an approval for this
    // one, however real it is: `app.require_approval()` looks for a row keyed
    // on this decision, and a form naming another would be a submission with
    // no approval behind it.
    if (approval === undefined || approval.decisionId !== input.decisionId) {
      throw new NoApprovalForSubmissionError(input.decisionId);
    }
    const row = this.caseOf(decision.deductionId);

    if (!MAY_WRITE.has(this.roleOf(input.actorId))) {
      throw new WrongRoleError(input.actorId, 'submit', [...MAY_WRITE]);
    }
    if (row.state !== 'awaiting_approval') {
      throw new WrongCaseStateError(decision.deductionId, 'submit', row.state, [
        'awaiting_approval',
      ]);
    }
    // The store's half, deliberately not the trigger's: the gate carries one
    // rule, and this is the other one (ADR 0020 §2).
    if (packet.contentHash !== approval.packetHash) {
      throw new PacketHashMismatchError(
        input.decisionId,
        approval.packetHash,
        packet.contentHash,
      );
    }
    const already = [...this.submissions.values()].find(
      (candidate) =>
        candidate.decisionId === input.decisionId && candidate.channel === input.channel,
    );
    if (already !== undefined) {
      throw new DuplicateSubmissionError(input.decisionId, input.channel, already.submissionId);
    }

    const submission: SubmissionRecord = {
      submissionId: randomUUID(),
      decisionId: input.decisionId,
      channel: input.channel,
      packetHash: packet.contentHash,
      confirmationNumber: input.confirmationNumber,
      submittedAt: input.submittedAt,
    };
    this.submissions.set(submission.submissionId, submission);
    row.state = 'submitted';
    return { submissionId: submission.submissionId };
  }

  async recordOutcome(input: {
    readonly deductionId: string;
    readonly outcome: CaseOutcome;
    readonly recoveredCents: number;
    readonly recordedBy: string;
    readonly note?: string;
  }): Promise<{ readonly eventId: string }> {
    this.take('recordOutcome', input);
    const row = this.caseOf(input.deductionId);
    if (!MAY_WRITE.has(this.roleOf(input.recordedBy))) {
      throw new WrongRoleError(input.recordedBy, 'record an outcome', [...MAY_WRITE]);
    }
    if (row.state !== 'submitted') {
      throw new WrongCaseStateError(input.deductionId, 'record an outcome', row.state, [
        'submitted',
      ]);
    }

    const refuse = (reason: string): never => {
      throw new InvalidRecoveryAmountError(
        input.deductionId,
        input.outcome,
        input.recoveredCents,
        reason,
      );
    };
    if (!Number.isInteger(input.recoveredCents)) refuse('cents must be a whole number');
    if (input.recoveredCents < 0) refuse('a recovery cannot be negative');
    if (input.outcome === 'lost' && input.recoveredCents !== 0) {
      refuse('a lost case recovered nothing');
    }
    if (input.outcome === 'won' && input.recoveredCents !== row.deductionAmountCents) {
      refuse('a won case recovered the whole deduction');
    }
    if (
      input.outcome === 'partial' &&
      (input.recoveredCents <= 0 || input.recoveredCents >= row.deductionAmountCents)
    ) {
      refuse('a partial recovery is more than nothing and less than the deduction');
    }

    const outcome: OutcomeRecord = {
      eventId: randomUUID(),
      deductionId: input.deductionId,
      outcome: input.outcome,
      recoveredCents: input.recoveredCents,
      recordedBy: input.recordedBy,
      ...(input.note === undefined ? {} : { note: input.note }),
      recordedAt: this.now,
    };
    this.outcomes.set(outcome.eventId, outcome);
    row.state = input.outcome;
    return { eventId: outcome.eventId };
  }

  async getWorkflow(deductionId: string): Promise<CaseWorkflow | undefined> {
    this.calls.push({ method: 'getWorkflow', input: deductionId });
    const row = this.cases.get(deductionId);
    // A case this tenant cannot see is absent, not forbidden — the same answer
    // RLS gives, and the reason the cover sheet is a 404 rather than a 403.
    if (row === undefined) return undefined;

    const decision = [...this.decisions.values()].find(
      (candidate) => candidate.deductionId === deductionId,
    );
    const approval =
      decision === undefined
        ? undefined
        : [...this.approvals.values()].find(
            (candidate) => candidate.decisionId === decision.decisionId,
          );
    // The packet the approval named, when there is one, and otherwise the
    // latest — the real store's selection (`getWorkflow` in
    // `packages/store-postgres/src/workflow.ts`), because a case page must show
    // what was approved rather than the most recent thing assembled. Taking the
    // first match instead made this double disagree with the store about which
    // packet a reviewer is looking at, which is the one thing the approve card
    // exists to get right: `unique (decision_id, content_hash)` means a
    // re-assembly is a *second* row, and the approval names exactly one of them.
    const forDecision = (candidate: PacketRecord): boolean =>
      decision !== undefined && candidate.decisionId === decision.decisionId;
    const packets = [...this.packets.values()].filter(forDecision);
    const packet =
      approval === undefined
        ? packets[packets.length - 1]
        : packets.find((candidate) => candidate.contentHash === approval.packetHash);
    const submission =
      decision === undefined
        ? undefined
        : [...this.submissions.values()].find(
            (candidate) => candidate.decisionId === decision.decisionId,
          );
    const outcome = [...this.outcomes.values()].find(
      (candidate) => candidate.deductionId === deductionId,
    );

    return {
      deductionId,
      state: row.state,
      ...(decision === undefined ? {} : { decision }),
      ...(packet === undefined ? {} : { packet }),
      ...(approval === undefined ? {} : { approval }),
      ...(submission === undefined ? {} : { submission }),
      ...(outcome === undefined ? {} : { outcome }),
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

/** Deterministic, like the real one: the hash is a pure function of contents. */
function hashOf(
  decisionId: string,
  narrative: string,
  fileDocumentIds: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ decisionId, narrative, fileDocumentIds }))
    .digest('hex');
}

function narrativeFor(decision: HumanDecisionRecord): string {
  return [
    '# Dispute cover sheet',
    '',
    `Reason: ${decision.reason}`,
    `Rationale: ${decision.rationale}`,
  ].join('\n');
}
