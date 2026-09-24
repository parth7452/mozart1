/**
 * One scheduled ledger sync, shaped for a workflow runtime (ADR 0031).
 *
 * `syncLedger` (./discovery.ts) is the sync. This is what a timer needs around
 * it and nothing more: check that the member the event names may still write,
 * resolve an accounting source for the connection, run the window, and record
 * a row saying what happened. Like every other step here it is a pure function
 * over ports, so the whole job runs in a test with no database, no queue and no
 * vendor.
 *
 * **Every path that gets as far as a real connection writes a run row.** A sync
 * that ran and left no row is invisible, and ADR 0030's coverage view cannot
 * tell a period where the ledger held no short-pays from a period nothing ever
 * walked. So `refused`, `not_configured` and `failed` are recorded as
 * deliberately as `completed` is.
 *
 * **And nothing is swallowed.** A refusal and an unconfigured source are
 * *outcomes* — settled facts about a connection, returned so the fleet carries
 * on and the row is what makes them actionable. A sync that broke is an error:
 * the row is written first, and then it is rethrown, because a partial run
 * reported as a success is how a coverage number goes wrong (CLAUDE.md).
 */

import type { LedgerAnomaly, LedgerAnomalyKind, LedgerWindow } from '@recouple/core-domain';
import { syncLedger, type DiscoveryStore, type LedgerSource, type SyncReport } from './discovery';

/**
 * How many days of payment and credit activity a run walks, inclusive of today.
 *
 * Days of *payment* activity since ADR 0035, not of invoicing: the window
 * selects the payments and credits dated in it, and the invoices they name are
 * read by id whatever their age. An invoice therefore stays in view for this
 * many days after its last payment or credit.
 *
 * Consecutive daily runs therefore overlap by 34 days, and the overlap is the
 * design rather than slack (ADR 0031 §6): ADR 0026 says a caller walking month
 * by month sees a boundary transaction twice and that dedup is the caller's
 * job, a payment can be applied to an invoice days after either was dated, and
 * a run killed mid-flight leaves no row at all. `syncLedger` is repeat-safe —
 * an invoice whose short-pay became a case has its `ledger_invoice_id` in
 * `deduction_identifiers`, so the next pass resolves `exact` and only writes
 * identifier rows — so the overlap costs one query and no case.
 *
 * A code constant rather than a per-tenant threshold on purpose: lengthening it
 * is strictly more conservative and shortening it is a code change with an ADR
 * behind it, so there is nothing here for `app.guard_threshold_direction()` to
 * guard.
 */
export const LEDGER_SYNC_WINDOW_DAYS = 35;

/** A connection, as this job needs to read it. `AccountingConnectionRow` is one. */
export interface LedgerConnectionRecord {
  readonly connectionId: string;
  readonly orgId: string;
  readonly provider: string;
  /** The provider's key for the company. Names which books; authorises nothing. */
  readonly providerAccountId: string;
  readonly enabled: boolean;
  readonly createdBy: string;
}

export type LedgerSyncOutcome = 'completed' | 'not_configured' | 'refused' | 'failed';

/** What a run row carries. `PostgresLedgerSyncStore.recordLedgerSyncRun` takes one. */
export interface LedgerSyncRunRecord {
  readonly orgId: string;
  readonly connectionId: string;
  readonly requestedBy: string;
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
   * Which invoices the sync could not reason about, as kind and ids (ADR 0035
   * §5). Exactly `anomalyCount` of them — the store and the database both
   * refuse any other number — and never the detector's `detail`, which quotes
   * the ledger.
   */
  readonly anomalies: readonly LedgerSyncAnomalyRecord[];
  /** A class name, never a message (invariant 4). */
  readonly errorClass?: string;
}

/** One anomaly as a run row's child carries it: a closed-set kind and ledger ids. */
export interface LedgerSyncAnomalyRecord {
  readonly kind: LedgerAnomalyKind;
  readonly invoiceExternalId: string;
  readonly transactionExternalId?: string;
}

/** The detector's anomaly, stripped to what may be stored: no `detail`. */
export function toAnomalyRecord(anomaly: LedgerAnomaly): LedgerSyncAnomalyRecord {
  return {
    kind: anomaly.kind,
    invoiceExternalId: anomaly.invoiceExternalId,
    ...(anomaly.transactionExternalId !== undefined
      ? { transactionExternalId: anomaly.transactionExternalId }
      : {}),
  };
}

/**
 * What the job needs of a store besides the discovery writes.
 *
 * `PostgresLedgerSyncStore` is one. Declared structurally here rather than
 * imported so `pipeline` takes no dependency on `store-postgres` for three
 * method signatures — the same choice `LedgerSource` makes in ./discovery.ts.
 */
export interface LedgerSyncRunStore {
  /**
   * Whether this member may write in this org — `app.member_may_write()`, asked
   * of the database.
   *
   * Asked for `readDocumentJob`'s reason (ADR 0021): an event is a signed
   * message naming an org and a user, and the signature says the runtime
   * delivered it, not that the pair is real. `tenant_read` is gated on the org
   * claim alone, so without this a payload pairing one tenant's org with any
   * user id would be read and paid for at the vendor before the first write
   * refused it.
   */
  memberMayWrite(actor: { readonly orgId: string; readonly userId: string }): Promise<boolean>;
  /** Read under the tenant's own claims: another tenant's is simply not found. */
  connection(connectionId: string): Promise<LedgerConnectionRecord | undefined>;
  recordLedgerSyncRun(input: LedgerSyncRunRecord): Promise<string>;
  /**
   * Turns a connection off because the provider refused its stored sign-in
   * for good, so the company is no longer held from every other workspace
   * (ADR 0046). Only while `credentialId` is still the latest stored sign-in:
   * a reconnect since is `newer_sign_in`, and nothing is written. `undefined`
   * when this tenant cannot see the connection.
   *
   * Optional: a store without it never releases, which is where every sync
   * stood before ADR 0046.
   */
  releaseDeadConnection?(input: {
    readonly connectionId: string;
    readonly credentialId: string;
    readonly reason: DeadLedgerGrant['reason'];
  }): Promise<LedgerReleaseOutcome | undefined>;
}

/** What a release answered (ADR 0046 §2). */
export type LedgerReleaseOutcome = 'released' | 'newer_sign_in' | 'already_off';

/**
 * A stored sign-in the provider has refused for good, and which one (ADR 0046).
 *
 * `reason` is one of the two answers that are final: the provider refused a
 * refresh (`grant_refused`), or the refresh token's own expiry passed
 * (`refresh_expired`). `credentialId` is the stored row that was refused.
 */
export interface DeadLedgerGrant {
  readonly reason: 'grant_refused' | 'refresh_expired';
  readonly credentialId: string;
}

/**
 * Whether this deployment can build a source for this connection.
 *
 * A typed answer rather than a throw or a source that throws on use, following
 * `scannerFromEnv` and `runnerFromEnv` (ADR 0018, ADR 0021): one place decides,
 * and "not configured" is a value the caller handles rather than an exception
 * that takes the fleet with it.
 */
export type ResolvedLedgerSource =
  | {
      readonly kind: 'ready';
      readonly source: LedgerSource;
      /**
       * Whether a failure the source threw says the stored sign-in is dead
       * for good, and which stored sign-in it was (ADR 0046) — `undefined`
       * for every other failure. The provider-specific half of the question:
       * this job knows no provider's errors.
       */
      readonly deadGrant?: (error: unknown) => DeadLedgerGrant | undefined;
    }
  | { readonly kind: 'not_configured'; readonly reason: string };

export interface LedgerSourceFactory {
  resolve(
    connection: LedgerConnectionRecord,
  ): ResolvedLedgerSource | Promise<ResolvedLedgerSource>;
}

export interface LedgerSyncJobDeps {
  readonly runs: LedgerSyncRunStore;
  readonly discovery: DiscoveryStore;
  readonly sources: LedgerSourceFactory;
  readonly now: () => Date;
  /** Defaults to `LEDGER_SYNC_WINDOW_DAYS`. */
  readonly windowDays?: number;
  /** Passed through to `syncLedger`, which defaults it (ADR 0029 §4). */
  readonly minDisputeCents?: number;
}

export interface LedgerSyncJobInput {
  readonly connectionId: string;
  readonly orgId: string;
  /** The member the run acts as: the connection's `created_by` (ADR 0031 §3). */
  readonly actor: { readonly userId: string };
}

export interface LedgerSyncJobResult {
  readonly runId: string;
  readonly connectionId: string;
  readonly orgId: string;
  readonly outcome: LedgerSyncOutcome;
  readonly window: LedgerWindow;
  readonly invoicesExamined: number;
  readonly openedCount: number;
  readonly skippedCount: number;
  readonly declinedCount: number;
  readonly anomalyCount: number;
  /**
   * Ledger cases this run moved out of `discovered` before it read the ledger
   * (ADR 0043 §2). Only on a completed run, and never on the run row: it is
   * about cases opened by earlier runs, not about this run's window, and each
   * move is already a `case.classified` event on its case.
   */
  readonly classifiedCount?: number;
  /**
   * Why it did not sync, for a log line — never for the run row.
   *
   * `not_configured` names the environment variable that is missing, which is
   * the one thing that makes it fixable, and that belongs in this deployment's
   * own logs rather than in a durable row (ADR 0031 §2).
   */
  readonly reason?: string;
}

/** A payload that does not name what this job needs, or names two things at odds. */
export class LedgerSyncJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerSyncJobError';
  }
}

/** A connection this tenant cannot see, or that is not there at all. */
export class LedgerConnectionNotFoundError extends Error {
  constructor(readonly connectionId: string) {
    super(`no accounting connection ${connectionId} for this tenant`);
    this.name = 'LedgerConnectionNotFoundError';
  }
}

/**
 * The member this connection acts as may no longer write in this org.
 *
 * Instantiated only for its name, which is what goes in `error_class`: the
 * string is a class rather than a literal so the row and the code cannot drift.
 */
export class LedgerSyncRefusedError extends Error {
  constructor(orgId: string, userId: string) {
    super(`user ${userId} may no longer write in org ${orgId}`);
    this.name = 'LedgerSyncRefusedError';
  }
}

/** The connection was disabled between the fan-out listing it and this run. */
export class LedgerConnectionDisabledError extends Error {
  constructor(readonly connectionId: string) {
    super(`accounting connection ${connectionId} is disabled`);
    this.name = 'LedgerConnectionDisabledError';
  }
}

/** No accounting source could be built for this connection (ADR 0031 §7). */
export class LedgerSourceNotConfiguredError extends Error {
  constructor(readonly connectionId: string, reason: string) {
    super(`no accounting source for connection ${connectionId}: ${reason}`);
    this.name = 'LedgerSourceNotConfiguredError';
  }
}

/**
 * The trailing window a run walks: `[today − (days − 1), today]`, in UTC.
 *
 * UTC rather than a local zone because the run row is compared against
 * `deduction_date` and against other runs, and a window whose edges move with
 * a server's timezone is a window nobody can reason about. `YYYY-MM-DD` both
 * ends, which is the only shape `QboClient` will accept (ADR 0026).
 */
export function ledgerSyncWindow(
  now: Date,
  days: number = LEDGER_SYNC_WINDOW_DAYS,
): LedgerWindow {
  if (!Number.isInteger(days) || days < 1) {
    throw new LedgerSyncJobError(
      `a ledger sync window is a whole number of days, at least one; got ${String(days)}`,
    );
  }
  const toMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromMs = toMs - (days - 1) * 86_400_000;
  return { from: isoDay(fromMs), to: isoDay(toMs) };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One connection's sync, from an id.
 *
 * The order is the order, and each question is cheaper than what follows it:
 * is this connection one this tenant can see, is it still enabled, may this
 * member still write, and can this deployment even build a source? Only then is
 * a vendor called and a model's worth of money — no model here, but a ledger
 * read is a paid API call and a page of somebody's books either way — spent.
 *
 * A connection that cannot be found is thrown rather than recorded: a run row
 * names a connection by foreign key, so there is nothing to attribute the row
 * to, and an event naming a connection this tenant cannot see is a payload
 * problem rather than a sync that went badly.
 */
export async function syncLedgerJob(
  deps: LedgerSyncJobDeps,
  input: LedgerSyncJobInput,
): Promise<LedgerSyncJobResult> {
  assertNamed(input.connectionId, 'connectionId');
  assertNamed(input.orgId, 'orgId');
  assertNamed(input.actor?.userId, 'actor.userId');

  const startedAt = deps.now();
  const window = ledgerSyncWindow(startedAt, deps.windowDays ?? LEDGER_SYNC_WINDOW_DAYS);

  const connection = await deps.runs.connection(input.connectionId);
  if (connection === undefined) throw new LedgerConnectionNotFoundError(input.connectionId);
  if (connection.orgId !== input.orgId) {
    // The store read under this org's claims, so RLS should have hidden it —
    // this is the belt the in-memory stores need, and it is the same check
    // `readDocumentJob` makes about a document's org for the same reason.
    throw new LedgerSyncJobError(
      `connection ${input.connectionId} does not belong to org ${input.orgId}`,
    );
  }

  const record = async (
    outcome: LedgerSyncOutcome,
    counts: Counts,
    errorClass?: string,
    anomalies: readonly LedgerSyncAnomalyRecord[] = [],
  ): Promise<LedgerSyncJobResult> => {
    const runId = await deps.runs.recordLedgerSyncRun({
      orgId: input.orgId,
      connectionId: connection.connectionId,
      requestedBy: input.actor.userId,
      windowFrom: window.from,
      windowTo: window.to,
      startedAt,
      finishedAt: deps.now(),
      outcome,
      ...counts,
      anomalies,
      ...(errorClass !== undefined ? { errorClass } : {}),
    });
    return { runId, connectionId: connection.connectionId, orgId: input.orgId, outcome, window, ...counts };
  };

  // Disabled between the fan-out listing it and this delivery running. Nothing
  // is read, and the row says which of the two refusals this was.
  if (!connection.enabled) {
    const disabled = new LedgerConnectionDisabledError(connection.connectionId);
    return { ...(await record('refused', NOTHING, disabled.name)), reason: disabled.message };
  }

  // Before a vendor is called, and so before anybody's books are read: is the
  // member this run acts as still a member of this org who may write? A cron
  // has no session, so nothing upstream established it (ADR 0031 §3).
  if (!(await deps.runs.memberMayWrite({ orgId: input.orgId, userId: input.actor.userId }))) {
    const refused = new LedgerSyncRefusedError(input.orgId, input.actor.userId);
    return { ...(await record('refused', NOTHING, refused.name)), reason: refused.message };
  }

  const resolved = await deps.sources.resolve(connection);
  if (resolved.kind === 'not_configured') {
    const missing = new LedgerSourceNotConfiguredError(connection.connectionId, resolved.reason);
    return { ...(await record('not_configured', NOTHING, missing.name)), reason: resolved.reason };
  }

  let report: SyncReport;
  try {
    report = await syncLedger({
      source: resolved.source,
      window,
      store: deps.discovery,
      orgId: input.orgId,
      ...(deps.minDisputeCents !== undefined ? { minDisputeCents: deps.minDisputeCents } : {}),
    });
  } catch (error) {
    // The row first, then the throw. A run that broke halfway has written
    // whatever `syncLedger` wrote before it broke, and the row is the only
    // thing that says a walk of this window was attempted and did not finish —
    // which is exactly what ADR 0030's coverage number must not mistake for a
    // window with nothing in it. The class name, never the message: an error
    // off this path can quote a ledger (invariant 4).
    await deps.runs.recordLedgerSyncRun({
      orgId: input.orgId,
      connectionId: connection.connectionId,
      requestedBy: input.actor.userId,
      windowFrom: window.from,
      windowTo: window.to,
      startedAt,
      finishedAt: deps.now(),
      outcome: 'failed',
      ...NOTHING,
      anomalies: [],
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    await releaseIfDead(deps, resolved, error, connection);
    throw error;
  }

  const completed = await record(
    'completed',
    {
      invoicesExamined: report.invoicesExamined,
      openedCount: report.opened.length,
      skippedCount: report.skipped.length,
      declinedCount: report.declined.length,
      anomalyCount: report.anomalies.length,
    },
    undefined,
    report.anomalies.map(toAnomalyRecord),
  );
  return { ...completed, classifiedCount: report.classified.length };
}

/**
 * After a run failed because the provider refused the stored sign-in for good,
 * turns the connection off so the company is not held from every other
 * workspace (ADR 0046) — and says what happened, in ids and one of three
 * outcomes.
 *
 * Never in the way of the failure it follows. The run row is already written
 * and the caller re-throws the original error; a release that is refused (a
 * member who is no longer an owner) or that breaks is logged by class name and
 * left for the operator's `pnpm unlink:qbo`, as before this existed.
 */
async function releaseIfDead(
  deps: LedgerSyncJobDeps,
  resolved: Extract<ResolvedLedgerSource, { kind: 'ready' }>,
  error: unknown,
  connection: LedgerConnectionRecord,
): Promise<void> {
  const dead = resolved.deadGrant?.(error);
  if (dead === undefined || deps.runs.releaseDeadConnection === undefined) return;
  const where = `connection ${connection.connectionId} for org ${connection.orgId}`;
  try {
    const outcome = await deps.runs.releaseDeadConnection({
      connectionId: connection.connectionId,
      credentialId: dead.credentialId,
      reason: dead.reason,
    });
    console.warn(
      `[recouple] ledger sync: ${where}: the provider refused its stored sign-in (${dead.reason}); ` +
        (outcome === 'released'
          ? 'released it, so nothing reads it and it can be connected again'
          : outcome === 'newer_sign_in'
            ? 'a newer sign-in was stored since, so it was left on'
            : outcome === 'already_off'
              ? 'it was already off'
              : 'it is not visible to this tenant, so nothing was changed'),
    );
  } catch (releaseError) {
    console.error(
      `[recouple] ledger sync: ${where}: the provider refused its stored sign-in (${dead.reason}), ` +
        `and releasing it failed (${releaseError instanceof Error ? releaseError.name : typeof releaseError}); ` +
        'it stays on until an owner reconnects or an operator runs `pnpm unlink:qbo`',
    );
  }
}

interface Counts {
  readonly invoicesExamined: number;
  readonly openedCount: number;
  readonly skippedCount: number;
  readonly declinedCount: number;
  readonly anomalyCount: number;
}

/** A run that read nothing. Zeroes, said once. */
const NOTHING: Counts = {
  invoicesExamined: 0,
  openedCount: 0,
  skippedCount: 0,
  declinedCount: 0,
  anomalyCount: 0,
};

function assertNamed(value: string | undefined, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LedgerSyncJobError(`a ledger sync job needs ${field}; this one has none`);
  }
}
