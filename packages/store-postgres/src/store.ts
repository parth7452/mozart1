/**
 * The PipelineStore, backed by Postgres.
 *
 * Every query runs as `app_rw` with the caller's tenant claim set, so the same
 * RLS policies that protect the database in production protect it here. The
 * service role never appears: this store is what a request path uses, and
 * invariant 6 says the service-role key does not belong in one.
 *
 * It writes through the real constraints — append-only triggers, the approval
 * gate, the tenant policies — which is the point. An in-memory store can only
 * ever prove the pipeline's own logic; this proves the schema supports it.
 */

import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { resolveDebtorId, tryParsePrintedDate } from '@recouple/core-domain';
import type { CaseState, DebtorCandidate } from '@recouple/core-domain';
import type { DocType, ExtractedField, ModelCallRecord } from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';
import { DuplicateCaseError } from '@recouple/pipeline';
import type { CaseRecord, PipelineStore, StoredDocument } from '@recouple/pipeline';

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

function poolFor(config: PostgresStoreConfig): Pool {
  const key = `${config.connectionString}::${config.max ?? 4}`;
  const existing = pools.get(key);
  if (existing !== undefined) return existing;
  const pool = new Pool({ connectionString: config.connectionString, max: config.max ?? 4 });
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
 */
export const DISCOVERED_FROM = [
  'web_upload',
  'email_in',
  'email_body',
  'erp_sync',
  'portal_fetch',
  'edi_812',
] as const;

export type DiscoveredFrom = (typeof DISCOVERED_FROM)[number];

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

export class PostgresStore implements PipelineStore {
  private readonly pool: Pool;
  private readonly role: string;

  private readonly blobs: BlobStore;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
    blobs?: BlobStore,
  ) {
    this.pool = poolFor(config);
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
    };
  }

  async findDocumentByHash(orgId: string, sha256: string): Promise<StoredDocument | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<DocumentRow>(
        `select id, org_id, sha256, mime_type, byte_size, storage_ref,
                coalesce(filename, '') as filename
           from documents
          where org_id = $1 and sha256 = $2`,
        [orgId, Buffer.from(sha256, 'hex')],
      );
      const row = rows[0];
      return row === undefined ? undefined : this.toStoredDocument(row);
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
        `insert into documents (id, org_id, sha256, byte_size, mime_type, storage_ref, filename)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          documentId,
          document.orgId,
          Buffer.from(document.sha256, 'hex'),
          document.byteSize,
          document.mimeType,
          storageRef,
          document.filename,
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
                coalesce(d.filename, '') as filename
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
   * One document by id, bytes included.
   *
   * There is no org predicate here on purpose: the policies decide, and a
   * document of another tenant comes back as nothing rather than as a row we
   * then have to remember to check.
   */
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    const row = await this.withTenant(async (client) => {
      const { rows } = await client.query<DocumentRow>(
        `select id, org_id, sha256, mime_type, byte_size, storage_ref,
                coalesce(filename, '') as filename
           from documents where id = $1`,
        [documentId],
      );
      return rows[0];
    });
    return row === undefined ? undefined : this.toStoredDocument(row);
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
   * `discovered_from` is read off the case's own notice rather than passed in:
   * it is how the deduction reached us, which is a fact about the document, not
   * something a reviewer should be able to type. Coverage is attributed by
   * source, so a wrong value here quietly credits the wrong channel.
   */
  async declineCase(input: {
    deductionId: string;
    reason: DeclineReason;
    decidedBy: string;
    /**
     * What to attribute the decline to when the case's own documents do not say.
     *
     * Nothing writes the `uploads` table yet, so `documents.upload_id` is always
     * null and this fallback is, today, always what gets used. It is a required
     * parameter and it is named for what it is, because `discovered_from` is
     * NOT NULL so that coverage can be attributed by channel — and a channel
     * quietly credited to the wrong source is a number that looks right.
     *
     * When ingest starts recording provenance this stops being reached, and the
     * derivation below takes over with no change here.
     */
    assumedDiscoveredFrom: DiscoveredFrom;
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
      const { rows: caseRows } = await client.query<{
        amount: string;
        discovered_from: string | null;
      }>(
        `select d.deduction_amount_cents::text as amount,
                (select u.source
                   from deduction_documents dd
                   join documents doc on doc.id = dd.document_id
                   join uploads u on u.id = doc.upload_id
                  where dd.deduction_id = d.id and dd.role = 'notice'
                  order by doc.created_at asc
                  limit 1) as discovered_from
           from deductions d
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

      // Derived when the document knows, the caller's stated assumption when it
      // does not. Today it is always the latter.
      const discoveredFrom = found.discovered_from ?? input.assumedDiscoveredFrom;

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
}

/**
 * A bigint cents column as a JS number, or a loud failure.
 *
 * Money is integer cents in a bigint (invariant 3), and a JS number holds only
 * 2^53 of them exactly. Every conversion is therefore a place where a value can
 * quietly stop being itself, and a rounded cent on a money path is the kind of
 * bug that is only ever found in a reconciliation. This refuses instead.
 */
function exactCents(text: string, column: string): number {
  const cents = Number(text);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${column} is ${text}, which no JS number holds exactly`);
  }
  return cents;
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
