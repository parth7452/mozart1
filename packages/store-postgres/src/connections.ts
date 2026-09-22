/**
 * The accounting-connection registry and the ledger-sync log, on Postgres
 * (ADR 0031, migration 0024).
 *
 * Two tables and two questions, and they are asked by callers with different
 * amounts of identity — which is the whole reason this file has both a free
 * function and a class:
 *
 *  - **The cron fan-out has no tenant.** It has to know which orgs to fan out
 *    to before it can adopt any org's claims, so `listConnectionsToSync` runs
 *    as `app_rw` with no claims at all and asks
 *    `app.ledger_connections_to_sync()`, a security-definer function that hands
 *    back ids and a provider name. Not the account id, not a name, not a row.
 *    Never the service role (invariant 6) — ADR 0031 §5 spells out the
 *    difference.
 *  - **Everything else has one.** `PostgresLedgerSyncStore` runs as `app_rw`
 *    with the tenant's claims set transaction-locally, in the manner of
 *    `workflow.ts` and `discovery.ts`, and reads the connection row it was
 *    handed through RLS. That read is where `provider_account_id` comes from.
 *
 * It holds no secrets because the table holds none: `accounting_connections`
 * names a company and says who connected it, and what proves we may read those
 * books lives in KMS-backed storage (CLAUDE.md, ADR 0031 §1). If you find
 * yourself adding a token column here, that is the line you are about to cross.
 */

import type { Pool, PoolClient } from 'pg';
import { sessionPool, type PostgresStore, type PostgresStoreConfig, type TenantContext } from './store';

/**
 * The providers the database will take, as code.
 *
 * `accounting_connections.provider` carries the same list as a check
 * constraint. They are changed together: a new provider is one line here, one
 * line in a migration, and an `AccountingSource` behind the same port.
 */
export const ACCOUNTING_PROVIDERS = ['qbo'] as const;
export type AccountingProvider = (typeof ACCOUNTING_PROVIDERS)[number];

export function isAccountingProvider(value: string): value is AccountingProvider {
  return (ACCOUNTING_PROVIDERS as readonly string[]).includes(value);
}

/** A connection the scheduler should walk, as the fan-out needs it: ids only. */
export interface ConnectionToSync {
  readonly connectionId: string;
  readonly orgId: string;
  readonly provider: AccountingProvider;
  /** The member a sync of this connection acts as (ADR 0031 §3). */
  readonly createdBy: string;
}

/** A connection as its own tenant can read it, account id and all. */
export interface AccountingConnectionRow extends ConnectionToSync {
  /** The provider's key for the company — QBO's `realmId`. Not a credential. */
  readonly providerAccountId: string;
  readonly enabled: boolean;
}

/** The four outcomes `ledger_sync_runs.outcome` admits (migration 0024). */
export const LEDGER_SYNC_OUTCOMES = [
  'completed',
  'not_configured',
  'refused',
  'failed',
] as const;
export type LedgerSyncOutcome = (typeof LEDGER_SYNC_OUTCOMES)[number];

export interface LedgerSyncRunInput {
  readonly orgId: string;
  readonly connectionId: string;
  /** Must be the member this store acts as; the database refuses anything else. */
  readonly requestedBy: string;
  /** `YYYY-MM-DD`, inclusive both ends. */
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly outcome: LedgerSyncOutcome;
  readonly invoicesExamined: number;
  readonly openedCount: number;
  readonly skippedCount: number;
  readonly declinedCount: number;
  readonly anomalyCount: number;
  /**
   * An error's **class name**, never its message (invariant 4, ADR 0031 §2).
   * The database refuses one on a `completed` run.
   */
  readonly errorClass?: string;
}

/** A registry row the database took but this code does not understand. */
export class UnknownAccountingProviderError extends Error {
  constructor(
    readonly connectionId: string,
    readonly provider: string,
  ) {
    super(
      `connection ${connectionId} names provider ${provider}, which this build has no source for; ` +
        `known providers are ${ACCOUNTING_PROVIDERS.join(', ')}`,
    );
    this.name = 'UnknownAccountingProviderError';
  }
}

/**
 * Every enabled connection, across every org, as ids.
 *
 * No `TenantContext`, because there is no tenant yet: this is the query that
 * decides which tenants the scheduler will adopt. It runs as `app_rw` — the
 * same role as everything else here, set with `set local role` inside a
 * transaction — and the reach past RLS is `app.ledger_connections_to_sync()`'s
 * alone, which returns four id-shaped columns and nothing a tenant would mind
 * another seeing less than it would mind its ledger being read (ADR 0031 §5).
 *
 * A provider the database took and this build does not know is raised, not
 * skipped: a connection nobody syncs because nobody recognised it is a silent
 * gap in a coverage number (CLAUDE.md: fail loud).
 */
export async function listConnectionsToSync(
  config: PostgresStoreConfig,
): Promise<readonly ConnectionToSync[]> {
  const pool: Pool = sessionPool(config);
  const role = config.role ?? 'app_rw';
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    const { rows } = await client.query<{
      connection_id: string;
      org_id: string;
      provider: string;
      created_by: string;
    }>('select connection_id, org_id, provider, created_by from app.ledger_connections_to_sync()');
    await client.query('commit');
    return rows.map((row) => {
      if (!isAccountingProvider(row.provider)) {
        throw new UnknownAccountingProviderError(row.connection_id, row.provider);
      }
      return {
        connectionId: row.connection_id,
        orgId: row.org_id,
        provider: row.provider,
        createdBy: row.created_by,
      };
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The tenant-scoped half: read one connection, record one run.
 *
 * `memberMayWrite` is delegated to the `PostgresStore` this is constructed
 * with rather than re-asked here, for `discovery.ts`'s reason — there is to be
 * one copy of a rule, and that one already refuses to answer about a member it
 * is not acting as.
 */
export class PostgresLedgerSyncStore {
  private readonly pool: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
    private readonly store: PostgresStore,
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
  }

  /**
   * As `PostgresStore.withTenant`: the role and the claims are transaction-local,
   * so a pooled connection cannot carry one tenant's claims into another's
   * query. Repeated here rather than reached into, exactly as `discovery.ts`
   * repeats it — a private method on another class is not an API.
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

  /** Whether this member may write in this tenant — the database's answer. */
  async memberMayWrite(actor: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<boolean> {
    return this.store.memberMayWrite(actor);
  }

  /**
   * One connection, read under the tenant's own claims.
   *
   * A connection belonging to another tenant is not "forbidden", it is simply
   * not found — RLS doing the work rather than a filter this file remembered to
   * apply (invariant 6). Which is also why the fan-out's id list is safe to act
   * on: a wrong id gets nothing.
   */
  async connection(connectionId: string): Promise<AccountingConnectionRow | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        org_id: string;
        provider: string;
        provider_account_id: string;
        enabled: boolean;
        created_by: string;
      }>(
        `select id, org_id, provider, provider_account_id, enabled, created_by
           from accounting_connections
          where id = $1`,
        [connectionId],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      if (!isAccountingProvider(row.provider)) {
        throw new UnknownAccountingProviderError(row.id, row.provider);
      }
      return {
        connectionId: row.id,
        orgId: row.org_id,
        provider: row.provider,
        providerAccountId: row.provider_account_id,
        enabled: row.enabled,
        createdBy: row.created_by,
      };
    });
  }

  /**
   * Writes the run row, through the one door the database opens for it.
   *
   * `app.record_ledger_sync_run()` rather than an INSERT, because `app_rw`
   * holds no INSERT on `ledger_sync_runs` at all (migration 0024 §3): the row
   * that most needs writing is the one whose acting member may no longer write,
   * and `tenant_insert`'s `app.member_may_write()` would refuse the record of
   * its own refusal. The function is definer, and bounded to this store's own
   * claims — it refuses any org but `app.current_org_id()` and any
   * `requested_by` but `app.current_user_id()`, both of which this transaction
   * has just set.
   *
   * The counts are floored at zero and rounded to integers here as well as
   * checked there, because a `NaN` from a caller would otherwise reach a
   * `not null` column as a null and fail with a message about the wrong thing.
   */
  async recordLedgerSyncRun(input: LedgerSyncRunInput): Promise<string> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select app.record_ledger_sync_run(
                  $1::uuid, $2::uuid, $3::uuid, $4::date, $5::date,
                  $6::timestamptz, $7::timestamptz, $8::text,
                  $9::integer, $10::integer, $11::integer, $12::integer, $13::integer,
                  $14::text) as id`,
        [
          input.orgId,
          input.connectionId,
          input.requestedBy,
          input.windowFrom,
          input.windowTo,
          input.startedAt.toISOString(),
          input.finishedAt.toISOString(),
          input.outcome,
          count(input.invoicesExamined),
          count(input.openedCount),
          count(input.skippedCount),
          count(input.declinedCount),
          count(input.anomalyCount),
          input.errorClass ?? null,
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined || id === null) {
        // The function returns the new id or raises. Nothing else is a result.
        throw new Error('app.record_ledger_sync_run() returned no run id');
      }
      return id;
    });
  }

  /**
   * The runs this tenant has on record, newest first — for an operator asking
   * "did it run, and what did it find".
   *
   * `limit` is applied in SQL rather than after: a tenant syncing daily
   * accumulates a row a day per connection, and this is a page of history, not
   * the history.
   */
  async recentRuns(limit = 50): Promise<readonly LedgerSyncRunRow[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        connection_id: string;
        window_from: string;
        window_to: string;
        started_at: Date;
        finished_at: Date;
        invoices_examined: number;
        opened_count: number;
        skipped_count: number;
        declined_count: number;
        anomaly_count: number;
        outcome: LedgerSyncOutcome;
        error_class: string | null;
        requested_by: string;
      }>(
        `select id, connection_id,
                to_char(window_from, 'YYYY-MM-DD') as window_from,
                to_char(window_to, 'YYYY-MM-DD') as window_to,
                started_at, finished_at, invoices_examined, opened_count,
                skipped_count, declined_count, anomaly_count, outcome,
                error_class, requested_by
           from ledger_sync_runs
          order by started_at desc, id desc
          limit $1`,
        [Math.max(1, Math.trunc(limit))],
      );
      return rows.map((row) => ({
        runId: row.id,
        connectionId: row.connection_id,
        windowFrom: row.window_from,
        windowTo: row.window_to,
        startedAt: row.started_at.toISOString(),
        finishedAt: row.finished_at.toISOString(),
        invoicesExamined: row.invoices_examined,
        openedCount: row.opened_count,
        skippedCount: row.skipped_count,
        declinedCount: row.declined_count,
        anomalyCount: row.anomaly_count,
        outcome: row.outcome,
        ...(row.error_class !== null ? { errorClass: row.error_class } : {}),
        requestedBy: row.requested_by,
      }));
    });
  }
}

/** One row of `ledger_sync_runs`, read back. */
export interface LedgerSyncRunRow {
  readonly runId: string;
  readonly connectionId: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly invoicesExamined: number;
  readonly openedCount: number;
  readonly skippedCount: number;
  readonly declinedCount: number;
  readonly anomalyCount: number;
  readonly outcome: LedgerSyncOutcome;
  readonly errorClass?: string;
  readonly requestedBy: string;
}

/** A count column: a non-negative integer, or a loud failure rather than a null. */
function count(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`a ledger sync run count must be a non-negative number; got ${String(value)}`);
  }
  return Math.trunc(value);
}
