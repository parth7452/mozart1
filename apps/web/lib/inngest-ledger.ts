import { randomUUID } from 'node:crypto';
import { NonRetriableError, type Inngest } from 'inngest';
import type { ConcurrencyOption } from 'inngest/types';
import {
  LedgerConnectionNotFoundError,
  LedgerSyncJobError,
  syncLedgerJob,
  type LedgerSyncJobDeps,
  type LedgerSyncJobResult,
} from '@recouple/pipeline';
import { isUuid } from './request';

/**
 * The scheduled half of the Inngest binding: a cron that fans out, and a
 * function that syncs one ledger (ADR 0031 §8).
 *
 * A sibling of `./inngest.ts` rather than more of it — the two share the client,
 * the app id and the plan's concurrency ceiling, and nothing else. Everything
 * these functions actually do lives in `@recouple/pipeline` as `syncLedgerJob`,
 * a pure function over ports. This file names the schedule and the event, checks
 * the payload, builds tenant-scoped stores from it and hands off. It calls no
 * vendor and writes no row of its own.
 */

/**
 * When the fan-out fires: daily, 07:00 UTC.
 *
 * A named constant because it is a policy and not a detail — it decides how
 * stale a discovered deduction can be before anybody sees it, and it is the
 * number that has to move with `LEDGER_SYNC_WINDOW_DAYS` if the overlap is ever
 * reconsidered (ADR 0031 §6). Daily and early: a ledger read is cheap, a
 * dispute deadline is not, and 07:00 UTC is before the working day in every
 * timezone this product is sold in.
 */
export const LEDGER_SYNC_SCHEDULE = '0 7 * * *';

/** One connection wants its ledger walked. */
export const LEDGER_SYNC_REQUESTED = 'ledger/sync.requested';

/**
 * How many of one tenant's ledgers may sync at once.
 *
 * One. Two concurrent syncs of the same tenant would race on identity: each
 * reads `knownIdentifiers` before the other has written, and both open a case
 * for the same invoice (`syncLedger` reads that state once, at its start, on
 * purpose). A tenant with two connections walks them one after the other, which
 * costs minutes and is correct.
 */
export const LEDGER_SYNCS_IN_FLIGHT_PER_ORG = 1;

/**
 * How many ledgers this app may sync at once, across every tenant.
 *
 * Deliberately small, and well under `INNGEST_PLAN_CONCURRENCY_LIMIT` — a
 * function asking for more concurrency than the plan allows makes the whole app
 * fail to sync, which is not a slower schedule but no deployed function at all
 * (`./inngest.ts`). Two, so one tenant's long walk cannot hold the fleet, and
 * no higher because this shares the plan's budget with the reads, which are the
 * ones a person is waiting on.
 */
export const LEDGER_SYNCS_IN_FLIGHT = 2;

/**
 * What the event carries: ids, and one key.
 *
 * Not one row of anybody's ledger. The queue is a third party, the payload is
 * durable there, and a customer's invoices are their business (invariant 4,
 * ADR 0021). Everything the sync needs beyond this it fetches from the database
 * under the tenant's own claims.
 */
export interface LedgerSyncRequestedData {
  readonly connectionId: string;
  readonly orgId: string;
  /** The connection's `created_by`: the member the sync acts as (ADR 0031 §3). */
  readonly userId: string;
  /**
   * What makes two events the same request to sync, for the runtime's
   * idempotency window.
   *
   * Fresh per connection per firing, so the window catches only a literal
   * redelivery of one event. It is deliberately **not** the org id: keying on
   * the org would make the window swallow every deliberate re-run of that
   * tenant's sync for twenty-four hours, which is the mistake
   * `event.data.documentId` was for the read — keying on the thing being
   * recovered made the recovery indistinguishable from it (ADR 0021).
   *
   * Not a secret and not a claim: it decides nothing about who may read what.
   */
  readonly syncKey: string;
}

/** A connection the fan-out was told to sync, as ids. */
export interface SyncableConnection {
  readonly connectionId: string;
  readonly orgId: string;
  readonly createdBy: string;
}

/** The deps for one tenant, and their closing. */
export interface LedgerSyncDepsHandle {
  readonly deps: LedgerSyncJobDeps;
  close(): Promise<void>;
}

/**
 * What these functions need from the app.
 *
 * Injected rather than imported so this file depends on neither `lib/store` nor
 * `lib/ledger-sync` — and so a test can watch exactly which identity a payload
 * turns into, and exactly which events a fan-out sent.
 */
export interface LedgerSyncContext {
  /** Every enabled connection, across every org, as ids (ADR 0031 §5). */
  connectionsToSync(): Promise<readonly SyncableConnection[]>;
  /** Sends the fan-out's events. One call, so a retry re-sends the same keys. */
  send(events: readonly { name: string; data: LedgerSyncRequestedData }[]): Promise<void>;
  depsFor(identity: {
    readonly orgId: string;
    readonly userId: string;
  }): LedgerSyncDepsHandle;
}

export function ledgerSyncRequestedEvent(data: LedgerSyncRequestedData): {
  name: string;
  data: LedgerSyncRequestedData;
} {
  return { name: LEDGER_SYNC_REQUESTED, data };
}

/**
 * The event payload, checked before it is used for anything.
 *
 * Every field is about to become a tenant claim or a foreign key. A payload
 * missing one — or carrying something that is not an id — must not read as "any
 * tenant": it fails, and without a retry, because a malformed event will still
 * be malformed in thirty seconds.
 */
export function parseLedgerSyncRequested(data: unknown): LedgerSyncRequestedData {
  if (data === null || typeof data !== 'object') {
    throw new NonRetriableError(`${LEDGER_SYNC_REQUESTED} carried no payload object`);
  }
  const raw = data as Record<string, unknown>;
  return {
    connectionId: requireId(raw.connectionId, 'connectionId'),
    orgId: requireId(raw.orgId, 'orgId'),
    userId: requireId(raw.userId, 'userId'),
    syncKey: requireId(raw.syncKey, 'syncKey'),
  };
}

/**
 * Two limits, and the runtime applies both. A tuple because that is what the
 * SDK takes: at most two concurrency options per function.
 */
const LEDGER_SYNC_CONCURRENCY: [ConcurrencyOption, ConcurrencyOption] = [
  { key: 'event.data.orgId', limit: LEDGER_SYNCS_IN_FLIGHT_PER_ORG },
  // Keyless on purpose: a key makes a separate limit per value of that key,
  // which is exactly what a fleet ceiling must not be.
  { limit: LEDGER_SYNCS_IN_FLIGHT },
];

/**
 * How the runtime is asked to run the fan-out.
 *
 * Concurrency one and keyless, so two firings can never overlap: a schedule
 * that fires while the last one is still listing would send every connection's
 * event twice, and the second copies carry different `syncKey`s, so the
 * idempotency window would not collapse them.
 *
 * `retries: 1` because there is nothing expensive to retry — one query and one
 * batch of sends — and because a fan-out that keeps failing should be visible
 * rather than quietly succeeding on the fourth attempt.
 */
export const LEDGER_SYNC_FAN_OUT_CONFIG = {
  id: 'ledger-sync-fan-out',
  name: 'Fan out the daily ledger syncs',
  triggers: [{ cron: LEDGER_SYNC_SCHEDULE }],
  retries: 1 as const,
  concurrency: [{ limit: 1 }] as [ConcurrencyOption],
};

/**
 * How the runtime is asked to run one sync.
 *
 * Exported so a test can read it: these values decide what a delivery costs and
 * how much of this app's budget the runtime may spend at once, and none of them
 * shows up in the behaviour of a stubbed `step.run`.
 */
export const LEDGER_SYNC_CONFIG = {
  id: 'sync-ledger',
  name: 'Sync one accounting ledger',
  triggers: [{ event: LEDGER_SYNC_REQUESTED }],
  retries: 2 as const,
  idempotency: 'event.data.syncKey',
  concurrency: LEDGER_SYNC_CONCURRENCY,
};

export interface LedgerFanOutInvocation {
  readonly step: {
    run<T>(id: string, work: () => Promise<T>): Promise<T>;
  };
}

export interface LedgerFanOutResult {
  readonly connections: number;
}

/**
 * The fan-out, as a function of the context so a test can invoke it with a
 * stubbed `step`.
 *
 * Two steps, and the split is the point. The first lists the connections and
 * mints a `syncKey` per connection; its result is memoized, so a retry of the
 * second step re-sends *the same keys* and the runtime's idempotency window
 * collapses them into one sync each. Minting the keys in the sending step would
 * make every retry a fresh set of requests, which is a duplicate sync per
 * connection per retry.
 *
 * It sends for every enabled connection and decides nothing else: whether a
 * connection can be read, and whether its member may still write, are the
 * handler's questions, asked under that tenant's own claims (ADR 0031 §3, §7).
 *
 * What a log line may carry is the rule the payload follows: ids and counts.
 */
export function ledgerFanOutSteps(
  context: LedgerSyncContext,
): (invocation: LedgerFanOutInvocation) => Promise<LedgerFanOutResult> {
  return async ({ step }) => {
    console.log('[recouple] ledger fan-out: run entered');

    const events = await step.run('list-connections', async () => {
      const connections = await context.connectionsToSync();
      return connections.map((connection) =>
        ledgerSyncRequestedEvent({
          connectionId: connection.connectionId,
          orgId: connection.orgId,
          userId: connection.createdBy,
          syncKey: randomUUID(),
        }),
      );
    });

    console.log(`[recouple] ledger fan-out: ${events.length} enabled connection(s) to sync`);

    if (events.length > 0) {
      await step.run('send-sync-requests', async () => {
        await context.send(events);
        return events.length;
      });
    }

    console.log('[recouple] ledger fan-out: run returned');
    return { connections: events.length };
  };
}

export interface LedgerSyncInvocation {
  readonly event: { readonly data: unknown };
  readonly step: {
    run<T>(id: string, work: () => Promise<T>): Promise<T>;
  };
}

/**
 * One connection's sync: build the tenant's stores from the payload, run the
 * window, close the stores.
 *
 * The stores are `PostgresStore` and its two siblings as `app_rw` with these
 * claims — the same construction a request makes, because a cron is not a
 * privileged context. There is no service-role key in this app and this is not
 * the place one appears (invariant 6).
 *
 * One step. The sync is not split per candidate: steps do not share memory, so
 * splitting would either re-read the ledger window or ship a customer's
 * invoices between steps, and neither is something to do for a progress bar.
 *
 * **It says where it got to**, for the reason `readDocumentSteps` does: a run
 * that is invoked and never comes back to execute its step produces no error
 * anywhere, and a run line with no step line under it is the only way to see
 * that. Ids, counts and one of four outcome constants — never a reason string,
 * which can name an environment variable, and never a line of a ledger.
 */
export function ledgerSyncSteps(
  context: LedgerSyncContext,
): (invocation: LedgerSyncInvocation) => Promise<LedgerSyncJobResult> {
  return async ({ event, step }) => {
    const where = whereFor(event.data);
    console.log(`[recouple] ledger sync: run entered, ${where}`);
    const result = await step.run('sync-ledger', async () => {
      console.log(`[recouple] ledger sync: step sync-ledger entered, ${where}`);
      const synced = await runLedgerSyncRequested(event.data, context);
      console.log(
        `[recouple] ledger sync: step sync-ledger ${synced.outcome}, ${where}, ` +
          `window ${synced.window.from}..${synced.window.to}, run ${synced.runId}, ` +
          `examined ${synced.invoicesExamined}, opened ${synced.openedCount}, ` +
          `skipped ${synced.skippedCount}, declined ${synced.declinedCount}, ` +
          `anomalies ${synced.anomalyCount}` +
          // Stuck ledger cases the sweep moved to `classified` (ADR 0043 §2).
          (synced.classifiedCount === undefined ? '' : `, classified ${synced.classifiedCount}`),
      );
      if (synced.reason !== undefined) {
        // The reason, in this deployment's own logs and nowhere else: it names
        // the environment variable that is missing, which is what makes a
        // `not_configured` run fixable, and it is not something to keep in a
        // durable row (ADR 0031 §2).
        console.warn(
          `[recouple] ledger sync: ${synced.outcome} for connection ${synced.connectionId}: ${synced.reason}`,
        );
      }
      return synced;
    });
    console.log(`[recouple] ledger sync: run returned, ${where}`);
    return result;
  };
}

/** The job, from a payload: parse, build the stores, run, close. */
export async function runLedgerSyncRequested(
  data: unknown,
  context: LedgerSyncContext,
): Promise<LedgerSyncJobResult> {
  const payload = parseLedgerSyncRequested(data);
  const handle = context.depsFor({ orgId: payload.orgId, userId: payload.userId });
  try {
    return await syncLedgerJob(handle.deps, {
      connectionId: payload.connectionId,
      orgId: payload.orgId,
      actor: { userId: payload.userId },
    });
  } catch (error) {
    throw asLedgerSyncFailure(error, {
      connectionId: payload.connectionId,
      orgId: payload.orgId,
    });
  } finally {
    await handle.close();
  }
}

/** The two functions this file serves. */
export function ledgerSyncFunctions(client: Inngest, context: LedgerSyncContext) {
  return [
    client.createFunction(LEDGER_SYNC_FAN_OUT_CONFIG, ledgerFanOutSteps(context)),
    client.createFunction(LEDGER_SYNC_CONFIG, ledgerSyncSteps(context)),
  ];
}

/**
 * Which failures are worth trying again, and what may be said about them.
 *
 * Nothing is swallowed: every one of these still fails the run. The question is
 * only whether repeating it could answer differently. A malformed payload and a
 * connection this tenant cannot see are settled facts — a connection does not
 * appear because we asked twice. Everything else — a timeout, a 500 from
 * Intuit, a database that blinked — is left retriable, which is the default,
 * and the trailing window means the next day's run covers what a give-up
 * missed.
 *
 * **What the message says.** The class name and the two ids this job already
 * holds, and never the original message. An error raised while reading somebody
 * else's books can quote them, and a message travels to a third party's run
 * history and sits there for its retention period — which is exactly what the
 * event payload is careful not to do (invariant 4). The cause is dropped for the
 * same reason: a serialised cause chain carries the message we just replaced.
 *
 * The original is not lost. It is logged here, in full, in this platform's own
 * logs rather than a third party's.
 */
export function asLedgerSyncFailure(
  error: unknown,
  ids: { readonly connectionId: string; readonly orgId: string },
): unknown {
  const settled =
    error instanceof LedgerSyncJobError || error instanceof LedgerConnectionNotFoundError;

  const name = error instanceof Error ? error.name : typeof error;
  const message =
    `${name} syncing connection ${ids.connectionId} for org ${ids.orgId}`;

  console.error(`[recouple] ledger sync failed: ${message}`, error);

  return settled ? new NonRetriableError(message) : new Error(message);
}

/**
 * The two ids a log line names, when they are ids.
 *
 * Read off the raw payload rather than out of `parseLedgerSyncRequested`, so
 * the first line is written before anything can throw — a malformed payload is
 * exactly the case where knowing a run was entered is worth something. A value
 * that is not a UUID is printed as `unknown` rather than printed.
 */
function whereFor(data: unknown): string {
  const raw = data === null || typeof data !== 'object' ? {} : (data as Record<string, unknown>);
  const connectionId = isUuid(raw.connectionId) ? raw.connectionId : 'unknown';
  const orgId = isUuid(raw.orgId) ? raw.orgId : 'unknown';
  return `connection ${connectionId} org ${orgId}`;
}

function requireId(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new NonRetriableError(
      `${LEDGER_SYNC_REQUESTED} needs ${field} to be an id; this one is ${JSON.stringify(value)}`,
    );
  }
  return value;
}
