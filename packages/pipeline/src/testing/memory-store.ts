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
  MAX_RATIONALE_LENGTH,
  packetContentHash,
  PacketError,
  resolveDebtorId,
} from '@recouple/core-domain';
import type {
  CanonicalReasonCode,
  CaseState,
  DebtorCandidate,
  PacketDocument,
} from '@recouple/core-domain';
import { DOC_TYPES, restoreDocument } from '@recouple/extraction';
import type { DocType, ExtractedField, ModelCallRecord } from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';
import {
  CaseAlreadyDeclinedError,
  CaseNotVisibleError,
  CaseWorkflowError,
  ConfirmationNumberRequiredError,
  DecisionNotForCaseError,
  DecisionNotFoundError,
  DuplicateApprovalError,
  DuplicateSubmissionError,
  InvalidRecoveryAmountError,
  NoApprovalForSubmissionError,
  NotACanonicalReasonError,
  NothingToSendError,
  PacketAfterApprovalError,
  PacketHashMismatchError,
  PacketNotBuildableError,
  PacketNotForDecisionError,
  PreparerCannotApproveError,
  RationaleRequiredError,
  RationaleTooLongError,
  WrongCaseStateError,
  WrongRoleError,
} from '../ports';
import type {
  ApprovalRecord,
  CaseOutcome,
  CaseRecord,
  CaseWorkflow,
  CaseWorkflowStore,
  DeclinedLine,
  DiscoveredVia,
  HumanDecisionRecord,
  IngestSource,
  RemittanceSettings,
  OutcomeRecord,
  PacketRecord,
  DocumentReadLease,
  DocumentReadLock,
  PipelineStore,
  RestoredExtraction,
  StoredDocument,
  SubmissionRecord,
  UnreadDocument,
  UnreadDocumentsStore,
  UploadRecord,
  UploadSource,
  WorkflowSubmissionChannel,
} from '../ports';
import {
  assertUnreadDocumentsQuery,
  ClassificationRefusedError,
  LineProvenanceUnknownError,
} from '../ports';
import { DuplicateCaseError } from '../steps';

/** A membership role, as `memberships.role` spells it. */
export type MembershipRole = 'owner' | 'approver' | 'analyst' | 'read_only' | 'accountant_guest';

/** Who `app.member_may_write()` lets write (migration 0010). */
const WRITER_ROLES: readonly MembershipRole[] = ['owner', 'approver', 'analyst'];

/** Who `app.enforce_separation_of_duties()` lets approve (migration 0005). */
const APPROVER_ROLES: readonly MembershipRole[] = ['owner', 'approver'];

/**
 * A case with no deduction amount, which this store alone can have.
 *
 * `deductions.deduction_amount_cents` is `not null check (> 0)`, so Postgres
 * cannot reach this at all — but `CaseRecord` makes the field optional, so a
 * test can build a case that has none, and a packet without an amount is a
 * dispute that does not say what is being disputed. Named rather than left as
 * a bare `CaseWorkflowError`, so the refusals here can all be told apart.
 */
export class CaseAmountMissingError extends CaseWorkflowError {
  constructor(
    readonly deductionId: string,
    readonly action: string,
  ) {
    super(`${action} refused: case ${deductionId} has no deduction amount`);
    this.name = 'CaseAmountMissingError';
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

export class InMemoryStore
  implements PipelineStore, CaseWorkflowStore, UnreadDocumentsStore, DocumentReadLock
{
  readonly documents = new Map<string, StoredDocument>();
  /** One row per arrival, keyed by id — the `uploads` table (migration 0003). */
  readonly uploads = new Map<string, UploadRecord>();
  /**
   * When each document was stored, which `documents.created_at` is in Postgres.
   *
   * Public and writable on purpose: "this document has been waiting twenty
   * minutes" is the whole subject of `unreadDocuments`, and a test that cannot
   * say so would have to sleep for it.
   */
  readonly documentCreatedAt = new Map<string, Date>();
  /** The documents a `withDocumentRead` is holding right now. */
  private readonly readsInFlight = new Set<string>();
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
  /** What `declineCase` leaves behind: the id and the case, and nothing else. */
  readonly declinedCandidates: Array<{ declinedCandidateId: string; deductionId: string }> = [];

  async findDocumentByHash(orgId: string, sha256: string): Promise<StoredDocument | undefined> {
    return [...this.documents.values()].find((d) => d.orgId === orgId && d.sha256 === sha256);
  }

  /**
   * Where a document came from, one row per arrival, exactly as the `uploads`
   * table holds it.
   *
   * Modelled rather than skipped because the answer is load-bearing: a decline
   * is attributed by it, and a store that handed back a channel for a document
   * that never recorded one would make the contract suite a fiction in the one
   * place it is about a number somebody reports.
   */
  async recordUpload(input: {
    readonly orgId: string;
    readonly source: IngestSource;
    readonly createdBy?: string;
  }): Promise<UploadRecord> {
    const record: UploadRecord = { uploadId: randomUUID(), ...input };
    this.uploads.set(record.uploadId, record);
    return record;
  }

  async uploadSourceFor(documentId: string): Promise<UploadSource | undefined> {
    const uploadId = this.documents.get(documentId)?.uploadId;
    if (uploadId === undefined) return undefined;
    return this.uploads.get(uploadId)?.source;
  }

  async putDocument(document: Omit<StoredDocument, 'documentId'>): Promise<StoredDocument> {
    const stored: StoredDocument = { ...document, documentId: randomUUID() };
    this.documents.set(stored.documentId, stored);
    this.documentCreatedAt.set(stored.documentId, new Date());
    return stored;
  }

  async recordScan(documentId: string, verdict: ScanVerdict): Promise<void> {
    this.scans.push({ documentId, verdict });
  }

  async latestScan(documentId: string): Promise<ScanVerdict | undefined> {
    return this.scans.filter((s) => s.documentId === documentId).at(-1)?.verdict;
  }

  /**
   * The same refusal Postgres gives, so a test against this store is evidence
   * about production and not about this store.
   *
   * The database admits exactly `DOC_TYPES` and nothing else (migration 0021),
   * and a store that quietly accepted a thirteenth would make the in-memory
   * half of every pipeline test pass on a read the real one cannot record —
   * which is the shape the `correspondence` failure had in the first place
   * (ADR 0027).
   */
  async recordClassification(
    documentId: string,
    docType: DocType,
    confidence: number,
  ): Promise<void> {
    if (!(DOC_TYPES as readonly string[]).includes(docType)) {
      throw new ClassificationRefusedError(documentId, docType);
    }
    this.classifications.push({ documentId, docType, confidence });
  }

  async recordExtraction(input: StoredExtraction): Promise<void> {
    this.extractions.push(input);
  }

  /**
   * Rebuilt from the stored *fields*, not handed back from memory.
   *
   * The object this store was given at write time is the one the reader
   * produced, and returning it would make every test that reads a document
   * back pass on a document Postgres cannot produce: the database keeps one row
   * per field and no row at all for an absent one. So this goes through the
   * same `restoreDocument` the Postgres store does, and the two answer
   * identically — which is the only thing that makes an in-memory test evidence
   * about production.
   */
  async latestExtraction(documentId: string): Promise<RestoredExtraction | undefined> {
    const found = this.extractions.filter((e) => e.documentId === documentId).at(-1);
    if (found === undefined) return undefined;
    const rebuilt = restoreDocument(found.docType, found.fields);
    return {
      docType: found.docType,
      document: rebuilt.document,
      validated: rebuilt.validated,
      issues: rebuilt.issues,
    };
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
    discoveredVia?: DiscoveredVia;
    invoiceNumber?: string;
    reasonCodeAsPrinted?: string;
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
      // The column's default, modelled: a case that does not say how it was
      // discovered was discovered by a notice, because until ADR 0026 there was
      // no other way. A store that left it undefined would let a test pass on a
      // case shape Postgres cannot produce.
      discoveredVia: 'notice',
      ...input,
      ...(debtorId !== undefined ? { debtorId } : {}),
    };
    this.cases.set(record.deductionId, record);
    this.caseOpenedAt.set(record.deductionId, new Date());
    return record;
  }

  /**
   * The tenant's remittance floor and dedup window.
   *
   * Defaulted to migration 0021's own defaults, and writable, because the whole
   * subject of a tolerance test is what happens on each side of it.
   */
  readonly remittanceSettingsByOrg = new Map<string, RemittanceSettings>();

  async remittanceSettings(orgId: string): Promise<RemittanceSettings> {
    return (
      this.remittanceSettingsByOrg.get(orgId) ?? {
        toleranceCents: 500,
        toleranceBps: 50,
        dedupDays: 30,
      }
    );
  }

  /**
   * When each case was opened, which `deductions.created_at` is in Postgres.
   *
   * Public and writable for `documentCreatedAt`'s reason: "this case was opened
   * forty days ago" is the whole subject of a dedup-window test, and a test that
   * could not say so would have to wait for it.
   */
  readonly caseOpenedAt = new Map<string, Date>();

  async findRecentCaseByInvoice(
    orgId: string,
    invoiceNumber: string,
    amountCents: number,
    withinDays: number,
  ): Promise<CaseRecord | undefined> {
    const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
    // Oldest first, the way the Postgres store orders it, so two candidates give
    // the same answer in both: the case the deduction actually reached us as.
    const candidates = [...this.cases.values()]
      .filter(
        (c) =>
          c.orgId === orgId &&
          c.invoiceNumber === invoiceNumber &&
          c.deductionAmountCents === amountCents &&
          (this.caseOpenedAt.get(c.deductionId)?.getTime() ?? 0) >= cutoff,
      )
      .sort(
        (a, b) =>
          (this.caseOpenedAt.get(a.deductionId)?.getTime() ?? 0) -
          (this.caseOpenedAt.get(b.deductionId)?.getTime() ?? 0),
      );
    return candidates[0];
  }

  /** The invoices a `withInvoiceClaim` is holding right now. */
  private readonly invoiceClaims = new Set<string>();

  /**
   * The per-invoice claim, as a set in one process.
   *
   * The Postgres store's is an advisory lock in the database, which is what
   * makes it hold across two of them. Same contract: one holder at a time, and
   * the claim released however the work ends. It **waits** rather than refusing,
   * which is the opposite of `withDocumentRead` — there is no model call inside
   * it, and a line that gave up would be a deduction silently dropped.
   *
   * A test is single-threaded enough that contention is the exception, so this
   * polls rather than keeping a waiter queue: the point it models is that the
   * second caller sees the first caller's writes, not how it was scheduled.
   */
  async withInvoiceClaim<T>(
    orgId: string,
    invoiceNumber: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = `${orgId}:${invoiceNumber}`;
    while (this.invoiceClaims.has(key)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.invoiceClaims.add(key);
    try {
      return await work();
    } finally {
      this.invoiceClaims.delete(key);
    }
  }

  /** Every line declined under the tolerance, as `declined_candidates` holds it. */
  readonly declinedLines: Array<
    DeclinedLine & {
      readonly orgId: string;
      readonly documentId: string;
      readonly estimatedRecoverableCents: number;
      readonly externalIds: Readonly<Record<string, string>>;
      readonly decidedByVersion: string;
      readonly detail?: string;
    }
  > = [];

  /**
   * A short-paid line we are not fighting, with no case.
   *
   * The channel is derived here rather than taken, exactly as the Postgres store
   * derives it: a document whose arrival nothing recorded cannot be attributed,
   * and a store that quietly credited `web_upload` would make the contract suite
   * a fiction in the one place it is about a number somebody reports.
   */
  async recordDeclinedLine(input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly estimatedRecoverableCents: number;
    readonly externalIds: Readonly<Record<string, string>>;
    readonly decidedByVersion: string;
    readonly detail?: string;
  }): Promise<DeclinedLine> {
    const discoveredFrom = await this.uploadSourceFor(input.documentId);
    if (discoveredFrom === undefined) throw new LineProvenanceUnknownError(input.documentId);
    const row = {
      declinedCandidateId: randomUUID(),
      discoveredFrom,
      // This store models arrivals recorded at ingest and nothing else — it has
      // no `document_arrivals` — so everything it can answer, it observed.
      provenanceKind: 'observed' as const,
      ...input,
    };
    this.declinedLines.push(row);
    return {
      declinedCandidateId: row.declinedCandidateId,
      discoveredFrom: row.discoveredFrom,
      provenanceKind: row.provenanceKind,
    };
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

  /** The narrow question, answered off the same map `getDocument` reads. */
  async documentIsVisible(documentId: string): Promise<boolean> {
    return this.documents.has(documentId);
  }

  /**
   * The read claim, as a set of the documents being read right now.
   *
   * The Postgres store's is an advisory lock in the database, which is what
   * makes it hold across two processes; this one is a set in one process, which
   * is what a test has. They are the same contract: one holder at a time, the
   * claim released however the work ends, and a caller who does not get it told
   * so rather than made to wait.
   *
   * `held: false` is deliberately not a queue. A caller that waited would hold
   * a worker for the length of somebody else's model calls, to be told at the
   * end of it that the document has been read — which is what it would have
   * been told immediately.
   */
  async withDocumentRead<T>(
    documentId: string,
    work: () => Promise<T>,
  ): Promise<DocumentReadLease<T>> {
    if (this.readsInFlight.has(documentId)) return { held: false };
    this.readsInFlight.add(documentId);
    try {
      return { held: true, result: await work() };
    } finally {
      // In a `finally`, not after the call: a read that throws must release the
      // document, or one failed delivery makes it unreadable for ever.
      this.readsInFlight.delete(documentId);
    }
  }

  /**
   * The documents that were stored and scanned clean and never read.
   *
   * The same three conditions the Postgres store applies, modelled the way
   * Postgres applies them: the *latest* verdict decides, an extraction is the
   * record of a read, and the age is measured against the wall clock. A store
   * that was more generous here would make the contract suite a fiction.
   */
  async unreadDocuments(olderThanMinutes: number, limit = 50): Promise<readonly UnreadDocument[]> {
    assertUnreadDocumentsQuery(olderThanMinutes, limit);
    const now = Date.now();
    const cutoff = now - olderThanMinutes * 60_000;

    return [...this.documents.values()]
      .map((document) => ({
        document,
        createdAt: this.documentCreatedAt.get(document.documentId) ?? new Date(0),
      }))
      .filter(({ document, createdAt }) => {
        if (createdAt.getTime() > cutoff) return false;
        const verdict = this.scans.filter((s) => s.documentId === document.documentId).at(-1);
        if (verdict?.verdict.status !== 'clean') return false;
        return !this.extractions.some((e) => e.documentId === document.documentId);
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map(({ document, createdAt }) => ({
        documentId: document.documentId,
        filename: document.filename,
        createdAt: createdAt.toISOString(),
        ageMinutes: Math.max(0, Math.floor((now - createdAt.getTime()) / 60_000)),
        onCase: this.links.some((l) => l.documentId === document.documentId),
      }));
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
    // The same class and the same words the Postgres store uses when RLS hides
    // a case: a tenant is never told whether somebody else's case exists, and a
    // route can render this as a 404 rather than a fault.
    if (found === undefined) throw new CaseNotVisibleError(deductionId);
    return found;
  }

  /**
   * Just enough of a decline for the rule that follows from it.
   *
   * `PostgresStore.declineCase` writes a `declined_candidates` row with what
   * the case was worth and what was missing (STRATEGY ADD-1); none of that is
   * modelled here. What is modelled is the one thing the workflow reads it
   * for — a case we chose not to fight is not a case to dispute — so
   * `CaseAlreadyDeclinedError` is a rule both stores are held to by the
   * contract suite rather than one only Postgres has.
   *
   * Not a method of `CaseWorkflowStore` — that port has no `declineCase`. Like
   * `addMember` and `addOrg`, this is a seam a test sets the world up through,
   * named after the `PostgresStore` method whose effect it stands in for.
   */
  declineCase(deductionId: string): { readonly declinedCandidateId: string } {
    const declinedCandidateId = randomUUID();
    this.declinedCandidates.push({ declinedCandidateId, deductionId });
    return { declinedCandidateId };
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
    // Asked before the state check, in the order the Postgres store asks it: a
    // case we already chose not to fight is not a case to dispute, whatever
    // state it is sitting in.
    const declined = this.declinedCandidates.find((d) => d.deductionId === input.deductionId);
    if (declined !== undefined) {
      throw new CaseAlreadyDeclinedError(input.deductionId, declined.declinedCandidateId);
    }
    if (existing.state !== 'classified') {
      throw new WrongCaseStateError(input.deductionId, 'decide', existing.state, ['classified']);
    }
    const rationale = input.rationale.trim();
    if (rationale === '') {
      throw new RationaleRequiredError(input.deductionId);
    }
    // Before the insert, because `decisions` is append-only: a rationale only
    // `packets.narrative` could refuse would leave the case in `analyst_review`
    // with nothing able to move it (core-domain/src/packet.ts).
    if (rationale.length > MAX_RATIONALE_LENGTH) {
      throw new RationaleTooLongError(input.deductionId, rationale.length, MAX_RATIONALE_LENGTH);
    }
    // The type says this is canonical; a form post is a string until something
    // checks.
    if (!isCanonicalReasonCode(input.reason)) {
      throw new NotACanonicalReasonError(input.deductionId, input.reason);
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
      throw new DecisionNotForCaseError(input.decisionId, input.deductionId);
    }
    const { ids, lines } = this.packetDocuments(input.deductionId);
    if (ids.length === 0) {
      throw new NothingToSendError(input.deductionId);
    }
    const amountCents = existing.deductionAmountCents;
    if (amountCents === undefined) {
      throw new CaseAmountMissingError(input.deductionId, 'assemble');
    }
    // `core-domain`'s own refusal, wrapped as the workflow's, exactly as the
    // Postgres store wraps it: a `PacketError` is not a `CaseWorkflowError`,
    // and a caller that sorts rules from bugs on the base class would read one
    // as a fault. Nothing is swallowed — the original is the `cause`.
    let narrative: string;
    try {
      narrative = buildPacketNarrative({
        ...(existing.claimId !== undefined ? { claimId: existing.claimId } : {}),
        ...(existing.retailerName !== undefined ? { retailer: existing.retailerName } : {}),
        deductionAmountCents: amountCents,
        ...(existing.deductionDate !== undefined
          ? { deductionDate: existing.deductionDate }
          : {}),
        ...(existing.disputeDeadline !== undefined
          ? { disputeDeadline: existing.disputeDeadline }
          : {}),
        reason: decision.reason,
        rationale: decision.rationale,
        documents: lines,
      });
    } catch (error) {
      if (error instanceof PacketError) {
        throw new PacketNotBuildableError(input.deductionId, input.decisionId, error.message, {
          cause: error,
        });
      }
      throw error;
    }
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
      throw new PacketAfterApprovalError(input.decisionId, approved.packetHash);
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
  }): Promise<{ readonly approvalId: string; readonly deductionId: string }> {
    const packet = this.packets.find((p) => p.packetId === input.packetId);
    if (packet === undefined || packet.decisionId !== input.decisionId) {
      throw new PacketNotForDecisionError(input.packetId, input.decisionId, 'approve');
    }
    const existing = this.caseOrThrow(packet.deductionId);
    const decision = this.decisions.find((d) => d.decisionId === input.decisionId);
    if (decision === undefined) {
      throw new DecisionNotFoundError(input.decisionId, 'approve');
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
    return { approvalId: record.approvalId, deductionId: record.deductionId };
  }

  async recordSubmission(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approvalId: string;
    readonly channel: WorkflowSubmissionChannel;
    readonly confirmationNumber: string;
    readonly submittedAt: Date;
    readonly actorId: string;
  }): Promise<{ readonly submissionId: string; readonly deductionId: string }> {
    const packet = this.packets.find((p) => p.packetId === input.packetId);
    if (packet === undefined || packet.decisionId !== input.decisionId) {
      throw new PacketNotForDecisionError(input.packetId, input.decisionId, 'submit');
    }
    // The gate, such as it is here: there is no path to a submission that does
    // not start from an approval for this exact decision. In Postgres that is
    // `app.require_approval('submit')`, a trigger, and it holds whatever this
    // store believes (ADR 0020 §5).
    const approval = this.approvals.find((a) => a.approvalId === input.approvalId);
    if (approval === undefined || approval.decisionId !== input.decisionId) {
      throw new NoApprovalForSubmissionError(input.decisionId);
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
    // Trimmed once, and it is the trimmed value that is stored and put on the
    // event — the same as the Postgres store, because a confirmation number
    // that differs from the portal's by a trailing space is one nobody can
    // match back to the retailer's record.
    const confirmationNumber = input.confirmationNumber.trim();
    if (confirmationNumber === '') {
      throw new ConfirmationNumberRequiredError(input.decisionId);
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
      confirmationNumber,
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
    return { submissionId: record.submissionId, deductionId: record.deductionId };
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
      throw new CaseAmountMissingError(input.deductionId, 'record outcome');
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
 * rather than against a JS number (invariant 3). The rule is stated twice
 * because the two stores hold the amount differently — a `number` here, a
 * bigint column there — and a shared helper would have to take one of the two
 * and convert, which is the conversion invariant 3 exists to avoid. What keeps
 * them saying the same thing is the contract suite, which runs the same cases
 * against both.
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
