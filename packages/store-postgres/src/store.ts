/**
 * The PipelineStore — and, since ADR 0020, the CaseWorkflowStore, and the
 * JobStore a queued read is given (ADR 0021) — backed by Postgres.
 *
 * Every query runs as `app_rw` with the caller's tenant claim set, so the same
 * RLS policies that protect the database in production protect it here. The
 * service role never appears: this store is what a request path uses, and
 * invariant 6 says the service-role key does not belong in one.
 *
 * It writes through the real constraints — append-only triggers, the approval
 * gate, the tenant policies — which is the point. An in-memory store can only
 * ever prove the pipeline's own logic; this proves the schema supports it.
 *
 * The Phase 3 workflow (decide, assemble, approve, submit, record the outcome)
 * lives next door in `./workflow`, which this class wraps one method at a time
 * so that every one of them runs inside `withTenant` and nothing else has to
 * remember to.
 */

import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  cents,
  CASE_STATES,
  CLOSED_STATES,
  DUE_SOON_DAYS,
  identifierMatchKey,
  resolveDebtorId,
  resolveIdentity,
  tryParsePrintedDate,
} from '@recouple/core-domain';
import type {
  ArrivalIdentity,
  CanonicalReasonCode,
  CaseState,
  DebtorCandidate,
  IdentifierKind,
  KnownDeduction,
  KnownIdentifier,
} from '@recouple/core-domain';
import { restoreDocument, textByPage } from '@recouple/extraction';
import type { DocType, ExtractedField, ModelCallRecord } from '@recouple/extraction';
import type { ScanStatus, ScanVerdict } from '@recouple/ingest';
import {
  ActorIsNotTheSessionError,
  AlreadyDeclinedError,
  AmbiguousIdentityError,
  CaseMergedAwayError,
  CaseNotDeclinableError,
  ClassificationFloorError,
  ClassificationRefusedError,
  DOCUMENT_HELD,
  DECLINABLE_STATES,
  DOCUMENT_HOLD_RELEASED,
  DuplicateCaseError,
  holdAuditPayload,
  holdFromAuditPayload,
  parseClassificationFloor,
  servingRefusal,
} from '@recouple/pipeline';
import type {
  CaseMerges,
  CaseOutcome,
  CaseRecord,
  CaseWorkflow,
  CaseWorkflowStore,
  DeclinedLine,
  DiscoveredVia,
  DocumentHold,
  DocumentReadLease,
  DuplicateReviewStore,
  DuplicateVerdict,
  DuplicateVerdictRecord,
  HeldDocumentStore,
  HoldReason,
  HoldRecord,
  IngestSource,
  JobStore,
  MergeRecord,
  PipelineStore,
  PossibleDuplicatePair,
  RemittanceSettings,
  RestoredExtraction,
  ServingRefusal,
  StoredDocument,
  UnattachedDocument,
  UnmergeRecord,
  UnreadDocument,
  UnreadDocumentsStore,
  EvidenceAttachStore,
  UploadRecord,
  UploadSource,
  WorkflowSubmissionChannel,
} from '@recouple/pipeline';
import {
  assertUnattachedDocumentsQuery,
  assertUnreadDocumentsQuery,
  LineProvenanceUnknownError,
  UNREAD_DOCUMENTS_MAX_LIMIT,
  UPLOAD_SOURCES,
} from '@recouple/pipeline';
import * as workflow from './workflow';
import { exactCents } from './workflow';
import { COVERAGE_MONTHS_DEFAULT, readCoverageReport, type CoverageReport } from './coverage';
import { LEDGER_RUNS_DEFAULT, readLedgerSyncHealth, type LedgerSyncHealth } from './ledger-health';
import {
  DECLINED_SQL,
  NOT_QUEUED,
  QUEUED_SQL,
  readReviewQueue,
  REVIEW_QUEUE_LIMIT,
  URGENCY_BUCKET_SQL,
  URGENCY_ORDER_SQL,
  type ReviewQueueRead,
} from './review-queue';

/**
 * The same claim, for the same debtor, is already a case.
 *
 * Defined with the pipeline's steps, not here, so that the in-memory store and
 * this one refuse a duplicate with the same class — a caller cannot be right
 * about one store and wrong about the other.
 */
export { DuplicateCaseError };

/**
 * The arrival could be more than one of the tenant's deductions, so no case is
 * opened and a person is asked (ADR 0025 §6). Defined with the steps, for the
 * same reason `DuplicateCaseError` is.
 */
export { AmbiguousIdentityError };

/**
 * A decline refused because the case already carries one, or because it is
 * being fought. Defined with the pipeline's ports, for the reason
 * `DuplicateCaseError` is: the in-memory store refuses a decline with the same
 * classes, and the workflow contract holds the two to it.
 */
export { AlreadyDeclinedError, CaseNotDeclinableError, DECLINABLE_STATES };

/**
 * The one sentence a duplicate claim is reported with, wherever it was caught.
 *
 * Three things can now catch it — `resolveIdentity` before anything is
 * inserted, `unique (org_id, debtor_id, claim_id)` on the case, and
 * `unique (org_id, source, identifier_kind, identifier)` on the identifier —
 * and a reviewer is told the same thing by all three. Which check fired is our
 * business; which case already holds the claim is theirs. The wording is
 * unchanged from ADR 0019's, so nothing that reads it has to learn a second
 * one.
 */
function duplicateCaseMessage(claimId: string, existingDeductionId: string): string {
  return `claim ${claimId} is already open for this debtor as case ${existingDeductionId}`;
}

export interface TenantContext {
  readonly orgId: string;
  /**
   * Required, not optional. Since migration 0010 the write policies ask whether
   * this member holds a writer role, so a store with no identity can read and
   * nothing else — and an actor is what an authorization decision is made
   * about. A background job that genuinely has no user runs as its own
   * service member, not as nobody.
   */
  readonly userId: string;
}

export interface PostgresStoreConfig {
  readonly connectionString: string;
  /** The role to run as. Never the owner in production. */
  readonly role?: string;
  readonly max?: number;
}

/**
 * One pool per connection string, for the life of the process.
 *
 * A store is constructed per request — it carries the tenant, so it has to be —
 * and a pool per store meant a request opened connections and threw them away.
 * Postgres connections are expensive and Supabase allows few of them; a page
 * view that opens five is a page view that fails under any load at all.
 *
 * Sharing is safe precisely because the tenant is not on the connection: claims
 * are set with `set_config(..., true)` inside each transaction and the role with
 * `set local role`, both of which end with the transaction. A pooled connection
 * therefore cannot carry one tenant's claims into another tenant's query — which
 * is the property that makes pooling and RLS safe together, and the reason it was
 * written that way from the start.
 */
const pools = new Map<string, Pool>();

/**
 * Which of a connection string's two pools a caller wants.
 *
 * `work` is every query in this file: checked out, used, returned, all inside
 * one transaction. `locks` is the one thing that is not — a connection held for
 * the whole of a document's read, because that is what holding an advisory lock
 * across the read means (`withDocumentRead`).
 *
 * They are separate pools and that is the entire point. Sharing one would
 * deadlock: `max` is four, so four concurrent reads would hold all four
 * connections waiting to take a lock's transaction, and the work each of them
 * then does — fetch the document, record the classification, open the case —
 * would queue for a connection that is never coming back. Not slower: stopped,
 * with `pool.connect()` waiting for ever by default.
 */
type PoolPurpose = 'work' | 'locks' | 'inbound';

function poolFor(config: PostgresStoreConfig, purpose: PoolPurpose = 'work'): Pool {
  const key = `${config.connectionString}::${config.max ?? 4}::${purpose}`;
  const existing = pools.get(key);
  if (existing !== undefined) return existing;
  const pool = new Pool({
    connectionString: config.connectionString,
    // An inbound email's claim is held for the length of a scan. Two, and its
    // own: a burst of mail to one address must not hold the connections every
    // document read and token refresh waits on (ADR 0047 §10).
    max: purpose === 'inbound' ? 2 : (config.max ?? 4),
    // A delivery that cannot get a connection at once answers 503 and Postmark
    // comes back; waiting would spend Postmark's two minutes on a queue.
    ...(purpose === 'inbound' ? { connectionTimeoutMillis: 1_000 } : {}),
    // Lock connections are held for the length of a read, so exhausting that
    // pool is a real possibility rather than a momentary one — and a
    // `connect()` that waits for ever turns it into a worker that never
    // returns and a reviewer watching a spinner. It fails instead, loudly, and
    // a job that failed is a job the runtime retries.
    ...(purpose === 'locks' ? { connectionTimeoutMillis: 30_000 } : {}),
  });
  // A pool that throws on an idle client's error takes the process with it.
  pool.on('error', () => undefined);
  pools.set(key, pool);
  return pool;
}

/** The shared pool for a connection string, for callers that are not a store. */
export function sessionPool(config: PostgresStoreConfig): Pool {
  return poolFor(config);
}

/**
 * The shared *lock* pool for a connection string: for a caller that holds an
 * advisory lock in one transaction while its work runs in others
 * (`withLedgerAccountLock`). Never the working pool, for `PoolPurpose`'s
 * reason — a lock held on a working connection can starve the work it waits
 * for.
 */
export function sessionLockPool(config: PostgresStoreConfig): Pool {
  return poolFor(config, 'locks');
}

/**
 * The inbound email claim's own pool (ADR 0047 §10): two connections, and a
 * one-second wait before a delivery is answered 503 rather than queued.
 */
export function inboundClaimPool(config: PostgresStoreConfig): Pool {
  return poolFor(config, 'inbound');
}

/**
 * Ends every shared pool. For a process that is shutting down, and for tests —
 * a request path never calls this, because the pool outlives the request.
 */
export async function closeAllPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end().catch(() => undefined)));
}

/**
 * The columns a backfill may fill, each only ever from null.
 *
 * Mutable and internal: it is a builder the repair fills in as it reads, and
 * `FilledCase` is what a caller is handed once it has been written.
 */
interface CaseFill {
  retailerNameAsPrinted?: string;
  debtorId?: string;
  deductionDate?: string;
  disputeDeadline?: string;
}

/** One case a backfill repaired, and which columns it filled. */
export interface FilledCase {
  readonly deductionId: string;
  readonly retailerNameAsPrinted?: string;
  readonly debtorId?: string;
  readonly deductionDate?: string;
  readonly disputeDeadline?: string;
}

/** What a repair from `extraction_results` changed, and what it could not. */
export interface ExtractionBackfill {
  readonly filled: readonly FilledCase[];
  /** Matched, but the row would not take it — a duplicate claim, or too long. */
  readonly blocked: readonly { deductionId: string; name: string; reason: string }[];
  /** A printed date that is not a date. The column stays null, as it would on a new case. */
  readonly unread: readonly { deductionId: string; field: string; problem: string }[];
  /** Cases with nothing left to fill, so running it twice is a no-op. */
  readonly unchanged: number;
}

/** What a backfill changed, and what it deliberately did not. */
export interface DebtorBackfill {
  readonly resolved: readonly { deductionId: string; debtorId: string; name: string }[];
  /** Matched a debtor, but that claim is already a case against it. */
  readonly blocked: readonly { deductionId: string; name: string; reason: string }[];
  /** Still nobody's: no debtor answers to the name, or more than one does. */
  readonly stillUnmatched: number;
}

/** A case as the list route shows it. */
export interface CaseSummary {
  readonly deductionId: string;
  readonly state: CaseState;
  readonly claimId?: string;
  readonly deductionAmountCents: number;
  readonly deductionDate?: string;
  readonly disputeDeadline?: string;
  readonly debtorName?: string;
  readonly retailerKey?: string;
  /**
   * The retailer as the notice printed it. Present whenever extraction read a
   * name; `debtorName` is present only when exactly one debtor matched it, so a
   * view that has this and not that is looking at a name nobody has claimed yet
   * (ADR 0019).
   */
  readonly retailerNameAsPrinted?: string;
  /**
   * What kind of document named this deduction (ADR 0028). `'notice'` for every
   * case opened before that, which is what the column's default says too.
   */
  readonly discoveredVia: DiscoveredVia;
  /**
   * The invoice this deduction was taken against, as the document printed it.
   *
   * Read back from `deduction_identifiers` rather than from a column on the
   * case: a deduction's names live there (ADR 0025), and a second copy here
   * would be the one a view showed while the matcher read the other. The
   * earliest one wins where a case carries more than one, so the list does not
   * change when the planner does.
   */
  readonly invoiceNumber?: string;
  /** The reason code exactly as printed, never mapped (playbook data, Phase 2). */
  readonly reasonCodeAsPrinted?: string;
  readonly documentCount: number;
  readonly createdAt: string;
  /**
   * Present when a `declined_candidates` row names this case. A decline moves
   * no state (ADR 0043), so a declined case still reads `classified`, and this
   * is what tells a view it is decided rather than waiting. `DECLINED_SQL`, the
   * queue's own predicate.
   */
  readonly declined?: true;
}

/**
 * How many of a tenant's cases are in one state, and what they add up to: the
 * case list's figures before anything decides what a state means.
 */
export interface CaseStateTally {
  readonly state: CaseState;
  /**
   * Whether a decline names these cases. A decline moves no state (ADR 0043),
   * so a state's cases come as two rows, the declined and the rest, split by
   * the queue's own predicate (`DECLINED_SQL`) so the figures and the queue
   * cannot disagree about which cases are open.
   */
  readonly declined: boolean;
  readonly cases: number;
  /** Deducted across them, integer cents (invariant 3). */
  readonly deductedCents: number;
  /**
   * How many have a dispute deadline at most `DUE_SOON_DAYS` after the day the
   * tally was asked for: due soon, due that day, or past it — every deadline
   * the list's label does not call ok.
   */
  readonly dueSoonOrPast: number;
}

/** How many cases the ledger lists when nothing says otherwise: `listCases`' hundred. */
export const CASE_SEARCH_LIMIT = 100;
/** The most a ledger read will list at once. */
export const CASE_SEARCH_MAX = 500;
/** The longest text searched for. A claim, an invoice or a name is far shorter. */
export const CASE_SEARCH_QUERY_MAX = 200;

/**
 * What the case list's ledger is asked for (`searchCases`). Neither filter is
 * the newest cases, as `listCases` reads them.
 */
export interface CaseSearch {
  /**
   * Text a person typed, matched anywhere in a case's claim id, invoice
   * number, debtor, printed retailer name or id, ignoring case. It is text,
   * never a pattern: `%`, `_` and `\` match themselves.
   */
  readonly query?: string;
  readonly state?: CaseState;
  readonly limit?: number;
}

/** A page of the ledger, and how many cases it is a page of. */
export interface CaseSearchResult {
  /** The newest matching cases, at most `limit`. */
  readonly rows: readonly CaseSummary[];
  /** Every case that matches, however many `rows` holds. */
  readonly total: number;
  readonly limit: number;
}

/**
 * How many cases the attach control offers by default. Not the review queue's
 * 500: the page draws the whole list once for every document waiting to be
 * attached, up to fifty of them.
 */
export const ATTACH_TARGETS_LIMIT = 250;
export const ATTACH_TARGETS_MAX = 2_000;

/** The cases a document read and on no case can be attached to (`attachTargets`). */
export interface AttachTargets {
  /** The open cases offered, most urgent first, at most `limit` of them. */
  readonly rows: readonly CaseSummary[];
  /** Every open case, however many `rows` holds. */
  readonly total: number;
  readonly limit: number;
}

/**
 * Why a case was not fought. Mirrors the `decline_reason` enum in migration
 * 0014 — the database is the referee, so an unknown value is refused there
 * rather than stored and puzzled over later.
 */
export const DECLINE_REASONS = [
  'below_economic_floor',
  'deadline_passed',
  'evidence_unavailable',
  'deduction_valid',
  'duplicate_of_other',
  'below_confidence_floor',
  'tenant_declined',
  'other',
] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];

/**
 * How a deduction reached us. Mirrors the `discovered_from` check in migration
 * 0014; coverage is attributed by this, so it is a closed set.
 *
 * The same list as `uploads.source`, and deliberately the *same constant*
 * rather than a second copy of it: `discovered_from` is derived from the
 * channel a document arrived through, so the two lists drifting apart would be
 * a decline attributed to a word the uploads table cannot produce.
 */
export const DISCOVERED_FROM = UPLOAD_SOURCES;

export type DiscoveredFrom = UploadSource;

/**
 * Whether a word is a channel coverage can be grouped by.
 *
 * This is what `DISCOVERED_FROM` is for. `declineCase` reads the channel back
 * out of `uploads.source`, which is `text` with a check constraint, and the
 * driver hands it over as a plain string: without this the value would be
 * *asserted* into the union on the way to `declined_candidates.discovered_from`
 * — the one column every coverage number is grouped by — and a source added to
 * one check constraint but not the other would be discovered as a failed insert
 * with no idea which word caused it. Asked here, it is a refusal that names it.
 */
export function isDiscoveredFrom(value: unknown): value is DiscoveredFrom {
  return typeof value === 'string' && (DISCOVERED_FROM as readonly string[]).includes(value);
}

export function isDeclineReason(value: unknown): value is DeclineReason {
  return typeof value === 'string' && (DECLINE_REASONS as readonly string[]).includes(value);
}

/**
 * The channels an operator may assert for a document stored before provenance
 * was recorded.
 *
 * The three `IngestSource` names, and not the full six, because this is only
 * ever asked about a document that is *already in the database with no arrival
 * on it* — and the only doors that existed while such a document could be
 * stored are the web upload and the two email ones. `erp_sync`, `portal_fetch`
 * and `edi_812` are Phases 1.5, 2 and 2.5: when they land they write an
 * `uploads` row at ingest like every other path, so a document of theirs never
 * reaches this table. Offering them here would be offering an operator a
 * channel that could not have delivered the bytes they are looking at.
 */
export const ASSERTABLE_SOURCES: readonly IngestSource[] = ['web_upload', 'email_in', 'email_body'];

export function isAssertableSource(value: unknown): value is IngestSource {
  return typeof value === 'string' && (ASSERTABLE_SOURCES as readonly string[]).includes(value);
}

/**
 * Raised when a document already says how it arrived.
 *
 * `recordDocumentArrival` fills in what nothing knows; it never overwrites what
 * something does. Two different things reach here and the caller is told which,
 * because they mean different things to whoever ran the script: `origin:
 * 'ingest'` is a document the pipeline recorded an arrival for, which is the
 * normal case and means there was nothing to repair; `origin: 'asserted'` is a
 * document somebody already recorded an arrival for by hand, which means the
 * run is a repeat and the first answer stands.
 *
 * The database refuses both regardless — `app.arrival_only_when_unknown()` for
 * the first, `unique (document_id)` for the second (ADR 0024 §3). This class is
 * how the store says so before spending a round trip on being refused.
 */
export class ArrivalAlreadyRecordedError extends Error {
  constructor(
    readonly documentId: string,
    readonly origin: 'ingest' | 'asserted',
    readonly uploadId: string,
  ) {
    super(
      origin === 'ingest'
        ? `document ${documentId} already records arrival ${uploadId} from ingest`
        : `document ${documentId} already has an arrival asserted for it (${uploadId})`,
    );
    this.name = 'ArrivalAlreadyRecordedError';
  }
}

/** An arrival supplied after the fact, and what it was written against. */
export interface DocumentArrival {
  readonly arrivalId: string;
  readonly documentId: string;
  readonly uploadId: string;
  readonly source: IngestSource;
  readonly recordedBy: string;
  readonly detail?: string;
  /** The cases the document is attached to, each of which got an event. */
  readonly deductionIds: readonly string[];
}

/**
 * The evidence a decline can say was missing.
 *
 * Unlike `reason`, `declined_candidates.missing_evidence` is an unconstrained
 * `text[]` — the database will store whatever it is handed. The point of the
 * column is that it gets added up, and "no POD" has to be one thing across a
 * thousand declines rather than a hundred spellings, so the closed set lives
 * here: this is the lowest place that can refuse one.
 */
export const MISSING_EVIDENCE_TYPES = [
  'proof_of_delivery',
  'bill_of_lading',
  'invoice',
  'purchase_order',
  'receiving_report',
  'timesheet',
  'rate_agreement',
  'correspondence',
] as const;

export type MissingEvidence = (typeof MISSING_EVIDENCE_TYPES)[number];

export function isMissingEvidence(value: unknown): value is MissingEvidence {
  return typeof value === 'string' && (MISSING_EVIDENCE_TYPES as readonly string[]).includes(value);
}

/**
 * Raised when a decline cannot be attributed to the channel that found the case.
 *
 * `declined_candidates.discovered_from` is the column coverage is grouped by:
 * of the dollars each channel surfaced, how many did we fight for. A decline
 * stored under a channel nobody verified is not a missing number — it is a
 * wrong one, and it reads exactly like a right one. So the row is refused and
 * the case is left standing, which is the only outcome that cannot silently
 * move the number this log exists to produce (docs/STRATEGY.md, ADD-1).
 *
 * In practice this means one of two things, and they are told apart by
 * {@link noticeDocumentId} because they are not the same problem.
 *
 * The case has **no notice document at all** — a case assembled wrong, and
 * attaching its notice fixes it.
 *
 * Or the case **predates provenance recording**: its notice was stored before
 * `ingestDocument` wrote an `uploads` row, so `documents.upload_id` is null and
 * nothing in the database says which channel found it. That used to be a dead
 * end — `documents` is append-only, so `upload_id` cannot be filled in
 * afterwards, and `uploads` has no column pointing back at a document — and the
 * message said so. Migration 0019 is the migration it was waiting for: a
 * `document_arrivals` row, written once, by a named person, with the channel
 * typed out rather than defaulted, and refused outright for any document that
 * already says how it arrived (ADR 0024 §3). `pnpm link:provenance` is how one
 * is written, and this refusal names it — as an operator's job, not the
 * reviewer's, because asserting a channel that nothing observed is a decision
 * somebody signs.
 */
export class ProvenanceUnknownError extends Error {
  constructor(
    readonly deductionId: string,
    detail: string,
    /** The notice whose arrival is unrecorded, when the case has a notice. */
    readonly noticeDocumentId?: string,
  ) {
    super(`case ${deductionId} cannot be declined: ${detail}`);
    this.name = 'ProvenanceUnknownError';
  }
}

/**
 * What a human decision is stamped with, so a decline made by a person and one
 * made by a future policy are distinguishable when the tail gets evaluated.
 */
export const HUMAN_DECISION_VERSION = 'human/v1';

/**
 * How a declined row's channel was arrived at (ADR 0024 §4).
 *
 * `observed` — the pipeline recorded the arrival as it happened, so
 * `documents.upload_id` answered. `asserted` — a person supplied it afterwards
 * through `document_arrivals`, for a document stored before provenance was
 * recorded. Both produce the same `discovered_from`; only this says which way
 * it was reached, so a coverage number can be split by it instead of being
 * three joins away from the difference.
 */
export const PROVENANCE_KINDS = ['observed', 'asserted'] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** A recorded decline: what it was worth, and what would have changed it. */
export interface DeclinedCandidate {
  readonly declinedCandidateId: string;
  readonly deductionId: string;
  readonly reason: DeclineReason;
  readonly estimatedRecoverableCents: number;
  /**
   * The channel that found the deduction, checked against the closed set on the
   * way out of the database rather than asserted into it (`isDiscoveredFrom`).
   */
  readonly discoveredFrom: DiscoveredFrom;
  /**
   * Whether that channel was observed at ingest or asserted afterwards. Derived
   * from which of the two joins answered, never passed in — the same rule
   * `discoveredFrom` itself is under.
   */
  readonly provenanceKind: ProvenanceKind;
  readonly decidedBy: string;
  readonly decidedByVersion: string;
  readonly missingEvidence: readonly string[];
  readonly detail?: string;
  readonly decidedAt: string;
}

/**
 * The columns a typed document is rebuilt from: the value and its provenance.
 *
 * Not `StoredField` — that is what the review page lists, and carries the
 * document, the box and the quote check with it. This is only what
 * `restoreDocument` needs.
 */
interface StoredFieldRowForRebuild {
  readonly field_path: string;
  readonly value_json: unknown;
  readonly confidence: string;
  readonly source_page: number;
  readonly source_quote: string;
  readonly schema_version: string;
}

/** One stored field, with everything a reviewer needs to check it. */
export interface StoredField {
  readonly documentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly docType: DocType | null;
  readonly fieldPath: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly sourcePage: number;
  readonly sourceQuote: string;
  readonly sourceBbox: readonly [number, number, number, number] | null;
  /**
   * Three answers, not two: true means the quote was found in the page text,
   * false means it was looked for and was not there, and null means there was no
   * text to look in. A reviewer is told which kind of check a field got, because
   * "unchecked" and "checked and wrong" are not the same claim.
   */
  readonly quoteVerified: boolean | null;
}

/** The roles `deduction_documents.role` admits (migration 0007). */
export type DocumentRole = 'notice' | 'evidence' | 'remittance' | 'context';

/**
 * One document on a case, as the review page lists it: what it is called, what
 * it is and how it is on the case. No bytes — the page embeds those through
 * `/api/document/[id]`, under the same policies.
 */
export interface CaseDocument {
  readonly documentId: string;
  readonly filename: string;
  readonly mimeType: string;
  /**
   * What its latest classification said it is. Null for a document no model
   * classified: a ledger extract, whose kind is known by construction and which
   * nothing reads (ADR 0029).
   */
  readonly docType: DocType | null;
  /**
   * How it is on this case: `notice` for the document the case was opened from
   * — a notice, the remittance whose line opened it (ADR 0028), or a ledger
   * extract (ADR 0029) — and `evidence` for what was attached to it. A document
   * linked in more than one role reads as the stronger, `notice` first.
   */
  readonly role: DocumentRole;
  /** Whether any read of it is recorded: an `extraction_results` row, for any case or none. */
  readonly read: boolean;
  /**
   * Whether a read of it was recorded against this case, which is what puts its
   * model spend in {@link PostgresStore.costForCase}. False for a document read
   * before it was on this case — a remittance, whose one read serves every case
   * it opens (ADR 0028); a held notice a person opened (ADR 0044); evidence
   * attached from "Read, not on a case" — whose spend stays unattributed.
   */
  readonly readForCase: boolean;
  /**
   * Why its bytes may not be served — `servingRefusal` over its latest scan
   * verdict and its arrival — or null when they may. The case page shows a
   * notice in place of the embed and the link, because `/api/document` would
   * refuse them anyway.
   */
  readonly servingRefusal: ServingRefusal | null;
}

/**
 * The status of a document's latest scan verdict, as a scalar subquery over the
 * `documents` row aliased `alias` — the same row `latestScan` answers with, by
 * the same order. Null when nothing scanned it.
 */
const LATEST_SCAN_SQL = (alias: string): string =>
  `(select s.status from document_scans s
     where s.document_id = ${alias}.id order by s.id desc limit 1)`;

/**
 * `PostgresStore.servableDocument`'s answer for a document this tenant can see:
 * a refusal, or what a route needs to serve it.
 */
export type ServableDocument =
  | { readonly refusal: ServingRefusal; readonly document?: undefined }
  | {
      readonly refusal?: undefined;
      readonly document: {
        readonly documentId: string;
        readonly filename: string;
        readonly mimeType: string;
        readonly bytes: Uint8Array;
      };
    };

/**
 * The documents on one case, one row each, in SQL: a document linked in two
 * roles reads as the stronger, and `linked_at` is the order it was put there.
 *
 * Written out once and interpolated into both `caseDocuments` and
 * `fieldsForCase`, because the one way the review page can show a document's
 * fields without the document — or the document without its fields — is these
 * two reads disagreeing about which documents a case has.
 */
const CASE_DOCUMENTS_CTE = `on_case as (
  select dd.document_id,
         (array_agg(dd.role order by case dd.role
            when 'notice' then 0 when 'remittance' then 1
            when 'evidence' then 2 else 3 end))[1] as role,
         min(dd.id) as linked_at
    from deduction_documents dd
   where dd.deduction_id = $1
   group by dd.document_id
)`;

/**
 * `identifierMatchKey`, written in SQL.
 *
 * Trim, collapse internal whitespace, case-fold — exactly what `identity.ts`
 * does in TypeScript, and deliberately nothing more: no punctuation stripping,
 * because `APDP-99812` and `APDP99812` are different identifiers until a person
 * says otherwise (ADR 0025 §4). Written out once and interpolated into both
 * lookups rather than typed twice, since the one way this can be wrong is the
 * two copies drifting — and a fold that drifts from the matcher's hands back
 * candidates the matcher refuses, which reads as "no duplicate" and opens a
 * second case for a deduction we already have.
 *
 * It is a constant expression over a column, never user input: the values it
 * compares against are bound parameters.
 */
const FOLDED_IDENTIFIER = "lower(regexp_replace(btrim(i.identifier), '\\s+', ' ', 'g'))";

interface CaseSummaryRow {
  id: string;
  state: CaseState;
  claim_id: string | null;
  amount: string;
  // `pg` hands back `date` and `timestamptz` as Date objects, so these are
  // normalised on the way out rather than left for each caller to discover.
  deduction_date: Date | string | null;
  dispute_deadline: Date | string | null;
  created_at: Date | string;
  debtor_name: string | null;
  retailer_key: string | null;
  retailer_name_as_printed: string | null;
  discovered_via: DiscoveredVia;
  invoice_number: string | null;
  reason_code_as_printed: string | null;
  document_count: number;
  declined: boolean;
}

/**
 * A case as the list and the case page show it, in SQL, with no `where`, order
 * or limit of its own.
 *
 * Written out once and shared by `listCases`, `searchCases`, `caseSummary`
 * and `attachTargets`, for `CASE_DOCUMENTS_CTE`'s reason: the one way a case
 * can read one way in the list and another on its own page is these reads
 * disagreeing. There is no `org_id` in it on purpose — RLS decides whose cases
 * these are. The columns are apart from the `from` so a read can add one of
 * its own (`attachTargets` adds a count) and still map through `toCaseSummary`.
 */
const CASE_SUMMARY_COLUMNS = `d.id, d.state, d.claim_id, d.deduction_amount_cents::text as amount,
        d.deduction_date, d.dispute_deadline, d.created_at,
        d.retailer_name_as_printed, d.discovered_via, d.reason_code_as_printed,
        b.display_name as debtor_name, b.retailer_key,
        -- The invoice, from the table that holds a deduction's names
        -- (ADR 0025). Earliest first with id breaking the tie, for
        -- declineCase's reason: first_seen_at defaults to the
        -- transaction's start time, so two rows written in one
        -- transaction carry the identical timestamp and limit 1 over a
        -- tie is whichever row the plan reached first.
        (select i.identifier from deduction_identifiers i
          where i.deduction_id = d.id and i.identifier_kind = 'invoice_number'
          order by i.first_seen_at asc, i.id asc limit 1) as invoice_number,
        (select count(*) from deduction_documents dd where dd.deduction_id = d.id)
          ::int as document_count,
        ${DECLINED_SQL} as declined`;

const CASE_SUMMARY_SELECT = `select ${CASE_SUMMARY_COLUMNS}
   from deductions d
   left join debtors b on b.id = d.debtor_id`;

/**
 * Which cases a ledger search reaches, as a `where` over `CASE_SUMMARY_SELECT`'s
 * `d` and `b`. `$1` is a state or null, `$2` a `containing` pattern or null.
 *
 * Every invoice number a case carries is matched, not only the earliest one the
 * list shows, since any of them is a name a person may look the case up by. A
 * merged-away case matches on its own names and reads as `merged`, and its page
 * names the survivor (ADR 0042); nothing here writes, so there is nothing to
 * redirect to it.
 */
const CASE_SEARCH_WHERE = `where ($1::text is null or d.state = $1::text)
    and ($2::text is null
         or d.claim_id ilike $2 escape '\\'
         or d.id::text ilike $2 escape '\\'
         or b.display_name ilike $2 escape '\\'
         or d.retailer_name_as_printed ilike $2 escape '\\'
         or exists (select 1 from deduction_identifiers i
                     where i.deduction_id = d.id
                       and i.identifier_kind = 'invoice_number'
                       and i.identifier ilike $2 escape '\\'))`;

/**
 * `text` as an `ilike … escape '\'` pattern that matches it anywhere.
 *
 * The escape character is escaped first, so a `\` somebody typed cannot escape
 * the `%` or `_` after it, and those two are escaped so that "10%" finds "10%"
 * rather than everything that starts with "10".
 */
function containing(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function toCaseSummary(row: CaseSummaryRow): CaseSummary {
  const deductionDate = isoDate(row.deduction_date);
  const disputeDeadline = isoDate(row.dispute_deadline);
  return {
    deductionId: row.id,
    state: row.state,
    ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
    deductionAmountCents: Number(row.amount),
    ...(deductionDate !== undefined ? { deductionDate } : {}),
    ...(disputeDeadline !== undefined ? { disputeDeadline } : {}),
    ...(row.debtor_name !== null ? { debtorName: row.debtor_name } : {}),
    ...(row.retailer_key !== null ? { retailerKey: row.retailer_key } : {}),
    ...(row.retailer_name_as_printed !== null
      ? { retailerNameAsPrinted: row.retailer_name_as_printed }
      : {}),
    discoveredVia: row.discovered_via,
    ...(row.invoice_number !== null ? { invoiceNumber: row.invoice_number } : {}),
    ...(row.reason_code_as_printed !== null
      ? { reasonCodeAsPrinted: row.reason_code_as_printed }
      : {}),
    documentCount: row.document_count,
    createdAt: isoDate(row.created_at) ?? '',
    ...(row.declined ? { declined: true as const } : {}),
  };
}

interface StoredFieldRow {
  document_id: string;
  filename: string;
  mime_type: string;
  doc_type: DocType | null;
  field_path: string;
  value_json: unknown;
  confidence: string;
  source_page: number;
  source_quote: string;
  source_bbox: string[] | null;
  quote_verified: boolean | null;
}

interface CaseDocumentRow {
  document_id: string;
  filename: string;
  mime_type: string;
  doc_type: DocType | null;
  role: DocumentRole;
  read: boolean;
  read_for_case: boolean;
  scan: ScanStatus | null;
  source: UploadSource | null;
}

interface DocumentRow {
  id: string;
  org_id: string;
  sha256: Buffer;
  filename: string;
  mime_type: string;
  byte_size: string;
  storage_ref: string;
  /** Null on the rows stored before ingest recorded where a document came from. */
  upload_id: string | null;
}

/** A document that was stored and scanned clean and has no extraction. */
interface UnreadDocumentRow {
  id: string;
  filename: string;
  created_at: Date;
  age_minutes: number;
  on_case: boolean;
}

interface UnattachedDocumentRow {
  id: string;
  filename: string;
  created_at: Date;
  doc_type: DocType;
  /** `numeric(5,4)` as text, as the driver hands every numeric over. */
  confidence: string;
  /** The standing hold's columns, all null when there is none (ADR 0044). */
  hold_org_id: string | null;
  hold_payload: unknown;
  held_at: Date | null;
  held_by: string | null;
  /** The arrival email's claims, when the document came by email (ADR 0047 §7). */
  email_dkim: 'pass' | 'fail' | 'none' | 'unknown' | null;
  email_sender_domain: string | null;
}

/**
 * The hold standing on a document (ADR 0044), as a subquery over `audit_log`
 * keyed on the given document-id expression: the latest `document.held` row
 * that no `document.hold_released` row follows. One fragment, so `documentHold`
 * and `unattachedDocuments` cannot disagree about what "held" means.
 *
 * `subject_id` is text (0004) and has no index of its own; the scan is over the
 * tenant's audit rows, which RLS narrows it to. Indexing it is a migration.
 */
function standingHoldSql(documentIdText: string): string {
  return `select a.org_id, a.actor_id, a.payload, a.observed_at
            from audit_log a
           where a.subject_table = 'documents'
             and a.subject_id = ${documentIdText}
             and a.action = '${DOCUMENT_HELD}'
             and not exists (
               select 1 from audit_log r
                where r.subject_table = 'documents'
                  and r.subject_id = a.subject_id
                  and r.action = '${DOCUMENT_HOLD_RELEASED}'
                  and r.id > a.id)
           order by a.id desc
           limit 1`;
}

/**
 * A classification's confidence, read exactly: `numeric(5,4)` text such as
 * `0.7500`, checked to be a number in [0, 1] (the column's own check) rather
 * than trusted to be one.
 */
function classificationConfidence(text: string, documentId: string): number {
  const value = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `document ${documentId}'s classification confidence is not a number in [0, 1]`,
    );
  }
  return value;
}

/**
 * Documents carry their bytes in object storage, not in Postgres. The store
 * keeps them in memory for the length of a pipeline run so the reader models can
 * be handed a payload without a round trip to a bucket that does not exist yet;
 * Phase 1b replaces this with Supabase Storage.
 */
export interface BlobStore {
  /**
   * Keeps `bytes` under `ref`, or throws. A ref an implementation cannot key is
   * a refusal (`BlobRefUnrecognisedError`), never a quiet return: the caller
   * writes a `documents` row pointing at the ref next.
   */
  put(ref: string, bytes: Uint8Array): Promise<void>;
  get(ref: string): Promise<Uint8Array | undefined>;
}

/**
 * The bytes of a document, in the same database as everything else about it.
 *
 * It runs through the same tenant claims as the store that owns it, so a blob is
 * readable exactly when the document row is — one authorization story rather
 * than two kept in step by hand (ADR 0014).
 */
export class PostgresBlobStore implements BlobStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: TenantContext,
    private readonly role: string,
  ) {}

  private async withTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Keyed by document id, not by the storage ref: the ref is a name for where the
   * bytes are, and here that is "the row for this document".
   */
  async put(ref: string, bytes: Uint8Array): Promise<void> {
    const documentId = documentIdFromRef(ref);
    // A ref this store cannot key is bytes it would not keep. Returning quietly
    // left `putDocument` to write a `documents` row pointing at nothing, which
    // reads back as an empty file. The only caller passes `refForDocument`'s
    // answer, so this is a programming error — and a second `BlobStore` must
    // not inherit the silence either.
    if (documentId === undefined) throw new BlobRefUnrecognisedError(ref);
    await this.withTenant(async (client) => {
      await client.query(
        `insert into document_blobs (document_id, org_id, bytes, byte_size)
         values ($1, $2, $3, $4)
         on conflict (document_id) do nothing`,
        [documentId, this.tenant.orgId, Buffer.from(bytes), bytes.byteLength],
      );
    });
  }

  async get(ref: string): Promise<Uint8Array | undefined> {
    return this.withTenant((client) => this.getOn(client, ref));
  }

  /**
   * `get`, on a transaction the caller already holds — so the bytes are read
   * under that transaction's claims and in its snapshot. `servableDocument`
   * reads them this way, in the transaction that decided they may be served.
   */
  async getOn(client: PoolClient, ref: string): Promise<Uint8Array | undefined> {
    const documentId = documentIdFromRef(ref);
    if (documentId === undefined) return undefined;
    const { rows } = await client.query<{ bytes: Buffer }>(
      `select bytes from document_blobs where document_id = $1`,
      [documentId],
    );
    const found = rows[0]?.bytes;
    return found === undefined ? undefined : new Uint8Array(found);
  }
}

const REF_PREFIX = 'pgblob://';

/**
 * A storage ref `PostgresBlobStore.put` cannot key. It names the ref's scheme
 * only, never the whole ref, and nothing from the bytes.
 */
export class BlobRefUnrecognisedError extends Error {
  override readonly name = 'BlobRefUnrecognisedError';
  constructor(ref: string) {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(ref)?.[0] ?? 'no scheme';
    super(`storage ref (${scheme}) is not a ${REF_PREFIX}<document id> ref: the bytes were not stored`);
  }
}

/** `pgblob://<document id>` — the ref a document row carries. */
export function refForDocument(documentId: string): string {
  return `${REF_PREFIX}${documentId}`;
}

function documentIdFromRef(ref: string): string | undefined {
  if (!ref.startsWith(REF_PREFIX)) return undefined;
  const id = ref.slice(REF_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  /**
   * Keys any string, the empty one included: a `Map` has no ref it cannot
   * key, so `BlobStore.put`'s "refuse a ref it cannot key" holds here
   * trivially and there is nothing to throw.
   */
  async put(ref: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(ref, bytes);
  }
  async get(ref: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(ref);
  }
}

export class PostgresStore
  implements
    PipelineStore,
    CaseWorkflowStore,
    DuplicateReviewStore,
    JobStore,
    UnreadDocumentsStore,
    EvidenceAttachStore,
    HeldDocumentStore
{
  private readonly pool: Pool;
  /** Held for the length of a read, so deliberately not the working pool. */
  private readonly lockPool: Pool;
  private readonly role: string;

  private readonly blobs: BlobStore;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
    blobs?: BlobStore,
  ) {
    this.pool = poolFor(config);
    this.lockPool = poolFor(config, 'locks');
    this.role = config.role ?? 'app_rw';
    // Durable by default. An in-memory blob store is a thing a test may choose,
    // not the behaviour a caller gets by forgetting to choose.
    this.blobs = blobs ?? new PostgresBlobStore(this.pool, tenant, this.role);
  }

  /**
   * Releases this store's hold on the database.
   *
   * The pool is shared with every other store on the same connection string, so
   * ending it here would break them. There is nothing per-store to release:
   * every connection is returned to the pool at the end of its transaction.
   * `closeAllPools()` is what actually ends them, at shutdown.
   */
  async close(): Promise<void> {
    return;
  }

  /**
   * Runs a unit of work as the application role with the tenant's claims set.
   *
   * Both settings are transaction-local, so a pooled connection cannot carry one
   * tenant's claims into another tenant's query — the failure mode that makes
   * connection pooling and RLS dangerous together.
   *
   * `isolation` raises the transaction's level where one snapshot has to answer
   * several statements (`servableDocument`); the default is the database's.
   */
  private async withTenant<T>(
    work: (client: PoolClient) => Promise<T>,
    options: { readonly isolation?: 'repeatable read' } = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        options.isolation === undefined ? 'begin' : `begin isolation level ${options.isolation}`,
      );
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw caseMergedAway(error) ?? error;
    } finally {
      client.release();
    }
  }

  private async toStoredDocument(row: DocumentRow): Promise<StoredDocument> {
    const bytes = (await this.blobs.get(row.storage_ref)) ?? new Uint8Array();
    const pages = await this.pagesFor(row.id);
    return {
      documentId: row.id,
      orgId: row.org_id,
      sha256: row.sha256.toString('hex'),
      filename: row.filename,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      bytes,
      ...(pages !== undefined ? { pageText: pages } : {}),
      requiresSplit: false,
      ...(row.upload_id !== null ? { uploadId: row.upload_id } : {}),
    };
  }

  async findDocumentByHash(orgId: string, sha256: string): Promise<StoredDocument | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<DocumentRow>(
        `select id, org_id, sha256, mime_type, byte_size, storage_ref, upload_id,
                coalesce(filename, '') as filename
           from documents
          where org_id = $1 and sha256 = $2`,
        [orgId, Buffer.from(sha256, 'hex')],
      );
      const row = rows[0];
      return row === undefined ? undefined : this.toStoredDocument(row);
    });
  }

  /**
   * One `uploads` row: a tenant received something, through this channel, from
   * this member.
   *
   * Written as `app_rw` under the tenant's own claims like every other write
   * here, so `tenant_insert` — org claim plus `app.member_may_write()`
   * (migration 0010) — is what decides whether it lands. A store whose member
   * may not write cannot record an arrival, which is the same answer the
   * `documents` insert two lines later would give.
   */
  async recordUpload(input: {
    readonly orgId: string;
    readonly source: IngestSource;
    readonly createdBy?: string;
  }): Promise<UploadRecord> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into uploads (org_id, source, created_by)
         values ($1, $2, $3)
         returning id`,
        [input.orgId, input.source, input.createdBy ?? null],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('insert into uploads returned no row');
      return {
        uploadId: id,
        orgId: input.orgId,
        source: input.source,
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
      };
    });
  }

  /**
   * The channel a document arrived through, through `documents.upload_id`.
   *
   * An inner join, so a document stored before provenance was recorded answers
   * `undefined` rather than a plausible guess. The caller decides what to do
   * about not knowing; this only refuses to invent it.
   */
  async uploadSourceFor(documentId: string): Promise<UploadSource | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ source: UploadSource }>(
        `select u.source
           from documents d
           join uploads u on u.id = d.upload_id
          where d.id = $1`,
        [documentId],
      );
      return rows[0]?.source;
    });
  }

  /**
   * Records, after the fact, which channel a pre-provenance document came
   * through (ADR 0024 §3).
   *
   * `documents.upload_id` is set by `ingestDocument` and has been since
   * 2026-09-21. The rows stored before that have it null and nothing anywhere
   * says how they arrived, so `declineCase` refuses their cases rather than
   * attributing a decline to a guess — and migration 0019 freezes `uploads`,
   * which closes the last lever that could have papered over it. This is the
   * one way back, and it is built to be an assertion rather than an invention:
   *
   * - the `source` is an argument, typed by an operator at the point of use and
   *   never defaulted, because the fact that would justify a value ("this
   *   deployment has never had an inbound-email caller") is an assertion about
   *   the deployment and not a derivation from anything here;
   * - `recordedBy` is stored, so the assertion has a name on it for as long as
   *   the row exists;
   * - and it never overwrites. A document that already says how it arrived is
   *   refused here, and refused again by the database if this check is ever
   *   raced past.
   *
   * The `uploads` row's `received_at` is the document's own `created_at`
   * rather than `now()`: when the bytes were stored is a fact this database
   * holds and is the closest thing it has to when they arrived, whereas `now()`
   * would be a statement about when somebody ran a script, recorded in a column
   * that means something else.
   *
   * One transaction: the arrival, the mapping, and a `document.provenance_recorded`
   * event on every case the document is attached to — so a case's own timeline
   * says its provenance was supplied by a person on a date, rather than reading
   * as though it had been there all along.
   *
   * @throws {ArrivalAlreadyRecordedError} the document already records an
   *   arrival, from ingest or from an earlier assertion. Nothing is written.
   */
  async recordDocumentArrival(input: {
    readonly documentId: string;
    readonly source: IngestSource;
    readonly recordedBy: string;
    readonly detail?: string;
  }): Promise<DocumentArrival> {
    if (!isAssertableSource(input.source)) {
      // Before anything is written, and named. The column would take any of the
      // six `uploads.source` admits; only three of them could have delivered a
      // document that is already stored with no arrival on it.
      throw new Error(
        `${JSON.stringify(input.source)} is not a channel an arrival can be asserted from ` +
          `(${ASSERTABLE_SOURCES.join(', ')})`,
      );
    }
    return this.withTenant(async (client) => {
      // No `for update` on the document: `app_rw` holds no UPDATE on
      // `documents` (0004), so asking for a row lock there would be refused
      // outright. Two operators racing on the same document are separated by
      // `unique (document_id)` on `document_arrivals` instead — the second gets
      // a duplicate-key error rather than a second arrival — which is the same
      // rule that makes the assertion write-once in the first place.
      const { rows: docRows } = await client.query<{
        upload_id: string | null;
        created_at: Date | string;
      }>(
        `select d.upload_id, d.created_at from documents d where d.id = $1`,
        [input.documentId],
      );
      const document = docRows[0];
      if (document === undefined) {
        throw new Error(`document ${input.documentId} is not visible to this tenant`);
      }
      if (document.upload_id !== null) {
        throw new ArrivalAlreadyRecordedError(input.documentId, 'ingest', document.upload_id);
      }

      const { rows: existing } = await client.query<{ upload_id: string }>(
        `select upload_id from document_arrivals where document_id = $1`,
        [input.documentId],
      );
      const asserted = existing[0];
      if (asserted !== undefined) {
        throw new ArrivalAlreadyRecordedError(input.documentId, 'asserted', asserted.upload_id);
      }

      const { rows: uploadRows } = await client.query<{ id: string }>(
        `insert into uploads (org_id, source, created_by, received_at)
         values ($1, $2, $3, $4)
         returning id`,
        [this.tenant.orgId, input.source, input.recordedBy, document.created_at],
      );
      const uploadId = uploadRows[0]?.id;
      if (uploadId === undefined) throw new Error('insert into uploads returned no row');

      const { rows: arrivalRows } = await client.query<{ id: string }>(
        `insert into document_arrivals
           (org_id, document_id, upload_id, recorded_by, detail)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [
          this.tenant.orgId,
          input.documentId,
          uploadId,
          input.recordedBy,
          input.detail ?? null,
        ],
      );
      const arrivalId = arrivalRows[0]?.id;
      if (arrivalId === undefined) throw new Error('insert into document_arrivals returned no row');

      // Every case the document is on, not only the ones where it is the
      // notice: a decline reads the notice, but a reviewer looking at any case
      // this document is attached to should see that somebody supplied its
      // provenance rather than find the channel having changed silently.
      const { rows: caseRows } = await client.query<{ deduction_id: string }>(
        `select distinct deduction_id from deduction_documents
          where document_id = $1 order by deduction_id`,
        [input.documentId],
      );
      for (const row of caseRows) {
        await client.query(
          `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
           values ($1, $2, 'document.provenance_recorded', $3::jsonb, now())`,
          [
            this.tenant.orgId,
            row.deduction_id,
            JSON.stringify({
              document_id: input.documentId,
              upload_id: uploadId,
              arrival_id: arrivalId,
              source: input.source,
              recorded_by: input.recordedBy,
              // Said in the event itself, so a reader of the timeline does not
              // have to know that `document_arrivals` exists to know that this
              // channel was supplied rather than observed.
              asserted_after_the_fact: true,
              ...(input.detail !== undefined ? { detail: input.detail } : {}),
            }),
          ],
        );
      }

      return {
        arrivalId,
        documentId: input.documentId,
        uploadId,
        source: input.source,
        recordedBy: input.recordedBy,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        deductionIds: caseRows.map((row) => row.deduction_id),
      };
    });
  }

  /**
   * The documents of this tenant that record no arrival at all.
   *
   * What `pnpm link:provenance` lists before it asserts anything, and what it
   * walks with `--all-unrecorded`. Ordered oldest first, because these are by
   * definition the oldest documents here and an operator reading the list is
   * reading a history.
   *
   * Capped, for `unreadDocuments`' reason and validated by the same function:
   * an unbounded `select` is a query whose cost is set by the tenant's history
   * rather than by the caller, and this one is read by a script that prints
   * every row it is given before asserting anything. A tenant with ten thousand
   * pre-provenance documents is a migration-sized job, not a list; the default
   * is {@link UNREAD_DOCUMENTS_MAX_LIMIT} because the list an operator walks in
   * one sitting is the same size as the list a reviewer reads.
   *
   * @throws {UnreadDocumentsQueryError} the limit is not a whole number of rows
   *   between 1 and {@link UNREAD_DOCUMENTS_MAX_LIMIT}. Nothing is read.
   */
  async documentsWithoutArrival(limit = UNREAD_DOCUMENTS_MAX_LIMIT): Promise<
    readonly {
      readonly documentId: string;
      readonly filename: string;
      readonly createdAt: string;
      readonly deductionIds: readonly string[];
    }[]
  > {
    // The age half of that check is not a question this query asks, so it is
    // passed the value that always satisfies it. The limit half is the whole
    // point, and it refuses with the same class and the same words as
    // `unreadDocuments` so a caller cannot be right about one and wrong about
    // the other.
    assertUnreadDocumentsQuery(0, limit);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        filename: string;
        created_at: Date | string;
        deduction_ids: string[] | null;
      }>(
        `select d.id,
                coalesce(d.filename, '') as filename,
                d.created_at,
                (select array_agg(distinct dd.deduction_id::text)
                   from deduction_documents dd where dd.document_id = d.id) as deduction_ids
           from documents d
           left join document_arrivals da on da.document_id = d.id
          where d.upload_id is null and da.id is null
          order by d.created_at asc, d.id asc
          limit $1`,
        [limit],
      );
      return rows.map((row) => ({
        documentId: row.id,
        filename: row.filename,
        createdAt:
          typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
        deductionIds: row.deduction_ids ?? [],
      }));
    });
  }

  async putDocument(document: Omit<StoredDocument, 'documentId'>): Promise<StoredDocument> {
    // The id is generated here rather than by the insert, because the bytes are
    // written first and keyed by it: a `documents` row that points at bytes
    // nothing can produce is worse than bytes nothing references.
    const documentId = randomUUID();
    const storageRef = refForDocument(documentId);
    await this.blobs.put(storageRef, document.bytes);

    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into documents
           (id, org_id, sha256, byte_size, mime_type, storage_ref, filename, upload_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          documentId,
          document.orgId,
          Buffer.from(document.sha256, 'hex'),
          document.byteSize,
          document.mimeType,
          storageRef,
          document.filename,
          // Null only for a caller that stored bytes without recording an
          // arrival. `ingestDocument` always records one first; a test that
          // writes a document straight into the store is the other case, and a
          // case opened on such a document cannot be declined (see
          // `declineCase`), which is the loud version of not knowing.
          document.uploadId ?? null,
        ],
      );
      const id = rows[0]?.id as string;

      if (document.pageText !== undefined && document.pageText.length > 0) {
        await this.insertPages(client, document.orgId, id, document.pageText);
      }

      return { ...document, documentId: id };
    });
  }

  private async insertPages(
    client: PoolClient,
    orgId: string,
    documentId: string,
    pages: readonly string[],
  ): Promise<void> {
    for (const [index, text] of pages.entries()) {
      await client.query(
        `insert into document_pages (org_id, document_id, page_number, text_layer)
         values ($1, $2, $3, $4)
         on conflict (document_id, page_number) do nothing`,
        [orgId, documentId, index + 1, text],
      );
    }
  }

  async recordScan(documentId: string, verdict: ScanVerdict): Promise<void> {
    await this.withTenant(async (client) => {
      await client.query(
        `insert into document_scans (org_id, document_id, status, scanner, detail)
         values ($1, $2, $3, $4, $5)`,
        [this.tenant.orgId, documentId, verdict.status, verdict.scanner, verdict.detail ?? null],
      );
    });
  }

  async latestScan(documentId: string): Promise<ScanVerdict | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ status: ScanVerdict['status']; scanner: string; detail: string | null }>(
        `select status, scanner, detail from document_scans
          where document_id = $1 order by id desc limit 1`,
        [documentId],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        status: row.status,
        scanner: row.scanner,
        ...(row.detail !== null ? { detail: row.detail } : {}),
      };
    });
  }

  /**
   * What the classifier said, written down — or a named refusal when the
   * database will not have it.
   *
   * The translation is gated on the constraint's *name*, not on the SQLSTATE.
   * There are two check constraints on this table — the doc type's and the
   * column's `confidence between 0 and 1` — and they raise the same 23514.
   * Nothing validates a confidence at runtime before it gets here:
   * `ClassificationResult` is an interface, so it is a promise the compiler
   * checks and the classifier keeps, and the only clamp in the codebase is
   * inside `packages/extraction/src/claude.ts`. A second classifier answering
   * 1.4, or NaN, would be reported as doc-type drift and sent to somebody to
   * go and widen a constraint that is not the one that refused it. So the
   * confidence check rethrows untouched, and only
   * `document_classifications_doc_type_check` is named.
   *
   * A refused doc type is settled — a check constraint answers the same on
   * every attempt — and the caller that most needs to know that is the queue,
   * which would otherwise pay for the OCR, the classification and the
   * extraction three more times to be told the same thing (ADR 0027). A
   * confidence out of range is settled too, but it is a different bug with a
   * different fix, and `asJobFailure`'s bare-23514 branch is what stops it
   * being retried.
   *
   * Nothing is swallowed: the insert still fails, and it fails with more
   * information than the driver gave, not less. The driver's own message quotes
   * the offending row, so it is neither carried into the new message nor
   * chained as `cause` (invariant 4).
   */
  async recordClassification(
    documentId: string,
    docType: DocType,
    confidence: number,
  ): Promise<void> {
    await this.withTenant(async (client) => {
      try {
        await client.query(
          `insert into document_classifications (org_id, document_id, doc_type, confidence)
           values ($1, $2, $3, $4)`,
          [this.tenant.orgId, documentId, docType, confidence],
        );
      } catch (error) {
        if (
          sqlState(error) === '23514' &&
          constraintName(error) === 'document_classifications_doc_type_check'
        ) {
          throw new ClassificationRefusedError(documentId, docType);
        }
        throw error;
      }
    });
  }

  async recordExtraction(input: {
    documentId: string;
    deductionId?: string;
    docType: DocType;
    extractor: string;
    schemaVersion: string;
    fields: readonly ExtractedField[];
    document: unknown;
  }): Promise<void> {
    await this.withTenant(async (client) => {
      for (const field of input.fields) {
        await client.query(
          `insert into extraction_results
             (org_id, document_id, deduction_id, field_path, value_json, confidence,
              source_page, source_quote, source_bbox, quote_verified,
              extractor, model_version, schema_version)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::numeric(6,5)[], $10, $11, $12, $13)`,
          [
            this.tenant.orgId,
            input.documentId,
            input.deductionId ?? null,
            field.fieldPath,
            JSON.stringify(field.value ?? null),
            field.confidence,
            field.sourcePage,
            field.sourceQuote.slice(0, 2000),
            field.sourceBbox === null ? null : [...field.sourceBbox],
            field.quoteVerified,
            input.extractor,
            'recorded',
            input.schemaVersion,
          ],
        );
      }
    });
  }

  async latestExtraction(documentId: string): Promise<RestoredExtraction | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ doc_type: DocType }>(
        `select doc_type from document_classifications
          where document_id = $1 order by id desc limit 1`,
        [documentId],
      );
      const docType = rows[0]?.doc_type;
      if (docType === undefined) return undefined;

      // The typed object is rebuilt from the field rows: they are the record of
      // record, and reassembling from them proves nothing was lost on the way
      // in. Provenance comes back with it, because the document the reader
      // produced carries a page and a quote on every field and this has to be
      // that same document — `restoreDocument` validates it against the schema
      // rather than casting, and a field the document did not carry is filled
      // back in as an explicit absence rather than left out as a missing key.
      const { rows: fields } = await client.query<StoredFieldRowForRebuild>(
        `select field_path, value_json, confidence, source_page, source_quote, schema_version
           from extraction_results
          where document_id = $1 order by id asc`,
        [documentId],
      );
      if (fields.length === 0) return undefined;
      const rebuilt = restoreDocument(
        docType,
        fields.map((row) => ({
          fieldPath: row.field_path,
          value: row.value_json,
          // `numeric` arrives as a string from the driver, as everywhere else
          // this table is read.
          confidence: Number(row.confidence),
          sourcePage: row.source_page,
          sourceQuote: row.source_quote,
        })),
      );
      // The newest row's version: the rows are in id order, and a document read
      // twice carries both reads' rows.
      const schemaVersion = fields.at(-1)?.schema_version;
      return {
        docType,
        document: rebuilt.document,
        validated: rebuilt.validated,
        issues: rebuilt.issues,
        ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      };
    });
  }

  async recordModelCall(call: ModelCallRecord): Promise<void> {
    await this.withTenant(async (client) => {
      await client.query(
        `insert into model_calls
           (org_id, purpose, provider, model_version, document_id, deduction_id,
            input_tokens, output_tokens, cached_tokens, cost_micros, latency_ms, outcome, detail)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          this.tenant.orgId,
          call.purpose,
          call.provider,
          call.modelVersion,
          call.documentId ?? null,
          call.deductionId ?? null,
          call.inputTokens ?? null,
          call.outputTokens ?? null,
          call.cachedTokens ?? null,
          call.costMicros,
          call.latencyMs,
          call.outcome,
          call.detail ?? null,
        ],
      );
    });
  }

  async recordPages(
    documentId: string,
    pages: readonly { readonly page: number; readonly text: string }[],
  ): Promise<void> {
    await this.withTenant(async (client) => {
      for (const page of pages) {
        await client.query(
          `insert into document_pages (org_id, document_id, page_number, text_layer)
           values ($1, $2, $3, $4)
           on conflict (document_id, page_number) do nothing`,
          [this.tenant.orgId, documentId, page.page, page.text],
        );
      }
    });
  }

  async pagesFor(documentId: string): Promise<readonly string[] | undefined> {
    return this.withTenant(async (client) => {
      // By page number, not by row: OCR stores no row for a page it found no
      // text on, and read by position the page after it would take its number
      // (`textByPage`).
      const { rows } = await client.query<{ page_number: number; text_layer: string | null }>(
        `select page_number, text_layer from document_pages
          where document_id = $1 order by page_number asc`,
        [documentId],
      );
      if (rows.length === 0) return undefined;
      return textByPage(rows.map((row) => ({ page: row.page_number, text: row.text_layer ?? '' })));
    });
  }

  /**
   * Every spelling the tenant's debtors answer to.
   *
   * Read through RLS in the caller's transaction, so it can only ever see this
   * tenant's debtors (invariant 6). A tenant has tens of debtors, not millions,
   * so reading them and folding in TypeScript is cheap — and it keeps one
   * implementation of the fold rather than a second one written in SQL that
   * would drift from it (ADR 0019 §4).
   */
  private async debtorCandidates(client: PoolClient): Promise<DebtorCandidate[]> {
    const { rows } = await client.query<{ id: string; names: string[] }>(
      `select b.id,
              array_remove(
                array[b.display_name, b.retailer_key] ||
                coalesce(array_agg(a.alias) filter (where a.alias is not null), '{}'),
                null
              ) as names
         from debtors b
         left join debtor_aliases a on a.debtor_id = b.id
        group by b.id, b.display_name, b.retailer_key`,
    );
    return rows.map((row) => ({ debtorId: row.id, names: row.names }));
  }

  /**
   * Every identifier this tenant has recorded, and which deduction each names.
   *
   * Read through RLS in the caller's transaction, so it can only ever be this
   * tenant's (invariant 6), and matched in TypeScript rather than in SQL:
   * `resolveIdentity` normalises both sides, so an index on the raw column
   * would not serve the lookup anyway, and one implementation of the fold is
   * better than a second one written in SQL that would drift from it (ADR 0025,
   * the choice ADR 0019 §4 made for debtors). A tenant has thousands of these,
   * not millions; when that stops being true the answer is an expression index
   * measured against a query somebody has, not guessed at here.
   */
  private async knownIdentifiers(client: PoolClient): Promise<KnownIdentifier[]> {
    const { rows } = await client.query<{
      deduction_id: string;
      source: string;
      identifier_kind: IdentifierKind;
      identifier: string;
    }>(
      // A merged-away case's names are its survivor's (ADR 0042 §10), so an
      // arrival matching both halves of a merged pair is one exact match.
      `select coalesce(m.surviving_deduction_id, i.deduction_id) as deduction_id,
              i.source, i.identifier_kind, i.identifier
         from deduction_identifiers i
         left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
        where i.org_id = $1`,
      [this.tenant.orgId],
    );
    return rows.map((row) => ({
      deductionId: row.deduction_id,
      source: row.source,
      kind: row.identifier_kind,
      identifier: row.identifier,
    }));
  }

  /**
   * The deductions an arrival could still be, as far as matching cares.
   *
   * A case that is already won, lost, partial or written off is finished: an
   * arrival that looks like one is a new deduction to open, not a case to hold
   * for a merge nobody can act on. The identifiers above are *not* filtered
   * that way — an exact claim-id match on a closed case is the same duplicate
   * `unique (org_id, debtor_id, claim_id)` has always refused, and it is
   * refused the same way here.
   *
   * The invoice number comes off `deduction_identifiers`, because `deductions`
   * has no such column: until another source records one, this is empty and the
   * probable branch simply never fires — which is the correct behaviour, not a
   * gap. `openCase` deliberately does not write an `invoice_number` identifier
   * of its own: two deductions taken against one invoice is a real shape (ADR
   * 0025 §6 names it), and the table's per-source uniqueness would refuse the
   * second one's case outright.
   *
   * A merged-away case's invoice rows are read as its survivor's, the way
   * `knownIdentifiers` and `identityCandidates` read them. When the newer copy
   * of a pair survives, its own `invoice_number` row was the one skipped as a
   * collision when it arrived, so reading only the case's own rows left the
   * survivor with no invoice number and a third copy matching nothing
   * (docs/audits/duplicate-counting, F5). The case's own row is still preferred
   * when it has one, however old the merged-away half's: two halves need not
   * print the same invoice, and the survivor's own must not be displaced.
   */
  private async knownOpenDeductions(client: PoolClient): Promise<KnownDeduction[]> {
    const { rows } = await client.query<{
      id: string;
      deduction_amount_cents: string;
      deduction_date: string | null;
      debtor_id: string | null;
      invoice_number: string | null;
    }>(
      `select d.id,
              d.deduction_amount_cents,
              to_char(d.deduction_date, 'YYYY-MM-DD') as deduction_date,
              d.debtor_id,
              -- Over the case and every case merged into it (ADR 0042 §10):
              -- a survivor whose own invoice row was skipped as a collision
              -- with the copy it absorbed holds that copy's invoice number.
              -- Its own row comes first, whatever its age: a merged-away
              -- half may print a different invoice, and it must not take
              -- the survivor's place.
              (select i.identifier
                 from deduction_identifiers i
                 left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
                where i.org_id = d.org_id
                  and coalesce(m.surviving_deduction_id, i.deduction_id) = d.id
                  and i.identifier_kind = 'invoice_number'
                order by (i.deduction_id = d.id) desc, i.first_seen_at asc, i.id asc
                limit 1) as invoice_number
         from deductions d
        where d.org_id = $1
          and d.state <> all ($2::text[])`,
      // Closed: finished, or merged into another case (ADR 0042).
      [this.tenant.orgId, [...CLOSED_STATES]],
    );
    return rows.map((row) => ({
      deductionId: row.id,
      amountCents: cents(Number(row.deduction_amount_cents)),
      ...(row.invoice_number !== null ? { invoiceNumber: row.invoice_number } : {}),
      ...(row.deduction_date !== null ? { deductionDate: row.deduction_date } : {}),
      ...(row.debtor_id !== null ? { debtorId: row.debtor_id } : {}),
    }));
  }

  /**
   * Which deduction this arrival is, if the tenant already holds it.
   *
   * Asked *before* anything is inserted, and answered by `resolveIdentity` —
   * deterministic code with no I/O and no model, because this is the one
   * operation that can quietly destroy a disputable deduction (ADR 0025 §5).
   * `undefined` when the arrival names nothing that could match, which saves
   * two queries on a notice whose claim id was unreadable.
   */
  private async resolveArrival(
    client: PoolClient,
    arrival: ArrivalIdentity,
  ): Promise<ReturnType<typeof resolveIdentity> | undefined> {
    if (arrival.identifiers.length === 0 && arrival.invoiceNumber === undefined) return undefined;
    return resolveIdentity(
      arrival,
      await this.knownIdentifiers(client),
      await this.knownOpenDeductions(client),
    );
  }

  async openCase(input: {
    orgId: string;
    claimId?: string;
    invoiceNumber?: string;
    source?: UploadSource;
    retailerName?: string;
    deductionAmountCents?: number;
    deductionDate?: string;
    disputeDeadline?: string;
    discoveredVia?: DiscoveredVia;
    reasonCodeAsPrinted?: string;
  }): Promise<CaseRecord> {
    return this.withTenant(async (client) => {
      // The name goes on the case as printed, always. Whether it also names a
      // debtor is a separate question, and the answer is usually no: a debtor
      // is master data a human created, and untrusted document text may select
      // one but never mint one (invariant 4, ADR 0019).
      const debtorId =
        input.retailerName === undefined
          ? undefined
          : resolveDebtorId(input.retailerName, await this.debtorCandidates(client));

      // Is this a deduction we already have? Asked before anything is created,
      // because the two failures are not symmetric: a second case for one
      // deduction is visible and the money is still disputable, a wrong merge
      // is not (ADR 0025). An exact identifier match is the same refusal
      // `unique (org_id, debtor_id, claim_id)` gives — and that constraint
      // stays, as the last line of defence behind this.
      const amountCents =
        input.deductionAmountCents !== undefined &&
        Number.isSafeInteger(input.deductionAmountCents) &&
        input.deductionAmountCents > 0
          ? cents(input.deductionAmountCents)
          : undefined;
      const resolution = await this.resolveArrival(client, {
        identifiers:
          input.claimId !== undefined && input.claimId.trim() !== ''
            ? [{ kind: 'claim_id', identifier: input.claimId }]
            : [],
        ...(input.invoiceNumber !== undefined ? { invoiceNumber: input.invoiceNumber } : {}),
        ...(amountCents !== undefined ? { amountCents } : {}),
        ...(input.deductionDate !== undefined ? { deductionDate: input.deductionDate } : {}),
        ...(debtorId !== undefined ? { debtorId } : {}),
      });

      if (resolution?.kind === 'exact') {
        throw new DuplicateCaseError(
          duplicateCaseMessage(input.claimId ?? resolution.matchedOn.identifier, resolution.deductionId),
          resolution.deductionId,
          input.claimId ?? resolution.matchedOn.identifier,
        );
      }
      if (resolution?.kind === 'ambiguous') {
        throw new AmbiguousIdentityError(
          `this arrival matches ${resolution.deductionIds.length} cases on ` +
            `${resolution.basis.join(', ')} — ${resolution.deductionIds.join(', ')} — ` +
            'and which one it is, if it is either, is a question for a person',
          resolution.deductionIds,
          resolution.basis,
        );
      }

      // A failed statement aborts the whole transaction, and the lookup that
      // explains the failure is itself a statement. The savepoint is what lets
      // us ask the question rather than hand back a bare driver error.
      await client.query('savepoint before_open_case');
      let rows: { id: string; state: CaseState }[];
      try {
        ({ rows } = await client.query<{ id: string; state: CaseState }>(
          `insert into deductions (org_id, debtor_id, claim_id, retailer_name_as_printed,
                                   deduction_amount_cents, deduction_date, dispute_deadline,
                                   discovered_via, reason_code_as_printed, state)
           values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'notice'), $9, 'discovered')
           returning id, state`,
          [
            input.orgId,
            debtorId ?? null,
            input.claimId ?? null,
            input.retailerName ?? null,
            input.deductionAmountCents ?? 1,
            input.deductionDate ?? null,
            input.disputeDeadline ?? null,
            // `coalesce` rather than a default in TypeScript: the column's
            // default is what says a case nobody labelled was named by a notice,
            // and there should be one place that says so (migration 0022).
            input.discoveredVia ?? null,
            input.reasonCodeAsPrinted ?? null,
          ],
        ));
      } catch (error) {
        await client.query('rollback to savepoint before_open_case');
        throw await this.explainDuplicateCase(client, error, input.claimId, debtorId);
      }
      await client.query('release savepoint before_open_case');
      const row = rows[0];
      if (row === undefined) throw new Error('insert into deductions returned no row');

      // The claim id, said in the place every later source will say its own
      // name (ADR 0025). Same transaction as the `deductions` row on purpose:
      // a case whose identifier was written by a second statement that did not
      // run is a case the next arrival cannot match against, and the arrival is
      // the thing that would then be duplicated. Verbatim, never normalised —
      // comparison normalises, storage does not (§4).
      //
      // No source, no row: `deduction_identifiers.source` is not nullable and
      // the only documents that cannot name one are those stored before
      // provenance existed (ADR 0024). `openCaseFromNotice` records that on
      // `case.discovered` rather than filing the identifier under a guessed
      // channel.
      if (input.claimId !== undefined && input.claimId.trim() !== '' && input.source !== undefined) {
        await client.query('savepoint before_identifier');
        try {
          await client.query(
            `insert into deduction_identifiers
               (org_id, deduction_id, source, identifier_kind, identifier)
             values ($1, $2, $3, 'claim_id', $4)`,
            [input.orgId, row.id, input.source, input.claimId],
          );
        } catch (error) {
          // `unique (org_id, source, identifier_kind, identifier)` — which the
          // resolution above should already have caught, so getting here means
          // two arrivals raced. It is the same duplicate, and it is reported
          // the same way rather than as a driver error.
          await client.query('rollback to savepoint before_identifier');
          throw await this.explainDuplicateIdentifier(client, error, input.claimId, input.source);
        }
        await client.query('release savepoint before_identifier');
      }

      // Probable, never merged: losing a deduction is the worse error, so the
      // case opens and the pair is named for a reviewer (ADR 0025 §6). The
      // basis names which facts agreed and never their values — document text
      // does not go on an event (invariant 4).
      if (resolution?.kind === 'probable') {
        await client.query(
          `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
           values ($1, $2, 'case.possible_duplicate', $3::jsonb, now())`,
          [
            input.orgId,
            row.id,
            JSON.stringify({ of: resolution.deductionId, basis: resolution.basis }),
          ],
        );
      }

      return {
        deductionId: row.id,
        orgId: input.orgId,
        state: row.state,
        ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
        ...(input.retailerName !== undefined ? { retailerName: input.retailerName } : {}),
        ...(debtorId !== undefined ? { debtorId } : {}),
        ...(input.deductionAmountCents !== undefined
          ? { deductionAmountCents: input.deductionAmountCents }
          : {}),
        ...(input.deductionDate !== undefined ? { deductionDate: input.deductionDate } : {}),
        ...(input.disputeDeadline !== undefined
          ? { disputeDeadline: input.disputeDeadline }
          : {}),
        discoveredVia: input.discoveredVia ?? 'notice',
        ...(input.reasonCodeAsPrinted !== undefined
          ? { reasonCodeAsPrinted: input.reasonCodeAsPrinted }
          : {}),
      };
    });
  }

  /**
   * The tenant's remittance floor and dedup window (`org_settings`, 0021).
   *
   * Read through RLS in the caller's transaction like everything else here, and
   * read per document rather than cached: a tenant that lowers its floor should
   * see the next remittance filed against the new one. A tenant with no
   * `org_settings` row at all gets the column defaults rather than a throw —
   * every path that creates a tenant writes one, and a remittance that refused
   * to be read because a settings row was missing would be a read paid for and
   * thrown away.
   */
  async remittanceSettings(orgId: string): Promise<RemittanceSettings> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        cents: string;
        bps: number;
        days: number;
      }>(
        `select remittance_tolerance_cents::text as cents,
                remittance_tolerance_bps as bps,
                remittance_dedup_days as days
           from org_settings where org_id = $1`,
        [orgId],
      );
      const row = rows[0];
      if (row === undefined) return { toleranceCents: 500, toleranceBps: 50, dedupDays: 30 };
      return {
        toleranceCents: exactCents(row.cents, 'remittance_tolerance_cents'),
        toleranceBps: row.bps,
        dedupDays: row.days,
      };
    });
  }

  /**
   * This tenant's `min_classification_confidence` (ADR 0044): one select as
   * `app_rw` under the tenant's claims, the column read as text and parsed
   * exactly (`parseClassificationFloor`).
   *
   * Unlike `remittanceSettings`, a missing row is refused rather than defaulted.
   * This is a threshold invariant 7 guards, asked before a read spends anything,
   * and a default would be a floor nobody set deciding which documents open
   * cases. The `org_id` predicate is the tenant's own; RLS says the same thing,
   * and another tenant's row is not one this could find either way.
   */
  async classificationFloor(): Promise<number> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ floor: string }>(
        `select min_classification_confidence::text as floor
           from org_settings where org_id = $1`,
        [this.tenant.orgId],
      );
      const row = rows[0];
      if (row === undefined) throw new ClassificationFloorError(this.tenant.orgId, 'missing');
      return parseClassificationFloor(row.floor, this.tenant.orgId);
    });
  }

  /**
   * One `document.held` row in `audit_log`, naming this store's member as the
   * actor — migration 0030's insert policy refuses any other, and refuses a
   * member who may not write (ADR 0044). The payload is `holdAuditPayload`'s:
   * a doc type, two numbers, a reason and schema field paths.
   */
  async recordHold(hold: HoldRecord): Promise<void> {
    if (hold.orgId !== this.tenant.orgId) {
      throw new Error(
        `a hold for org ${hold.orgId} cannot be recorded by a store acting in org ${this.tenant.orgId}`,
      );
    }
    await this.withTenant(async (client) => {
      await client.query(
        `insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
         values ($1, $2, $3, 'documents', $4, $5::jsonb)`,
        [
          this.tenant.orgId,
          this.tenant.userId,
          DOCUMENT_HELD,
          hold.documentId,
          JSON.stringify(holdAuditPayload(hold)),
        ],
      );
    });
  }

  /** The hold standing on a document, read through RLS (`standingHoldSql`). */
  async documentHold(documentId: string): Promise<DocumentHold | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        org_id: string;
        actor_id: string | null;
        payload: unknown;
        observed_at: Date;
      }>(standingHoldSql('$1::text'), [documentId]);
      const row = rows[0];
      if (row === undefined) return undefined;
      return holdFromAuditPayload(row.payload, {
        documentId,
        orgId: row.org_id,
        heldAt: new Date(row.observed_at).toISOString(),
        ...(row.actor_id !== null ? { heldBy: row.actor_id } : {}),
      });
    });
  }

  /**
   * A person's release of a hold: one `document.hold_released` row naming them
   * and the cases the release opened or joined. Ids and a reason only.
   *
   * Refused before the insert when `releasedBy` is not this store's caller —
   * the policy would refuse it too, but as a bare row-level-security error, and
   * a caller deserves to know it named the wrong person rather than only that
   * the database said no.
   */
  async releaseHold(input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly releasedBy: string;
    readonly reason: HoldReason;
    readonly deductionIds: readonly string[];
  }): Promise<void> {
    if (input.releasedBy !== this.tenant.userId) {
      throw new ActorIsNotTheSessionError(input.releasedBy, this.tenant.userId, 'release a hold');
    }
    if (input.orgId !== this.tenant.orgId) {
      throw new Error(
        `a hold in org ${input.orgId} cannot be released by a store acting in org ${this.tenant.orgId}`,
      );
    }
    await this.withTenant(async (client) => {
      await client.query(
        `insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
         values ($1, $2, $3, 'documents', $4, $5::jsonb)`,
        [
          this.tenant.orgId,
          this.tenant.userId,
          DOCUMENT_HOLD_RELEASED,
          input.documentId,
          JSON.stringify({ reason: input.reason, deduction_ids: [...input.deductionIds] }),
        ],
      );
    });
  }

  /**
   * Every name a case is known by, in `deduction_identifiers` (migration 0020).
   *
   * ADR 0025 built that table and wired nothing but its own backfill into it.
   * This is the `openCase` wiring it left as follow-up, and it is what gives
   * `resolveIdentity` something to match against on the live path rather than
   * only the claim ids the backfill carried across.
   *
   * `source` is **derived** from the document's own arrival — observed from
   * `documents.upload_id`, else asserted from `document_arrivals` — by the same
   * read `declineCase` and `recordDeclinedLine` use. It is never a parameter,
   * for ADR 0024's reason.
   *
   * Two things are reported rather than thrown, and both for the same reason:
   * an identifier row is an index, not a counted number, so the conservative
   * failure is to write nothing and say so. A document with no arrival names no
   * source, and an identifier another case already holds for that source is two
   * cases for one deduction — which is identity resolution's job (STRATEGY
   * §5.2), not something an insert here may decide. Either way the case stands;
   * the matcher will simply answer `none` next time, which is a second case
   * somebody can see, rather than a wrong merge, which nobody can.
   */
  async recordIdentifiers(input: {
    readonly orgId: string;
    readonly deductionId: string;
    readonly documentId: string;
    readonly identifiers: readonly { readonly kind: IdentifierKind; readonly identifier: string }[];
  }): Promise<{ readonly written: number; readonly skippedBecause?: string }> {
    const wanted = input.identifiers.filter((i) => i.identifier.trim() !== '');
    if (wanted.length === 0) return { written: 0 };
    return this.withTenant(async (client) => {
      const source = await this.arrivalSourceFor(client, input.documentId);
      if (source === undefined) {
        return {
          written: 0,
          skippedBecause:
            `document ${input.documentId} records no arrival, so no source can be named`,
        };
      }

      // `on conflict … do nothing` rather than a savepoint per row: the unique
      // constraint is `(org_id, source, identifier_kind, identifier)`, and a
      // conflict is a name somebody already recorded. Which case holds it is
      // asked afterwards, once, so the answer can say whether it was this one.
      const { rowCount } = await client.query(
        `insert into deduction_identifiers
           (org_id, deduction_id, source, identifier_kind, identifier)
         select $1, $2, $3, k.kind, k.identifier
           from unnest($4::text[], $5::text[]) as k(kind, identifier)
         on conflict (org_id, source, identifier_kind, identifier) do nothing`,
        [
          input.orgId,
          input.deductionId,
          source,
          wanted.map((i) => i.kind),
          wanted.map((i) => i.identifier),
        ],
      );
      const written = rowCount ?? 0;
      if (written === wanted.length) return { written };

      const { rows: taken } = await client.query<{ identifier_kind: string }>(
        `select i.identifier_kind
           from deduction_identifiers i
           join unnest($3::text[], $4::text[]) as k(kind, identifier)
             on k.kind = i.identifier_kind and k.identifier = i.identifier
          where i.org_id = $1 and i.source = $2 and i.deduction_id <> $5`,
        [
          input.orgId,
          source,
          wanted.map((i) => i.kind),
          wanted.map((i) => i.identifier),
          input.deductionId,
        ],
      );
      if (taken.length === 0) return { written };
      const kinds = [...new Set(taken.map((row) => row.identifier_kind))].sort();
      return {
        written,
        skippedBecause:
          `another case already holds this tenant's ${kinds.join(', ')} for ${source}`,
      };
    });
  }

  /**
   * The channel a document arrived through, observed or asserted.
   *
   * The same `coalesce`-shaped read `declineCase` makes, and at most one of the
   * two can exist — the database refuses a `document_arrivals` row for a
   * document that already names an upload — so this reads whichever is there
   * rather than choosing between them (ADR 0024).
   */
  private async arrivalSourceFor(
    client: PoolClient,
    documentId: string,
  ): Promise<UploadSource | undefined> {
    const { rows } = await client.query<{
      observed_from: string | null;
      asserted_from: string | null;
    }>(
      `select u.source as observed_from, au.source as asserted_from
         from documents d
         left join uploads u on u.id = d.upload_id
         left join document_arrivals da on da.document_id = d.id
         left join uploads au on au.id = da.upload_id
        where d.id = $1`,
      [documentId],
    );
    const found = rows[0];
    const raw = found?.observed_from ?? found?.asserted_from ?? null;
    if (raw === null) return undefined;
    if (!isDiscoveredFrom(raw)) {
      // Unreachable while `uploads_source_check` and the lists in migrations
      // 0014 and 0020 stay one list — the point of there being one
      // `UPLOAD_SOURCES` behind all of them. Loud, and before anything written.
      throw new Error(
        `uploads.source returned ${JSON.stringify(raw)}, which is not a channel a ` +
          'deduction identifier can be attributed to',
      );
    }
    return raw;
  }

  /**
   * The candidates `resolveIdentity` needs, and nothing else.
   *
   * The matching stays in `core-domain`: deterministic, pure, no I/O, no model,
   * and one implementation whichever store is underneath. This only narrows the
   * search, and it folds exactly the way `identifierMatchKey` does — trim,
   * collapse internal whitespace, case-fold — because a store that folded
   * differently would hand back candidates the matcher then refused, and "no
   * duplicate" is how a second case for one deduction gets opened.
   *
   * RLS scopes both reads to this tenant; the `org_id` in the predicates is the
   * index's leading column rather than the isolation.
   */
  async identityCandidates(input: {
    readonly orgId: string;
    readonly identifiers: readonly { readonly kind: IdentifierKind; readonly identifier: string }[];
    readonly invoiceNumber?: string;
  }): Promise<{
    readonly knownIdentifiers: readonly KnownIdentifier[];
    readonly knownDeductions: readonly KnownDeduction[];
  }> {
    const wanted = input.identifiers.filter((i) => identifierMatchKey(i.identifier) !== '');
    return this.withTenant(async (client) => {
      const knownIdentifiers: KnownIdentifier[] = [];
      if (wanted.length > 0) {
        const { rows } = await client.query<{
          deduction_id: string;
          source: string;
          identifier_kind: IdentifierKind;
          identifier: string;
        }>(
          `select coalesce(m.surviving_deduction_id, i.deduction_id) as deduction_id,
                  i.source, i.identifier_kind, i.identifier
             from deduction_identifiers i
             join unnest($2::text[], $3::text[]) as k(kind, folded)
               on k.kind = i.identifier_kind
              and k.folded = ${FOLDED_IDENTIFIER}
             left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
            where i.org_id = $1`,
          [
            input.orgId,
            wanted.map((i) => i.kind),
            wanted.map((i) => identifierMatchKey(i.identifier)),
          ],
        );
        for (const row of rows) {
          knownIdentifiers.push({
            deductionId: row.deduction_id,
            source: row.source,
            kind: row.identifier_kind,
            identifier: row.identifier,
          });
        }
      }

      const knownDeductions: KnownDeduction[] = [];
      if (input.invoiceNumber !== undefined && identifierMatchKey(input.invoiceNumber) !== '') {
        // The probable branch's candidates: every case of this tenant's already
        // filed against this invoice, whatever kind of document opened it.
        // Distinct, because one case may carry the same invoice from two
        // sources and a duplicated candidate would read as two probables and
        // come back `ambiguous`.
        const { rows } = await client.query<{
          id: string;
          amount: string;
          deduction_date: Date | string | null;
          debtor_id: string | null;
          identifier: string;
        }>(
          `select distinct on (d.id)
                  d.id, d.deduction_amount_cents::text as amount,
                  d.deduction_date, d.debtor_id, i.identifier
             from deduction_identifiers i
             left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
             -- The survivor stands in for a merged-away case (ADR 0042 §10).
             join deductions d on d.id = coalesce(m.surviving_deduction_id, i.deduction_id)
            where i.org_id = $1
              and i.identifier_kind = 'invoice_number'
              and ${FOLDED_IDENTIFIER} = $2
            order by d.id`,
          [input.orgId, identifierMatchKey(input.invoiceNumber)],
        );
        for (const row of rows) {
          const deductionDate = isoDate(row.deduction_date);
          knownDeductions.push({
            deductionId: row.id,
            amountCents: cents(exactCents(row.amount, 'deduction_amount_cents')),
            invoiceNumber: row.identifier,
            ...(deductionDate !== undefined ? { deductionDate } : {}),
            ...(row.debtor_id !== null ? { debtorId: row.debtor_id } : {}),
          });
        }
      }

      return { knownIdentifiers, knownDeductions };
    });
  }

  /**
   * Runs `work` while this (org, invoice) is claimed, so the look-then-open in
   * `openCasesFromRemittance` is one decision rather than two steps with a race
   * between them.
   *
   * `withDocumentRead` above claims a *document*, which stops two deliveries of
   * one remittance reading it at once. It says nothing about a notice and a
   * remittance — two different documents — arriving seconds apart and both
   * finding no case for one invoice. Under READ COMMITTED both would see no
   * existing case and both would insert, and `unique (org_id, debtor_id,
   * claim_id)` does not catch it: the two documents build different claim ids,
   * and it does not fire at all while `debtor_id` is null.
   *
   * `pg_advisory_xact_lock` — the **waiting** form, which is the opposite of
   * what `withDocumentRead` uses and for the opposite reason. There is no model
   * call inside this: the lookup and the insert are two short queries, so a
   * waiter waits milliseconds, while a caller that gave up would drop a
   * deduction on the floor rather than harmlessly skip a read. It cannot
   * deadlock, because the claim is taken and released per line — a read holds at
   * most one at a time, so there is no second lock for a cycle to form around.
   *
   * Transaction-scoped for `withDocumentRead`'s reason: `DATABASE_URL` is
   * Supabase's transaction pooler, and a session lock could be taken on one
   * server connection and unlocked on another.
   *
   * The key is `hashtextextended(org || ':' || invoice, 1)`. Seed 1, not 0, so
   * an invoice key cannot collide with a document key from `withDocumentRead` —
   * two different things waiting on one number would be a stall nobody could
   * explain. On its own pool, again like the read claim, so a connection held
   * for the length of a line cannot starve the queries inside it.
   */
  async withInvoiceClaim<T>(
    orgId: string,
    invoiceNumber: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const client = await this.lockPool.connect();
    // Destroyed rather than pooled after any failure: its transaction may be
    // open or aborted, and the next borrower would fail on it (ADR 0039 review).
    let failed: Error | undefined;
    try {
      await client.query('begin');
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
      ]);
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 1))', [
        `${orgId}:${invoiceNumber}`,
      ]);
      const result = await work();
      // Nothing is written on this connection; the commit is what releases the
      // claim, and it happens once the work is finished either way.
      await client.query('commit');
      return result;
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
      // Released now rather than whenever the pooler notices the connection go.
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release(failed);
    }
  }

  /**
   * Records a short-paid line we are not fighting, with no case attached.
   *
   * `declined_candidates.deduction_id` is nullable for exactly this (migration
   * 0014): "ERP triage will decline thousands of short-pay lines that never
   * reach extraction, and those are the rows coverage is measured against".
   * These are those rows, arriving a phase earlier than expected.
   *
   * `discovered_from` and `provenance_kind` are derived from the document's own
   * arrival by the same observed-or-asserted read `declineCase` uses, and are
   * not parameters. At most one of the two can exist for a document — the
   * database refuses a `document_arrivals` row for one that already names an
   * upload — so this reads whichever is there rather than choosing between them
   * (ADR 0024).
   *
   * @throws {LineProvenanceUnknownError} the document records no arrival either
   *   way. Nothing is written: the transaction rolls back and the caller counts
   *   the line as unattributed rather than crediting a channel to a guess.
   */
  async recordDeclinedLine(input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly estimatedRecoverableCents: number;
    readonly externalIds: Readonly<Record<string, string>>;
    readonly decidedByVersion: string;
    readonly detail?: string;
  }): Promise<DeclinedLine> {
    if (
      !Number.isSafeInteger(input.estimatedRecoverableCents) ||
      input.estimatedRecoverableCents < 0
    ) {
      throw new RangeError(
        `${input.estimatedRecoverableCents} is not a number of cents a decline can be worth`,
      );
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        observed_from: string | null;
        asserted_from: string | null;
      }>(
        `select u.source as observed_from, au.source as asserted_from
           from documents d
           left join uploads u on u.id = d.upload_id
           left join document_arrivals da on da.document_id = d.id
           left join uploads au on au.id = da.upload_id
          where d.id = $1`,
        [input.documentId],
      );
      const found = rows[0];
      const observedFrom = found?.observed_from ?? null;
      const assertedFrom = found?.asserted_from ?? null;
      const rawDiscoveredFrom = observedFrom ?? assertedFrom;
      if (rawDiscoveredFrom === null) throw new LineProvenanceUnknownError(input.documentId);
      if (!isDiscoveredFrom(rawDiscoveredFrom)) {
        // Unreachable while `uploads_source_check` and 0014's `discovered_from`
        // check hold the same list — the point of there being one
        // `UPLOAD_SOURCES` behind both. If they drift, this names the value
        // instead of failing on a check constraint with no clue which did it.
        throw new Error(
          `uploads.source returned ${JSON.stringify(rawDiscoveredFrom)}, which is not a ` +
            'channel coverage can be attributed to',
        );
      }
      const provenanceKind: ProvenanceKind = observedFrom !== null ? 'observed' : 'asserted';

      const { rows: written } = await client.query<{ id: string }>(
        `insert into declined_candidates
           (org_id, deduction_id, discovered_from, provenance_kind, reason,
            estimated_recoverable_cents, external_ids, decided_by, decided_by_version,
            missing_evidence, detail)
         values ($1, null, $2, $3, 'below_economic_floor', $4, $5::jsonb,
                 'remittance_tolerance', $6, '{}', $7)
         returning id`,
        [
          input.orgId,
          rawDiscoveredFrom,
          provenanceKind,
          input.estimatedRecoverableCents,
          JSON.stringify(input.externalIds),
          input.decidedByVersion,
          input.detail ?? null,
        ],
      );
      const row = written[0];
      if (row === undefined) throw new Error('insert into declined_candidates returned no row');
      return {
        declinedCandidateId: row.id,
        discoveredFrom: rawDiscoveredFrom,
        provenanceKind,
      };
    });
  }

  /**
   * Turns `unique (org_id, debtor_id, claim_id)` into an error that says which
   * case already holds the claim.
   *
   * The constraint never fired while `debtor_id` was always null — Postgres does
   * not compare nulls — so the same claim arriving twice, once as a PDF and once
   * as a scan, silently opened two cases. Now that a debtor can resolve, the
   * second insert is rejected, and a reviewer needs to be told *which* case to
   * look at rather than handed a driver error. Merging the two into one case is
   * the identity-resolution layer of STRATEGY §5.2 and is not done here.
   */
  private async explainDuplicateCase(
    client: PoolClient,
    error: unknown,
    claimId: string | undefined,
    debtorId: string | undefined,
  ): Promise<unknown> {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== '23505' || claimId === undefined || debtorId === undefined) return error;
    const { rows } = await client.query<{ id: string }>(
      `select coalesce(m.surviving_deduction_id, d.id) as id
         from deductions d
         left join deduction_merges_current m on m.merged_deduction_id = d.id
        where d.debtor_id = $1 and d.claim_id = $2
        limit 1`,
      [debtorId, claimId],
    );
    const existing = rows[0]?.id;
    if (existing === undefined) return error;
    return new DuplicateCaseError(duplicateCaseMessage(claimId, existing), existing, claimId);
  }

  /**
   * The same, for the identifier table's own unique constraint.
   *
   * Reachable only by a race — `resolveIdentity` has already looked and found
   * nothing — and a race that lands here is still the same fact: this claim id,
   * from this source, is already a case. Reported with the same class and the
   * same sentence, so a reviewer cannot tell which of the three checks caught
   * it and does not need to.
   */
  private async explainDuplicateIdentifier(
    client: PoolClient,
    error: unknown,
    claimId: string,
    source: UploadSource,
  ): Promise<unknown> {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== '23505') return error;
    const { rows } = await client.query<{ deduction_id: string }>(
      `select coalesce(m.surviving_deduction_id, i.deduction_id) as deduction_id
         from deduction_identifiers i
         left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
        where i.org_id = $1 and i.source = $2 and i.identifier_kind = 'claim_id'
          and i.identifier = $3
        limit 1`,
      [this.tenant.orgId, source, claimId],
    );
    const existing = rows[0]?.deduction_id;
    if (existing === undefined) return error;
    return new DuplicateCaseError(duplicateCaseMessage(claimId, existing), existing, claimId);
  }

  async linkDocument(
    deductionId: string,
    documentId: string,
    role: 'notice' | 'evidence',
  ): Promise<void> {
    await this.withTenant(async (client) => {
      await client.query(
        `insert into deduction_documents (org_id, deduction_id, document_id, role)
         values ($1, $2, $3, $4)
         on conflict (deduction_id, document_id, role) do nothing`,
        [this.tenant.orgId, deductionId, documentId, role],
      );
    });
  }

  async transitionCase(deductionId: string, to: CaseState): Promise<CaseRecord> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        org_id: string;
        state: CaseState;
        claim_id: string | null;
        deduction_amount_cents: string;
      }>(
        `update deductions set state = $2, updated_at = now()
          where id = $1
          returning id, org_id, state, claim_id, deduction_amount_cents`,
        [deductionId, to],
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`no case ${deductionId}`);
      return {
        deductionId: row.id,
        orgId: row.org_id,
        state: row.state,
        ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
        deductionAmountCents: Number(row.deduction_amount_cents),
      };
    });
  }

  async appendEvent(input: {
    orgId: string;
    deductionId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.withTenant(async (client) => {
      await client.query(
        `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
         values ($1, $2, $3, $4::jsonb, now())`,
        [input.orgId, input.deductionId, input.eventType, JSON.stringify(input.payload)],
      );
    });
  }

  async getCase(deductionId: string): Promise<CaseRecord | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        org_id: string;
        state: CaseState;
        claim_id: string | null;
        deduction_amount_cents: string;
        discovered_via: DiscoveredVia;
      }>(
        `select id, org_id, state, claim_id, deduction_amount_cents, discovered_via
           from deductions where id = $1`,
        [deductionId],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        deductionId: row.id,
        orgId: row.org_id,
        state: row.state,
        ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
        deductionAmountCents: Number(row.deduction_amount_cents),
        // What reconcileCase asks to tell a remittance-opened case from any
        // other case with no notice on it (ADR 0040).
        discoveredVia: row.discovered_via,
      };
    });
  }

  async documentsForCase(deductionId: string): Promise<readonly StoredDocument[]> {
    const rows = await this.withTenant(async (client) => {
      const { rows } = await client.query<DocumentRow>(
        `select d.id, d.org_id, d.sha256, d.mime_type, d.byte_size, d.storage_ref,
                d.upload_id, coalesce(d.filename, '') as filename
           from deduction_documents dd
           join documents d on d.id = dd.document_id
          where dd.deduction_id = $1
          order by dd.id asc`,
        [deductionId],
      );
      return rows;
    });
    return Promise.all(rows.map((row) => this.toStoredDocument(row)));
  }

  /**
   * Whether this member may write in this tenant, asked of the database.
   *
   * `app.member_may_write()` is the predicate every `tenant_insert` policy is
   * gated on (migration 0010), so what this reports and what the policies
   * enforce cannot drift apart. A job needs it and a request does not, because
   * the two are authenticated differently: a request has a session the database
   * already resolved a membership for, while a job has an event, and a signed
   * event says Inngest delivered it and nothing more. `tenant_read` is the org
   * claim and nothing else, so without this the document would be fetched, OCR'd
   * and read by a model before the first insert was refused (ADR 0021).
   *
   * The actor must be the one this store already carries: the claims are what
   * the function reads, so answering for anybody else would be answering a
   * different question than the one asked. A mismatch is a programming error and
   * says so, rather than returning `false`, which would look like a refused
   * member.
   */
  async memberMayWrite(actor: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<boolean> {
    if (actor.orgId !== this.tenant.orgId || actor.userId !== this.tenant.userId) {
      throw new Error(
        'this store acts as a different member than the one being asked about: ' +
          `store ${this.tenant.userId}@${this.tenant.orgId}, ` +
          `asked ${actor.userId}@${actor.orgId}`,
      );
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ may: boolean | null }>(
        'select app.member_may_write() as may',
      );
      // `=== true` and not a truthiness check: no row, or a null, is a member
      // who may not write.
      return rows[0]?.may === true;
    });
  }

  /**
   * The case this document is already filed against, if any.
   *
   * The notice link first: a document that opened a case is on that case, and a
   * document can also be evidence on another. It is what tells a redelivered
   * read-event that the document it names has already been read and where that
   * read landed (ADR 0021).
   *
   * RLS scopes it like every other read here, so a document of another tenant's
   * answers nothing rather than answering wrongly.
   */
  async caseForDocument(documentId: string): Promise<string | undefined> {
    return this.withTenant(async (client) => {
      // A document on a case that was merged away is on the deduction its
      // survivor is (ADR 0042 §10): a re-read or a ledger re-sync lands there.
      const { rows } = await client.query<{ deduction_id: string }>(
        `select coalesce(m.surviving_deduction_id, dd.deduction_id) as deduction_id
           from deduction_documents dd
           left join deduction_merges_current m on m.merged_deduction_id = dd.deduction_id
          where dd.document_id = $1
          order by (dd.role = 'notice') desc, dd.observed_at asc, dd.id asc
          limit 1`,
        [documentId],
      );
      return rows[0]?.deduction_id;
    });
  }

  /**
   * One document by id, bytes included.
   *
   * There is no org predicate here on purpose: the policies decide, and a
   * document of another tenant comes back as nothing rather than as a row we
   * then have to remember to check.
   */
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    const row = await this.withTenant(async (client) => {
      const { rows } = await client.query<DocumentRow>(
        `select id, org_id, sha256, mime_type, byte_size, storage_ref, upload_id,
                coalesce(filename, '') as filename
           from documents where id = $1`,
        [documentId],
      );
      return rows[0];
    });
    return row === undefined ? undefined : this.toStoredDocument(row);
  }

  /**
   * Whether this tenant can see this document — `getDocument`'s answer without
   * its cost.
   *
   * `select 1`, no columns and no bytes. A handler deciding between "go on" and
   * "404" was fetching megabytes of a scanned notice out of object storage to
   * learn one bit, and then throwing all of it away. The policies still decide
   * and they still decide by the row not being there, so this says exactly what
   * `getDocument` says about visibility and nothing about anything else.
   */
  async documentIsVisible(documentId: string): Promise<boolean> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query('select 1 from documents where id = $1', [documentId]);
      return rows.length > 0;
    });
  }

  /**
   * Whether this document's bytes may be handed to a browser: `undefined` for a
   * document this tenant cannot see, else `servingRefusal`'s answer over its
   * latest scan verdict and its arrival (`{ refusal: undefined }` when they may
   * be served). `documentsServing` for one id; no bytes.
   */
  async documentServing(
    documentId: string,
  ): Promise<{ readonly refusal: ServingRefusal | undefined } | undefined> {
    return (await this.documentsServing([documentId])).get(documentId);
  }

  /**
   * `documentServing` for several documents in one query and one transaction,
   * no bytes: a map from each id this tenant can see to its answer. An id RLS
   * hides, or that names nothing, is absent from the map — the caller decides
   * what an absence means, as with `documentServing`'s `undefined`.
   *
   * The packet's zip asks this of every enclosure before its first byte, so a
   * packet of 25 documents is one round trip rather than 25 transactions. It
   * is a verdict, not a licence: the bytes themselves still go through
   * `servableDocument`, which asks again in the transaction that reads them.
   */
  async documentsServing(
    documentIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly refusal: ServingRefusal | undefined }>> {
    if (documentIds.length === 0) return new Map();
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        scan: ScanStatus | null;
        source: UploadSource | null;
      }>(
        `select d.id, ${LATEST_SCAN_SQL('d')} as scan, u.source
           from documents d
           left join uploads u on u.id = d.upload_id
          where d.id = any($1::uuid[])`,
        [documentIds],
      );
      const answers = new Map<string, { readonly refusal: ServingRefusal | undefined }>();
      for (const row of rows) {
        answers.set(row.id, { refusal: servingRefusal({ scan: row.scan, source: row.source }) });
      }
      // Postgres prints a uuid in lower case; answer under the id as asked.
      return new Map(
        documentIds.flatMap((id) => {
          const answer = answers.get(id.toLowerCase());
          return answer === undefined ? [] : [[id, answer] as const];
        }),
      );
    });
  }

  /**
   * A document's bytes, only if they may be served — the verdict and the fetch
   * in **one** tenant transaction, at `repeatable read`, so both are read from
   * one snapshot: there is no gap between the check and the fetch for a
   * verdict to be recorded in and missed.
   *
   * - `undefined`: this tenant cannot see the document (RLS), and nothing else
   *   was asked — the 404 comes before any verdict.
   * - `{ refusal }`: `servingRefusal` refused it, and `document_blobs` was
   *   never selected from: a refused document's bytes are not read only to be
   *   thrown away.
   * - `{ document }`: what a route needs to serve it, and nothing it does not
   *   (no pages, no text layer).
   *
   * The bytes are read on the same connection when the blob store is this
   * database's (`PostgresBlobStore.getOn`). A blob store kept anywhere else
   * cannot join the snapshot, so it is read while the transaction is still
   * open; its bytes are immutable once stored, so the verdict the snapshot
   * gave is still the verdict about those bytes.
   */
  async servableDocument(documentId: string): Promise<ServableDocument | undefined> {
    return this.withTenant(
      async (client) => {
        const { rows } = await client.query<{
          id: string;
          filename: string;
          mime_type: string;
          storage_ref: string;
          scan: ScanStatus | null;
          source: UploadSource | null;
        }>(
          `select d.id, coalesce(d.filename, '') as filename, d.mime_type, d.storage_ref,
                  ${LATEST_SCAN_SQL('d')} as scan, u.source
             from documents d
             left join uploads u on u.id = d.upload_id
            where d.id = $1`,
          [documentId],
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        const refusal = servingRefusal({ scan: row.scan, source: row.source });
        if (refusal !== undefined) return { refusal };
        const bytes =
          this.blobs instanceof PostgresBlobStore
            ? await this.blobs.getOn(client, row.storage_ref)
            : await this.blobs.get(row.storage_ref);
        return {
          document: {
            documentId: row.id,
            filename: row.filename,
            mimeType: row.mime_type,
            // As `getDocument` answers a row whose blob is missing.
            bytes: bytes ?? new Uint8Array(),
          },
        };
      },
      { isolation: 'repeatable read' },
    );
  }

  /**
   * Runs a document's read while holding that document's claim in the database,
   * or does not run it at all.
   *
   * **Why the database and not a flag.** The guard `readDocumentJob` asks — has
   * this document already been read — is a question about the past, and the
   * read is what changes the answer. Between the two sits OCR, two model calls
   * and an `openCase`, and two deliveries that overlap in that window both see
   * "not read yet". The reviewer who found this ran two `readDocumentJob` calls
   * at once and got four model calls, two `extraction_results` rows and two
   * cases for one document: `unique (org_id, debtor_id, claim_id)` does not
   * fire while `debtor_id` is null, which is every tenant's starting state (ADR
   * 0019). A flag in one process would not have helped — the two deliveries are
   * two invocations, on two machines.
   *
   * **Why a transaction-scoped lock and not a session one.** `DATABASE_URL` is
   * Supabase's *transaction* pooler (apps/web/DEPLOY.md): a server connection
   * is allocated for the length of a transaction and handed to somebody else
   * afterwards. A session-level `pg_advisory_lock` outlives the transaction it
   * was taken in, so under that pooler it would be taken on one server
   * connection and the matching `pg_advisory_unlock` could run on another — the
   * unlock quietly fails, and a connection in the pool goes on holding a lock
   * for a document nobody is reading, which makes that document permanently
   * unreadable. `pg_try_advisory_xact_lock` lives and dies with the transaction,
   * which is exactly the unit the pooler guarantees, and it cannot leak: commit,
   * rollback, a crashed process or a killed backend all release it. The cost is
   * an open transaction for the length of the read, which is why it is on its
   * own pool.
   *
   * **Why `try` and not the waiting form.** A caller that waited would hold a
   * worker for the length of somebody else's model calls, to be told at the end
   * of it that the document has been read. It is told that immediately instead,
   * and spends nothing.
   *
   * The key is `hashtextextended(id, 0)`: advisory locks are keyed by bigint,
   * and this is Postgres's own hash of the id rather than one this file
   * invented. A collision between two different documents' ids would mean one
   * of them waits for the other — a slower read, never a wrong one — and at
   * 64 bits it is not a thing to plan for.
   *
   * Claims and role are set exactly as `withTenant` sets them, transaction-
   * locally, so this connection cannot carry one tenant's claims anywhere
   * either. No row is written here: the lock is the whole transaction.
   */
  async withDocumentRead<T>(
    documentId: string,
    work: () => Promise<T>,
  ): Promise<DocumentReadLease<T>> {
    const client = await this.lockPool.connect();
    // Destroyed rather than pooled after any failure, as in `withInvoiceClaim`.
    let failed: Error | undefined;
    try {
      await client.query('begin');
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
      ]);
      const { rows } = await client.query<{ held: boolean | null }>(
        'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as held',
        [documentId],
      );
      // `=== true` rather than truthiness: anything else is not a lock.
      if (rows[0]?.held !== true) {
        await client.query('rollback');
        return { held: false };
      }

      const result = await work();
      // Nothing was written in this transaction; the commit is what releases
      // the lock, and it happens once the work is finished either way.
      await client.query('commit');
      return { held: true, result };
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
      // Released now rather than whenever the pooler notices the connection go.
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release(failed);
    }
  }

  /**
   * The documents this tenant got through the door and nobody ever read.
   *
   * Three conditions, and each one is a thing that has to be true for the
   * document to be stuck rather than merely new:
   *
   *  - **The latest scan verdict is `clean`.** The same latest-wins subquery
   *    `latestScan` uses, because a document whose last verdict is `infected`
   *    or `error` was refused by the gate on purpose and is not waiting for
   *    anything (invariant 4). A document with no verdict at all is not here
   *    either — nothing may read it, so nothing is owed.
   *  - **No `extraction_results` row.** The same record `readDocumentJob`'s own
   *    guard consults, so a document this list offers is exactly a document a
   *    re-drive would actually read, and one it does not offer is one a re-drive
   *    would answer from what was recorded.
   *  - **Older than the caller's threshold.** A document uploaded ten seconds
   *    ago is not stuck, it is being read, and a list that says otherwise would
   *    teach a reviewer to ignore it.
   *
   * Read-only, and RLS-scoped like everything else here: "this tenant's
   * documents" is the policies' answer rather than a `where org_id = …` this
   * query remembered to write. Bytes are deliberately not fetched — this is a
   * list, and a list that loads every stuck document's bytes to print its name
   * is a list nobody can afford to open.
   */
  async unreadDocuments(olderThanMinutes: number, limit = 50): Promise<readonly UnreadDocument[]> {
    assertUnreadDocumentsQuery(olderThanMinutes, limit);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<UnreadDocumentRow>(
        `select d.id,
                coalesce(d.filename, '') as filename,
                d.created_at,
                floor(extract(epoch from (now() - d.created_at)) / 60)::int as age_minutes,
                exists (select 1 from deduction_documents dd where dd.document_id = d.id)
                  as on_case
           from documents d
          where d.created_at <= now() - ($1::double precision * interval '1 minute')
            and (select s.status from document_scans s
                  where s.document_id = d.id order by s.id desc limit 1) = 'clean'
            and not exists (select 1 from extraction_results e where e.document_id = d.id)
            -- An email's body is read only when no attachment was the notice
            -- (ADR 0047 §8), so a cover note beside an attachment read as one
            -- is not a stalled read, and this list does not present it as one.
            -- Derived from the rows, not recorded.
            and not exists (
              select 1
                from inbound_message_parts bp
                join inbound_message_parts ap
                  on ap.org_id = bp.org_id
                 and ap.inbound_message_id = bp.inbound_message_id
                 and ap.kind = 'attachment'
                 and ap.document_id is not null
               where bp.org_id = d.org_id and bp.document_id = d.id and bp.kind = 'body'
                 and (select c.doc_type from document_classifications c
                       where c.document_id = ap.document_id
                       order by c.id desc limit 1) = 'deduction_notice')
          order by d.created_at asc
          limit $2`,
        [olderThanMinutes, limit],
      );
      return rows.map((row) => ({
        documentId: row.id,
        filename: row.filename,
        createdAt: new Date(row.created_at).toISOString(),
        // Never negative: a clock that has stepped backwards should read as
        // "just now", not as a document from the future.
        ageMinutes: Math.max(0, row.age_minutes),
        onCase: row.on_case,
      }));
    });
  }

  /**
   * The documents this tenant read and no case holds, newest first.
   *
   * Two conditions, each the mirror of one `unreadDocuments` applies: an
   * `extraction_results` row is the record of a read — the same record the read
   * job's guard consults — and no `deduction_documents` row in any role means no
   * case holds it. What it was read as is the latest classification, the same
   * row `latestExtraction` takes the type from, so this list and an attach
   * agree about what the document is.
   *
   * Through `withTenant` as `app_rw`, so "this tenant's documents" is the
   * policies' answer. No new table, no new column.
   */
  async unattachedDocuments(limit = 50): Promise<readonly UnattachedDocument[]> {
    assertUnattachedDocumentsQuery(limit);
    return this.withTenant(async (client) => {
      // The confidence comes off the same classification row as the type, and
      // the hold is `documentHold`'s own subquery (ADR 0044), so the list and a
      // press of its button agree about which documents are held.
      const { rows } = await client.query<UnattachedDocumentRow>(
        `select d.id,
                coalesce(d.filename, '') as filename,
                d.created_at,
                c.doc_type,
                c.confidence::text as confidence,
                h.org_id as hold_org_id,
                h.payload as hold_payload,
                h.observed_at as held_at,
                h.actor_id as held_by,
                em.dkim as email_dkim,
                em.sender_domain as email_sender_domain
           from documents d
           join lateral (
             select doc_type, confidence from document_classifications dc
              where dc.document_id = d.id order by dc.id desc limit 1
           ) c on true
           left join lateral (${standingHoldSql('d.id::text')}) h on true
           -- The email this document arrived in, when its own arrival was one:
           -- the message whose part stored it, else the first that named it
           -- (a retry after a death between the bytes and the record, ADR 0047
           -- §10). A later email carrying the same bytes is not its arrival.
           left join lateral (
             select m.dkim, m.sender_domain
               from uploads u
               join inbound_message_parts p
                 on p.org_id = d.org_id and p.document_id = d.id
               join inbound_messages m
                 on m.org_id = p.org_id and m.id = p.inbound_message_id
                and m.outcome = 'received'
              where u.id = d.upload_id and u.source in ('email_in', 'email_body')
              order by (p.outcome = 'stored') desc, m.received_at, m.id
              limit 1
           ) em on true
          where exists (select 1 from extraction_results e where e.document_id = d.id)
            and not exists (select 1 from deduction_documents dd where dd.document_id = d.id)
          order by d.created_at desc, d.id desc
          limit $1`,
        [limit],
      );
      return rows.map((row) => ({
        documentId: row.id,
        filename: row.filename,
        createdAt: new Date(row.created_at).toISOString(),
        docType: row.doc_type,
        confidence: classificationConfidence(row.confidence, row.id),
        ...(row.hold_org_id !== null
          ? {
              hold: holdFromAuditPayload(row.hold_payload, {
                documentId: row.id,
                orgId: row.hold_org_id,
                ...(row.held_at !== null ? { heldAt: new Date(row.held_at).toISOString() } : {}),
                ...(row.held_by !== null ? { heldBy: row.held_by } : {}),
              }),
            }
          : {}),
        ...(row.email_dkim !== null
          ? {
              email: {
                dkim: row.email_dkim,
                ...(row.email_sender_domain !== null
                  ? { senderDomain: row.email_sender_domain }
                  : {}),
              },
            }
          : {}),
      }));
    });
  }

  /**
   * Files a read document against a case as evidence, and records that it was:
   * one transaction, both or neither.
   *
   * The link is conditional on the case holding the document in **no** role,
   * not merely not as evidence — `deduction_documents`' unique key is
   * `(deduction_id, document_id, role)`, so a plain `on conflict do nothing`
   * would happily file a case's own notice against it a second time as
   * evidence. The `on conflict` is still there for the race: two presses that
   * both pass the `not exists` in two transactions meet at the unique key, one
   * inserts and the other inserts nothing, and only the one that inserted
   * writes the event.
   *
   * `evidence.attached` rather than `evidence.uploaded`: nothing was read for
   * this case, and the case's history should say which of the two happened.
   * The Attach button on the case list reaches this, and so does the same file
   * uploaded to a case that does not hold it yet (`answerFromRecord`): the
   * bytes were already read, and it is the recorded reading that is filed.
   */
  async attachEvidence(input: {
    readonly orgId: string;
    readonly deductionId: string;
    readonly documentId: string;
    readonly docType: DocType;
  }): Promise<boolean> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into deduction_documents (org_id, deduction_id, document_id, role)
         select $1, $2, $3, 'evidence'
          where not exists (
            select 1 from deduction_documents dd
             where dd.deduction_id = $2 and dd.document_id = $3)
         on conflict (deduction_id, document_id, role) do nothing
         returning id`,
        [input.orgId, input.deductionId, input.documentId],
      );
      if (rows.length === 0) return false;
      await client.query(
        `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
         values ($1, $2, 'evidence.attached', $3::jsonb, now())`,
        [
          input.orgId,
          input.deductionId,
          JSON.stringify({
            document_id: input.documentId,
            doc_type: input.docType,
            read_again: false,
          }),
        ],
      );
      return true;
    });
  }

  /**
   * This tenant's debtor with a given retailer key, through RLS.
   *
   * `pnpm link:retailer` read this on an owner connection outside the policies
   * until ADR 0034. It never creates one: a debtor is master data a person owns.
   */
  async debtorByRetailerKey(
    retailerKey: string,
  ): Promise<{ debtorId: string; displayName: string } | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string; display_name: string }>(
        `select id, display_name from debtors where retailer_key = $1`,
        [retailerKey],
      );
      const row = rows[0];
      return row === undefined ? undefined : { debtorId: row.id, displayName: row.display_name };
    });
  }

  /** Every retailer key this tenant has a debtor for, sorted, through RLS. */
  async retailerKeys(): Promise<readonly string[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ retailer_key: string }>(
        `select retailer_key from debtors order by retailer_key`,
      );
      return rows.map((row) => row.retailer_key);
    });
  }

  /**
   * How many of this tenant's cases carry a printed retailer name and no
   * debtor: what `resolveUnmatchedCases` would re-check. For a dry run.
   */
  async countUnmatchedCases(): Promise<number> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*) as n from deductions
          where debtor_id is null and retailer_name_as_printed is not null`,
      );
      return Number(rows[0]?.n ?? 0);
    });
  }

  /**
   * Records that a debtor answers to another spelling of its name.
   *
   * This is the human half of ADR 0019, and the only way "WALMART STORES, INC."
   * ever becomes Walmart. It is deliberately not something document text can
   * do: a person decides that two names are one retailer, and from then on the
   * lookup in `openCase` resolves that spelling by itself.
   *
   * Idempotent, so running it twice is not an error. The debtor is checked
   * through RLS first, so an alias cannot be hung off another tenant's row.
   */
  async addDebtorAlias(debtorId: string, alias: string): Promise<void> {
    const trimmed = alias.trim();
    if (trimmed === '') throw new Error('an alias cannot be blank');
    await this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from debtors where id = $1`,
        [debtorId],
      );
      if (rows[0] === undefined) {
        throw new Error(`no debtor ${debtorId} in this tenant`);
      }
      await client.query(
        `insert into debtor_aliases (org_id, debtor_id, alias)
         select $1, $2, $3
          where not exists (
            select 1 from debtor_aliases
             where debtor_id = $2 and lower(alias) = lower($3)
          )`,
        [this.tenant.orgId, debtorId, trimmed],
      );
    });
  }

  /**
   * Fills a case's retailer and dates from what extraction already read.
   *
   * A case opened before ADR 0019 has none of them on its row, but the values
   * were never lost: `extraction_results` holds them with their quotes and their
   * verification. This reads them back through exactly the code `openCase` uses
   * — `parsePrintedDate` and `resolveDebtorId` — so a repaired case says the
   * same thing a case uploaded today would, rather than something a second
   * implementation decided.
   *
   * It only ever fills a column that is null. Anything already on the row was
   * put there by the pipeline or by a person, and neither is this function's to
   * overwrite. A case with nothing to fill is counted and left alone, so running
   * it twice is a no-op.
   */
  async backfillFromExtraction(): Promise<ExtractionBackfill> {
    return this.withTenant(async (client) => {
      const candidates = await this.debtorCandidates(client);
      // The latest reading of each field, so a re-extraction wins over the
      // first one — the same ordering `latestExtraction` uses.
      const { rows } = await client.query<{
        id: string;
        claim_id: string | null;
        has_name: boolean;
        has_debtor: boolean;
        has_deduction_date: boolean;
        has_deadline: boolean;
        printed_name: string | null;
        printed_deduction_date: string | null;
        printed_deadline: string | null;
      }>(
        `select d.id, d.claim_id,
                d.retailer_name_as_printed is not null as has_name,
                d.debtor_id is not null                as has_debtor,
                d.deduction_date is not null           as has_deduction_date,
                d.dispute_deadline is not null         as has_deadline,
                (select e.value_json #>> '{}' from extraction_results e
                  where e.deduction_id = d.id and e.field_path = 'retailer_name'
                  order by e.id desc limit 1) as printed_name,
                (select e.value_json #>> '{}' from extraction_results e
                  where e.deduction_id = d.id and e.field_path = 'deduction_date'
                  order by e.id desc limit 1) as printed_deduction_date,
                (select e.value_json #>> '{}' from extraction_results e
                  where e.deduction_id = d.id and e.field_path = 'dispute_deadline'
                  order by e.id desc limit 1) as printed_deadline
           from deductions d
          where d.retailer_name_as_printed is null
             or d.debtor_id is null
             or d.deduction_date is null
             or d.dispute_deadline is null
          order by d.created_at asc`,
      );

      const filled: FilledCase[] = [];
      const blocked: { deductionId: string; name: string; reason: string }[] = [];
      const unread: { deductionId: string; field: string; problem: string }[] = [];
      let unchanged = 0;

      for (const row of rows) {
        const change: CaseFill = {};

        const name = row.printed_name?.trim();
        if (name !== undefined && name !== '') {
          if (!row.has_name) change.retailerNameAsPrinted = name;
          if (!row.has_debtor) {
            const debtorId = resolveDebtorId(name, candidates);
            if (debtorId !== undefined) change.debtorId = debtorId;
          }
        }

        for (const [field, printed, already] of [
          ['deduction_date', row.printed_deduction_date, row.has_deduction_date],
          ['dispute_deadline', row.printed_deadline, row.has_deadline],
        ] as const) {
          if (already) continue;
          const text = printed?.trim();
          if (text === undefined || text === '') continue;
          const parsed = tryParsePrintedDate(text);
          if ('problem' in parsed) {
            // Same rule as the pipeline: the column stays null, the case stays,
            // and the reason is reported rather than swallowed.
            unread.push({ deductionId: row.id, field, problem: parsed.problem });
            continue;
          }
          if (field === 'deduction_date') change.deductionDate = parsed.date;
          else change.disputeDeadline = parsed.date;
        }

        if (Object.keys(change).length === 0) {
          unchanged += 1;
          continue;
        }

        const outcome = await this.fillNullColumns(client, row.id, row.claim_id, change);
        if (outcome.blocked !== undefined) {
          blocked.push({ deductionId: row.id, name: name ?? '(none)', reason: outcome.blocked });
        }
        if (outcome.landed === undefined) {
          // Nothing reached the row: either every column was refused, or another
          // writer filled them between the select and the update. Neither is a
          // change, so neither gets an event.
          if (outcome.blocked === undefined) unchanged += 1;
          continue;
        }

        await client.query(
          `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
           values ($1, $2, 'case.backfilled_from_extraction', $3::jsonb, now())`,
          [this.tenant.orgId, row.id, JSON.stringify(outcome.landed)],
        );
        filled.push({ deductionId: row.id, ...outcome.landed });
      }

      return { filled, blocked, unread, unchanged };
    });
  }

  /**
   * Writes one case's repair, and reports the part of it the row refused.
   *
   * Two halves, deliberately. The printed name and the two dates are what a
   * reviewer triages on, and nothing can refuse them but the length check. The
   * debtor link is identity, and `unique (org_id, debtor_id, claim_id)` refuses
   * it when that claim is already a case against the debtor we resolved.
   *
   * Writing all four in one statement let one refused column veto the other
   * three: the savepoint rolled back, the row kept its null name, and
   * `resolveUnmatchedCases` — which only ever looks at rows that already carry a
   * printed name — could never reach it again. That made the row unrepairable
   * for good.
   *
   * So a refusal drops the column it was about and the rest is written: a
   * refused link leaves `debtor_id` null and lands the name and the dates, a
   * name past the column's cap leaves that null and lands the dates. Nothing is
   * truncated to fit, every refusal is reported — the duplicate by the id of the
   * case that holds the claim — and an error about anything else is raised, not
   * retried. Merging two cases of one claim is still identity resolution's job
   * (STRATEGY §5.2), not a backfill's.
   */
  private async fillNullColumns(
    client: PoolClient,
    deductionId: string,
    claimId: string | null,
    change: CaseFill,
  ): Promise<{ landed?: CaseFill; blocked?: string }> {
    const refusals: string[] = [];
    const attempt: CaseFill = { ...change };

    // Terminates: every pass either returns, raises, or removes one of the four
    // columns from the attempt.
    for (;;) {
      try {
        const landed = await this.writeCaseFill(client, deductionId, attempt);
        return {
          ...(landed !== undefined ? { landed } : {}),
          ...(refusals.length > 0 ? { blocked: refusals.join('; ') } : {}),
        };
      } catch (error) {
        const code = sqlState(error);
        // 23505: that claim is already a case against the debtor we resolved.
        if (code === '23505' && attempt.debtorId !== undefined) {
          refusals.push(
            await this.duplicateClaimReason(client, deductionId, claimId, attempt.debtorId),
          );
          delete attempt.debtorId;
        } else if (code === '23514' && attempt.retailerNameAsPrinted !== undefined) {
          // The name is longer than the column allows, and half a name is not
          // what the page said, so none of it is stored.
          refusals.push('the extracted retailer name is too long to store');
          delete attempt.retailerNameAsPrinted;
        } else {
          // Anything else, or a violation about a column we are not writing, is
          // not ours to interpret.
          throw error;
        }
      }
      if (Object.keys(attempt).length === 0) return { blocked: refusals.join('; ') };
    }
  }

  /**
   * The update itself: each column takes the new value only if it is still null.
   *
   * `coalesce(col, $n)`, not `coalesce($n, col)` — the column wins, so "fills
   * only null columns" is a property of the statement rather than of the
   * TypeScript flags that built its parameters. The `is null` guards mean a row
   * another writer filled between the select and here is not touched at all, so
   * it is neither stamped with `updated_at` nor reported as a change.
   *
   * Returns exactly what landed, read back from the row, or undefined when
   * nothing did. It runs inside a savepoint so a constraint violation is a
   * question the caller can ask about rather than an aborted transaction.
   */
  private async writeCaseFill(
    client: PoolClient,
    deductionId: string,
    change: CaseFill,
  ): Promise<CaseFill | undefined> {
    await client.query('savepoint before_backfill');
    let row: {
      retailer_name_as_printed: string | null;
      debtor_id: string | null;
      deduction_date: Date | string | null;
      dispute_deadline: Date | string | null;
    } | undefined;
    try {
      const result = await client.query<NonNullable<typeof row>>(
        `update deductions
            set retailer_name_as_printed = coalesce(retailer_name_as_printed, $2),
                debtor_id                = coalesce(debtor_id, $3::uuid),
                deduction_date           = coalesce(deduction_date, $4::date),
                dispute_deadline         = coalesce(dispute_deadline, $5::date),
                updated_at               = now()
          where id = $1
            and (($2::text is not null and retailer_name_as_printed is null)
              or ($3::uuid is not null and debtor_id is null)
              or ($4::date is not null and deduction_date is null)
              or ($5::date is not null and dispute_deadline is null))
      returning retailer_name_as_printed, debtor_id, deduction_date, dispute_deadline`,
        [
          deductionId,
          change.retailerNameAsPrinted ?? null,
          change.debtorId ?? null,
          change.deductionDate ?? null,
          change.disputeDeadline ?? null,
        ],
      );
      row = result.rows[0];
      await client.query('release savepoint before_backfill');
    } catch (error) {
      await client.query('rollback to savepoint before_backfill');
      throw error;
    }
    if (row === undefined) return undefined;

    // What we asked for is not what landed — another writer may have filled a
    // column first. The event records the row, not the intent.
    const landed: CaseFill = {};
    if (
      change.retailerNameAsPrinted !== undefined &&
      row.retailer_name_as_printed === change.retailerNameAsPrinted
    ) {
      landed.retailerNameAsPrinted = change.retailerNameAsPrinted;
    }
    if (change.debtorId !== undefined && row.debtor_id === change.debtorId) {
      landed.debtorId = change.debtorId;
    }
    if (change.deductionDate !== undefined && isoDate(row.deduction_date) === change.deductionDate) {
      landed.deductionDate = change.deductionDate;
    }
    if (
      change.disputeDeadline !== undefined &&
      isoDate(row.dispute_deadline) === change.disputeDeadline
    ) {
      landed.disputeDeadline = change.disputeDeadline;
    }
    return Object.keys(landed).length === 0 ? undefined : landed;
  }

  /** Which case already holds this claim for that debtor, named rather than guessed at. */
  private async duplicateClaimReason(
    client: PoolClient,
    deductionId: string,
    claimId: string | null,
    debtorId: string | undefined,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `select id from deductions
        where debtor_id = $1 and claim_id = $2 and id <> $3 limit 1`,
      [debtorId ?? null, claimId, deductionId],
    );
    return `claim ${claimId ?? '(none)'} is already open for that debtor as case ${
      rows[0]?.id ?? 'unknown'
    }`;
  }

  /**
   * Resolves cases whose retailer name now matches a debtor, and leaves the
   * rest alone.
   *
   * Adding an alias does not reach back through history on its own — ADR 0019
   * says so on purpose, because a silent rewrite of old cases is not something
   * anyone asked for. This is the deliberate step that does it, and it records
   * a `case.debtor_resolved` event for each one so the change is in the stream
   * rather than only in the projection.
   *
   * A case it cannot resolve is reported, never guessed at, and a case whose
   * claim is already open against that debtor comes back as `blocked` rather
   * than as a swallowed unique violation: that is two cases for one claim, and
   * merging them is identity resolution's job, not a backfill's.
   *
   * It only ever looks at rows that already carry a printed name, which is why
   * `backfillFromExtraction` must land that name even when the debtor link is
   * refused: a row with no name is a row this function can never reach.
   */
  async resolveUnmatchedCases(): Promise<DebtorBackfill> {
    return this.withTenant(async (client) => {
      const candidates = await this.debtorCandidates(client);
      const { rows } = await client.query<{
        id: string;
        claim_id: string | null;
        retailer_name_as_printed: string;
      }>(
        `select id, claim_id, retailer_name_as_printed
           from deductions
          where debtor_id is null and retailer_name_as_printed is not null
          order by created_at asc`,
      );

      const resolved: { deductionId: string; debtorId: string; name: string }[] = [];
      const blocked: { deductionId: string; name: string; reason: string }[] = [];
      let stillUnmatched = 0;

      for (const row of rows) {
        const debtorId = resolveDebtorId(row.retailer_name_as_printed, candidates);
        if (debtorId === undefined) {
          stillUnmatched += 1;
          continue;
        }
        await client.query('savepoint before_resolve');
        let linked: number;
        try {
          // `debtor_id is null` again here, not only in the select above: a
          // resolution that happened in between is somebody else's answer, and
          // this one must not overwrite it.
          const result = await client.query(
            `update deductions set debtor_id = $1, updated_at = now()
              where id = $2 and debtor_id is null`,
            [debtorId, row.id],
          );
          linked = result.rowCount ?? 0;
          await client.query('release savepoint before_resolve');
        } catch (error) {
          await client.query('rollback to savepoint before_resolve');
          if (sqlState(error) !== '23505') throw error;
          blocked.push({
            deductionId: row.id,
            name: row.retailer_name_as_printed,
            reason: await this.duplicateClaimReason(client, row.id, row.claim_id, debtorId),
          });
          continue;
        }
        // Nothing changed, so nothing is claimed and no event is appended.
        if (linked === 0) continue;
        await client.query(
          `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
           values ($1, $2, 'case.debtor_resolved', $3::jsonb, now())`,
          [
            this.tenant.orgId,
            row.id,
            JSON.stringify({
              debtor_id: debtorId,
              retailer_name_as_printed: row.retailer_name_as_printed,
              resolved_by: 'backfill',
            }),
          ],
        );
        resolved.push({
          deductionId: row.id,
          debtorId,
          name: row.retailer_name_as_printed,
        });
      }

      return { resolved, blocked, stillUnmatched };
    });
  }

  /** Total model spend on this tenant's book, in micro-USD. */
  /**
   * The case list a reviewer lands on: newest first, with the deadline that
   * decides what is urgent and the count of evidence already attached.
   *
   * Every row here comes back through RLS, so "the tenant's cases" is the
   * database's answer, not a `where org_id = …` we remembered to write.
   */
  async listCases(limit = 100): Promise<readonly CaseSummary[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<CaseSummaryRow>(
        `${CASE_SUMMARY_SELECT}
          order by d.created_at desc
          limit $1`,
        [limit],
      );
      return rows.map(toCaseSummary);
    });
  }

  /**
   * One case, as `listCases` would show it, whenever it was opened.
   *
   * The case page's read. It used to find its case in `listCases`, whose limit
   * made every case older than the newest hundred a 404 on its own page — the
   * old, urgent ones the review queue exists to surface among them (ADR 0043).
   * `undefined` means RLS showed this tenant no such case, which is also what
   * another tenant's case looks like, and the page 404s both alike.
   */
  async caseSummary(deductionId: string): Promise<CaseSummary | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<CaseSummaryRow>(
        `${CASE_SUMMARY_SELECT}
          where d.id = $1`,
        [deductionId],
      );
      const row = rows[0];
      return row === undefined ? undefined : toCaseSummary(row);
    });
  }

  /**
   * The case list's ledger: the newest cases matching a search, and how many
   * match in all.
   *
   * The ledger's table used to filter `listCases` in the browser, so a search
   * reached only the newest hundred cases — past that, an older case could not
   * be found by its claim at all, and the state filter offered only the states
   * among those hundred. The search is the database's now, over every case this
   * tenant has, matched as `CASE_SEARCH_WHERE` says; `total` says how many
   * matched, so the page can say what it is not listing. With neither filter
   * this is `listCases` with a total.
   *
   * One tenant transaction as `app_rw`, the same select and mapping as the list
   * and the case page, and no `org_id` anywhere: RLS decides whose cases these
   * are, for a `read_only` member as for anyone.
   */
  async searchCases(search: CaseSearch = {}): Promise<CaseSearchResult> {
    const limit = search.limit ?? CASE_SEARCH_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CASE_SEARCH_MAX) {
      throw new RangeError(`a case search lists 1 to ${CASE_SEARCH_MAX} cases`);
    }
    const state = search.state;
    if (state !== undefined && !(CASE_STATES as readonly string[]).includes(state)) {
      throw new RangeError('a case search filters by one of CASE_STATES');
    }
    const text = search.query?.trim() ?? '';
    if (text.length > CASE_SEARCH_QUERY_MAX) {
      throw new RangeError(`a case search is at most ${CASE_SEARCH_QUERY_MAX} characters`);
    }
    const parameters = [state ?? null, text === '' ? null : containing(text)];
    return this.withTenant(async (client) => {
      const { rows } = await client.query<CaseSummaryRow>(
        `${CASE_SUMMARY_SELECT}
          ${CASE_SEARCH_WHERE}
          order by d.created_at desc, d.id desc
          limit $3`,
        [...parameters, limit],
      );
      const { rows: counted } = await client.query<{ total: string }>(
        `select count(*)::text as total
           from deductions d
           left join debtors b on b.id = d.debtor_id
          ${CASE_SEARCH_WHERE}`,
        parameters,
      );
      return {
        rows: rows.map(toCaseSummary),
        total: exactCents(counted[0]?.total ?? '0', 'total'),
        limit,
      };
    });
  }

  /**
   * The case list's figures, per state, over every case this tenant has.
   *
   * Not over `listCases`, which is the newest hundred: past a hundred cases the
   * list's total, its open cases and its deadlines to watch undercounted and
   * said nothing. Here the SQL counts, sums and compares one date per state;
   * what a state means — open, filed, merged away — is decided by the page with
   * `isClosed`, the rule every other list uses — and a declined case comes as
   * its own row, since a decline moves no state and only the page can say that
   * a declined `classified` case is not open. `today` is read as its UTC day,
   * as the review queue and the deadline label read it, and the page passes
   * the one it reads the queue with. One tenant transaction as `app_rw`; RLS
   * decides whose cases these are.
   */
  async caseTally(options: { readonly today?: Date } = {}): Promise<readonly CaseStateTally[]> {
    const today = options.today ?? new Date();
    if (Number.isNaN(today.getTime())) {
      throw new RangeError('a case tally needs a real date for today');
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        state: CaseState;
        declined: boolean;
        cases: string;
        deducted: string;
        due: string;
      }>(
        `with t as (
           select d.state, d.deduction_amount_cents, d.dispute_deadline,
                  ${DECLINED_SQL} as declined
             from deductions d
         )
         select state, declined, count(*)::text as cases,
                sum(deduction_amount_cents)::text as deducted,
                count(*) filter (where dispute_deadline <= $1::date + $2::int)::text as due
           from t
          group by state, declined
          order by state, declined`,
        [today.toISOString().slice(0, 10), DUE_SOON_DAYS],
      );
      return rows.map((row) => ({
        state: row.state,
        declined: row.declined,
        cases: exactCents(row.cases, 'cases'),
        deductedCents: exactCents(row.deducted, 'deduction_amount_cents'),
        dueSoonOrPast: exactCents(row.due, 'due'),
      }));
    });
  }

  /**
   * The cases a document that was read and is on no case can be attached to,
   * from the case list: every case this tenant has that is not closed.
   *
   * The attach control's own read. It used to be handed `listCases()`, the
   * newest hundred, so past a hundred cases an older open case could never be
   * chosen however urgent it was — the cases the review queue exists to surface
   * (ADR 0043). Closed is `CLOSED_STATES`, the rule the picker always used:
   * finished, or merged into another case, which `attachReadDocument` refuses
   * (ADR 0042).
   *
   * The review queue's cases come first and in its order (`URGENCY_ORDER_SQL`),
   * then the filed and the declined ones in the same order, so a cut at `limit`
   * drops the least urgent rather than the oldest. `total` counts every open
   * case, so the page can say what it is not listing. `today` is read as its
   * UTC day, and the page passes the one it reads the queue with. One tenant
   * transaction as `app_rw`, with no `org_id` of its own: RLS decides.
   */
  async attachTargets(
    options: { readonly today?: Date; readonly limit?: number } = {},
  ): Promise<AttachTargets> {
    const today = options.today ?? new Date();
    const limit = options.limit ?? ATTACH_TARGETS_LIMIT;
    if (Number.isNaN(today.getTime())) {
      throw new RangeError('the cases to attach to need a real date for today');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > ATTACH_TARGETS_MAX) {
      throw new RangeError(
        `the cases to attach to are 1 to ${ATTACH_TARGETS_MAX}, not ${String(limit)}`,
      );
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<CaseSummaryRow & { total: string }>(
        `with open_cases as (
           select d.*,
                  ${QUEUED_SQL} as queued,
                  ${URGENCY_BUCKET_SQL} as bucket,
                  (d.created_at at time zone 'UTC')::date as created_on
             from deductions d
            where d.state <> all ($5::text[])
         )
         select ${CASE_SUMMARY_COLUMNS}, count(*) over ()::text as total
           from open_cases q
           join deductions d on d.id = q.id
           left join debtors b on b.id = d.debtor_id
          order by q.queued desc, ${URGENCY_ORDER_SQL}
          limit $4`,
        [
          [...NOT_QUEUED],
          today.toISOString().slice(0, 10),
          DUE_SOON_DAYS,
          limit,
          [...CLOSED_STATES],
        ],
      );
      return {
        rows: rows.map(toCaseSummary),
        total: rows.length === 0 ? 0 : exactCents(rows[0]?.total ?? '0', 'total'),
        limit,
      };
    });
  }

  /**
   * The documents on a case, the one it was opened from first and then in the
   * order they were put on it.
   *
   * The review page's list of documents, and not a by-product of its fields: a
   * ledger extract is a case's notice and has no fields at all, because no model
   * reads it (ADR 0029), and deriving the documents from the fields left a
   * ledger case with no original document and its packet naming the extract
   * "document 1". The same order `packetDocuments` encloses them in.
   */
  async caseDocuments(deductionId: string): Promise<readonly CaseDocument[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<CaseDocumentRow>(
        `with ${CASE_DOCUMENTS_CTE}
         select o.document_id, coalesce(d.filename, '') as filename, d.mime_type,
                c.doc_type, o.role,
                exists (select 1 from extraction_results x
                         where x.document_id = o.document_id) as read,
                exists (select 1 from extraction_results x
                         where x.document_id = o.document_id
                           and x.deduction_id = $1) as read_for_case,
                ${LATEST_SCAN_SQL('d')} as scan,
                u.source
           from on_case o
           join documents d on d.id = o.document_id
           left join uploads u on u.id = d.upload_id
           left join lateral (
             select doc_type from document_classifications dc
              where dc.document_id = o.document_id order by dc.id desc limit 1
           ) c on true
          order by (o.role <> 'notice'), o.linked_at`,
        [deductionId],
      );
      return rows.map((row) => ({
        documentId: row.document_id,
        filename: row.filename,
        mimeType: row.mime_type,
        docType: row.doc_type,
        role: row.role,
        read: row.read,
        readForCase: row.read_for_case,
        servingRefusal: servingRefusal({ scan: row.scan, source: row.source }) ?? null,
      }));
    });
  }

  /**
   * Every stored field of a case, with the provenance a reviewer follows: which
   * document, which page, the quote as printed, whether that quote was found in
   * the page text, and the box to draw over the scan.
   *
   * This is the read behind the review route. It deliberately returns the field
   * rows rather than the rebuilt objects — a reviewer checks values against the
   * page, and the page reference is the part a rebuilt object throws away.
   *
   * **By the case's documents, not by the rows' `deduction_id`.** A document is
   * on a case because `deduction_documents` says so, and a row's `deduction_id`
   * says something else: which case the read that wrote it was paid for. The
   * two differ whenever a document was read against no case and then put on
   * one — every remittance-opened case, whose remittance's one read serves all
   * the cases it opens (ADR 0028); a held notice a person opened (ADR 0044);
   * evidence attached from "Read, not on a case". Reading by `deduction_id`
   * showed those cases no document at all. `reconcileCase` already reads by
   * link (`documentsForCase`, then `latestExtraction`), so this is now the same
   * set of documents the findings are computed over, and the same set
   * `caseDocuments` lists.
   *
   * One row per document and field path, the latest: a document read twice
   * carries both reads' rows, and `latestExtraction` rebuilds from all of them
   * with the later row winning a path, so this lists the fields that rebuild
   * uses rather than each twice. The case's notice first, then the documents in
   * the order they were put on it, each in the order its fields were written.
   *
   * Nothing about spend moves: `costForCase` still sums only what was recorded
   * against this case (ADR 0028), and `caseDocuments` says which reads that is.
   */
  async fieldsForCase(deductionId: string): Promise<readonly StoredField[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<StoredFieldRow>(
        `with ${CASE_DOCUMENTS_CTE}, latest as (
           select distinct on (e.document_id, e.field_path)
                  e.id, e.document_id, e.field_path, e.value_json, e.confidence,
                  e.source_page, e.source_quote, e.source_bbox, e.quote_verified
             from extraction_results e
             join on_case o on o.document_id = e.document_id
            order by e.document_id, e.field_path, e.id desc
         )
         select l.document_id, coalesce(d.filename, '') as filename, d.mime_type,
                c.doc_type, l.field_path, l.value_json, l.confidence,
                l.source_page, l.source_quote, l.source_bbox, l.quote_verified
           from latest l
           join on_case o on o.document_id = l.document_id
           join documents d on d.id = l.document_id
           left join lateral (
             select doc_type from document_classifications dc
              where dc.document_id = l.document_id order by dc.id desc limit 1
           ) c on true
          order by (o.role <> 'notice'), o.linked_at, l.id asc`,
        [deductionId],
      );
      return rows.map((row) => ({
        documentId: row.document_id,
        filename: row.filename,
        mimeType: row.mime_type,
        docType: row.doc_type,
        fieldPath: row.field_path,
        value: row.value_json,
        confidence: Number(row.confidence),
        sourcePage: row.source_page,
        sourceQuote: row.source_quote,
        sourceBbox:
          row.source_bbox === null
            ? null
            : (row.source_bbox.map((n) => Number(n)) as [number, number, number, number]),
        quoteVerified: row.quote_verified,
      }));
    });
  }

  /** What this case has cost so far, which is what a contingency fee is set against. */
  async costForCase(deductionId: string): Promise<number> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ total: string | null }>(
        `select sum(cost_micros)::text as total from model_calls where deduction_id = $1`,
        [deductionId],
      );
      return Number(rows[0]?.total ?? 0);
    });
  }

  async totalCostMicros(): Promise<number> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ total: string | null }>(
        `select sum(cost_micros)::text as total from model_calls`,
      );
      return Number(rows[0]?.total ?? 0);
    });
  }

  /**
   * Records a case we are choosing not to fight.
   *
   * A discard is not a decision. Every declined case gets a row saying what it
   * was worth and what was missing, because coverage is a ratio of dollars and
   * it has no numerator without this (docs/STRATEGY.md, ADD-1). Deleting the
   * case instead would flatter every number we ever report.
   *
   * `discovered_from` is read off the case's own notice and is not a parameter
   * at all: it is how the deduction reached us, which is a fact about the
   * document rather than something a reviewer — or the route that happens to be
   * calling — should be able to state. Coverage is attributed by it, so a value
   * supplied by a caller is a channel credited on somebody's say-so.
   *
   * It used to take `assumedDiscoveredFrom`, because nothing wrote the
   * `uploads` table and the derivation could never succeed. Ingest writes it
   * now, on every path, so the assumption is gone rather than demoted to a
   * default: a case whose notice records no arrival raises
   * {@link ProvenanceUnknownError} instead of being counted under a guess.
   *
   * Since ADR 0024 the channel is read as `coalesce(observed, asserted)`: the
   * `uploads` row the notice names, or — for a notice stored before ingest
   * recorded arrivals — the one an operator supplied through
   * `document_arrivals`. At most one of the two can exist for a document, so
   * that is a read of whichever is there rather than a precedence rule.
   *
   * @throws {ProvenanceUnknownError} the case has no notice, or its notice has
   *   nothing — observed or asserted — to say which channel found it. The
   *   second of those is a case that predates provenance recording; it becomes
   *   declinable once somebody records how its notice arrived with
   *   `pnpm link:provenance`, and not before.
   */
  async declineCase(input: {
    deductionId: string;
    reason: DeclineReason;
    decidedBy: string;
    missingEvidence?: readonly MissingEvidence[];
    detail?: string;
  }): Promise<DeclinedCandidate> {
    return this.withTenant(async (client) => {
      // The amount comes from the case, not the caller — what it was worth is
      // not a reviewer's opinion. RLS scopes the read to this tenant.
      //
      // `for update of d` is what makes the check-then-insert below one
      // decision rather than two. READ COMMITTED lets two transactions both
      // read no declined row and both insert one, and there is no unique index
      // to catch the second (migration 0014 allows a second decline for a
      // different reason on purpose, so adding one is a migration and an ADR,
      // not a line here). Taking a row lock on the case instead serialises
      // every decline of the same case through this point: the second waits,
      // then sees the first's row and raises `AlreadyDeclinedError`. The lock
      // is held to commit, which is where the insert is.
      //
      // The notice is read with a LEFT JOIN onto `uploads` so that "this case
      // has no notice" and "its notice records no arrival" come back as
      // different answers. They are different faults — one is a case assembled
      // wrong, the other a document stored before provenance existed — and a
      // refusal that could not tell them apart would send somebody to the wrong
      // place.
      //
      // The earliest notice wins, and `doc.id` breaks the tie. `created_at`
      // defaults to `now()`, which is the transaction's start time, so two
      // notices attached inside one transaction — or on a clock with coarse
      // enough resolution — carry the identical timestamp, and `limit 1` over a
      // tie is whichever row the plan reached first. That is a coverage number
      // that changes when the planner does. The id is arbitrary but it is
      // *fixed*, so the same case is attributed to the same channel every time
      // it is asked, which is the property this column needs.
      //
      // Deliberately the earliest and not the earliest *with* an arrival: a
      // case whose first notice predates provenance is refused below even when
      // a later one records a channel. The first arrival is how the deduction
      // reached us; the second is a copy of something we already had. Counting
      // the copy's channel would credit whichever source re-sent a document,
      // which is the same misattribution `ingestDocument` refuses when it
      // declines to write a second `uploads` row for bytes it already has. A
      // refusal somebody has to act on is the honest answer, and the test
      // "refuses when the earliest notice predates provenance, even though a
      // later one records a channel" in `decline-case.test.ts` keeps it from
      // being quietly relaxed into "the earliest notice that knows".
      //
      // Observed or asserted, since ADR 0024: a document ingest recorded an
      // arrival for answers from `documents.upload_id`, and one stored before
      // provenance existed answers from the `document_arrivals` row an operator
      // supplied with `pnpm link:provenance`. The two come back as separate
      // columns rather than pre-coalesced because which of them answered is
      // itself recorded — `declined_candidates.provenance_kind` (ADR 0024 §4) —
      // and a `coalesce` in SQL throws that away. Reading observed first is not
      // a preference: the database refuses a `document_arrivals` row for a
      // document that already has an `upload_id`, so at most one of the two is
      // ever non-null and this is reading whichever exists rather than choosing
      // between them. `unique (document_id)` means the extra join multiplies
      // nothing, so which notice is picked is exactly what it was.
      const { rows: caseRows } = await client.query<{
        amount: string;
        state: CaseState;
        decision_id: string | null;
        notice_document_id: string | null;
        observed_from: string | null;
        asserted_from: string | null;
      }>(
        `select d.deduction_amount_cents::text as amount,
                d.state,
                (select x.id from decisions x where x.deduction_id = d.id
                  order by x.created_at asc, x.id asc limit 1) as decision_id,
                notice.document_id as notice_document_id,
                notice.observed_from as observed_from,
                notice.asserted_from as asserted_from
           from deductions d
           left join lateral (
             select doc.id as document_id,
                    u.source as observed_from,
                    au.source as asserted_from
               from deduction_documents dd
               join documents doc on doc.id = dd.document_id
               left join uploads u on u.id = doc.upload_id
               left join document_arrivals da on da.document_id = doc.id
               left join uploads au on au.id = da.upload_id
              where dd.deduction_id = d.id and dd.role = 'notice'
              order by doc.created_at asc, doc.id asc
              limit 1
           ) notice on true
          where d.id = $1
          for update of d`,
        [input.deductionId],
      );
      const found = caseRows[0];
      if (found === undefined) {
        // Two different refusals arrive here as the same empty result, and they
        // must not be reported as the same thing. `for update` makes Postgres
        // apply the UPDATE policy as well as the read one, and migration 0010
        // gates `tenant_update` on `app.member_may_write()` — so a `read_only`
        // member of the tenant that owns this case gets no row either, and
        // telling them their own case does not exist would be a lie that sends
        // them looking for the wrong problem.
        //
        // One extra read, on the failure path only, tells the two apart. The
        // database is still what refused in both cases; this only says which.
        const { rows: readable } = await client.query<{ one: number }>(
          `select 1 as one from deductions where id = $1`,
          [input.deductionId],
        );
        if (readable.length > 0) {
          throw new Error(
            `permission denied: this member may read case ${input.deductionId} but not decline it`,
          );
        }
        throw new Error(`case ${input.deductionId} is not visible to this tenant`);
      }
      // Fought or declined, never both. Asked under the case's row lock, and
      // it is the *state* check below that holds the race, not the decision
      // subquery. `recordHumanDecision` moves `deductions.state` out of
      // `classified` under the same row lock, so a decision that committed
      // while this decline waited is seen: `for update` re-reads the locked
      // row's current version, and its state is no longer declinable. The
      // scalar `decisions` subquery alone would not see it — it reads the
      // statement's snapshot, taken before the wait, so a decision inserted
      // meanwhile is invisible to it and `decision_id` comes back null.
      // (`recordHumanDecision` in turn refuses a declined case.) A merged-away
      // case is refused by the name the database would
      // give it (`RCM01`), since that is the reason and not its state as such.
      if (found.state === 'merged') {
        throw new CaseMergedAwayError(input.deductionId, 'declined_candidates');
      }
      if (found.decision_id !== null) {
        throw new CaseNotDeclinableError(input.deductionId, found.state, found.decision_id);
      }
      if (!(DECLINABLE_STATES as readonly CaseState[]).includes(found.state)) {
        throw new CaseNotDeclinableError(input.deductionId, found.state);
      }
      // Cents are a bigint (invariant 3). `Number()` on one is lossy above
      // 2^53, and it used to be called twice: once on the way into the
      // `case.declined` event, which is append-only and so cannot be corrected,
      // and once on the way out to the caller. The event now carries the
      // column's exact text and this is the only conversion left — checked
      // here, before anything is written, so a value we cannot represent stops
      // the decline rather than landing in a row we cannot correct.
      const estimatedRecoverableCents = exactCents(found.amount, 'deduction_amount_cents');

      // Derived, or refused. `declined_candidates.discovered_from` is NOT NULL
      // so that coverage can be attributed by channel, and a column that is
      // always filled is worth nothing if what fills it is a guess: every
      // decline would credit whichever source the calling code assumed, and the
      // per-channel numbers would look complete while meaning nothing.
      //
      // Nothing is written on this path. The transaction rolls back, the case
      // is untouched, and the person is told what is missing.
      // Which of the two answered, before either is used: the channel and the
      // kind are one derivation, so they cannot disagree.
      const observedFrom = found.observed_from;
      const assertedFrom = found.asserted_from;
      const rawDiscoveredFrom = observedFrom ?? assertedFrom;
      const provenanceKind: ProvenanceKind = observedFrom !== null ? 'observed' : 'asserted';

      if (rawDiscoveredFrom === null) {
        throw new ProvenanceUnknownError(
          input.deductionId,
          found.notice_document_id === null
            ? 'it has no notice document, so nothing on it says which channel found this deduction'
            : // Said plainly, and said as a dead end, because it is one. The
              // notice is there and its `uploads` row is not, which can only
              // mean it was stored before ingest recorded arrivals. Nothing a
              // reviewer can do on a case page changes that — `documents` is
              // append-only, so `upload_id` cannot be filled in afterwards —
              // but since ADR 0024 there is one thing an *operator* can do, and
              // naming it is the difference between a dead end and a job. It is
              // deliberately not phrased as something the reader can do
              // themselves: asserting a channel is a decision with a name on it.
              `its notice document ${found.notice_document_id} records no arrival. This case ` +
              'predates provenance recording; an operator can record how it arrived with ' +
              '`pnpm link:provenance` (ADR 0024) and it can be declined after that',
          found.notice_document_id ?? undefined,
        );
      }
      if (!isDiscoveredFrom(rawDiscoveredFrom)) {
        // Unreachable while `uploads_source_check` and the `discovered_from`
        // check in migration 0014 hold the same list — which is the point of
        // there being one `UPLOAD_SOURCES` behind both. If they ever drift, the
        // insert below fails on a check constraint with no clue which value did
        // it; this fails first and names it. Loud, and before anything written.
        throw new Error(
          `uploads.source returned ${JSON.stringify(rawDiscoveredFrom)}, which is not a ` +
            'channel coverage can be attributed to',
        );
      }
      const discoveredFrom = rawDiscoveredFrom;

      // The column takes any text, so the check is here or nowhere. A value
      // nobody counts is worse than an empty list: it looks like a reason.
      for (const evidence of input.missingEvidence ?? []) {
        if (!isMissingEvidence(evidence)) {
          throw new Error(`${evidence} is not an evidence type coverage can add up`);
        }
      }

      // One decline per case. The schema allows a second row — a case declined
      // again for a different reason is history — but `coverage_by_period` sums
      // them all, so a second row for a case that already has one double-counts
      // its dollars. Refused loudly here rather than counted twice there.
      //
      // This read is inside the case's row lock, so it closes the genuine race
      // as well as the double-click: a concurrent decline of the same case is
      // still waiting on that lock and cannot have read no row.
      //
      // It intentionally does not lock `declined_candidates` itself. There is
      // nothing to lock — the row does not exist yet, and a predicate lock over
      // "rows that might appear" is what SERIALIZABLE is for. The case row is
      // the thing both transactions agree on.
      const { rows: already } = await client.query<{ id: string; decided_at: string }>(
        `select id, decided_at::text as decided_at
           from declined_candidates
          where deduction_id = $1
          order by decided_at asc, id asc
          limit 1`,
        [input.deductionId],
      );
      const standing = already[0];
      if (standing !== undefined) {
        throw new AlreadyDeclinedError(input.deductionId, standing.id, standing.decided_at);
      }

      const { rows } = await client.query<{ id: string; decided_at: string }>(
        `insert into declined_candidates
           (org_id, deduction_id, discovered_from, provenance_kind, reason,
            estimated_recoverable_cents, decided_by, decided_by_version,
            missing_evidence, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id, decided_at`,
        [
          this.tenant.orgId,
          input.deductionId,
          discoveredFrom,
          provenanceKind,
          input.reason,
          found.amount,
          input.decidedBy,
          // A human decided, and that is a version like any other: when a policy
          // starts declining cases, the two have to be tellable apart.
          HUMAN_DECISION_VERSION,
          input.missingEvidence ?? [],
          input.detail ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('insert into declined_candidates returned no row');

      // The case's own timeline says so too, in the same transaction as the row
      // it describes: a reviewer reading the case should not have to know that
      // the counterfactual log is a separate table to find out it was declined.
      await client.query(
        `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
         values ($1, $2, 'case.declined', $3::jsonb, now())`,
        [
          this.tenant.orgId,
          input.deductionId,
          JSON.stringify({
            declined_candidate_id: row.id,
            reason: input.reason,
            // The column's own text, digit for digit. jsonb would hold a number
            // of any size, but everything that reads this payload back goes
            // through `JSON.parse`, and that is where a bigint would round.
            estimated_recoverable_cents: found.amount,
            discovered_from: discoveredFrom,
            // Said on the timeline too, so a reader of the case can tell an
            // observed channel from one a person supplied without going to
            // `declined_candidates` for it.
            provenance_kind: provenanceKind,
            decided_by: input.decidedBy,
            decided_by_version: HUMAN_DECISION_VERSION,
            missing_evidence: input.missingEvidence ?? [],
          }),
        ],
      );

      return {
        declinedCandidateId: row.id,
        deductionId: input.deductionId,
        reason: input.reason,
        estimatedRecoverableCents,
        discoveredFrom,
        provenanceKind,
        decidedBy: input.decidedBy,
        decidedByVersion: HUMAN_DECISION_VERSION,
        missingEvidence: input.missingEvidence ?? [],
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        decidedAt: row.decided_at,
      };
    });
  }

  // -------------------------------------------------------------------------
  // CaseWorkflowStore (ADR 0020): a human decides, and the gate is exercised
  // -------------------------------------------------------------------------
  //
  // Every one of these is a single `withTenant` transaction, because each is a
  // step through the case state machine and a step is three writes that have to
  // land together: the record, the append-only event, and the `deductions.state`
  // projection. Two of the three would be a case whose timeline and whose state
  // disagree, and the projection is supposed to be rebuildable from the stream.
  //
  // The work itself lives in `./workflow`, taking the client this transaction
  // opened — so the role, the tenant claims and the commit stay in one place
  // (`withTenant`) rather than being repeated five times.

  async recordHumanDecision(input: {
    readonly deductionId: string;
    readonly preparedBy: string;
    readonly reason: CanonicalReasonCode;
    readonly rationale: string;
  }): Promise<{ readonly decisionId: string }> {
    return this.withTenant((client) => workflow.recordHumanDecision(client, this.tenant, input));
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
    return this.withTenant((client) => workflow.assemblePacket(client, this.tenant, input));
  }

  async approve(input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approverId: string;
    readonly note?: string;
  }): Promise<{ readonly approvalId: string; readonly deductionId: string }> {
    return this.withTenant((client) => workflow.approve(client, this.tenant, input));
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
    return this.withTenant((client) => workflow.recordSubmission(client, this.tenant, input));
  }

  async recordOutcome(input: {
    readonly deductionId: string;
    readonly outcome: CaseOutcome;
    readonly recoveredCents: number;
    readonly recordedBy: string;
    readonly note?: string;
  }): Promise<{ readonly eventId: string }> {
    return this.withTenant((client) => workflow.recordOutcome(client, this.tenant, input));
  }

  async setDisputeDeadline(input: {
    readonly deductionId: string;
    readonly deadline: string;
    readonly basis: string;
    readonly setBy: string;
  }): Promise<{ readonly eventId: string }> {
    return this.withTenant((client) => workflow.setDisputeDeadline(client, this.tenant, input));
  }

  /** Everything the case page shows, in one transaction under one tenant's claims. */
  async getWorkflow(deductionId: string): Promise<CaseWorkflow | undefined> {
    return this.withTenant((client) => workflow.getWorkflow(client, deductionId));
  }

  // -------------------------------------------------------------------------
  // DuplicateReviewStore (ADR 0032): the pairs identity resolution left
  // -------------------------------------------------------------------------
  //
  // `resolveIdentity` merges only an exact match; a probable one opens the case
  // and names the other deduction on an event (ADR 0025 §6). These two are what
  // makes that a deferral to a person rather than to nobody: the list, and the
  // verdict. Both run as `app_rw` under the tenant's claims like everything else
  // here — the service role appears nowhere (invariant 6).

  async possibleDuplicates(options?: {
    readonly deductionId?: string;
    readonly limit?: number;
  }): Promise<readonly PossibleDuplicatePair[]> {
    return this.withTenant((client) => workflow.possibleDuplicates(client, options));
  }

  /**
   * Matches a remittance line recorded on `case.discovered` and never named as
   * a pair (audit F1). Read by `pnpm link:duplicates`; reads only.
   */
  async unnamedProbablePairs(options?: {
    readonly limit?: number;
  }): Promise<readonly workflow.UnnamedProbablePair[]> {
    return this.withTenant((client) => workflow.unnamedProbablePairs(client, options));
  }

  /** Names one of those as a `case.possible_duplicate`, once (audit F1). */
  async namePossibleDuplicate(input: {
    readonly discoveredEventId: string;
    readonly of: string;
    readonly recordedBy: string;
  }): Promise<'named' | 'already_named'> {
    return this.withTenant((client) =>
      workflow.namePossibleDuplicate(client, this.tenant, input),
    );
  }

  /**
   * The coverage page's figures for the last `months` months (ADR 0030, ADR
   * 0038): per channel per month, per channel over the window, dollars-only
   * monthly totals, and the confirmed duplicates still counted twice. One
   * tenant transaction as `app_rw`; the tenant is this store's, never a
   * parameter. Reads only.
   */
  async coverageReport(options: { readonly months?: number } = {}): Promise<CoverageReport> {
    const months = options.months ?? COVERAGE_MONTHS_DEFAULT;
    return this.withTenant((client) => readCoverageReport(client, months));
  }

  /**
   * The cases a person can act on now, most urgent first as the SQL sees it —
   * `rankForReview` gives the final order (ADR 0043). One tenant transaction as
   * `app_rw`; reads only.
   */
  async reviewQueue(
    options: { readonly today?: Date; readonly limit?: number } = {},
  ): Promise<ReviewQueueRead> {
    return this.withTenant((client) =>
      readReviewQueue(client, options.today ?? new Date(), options.limit ?? REVIEW_QUEUE_LIMIT),
    );
  }

  /**
   * The ledger sync's recent runs and, per connection, what its latest
   * completed run found (ADR 0031, ADR 0035). One tenant transaction as
   * `app_rw`. Reads only.
   */
  async ledgerSyncHealth(options: { readonly runLimit?: number } = {}): Promise<LedgerSyncHealth> {
    const runLimit = options.runLimit ?? LEDGER_RUNS_DEFAULT;
    return this.withTenant((client) => readLedgerSyncHealth(client, runLimit));
  }

  async recordDuplicateVerdict(input: {
    readonly deductionId: string;
    readonly otherDeductionId: string;
    readonly verdict: DuplicateVerdict;
    readonly recordedBy: string;
    readonly merge?: boolean;
  }): Promise<DuplicateVerdictRecord> {
    return this.withTenant((client) =>
      workflow.recordDuplicateVerdict(client, this.tenant, input),
    );
  }

  // Merging a confirmed pair, and undoing it (ADR 0042). One row each; the
  // database checks it, moves the state and writes the events.

  async mergeConfirmedDuplicate(input: {
    readonly deductionId: string;
    readonly otherDeductionId: string;
    readonly mergedBy: string;
  }): Promise<MergeRecord> {
    return this.withTenant((client) =>
      workflow.mergeConfirmedDuplicate(client, this.tenant, input),
    );
  }

  async undoMerge(input: {
    readonly deductionId: string;
    readonly undoneBy: string;
  }): Promise<UnmergeRecord> {
    return this.withTenant((client) => workflow.undoMerge(client, this.tenant, input));
  }

  async mergesFor(deductionId: string): Promise<CaseMerges> {
    return this.withTenant((client) => workflow.mergesFor(client, deductionId));
  }
}

/**
 * The database's refusal to hang work on a case merged into another (`RCM01`,
 * ADR 0042 §9), as the named error a route and a job can tell apart. DETAIL is
 * the case id and HINT the table, both set by the trigger and neither text off
 * a page. Anything else is not this and is left alone.
 */
function caseMergedAway(error: unknown): CaseMergedAwayError | undefined {
  if (sqlState(error) !== 'RCM01') return undefined;
  const detail = (error as { detail?: unknown } | null)?.detail;
  const hint = (error as { hint?: unknown } | null)?.hint;
  const refused = new CaseMergedAwayError(
    typeof detail === 'string' ? detail : 'unknown',
    typeof hint === 'string' ? hint : undefined,
  );
  (refused as { cause?: unknown }).cause = error;
  return refused;
}

/** The SQLSTATE of a driver error, when it carries one. */
function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Which constraint refused the row, as the driver reports it.
 *
 * A SQLSTATE says what kind of refusal it was; only the name says which rule.
 * Read off the error's `constraint` field rather than out of its message,
 * because the message quotes the offending row (invariant 4) and its wording is
 * the server's to change. An error that carries no name answers `undefined`,
 * which matches nothing — so a caller comparing against a name gets the
 * conservative answer and rethrows.
 */
function constraintName(error: unknown): string | undefined {
  const name = (error as { constraint?: unknown } | null)?.constraint;
  return typeof name === 'string' ? name : undefined;
}

/**
 * A date as an ISO string, whatever the driver handed us.
 *
 * `pg` parses `date` and `timestamptz` into Date objects, and a `date` in
 * particular becomes local midnight — so `toISOString()` on it can name the day
 * before. The date columns here are calendar dates (a dispute deadline is a day,
 * not an instant), so the local Y-M-D is the right reading of one.
 */
function isoDate(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
