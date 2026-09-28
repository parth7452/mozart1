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
  SETUP_ROWS,
  assertQboId,
  entryLines,
  postingSetupRequestId,
  settlementStages,
  type AccountReadBackField,
  type LedgerAccountMap,
  type PostingLine,
  type SetupRow,
} from '@recouple/qbo';
import { OwnerRequiredError } from './connections';
import {
  isPoolConnectTimeout,
  sessionPool,
  setupClaimPool,
  type PostgresStoreConfig,
  type TenantContext,
} from './store';
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

/** A settlement approval refused by the database's separation of duties. */
export class SettlementApprovalRefusedError extends PostingStoreError {
  override readonly name = 'SettlementApprovalRefusedError';
  constructor(
    readonly decisionId: string,
    readonly reason: 'preparer' | 'role' | 'duplicate',
  ) {
    super(`settlement approval refused for decision ${decisionId}: ${reason}`);
  }
}

export interface PostingConnectionView {
  readonly connectionId: string;
  readonly realmId: string;
  readonly postingEnabled: boolean;
  readonly map: (LedgerAccountMap & { readonly mapId: string }) | undefined;
}

/**
 * The advisory-lock seed for a setup press's claim on its connection
 * (ADR 0063 §2). Seed 0 is `withDocumentRead`'s and migration 0004's hash
 * chains', 1 the invoice claim's (ADR 0028), 2 a company's refresh lock (ADR
 * 0039 §5), 3 an inbound email's claim (ADR 0047 §10), 4 migration 0035's team
 * locks. Not 2 above all: a press's own QuickBooks calls take the company's
 * refresh lock when a token needs refreshing, and a press holding it would
 * wait on itself.
 */
export const POSTING_SETUP_LOCK_SEED = 5;

/**
 * A setup press's claim on its connection: held while its work ran, or not had
 * at all — another press holds it (`held`), or no connection to hold it on was
 * free within `SETUP_CLAIM_CONNECT_TIMEOUT_MS` (`no_connection`).
 */
export type PostingSetupClaim<T> =
  | { readonly held: false; readonly reason: 'held' | 'no_connection' }
  | { readonly held: true; readonly result: T };

/**
 * A setup row whose latest create has no answer on the record (ADR 0063 §2),
 * and the request id that create went out under: what a later press that
 * finds the account records it as found for.
 */
export interface UnansweredAccountCreate {
  readonly row: SetupRow;
  readonly requestId: string;
}

/** Every QuickBooks account a setup press recorded for each row: created, or found. */
export type RecordedSetupAccounts = Readonly<Record<SetupRow, readonly string[]>>;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QBO_ACCOUNT_ID = /^\d{1,20}$/;

/**
 * What a read-back compares (ADR 0063 §2), as the closed set the store checks
 * a caller against. `satisfies` keeps it `AccountReadBackField`'s own set: a
 * field added there fails to compile here until it is admitted.
 */
const READ_BACK_FIELDS = {
  Id: true,
  Name: true,
  AccountType: true,
  Active: true,
} as const satisfies Record<AccountReadBackField, true>;

export interface CaseWriteback {
  readonly writebackId: string;
  readonly decisionId: string;
  readonly connectionId: string | undefined;
  readonly method: WritebackMethod;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly qboTxnId: string | undefined;
  readonly amountCents: Cents | undefined;
}

export interface CasePosting {
  readonly connection:
    | { readonly connectionId: string; readonly postingEnabled: boolean; readonly hasMap: boolean }
    | undefined;
  readonly ledgerInvoiceId: string | undefined;
  readonly writebacks: readonly CaseWriteback[];
  readonly settlement:
    | {
        readonly decisionId: string;
        readonly preparedBy: string;
        readonly outcome: SettlementOutcome;
        readonly recoveredCents: Cents;
        readonly invoiceId: string;
        readonly approved: boolean;
      }
    | undefined;
}

function settlementApprovalRefusal(error: unknown, decisionId: string, approverId: string): unknown {
  const state = sqlState(error);
  const text = error instanceof Error ? error.message : '';
  if (state === '23505') return new SettlementApprovalRefusedError(decisionId, 'duplicate');
  if (state === '23001' && /cannot approve their own decision/.test(text)) {
    return new SettlementApprovalRefusedError(decisionId, 'preparer');
  }
  if (state === '23001' && /is not an approver/.test(text)) {
    return new SettlementApprovalRefusedError(decisionId, 'role');
  }
  void approverId;
  return error;
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
  /**
   * Where a setup press's claim is held: its own pool (`setupClaimPool`) —
   * never the working pool, and never the lock pool, which the press's own
   * token refresh borrows from while the claim is held (`PoolPurpose`).
   */
  private readonly claimPool: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
  ) {
    this.pool = sessionPool(config);
    this.claimPool = setupClaimPool(config);
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
   * Whether the caller is an owner here, asked of the database
   * (`app.member_is_owner()`), so a setup press is refused before it reads or
   * creates anything in QuickBooks (ADR 0063 §2). Every write after it asks
   * again in its own way; this is only the first, and the earliest.
   */
  async memberIsOwner(): Promise<boolean> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ owner: boolean }>('select app.member_is_owner() as owner');
      return rows[0]?.owner === true;
    });
  }

  /**
   * Holds this connection's setup claim while `work` runs, so two presses of
   * Turn on posting — a double click, two owners at once — never plan, create
   * and save for one connection together (ADR 0063 §2). Without it both pass
   * the no-map check and plan the same creates, and the audit log and the
   * owner's notice end up saying what the other press did.
   *
   * `withDocumentRead`'s shape, for its reasons: a transaction-scoped try-lock
   * (`DATABASE_URL` is the transaction pooler), the role and claims set
   * transaction-locally, and the commit after `work` — which writes on the
   * working pool — what releases it, whichever way `work` ended. `try` and not
   * the waiting form: the press that does not get it is told at once and does
   * nothing, rather than holding a request for the length of the other
   * press's QuickBooks calls to find a map saved at the end of it.
   *
   * On a pool of its own (`setupClaimPool`), not the lock pool `withDocumentRead`
   * holds its claims on: a press holds this for minutes, across QuickBooks
   * calls whose token refresh takes a lock-pool connection of its own, and one
   * pool for both is a press waiting on itself while document reads wait on
   * it. A press that gets no connection within `SETUP_CLAIM_CONNECT_TIMEOUT_MS`
   * is `no_connection`, having done nothing; one that could not be opened at
   * all is thrown as it came.
   *
   * Keyed on the connection id, with `POSTING_SETUP_LOCK_SEED`.
   */
  async withSetupClaim<T>(
    connectionId: string,
    work: () => Promise<T>,
  ): Promise<PostingSetupClaim<T>> {
    let client: PoolClient;
    try {
      client = await this.claimPool.connect();
    } catch (error) {
      if (isPoolConnectTimeout(error)) return { held: false, reason: 'no_connection' };
      throw error;
    }
    // Destroyed rather than pooled after any failure, as `withDocumentRead`'s
    // is: an aborted transaction would fail the next borrower's first statement.
    let failed: Error | undefined;
    try {
      await client.query('begin');
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
      ]);
      const { rows } = await client.query<{ held: boolean | null }>(
        'select pg_try_advisory_xact_lock(hashtextextended($1, $2)) as held',
        [connectionId, POSTING_SETUP_LOCK_SEED],
      );
      // `=== true` rather than truthiness: anything else is not a lock.
      if (rows[0]?.held !== true) {
        await client.query('rollback');
        return { held: false, reason: 'held' };
      }
      const result = await work();
      await client.query('commit');
      return { held: true, result };
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release(failed);
    }
  }

  /**
   * Records, before anything is sent, that an owner's setup press is asking
   * QuickBooks for one of the two accounts ADR 0063 admits: one
   * `accounting_connection.account_create_requested` row naming the
   * connection, its realm, the row, and the request id the create goes out
   * with. ADR 0060 §3's discipline for a write-back, applied to an account:
   * when QuickBooks' answer never arrives — a timeout, a 5xx, a read-back that
   * could not be made — the audit log still says this press asked, when and as
   * whom, under the request id Intuit holds. One row per create a press
   * attempts: it records the asking, whether or not QuickBooks was then
   * reached. What answers it is a later `recordAccountCreated`, or
   * `recordAccountFound`.
   *
   * The request id is derived here and never passed in, and returned for the
   * create to go out with: `postingSetupRequestId` of this attempt, which is
   * the number of answers this row already has. So a create sent again after
   * one no answer came for is the same request to Intuit, and a create after
   * an answered one is a new request, which Intuit cannot answer with the
   * account the answered one made.
   *
   * Owner only, asked of the database in this row's own transaction: the last
   * check before a write to a customer's books.
   */
  async recordAccountCreateRequested(connectionId: string, row: SetupRow): Promise<string> {
    assertSetupRow(row);
    return this.withOwner(async (client) => {
      const connection = await this.connectionRow(client, connectionId);
      const { rows } = await client.query<{ answers: number }>(
        `select count(*)::int as answers
           from audit_log
          where subject_table = 'accounting_connections'
            and subject_id = $1
            and action in ('accounting_connection.account_created',
                           'accounting_connection.account_found')
            and payload->>'row' = $2`,
        [connectionId, row],
      );
      const requestId = postingSetupRequestId(connectionId, row, rows[0]?.answers ?? 0);
      await this.audit(client, 'accounting_connection.account_create_requested', connectionId, {
        provider_account_id: connection.provider_account_id,
        row,
        request_id: requestId,
      });
      return requestId;
    });
  }

  /**
   * Records that an owner's setup press created one of the two accounts ADR
   * 0063 admits: one `accounting_connection.account_created` row naming the
   * connection, its realm (read off the connection here, never passed in),
   * which of the two it was, the QuickBooks account id, and the request id it
   * was created under — copied from the row's latest request, which is this
   * press's own. Ids and words from closed sets only — never an account's
   * name, ours or anyone's.
   *
   * `readBackMismatch` is set when the account did not read back as it was
   * sent (ADR 0063 §2): QuickBooks made it all the same, so it is in the
   * customer's books and is recorded like any other, with the fields that
   * differed (`Id`, `Name`, `AccountType`, `Active`) and never their values.
   *
   * Only for an account QuickBooks answered this press's create with. One an
   * earlier press asked for and never heard back about is not this row's:
   * that is `recordAccountFound`.
   *
   * Owner only, like the switch. `audit_log`'s own policy admits any writer
   * acting as themselves, so the owner is asked of the database in the same
   * transaction and anybody else is `OwnerRequiredError`, with nothing written.
   */
  async recordAccountCreated(
    connectionId: string,
    input: {
      readonly row: SetupRow;
      readonly qboAccountId: string;
      readonly readBackMismatch?: readonly AccountReadBackField[];
    },
  ): Promise<void> {
    assertSetupRow(input.row);
    const qboAccountId = assertQboId(input.qboAccountId);
    const mismatch = input.readBackMismatch;
    if (
      mismatch !== undefined &&
      (mismatch.length === 0 || !mismatch.every((field) => Object.hasOwn(READ_BACK_FIELDS, field)))
    ) {
      throw new PostingStoreError('a read-back mismatch names at least one of Id, Name, AccountType, Active');
    }
    await this.withOwner(async (client) => {
      const connection = await this.connectionRow(client, connectionId);
      await this.audit(client, 'accounting_connection.account_created', connectionId, {
        provider_account_id: connection.provider_account_id,
        row: input.row,
        qbo_account_id: qboAccountId,
        request_id: await this.requestAnswered(client, connectionId, input.row),
        ...(mismatch === undefined ? {} : { read_back_mismatch: [...new Set(mismatch)] }),
      });
    });
  }

  /**
   * Records that an owner's setup press found, in the company's chart, the
   * account an earlier press asked QuickBooks for and never heard back about
   * (ADR 0063 §2): one `accounting_connection.account_found` row naming the
   * connection, its realm (read off the connection here, never passed in), the
   * row, the QuickBooks account id, and the request id that went unanswered —
   * copied from the row's latest request. Ids and words from closed sets only.
   *
   * Not `account_created`, because nobody saw it made. The press found an
   * account as that request would have made it, and a person could have made
   * that account in QuickBooks in between; the action says only what is
   * known. The request row before it says whose press asked. It carries no
   * read-back: only a press that made the account has one.
   *
   * Owner only, as `recordAccountCreated` is.
   */
  async recordAccountFound(
    connectionId: string,
    input: { readonly row: SetupRow; readonly qboAccountId: string },
  ): Promise<void> {
    assertSetupRow(input.row);
    const qboAccountId = assertQboId(input.qboAccountId);
    await this.withOwner(async (client) => {
      const connection = await this.connectionRow(client, connectionId);
      await this.audit(client, 'accounting_connection.account_found', connectionId, {
        provider_account_id: connection.provider_account_id,
        row: input.row,
        qbo_account_id: qboAccountId,
        request_id: await this.requestAnswered(client, connectionId, input.row),
      });
    });
  }

  /**
   * The setup rows of this connection whose latest create has no answer on the
   * record (ADR 0063 §2): an `accounting_connection.account_create_requested`
   * row with no `accounting_connection.account_created` or
   * `accounting_connection.account_found` for the same row after it. That is a
   * press that asked QuickBooks for an account and never learned what it made
   * — a timeout, a 5xx, a reply with no id, a read-back that could not be made,
   * a 4xx that does not say which of those two requests it refused — so
   * nothing yet names the account's id, if there is one. The next press
   * settles it from its own read of the chart (`recordAccountFound`), and logs
   * the request id it answers before it records it.
   *
   * In `SETUP_ROWS`' order. A read of this tenant's own audit log, through its
   * policy; `audit_log` has no index on its subject, and a press is rare enough
   * for this to scan the tenant's rows.
   */
  async unansweredAccountCreates(connectionId: string): Promise<readonly UnansweredAccountCreate[]> {
    return this.withTenant(async (client) => {
      const latest = await this.latestRequests(client, connectionId);
      return SETUP_ROWS.flatMap((row) => {
        const request = latest.get(row);
        return request === undefined || request.answered ? [] : [{ row, requestId: request.requestId }];
      });
    });
  }

  /**
   * Every QuickBooks account a setup press has recorded for each row of this
   * connection — created, or found as a request with no answer had asked for
   * it — oldest first (ADR 0063 §2). What a press reads before it plans a
   * create: an account setup already recorded for a row, and still in the
   * chart though no longer under our name there, is one a second create would
   * duplicate, so the press refuses rather than ask again.
   *
   * A read of this tenant's own audit log, through its policy, like
   * `unansweredAccountCreates`. A row that names an account id that is not
   * digits is refused rather than read around: nothing of ours writes one.
   */
  async recordedSetupAccounts(connectionId: string): Promise<RecordedSetupAccounts> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ setup_row: string | null; qbo_account_id: unknown }>(
        `select payload->>'row' as setup_row, payload->>'qbo_account_id' as qbo_account_id
           from audit_log
          where subject_table = 'accounting_connections'
            and subject_id = $1
            and action in ('accounting_connection.account_created',
                           'accounting_connection.account_found')
          order by id`,
        [connectionId],
      );
      const recorded: Record<SetupRow, string[]> = { deductions_receivable: [], writeoff: [] };
      for (const { setup_row, qbo_account_id } of rows) {
        const row = SETUP_ROWS.find((candidate) => candidate === setup_row);
        if (row === undefined) continue;
        if (typeof qbo_account_id !== 'string' || !QBO_ACCOUNT_ID.test(qbo_account_id)) {
          throw new PostingStoreError(`an account setup recorded for connection ${connectionId} has no account id`);
        }
        recorded[row].push(qbo_account_id);
      }
      return recorded;
    });
  }

  /**
   * Saves a new map for a connection, after checking each account's type as
   * QuickBooks reports it now. This never creates an account: the two a setup
   * press may create (ADR 0063) exist before it is called. Owner only — the
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
        enabled: boolean | null;
      }>(
        `select w.id, w.decision_id, w.method, w.status, w.qbo_txn_id, w.connection_id,
                w.account_map_id, w.amount_cents::text as amount_cents, w.lines,
                c.provider_account_id as realm_id, c.posting_enabled, c.enabled
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
        // A turned-off connection posts nothing, whatever its posting switch says.
        postingEnabled: row.posting_enabled === true && row.enabled === true,
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

  /**
   * Moment 2's approval (ADR 0060 §2): a `writeback` approval for a
   * settlement decision, and a `writeoff` approval with it when the entry
   * writes anything off. One transaction. Separation of duties is the
   * database's, unchanged: the preparer is refused as on every approval.
   */
  async approveSettlement(decisionId: string): Promise<{
    readonly deductionId: string;
    readonly writeoffCents: Cents;
  }> {
    return this.withTenant(async (client) => {
      const facts = await readDecisionFacts(client, decisionId);
      if (facts.schemaId !== SETTLEMENT_SCHEMA_ID) {
        throw new PostingDecisionError('only a settlement decision is approved here');
      }
      const writeoffCents = expenseDebit(facts);
      const actions: Array<'writeback' | 'writeoff'> =
        writeoffCents > 0 ? ['writeback', 'writeoff'] : ['writeback'];
      for (const action of actions) {
        let approvalId: string | undefined;
        try {
          const { rows } = await client.query<{ id: string }>(
            `insert into approvals (org_id, decision_id, approver_id, action_type)
             values ($1, $2, $3, $4) returning id`,
            [this.tenant.orgId, decisionId, this.tenant.userId, action],
          );
          approvalId = rows[0]?.id;
        } catch (error) {
          throw settlementApprovalRefusal(error, decisionId, this.tenant.userId);
        }
        if (approvalId === undefined) throw new Error('insert into approvals returned no row');
        await appendEvent(client, this.tenant, facts.deductionId, 'approval.granted', {
          approval_id: approvalId,
          decision_id: decisionId,
          action_type: action,
          approver_id: this.tenant.userId,
        });
      }
      return { deductionId: facts.deductionId, writeoffCents };
    });
  }

  /**
   * A person's "Check QuickBooks and retry": a `failed` row goes back to
   * `pending` with an event saying who asked, and the job then reads back by
   * reference before it sends anything. The row, and so its request id, is
   * the same one — never a new row.
   */
  async requeueWriteback(writebackId: string): Promise<{
    readonly deductionId: string;
    readonly connectionId: string;
  }> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        deduction_id: string;
        connection_id: string | null;
        status: string;
      }>(`select deduction_id, connection_id, status from writebacks where id = $1 for update`, [
        writebackId,
      ]);
      const row = rows[0];
      if (row === undefined || row.connection_id === null) throw new WritebackNotFoundError(writebackId);
      if (row.status !== 'failed') {
        throw new PostingDecisionError(`writeback ${writebackId} is ${row.status}, not failed`);
      }
      await appendEvent(client, this.tenant, row.deduction_id, 'writeback.retry_requested', {
        writeback_id: writebackId,
        requested_by: this.tenant.userId,
      });
      await client.query(`update writebacks set status = 'pending' where id = $1`, [writebackId]);
      return { deductionId: row.deduction_id, connectionId: row.connection_id };
    });
  }

  /** The tenant's QuickBooks connections as Settings → QuickBooks shows them. */
  async postingConnections(): Promise<readonly PostingConnectionView[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        provider_account_id: string;
        posting_enabled: boolean;
        map_id: string | null;
        ar_account_id: string | null;
        deductions_receivable_account_id: string | null;
        writeoff_by_family: Record<string, string> | null;
        unclassified_writeoff: string | null;
      }>(
        `select c.id, c.provider_account_id, c.posting_enabled,
                m.id as map_id, m.ar_account_id, m.deductions_receivable_account_id,
                m.writeoff_by_family, m.unclassified_writeoff
           from accounting_connections c
           left join lateral (
             select * from ledger_account_maps l
              where l.connection_id = c.id order by l.seq desc limit 1
           ) m on true
          where c.enabled and c.provider = 'qbo'
          order by c.created_at, c.id`,
      );
      return rows.map((row) => ({
        connectionId: row.id,
        realmId: row.provider_account_id,
        postingEnabled: row.posting_enabled,
        map:
          row.map_id === null
            ? undefined
            : {
                ...toMap(row as unknown as MapRow),
                mapId: row.map_id,
              },
      }));
    });
  }

  /**
   * What the case page needs to offer posting: the tenant's one enabled
   * connection (none when there are several — which one is not ours to
   * guess), the case's writebacks, and its latest settlement decision.
   */
  async postingForCase(deductionId: string): Promise<CasePosting> {
    return this.withTenant(async (client) => {
      const connections = await client.query<{ id: string; posting_enabled: boolean; has_map: boolean }>(
        `select c.id, c.posting_enabled,
                exists (select 1 from ledger_account_maps l where l.connection_id = c.id) as has_map
           from accounting_connections c
          where c.enabled and c.provider = 'qbo'`,
      );
      const only = connections.rows.length === 1 ? connections.rows[0] : undefined;
      const writebacks = await client.query<{
        id: string;
        decision_id: string;
        connection_id: string | null;
        method: WritebackMethod;
        status: 'pending' | 'succeeded' | 'failed';
        qbo_txn_id: string | null;
        amount_cents: string | null;
      }>(
        `select id, decision_id, connection_id, method, status, qbo_txn_id, amount_cents::text
           from writebacks where deduction_id = $1 order by created_at, id`,
        [deductionId],
      );
      const invoice = await client.query<{ identifier: string }>(
        `select identifier from deduction_identifiers
          where deduction_id = $1 and identifier_kind = 'ledger_invoice_id'
          order by identifier limit 1`,
        [deductionId],
      );
      const settlement = await client.query<{
        id: string;
        prepared_by: string;
        result: SettlementResult;
        approved: boolean;
      }>(
        `select d.id, d.prepared_by, d.result,
                exists (select 1 from approvals a
                         where a.decision_id = d.id and a.action_type = 'writeback') as approved
           from decisions d
          where d.deduction_id = $1 and d.schema_id = $2
          order by d.created_at desc, d.id desc limit 1`,
        [deductionId, SETTLEMENT_SCHEMA_ID],
      );
      const latest = settlement.rows[0];
      return {
        connection:
          only === undefined
            ? undefined
            : { connectionId: only.id, postingEnabled: only.posting_enabled, hasMap: only.has_map },
        ledgerInvoiceId: invoice.rows[0]?.identifier,
        writebacks: writebacks.rows.map((row) => ({
          writebackId: row.id,
          decisionId: row.decision_id,
          connectionId: row.connection_id ?? undefined,
          method: row.method,
          status: row.status,
          qboTxnId: row.qbo_txn_id ?? undefined,
          amountCents: row.amount_cents === null ? undefined : exact(row.amount_cents, 'amount_cents'),
        })),
        settlement:
          latest === undefined
            ? undefined
            : {
                decisionId: latest.id,
                preparedBy: latest.prepared_by,
                outcome: latest.result.outcome,
                recoveredCents: cents(latest.result.recovered_cents),
                invoiceId: latest.result.invoice_id,
                approved: latest.approved,
              },
      };
    });
  }

  private async connectionRow(
    client: PoolClient,
    connectionId: string,
  ): Promise<{ posting_enabled: boolean; provider_account_id: string }> {
    const { rows } = await client.query<{ posting_enabled: boolean; provider_account_id: string }>(
      `select posting_enabled, provider_account_id from accounting_connections where id = $1`,
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

  /**
   * `withTenant` for an audit row only an owner writes: the owner asked of the
   * database first, in the same transaction, and a refusal anywhere in `work`
   * read as `OwnerRequiredError`. `audit_log`'s own policy admits any writer
   * acting as themselves, so this is what makes such a row owner-only.
   */
  private async withOwner<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ owner: boolean }>('select app.member_is_owner() as owner');
      if (rows[0]?.owner !== true) throw new OwnerRequiredError(this.tenant.orgId, this.tenant.userId);
      try {
        return await work(client);
      } catch (error) {
        throw this.ownerRefusal(error);
      }
    });
  }

  /**
   * Each setup row's latest `account_create_requested` on this connection: the
   * request id it went out under, and whether an `account_created` or
   * `account_found` for the same row came after it. A row setup never makes
   * is not read; a request that names no request id is refused rather than
   * read around, because nothing of ours writes one.
   */
  private async latestRequests(
    client: PoolClient,
    connectionId: string,
  ): Promise<ReadonlyMap<SetupRow, { readonly requestId: string; readonly answered: boolean }>> {
    const { rows } = await client.query<{ setup_row: string | null; request_id: unknown; answered: boolean }>(
      `select asked.setup_row, asked.request_id,
              exists (select 1 from audit_log answer
                       where answer.subject_table = 'accounting_connections'
                         and answer.subject_id = $1
                         and answer.action in ('accounting_connection.account_created',
                                               'accounting_connection.account_found')
                         and answer.payload->>'row' = asked.setup_row
                         and answer.id > asked.id) as answered
         from (select distinct on (payload->>'row')
                      payload->>'row' as setup_row, payload->>'request_id' as request_id, id
                 from audit_log
                where subject_table = 'accounting_connections'
                  and subject_id = $1
                  and action = 'accounting_connection.account_create_requested'
                order by payload->>'row', id desc) asked`,
      [connectionId],
    );
    const latest = new Map<SetupRow, { readonly requestId: string; readonly answered: boolean }>();
    for (const { setup_row, request_id, answered } of rows) {
      const row = SETUP_ROWS.find((candidate) => candidate === setup_row);
      if (row === undefined) continue;
      if (typeof request_id !== 'string' || !REQUEST_ID.test(request_id)) {
        throw new PostingStoreError(`a setup request for connection ${connectionId} names no request id`);
      }
      latest.set(row, { requestId: request_id, answered: answered === true });
    }
    return latest;
  }

  /**
   * The request id an account created or found for `row` answers: the row's
   * latest request, copied rather than derived again, so the answer names the
   * request id the create went out under. A row nobody asked for has no
   * answer to give, and is refused.
   */
  private async requestAnswered(client: PoolClient, connectionId: string, row: SetupRow): Promise<string> {
    const request = (await this.latestRequests(client, connectionId)).get(row);
    if (request === undefined) {
      throw new PostingStoreError(`no ${row} account was asked for on connection ${connectionId}`);
    }
    return request.requestId;
  }
}

/**
 * A caller the type system does not reach (a script, a form) gets no audit
 * row for an account setup never makes.
 */
function assertSetupRow(row: SetupRow): void {
  if (!SETUP_ROWS.includes(row)) {
    throw new PostingStoreError('an account created at setup is deductions_receivable or writeoff');
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
