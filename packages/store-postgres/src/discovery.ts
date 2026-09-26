/**
 * The ERP discovery path, on Postgres (ADR 0029, STRATEGY §5, §6.3, ADD-7).
 *
 * A short-pay found in a customer's own ledger becomes a case the same way a
 * deduction notice does: an `uploads` row, then bytes, then a case, then the
 * link that makes those bytes its notice. Nothing here invents a channel and
 * nothing here writes a table the rest of the system does not already read —
 * which is the whole reason ADR 0029 §1 chose "a ledger extract is a document"
 * over a shadow table. `declineCase` can derive `erp_sync` off such a case's
 * notice on the day it is opened.
 *
 * It is a **separate class with its own tenant scoping**, in the manner of
 * `workflow.ts`, and it runs as `app_rw` with the tenant's claims set
 * transaction-locally like everything else here. The service role appears
 * nowhere.
 *
 * Three things it is careful about:
 *
 *  1. **It never copies `PostgresStore`.** `findDocumentByHash`, `putDocument`
 *     and `openCase` are delegated to the store instance it is given —
 *     `openCase` in particular carries the debtor resolution of ADR 0019 and
 *     the duplicate-claim explanation of `DuplicateCaseError`, and a second
 *     copy of either would be a second set of rules.
 *  2. **The writes that stop a duplicate land together.** `recordLedgerCase` is
 *     not one transaction — the delegated calls each open their own, and
 *     `store.ts` is not edited by this change (ADR 0029 §5) — but the notice
 *     link, the identifier rows and the events are, because the identifier rows
 *     are what make the *next* sync answer `exact` instead of opening a second
 *     case. The remaining window, between `openCase`'s commit and that
 *     transaction, is narrowed by re-using the case a stored extract is already
 *     attached to rather than being hidden.
 *  3. **`discovered_from` is a literal, not a parameter.** This class is the ERP
 *     path; it can only ever be `erp_sync`. A caller that could pass a channel
 *     is a coverage number credited on somebody's say-so (ADR 0024 §1).
 */

import type { Pool, PoolClient } from 'pg';
import { applyTransition, cents, CLOSED_STATES } from '@recouple/core-domain';
import type { Cents, IdentifierKind, LedgerExtract } from '@recouple/core-domain';
import { sessionPool, type PostgresStore, type PostgresStoreConfig, type TenantContext } from './store';

/**
 * What decided, and which version of it. Written to
 * `declined_candidates.decided_by_version` so that when the Phase 2 model takes
 * this slot the two populations can be told apart and scored against each other
 * (STRATEGY ADD-7).
 */
export const TRIAGE_DECIDED_BY = 'triage-rules';
export const TRIAGE_DECIDED_BY_VERSION = 'triage-rules/v1';

/** The one channel this class can write. Never a parameter (ADR 0029 §5). */
const DISCOVERED_FROM_ERP = 'erp_sync';

/** An identifier a deduction is already known by, as the matcher wants it. */
export interface StoredIdentifier {
  readonly deductionId: string;
  readonly source: string;
  readonly kind: IdentifierKind;
  readonly identifier: string;
}

/** An open deduction, as far as identity matching cares about it. */
export interface StoredDeduction {
  readonly deductionId: string;
  /** Branded integer cents, so it compares against a candidate's gap directly. */
  readonly amountCents: Cents;
  readonly invoiceNumber?: string;
  readonly deductionDate?: string;
  readonly debtorId?: string;
}

/** The identifiers a ledger arrival carries. Both may be absent-shaped. */
export interface LedgerIdentifiers {
  /** The ledger's own key for the invoice (`ledger_invoice_id`). */
  readonly ledgerInvoiceId: string;
  /** The invoice number as the customer sees it (`invoice_number`). */
  readonly invoiceNumber: string;
}

export interface RecordLedgerCaseInput {
  readonly orgId: string;
  readonly extract: LedgerExtract;
  readonly identifiers: LedgerIdentifiers;
  readonly gapCents: number;
  readonly customerName: string;
  readonly gapStatus: string;
  /** The day the money went missing: the last payment applied to the invoice. */
  readonly deductionDate?: string;
  /** Set when identity answered `probable` — the case opens with a flag on it. */
  readonly possibleDuplicateOf?: {
    readonly deductionId: string;
    readonly basis: readonly string[];
  };
}

export interface RecordedLedgerCase {
  readonly deductionId: string;
  readonly documentId: string;
  /** True when the extract's bytes, and the case, were already here. */
  readonly reused: boolean;
}

export interface DeclineCandidateInput {
  readonly orgId: string;
  readonly reason: 'below_economic_floor' | 'duplicate_of_other';
  readonly estimatedRecoverableCents: number;
  readonly identifiers: LedgerIdentifiers;
  /**
   * Who deducted, as the ledger names them — the vendor's own key and the
   * customer name printed on the invoice, both verbatim.
   *
   * Recorded because a per-debtor cut of coverage (STRATEGY ADD-2, ADD-4) is
   * impossible to reconstruct afterwards for a declined candidate that never
   * became a case: `deduction_id` is null, so there is no `debtor_id`, and
   * nothing else on the row says who the money was withheld by. Two strings
   * written now, or a number nobody can ever compute.
   *
   * Untrusted, and treated as such (invariant 4): stored verbatim into
   * `external_ids`, never matched into master data here and never used to mint
   * a debtor. `customer_external_id` is a vendor's key, not a `debtor_id`;
   * joining the two is identity resolution's job (STRATEGY §5.2), and the
   * per-debtor view is deliberately not built here.
   */
  readonly customerExternalId: string;
  readonly customerName: string;
  readonly detail?: string;
}

/**
 * One row of `coverage_by_period_by_source` (migration 0023, ADR 0030).
 *
 * Every cents column is integer cents parsed exactly from the column's text
 * (invariant 3). `coverageOfDiscovered` is the *view's* ratio, rounded to four
 * places in the database: nothing here divides one bigint by another, because
 * that is where integer cents stop being integer cents.
 */
export interface CoveragePeriodRow {
  readonly orgId: string;
  /** The month, as `YYYY-MM-DD` on its first day. */
  readonly period: string;
  /**
   * The channel that found the money — or `'unknown'` where nothing recorded
   * how the case's notice arrived. `'unknown'` is not an `UploadSource`: it is
   * the absence of one, and it exists only in this view (ADR 0030 §3).
   */
  readonly discoveredFrom: string;
  readonly openedCount: number;
  readonly openedCents: number;
  readonly filedCount: number;
  readonly filedCents: number;
  /**
   * Every decline decided in the period, whether or not it named a case — so a
   * case opened and later declined is here *and* in `openedCents` (ADR 0038 §2).
   */
  readonly declinedCount: number;
  readonly declinedCents: number;
  /**
   * Each deduction once, as the view computed it: every case opened in the
   * period plus every candidate declined without becoming a case. **Not**
   * `openedCents + declinedCents`, which counts a declined case twice
   * (migration 0029, ADR 0038).
   */
  readonly discoveredCents: number;
  /** Null where nothing was discovered in that period from that source. */
  readonly coverageOfDiscovered: number | undefined;
}

export interface DeclinedLedgerCandidate {
  readonly declinedCandidateId: string;
  readonly reason: DeclineCandidateInput['reason'];
  readonly estimatedRecoverableCents: number;
  /** False when a decline for this invoice and version was already recorded. */
  readonly written: boolean;
}

export class DiscoveryStoreError extends Error {}

export class PostgresDiscoveryStore {
  private readonly pool: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
    /**
     * The store this one delegates document and case creation to. Taken rather
     * than re-implemented: `openCase` carries the debtor resolution and the
     * duplicate-claim refusal, and there is to be one copy of both.
     */
    private readonly store: PostgresStore,
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
  }

  /**
   * As `PostgresStore.withTenant`: the role and the claims are transaction-local,
   * so a pooled connection cannot carry one tenant's claims into another's
   * query. Repeated here rather than reached into, because it is four lines and
   * a private method on another class is not an API.
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

  /**
   * Every identifier this tenant's deductions are known by — the left-hand side
   * of `resolveIdentity`.
   *
   * Read whole rather than queried per candidate: matching normalises both
   * sides (trim, case-fold, collapse whitespace), so an index on the raw column
   * would not serve a lookup anyway, and a tenant holds thousands of these
   * rather than millions (ADR 0025).
   */
  async knownIdentifiers(orgId: string): Promise<readonly StoredIdentifier[]> {
    this.assertOwnTenant(orgId);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        deduction_id: string;
        source: string;
        identifier_kind: IdentifierKind;
        identifier: string;
      }>(
        // A merged-away case's names are its survivor's (ADR 0042 §10): a
        // ledger line matching either half of a merged pair is the survivor.
        `select coalesce(m.surviving_deduction_id, i.deduction_id) as deduction_id,
                i.source, i.identifier_kind, i.identifier
           from deduction_identifiers i
           left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
          where i.org_id = $1
          order by i.first_seen_at asc, i.id asc`,
        [orgId],
      );
      return rows.map((row) => ({
        deductionId: row.deduction_id,
        source: row.source,
        kind: row.identifier_kind,
        identifier: row.identifier,
      }));
    });
  }

  /**
   * The deductions a probable match could be about: everything not closed.
   *
   * "Open" means not closed — `won`, `lost`, `partial` and `written_off` are
   * where a deduction ends, and a ledger line that resembles a finished case is
   * a probable match worth nothing: the money question it asks was already
   * answered. A case merged into another is closed too (`CLOSED_STATES` in
   * `core-domain`, ADR 0042): it is not the deduction any more, its survivor is.
   * Its invoice number is not lost with it: the survivor is read with every
   * invoice row of the cases merged into it, so a survivor whose own row was
   * skipped as a collision is still a probable match for the next copy
   * (docs/audits/duplicate-counting, F5). A survivor that holds an invoice row
   * of its own keeps it, however old the merged-away half's.
   *
   * Money is read as text and converted once, checked: a bigint through a JS
   * number is lossy above 2^53 and this value is compared against a candidate's
   * `gapCents` (invariant 3).
   */
  async knownDeductions(orgId: string): Promise<readonly StoredDeduction[]> {
    this.assertOwnTenant(orgId);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        amount: string;
        invoice_number: string | null;
        deduction_date: string | null;
        debtor_id: string | null;
      }>(
        `select d.id,
                d.deduction_amount_cents::text as amount,
                -- Over the case and every case merged into it (ADR 0042
                -- §10), as knownIdentifiers reads them: a survivor whose
                -- own invoice row was skipped as a collision holds the one
                -- the merged-away copy recorded. Its own row comes first,
                -- whatever its age: a merged-away half may print another.
                (select i.identifier
                   from deduction_identifiers i
                   left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
                  where i.org_id = d.org_id
                    and coalesce(m.surviving_deduction_id, i.deduction_id) = d.id
                    and i.identifier_kind = 'invoice_number'
                  order by (i.deduction_id = d.id) desc, i.first_seen_at asc, i.id asc
                  limit 1) as invoice_number,
                to_char(d.deduction_date, 'YYYY-MM-DD') as deduction_date,
                d.debtor_id
           from deductions d
          where d.org_id = $1
            and d.state <> all ($2::text[])
          order by d.created_at asc, d.id asc`,
        [orgId, [...CLOSED_STATES]],
      );
      return rows.map((row) => ({
        deductionId: row.id,
        amountCents: cents(exactCentsOrThrow(row.amount, 'deduction_amount_cents')),
        ...(row.invoice_number !== null ? { invoiceNumber: row.invoice_number } : {}),
        ...(row.deduction_date !== null ? { deductionDate: row.deduction_date } : {}),
        ...(row.debtor_id !== null ? { debtorId: row.debtor_id } : {}),
      }));
    });
  }

  /**
   * Stores the ledger extract, opens the case it is the notice for, and records
   * the names the ledger knows it by.
   *
   * The order is the order `ingestDocument` uses, for the same reason: the
   * arrival before the bytes, so a stored document always has an arrival behind
   * it, and the reverse order can leave a document that cannot say where it
   * came from.
   *
   * Re-running a sync is safe. The extract is canonical, so unchanged ledger
   * state hashes to the document already stored; if that document is already a
   * case's notice, this returns the case it is on and writes nothing new rather
   * than opening a second one.
   */
  async recordLedgerCase(input: RecordLedgerCaseInput): Promise<RecordedLedgerCase> {
    this.assertOwnTenant(input.orgId);

    const existing = await this.store.findDocumentByHash(input.orgId, input.extract.sha256);
    if (existing !== undefined) {
      const onCase = await this.store.caseForDocument(existing.documentId);
      if (onCase !== undefined) {
        // The whole of this method already happened, or happened far enough
        // that the case exists and the document is on it. Anything it would
        // write now is either already there or would be a second case for one
        // invoice.
        await this.ensureIdentifiers(onCase, input.orgId, input.identifiers);
        return { deductionId: onCase, documentId: existing.documentId, reused: true };
      }
    }

    // A re-sync whose bytes are already stored keeps the first arrival's
    // `uploads` row: the channel that re-sent something we already had did not
    // find it (ADR 0024). A genuinely new extract gets an arrival of its own.
    const documentId =
      existing !== undefined
        ? existing.documentId
        : await this.storeExtract(input.orgId, input.extract);

    const opened = await this.store.openCase({
      orgId: input.orgId,
      deductionAmountCents: input.gapCents,
      // As the ledger printed it. `openCase` may select a debtor through an
      // alias a human added; it never mints one (ADR 0019, invariant 4).
      retailerName: input.customerName,
      ...(input.deductionDate !== undefined ? { deductionDate: input.deductionDate } : {}),
    });

    // One transaction from here: the link, the identifiers and the events. The
    // identifiers are what make the next sync skip this invoice, so a case that
    // has them but no link — or a link but no identifiers — is the state a
    // duplicate comes out of.
    await this.withTenant(async (client) => {
      await client.query(
        `insert into deduction_documents (org_id, deduction_id, document_id, role)
         values ($1, $2, $3, 'notice')
         on conflict (deduction_id, document_id, role) do nothing`,
        [input.orgId, opened.deductionId, documentId],
      );

      await this.insertIdentifiers(client, opened.deductionId, input.orgId, input.identifiers);

      await client.query(
        `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
         values ($1, $2, 'case.discovered', $3::jsonb, now())`,
        [
          input.orgId,
          opened.deductionId,
          JSON.stringify({
            document_id: documentId,
            source: DISCOVERED_FROM_ERP,
            gap_status: input.gapStatus,
            invoice_number: input.identifiers.invoiceNumber,
            ledger_invoice_id: input.identifiers.ledgerInvoiceId,
            retailer_name: input.customerName,
            debtor_id: opened.debtorId ?? null,
            deduction_date: input.deductionDate ?? null,
          }),
        ],
      );

      // A ledger extract's type is known by construction, so the case it opens
      // crosses `discovered → classified` here, in the same transaction as its
      // notice link — the edge a notice crosses once the classifier has read
      // it. Without this a ledger case could be neither decided nor declined
      // (ADR 0043 §2).
      if (!(await this.classifyLedgerCase(client, input.orgId, opened.deductionId))) {
        throw new DiscoveryStoreError(
          `case ${opened.deductionId} was opened a moment ago and is not discovered`,
        );
      }

      if (input.possibleDuplicateOf !== undefined) {
        // The held-pair record, until a merge operation exists (STRATEGY §5.2).
        // `basis` names the facts that agreed and never their values, because
        // this is an append-only event and document text does not go there.
        await client.query(
          `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
           values ($1, $2, 'case.possible_duplicate', $3::jsonb, now())`,
          [
            input.orgId,
            opened.deductionId,
            JSON.stringify({
              of: input.possibleDuplicateOf.deductionId,
              basis: input.possibleDuplicateOf.basis,
            }),
          ],
        );
      }
    });

    return { deductionId: opened.deductionId, documentId, reused: existing !== undefined };
  }

  /**
   * Every one of this tenant's ledger cases still in `discovered`, moved to
   * `classified` with one `case.classified` event each (ADR 0043 §2).
   *
   * A ledger case opens `classified` now. The ones opened before that stayed
   * `discovered`, and the case page offers neither decide nor decline there.
   * Only cases whose notice arrived through `erp_sync` are touched, so a notice
   * half-way through its own read is left to its own path — and so is a case
   * `openCase` committed before a sync died short of linking it (ADR 0029's
   * crash window), which has no notice to say where it came from. Locked, so
   * two overlapping syncs cannot both move one case. The sync runs this first
   * on every run; after the first it finds nothing.
   */
  async classifyLedgerCases(orgId: string): Promise<readonly string[]> {
    this.assertOwnTenant(orgId);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select d.id::text as id
           from deductions d
          where d.org_id = $1
            and d.state = 'discovered'
            and exists (
              select 1 from deduction_documents dd
                join documents doc on doc.id = dd.document_id
                join uploads u on u.id = doc.upload_id
               where dd.deduction_id = d.id and dd.role = 'notice' and u.source = $2)
          order by d.created_at asc, d.id asc
          for update of d`,
        [orgId, DISCOVERED_FROM_ERP],
      );
      const moved: string[] = [];
      for (const row of rows) {
        if (await this.classifyLedgerCase(client, orgId, row.id)) moved.push(row.id);
      }
      return moved;
    });
  }

  /**
   * `discovered → classified` on `document.classified`, whose one guard is that
   * the document's type is known — which a ledger extract's is. Checked against
   * the state machine, then written only if the case is still `discovered`, with
   * its event in the same transaction. False when it was not.
   */
  private async classifyLedgerCase(
    client: PoolClient,
    orgId: string,
    deductionId: string,
  ): Promise<boolean> {
    applyTransition('discovered', 'classified', 'document.classified', { doc_type_known: true });
    const { rowCount } = await client.query(
      `update deductions set state = 'classified', updated_at = now()
        where id = $1 and state = 'discovered'`,
      [deductionId],
    );
    if (rowCount !== 1) return false;
    await client.query(
      `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values ($1, $2, 'case.classified', $3::jsonb, now())`,
      [orgId, deductionId, JSON.stringify({ classified_by: 'ledger_sync', source: DISCOVERED_FROM_ERP })],
    );
    return true;
  }

  /**
   * The arrival, then the bytes — `ingestDocument`'s order, and its reason.
   *
   * The `uploads` row is written here rather than through
   * `PostgresStore.recordUpload` for one narrow reason: that method's `source`
   * is typed `IngestSource`, the three channels the *pipeline* can produce, and
   * `erp_sync` is deliberately not one of them. The column has admitted it
   * since migration 0014. Widening the type is an edit to `store.ts`, which
   * this change does not make (ADR 0029 §5); the statement is the same insert.
   *
   * `created_by` is null and cannot be anything else: a scheduled job read a
   * third party's API, and no member put this document in front of the
   * pipeline.
   */
  private async storeExtract(orgId: string, extract: LedgerExtract): Promise<string> {
    const uploadId = await this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into uploads (org_id, source, created_by)
         values ($1, $2, null)
         returning id`,
        [orgId, DISCOVERED_FROM_ERP],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new DiscoveryStoreError('insert into uploads returned no row');
      return id;
    });

    const stored = await this.store.putDocument({
      orgId,
      sha256: extract.sha256,
      filename: extract.filename,
      mimeType: extract.mimeType,
      byteSize: extract.bytes.byteLength,
      bytes: extract.bytes,
      uploadId,
      requiresSplit: false,
    });
    return stored.documentId;
  }

  /**
   * The two names the ledger knows this deduction by.
   *
   * Verbatim, exactly as the ledger returned them (ADR 0025 §4), and skipped
   * where the ledger returned nothing: an empty identifier is not a name, and
   * the column refuses it anyway. `on conflict do nothing` because the pair
   * `(org, source, kind, identifier)` is unique and a re-sync of the same
   * invoice is the normal case — a second insert is not an error, it is the
   * same fact.
   */
  private async insertIdentifiers(
    client: PoolClient,
    deductionId: string,
    orgId: string,
    identifiers: LedgerIdentifiers,
  ): Promise<void> {
    const rows: readonly { kind: IdentifierKind; identifier: string }[] = [
      { kind: 'ledger_invoice_id', identifier: identifiers.ledgerInvoiceId },
      { kind: 'invoice_number', identifier: identifiers.invoiceNumber },
    ];
    for (const row of rows) {
      if (row.identifier.trim() === '') continue;
      await client.query(
        `insert into deduction_identifiers
           (org_id, deduction_id, source, identifier_kind, identifier)
         values ($1, $2, $3, $4, $5)
         on conflict (org_id, source, identifier_kind, identifier) do nothing`,
        [orgId, deductionId, DISCOVERED_FROM_ERP, row.kind, row.identifier],
      );
    }
  }

  /**
   * Records the ledger's names for a deduction we already hold, and nothing
   * else.
   *
   * This is the `exact` branch (ADR 0029 §3): a deduction a notice already
   * found, which the ledger has now named in its own terms. Recording that is a
   * fact worth having — it makes the next sync's match exact rather than
   * probable — and it is the *only* write that branch makes. No case, no
   * decline, no document.
   */
  async ensureIdentifiers(
    deductionId: string,
    orgId: string,
    identifiers: LedgerIdentifiers,
  ): Promise<void> {
    this.assertOwnTenant(orgId);
    await this.withTenant((client) =>
      this.insertIdentifiers(client, deductionId, orgId, identifiers),
    );
  }

  /**
   * A short-pay we are choosing not to open a case for.
   *
   * A discard is not a decision: coverage is a ratio of dollars and it has no
   * numerator without this row (STRATEGY ADD-1). `deduction_id` is null —
   * migration 0014 made it nullable for exactly this, a candidate that never
   * became a case — and `discovered_from` is the literal `erp_sync`, because
   * this class *is* the ERP path.
   *
   * **Idempotent per (org, ledger invoice, version), by a read inside the
   * transaction.** A re-sync must not count the same invoice's dollars twice in
   * the denominator. A partial unique index on
   * `(org_id, (external_ids->>'ledger_invoice_id'), decided_by_version)` would
   * be the stronger answer and is deliberately not added here:
   * `declined_candidates` is append-only and migration-owned, so adding one is
   * migration 0023 and an amendment to ADR 0029 — proposed, not done. What this
   * read does not close is two syncs of the same tenant running concurrently,
   * which is a shape nothing schedules today; the index is what closes it.
   */
  async declineCandidate(input: DeclineCandidateInput): Promise<DeclinedLedgerCandidate> {
    this.assertOwnTenant(input.orgId);
    if (!Number.isSafeInteger(input.estimatedRecoverableCents) ||
        input.estimatedRecoverableCents < 0) {
      throw new DiscoveryStoreError(
        `estimatedRecoverableCents must be non-negative integer cents, got ` +
          String(input.estimatedRecoverableCents),
      );
    }

    const externalIds = {
      ledger_invoice_id: input.identifiers.ledgerInvoiceId,
      invoice_number: input.identifiers.invoiceNumber,
      // Verbatim, and stored rather than resolved (ADR 0030 §7).
      customer_external_id: input.customerExternalId,
      customer_name: input.customerName,
    };

    return this.withTenant(async (client) => {
      const { rows: already } = await client.query<{ id: string }>(
        `select id from declined_candidates
          where org_id = $1
            and decided_by_version = $2
            and external_ids ->> 'ledger_invoice_id' = $3
          order by decided_at asc
          limit 1`,
        [input.orgId, TRIAGE_DECIDED_BY_VERSION, input.identifiers.ledgerInvoiceId],
      );
      const standing = already[0];
      if (standing !== undefined) {
        return {
          declinedCandidateId: standing.id,
          reason: input.reason,
          estimatedRecoverableCents: input.estimatedRecoverableCents,
          written: false,
        };
      }

      const { rows } = await client.query<{ id: string }>(
        `insert into declined_candidates
           (org_id, deduction_id, discovered_from, reason, estimated_recoverable_cents,
            external_ids, decided_by, decided_by_version, missing_evidence, detail)
         values ($1, null, $2, $3, $4, $5::jsonb, $6, $7, '{}', $8)
         returning id`,
        [
          input.orgId,
          DISCOVERED_FROM_ERP,
          input.reason,
          input.estimatedRecoverableCents,
          JSON.stringify(externalIds),
          TRIAGE_DECIDED_BY,
          TRIAGE_DECIDED_BY_VERSION,
          input.detail ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new DiscoveryStoreError('insert into declined_candidates returned no row');
      }
      return {
        declinedCandidateId: row.id,
        reason: input.reason,
        estimatedRecoverableCents: input.estimatedRecoverableCents,
        written: true,
      };
    });
  }

  /**
   * Coverage for this tenant, per month, per channel that found the money
   * (migration 0023, ADR 0030, STRATEGY §2 and ADD-2).
   *
   * Per source and never blended, which is the same rule the eval suites are
   * under and for the same reason: one rate over every channel moves whenever
   * the *mix* moves, so a tenant turning on an ERP sync would read as the
   * product getting better. A caller that wants a tenant total sums these, or
   * reads `coverage_by_period` and knows what it is looking at.
   *
   * The view is `security_invoker`, so this returns what the tenant whose
   * claims are set can see and nothing else — no service role, no
   * cross-tenant read, the same `withTenant` discipline as every other method
   * here.
   *
   * **The ratio comes back from the database.** Every cents column is a bigint
   * read as text and converted once, checked (invariant 3); the division is the
   * view's, rounded there to four places. Dividing two bigints in TypeScript is
   * how integer cents become a float, and this is a money path.
   */
  async coverageByPeriod(orgId: string): Promise<readonly CoveragePeriodRow[]> {
    this.assertOwnTenant(orgId);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        period: string;
        discovered_from: string;
        opened_count: string;
        opened_cents: string;
        filed_count: string;
        filed_cents: string;
        declined_count: string;
        declined_cents: string;
        discovered_cents: string;
        coverage_of_discovered: string | null;
      }>(
        `select to_char(period, 'YYYY-MM-DD') as period,
                discovered_from,
                opened_count::text            as opened_count,
                opened_cents::text            as opened_cents,
                filed_count::text             as filed_count,
                filed_cents::text             as filed_cents,
                declined_count::text          as declined_count,
                declined_cents::text          as declined_cents,
                discovered_cents::text        as discovered_cents,
                coverage_of_discovered::text  as coverage_of_discovered
           from coverage_by_period_by_source
          where org_id = $1
          order by period desc, discovered_from asc`,
        [orgId],
      );
      return rows.map((row) => ({
        orgId,
        period: row.period,
        discoveredFrom: row.discovered_from,
        openedCount: exactCentsOrThrow(row.opened_count, 'opened_count'),
        openedCents: exactCentsOrThrow(row.opened_cents, 'opened_cents'),
        filedCount: exactCentsOrThrow(row.filed_count, 'filed_count'),
        filedCents: exactCentsOrThrow(row.filed_cents, 'filed_cents'),
        declinedCount: exactCentsOrThrow(row.declined_count, 'declined_count'),
        declinedCents: exactCentsOrThrow(row.declined_cents, 'declined_cents'),
        discoveredCents: exactCentsOrThrow(row.discovered_cents, 'discovered_cents'),
        ...(row.coverage_of_discovered !== null
          ? { coverageOfDiscovered: ratio(row.coverage_of_discovered) }
          : { coverageOfDiscovered: undefined }),
      }));
    });
  }

  /**
   * The org a caller names has to be the org this store acts as.
   *
   * RLS would refuse the write anyway — `tenant_insert` checks the org claim —
   * but it would refuse it as an empty result or a policy violation somewhere
   * downstream. A mismatch here is a programming error and says so.
   */
  private assertOwnTenant(orgId: string): void {
    if (orgId !== this.tenant.orgId) {
      throw new DiscoveryStoreError(
        `this store acts for org ${this.tenant.orgId}, asked about ${orgId}`,
      );
    }
  }
}

/**
 * A bigint column as a safe integer, or a loud refusal.
 *
 * `workflow.exactCents` does the same job for the workflow's reads; it is not
 * imported here because it raises a `CaseWorkflowError`, and a ledger sync is
 * not a case workflow — a refusal that claimed to be one would be caught by a
 * route that has nothing to do with this.
 */
/**
 * The view's ratio, as a number, or a loud refusal.
 *
 * A `numeric` arrives as text. This parses it and never computes it: the
 * division that produced it happened in the database, over bigint cents, and
 * recomputing it here from two columns is exactly the float arithmetic
 * invariant 3 exists to keep off a money path.
 */
function ratio(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new DiscoveryStoreError(`coverage_of_discovered is not a number: ${JSON.stringify(text)}`);
  }
  return value;
}

function exactCentsOrThrow(text: string, column: string): number {
  if (!/^-?\d+$/.test(text)) {
    throw new DiscoveryStoreError(`${column} is not an integer: ${JSON.stringify(text)}`);
  }
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DiscoveryStoreError(`${column} is outside the safe integer range: ${text}`);
  }
  return Number(value);
}
