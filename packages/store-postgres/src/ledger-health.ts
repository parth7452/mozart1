import type { PoolClient } from 'pg';
import {
  LEDGER_SYNC_ANOMALY_KINDS,
  LEDGER_SYNC_OUTCOMES,
  type LedgerSyncAnomalyKind,
  type LedgerSyncOutcome,
} from './connections';

/**
 * How the ledger sync has been doing, for the coverage page (ADR 0031, ADR
 * 0035): the recent runs, and — per connection — what its latest completed run
 * found that a person has to look at in QuickBooks.
 *
 * **Per connection.** Runs and anomalies belong to a connection, and one
 * tenant can hold more than one; the latest completed run is taken per
 * connection so one ledger's findings never hide another's.
 *
 * **An anomaly missing from a later run is not a fixed anomaly.** Each run
 * walks the payments and credits of a trailing 35 days (ADR 0035 §1), so an
 * anomaly raised by a payment that has since left the window drops out of the
 * next run whether or not anybody fixed it. The page says so; this read keeps
 * the window each run looked at so it can.
 *
 * Kinds and outcomes are checked against the closed sets the tables' own check
 * constraints name. An unknown value throws: a sixth kind the page has no words
 * for is a code change, not something to render as a raw string and move on.
 * Nothing here is text off a ledger: the anomaly table keeps kinds and ids and
 * no detail by design (ADR 0035 §5).
 */

export class LedgerHealthReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerHealthReadError';
  }
}

export const LEDGER_RUNS_DEFAULT = 30;
export const LEDGER_RUNS_MAX = 100;

export interface LedgerRunRow {
  readonly runId: string;
  readonly connectionId: string;
  /** The company the run read — QuickBooks' realm id, not a credential. */
  readonly providerAccountId: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: LedgerSyncOutcome;
  /** A class name, never a message. */
  readonly errorClass?: string;
  readonly invoicesExamined: number;
  readonly openedCount: number;
  readonly skippedCount: number;
  readonly declinedCount: number;
  readonly anomalyCount: number;
  /**
   * Whether the run's anomalies are rows. A run recorded before migration 0027
   * counted them and kept no ids, so its count stands alone.
   */
  readonly itemised: boolean;
}

export interface LedgerAnomalyRow {
  readonly kind: LedgerSyncAnomalyKind;
  readonly invoiceExternalId: string;
  readonly transactionExternalId?: string;
}

/** A connection's latest completed run, and what it found. */
export interface LedgerFindings {
  readonly connectionId: string;
  readonly providerAccountId: string;
  readonly run: LedgerRunRow;
  /** Kind, then invoice id. Empty for a run that was not itemised. */
  readonly anomalies: readonly LedgerAnomalyRow[];
}

export interface LedgerSyncHealth {
  /** Newest first, across every connection this tenant holds. */
  readonly runs: readonly LedgerRunRow[];
  /** One per connection that has ever completed a run, newest run first. */
  readonly findings: readonly LedgerFindings[];
}

export function assertLedgerRunLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_RUNS_MAX) {
    throw new LedgerHealthReadError(
      `a ledger run list holds 1 to ${LEDGER_RUNS_MAX} runs, not ${String(limit)}`,
    );
  }
}

/** The whole read, in the caller's tenant transaction (RLS `tenant_read` on every table). */
export async function readLedgerSyncHealth(
  client: PoolClient,
  runLimit: number,
): Promise<LedgerSyncHealth> {
  assertLedgerRunLimit(runLimit);

  const recent = await client.query<RunDbRow>(
    `${RUN_COLUMNS}
      order by r.started_at desc, r.id desc
      limit $1`,
    [runLimit],
  );

  const latest = await client.query<RunDbRow>(
    `select * from (
       select distinct on (r.connection_id) ${RUN_SELECT_LIST}
         from ledger_sync_runs r
         join accounting_connections c on c.id = r.connection_id
        where r.outcome = 'completed'
        order by r.connection_id, r.started_at desc, r.id desc
     ) latest
     order by started_at desc, run_id desc`,
  );

  const runIds = latest.rows.map((row) => row.run_id);
  const anomalies =
    runIds.length === 0
      ? { rows: [] as AnomalyDbRow[] }
      : await client.query<AnomalyDbRow>(
          `select run_id::text as run_id, kind, invoice_external_id, transaction_external_id
             from ledger_sync_anomalies
            where run_id = any($1::uuid[])
            order by kind asc, invoice_external_id asc, transaction_external_id asc nulls first`,
          [runIds],
        );

  return {
    runs: recent.rows.map(toRun),
    findings: latest.rows.map((row) => {
      const run = toRun(row);
      return {
        connectionId: run.connectionId,
        providerAccountId: run.providerAccountId,
        run,
        anomalies: anomalies.rows
          .filter((anomaly) => anomaly.run_id === row.run_id)
          .map((anomaly) => ({
            kind: knownKind(anomaly.kind),
            invoiceExternalId: anomaly.invoice_external_id,
            ...(anomaly.transaction_external_id === null
              ? {}
              : { transactionExternalId: anomaly.transaction_external_id }),
          })),
      };
    }),
  };
}

const RUN_SELECT_LIST = `
         r.id::text                     as run_id,
         r.connection_id::text          as connection_id,
         c.provider_account_id,
         to_char(r.window_from, 'YYYY-MM-DD') as window_from,
         to_char(r.window_to, 'YYYY-MM-DD')   as window_to,
         r.started_at,
         r.finished_at,
         r.outcome,
         r.error_class,
         r.invoices_examined,
         r.opened_count,
         r.skipped_count,
         r.declined_count,
         r.anomaly_count,
         (select count(*) from ledger_sync_anomalies a where a.run_id = r.id)::int as anomaly_rows`;

const RUN_COLUMNS = `
  select ${RUN_SELECT_LIST}
    from ledger_sync_runs r
    join accounting_connections c on c.id = r.connection_id`;

interface RunDbRow {
  run_id: string;
  connection_id: string;
  provider_account_id: string;
  window_from: string;
  window_to: string;
  started_at: Date;
  finished_at: Date;
  outcome: string;
  error_class: string | null;
  invoices_examined: number;
  opened_count: number;
  skipped_count: number;
  declined_count: number;
  anomaly_count: number;
  anomaly_rows: number;
}

interface AnomalyDbRow {
  run_id: string;
  kind: string;
  invoice_external_id: string;
  transaction_external_id: string | null;
}

function toRun(row: RunDbRow): LedgerRunRow {
  return {
    runId: row.run_id,
    connectionId: row.connection_id,
    providerAccountId: row.provider_account_id,
    windowFrom: row.window_from,
    windowTo: row.window_to,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    outcome: knownOutcome(row.outcome),
    ...(row.error_class === null ? {} : { errorClass: row.error_class }),
    invoicesExamined: row.invoices_examined,
    openedCount: row.opened_count,
    skippedCount: row.skipped_count,
    declinedCount: row.declined_count,
    anomalyCount: row.anomaly_count,
    itemised: row.anomaly_rows === row.anomaly_count,
  };
}

function knownOutcome(value: string): LedgerSyncOutcome {
  if ((LEDGER_SYNC_OUTCOMES as readonly string[]).includes(value)) return value as LedgerSyncOutcome;
  throw new LedgerHealthReadError(`ledger_sync_runs.outcome ${JSON.stringify(value)} is not one this build knows`);
}

function knownKind(value: string): LedgerSyncAnomalyKind {
  if ((LEDGER_SYNC_ANOMALY_KINDS as readonly string[]).includes(value)) {
    return value as LedgerSyncAnomalyKind;
  }
  throw new LedgerHealthReadError(`ledger_sync_anomalies.kind ${JSON.stringify(value)} is not one this build knows`);
}
