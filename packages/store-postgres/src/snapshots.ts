/**
 * The books as a daily ledger sync kept them (ADR 0074, migration 0045).
 *
 * One write and three reads, each in one tenant transaction as `app_rw` under
 * the caller's claims — never the service role, and no `org_id` filter of its
 * own on a read: RLS decides whose snapshots these are.
 *
 * - `recordLedgerSnapshot` sends a snapshot's header and lines to
 *   `app.record_ledger_snapshot()`, the only door into either table. The
 *   door checks the chain's head under a lock on the connection, the counts,
 *   that the trial balance adds up, and that the run is the caller's
 *   completed run; this class adds nothing to that but the shape. A refusal
 *   comes back as `LedgerSnapshotRefusedError`.
 * - `latestSnapshotSha` is the chain's head, which the next snapshot's
 *   `prev_sha256` must name.
 * - `recentSnapshots` is what the Books page lists.
 * - `snapshotContent` rebuilds a stored snapshot's content exactly as
 *   `buildLedgerSnapshot` made it, so `snapshotSha256` recomputes its hash
 *   from the rows: the post-audit check, and what the integration test asks.
 *
 * In its own file and its own small class, in the manner of
 * `PostgresBooksStore`.
 */

import type { Pool, PoolClient } from 'pg';
import {
  LEDGER_SNAPSHOT_FORMAT,
  type LedgerSnapshotContent,
  type LedgerSnapshotStatus,
} from '@recouple/core-domain';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';

/** The door refused a snapshot. Its message names ids and a rule, never ledger text. */
export class LedgerSnapshotRefusedError extends Error {
  override readonly name = 'LedgerSnapshotRefusedError';
  constructor(
    message: string,
    /** The SQLSTATE the door raised. */
    readonly code: string,
  ) {
    super(message);
  }
}

/** A read that came back in a shape it should never have. Column names only. */
export class LedgerSnapshotReadError extends Error {
  override readonly name = 'LedgerSnapshotReadError';
}

/** One kept snapshot, as a list shows it. Totals are absent on a refused one. */
export interface LedgerSnapshotSummary {
  readonly snapshotId: string;
  readonly runId: string;
  readonly asOf: string;
  readonly status: LedgerSnapshotStatus;
  readonly refusalClass?: string;
  readonly totalDebitCents?: number;
  readonly totalCreditCents?: number;
  readonly trialBalanceLineCount: number;
  readonly ledgerLineCount: number;
  readonly sha256: string;
  readonly prevSha256?: string;
  readonly createdAt: string;
}

/** The most snapshots one list read returns. */
export const LEDGER_SNAPSHOTS_LIST_MAX = 100;

export class PostgresLedgerSnapshotStore {
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

  /**
   * Writes one snapshot and all its lines, as the member these claims are
   * for, through `app.record_ledger_snapshot()`. Its `created_by` is that
   * member: the door refuses any other.
   */
  async recordLedgerSnapshot(input: {
    readonly content: LedgerSnapshotContent;
    readonly sha256: string;
    readonly prevSha256: string | null;
  }): Promise<string> {
    const { content } = input;
    if (content.org_id !== this.tenant.orgId) {
      throw new LedgerSnapshotRefusedError(
        `snapshot for org ${content.org_id} offered to a store for org ${this.tenant.orgId}`,
        'client',
      );
    }
    const header = {
      org_id: content.org_id,
      connection_id: content.connection_id,
      run_id: content.run_id,
      created_by: this.tenant.userId,
      as_of: content.as_of,
      window_from: content.window_from,
      window_to: content.window_to,
      basis: content.basis,
      currency: content.currency,
      status: content.status,
      refusal_class: content.refusal_class,
      total_debit_cents: content.total_debit_cents,
      total_credit_cents: content.total_credit_cents,
      trial_balance_line_count: content.trial_balance.length,
      ledger_line_count: content.ledger_postings.length,
      sha256: input.sha256,
      prev_sha256: input.prevSha256,
    };
    try {
      return await this.withTenant(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'select app.record_ledger_snapshot($1::jsonb, $2::jsonb, $3::jsonb) as id',
          [
            JSON.stringify(header),
            JSON.stringify(content.trial_balance),
            JSON.stringify(content.ledger_postings),
          ],
        );
        const id = rows[0]?.id;
        if (typeof id !== 'string') throw new LedgerSnapshotReadError('the door returned no id');
        return id;
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : '';
      if (
        (code === '23001' || code === '42501' || code === '22023') &&
        message.startsWith('ledger snapshot blocked')
      ) {
        throw new LedgerSnapshotRefusedError(message, code);
      }
      throw error;
    }
  }

  /** The chain's head for a connection: its latest snapshot's hash, if any. */
  async latestSnapshotSha(connectionId: string): Promise<string | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ sha256: string }>(
        `select sha256 from ledger_snapshots
          where connection_id = $1
          order by seq desc
          limit 1`,
        [connectionId],
      );
      return rows[0]?.sha256;
    });
  }

  /** A connection's latest snapshots, newest first. */
  async recentSnapshots(
    connectionId: string,
    limit: number,
  ): Promise<readonly LedgerSnapshotSummary[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_SNAPSHOTS_LIST_MAX) {
      throw new LedgerSnapshotReadError(
        `a snapshot list is 1 to ${LEDGER_SNAPSHOTS_LIST_MAX} rows`,
      );
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<HeaderRow & { id: string; created_at: Date }>(
        `select id, ${HEADER_COLUMNS}, created_at
           from ledger_snapshots
          where connection_id = $1
          order by seq desc
          limit $2`,
        [connectionId, limit],
      );
      return rows.map((row) => ({
        snapshotId: row.id,
        runId: row.run_id,
        asOf: row.as_of,
        status: row.status,
        ...(row.refusal_class === null ? {} : { refusalClass: row.refusal_class }),
        ...(row.total_debit_cents === null
          ? {}
          : { totalDebitCents: exactCents(row.total_debit_cents, 'total_debit_cents') }),
        ...(row.total_credit_cents === null
          ? {}
          : { totalCreditCents: exactCents(row.total_credit_cents, 'total_credit_cents') }),
        trialBalanceLineCount: row.trial_balance_line_count,
        ledgerLineCount: row.ledger_line_count,
        sha256: row.sha256,
        ...(row.prev_sha256 === null ? {} : { prevSha256: row.prev_sha256 }),
        createdAt: new Date(row.created_at).toISOString(),
      }));
    });
  }

  /**
   * A stored snapshot's content, rebuilt from its rows exactly as
   * `buildLedgerSnapshot` produced it, with the two hashes it was stored
   * under: `snapshotSha256(content, prevSha256)` recomputes `sha256`.
   * `undefined` for a snapshot this tenant cannot see.
   */
  async snapshotContent(snapshotId: string): Promise<
    | {
        readonly content: LedgerSnapshotContent;
        readonly sha256: string;
        readonly prevSha256: string | null;
      }
    | undefined
  > {
    return this.withTenant(async (client) => {
      const header = await client.query<HeaderRow>(
        `select ${HEADER_COLUMNS} from ledger_snapshots where id = $1`,
        [snapshotId],
      );
      const row = header.rows[0];
      if (row === undefined) return undefined;
      const lines = await client.query<{
        kind: 'trial_balance' | 'ledger_posting';
        account_external_id: string | null;
        account_name: string;
        debit_cents: string;
        credit_cents: string;
        txn_date: string | null;
        txn_type: string | null;
        transaction_external_id: string | null;
        doc_number: string | null;
      }>(
        `select kind, account_external_id, account_name,
                debit_cents::text as debit_cents, credit_cents::text as credit_cents,
                txn_date::text as txn_date, txn_type, transaction_external_id, doc_number
           from ledger_snapshot_lines
          where snapshot_id = $1
          order by kind, line_no`,
        [snapshotId],
      );
      const trial = lines.rows
        .filter((line) => line.kind === 'trial_balance')
        .map((line) => ({
          account_external_id: line.account_external_id,
          account_name: line.account_name,
          debit_cents: line.debit_cents,
          credit_cents: line.credit_cents,
        }));
      const postings = lines.rows
        .filter((line) => line.kind === 'ledger_posting')
        .map((line) => {
          if (line.txn_date === null) {
            throw new LedgerSnapshotReadError('a stored posting has no txn_date');
          }
          return {
            account_external_id: line.account_external_id,
            account_name: line.account_name,
            debit_cents: line.debit_cents,
            credit_cents: line.credit_cents,
            txn_date: line.txn_date,
            txn_type: line.txn_type,
            transaction_external_id: line.transaction_external_id,
            doc_number: line.doc_number,
          };
        });
      return {
        content: {
          format: LEDGER_SNAPSHOT_FORMAT,
          org_id: row.org_id,
          connection_id: row.connection_id,
          run_id: row.run_id,
          as_of: row.as_of,
          window_from: row.window_from,
          window_to: row.window_to,
          basis: row.basis,
          currency: row.currency,
          status: row.status,
          refusal_class: row.refusal_class,
          total_debit_cents: row.total_debit_cents,
          total_credit_cents: row.total_credit_cents,
          trial_balance: trial,
          ledger_postings: postings,
        },
        sha256: row.sha256,
        prevSha256: row.prev_sha256,
      };
    });
  }
}

interface HeaderRow {
  org_id: string;
  connection_id: string;
  run_id: string;
  as_of: string;
  window_from: string;
  window_to: string;
  basis: string | null;
  currency: string | null;
  status: LedgerSnapshotStatus;
  refusal_class: string | null;
  total_debit_cents: string | null;
  total_credit_cents: string | null;
  trial_balance_line_count: number;
  ledger_line_count: number;
  sha256: string;
  prev_sha256: string | null;
}

/** Dates and cents as text, so neither a timezone nor a float touches them. */
const HEADER_COLUMNS = `org_id, connection_id, run_id, as_of::text as as_of,
  window_from::text as window_from, window_to::text as window_to, basis, currency,
  status, refusal_class, total_debit_cents::text as total_debit_cents,
  total_credit_cents::text as total_credit_cents, trial_balance_line_count,
  ledger_line_count, sha256, prev_sha256`;

/** A bigint the database sent as text, as a number it fits in exactly. */
function exactCents(text: string, column: string): number {
  const value = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value)) {
    throw new LedgerSnapshotReadError(`${column} is not a whole number this process can hold`);
  }
  return value;
}
