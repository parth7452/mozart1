/**
 * The store half of posting a deduction's accounting to QuickBooks (ADR 0060).
 *
 * Every write here is made as `app_rw` with the caller's claims, and the
 * database is the referee: a map is inserted only by an owner, the switch is
 * turned on only by an owner and only while a map exists, a `writebacks` or
 * `writeoffs` row exists only under an `approvals` row for its decision, and a
 * succeeded posting is final. This file adds the checks only it can make: the
 * account types a map names (read live by the caller), the amounts a row
 * carries (from `draftEntries` and nothing else), and that a write-off equals
 * the entry's expense debit.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  REASON_FAMILIES,
  draftEntries,
  familyOf,
  isCanonicalReasonCode,
  sumCents,
  cents,
  type Cents,
  type ReasonFamily,
} from '@recouple/core-domain';
import {
  assertQboId,
  entryLines,
  settlementStages,
  type LedgerAccountMap,
  type PostingLine,
} from '@recouple/qbo';
import { OwnerRequiredError } from './connections';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';
import { HUMAN_MODEL_VERSION, HUMAN_PROVIDER, HUMAN_SCHEMA_ID } from './workflow';

/** A settlement decision's schema (ADR 0060 §2, moment 2). */
export const SETTLEMENT_SCHEMA_ID = 'S';
export const SETTLEMENT_SCHEMA_VERSION = 'settlement-1';

export const SETTLEMENT_OUTCOMES = ['won', 'partial', 'lost', 'declined'] as const;
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

export const WRITEBACK_METHODS = ['journal_entry', 'payment_application'] as const;
export type WritebackMethod = (typeof WRITEBACK_METHODS)[number];

/** The QuickBooks `AccountType`s each role of a map must have (ADR 0060 §4). */
export const MAP_ACCOUNT_TYPES = {
  ar: ['Accounts Receivable'],
  deductionsReceivable: ['Other Current Asset'],
  writeoff: ['Expense', 'Other Expense'],
} as const;

/** Reads each account's `AccountType` live; an id QuickBooks lacks is absent. */
export type AccountTypeReader = (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;

export class PostingStoreError extends Error {}

export class AccountMapTypeError extends PostingStoreError {
  override readonly name = 'AccountMapTypeError';
  constructor(readonly fields: readonly string[]) {
    super(`the account map names accounts of the wrong type or none: ${fields.join(', ')}`);
  }
}

export class AccountMapRequiredError extends PostingStoreError {
  override readonly name = 'AccountMapRequiredError';
  constructor(readonly connectionId: string) {
    super(`connection ${connectionId} has no account map in force`);
  }
}

export class PostingConnectionNotFoundError extends PostingStoreError {
  override readonly name = 'PostingConnectionNotFoundError';
  constructor(readonly connectionId: string) {
    super(`connection ${connectionId} is not this tenant's`);
  }
}

export class PostingDecisionError extends PostingStoreError {
  override readonly name = 'PostingDecisionError';
}

export class WritebackNotApprovedError extends PostingStoreError {
  override readonly name = 'WritebackNotApprovedError';
  constructor(readonly decisionId: string, readonly action: 'writeback' | 'writeoff') {
    super(`decision ${decisionId} has no ${action} approval`);
  }
}

export class WritebackExistsError extends PostingStoreError {
  override readonly name = 'WritebackExistsError';
  constructor(readonly decisionId: string, readonly method: WritebackMethod) {
    super(`decision ${decisionId} already has a ${method} writeback`);
  }
}

export class WriteoffAmountMismatchError extends PostingStoreError {
  override readonly name = 'WriteoffAmountMismatchError';
  constructor(readonly decisionId: string, readonly expected: Cents, readonly given: Cents) {
    super(`a write-off for decision ${decisionId} must be ${expected} cents, the entry's expense debit; got ${given}`);
  }
}

export class WritebackNotFoundError extends PostingStoreError {
  override readonly name = 'WritebackNotFoundError';
  constructor(readonly writebackId: string) {
    super(`writeback ${writebackId} is not this tenant's`);
  }
}

/** A settlement decision's `result` (ADR 0060 §2). */
export interface SettlementResult {
  readonly outcome: SettlementOutcome;
  readonly recovered_cents: number;
  readonly family: ReasonFamily | null;
  readonly invoice_id: string;
  readonly payment_id?: string;
}

/** Everything the posting job needs about one row, ids and cents only. */
export interface WritebackToPost {
  readonly writebackId: string;
  readonly deductionId: string;
  readonly decisionId: string;
  readonly schemaId: 'B' | 'S';
  readonly method: WritebackMethod;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly qboTxnId: string | undefined;
  readonly connectionId: string;
  readonly realmId: string;
  readonly postingEnabled: boolean;
  readonly amountCents: Cents;
  readonly lines: readonly PostingLine[] | undefined;
  readonly caseAmountCents: Cents;
  readonly family: ReasonFamily | undefined;
  readonly outcome: SettlementOutcome | undefined;
  readonly recoveredCents: Cents | undefined;
  readonly invoiceId: string | undefined;
  /** The writeback approval's day, UTC, `YYYY-MM-DD`. */
  readonly approvedOn: string;
  readonly map: LedgerAccountMap;
  /** For a payment: the same decision's journal entry, when it succeeded. */
  readonly journalEntryId: string | undefined;
}

export interface WritebackAttempt {
  readonly writebackId: string;
  readonly status: 'succeeded' | 'failed';
  readonly qboTxnId?: string;
  /** A constant: `sent`, `readback_mismatch`, `send_failed`, `unknown_outcome`. */
  readonly reason?: string;
  readonly httpStatus?: number;
  readonly faultCode?: string;
  readonly mismatch?: readonly string[];
}

interface MapRow {
  id: string;
  ar_account_id: string;
  deductions_receivable_account_id: string;
  writeoff_by_family: Record<string, string>;
  unclassified_writeoff: string;
}

function toMap(row: MapRow): LedgerAccountMap {
  return {
    arAccountId: row.ar_account_id,
    deductionsReceivableAccountId: row.deductions_receivable_account_id,
    writeoffByFamily: row.writeoff_by_family as Record<ReasonFamily, string>,
    unclassifiedWriteoff: row.unclassified_writeoff,
  };
}

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function exact(text: string, what: string): Cents {
  if (!/^-?\d+$/.test(text)) throw new Error(`${what} is not integer cents`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${what} is past a safe integer`);
  return cents(value);
}

interface DecisionFacts {
  readonly decisionId: string;
  readonly deductionId: string;
  readonly schemaId: 'B' | 'S';
  readonly caseAmountCents: Cents;
  readonly family: ReasonFamily | undefined;
  readonly outcome: SettlementOutcome | undefined;
  readonly recoveredCents: Cents | undefined;
  readonly invoiceId: string | undefined;
}

export class PostgresPostingStore {
  private readonly pool: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
  }

  /** As `PostgresStore.withTenant`: role and claims transaction-local. */
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

  async memberMayWrite(): Promise<boolean> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ ok: boolean }>('select app.member_may_write() as ok');
      return rows[0]?.ok === true;
    });
  }

  /**
   * Saves a new map for a connection, after checking each account's type as
   * QuickBooks reports it now. We never create an account. Owner only — the
   * database's rule; its refusal is `OwnerRequiredError`.
   */
  async saveAccountMap(
    connectionId: string,
    map: LedgerAccountMap,
    readAccountTypes: AccountTypeReader,
  ): Promise<{ readonly mapId: string }> {
    const roles: Array<[string, string, readonly string[]]> = [
      ['ar_account_id', map.arAccountId, MAP_ACCOUNT_TYPES.ar],
      ['deductions_receivable_account_id', map.deductionsReceivableAccountId, MAP_ACCOUNT_TYPES.deductionsReceivable],
      ...REASON_FAMILIES.map(
        (family): [string, string, readonly string[]] => [
          `writeoff_by_family.${family}`,
          map.writeoffByFamily[family],
          MAP_ACCOUNT_TYPES.writeoff,
        ],
      ),
      ['unclassified_writeoff', map.unclassifiedWriteoff, MAP_ACCOUNT_TYPES.writeoff],
    ];
    const bad: string[] = [];
    for (const [field, id] of roles) {
      try {
        assertQboId(id);
      } catch {
        bad.push(field);
      }
    }
    if (bad.length > 0) throw new AccountMapTypeError(bad);

    const types = await readAccountTypes([...new Set(roles.map(([, id]) => id))]);
    for (const [field, id, allowed] of roles) {
      const type = types.get(id);
      if (type === undefined || !allowed.includes(type)) bad.push(field);
    }
    if (bad.length > 0) throw new AccountMapTypeError(bad);

    return this.withTenant(async (client) => {
      await this.connectionRow(client, connectionId);
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into ledger_account_maps
             (org_id, connection_id, ar_account_id, deductions_receivable_account_id,
              writeoff_by_family, unclassified_writeoff, created_by)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7)
           returning id`,
          [
            this.tenant.orgId,
            connectionId,
            map.arAccountId,
            map.deductionsReceivableAccountId,
            JSON.stringify(map.writeoffByFamily),
            map.unclassifiedWriteoff,
            this.tenant.userId,
          ],
        );
        const mapId = rows[0]?.id;
        if (mapId === undefined) throw new Error('insert into ledger_account_maps returned no row');
        await this.audit(client, 'accounting_connection.account_map_saved', connectionId, {
          map_id: mapId,
        });
        return { mapId };
      } catch (error) {
        throw this.ownerRefusal(error);
      }
    });
  }

  /** Turns posting on or off for a connection; one audit row per change. */
  async setPostingEnabled(connectionId: string, enabled: boolean): Promise<void> {
    await this.withTenant(async (client) => {
      const current = await this.connectionRow(client, connectionId);
      if (current.posting_enabled === enabled) return;
      try {
        const updated = await client.query(
          `update accounting_connections set posting_enabled = $2 where id = $1`,
          [connectionId, enabled],
        );
        // RLS lets a non-owner see the row and update none of it.
        if (updated.rowCount !== 1) {
          throw new OwnerRequiredError(this.tenant.orgId, this.tenant.userId);
        }
      } catch (error) {
        if (sqlState(error) === '23514') throw new AccountMapRequiredError(connectionId);
        throw this.ownerRefusal(error);
      }
      await this.audit(
        client,
        enabled ? 'accounting_connection.posting_enabled' : 'accounting_connection.posting_disabled',
        connectionId,
        {},
      );
    });
  }

  /** The map that was latest for a connection at `approvedAt`. */
  async mapAtApproval(
    connectionId: string,
    approvedAt: Date,
  ): Promise<(LedgerAccountMap & { readonly mapId: string }) | undefined> {
    return this.withTenant(async (client) => {
      const row = await readMapAt(client, connectionId, approvedAt);
      return row === undefined ? undefined : { ...toMap(row), mapId: row.id };
    });
  }

  /**
   * Moment 2's decision (ADR 0060 §2): a human `S` decision naming the
   * outcome, what was recovered, the family and the invoice picked from a live
   * read. Checked against `draftEntries` before it is written.
   */
  async prepareSettlementDecision(input: {
    readonly deductionId: string;
    readonly preparedBy: string;
    readonly outcome: SettlementOutcome;
    readonly recoveredCents: Cents;
    readonly family: ReasonFamily | undefined;
    readonly invoiceId: string;
    readonly paymentId?: string;
  }): Promise<{ readonly decisionId: string }> {
    if (input.preparedBy !== this.tenant.userId) {
      throw new PostingDecisionError('a settlement decision is prepared by the caller');
    }
    if (!SETTLEMENT_OUTCOMES.includes(input.outcome)) {
      throw new PostingDecisionError(`unknown outcome ${String(input.outcome)}`);
    }
    if (input.family !== undefined && !REASON_FAMILIES.includes(input.family)) {
      throw new PostingDecisionError(`unknown reason family ${String(input.family)}`);
    }
    const invoiceId = assertQboId(input.invoiceId);
    const paymentId = input.paymentId === undefined ? undefined : assertQboId(input.paymentId);

    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ amount: string }>(
        `select deduction_amount_cents::text as amount from deductions where id = $1 for update`,
        [input.deductionId],
      );
      const found = rows[0];
      if (found === undefined) {
        throw new PostingDecisionError(`case ${input.deductionId} is not this tenant's`);
      }
      // Refuses what the books could not hold: more recovered than deducted,
      // a lost case that recovered something, a won case short of the whole.
      draftEntries({
        amountCents: exact(found.amount, 'deduction_amount_cents'),
        recoveredCents: input.recoveredCents,
        outcome: input.outcome,
        family: input.family,
      });
      const result: SettlementResult = {
        outcome: input.outcome,
        recovered_cents: input.recoveredCents,
        family: input.family ?? null,
        invoice_id: invoiceId,
        ...(paymentId !== undefined ? { payment_id: paymentId } : {}),
      };
      const stateHash = createHash('sha256')
        .update(JSON.stringify({ deduction: input.deductionId, amount: found.amount, result }))
        .digest();
      const inserted = await client.query<{ id: string }>(
        `insert into decisions
           (org_id, deduction_id, schema_id, schema_version, provider, model_version,
            input_state_hash, questions, result, raw_probabilities, confidence,
            latency_ms, cost_micros, prepared_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, '{}'::jsonb,
                 1.0000, 0, 0, $10)
         returning id`,
        [
          this.tenant.orgId,
          input.deductionId,
          SETTLEMENT_SCHEMA_ID,
          SETTLEMENT_SCHEMA_VERSION,
          HUMAN_PROVIDER,
          HUMAN_MODEL_VERSION,
          stateHash,
          JSON.stringify({
            outcome: 'choice',
            recovered_cents: 'cents',
            family: 'choice',
            invoice_id: 'ledger_id',
            payment_id: 'ledger_id',
          }),
          JSON.stringify(result),
          input.preparedBy,
        ],
      );
      const decisionId = inserted.rows[0]?.id;
      if (decisionId === undefined) throw new Error('insert into decisions returned no row');
      await appendEvent(client, this.tenant, input.deductionId, 'settlement.prepared', {
        decision_id: decisionId,
        schema_id: SETTLEMENT_SCHEMA_ID,
        outcome: input.outcome,
        recovered_cents: input.recoveredCents,
        prepared_by: input.preparedBy,
      });
      return { decisionId };
    });
  }

  /**
   * The `writebacks` row for one entity, inserted `pending` with
   * `request_id` = its own id before anything is sent. Its lines and amount
   * come from `draftEntries` and the map latest at the writeback approval; a
   * second press is refused by `unique (decision_id, method)`.
   */
  async insertWriteback(input: {
    readonly decisionId: string;
    readonly method: WritebackMethod;
    readonly connectionId: string;
  }): Promise<{ readonly writebackId: string }> {
    if (!WRITEBACK_METHODS.includes(input.method)) {
      throw new PostingDecisionError(`unknown writeback method ${String(input.method)}`);
    }
    return this.withTenant(async (client) => {
      await this.connectionRow(client, input.connectionId);
      const facts = await readDecisionFacts(client, input.decisionId);
      const approvedAt = await approvalAt(client, input.decisionId, 'writeback');
      const mapRow = await readMapAt(client, input.connectionId, approvedAt);
      if (mapRow === undefined) throw new AccountMapRequiredError(input.connectionId);
      const map = toMap(mapRow);

      let lines: readonly PostingLine[] | null = null;
      let amount: Cents;
      if (input.method === 'journal_entry') {
        lines = linesFor(facts, map);
        amount = sumCents(lines.filter((l) => l.side === 'Debit').map((l) => l.amountCents));
      } else {
        if (facts.schemaId === SETTLEMENT_SCHEMA_ID && facts.outcome !== 'declined') {
          // Applying the payer's existing Payment is an update with its
          // SyncToken, which this build has no client method for.
          throw new PostingDecisionError(
            'only a found posting or a declined settlement applies a zero payment',
          );
        }
        if (facts.invoiceId === undefined) {
          throw new PostingDecisionError(`decision ${input.decisionId} names no ledger invoice`);
        }
        amount = facts.caseAmountCents;
      }

      const writebackId = randomUUID();
      try {
        await client.query(
          `insert into writebacks
             (id, org_id, deduction_id, decision_id, method, status, request_id,
              connection_id, account_map_id, amount_cents, lines)
           values ($1::uuid, $2, $3, $4, $5, 'pending', $1::text, $6, $7, $8, $9::jsonb)`,
          [
            writebackId,
            this.tenant.orgId,
            facts.deductionId,
            input.decisionId,
            input.method,
            input.connectionId,
            mapRow.id,
            amount,
            lines === null ? null : JSON.stringify(lines),
          ],
        );
      } catch (error) {
        if (sqlState(error) === '23505') throw new WritebackExistsError(input.decisionId, input.method);
        throw error;
      }
      await appendEvent(client, this.tenant, facts.deductionId, 'writeback.queued', {
        writeback_id: writebackId,
        decision_id: input.decisionId,
        method: input.method,
        connection_id: input.connectionId,
        account_map_id: mapRow.id,
        amount_cents: amount,
      });
      return { writebackId };
    });
  }

  /**
   * The `writeoffs` row a settlement's write-off needs. Refused unless its
   * amount is exactly the entry's expense debit.
   */
  async insertWriteoff(input: {
    readonly decisionId: string;
    readonly amountCents: Cents;
  }): Promise<{ readonly writeoffId: string }> {
    return this.withTenant(async (client) => {
      const facts = await readDecisionFacts(client, input.decisionId);
      if (facts.schemaId !== SETTLEMENT_SCHEMA_ID) {
        throw new PostingDecisionError('a write-off follows a settlement decision');
      }
      const expected = expenseDebit(facts);
      if (expected !== input.amountCents) {
        throw new WriteoffAmountMismatchError(input.decisionId, expected, input.amountCents);
      }
      await approvalAt(client, input.decisionId, 'writeoff');
      const { rows } = await client.query<{ id: string }>(
        `insert into writeoffs (org_id, deduction_id, decision_id, amount_cents)
         values ($1, $2, $3, $4) returning id`,
        [this.tenant.orgId, facts.deductionId, input.decisionId, input.amountCents],
      );
      const writeoffId = rows[0]?.id;
      if (writeoffId === undefined) throw new Error('insert into writeoffs returned no row');
      return { writeoffId };
    });
  }

  /** One `deduction_events` row per attempt, and `status` as its projection. */
  async recordWritebackAttempt(attempt: WritebackAttempt): Promise<void> {
    await this.withTenant(async (client) => {
      const { rows } = await client.query<{ deduction_id: string }>(
        `select deduction_id from writebacks where id = $1`,
        [attempt.writebackId],
      );
      const row = rows[0];
      if (row === undefined) throw new WritebackNotFoundError(attempt.writebackId);
      await appendEvent(client, this.tenant, row.deduction_id, 'writeback.attempted', {
        writeback_id: attempt.writebackId,
        status: attempt.status,
        ...(attempt.qboTxnId !== undefined ? { qbo_txn_id: attempt.qboTxnId } : {}),
        ...(attempt.reason !== undefined ? { reason: attempt.reason } : {}),
        ...(attempt.httpStatus !== undefined ? { http_status: attempt.httpStatus } : {}),
        ...(attempt.faultCode !== undefined ? { fault_code: attempt.faultCode } : {}),
        ...(attempt.mismatch !== undefined ? { mismatch: attempt.mismatch } : {}),
      });
      await client.query(
        `update writebacks set status = $2, qbo_txn_id = coalesce(qbo_txn_id, $3) where id = $1`,
        [attempt.writebackId, attempt.status, attempt.qboTxnId ?? null],
      );
    });
  }

  /** What the posting job reads about one row before it builds a request. */
  async writebackForPosting(writebackId: string): Promise<WritebackToPost | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        decision_id: string;
        method: WritebackMethod;
        status: 'pending' | 'succeeded' | 'failed';
        qbo_txn_id: string | null;
        connection_id: string | null;
        account_map_id: string | null;
        amount_cents: string | null;
        lines: PostingLine[] | null;
        realm_id: string | null;
        posting_enabled: boolean | null;
      }>(
        `select w.id, w.decision_id, w.method, w.status, w.qbo_txn_id, w.connection_id,
                w.account_map_id, w.amount_cents::text as amount_cents, w.lines,
                c.provider_account_id as realm_id, c.posting_enabled
           from writebacks w
           left join accounting_connections c on c.id = w.connection_id
          where w.id = $1`,
        [writebackId],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      if (
        row.connection_id === null ||
        row.account_map_id === null ||
        row.amount_cents === null ||
        row.realm_id === null ||
        !WRITEBACK_METHODS.includes(row.method)
      ) {
        throw new PostingDecisionError(`writeback ${writebackId} was not written by ADR 0060's store`);
      }
      const facts = await readDecisionFacts(client, row.decision_id);
      const approvedAt = await approvalAt(client, row.decision_id, 'writeback');
      const maps = await client.query<MapRow>(
        `select id, ar_account_id, deductions_receivable_account_id, writeoff_by_family,
                unclassified_writeoff
           from ledger_account_maps where id = $1`,
        [row.account_map_id],
      );
      const mapRow = maps.rows[0];
      if (mapRow === undefined) throw new AccountMapRequiredError(row.connection_id);
      const entry = await client.query<{ qbo_txn_id: string | null }>(
        `select qbo_txn_id from writebacks
          where decision_id = $1 and method = 'journal_entry' and status = 'succeeded'`,
        [row.decision_id],
      );
      return {
        writebackId: row.id,
        deductionId: facts.deductionId,
        decisionId: row.decision_id,
        schemaId: facts.schemaId,
        method: row.method,
        status: row.status,
        qboTxnId: row.qbo_txn_id ?? undefined,
        connectionId: row.connection_id,
        realmId: row.realm_id,
        postingEnabled: row.posting_enabled === true,
        amountCents: exact(row.amount_cents, 'amount_cents'),
        lines: row.lines ?? undefined,
        caseAmountCents: facts.caseAmountCents,
        family: facts.family,
        outcome: facts.outcome,
        recoveredCents: facts.recoveredCents,
        invoiceId: facts.invoiceId,
        approvedOn: approvedAt.toISOString().slice(0, 10),
        map: toMap(mapRow),
        journalEntryId: entry.rows[0]?.qbo_txn_id ?? undefined,
      };
    });
  }

  private async connectionRow(
    client: PoolClient,
    connectionId: string,
  ): Promise<{ posting_enabled: boolean }> {
    const { rows } = await client.query<{ posting_enabled: boolean }>(
      `select posting_enabled from accounting_connections where id = $1`,
      [connectionId],
    );
    const row = rows[0];
    if (row === undefined) throw new PostingConnectionNotFoundError(connectionId);
    return row;
  }

  private async audit(
    client: PoolClient,
    action: string,
    connectionId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
       values ($1, $2, $3, 'accounting_connections', $4, $5::jsonb)`,
      [this.tenant.orgId, this.tenant.userId, action, connectionId, JSON.stringify(payload)],
    );
  }

  private ownerRefusal(error: unknown): unknown {
    return sqlState(error) === '42501'
      ? new OwnerRequiredError(this.tenant.orgId, this.tenant.userId)
      : error;
  }
}

async function appendEvent(
  client: PoolClient,
  tenant: TenantContext,
  deductionId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into deduction_events
       (org_id, deduction_id, event_type, payload, event_time, created_by)
     values ($1, $2, $3, $4::jsonb, now(), $5)`,
    [tenant.orgId, deductionId, eventType, JSON.stringify(payload), tenant.userId],
  );
}

async function readMapAt(
  client: PoolClient,
  connectionId: string,
  approvedAt: Date,
): Promise<MapRow | undefined> {
  const { rows } = await client.query<MapRow>(
    `select id, ar_account_id, deductions_receivable_account_id, writeoff_by_family,
            unclassified_writeoff
       from ledger_account_maps
      where connection_id = $1 and created_at <= $2
      order by seq desc
      limit 1`,
    [connectionId, approvedAt],
  );
  return rows[0];
}

async function approvalAt(
  client: PoolClient,
  decisionId: string,
  action: 'writeback' | 'writeoff',
): Promise<Date> {
  const { rows } = await client.query<{ approved_at: Date }>(
    `select approved_at from approvals where decision_id = $1 and action_type = $2
      order by approved_at asc limit 1`,
    [decisionId, action],
  );
  const row = rows[0];
  if (row === undefined) throw new WritebackNotApprovedError(decisionId, action);
  return new Date(row.approved_at);
}

async function readDecisionFacts(client: PoolClient, decisionId: string): Promise<DecisionFacts> {
  const { rows } = await client.query<{
    id: string;
    deduction_id: string;
    schema_id: string;
    provider: string;
    result: Record<string, unknown>;
    amount: string;
    ledger_invoice_id: string | null;
  }>(
    `select d.id, d.deduction_id, d.schema_id, d.provider, d.result,
            c.deduction_amount_cents::text as amount,
            (select i.identifier from deduction_identifiers i
              where i.deduction_id = d.deduction_id and i.identifier_kind = 'ledger_invoice_id'
              order by i.identifier limit 1) as ledger_invoice_id
       from decisions d join deductions c on c.id = d.deduction_id
      where d.id = $1`,
    [decisionId],
  );
  const row = rows[0];
  if (row === undefined) throw new PostingDecisionError(`decision ${decisionId} is not this tenant's`);
  if (row.provider !== HUMAN_PROVIDER) {
    throw new PostingDecisionError(`decision ${decisionId} is not a person's`);
  }
  const caseAmountCents = exact(row.amount, 'deduction_amount_cents');
  if (row.schema_id === HUMAN_SCHEMA_ID) {
    const reason = row.result['dispute_reason'];
    return {
      decisionId,
      deductionId: row.deduction_id,
      schemaId: 'B',
      caseAmountCents,
      family: typeof reason === 'string' && isCanonicalReasonCode(reason) ? familyOf(reason) : undefined,
      outcome: undefined,
      recoveredCents: undefined,
      invoiceId: row.ledger_invoice_id ?? undefined,
    };
  }
  if (row.schema_id === SETTLEMENT_SCHEMA_ID) {
    const result = row.result as unknown as SettlementResult;
    return {
      decisionId,
      deductionId: row.deduction_id,
      schemaId: 'S',
      caseAmountCents,
      family: result.family ?? undefined,
      outcome: result.outcome,
      recoveredCents: cents(result.recovered_cents),
      invoiceId: result.invoice_id,
    };
  }
  throw new PostingDecisionError(`decision ${decisionId} is schema ${row.schema_id}; nothing posts it`);
}

function draftsFor(facts: DecisionFacts) {
  return draftEntries({
    amountCents: facts.caseAmountCents,
    recoveredCents: facts.recoveredCents,
    outcome: facts.outcome,
    family: facts.family,
  });
}

/** The lines a decision's journal entry posts: found for B, the settlement for S. */
export function linesFor(facts: Pick<DecisionFacts, 'schemaId' | 'caseAmountCents' | 'family' | 'outcome' | 'recoveredCents'>, map: LedgerAccountMap): readonly PostingLine[] {
  const entries = draftsFor(facts as DecisionFacts);
  return facts.schemaId === 'B'
    ? entryLines(entries, map, ['found'])
    : entryLines(entries, map, settlementStages(facts.outcome === 'declined'));
}

function expenseDebit(facts: DecisionFacts): Cents {
  const entries = draftsFor(facts);
  return sumCents(
    entries
      .filter((entry) => entry.stage === 'written_off')
      .flatMap((entry) => entry.lines)
      .filter((line) => line.role === 'writeoff_expense')
      .map((line) => line.debit),
  );
}
