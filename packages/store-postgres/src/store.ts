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
import type { CaseState } from '@recouple/core-domain';
import type { DocType, ExtractedField, ModelCallRecord } from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';
import type { CaseRecord, PipelineStore, StoredDocument } from '@recouple/pipeline';

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
  readonly documentCount: number;
  readonly createdAt: string;
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

  async openCase(input: {
    orgId: string;
    claimId?: string;
    retailerName?: string;
    deductionAmountCents?: number;
  }): Promise<CaseRecord> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string; state: CaseState }>(
        `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
         values ($1, $2, $3, 'discovered')
         returning id, state`,
        [input.orgId, input.claimId ?? null, input.deductionAmountCents ?? 1],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('insert into deductions returned no row');
      return {
        deductionId: row.id,
        orgId: input.orgId,
        state: row.state,
        ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
        ...(input.retailerName !== undefined ? { retailerName: input.retailerName } : {}),
        ...(input.deductionAmountCents !== undefined
          ? { deductionAmountCents: input.deductionAmountCents }
          : {}),
      };
    });
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
