import { randomUUID } from 'node:crypto';
import { NonRetriableError, RetryAfterError, type Inngest } from 'inngest';
import type { ConcurrencyOption } from 'inngest/types';
import { PORTAL_TERMS_ALLOWED } from '@recouple/core-domain';
import { scannerFromEnv } from '@recouple/ingest';
import {
  PORTAL_ENV,
  PORTAL_READ_TOKEN_MIN_LENGTH,
  PORTAL_RUN_REQUEST_MAX_BYTES,
  PORTAL_WORKER_ROUTES,
  PortalWorkerErrorBodySchema,
  RunCaptureSchema,
  RunHandleSchema,
  RunRequestSchema,
  RunResultSchema,
  bindingOf,
  type PortalWorkerErrorCode,
  type RecipeVersion,
  type RunCapture,
  type RunHandle,
  type RunRequest,
  type RunResult,
} from '@recouple/portal';
import {
  PortalRunAlertError,
  PortalRunLostError,
  PortalWorkerBusyError,
  PortalWorkerContractError,
  PortalWorkerRefusedError,
  PortalWorkerUnavailableError,
  isSettledPortalReadError,
  portalReadRetryAfterMs,
  readPortalJob,
  type PortalJobSteps,
  type PortalReadJobDeps,
  type PortalReadJobResult,
  type PortalWorkerClient,
  type ResolvedPortalWorker,
} from '@recouple/pipeline';
import {
  PortalStoreError,
  PostgresPortalStore,
  listPortalConnectionsToRead,
} from '@recouple/store-postgres';
import { env } from './env';
import { inngestKeysFromEnv, readRequestedEvent } from './inngest';
import { PORTAL_READ_REQUESTED } from './portals';
import { isUuid } from './request';
import { tenantStore } from './store';

/**
 * The portal read's half of the Inngest binding (ADR 0057 §6, §13; ADR 0062):
 * whether this deployment has a worker, the worker's HTTP client, the function
 * that runs one read, and a fan-out that nothing schedules.
 *
 * Everything a read does is `readPortalJob` in @recouple/pipeline, a pure
 * function over ports, the steps among them. This file checks the event,
 * builds the acting member's stores and the worker's client, turns Inngest's
 * steps into the job's, and hands off. It writes no row of its own, and it
 * holds no credential: what it sends the worker is the sealed row, as stored.
 *
 * **What leaves here.** A step's return value and a failure's message are
 * durable in a third party's run history (ADR 0021), so both are ids, codes,
 * counts and class names. A log line is the same, and never a URL, a token, a
 * filename or an error's message: an error off this path can quote a page.
 */

// ---------------------------------------------------------------------------
// Whether this deployment reads portals at all (ADR 0057 §6, ADR 0062 §6)
// ---------------------------------------------------------------------------

/**
 * The worker's binding, decided in one place (`scannerFromEnv`'s shape, ADR
 * 0018): both variables, a queue and a production deployment give a binding;
 * neither variable gives none; anything between is misconfigured and says
 * what, by name and never by value. Either of the last two is a run recorded
 * `not_configured` (`PortalWorkerNotConfiguredError`).
 */
export type PortalReadBinding =
  | { readonly kind: 'none' }
  | { readonly kind: 'misconfigured'; readonly reason: string }
  | { readonly kind: 'bound'; readonly url: string; readonly token: string };

/** `Record` rather than `NodeJS.ProcessEnv`, for `ledger-sync.ts`'s reason: a test names only what it sets. */
export type PortalReadEnv = Readonly<Record<string, string | undefined>>;

/** The worker's bearer token as the worker accepts one: printable ASCII, no spaces. */
const TOKEN_CHARACTERS = /^[\x21-\x7e]+$/;

/** A host this machine is, where plain HTTP carries the token nowhere. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Production only. The worker's two variables are set for Production alone
 * (`docs/plans/ariba-portal/README.md`, step 6), and a preview holds no
 * Inngest keys (`docs/supabase.md`), so a preview never starts a read; a
 * preview that somehow held all three is refused here as well, by name. The
 * URL is the worker's origin, over HTTPS (plain HTTP only on this machine,
 * where the bearer token crosses no network).
 */
export function portalReadFromEnv(environment: PortalReadEnv = process.env): PortalReadBinding {
  const url = (environment[PORTAL_ENV.readUrl] ?? '').trim();
  const token = environment[PORTAL_ENV.readToken] ?? '';
  if (url === '' && token === '') return { kind: 'none' };
  if (url === '' || token === '') {
    const [missing, present] =
      url === '' ? [PORTAL_ENV.readUrl, PORTAL_ENV.readToken] : [PORTAL_ENV.readToken, PORTAL_ENV.readUrl];
    return { kind: 'misconfigured', reason: `${missing} is not set, and ${present} is` };
  }
  if (environment.VERCEL_ENV === 'preview') {
    return {
      kind: 'misconfigured',
      reason: `${PORTAL_ENV.readUrl} and ${PORTAL_ENV.readToken} are Production only, and this is a preview`,
    };
  }
  if (token.length < PORTAL_READ_TOKEN_MIN_LENGTH || !TOKEN_CHARACTERS.test(token)) {
    return {
      kind: 'misconfigured',
      reason:
        `${PORTAL_ENV.readToken} is not ${PORTAL_READ_TOKEN_MIN_LENGTH} or more printable characters ` +
        '(use openssl rand -hex 32, and the same value as the worker)',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'misconfigured', reason: `${PORTAL_ENV.readUrl} is not a URL` };
  }
  const secure =
    parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname));
  if (!secure) {
    return {
      kind: 'misconfigured',
      reason: `${PORTAL_ENV.readUrl} is not https: the bearer token would cross the network in the clear`,
    };
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return {
      kind: 'misconfigured',
      reason: `${PORTAL_ENV.readUrl} is the worker’s origin, with no credentials, path, query or fragment`,
    };
  }
  let keys;
  try {
    keys = inngestKeysFromEnv(environment as NodeJS.ProcessEnv);
  } catch {
    return { kind: 'misconfigured', reason: 'the Inngest binding is half-configured' };
  }
  if (keys === undefined) {
    return {
      kind: 'misconfigured',
      reason: 'a portal read runs only as a job, and this deployment has no Inngest keys',
    };
  }
  return { kind: 'bound', url: parsed.origin, token };
}

/** The job's answer from the binding: a client, or why there is none. */
export function portalWorkerFor(
  binding: PortalReadBinding,
  client: (config: PortalWorkerHttpConfig) => PortalWorkerClient<RecipeVersion> = (config) =>
    new HttpPortalWorkerClient(config),
): ResolvedPortalWorker<RecipeVersion> {
  if (binding.kind === 'bound') {
    return { kind: 'ready', client: client({ url: binding.url, token: binding.token }) };
  }
  return {
    kind: 'not_configured',
    reason:
      binding.kind === 'none'
        ? `${PORTAL_ENV.readUrl} and ${PORTAL_ENV.readToken} are not set`
        : binding.reason,
  };
}

// ---------------------------------------------------------------------------
// The worker, over HTTP (contracts.ts: the worker's routes)
// ---------------------------------------------------------------------------

export interface PortalWorkerHttpConfig {
  /** The worker's origin (`portalReadFromEnv`'s). */
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** For a start, a state and a result. */
  readonly timeoutMs?: number;
  /** For one capture, whose bytes can be a download's. */
  readonly captureTimeoutMs?: number;
}

type WorkerRoute = keyof typeof PORTAL_WORKER_ROUTES;

/** What this file asks of a contract schema: its answer, and on refusal the fields it names. */
interface ContractSchema<T> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: SchemaRefusal };
}

interface SchemaRefusal {
  readonly issues: readonly { readonly path: readonly PropertyKey[] }[];
}

interface WorkerAnswer {
  readonly status: number;
  readonly json: unknown;
  /** The contract's error code, when the body was one. Never the body. */
  readonly code: PortalWorkerErrorCode | undefined;
}

/**
 * `services/portal-read`, as the job sees it (ADR 0057 §6). Every answer is
 * parsed by the contract's own schema, and every refusal becomes one of the
 * job's named errors, carrying a route, a status and the contract's code:
 * never a body, the token or the worker's address. A redirect is refused
 * rather than followed, so the token goes to the worker's origin and nowhere
 * else.
 *
 * It holds no plaintext: the request it sends is the credential row's sealed
 * columns and binding, which only the worker's `kms:Decrypt` opens.
 */
export class HttpPortalWorkerClient implements PortalWorkerClient<RecipeVersion> {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly captureTimeoutMs: number;

  constructor(private readonly config: PortalWorkerHttpConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.captureTimeoutMs = config.captureTimeoutMs ?? 60_000;
  }

  async startRun(request: RunRequest): Promise<RunHandle> {
    const checked = RunRequestSchema.safeParse(request);
    if (!checked.success) {
      throw new PortalWorkerContractError(
        String(request.runId),
        `the run request is not one the contract admits (${fieldsOf(checked.error)})`,
      );
    }
    const body = JSON.stringify(checked.data);
    if (Buffer.byteLength(body, 'utf8') > PORTAL_RUN_REQUEST_MAX_BYTES) {
      throw new PortalWorkerContractError(request.runId, 'the run request is over the contract’s ceiling');
    }
    const answer = await this.call('startRun', PORTAL_WORKER_ROUTES.startRun.path, this.timeoutMs, body);
    if (answer.status === 200 || answer.status === 202) {
      return this.parsed(RunHandleSchema, answer, request.runId, 'startRun');
    }
    if (answer.code === 'busy') throw new PortalWorkerBusyError(request.runId);
    throw refusalOf('startRun', answer);
  }

  async runState(runId: string): Promise<RunHandle> {
    const answer = await this.call('runState', pathFor('runState', runId), this.timeoutMs);
    if (answer.status === 200) return this.parsed(RunHandleSchema, answer, runId, 'runState');
    throw this.failureOf('runState', runId, answer);
  }

  async runResult(runId: string): Promise<RunResult> {
    const answer = await this.call('runResult', pathFor('runResult', runId), this.timeoutMs);
    if (answer.status === 200) return this.parsed(RunResultSchema, answer, runId, 'runResult');
    throw this.failureOf('runResult', runId, answer);
  }

  async capture(runId: string, index: number): Promise<RunCapture> {
    if (!Number.isInteger(index) || index < 0) {
      throw new PortalWorkerContractError(runId, 'a capture is asked for by a whole index from 0');
    }
    const answer = await this.call('capture', pathFor('capture', runId, index), this.captureTimeoutMs);
    if (answer.status === 200) return this.parsed(RunCaptureSchema, answer, runId, 'capture');
    throw this.failureOf('capture', runId, answer);
  }

  /** A run's route that did not answer 200: a run it no longer holds is lost; the rest by status. */
  private failureOf(route: WorkerRoute, runId: string, answer: WorkerAnswer): Error {
    if (answer.status === 404) return new PortalRunLostError(runId);
    // Asked of a run it says is still running: the step asks again.
    if (answer.status === 409) return new PortalWorkerUnavailableError(route, 'http', 409);
    return refusalOf(route, answer);
  }

  private parsed<T>(schema: ContractSchema<T>, answer: WorkerAnswer, runId: string, route: WorkerRoute): T {
    const checked = schema.safeParse(answer.json);
    if (!checked.success) {
      throw new PortalWorkerContractError(runId, `the worker’s answer to ${route} is not the contract’s`);
    }
    return checked.data;
  }

  private async call(route: WorkerRoute, path: string, timeoutMs: number, body?: string): Promise<WorkerAnswer> {
    const { method } = PORTAL_WORKER_ROUTES[route];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(new URL(path, this.config.url), {
          method,
          headers: {
            authorization: `Bearer ${this.config.token}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          // The token goes to the worker's origin and nowhere else.
          redirect: 'error',
          cache: 'no-store',
          signal: abort.signal,
        });
      } catch {
        // The fetch's own error can name the URL: only which kind it was is said.
        throw new PortalWorkerUnavailableError(route, abort.signal.aborted ? 'timeout' : 'network');
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new PortalWorkerUnavailableError(route, abort.signal.aborted ? 'timeout' : 'network');
      }
      let json: unknown;
      try {
        json = text === '' ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      const error = PortalWorkerErrorBodySchema.safeParse(json);
      return { status: response.status, json, code: error.success ? error.data.error : undefined };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A status that is not an answer: the worker refused the request, or had no answer to give. */
function refusalOf(route: WorkerRoute, answer: WorkerAnswer): Error {
  if (answer.status >= 500) return new PortalWorkerUnavailableError(route, 'http', answer.status);
  return new PortalWorkerRefusedError(route, answer.status, answer.code);
}

function pathFor(route: 'runState' | 'runResult' | 'capture', runId: string, index?: number): string {
  if (!isUuid(runId)) throw new PortalWorkerContractError(String(runId), 'a run is asked for by its id');
  const path = PORTAL_WORKER_ROUTES[route].path.replace(':runId', encodeURIComponent(runId.toLowerCase()));
  return index === undefined ? path : path.replace(':index', String(index));
}

/** A schema's refusal as the fields it names, never the values it saw. */
function fieldsOf(error: SchemaRefusal): string {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? '(body)')))].join(', ');
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * One read of one connection, as this function reads the event: Settings →
 * Portals' dry run (`queuePortalDryRun` in `./portals`, which sends
 * `PORTAL_READ_REQUESTED`) or the fan-out's read. Ids, a flag and a key, and
 * never a credential, a recipe or a page (ADR 0021).
 */
export interface PortalReadRequest {
  readonly connectionId: string;
  readonly orgId: string;
  /** The connection's `created_by`: every run acts as that member (ADR 0057 §13), never whoever pressed. */
  readonly userId: string;
  /** ADR 0057 §3's dry run: nothing captured or stored. Required: a read that captures says so. */
  readonly dryRun: boolean;
  /** A dry run of the version an owner named. A read that captures runs the promoted one and names none. */
  readonly recipeVersionId?: string;
  /** Fresh per request, for the runtime's idempotency window: a redelivery is one run, a second press a second. */
  readonly runKey: string;
}

/**
 * The payload, checked before it becomes a tenant's claims. A malformed one
 * fails without a retry: it will be malformed in thirty seconds too. Ids are
 * lower-cased, as the contract and the database spell them.
 */
export function parsePortalReadRequested(data: unknown): PortalReadRequest {
  if (data === null || typeof data !== 'object') {
    throw new NonRetriableError(`${PORTAL_READ_REQUESTED} carried no payload object`);
  }
  const raw = data as Record<string, unknown>;
  const id = (field: string): string => {
    const value = raw[field];
    if (!isUuid(value)) {
      throw new NonRetriableError(`${PORTAL_READ_REQUESTED} needs ${field} to be an id`);
    }
    return value.toLowerCase();
  };
  const connectionId = id('connectionId');
  const orgId = id('orgId');
  const userId = id('userId');
  const runKey = id('runKey');
  if (typeof raw.dryRun !== 'boolean') {
    throw new NonRetriableError(`${PORTAL_READ_REQUESTED} needs dryRun to say whether the read captures`);
  }
  const dryRun = raw.dryRun;
  if (raw.recipeVersionId === undefined || raw.recipeVersionId === null) {
    return { connectionId, orgId, userId, dryRun, runKey };
  }
  if (!dryRun) {
    throw new NonRetriableError(
      `${PORTAL_READ_REQUESTED} names a recipe version for a read that captures, which runs the promoted one`,
    );
  }
  return { connectionId, orgId, userId, dryRun, recipeVersionId: id('recipeVersionId'), runKey };
}

// ---------------------------------------------------------------------------
// The functions' configuration
// ---------------------------------------------------------------------------

/**
 * How many portal reads this app runs at once, across every tenant: one. The
 * worker runs one browser at a time and answers another start `busy`, so a
 * higher number would only queue there (ADR 0057 §6). Well under
 * `INNGEST_PLAN_CONCURRENCY_LIMIT`, whose excess makes the whole app fail to
 * sync. A run between polls holds no slot, so a second read can still reach a
 * busy worker; its start is then asked again later (`PortalWorkerBusyError`).
 */
export const PORTAL_READS_IN_FLIGHT = 1;

/**
 * One read, from Settings → Portals or the fan-out.
 *
 * - One per connection in flight (ADR 0057 §13), and one across the fleet.
 * - Idempotent on the request's own key, never the connection's: keyed on the
 *   connection, a second press inside the window would be swallowed as the
 *   first (ADR 0021).
 * - `retries: 3` is per step: a busy worker's start is asked four times, a
 *   minute and a half apart; a transient database or network fault the same.
 *   A refused sign-in is never among them: it is an outcome, recorded once,
 *   and the connection is turned off (ADR 0057 §8).
 */
export const PORTAL_READ_CONFIG = {
  id: 'read-portal',
  name: 'Read one payer portal',
  triggers: [{ event: PORTAL_READ_REQUESTED }],
  retries: 3 as const,
  idempotency: 'event.data.runKey',
  concurrency: [
    { key: 'event.data.connectionId', limit: 1 },
    { limit: PORTAL_READS_IN_FLIGHT },
  ] as [ConcurrencyOption, ConcurrencyOption],
};

/** Sent by hand from the Inngest dashboard, never by the app: it starts a read that captures for every enabled connection. */
export const PORTAL_READ_FAN_OUT_REQUESTED = 'portal/read.fan-out.requested';

/**
 * The fan-out of ADR 0057 §13, with no schedule. ADR 0062 §4 gives SAP
 * Business Network none ("a sign-in is a login event on a real account, and
 * nothing is gained by repeating it daily"), and a recipe's schedule field
 * does not exist yet, so nothing triggers this but an operator sending
 * `PORTAL_READ_FAN_OUT_REQUESTED`. Each read it starts captures, and runs the
 * connection's promoted version under every refusal a dry run meets, the
 * terms gate first.
 *
 * Concurrency one and keyless, so two firings never overlap, and `retries: 1`:
 * one query and one batch of sends, whose keys are minted in a memoized step
 * so a retry re-sends the same ones (`inngest-ledger.ts`'s reason).
 */
export const PORTAL_READ_FAN_OUT_CONFIG = {
  id: 'portal-read-fan-out',
  name: 'Fan out the portal reads',
  triggers: [{ event: PORTAL_READ_FAN_OUT_REQUESTED }],
  retries: 1 as const,
  concurrency: [{ limit: 1 }] as [ConcurrencyOption],
};

// ---------------------------------------------------------------------------
// The context: what these functions need from the app
// ---------------------------------------------------------------------------

/** A connection the fan-out reads, as ids (`app.portal_connections_to_read()`). */
export interface ReadableConnection {
  readonly connectionId: string;
  readonly orgId: string;
  readonly createdBy: string;
}

export interface PortalReadDepsHandle {
  readonly deps: PortalReadJobDeps<RecipeVersion>;
  close(): Promise<void>;
}

/** Injected rather than imported, so a test sees which member a payload became and what was sent. */
export interface PortalReadContext {
  /** Every enabled connection, across every org, as ids. */
  connectionsToRead(): Promise<readonly ReadableConnection[]>;
  /** Sends events. One call, so a retry re-sends the same ones. */
  send(events: readonly { readonly name: string; readonly data: object }[]): Promise<void>;
  depsFor(identity: { readonly orgId: string; readonly userId: string }): PortalReadDepsHandle;
}

/**
 * The stores and the worker a read runs through, for one member of one
 * tenant: `PostgresPortalStore` and `PostgresStore` as `app_rw` with those
 * claims, the same construction a request makes. A job is not a privileged
 * context, and the service-role key appears nowhere (invariant 6).
 *
 * The portal store is built with no cipher: the job never seals, and nothing
 * here can open (ADR 0057 §7). The terms are core-domain's deployed data
 * (ADR 0057 §2), and the binding is the portal package's one computation.
 */
export function portalReadDepsFor(
  identity: { readonly orgId: string; readonly userId: string },
  send: PortalReadContext['send'],
  binding: PortalReadBinding = portalReadFromEnv(),
): PortalReadDepsHandle {
  if (binding.kind === 'misconfigured') {
    console.error(`[recouple] portal read: the worker is misconfigured: ${binding.reason}`);
  }
  const documents = tenantStore(identity);
  const store = new PostgresPortalStore({ connectionString: env.databaseUrl }, identity);
  return {
    deps: {
      store,
      worker: portalWorkerFor(binding),
      terms: PORTAL_TERMS_ALLOWED,
      bindingOf,
      ingest: { store: documents, scanner: scannerFromEnv() },
      // Each stored capture is read like an upload, by the read-document job,
      // as the member the run acted as; the read holds a notice `by_portal`
      // (ADR 0057 §10). The document id is the key, so a redelivery is one read.
      requestReads: async (documentIds) => {
        await send(
          documentIds.map((documentId) =>
            readRequestedEvent({ documentId, orgId: identity.orgId, userId: identity.userId, readKey: documentId }),
          ),
        );
      },
    },
    async close(): Promise<void> {
      // The pools are shared per connection string and outlive a job
      // (`sessionPool`), so this is the no-op `ledgerSyncDepsFor`'s is; called
      // so a store that ever holds something per instance is released here.
      await documents.close();
    },
  };
}

/** The production context, over this app's Inngest client. */
export function portalReadContext(
  send: PortalReadContext['send'],
): PortalReadContext {
  return {
    connectionsToRead: () => listPortalConnectionsToRead({ connectionString: env.databaseUrl }),
    send,
    depsFor: (identity) => portalReadDepsFor(identity, send),
  };
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

export interface PortalReadInvocation {
  readonly event: { readonly data: unknown };
  readonly step: {
    run<T>(id: string, work: () => Promise<T>): Promise<T>;
    sleep(id: string, time: number): Promise<void>;
  };
}

/**
 * One read: parse the event, build the member's deps, run the job over
 * Inngest's steps, close.
 *
 * **It says where it got to**, as `readDocumentSteps` does: a run line with
 * no outcome line under it is a stall that shows. Ids, the outcome and its
 * code, counts and a class name; `why` only for a run that did not start,
 * where it names a variable or a refusal and never a value.
 */
export function portalReadSteps(
  context: PortalReadContext,
): (invocation: PortalReadInvocation) => Promise<PortalReadJobResult> {
  return async ({ event, step }) => {
    const where = whereFor(event.data);
    console.log(`[recouple] portal read: run entered, ${where}`);
    const payload = parsePortalReadRequested(event.data);
    let handle: PortalReadDepsHandle;
    try {
      handle = context.depsFor({ orgId: payload.orgId, userId: payload.userId });
    } catch (error) {
      throw asPortalReadFailure(error, payload);
    }
    try {
      const result = await readPortalJob(
        handle.deps,
        {
          connectionId: payload.connectionId,
          orgId: payload.orgId,
          actor: { userId: payload.userId },
          dryRun: payload.dryRun,
          ...(payload.recipeVersionId !== undefined ? { recipeVersionId: payload.recipeVersionId } : {}),
        },
        portalSteps(step, where),
      );
      console.log(`[recouple] portal read: run ${result.runId} ${describe(result)}, ${where}`);
      if (result.why !== undefined) {
        console.warn(`[recouple] portal read: run ${result.runId} ${result.outcome}, ${where}: ${result.why}`);
      }
      return result;
    } catch (error) {
      throw asPortalReadFailure(error, payload);
    } finally {
      await handle.close();
    }
  };
}

export interface PortalFanOutInvocation {
  readonly step: {
    run<T>(id: string, work: () => Promise<T>): Promise<T>;
  };
}

/**
 * The fan-out: list, mint a key per connection in the same memoized step, and
 * send. It decides nothing about a connection: whether it may be read is the
 * read's question, asked under that tenant's own claims.
 */
export function portalFanOutSteps(
  context: PortalReadContext,
): (invocation: PortalFanOutInvocation) => Promise<{ readonly connections: number }> {
  return async ({ step }) => {
    console.log('[recouple] portal fan-out: run entered');
    const events = await step.run('list-connections', async () => {
      const connections = await context.connectionsToRead();
      return connections.map((connection) =>
        portalReadEvent({
          connectionId: connection.connectionId,
          orgId: connection.orgId,
          userId: connection.createdBy,
          dryRun: false,
          runKey: randomUUID(),
        }),
      );
    });
    console.log(`[recouple] portal fan-out: ${events.length} enabled connection(s) to read`);
    if (events.length > 0) {
      await step.run('send-read-requests', async () => {
        await context.send(events);
        return events.length;
      });
    }
    console.log('[recouple] portal fan-out: run returned');
    return { connections: events.length };
  };
}

/** A read of one connection, as the fan-out sends it. Settings sends its own dry run (`./portals`). */
export function portalReadEvent(data: PortalReadRequest): { name: string; data: PortalReadRequest } {
  return { name: PORTAL_READ_REQUESTED, data };
}

/** The two functions this file serves. */
export function portalReadFunctions(client: Inngest, context: PortalReadContext) {
  return [
    client.createFunction(PORTAL_READ_FAN_OUT_CONFIG, portalFanOutSteps(context)),
    client.createFunction(PORTAL_READ_CONFIG, portalReadSteps(context)),
  ];
}

// ---------------------------------------------------------------------------
// Failures: what may be said, and whether to ask again
// ---------------------------------------------------------------------------

/** A step's failure the runtime asks again after a wait, named as the original. */
class PortalStepRetryAfterError extends RetryAfterError {
  constructor(name: string, message: string, retryAfterMs: number) {
    super(message, retryAfterMs);
    this.name = name;
  }
}

/** A failure the runtime does not ask again, named as the original. */
class PortalSettledError extends NonRetriableError {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** A step's failure the runtime asks again, named as the original. */
class PortalStepError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/**
 * Inngest's steps as the job's. Every failure inside a step leaves it as a new
 * error with the original's class name (which the job records, if it comes to
 * that) and a message of ids: the original's message and cause stay here,
 * because a step's error is durable in the runtime's history and an error off
 * this path can quote a page. Whether it is asked again is decided by what it
 * was: a busy worker after a wait, a settled refusal never, anything else as
 * the function's `retries` allow.
 */
export function portalSteps(step: PortalReadInvocation['step'], where: string): PortalJobSteps {
  return {
    run: <T>(id: string, work: () => Promise<T>): Promise<T> =>
      step.run(id, async () => {
        try {
          return await work();
        } catch (error) {
          throw stepFailure(error, id, where);
        }
      }),
    sleep: (id: string, ms: number) => step.sleep(id, ms),
  };
}

function stepFailure(error: unknown, stepId: string, where: string): Error {
  const name = classNameOf(error);
  const message = `${name} in step ${stepId}, ${where}`;
  const retryAfterMs = portalReadRetryAfterMs(error);
  if (retryAfterMs !== undefined) {
    console.warn(`[recouple] portal read: ${message}; asking again later`);
    return new PortalStepRetryAfterError(name, message, retryAfterMs);
  }
  const settled = isSettled(error);
  console.error(`[recouple] portal read: ${message}${settled ? '' : '; asking again'}${framesOf(error)}`);
  return settled ? new PortalSettledError(name, message) : new PortalStepError(name, message);
}

/**
 * The function's own failure: always final, because every step it ran has
 * already been asked again as often as it will be, and nothing outside a step
 * would answer differently. A recorded end that reaches a person keeps its
 * name (`PortalCredentialRejectedError`, `PortalSessionExpiredError`,
 * `PortalRunFailedError`), which is what the failed-run email says; its
 * message is ids and codes. Anything else is said by its class name and the
 * payload's ids.
 */
export function asPortalReadFailure(
  error: unknown,
  ids: { readonly connectionId: string; readonly orgId: string },
): Error {
  if (error instanceof PortalRunAlertError) {
    console.warn(`[recouple] portal read: ${error.message}`);
    return new PortalSettledError(error.name, error.message);
  }
  const name = classNameOf(error);
  const message = `${name} reading portal connection ${ids.connectionId} for org ${ids.orgId}`;
  console.error(`[recouple] portal read failed: ${message}${framesOf(error)}`);
  return new PortalSettledError(name, message);
}

/**
 * What the runtime should not ask again: the job's own settled refusals, a
 * store's named refusal (a policy, a trigger or a check, which answer the
 * same every time), and a check constraint the store did not name.
 */
function isSettled(error: unknown): boolean {
  return (
    isSettledPortalReadError(error) ||
    error instanceof PortalStoreError ||
    (error as { code?: unknown } | null)?.code === '23514'
  );
}

/** A class name as `error_class` and the alert email admit one; anything else is `Error`. */
function classNameOf(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return typeof name === 'string' && name.length <= 100 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? name
    : 'Error';
}

/**
 * Where an error was thrown: the stack's frames and nothing of its message,
 * which can span lines. For this platform's own log, never the runtime's.
 */
function framesOf(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return '';
  const frames = error.stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 8);
  return frames.length === 0 ? '' : `\n${frames.join('\n')}`;
}

/** An outcome in a line: the outcome, its code or class, where it stopped, and the counts. */
function describe(result: PortalReadJobResult): string {
  const code = 'reason' in result ? ` (${result.reason})` : 'errorClass' in result ? ` (${result.errorClass})` : '';
  const at = result.atStep === null ? '' : ` at step ${result.atStep}`;
  const { pages, captures, newDocuments, deduplicated, refusals } = result.counts;
  return (
    `${result.outcome}${code}${at}, ${result.dryRun ? 'dry run' : 'captures'}, ` +
    `pages ${pages}, captures ${captures}, new ${newDocuments}, deduplicated ${deduplicated}, ` +
    `refusals ${refusals}, reads asked ${result.documentIds.length}` +
    (result.disabled === undefined ? '' : `, connection ${result.disabled}`)
  );
}

/**
 * The two ids a log line names, read off the raw payload so the first line is
 * written before anything can throw. A value that is not an id is `unknown`.
 */
function whereFor(data: unknown): string {
  const raw = data === null || typeof data !== 'object' ? {} : (data as Record<string, unknown>);
  const connectionId = isUuid(raw.connectionId) ? raw.connectionId.toLowerCase() : 'unknown';
  const orgId = isUuid(raw.orgId) ? raw.orgId.toLowerCase() : 'unknown';
  return `connection ${connectionId} org ${orgId}`;
}
