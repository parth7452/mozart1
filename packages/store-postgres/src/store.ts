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
import { resolveDebtorId, tryParsePrintedDate } from '@recouple/core-domain';
import type { CanonicalReasonCode, CaseState, DebtorCandidate } from '@recouple/core-domain';
import type { DocType, ExtractedField, ModelCallRecord } from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';
import { DuplicateCaseError } from '@recouple/pipeline';
import type {
  CaseOutcome,
  CaseRecord,
  CaseWorkflow,
  CaseWorkflowStore,
  DocumentReadLease,
  IngestSource,
  JobStore,
  PipelineStore,
  StoredDocument,
  UnreadDocument,
  UnreadDocumentsStore,
  UploadRecord,
  UploadSource,
  WorkflowSubmissionChannel,
} from '@recouple/pipeline';
import { assertUnreadDocumentsQuery, UPLOAD_SOURCES } from '@recouple/pipeline';
import * as workflow from './workflow';
import { exactCents } from './workflow';

/**
 * The same claim, for the same debtor, is already a case.
 *
 * Defined with the pipeline's steps, not here, so that the in-memory store and
 * this one refuse a duplicate with the same class — a caller cannot be right
 * about one store and wrong about the other.
 */
export { DuplicateCaseError };

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
type PoolPurpose = 'work' | 'locks';

function poolFor(config: PostgresStoreConfig, purpose: PoolPurpose = 'work'): Pool {
  const key = `${config.connectionString}::${config.max ?? 4}::${purpose}`;
  const existing = pools.get(key);
  if (existing !== undefined) return existing;
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max ?? 4,
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
  readonly documentCount: number;
  readonly createdAt: string;
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

export function isDeclineReason(value: unknown): value is DeclineReason {
  return typeof value === 'string' && (DECLINE_REASONS as readonly string[]).includes(value);
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
 * Raised when a case already carries a decline.
 *
 * `coverage_by_period` sums `estimated_recoverable_cents` over every declined
 * row, so a second decline of the same case counts its dollars twice in the
 * denominator — a double-clicked form would quietly move the one number this
 * feature exists to produce. The row is refused rather than the number being
 * wrong, and the first decline stands.
 */
export class AlreadyDeclinedError extends Error {
  constructor(
    readonly deductionId: string,
    readonly declinedCandidateId: string,
    readonly decidedAt: string,
  ) {
    super(`case ${deductionId} was already declined at ${decidedAt}`);
    this.name = 'AlreadyDeclinedError';
  }
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
 * In practice this means one of two things: the case has no notice document at
 * all, or its notice was stored before ingest recorded provenance and has no
 * `uploads` row behind it. Both are fixable with a fact somebody has; neither
 * is fixable by this code choosing a plausible answer.
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

/** A recorded decline: what it was worth, and what would have changed it. */
export interface DeclinedCandidate {
  readonly declinedCandidateId: string;
  readonly deductionId: string;
  readonly reason: DeclineReason;
  readonly estimatedRecoverableCents: number;
  readonly discoveredFrom: string;
  readonly decidedBy: string;
  readonly decidedByVersion: string;
  readonly missingEvidence: readonly string[];
  readonly detail?: string;
  readonly decidedAt: string;
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
  document_count: number;
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

/**
 * Documents carry their bytes in object storage, not in Postgres. The store
 * keeps them in memory for the length of a pipeline run so the reader models can
 * be handed a payload without a round trip to a bucket that does not exist yet;
 * Phase 1b replaces this with Supabase Storage.
 */
export interface BlobStore {
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
    if (documentId === undefined) return;
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
    const documentId = documentIdFromRef(ref);
    if (documentId === undefined) return undefined;
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ bytes: Buffer }>(
        `select bytes from document_blobs where document_id = $1`,
        [documentId],
      );
      const found = rows[0]?.bytes;
      return found === undefined ? undefined : new Uint8Array(found);
    });
  }
}

const REF_PREFIX = 'pgblob://';

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
  async put(ref: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(ref, bytes);
  }
  async get(ref: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(ref);
  }
}

export class PostgresStore
  implements PipelineStore, CaseWorkflowStore, JobStore, UnreadDocumentsStore
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
   */
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

  async recordClassification(
    documentId: string,
    docType: DocType,
    confidence: number,
  ): Promise<void> {
    await this.withTenant(async (client) => {
      await client.query(
        `insert into document_classifications (org_id, document_id, doc_type, confidence)
         values ($1, $2, $3, $4)`,
        [this.tenant.orgId, documentId, docType, confidence],
      );
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

  async latestExtraction(
    documentId: string,
  ): Promise<{ docType: DocType; document: unknown } | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ doc_type: DocType }>(
        `select doc_type from document_classifications
          where document_id = $1 order by id desc limit 1`,
        [documentId],
      );
      const docType = rows[0]?.doc_type;
      if (docType === undefined) return undefined;

      // The typed object is rebuilt from the field rows: they are the record of
      // record, and reassembling from them proves nothing was lost on the way in.
      const { rows: fields } = await client.query<{ field_path: string; value_json: unknown }>(
        `select field_path, value_json from extraction_results
          where document_id = $1 order by id asc`,
        [documentId],
      );
      if (fields.length === 0) return undefined;
      return { docType, document: rebuildDocument(fields) };
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
      const { rows } = await client.query<{ text_layer: string | null }>(
        `select text_layer from document_pages
          where document_id = $1 order by page_number asc`,
        [documentId],
      );
      if (rows.length === 0) return undefined;
      return rows.map((row) => row.text_layer ?? '');
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

  async openCase(input: {
    orgId: string;
    claimId?: string;
    retailerName?: string;
    deductionAmountCents?: number;
    deductionDate?: string;
    disputeDeadline?: string;
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

      // A failed statement aborts the whole transaction, and the lookup that
      // explains the failure is itself a statement. The savepoint is what lets
      // us ask the question rather than hand back a bare driver error.
      await client.query('savepoint before_open_case');
      let rows: { id: string; state: CaseState }[];
      try {
        ({ rows } = await client.query<{ id: string; state: CaseState }>(
          `insert into deductions (org_id, debtor_id, claim_id, retailer_name_as_printed,
                                   deduction_amount_cents, deduction_date, dispute_deadline, state)
           values ($1, $2, $3, $4, $5, $6, $7, 'discovered')
           returning id, state`,
          [
            input.orgId,
            debtorId ?? null,
            input.claimId ?? null,
            input.retailerName ?? null,
            input.deductionAmountCents ?? 1,
            input.deductionDate ?? null,
            input.disputeDeadline ?? null,
          ],
        ));
      } catch (error) {
        await client.query('rollback to savepoint before_open_case');
        throw await this.explainDuplicateCase(client, error, input.claimId, debtorId);
      }
      await client.query('release savepoint before_open_case');
      const row = rows[0];
      if (row === undefined) throw new Error('insert into deductions returned no row');
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
      `select id from deductions where debtor_id = $1 and claim_id = $2 limit 1`,
      [debtorId, claimId],
    );
    const existing = rows[0]?.id;
    if (existing === undefined) return error;
    return new DuplicateCaseError(
      `claim ${claimId} is already open for this debtor as case ${existing}`,
      existing,
      claimId,
    );
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
      }>(
        `select id, org_id, state, claim_id, deduction_amount_cents
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
      const { rows } = await client.query<{ deduction_id: string }>(
        `select deduction_id from deduction_documents
          where document_id = $1
          order by (role = 'notice') desc, observed_at asc, id asc
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

      try {
        const result = await work();
        // Nothing was written in this transaction; the commit is what releases
        // the lock, and it happens once the work is finished either way.
        await client.query('commit');
        return { held: true, result };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
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

  async findOrgBySlug(slug: string): Promise<{ orgId: string; slug: string } | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string }>(
        `select id, slug from organizations where slug = $1`,
        [slug],
      );
      const row = rows[0];
      return row === undefined ? undefined : { orgId: row.id, slug: row.slug };
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
        `select d.id, d.state, d.claim_id, d.deduction_amount_cents::text as amount,
                d.deduction_date, d.dispute_deadline, d.created_at,
                d.retailer_name_as_printed,
                b.display_name as debtor_name, b.retailer_key,
                (select count(*) from deduction_documents dd where dd.deduction_id = d.id)
                  ::int as document_count
           from deductions d
           left join debtors b on b.id = d.debtor_id
          order by d.created_at desc
          limit $1`,
        [limit],
      );
      return rows.map((row) => {
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
          documentCount: row.document_count,
          createdAt: isoDate(row.created_at) ?? '',
        };
      });
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
   */
  async fieldsForCase(deductionId: string): Promise<readonly StoredField[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<StoredFieldRow>(
        `select e.document_id, coalesce(d.filename, '') as filename, d.mime_type,
                c.doc_type, e.field_path, e.value_json, e.confidence,
                e.source_page, e.source_quote, e.source_bbox, e.quote_verified
           from extraction_results e
           join documents d on d.id = e.document_id
           left join lateral (
             select doc_type from document_classifications dc
              where dc.document_id = e.document_id order by dc.id desc limit 1
           ) c on true
          where e.deduction_id = $1
          order by e.document_id, e.id asc`,
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
   * @throws {ProvenanceUnknownError} the case has no notice, or its notice has
   *   no `uploads` row to say which channel found it
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
      const { rows: caseRows } = await client.query<{
        amount: string;
        notice_document_id: string | null;
        discovered_from: string | null;
      }>(
        `select d.deduction_amount_cents::text as amount,
                notice.document_id as notice_document_id,
                notice.source as discovered_from
           from deductions d
           left join lateral (
             select doc.id as document_id, u.source
               from deduction_documents dd
               join documents doc on doc.id = dd.document_id
               left join uploads u on u.id = doc.upload_id
              where dd.deduction_id = d.id and dd.role = 'notice'
              order by doc.created_at asc
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
      if (found.discovered_from === null) {
        throw new ProvenanceUnknownError(
          input.deductionId,
          found.notice_document_id === null
            ? 'it has no notice document, so nothing on it says which channel found this deduction'
            : `its notice document ${found.notice_document_id} records no arrival, so nothing ` +
              'says which channel found this deduction',
          found.notice_document_id ?? undefined,
        );
      }
      const discoveredFrom = found.discovered_from as DiscoveredFrom;

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
          order by decided_at asc
          limit 1`,
        [input.deductionId],
      );
      const standing = already[0];
      if (standing !== undefined) {
        throw new AlreadyDeclinedError(input.deductionId, standing.id, standing.decided_at);
      }

      const { rows } = await client.query<{ id: string; decided_at: string }>(
        `insert into declined_candidates
           (org_id, deduction_id, discovered_from, reason,
            estimated_recoverable_cents, decided_by, decided_by_version,
            missing_evidence, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, decided_at`,
        [
          this.tenant.orgId,
          input.deductionId,
          discoveredFrom,
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

  /** Everything the case page shows, in one transaction under one tenant's claims. */
  async getWorkflow(deductionId: string): Promise<CaseWorkflow | undefined> {
    return this.withTenant((client) => workflow.getWorkflow(client, deductionId));
  }
}

/** The SQLSTATE of a driver error, when it carries one. */
function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
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

/** Segments that would reach the prototype chain rather than the object. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Rebuilds a nested document from flat field rows (`lines[0].sku_upc` → nested).
 *
 * Paths written by `recordExtraction` are schema-derived, but this reads them
 * back out of the database and walks them as object keys, so it refuses the
 * segments that would climb the prototype chain instead of trusting where the
 * row came from.
 */
function rebuildDocument(
  rows: readonly { field_path: string; value_json: unknown }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const segments = row.field_path.split('.');
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.replace(/\[\d+\]$/, '')))) {
      continue;
    }
    let node: Record<string, unknown> = out;
    segments.forEach((segment, index) => {
      const match = /^([^[]+)\[(\d+)\]$/.exec(segment);
      const last = index === segments.length - 1;
      if (match?.[1] !== undefined && match[2] !== undefined) {
        const key = match[1];
        const row_index = Number(match[2]);
        const array = (node[key] as unknown[] | undefined) ?? [];
        node[key] = array;
        const existing = (array[row_index] as Record<string, unknown> | undefined) ?? {};
        array[row_index] = existing;
        node = existing;
        return;
      }
      if (last) {
        node[segment] = { value: row.value_json };
        return;
      }
      const existing = (node[segment] as Record<string, unknown> | undefined) ?? {};
      node[segment] = existing;
      node = existing;
    });
  }
  return out;
}
