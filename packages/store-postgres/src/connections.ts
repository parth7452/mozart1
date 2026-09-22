/**
 * The accounting-connection registry and the ledger-sync log, on Postgres
 * (ADR 0031, migration 0024; the log's anomalies, ADR 0035, migration 0027).
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

/**
 * The four kinds `ledger_sync_anomalies.kind` admits (migration 0027) — the
 * detector's `LEDGER_ANOMALY_KINDS`, repeated rather than imported so this
 * package's contract with its own check constraint is written down here, and
 * asserted against both by `test/ledger-anomalies.test.ts`.
 */
export const LEDGER_SYNC_ANOMALY_KINDS = [
  'overapplied',
  'application_to_unknown_invoice',
  'negative_amount',
  'currency_mismatch',
] as const;
export type LedgerSyncAnomalyKind = (typeof LEDGER_SYNC_ANOMALY_KINDS)[number];

/** One anomaly of a run, as the table keeps it: a kind and ledger ids, no text. */
export interface LedgerSyncAnomalyInput {
  readonly kind: LedgerSyncAnomalyKind;
  readonly invoiceExternalId: string;
  readonly transactionExternalId?: string;
}

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
   * Exactly `anomalyCount` of them (ADR 0035 §5). Written in the same
   * transaction as the run row, so a run with a count and no rows cannot be
   * committed through this store; the database refuses any other number too.
   */
  readonly anomalies: readonly LedgerSyncAnomalyInput[];
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

  /**
   * The connection for one provider account, if this tenant has one.
   *
   * By `(provider, provider_account_id)` rather than by id, because that is the
   * question an operator connecting a ledger asks: *is this company already
   * connected here?* A tenant may hold one connection per company (migration
   * 0024's unique), so an answer is unambiguous, and another tenant's is not
   * found rather than forbidden — RLS doing the work.
   */
  async connectionForAccount(
    provider: AccountingProvider,
    providerAccountId: string,
  ): Promise<AccountingConnectionRow | undefined> {
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
          where provider = $1 and provider_account_id = $2`,
        [provider, providerAccountId],
      );
      return rows[0] === undefined ? undefined : rowToConnection(rows[0]);
    });
  }

  /**
   * Register a connection for this tenant, as this member.
   *
   * `created_by` is this store's own member and is not a parameter: it is the
   * member a scheduled sync will act as (ADR 0031 §3), and a connection
   * attributed to somebody who is not the person running the command is a
   * connection that acts as a person who never agreed to it. `tenant_insert`
   * asks `app.member_may_write()`, so a `read_only` member is refused by the
   * database rather than by this code.
   *
   * It holds no secret, by construction: the row names a company, and what
   * proves we may read those books is a `accounting_credentials` row sealed
   * elsewhere (ADR 0033).
   */
  async createConnection(input: {
    readonly provider: AccountingProvider;
    readonly providerAccountId: string;
  }): Promise<AccountingConnectionRow> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        org_id: string;
        provider: string;
        provider_account_id: string;
        enabled: boolean;
        created_by: string;
      }>(
        `insert into accounting_connections (org_id, provider, provider_account_id, created_by)
         values ($1, $2, $3, $4)
         returning id, org_id, provider, provider_account_id, enabled, created_by`,
        [this.tenant.orgId, input.provider, input.providerAccountId, this.tenant.userId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('inserting an accounting connection returned no row');
      }
      return rowToConnection(row);
    });
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
      return row === undefined ? undefined : rowToConnection(row);
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
    // Checked here as well as there, for `count`'s reason: a mismatch should
    // fail with a message about the mismatch, before anything is sent.
    if (input.anomalies.length !== input.anomalyCount) {
      throw new Error(
        `a ledger sync run counted ${input.anomalyCount} anomalies and carries ` +
          `${input.anomalies.length}; a partial list is not the list (ADR 0035 §5)`,
      );
    }
    for (const anomaly of input.anomalies) {
      if (!(LEDGER_SYNC_ANOMALY_KINDS as readonly string[]).includes(anomaly.kind)) {
        throw new Error(`unknown ledger anomaly kind ${JSON.stringify(anomaly.kind)}`);
      }
    }
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
      // The run's anomalies, through their own door, in this transaction: if
      // this fails the run row goes with it (ADR 0035 §5). Kind and ids only —
      // never the detector's detail, which quotes the ledger.
      if (input.anomalies.length > 0) {
        const payload = input.anomalies.map((anomaly) => ({
          kind: anomaly.kind,
          invoice_external_id: anomaly.invoiceExternalId,
          transaction_external_id: anomaly.transactionExternalId ?? null,
        }));
        const written = await client.query<{ n: number }>(
          'select app.record_ledger_sync_anomalies($1::uuid, $2::jsonb) as n',
          [id, JSON.stringify(payload)],
        );
        if (written.rows[0]?.n !== input.anomalies.length) {
          throw new Error(
            `app.record_ledger_sync_anomalies() wrote ${String(written.rows[0]?.n)} of ` +
              `${input.anomalies.length} anomalies for run ${id}`,
          );
        }
      }
      return id;
    });
  }
}

/**
 * One registry row, as this package's types see it.
 *
 * A provider the database took and this build does not know is raised, not
 * skipped, for `listConnectionsToSync`'s reason: a connection nobody syncs
 * because nobody recognised it is a silent gap in a coverage number.
 */
function rowToConnection(row: {
  readonly id: string;
  readonly org_id: string;
  readonly provider: string;
  readonly provider_account_id: string;
  readonly enabled: boolean;
  readonly created_by: string;
}): AccountingConnectionRow {
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
}

/** A count column: a non-negative integer, or a loud failure rather than a null. */
function count(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`a ledger sync run count must be a non-negative number; got ${String(value)}`);
  }
  return Math.trunc(value);
}
