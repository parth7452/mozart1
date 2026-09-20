/**
 * An in-memory PipelineStore, and the Phase 3 workflow on top of it.
 *
 * For tests and local development only. It is exported from
 * `@recouple/pipeline/testing`, a separate entry point, so production code
 * cannot reach it by importing the package (CLAUDE.md: no mocks reachable from
 * production paths). The Supabase implementation lands with apps/web.
 *
 * It mirrors the database's behaviour where that behaviour is load-bearing:
 * documents dedupe on (org, sha256), every *_events-shaped list is
 * append-only, and — since ADR 0020 — the workflow's rules are the rules the
 * database enforces: a writer to decide, an owner or approver to approve, never
 * the preparer, one approval per decision and one submission per channel. A
 * store that let something through here that Postgres refuses would make the
 * memory tests a fiction, which is the only way this file can do harm.
 *
 * What it deliberately does *not* model is the gate itself. Nothing in this
 * file can put money in motion; `packages/store-postgres` is where a submission
 * meets `app.require_approval()`, and that trigger is the referee.
 */

import { randomUUID } from 'node:crypto';
import {
  applyTransition,
  buildPacketNarrative,
  isCanonicalReasonCode,
  packetContentHash,
  resolveDebtorId,
} from '@recouple/core-domain';
import type {
  CanonicalReasonCode,
  CaseState,
  DebtorCandidate,
  PacketDocument,
} from '@recouple/core-domain';
import type { DocType, ExtractedField, ModelCallRecord } from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';
import {
  CaseWorkflowError,
  DuplicateSubmissionError,
  InvalidRecoveryAmountError,
  PacketHashMismatchError,
  PreparerCannotApproveError,
  WrongCaseStateError,
  WrongRoleError,
} from '../ports';
import type {
  ApprovalRecord,
  CaseOutcome,
  CaseRecord,
  CaseWorkflow,
  CaseWorkflowStore,
  HumanDecisionRecord,
  OutcomeRecord,
  PacketRecord,
  PipelineStore,
  StoredDocument,
  SubmissionRecord,
  WorkflowSubmissionChannel,
} from '../ports';
import { DuplicateCaseError } from '../steps';

/** A membership role, as `memberships.role` spells it. */
export type MembershipRole = 'owner' | 'approver' | 'analyst' | 'read_only' | 'accountant_guest';

/** Who `app.member_may_write()` lets write (migration 0010). */
const WRITER_ROLES: readonly MembershipRole[] = ['owner', 'approver', 'analyst'];

/** Who `app.enforce_separation_of_duties()` lets approve (migration 0005). */
const APPROVER_ROLES: readonly MembershipRole[] = ['owner', 'approver'];

/**
 * A second approval for the same decision and action.
 *
 * `unique (decision_id, action_type)` on `approvals` (migration 0005): batch
 * approval in the UI writes one row each, never a blanket approval, and a
 * double-clicked approve button is not a second authorisation.
 *
 * Declared here *and* in `@recouple/store-postgres`, identically, because
 * `ports.ts` is frozen for the UI work happening alongside this and a class
 * cannot be added to it yet. A caller sorts it from a bug the way it sorts
 * every other refusal — `instanceof CaseWorkflowError` — and the two stores
 * agree on `name`, which is what the contract test asserts. When `ports.ts`
 * reopens, this class moves there and both copies go.
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

export interface StoredExtraction {
  readonly documentId: string;
  readonly deductionId?: string;
  readonly docType: DocType;
  readonly extractor: string;
  readonly schemaVersion: string;
  readonly fields: readonly ExtractedField[];
  readonly document: unknown;
}

export interface StoredEvent {
  readonly orgId: string;
  readonly deductionId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

export class InMemoryStore implements PipelineStore, CaseWorkflowStore {
  readonly documents = new Map<string, StoredDocument>();
  readonly scans: Array<{ documentId: string; verdict: ScanVerdict }> = [];
  readonly classifications: Array<{ documentId: string; docType: DocType; confidence: number }> = [];
  readonly extractions: StoredExtraction[] = [];
  readonly modelCalls: ModelCallRecord[] = [];
  readonly events: StoredEvent[] = [];
  readonly cases = new Map<string, CaseRecord>();
  readonly links: Array<{ deductionId: string; documentId: string; role: string }> = [];
  readonly pages = new Map<string, string[]>();
  readonly orgs = new Map<string, string>();
  /**
   * The tenant's debtors, as a test set them up. Nothing here ever adds to this
   * list: `openCase` resolves against it and never creates a debtor, which is
   * the behaviour the Postgres store has to match (ADR 0019).
   */
  readonly debtors: DebtorCandidate[] = [];
  /**
   * Who belongs to which tenant, and as what. Empty by default, so a store
   * nobody has set up says no to `memberMayWrite` rather than yes — the same
   * answer the database gives for a user with no `memberships` row. It is also
   * where the workflow reads a role from, so there is one answer to "what is
   * this person allowed to do here" rather than two that can disagree.
   */
  readonly memberships: Array<{ orgId: string; userId: string; role: MembershipRole }> = [];
  readonly decisions: (HumanDecisionRecord & { readonly orgId: string })[] = [];
  readonly packets: (PacketRecord & { readonly deductionId: string })[] = [];
  readonly approvals: (ApprovalRecord & { readonly deductionId: string })[] = [];
  readonly submissions: (SubmissionRecord & { readonly deductionId: string })[] = [];
  readonly outcomes: OutcomeRecord[] = [];

  async findDocumentByHash(orgId: string, sha256: string): Promise<StoredDocument | undefined> {
    return [...this.documents.values()].find((d) => d.orgId === orgId && d.sha256 === sha256);
  }

  async putDocument(document: Omit<StoredDocument, 'documentId'>): Promise<StoredDocument> {
    const stored: StoredDocument = { ...document, documentId: randomUUID() };
    this.documents.set(stored.documentId, stored);
    return stored;
  }

  async recordScan(documentId: string, verdict: ScanVerdict): Promise<void> {
    this.scans.push({ documentId, verdict });
  }

  async latestScan(documentId: string): Promise<ScanVerdict | undefined> {
    return this.scans.filter((s) => s.documentId === documentId).at(-1)?.verdict;
  }

  async recordClassification(
    documentId: string,
    docType: DocType,
    confidence: number,
  ): Promise<void> {
    this.classifications.push({ documentId, docType, confidence });
  }

  async recordExtraction(input: StoredExtraction): Promise<void> {
    this.extractions.push(input);
  }

  async latestExtraction(
    documentId: string,
  ): Promise<{ docType: DocType; document: unknown } | undefined> {
    const found = this.extractions.filter((e) => e.documentId === documentId).at(-1);
    return found === undefined ? undefined : { docType: found.docType, document: found.document };
  }

  async recordModelCall(call: ModelCallRecord): Promise<void> {
    this.modelCalls.push(call);
  }

  async recordPages(
    documentId: string,
    pages: readonly { readonly page: number; readonly text: string }[],
  ): Promise<void> {
    this.pages.set(documentId, [...pages].sort((a, b) => a.page - b.page).map((p) => p.text));
  }

  async pagesFor(documentId: string): Promise<readonly string[] | undefined> {
    return this.pages.get(documentId);
  }

  async openCase(input: {
    orgId: string;
    claimId?: string;
    retailerName?: string;
    deductionAmountCents?: number;
    deductionDate?: string;
    disputeDeadline?: string;
  }): Promise<CaseRecord> {
    const debtorId =
      input.retailerName === undefined
        ? undefined
        : resolveDebtorId(input.retailerName, this.debtors);

    // `unique (org_id, debtor_id, claim_id)`, modelled the way Postgres applies
    // it: a null `debtor_id` (or a null `claim_id`) never collides, because
    // Postgres does not compare nulls. That is not a detail — it is why the same
    // claim uploaded as a PDF and then as a scan opened two cases silently while
    // nothing resolved, and why it stopped once debtors started resolving
    // (ADR 0019). A store that did not model it let the pipeline's duplicate
    // path go untested.
    if (debtorId !== undefined && input.claimId !== undefined) {
      const existing = [...this.cases.values()].find(
        (c) => c.orgId === input.orgId && c.debtorId === debtorId && c.claimId === input.claimId,
      );
      if (existing !== undefined) {
        throw new DuplicateCaseError(
          `claim ${input.claimId} is already open for this debtor as case ${existing.deductionId}`,
          existing.deductionId,
          input.claimId,
        );
      }
    }

    const record: CaseRecord = {
      deductionId: randomUUID(),
      state: 'discovered',
      ...input,
      ...(debtorId !== undefined ? { debtorId } : {}),
    };
    this.cases.set(record.deductionId, record);
    return record;
  }

  async linkDocument(
    deductionId: string,
    documentId: string,
    role: 'notice' | 'evidence',
  ): Promise<void> {
    const already = this.links.some(
      (l) => l.deductionId === deductionId && l.documentId === documentId && l.role === role,
    );
    if (!already) this.links.push({ deductionId, documentId, role });
  }

  async transitionCase(deductionId: string, to: CaseState): Promise<CaseRecord> {
    const current = this.cases.get(deductionId);
    if (current === undefined) throw new Error(`no case ${deductionId}`);
    const next: CaseRecord = { ...current, state: to };
    this.cases.set(deductionId, next);
    return next;
  }

  async appendEvent(input: StoredEvent): Promise<void> {
    this.events.push(input);
  }

  async getCase(deductionId: string): Promise<CaseRecord | undefined> {
    return this.cases.get(deductionId);
  }

  async findOrgBySlug(slug: string): Promise<{ orgId: string; slug: string } | undefined> {
    const orgId = this.orgs.get(slug);
    return orgId === undefined ? undefined : { orgId, slug };
  }

  /** Registers a tenant and the inbound address slug that routes to it. */
  addOrg(slug: string, orgId: string): void {
    this.orgs.set(slug, orgId);
  }

  async memberMayWrite(actor: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<boolean> {
    const role = this.roleOf(actor.orgId, actor.userId);
    return role !== undefined && WRITER_ROLES.includes(role);
  }

  /** Registers a member of a tenant, the way an invitation would. */
  addMember(orgId: string, userId: string, role: MembershipRole = 'analyst'): void {
    this.memberships.push({ orgId, userId, role });
  }

  /** This user's role in this tenant, or nothing — an unknown `sub` has none. */
  private roleOf(orgId: string, userId: string): MembershipRole | undefined {
    return this.memberships.find((m) => m.orgId === orgId && m.userId === userId)?.role;
  }

  /**
   * The notice link first, then whatever else there is — the order the Postgres
   * store reads them in, because a document that opened a case belongs to that
   * case and may also be evidence on another.
   */
  async caseForDocument(documentId: string): Promise<string | undefined> {
    const links = this.links.filter((l) => l.documentId === documentId);
    return (links.find((l) => l.role === 'notice') ?? links[0])?.deductionId;
  }

  async documentsForCase(deductionId: string): Promise<readonly StoredDocument[]> {
    return this.links
      .filter((l) => l.deductionId === deductionId)
      .map((l) => this.documents.get(l.documentId))
      .filter((d): d is StoredDocument => d !== undefined);
  }

  /** Total model spend on this book, in micro-USD. */
  totalCostMicros(): number {
    return this.modelCalls.reduce((sum, call) => sum + call.costMicros, 0);
  }

  // -------------------------------------------------------------------------
  // CaseWorkflowStore (ADR 0020)
  // -------------------------------------------------------------------------
  //
  // The same rules the database enforces, in the same order the database
  // enforces them, so a test written against this store is not describing a
  // system that does not exist. Where the two could differ they are held
  // together by one contract suite that runs the same cases against both
  // (`packages/store-postgres/test/workflow.test.ts`).

  private caseOrThrow(deductionId: string): CaseRecord {
    const found = this.cases.get(deductionId);
    // The same words the Postgres store uses when RLS hides a case: a tenant
    // is never told whether somebody else's case exists.
    if (found === undefined) throw new Error(`case ${deductionId} is not visible to this tenant`);
    return found;
  }

  private requireWriter(orgId: string, userId: string, action: string): void {
    const role = this.roleOf(orgId, userId);
    if (role === undefined || !WRITER_ROLES.includes(role)) {
      throw new WrongRoleError(userId, action, WRITER_ROLES);
    }
  }

  /** The case's documents, notice first, then everything else as it was linked. */
  private packetDocuments(
    deductionId: string,
  ): { readonly ids: string[]; readonly lines: PacketDocument[] } {
    const links = this.links
      .filter((link) => link.deductionId === deductionId)
      .filter((link) => link.role === 'notice' || link.role === 'evidence');
    const ordered = [
      ...links.filter((link) => link.role === 'notice'),
      ...links.filter((link) => link.role !== 'notice'),
    ];
    const ids: string[] = [];
    const lines: PacketDocument[] = [];
    for (const link of ordered) {
      const document = this.documents.get(link.documentId);
      if (document === undefined) continue;
      ids.push(document.documentId);
      lines.push({ role: link.role as PacketDocument['role'], filename: document.filename });
    }
    return { ids, lines };
  }

  async recordHumanDecision(input: {
    readonly deductionId: string;
    readonly preparedBy: string;
    readonly reason: CanonicalReasonCode;
    readonly rationale: string;
  }): Promise<{ readonly decisionId: string }> {
    const existing = this.caseOrThrow(input.deductionId);
    this.requireWriter(existing.orgId, input.preparedBy, 'decide');
    if (existing.state !== 'classified') {
      throw new WrongCaseStateError(input.deductionId, 'decide', existing.state, ['classified']);
    }
    const rationale = input.rationale.trim();
    if (rationale === '') {
      throw new CaseWorkflowError('decide refused: a dispute decision needs a rationale');
    }
    // The type says this is canonical; a form post is a string until something
    // checks.
    if (!isCanonicalReasonCode(input.reason)) {
      throw new CaseWorkflowError(
        `decide refused: ${input.reason} is not a canonical reason code`,
      );
    }
    // The state machine is the spec; naming the trigger is what makes the move
    // a function of the fact that caused it (ADR 0020 §4).
    applyTransition('classified', 'analyst_review', 'decision.recorded', {
      human_decision_recorded: true,
    });

    const record: HumanDecisionRecord & { readonly orgId: string } = {
      decisionId: randomUUID(),
      orgId: existing.orgId,
      deductionId: input.deductionId,
      reason: input.reason,
      rationale,
      preparedBy: input.preparedBy,
      decidedAt: new Date(),
    };
    this.decisions.push(record);
    this.events.push({
      orgId: existing.orgId,
      deductionId: input.deductionId,
      eventType: 'decision.recorded',
      payload: {
        decision_id: record.decisionId,
        provider: 'human',
        schema_id: 'B',
        schema_version: 'human-1',
        reason: record.reason,
        rationale: record.rationale,
        prepared_by: record.preparedBy,
      },
    });
    this.cases.set(input.deductionId, { ...existing, state: 'analyst_review' });
    return { decisionId: record.decisionId };
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
    const existing = this.caseOrThrow(input.deductionId);
    this.requireWriter(existing.orgId, input.assembledBy, 'assemble');
    const decision = this.decisions.find((d) => d.decisionId === input.decisionId);
    if (decision === undefined || decision.deductionId !== input.deductionId) {
      throw new CaseWorkflowError(
        `assemble refused: decision ${input.decisionId} is not a decision on case ${input.deductionId}`,
      );
    }
    const { ids, lines } = this.packetDocuments(input.deductionId);
    if (ids.length === 0) {
      throw new CaseWorkflowError(
        `assemble refused: case ${input.deductionId} has no notice to send`,
      );
    }
    if (existing.deductionAmountCents === undefined) {
      throw new CaseWorkflowError(
        `assemble refused: case ${input.deductionId} has no deduction amount`,
      );
    }
    const narrative = buildPacketNarrative({
      ...(existing.claimId !== undefined ? { claimId: existing.claimId } : {}),
      ...(existing.retailerName !== undefined ? { retailer: existing.retailerName } : {}),
      deductionAmountCents: existing.deductionAmountCents,
      ...(existing.deductionDate !== undefined ? { deductionDate: existing.deductionDate } : {}),
      ...(existing.disputeDeadline !== undefined
        ? { disputeDeadline: existing.disputeDeadline }
        : {}),
      reason: decision.reason,
      rationale: decision.rationale,
      documents: lines,
    });
    const contentHash = packetContentHash({
      decisionId: input.decisionId,
      narrative,
      fileDocumentIds: ids,
    });

    // Identical contents are one packet, whichever button was pressed twice.
    // `unique (decision_id, content_hash)` says so in Postgres; here it is the
    // same lookup, and it comes before the state check for the same reason the
    // Postgres one does: re-assembling is not a second assembly, so a case
    // already waiting for approval must not be told it is in the wrong state.
    const already = this.packets.find(
      (p) => p.decisionId === input.decisionId && p.contentHash === contentHash,
    );
    if (already !== undefined) {
      return {
        packetId: already.packetId,
        contentHash: already.contentHash,
        narrative: already.narrative,
        fileDocumentIds: already.fileDocumentIds,
      };
    }

    // Different contents for the same decision are a second packet, not a
    // conflict — what happens when the reviewer attaches another document and
    // assembles again. Two ways in: from `analyst_review`, which carries the
    // case across the edge, or from `awaiting_approval`, where nothing moves.
    // Not once it is approved, though: there is no second approval
    // (`unique (decision_id, action_type)`), so a packet assembled after one
    // could never be authorised.
    const approved =
      existing.state === 'awaiting_approval'
        ? this.approvals.find((a) => a.decisionId === input.decisionId)
        : undefined;
    if (approved !== undefined) {
      throw new CaseWorkflowError(
        `assemble refused: decision ${input.decisionId} was already approved as packet ` +
          `${approved.packetHash} — a packet assembled now could never be approved`,
      );
    }
    if (existing.state === 'analyst_review') {
      applyTransition('analyst_review', 'awaiting_approval', 'packet.assembled', {
        packet_assembled_and_submission_safe: true,
      });
    } else if (existing.state !== 'awaiting_approval') {
      throw new WrongCaseStateError(input.deductionId, 'assemble', existing.state, [
        'analyst_review',
        'awaiting_approval',
      ]);
    }

    const record: PacketRecord & { readonly deductionId: string } = {
      packetId: randomUUID(),
      deductionId: input.deductionId,
      decisionId: input.decisionId,
      contentHash,
      narrative,
      fileDocumentIds: ids,
      assembledBy: input.assembledBy,
      assembledAt: new Date(),
    };
    this.packets.push(record);
    this.events.push({
      orgId: existing.orgId,
      deductionId: input.deductionId,
      eventType: 'packet.assembled',
      payload: {
        packet_id: record.packetId,
        decision_id: record.decisionId,
        content_hash: record.contentHash,
        file_document_ids: [...record.fileDocumentIds],
        assembled_by: record.assembledBy,
      },
    });
    if (existing.state === 'analyst_review') {
      this.cases.set(input.deductionId, { ...existing, state: 'awaiting_approval' });
    }
    return {
      packetId: record.packetId,
      contentHash: record.contentHash,
      narrative: record.narrative,
      fileDocumentIds: record.fileDocumentIds,
    };
  }

  async approve(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approverId: string;
    readonly note?: string;
  }): Promise<{ readonly approvalId: string }> {
    const packet = this.packets.find((p) => p.packetId === input.packetId);
    if (packet === undefined || packet.decisionId !== input.decisionId) {
      throw new CaseWorkflowError(
        `approve refused: packet ${input.packetId} was not assembled for decision ${input.decisionId}`,
      );
    }
    const existing = this.caseOrThrow(packet.deductionId);
    const decision = this.decisions.find((d) => d.decisionId === input.decisionId);
    if (decision === undefined) {
      throw new CaseWorkflowError(`approve refused: decision ${input.decisionId} does not exist`);
    }
    // Separation of duties, in the order `app.enforce_separation_of_duties()`
    // asks it: the preparer first, then whether this is an approver at all.
    if (decision.preparedBy === input.approverId) {
      throw new PreparerCannotApproveError(input.decisionId, input.approverId);
    }
    const role = this.roleOf(existing.orgId, input.approverId);
    if (role === undefined || !APPROVER_ROLES.includes(role)) {
      throw new WrongRoleError(input.approverId, 'approve', APPROVER_ROLES);
    }
    if (existing.state !== 'awaiting_approval') {
      throw new WrongCaseStateError(packet.deductionId, 'approve', existing.state, [
        'awaiting_approval',
      ]);
    }
    const standing = this.approvals.find((a) => a.decisionId === input.decisionId);
    if (standing !== undefined) {
      throw new DuplicateApprovalError(input.decisionId, standing.approvalId);
    }

    const record: ApprovalRecord & { readonly deductionId: string } = {
      approvalId: randomUUID(),
      deductionId: packet.deductionId,
      decisionId: input.decisionId,
      approverId: input.approverId,
      packetHash: packet.contentHash,
      ...(input.note !== undefined ? { note: input.note } : {}),
      approvedAt: new Date(),
    };
    this.approvals.push(record);
    // No state change: approving is what lets the case leave
    // `awaiting_approval`, and recording the submission is what moves it. The
    // event is the `approval.granted` the submit workflow waits for.
    this.events.push({
      orgId: existing.orgId,
      deductionId: packet.deductionId,
      eventType: 'approval.granted',
      payload: {
        approval_id: record.approvalId,
        decision_id: record.decisionId,
        action_type: 'submit',
        packet_hash: record.packetHash,
        approver_id: record.approverId,
      },
    });
    return { approvalId: record.approvalId };
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
    const packet = this.packets.find((p) => p.packetId === input.packetId);
    if (packet === undefined || packet.decisionId !== input.decisionId) {
      throw new CaseWorkflowError(
        `submit refused: packet ${input.packetId} was not assembled for decision ${input.decisionId}`,
      );
    }
    // The gate, such as it is here: there is no path to a submission that does
    // not start from an approval for this exact decision. In Postgres that is
    // `app.require_approval('submit')`, a trigger, and it holds whatever this
    // store believes (ADR 0020 §5).
    const approval = this.approvals.find((a) => a.approvalId === input.approvalId);
    if (approval === undefined || approval.decisionId !== input.decisionId) {
      throw new CaseWorkflowError(
        `submit refused: no submit approval row for decision ${input.decisionId}`,
      );
    }
    const existing = this.caseOrThrow(packet.deductionId);
    this.requireWriter(existing.orgId, input.actorId, 'submit');
    // Asked before the state check: a case that has been submitted is no longer
    // `awaiting_approval`, and a double-clicked submit button told it is in the
    // wrong state has been told something true and useless.
    const duplicate = this.submissions.find(
      (s) => s.decisionId === input.decisionId && s.channel === input.channel,
    );
    if (duplicate !== undefined) {
      throw new DuplicateSubmissionError(input.decisionId, input.channel, duplicate.submissionId);
    }
    if (existing.state !== 'awaiting_approval') {
      throw new WrongCaseStateError(packet.deductionId, 'submit', existing.state, [
        'awaiting_approval',
      ]);
    }
    if (packet.contentHash !== approval.packetHash) {
      throw new PacketHashMismatchError(
        input.decisionId,
        approval.packetHash,
        packet.contentHash,
      );
    }
    if (input.confirmationNumber.trim() === '') {
      throw new CaseWorkflowError(
        'submit refused: a manual submission is recorded with the confirmation the portal gave',
      );
    }
    applyTransition('awaiting_approval', 'submitted', 'submission.recorded', {
      approval_row_exists: true,
    });

    const record: SubmissionRecord & { readonly deductionId: string } = {
      submissionId: randomUUID(),
      deductionId: packet.deductionId,
      decisionId: input.decisionId,
      channel: input.channel,
      packetHash: packet.contentHash,
      confirmationNumber: input.confirmationNumber,
      submittedAt: input.submittedAt,
    };
    this.submissions.push(record);
    this.events.push({
      orgId: existing.orgId,
      deductionId: packet.deductionId,
      eventType: 'submission.recorded',
      payload: {
        submission_id: record.submissionId,
        decision_id: record.decisionId,
        channel: record.channel,
        packet_hash: record.packetHash,
        confirmation_number: record.confirmationNumber,
        submitted_at: record.submittedAt.toISOString(),
        recorded_by: input.actorId,
      },
    });
    this.cases.set(packet.deductionId, { ...existing, state: 'submitted' });
    return { submissionId: record.submissionId };
  }

  async recordOutcome(input: {
    readonly deductionId: string;
    readonly outcome: CaseOutcome;
    readonly recoveredCents: number;
    readonly recordedBy: string;
    readonly note?: string;
  }): Promise<{ readonly eventId: string }> {
    const existing = this.caseOrThrow(input.deductionId);
    this.requireWriter(existing.orgId, input.recordedBy, 'record outcome');
    // A second outcome is refused by the case no longer being `submitted`,
    // which is also what refuses an outcome on a case nobody filed.
    if (existing.state !== 'submitted') {
      throw new WrongCaseStateError(input.deductionId, 'record outcome', existing.state, [
        'submitted',
      ]);
    }
    if (existing.deductionAmountCents === undefined) {
      throw new CaseWorkflowError(
        `record outcome refused: case ${input.deductionId} has no deduction amount`,
      );
    }
    checkRecoveredCents(
      input.deductionId,
      input.outcome,
      input.recoveredCents,
      existing.deductionAmountCents,
    );
    applyTransition('submitted', input.outcome, 'outcome.recorded', {
      outcome_recorded_by_human: true,
    });

    const eventId = String(this.events.length + 1);
    this.events.push({
      orgId: existing.orgId,
      deductionId: input.deductionId,
      eventType: 'outcome.recorded',
      payload: {
        outcome: input.outcome,
        // As text, digit for digit, because everything that reads a payload
        // back goes through `JSON.parse` and that is where a bigint rounds —
        // the same treatment `case.declined` gives its cents.
        recovered_cents: String(input.recoveredCents),
        recorded_by: input.recordedBy,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    this.outcomes.push({
      eventId,
      deductionId: input.deductionId,
      outcome: input.outcome,
      recoveredCents: input.recoveredCents,
      recordedBy: input.recordedBy,
      ...(input.note !== undefined ? { note: input.note } : {}),
      recordedAt: new Date(),
    });
    this.cases.set(input.deductionId, { ...existing, state: input.outcome });
    return { eventId };
  }

  async getWorkflow(deductionId: string): Promise<CaseWorkflow | undefined> {
    const existing = this.cases.get(deductionId);
    if (existing === undefined) return undefined;
    const decision = this.decisions.filter((d) => d.deductionId === deductionId).at(-1);
    const approval =
      decision === undefined
        ? undefined
        : this.approvals.find((a) => a.decisionId === decision.decisionId);
    // The packet the approval named, when there is one: a case page should
    // show what was approved rather than the most recent thing assembled.
    const packet =
      decision === undefined
        ? undefined
        : approval !== undefined
          ? this.packets.find(
              (p) => p.decisionId === decision.decisionId && p.contentHash === approval.packetHash,
            )
          : this.packets.filter((p) => p.decisionId === decision.decisionId).at(-1);
    const submission =
      decision === undefined
        ? undefined
        : this.submissions.find((s) => s.decisionId === decision.decisionId);
    const outcome = this.outcomes.filter((o) => o.deductionId === deductionId).at(-1);

    // Each part is rebuilt into exactly the port's shape rather than handed
    // over as it is stored: the rows here carry a little extra (the org, the
    // case) that the Postgres store's reads do not, and two stores that answer
    // with different keys are two stores a caller can tell apart.
    return {
      deductionId,
      state: existing.state,
      ...(decision !== undefined
        ? {
            decision: {
              decisionId: decision.decisionId,
              deductionId: decision.deductionId,
              reason: decision.reason,
              rationale: decision.rationale,
              preparedBy: decision.preparedBy,
              decidedAt: decision.decidedAt,
            },
          }
        : {}),
      ...(packet !== undefined ? { packet } : {}),
      ...(approval !== undefined
        ? {
            approval: {
              approvalId: approval.approvalId,
              decisionId: approval.decisionId,
              approverId: approval.approverId,
              packetHash: approval.packetHash,
              ...(approval.note !== undefined ? { note: approval.note } : {}),
              approvedAt: approval.approvedAt,
            },
          }
        : {}),
      ...(submission !== undefined
        ? {
            submission: {
              submissionId: submission.submissionId,
              decisionId: submission.decisionId,
              channel: submission.channel,
              packetHash: submission.packetHash,
              confirmationNumber: submission.confirmationNumber,
              submittedAt: submission.submittedAt,
            },
          }
        : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    };
  }
}

/**
 * What a recovery may be, given what came back.
 *
 * `won` means the whole deduction came back. A dispute that recovered less than
 * the deduction is `partial`, however the retailer described it — otherwise
 * "won" would mean two different amounts and Phase 4's contingency billing
 * would be summing a word rather than a number. `lost` recovered nothing.
 *
 * The Postgres store makes the same judgement against the column's own text
 * rather than against a JS number (invariant 3); the rule is stated twice and
 * held together by one contract suite, because `ports.ts` has nowhere for a
 * shared helper to live until it reopens.
 */
function checkRecoveredCents(
  deductionId: string,
  outcome: CaseOutcome,
  recoveredCents: number,
  deductionAmountCents: number,
): void {
  const refuse = (reason: string): never => {
    throw new InvalidRecoveryAmountError(deductionId, outcome, recoveredCents, reason);
  };
  if (!Number.isInteger(recoveredCents)) refuse('cents are integers (invariant 3)');
  if (!Number.isSafeInteger(recoveredCents)) refuse('no JS number holds that many cents exactly');
  if (recoveredCents < 0) refuse('a recovery cannot be negative');
  if (outcome === 'lost' && recoveredCents !== 0) refuse('a lost case recovered nothing');
  if (outcome === 'won' && recoveredCents !== deductionAmountCents) {
    refuse(
      `a won case recovered the whole deduction of ${deductionAmountCents} cents; ` +
        'anything less is partial',
    );
  }
  if (outcome === 'partial' && (recoveredCents <= 0 || recoveredCents >= deductionAmountCents)) {
    refuse(
      `a partial recovery is strictly between nothing and the whole deduction of ` +
        `${deductionAmountCents} cents`,
    );
  }
}

/** A scanner that always says clean. Tests only — never wire this to anything. */
export class AlwaysCleanScanner {
  readonly name = 'test-always-clean';
  async scan(): Promise<ScanVerdict> {
    return { status: 'clean', scanner: this.name };
  }
}

export class AlwaysInfectedScanner {
  readonly name = 'test-always-infected';
  async scan(): Promise<ScanVerdict> {
    return { status: 'infected', scanner: this.name, detail: 'Eicar-Test-Signature' };
  }
}
