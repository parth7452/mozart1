// The worker's HTTP front door (ADR 0057 §6): the contract's five routes,
// every one but `/health` behind the bearer token, compared in constant time.
//
//  - POST /runs starts a run and answers its handle, 202 for a new run and 200
//    for an id it already holds, which it never starts again. A run refused
//    before decrypt (a binding mismatch among them) is created already done.
//    One run is in flight at a time, and another is 503 `busy`.
//  - GET /runs/:runId answers the handle, /result the result once the run is
//    done, and /captures/:index one capture with its bytes.
//
// The worker holds no database credential and no model key. It opens a sealed
// credential only for the binding of the recipe it runs, types it only into the
// bound forms, and keeps the plaintext for that run alone. Every browser starts
// from an empty profile, and nothing records it: no trace, HAR, video or
// screenshot. A log line carries ids, codes, counts and step names.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TokenCipher } from '@recouple/crypto';
import { TotpSteps } from './credentials';
import { PUBLIC_DESTINATIONS_ONLY, type DestinationPolicy } from './destinations';
import { bearerCheck, readBody, refuseTooLarge, sendCapture, sendError, sendJson } from './http';
import { errorClassOf, type WorkerLog } from './log';
import {
  PORTAL_RUN_REQUEST_MAX_BYTES,
  PORTAL_WORKER_RESULT_TTL_MS,
  PORTAL_WORKER_ROUTES,
  RunHandleSchema,
  RunRequestSchema,
  runRecipe,
  type Resolver,
  type RunHandle,
  type RunRequest,
  type RunResult,
} from './portal';
import { WORKER_ERROR_CLASSES, beforeDecrypt, endedWith, executeRun, failedWith, runCapMs, type EndedRun, type RunRecipe } from './run';
import { RunRegistry, type HeldRun } from './runs';

/**
 * The largest capture the worker holds: the door's own ceiling, @recouple/ingest's
 * `MAX_UPLOAD_BYTES`, past which ingest would refuse it anyway. It is restated
 * here, and a test holds the two equal, so the process that holds decrypted
 * credentials does not load the door's parsers to learn one number.
 */
export const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

export interface WorkerLimits {
  /** How long a finished run's result and captures are held: the contract's TTL. */
  readonly resultTtlMs: number;
  /** The longest a run may take, whatever its recipe's `maxRunMs` says. The runner is handed the lower of the two. */
  readonly runCeilingMs: number;
  /** How long past its cap (the recipe's, or the ceiling) a run may go before it is ended as overran. */
  readonly overrunGraceMs: number;
  /** How long after that the worker waits for the run's browser to close before it stops (`onStuck`). */
  readonly stuckExitMs: number;
  /** How many forgotten run ids are kept, so a retried start never runs twice. */
  readonly maxForgotten: number;
  /** The largest capture held. Larger ends the run `failed` (`PortalCaptureTooLargeError`), and none of its captures is offered. */
  readonly maxCaptureBytes: number;
  /** The most one run's captures may hold together. More ends the run `failed` (`PortalRunCapturesTooLargeError`). */
  readonly maxRunCaptureBytes: number;
  /**
   * The most capture bytes held across every finished run. Past it, other
   * runs' captures are let go to make room for the newest (runs.ts), and a
   * job that asks for one then records its run failed. At least
   * `maxRunCaptureBytes`, so a run's own captures always fit.
   */
  readonly maxHeldCaptureBytes: number;
}

/**
 * On a 2 GB machine: the browser is closed by the time a run's captures are
 * held, a run holds at most 128 MB, every finished run 256 MB together, and a
 * capture is base64'd a piece at a time as it is sent.
 */
export const WORKER_LIMITS: WorkerLimits = {
  resultTtlMs: PORTAL_WORKER_RESULT_TTL_MS,
  runCeilingMs: 30 * 60_000,
  overrunGraceMs: 2 * 60_000,
  stuckExitMs: 60_000,
  maxForgotten: 10_000,
  maxCaptureBytes: MAX_CAPTURE_BYTES,
  maxRunCaptureBytes: 128 * 1024 * 1024,
  maxHeldCaptureBytes: 256 * 1024 * 1024,
};

export interface WorkerOptions {
  readonly token: string;
  /** This worker's portal key: the ARN every sealed credential must name. */
  readonly keyId: string;
  /** Opens a sealed credential. The worker's own is open-only (ADR 0057 §7). */
  readonly cipher: TokenCipher;
  /** The Chromium the runner starts: in production, the launcher that starts the real one sandboxed (browser.ts). */
  readonly executablePath: string;
  readonly log: WorkerLog;
  /** The runner. `runRecipe`, unless a test names another. */
  readonly runRecipe?: RunRecipe | undefined;
  /**
   * Where a recipe may send the browser: read against the recipe's text before
   * decrypt, and handed to the runner, whose egress proxy holds every
   * connection to it at run time. Public destinations only, unless a test's
   * worker admits its loopback fixture.
   */
  readonly destinations?: DestinationPolicy | undefined;
  /** How the runner's egress proxy resolves a name. `dns.lookup`, unless a test's worker answers for it; `main.ts` never passes one. */
  readonly resolve?: Resolver | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly limits?: Partial<WorkerLimits> | undefined;
  /**
   * Called when a run that was ended as overran still has not let its browser
   * go after `stuckExitMs`. In production the process exits, and the platform
   * starts a clean one; a browser that will not close is not left running.
   */
  readonly onStuck: () => void;
}

export interface Worker {
  readonly server: Server;
  readonly runs: RunRegistry;
  /** Stops the sweep. The server is closed by its owner. */
  stop(): void;
}

/** Limits that do not nest: a wiring mistake, refused when the worker is made. */
export class WorkerLimitsError extends Error {
  override readonly name = 'WorkerLimitsError';
}

type Route = keyof typeof PORTAL_WORKER_ROUTES;

/** A route of the contract's as a matcher: each `:name` segment is one captured segment. */
function matcher(route: Route): (method: string, path: string) => string[] | null {
  const { method, path } = PORTAL_WORKER_ROUTES[route];
  const pattern = new RegExp(
    `^${path
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '([^/]+)' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}$`,
  );
  return (m, p) => {
    if (m !== method) return null;
    const found = pattern.exec(p);
    return found === null ? null : found.slice(1);
  };
}

const ROUTES = {
  health: matcher('health'),
  startRun: matcher('startRun'),
  runState: matcher('runState'),
  runResult: matcher('runResult'),
  capture: matcher('capture'),
} as const;

/** A capture's index as a path carries it: a non-negative integer, with no sign, leading zero or exponent. */
const INDEX = /^(?:0|[1-9][0-9]{0,8})$/;

/** A run id as the contract spells one (the schema's own rule, asked rather than restated). */
function isRunId(s: string): boolean {
  return RunHandleSchema.safeParse({ runId: s, state: 'running' }).success;
}

/** The request's fields, so that a refusal's log line can name the field that was wrong without repeating what came in. */
const REQUEST_FIELDS: ReadonlySet<string> = new Set(['runId', 'orgId', 'connectionId', 'recipe', 'binding', 'sealed', 'params', 'expectAccountId', 'dryRun']);

export function createWorker(options: WorkerOptions): Worker {
  const limits: WorkerLimits = { ...WORKER_LIMITS, ...options.limits };
  if (limits.maxCaptureBytes > limits.maxRunCaptureBytes || limits.maxRunCaptureBytes > limits.maxHeldCaptureBytes) {
    throw new WorkerLimitsError('a capture must fit in a run, and a run in what the worker holds');
  }
  const now = options.now ?? Date.now;
  const log = options.log;
  const destinations = options.destinations ?? PUBLIC_DESTINATIONS_ONLY;
  const authorized = bearerCheck(options.token);
  const runs = new RunRegistry({ now, ttlMs: limits.resultTtlMs, maxForgotten: limits.maxForgotten, maxHeldBytes: limits.maxHeldCaptureBytes });
  const deps = {
    cipher: options.cipher,
    executablePath: options.executablePath,
    runRecipe: options.runRecipe ?? runRecipe,
    destinations,
    resolve: options.resolve,
    now,
    sleep: options.sleep ?? ((ms: number) => sleep(ms)),
    log,
    totpSteps: new TotpSteps(),
    limits,
  };

  const handleOf = (run: HeldRun): RunHandle => ({ runId: run.runId, state: run.state === 'running' ? 'running' : 'done' });

  const logEnd = (ended: EndedRun): void => {
    const { result } = ended;
    log('run_ended', {
      runId: result.runId,
      outcome: result.outcome,
      reason: 'reason' in result ? result.reason : null,
      errorClass: 'errorClass' in result ? result.errorClass : null,
      // Why a credential did not open, by the class of what refused it: an IAM policy, the wrong key, KMS itself, or a binding altered in the row.
      ...(ended.decryptCause === undefined ? {} : { decryptCause: ended.decryptCause }),
      atStep: 'atStep' in result ? result.atStep : null,
      pages: result.counts.pages,
      captures: result.counts.captures,
      refusals: result.counts.refusals,
    });
  };

  /** Holds a run's end, and says which other runs' captures were let go to make room for its own. */
  const hold = (runId: string, ended: EndedRun): void => {
    for (const letGo of runs.end(runId, ended.result, ended.captures)) {
      log('captures_let_go', { runId: letGo, forRunId: runId, heldBytes: runs.heldBytes() });
    }
  };

  /** Runs `request` in the background, as the run in flight, under a watchdog. */
  const launch = (request: RunRequest, run: () => Promise<EndedRun>): void => {
    const { runId } = request;
    let overran = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = setTimeout(
      () => {
        overran = true;
        const ended = endedWith(runId, failedWith(WORKER_ERROR_CLASSES.overran));
        hold(runId, ended);
        log('run_overran', { runId });
        logEnd(ended);
        exitTimer = setTimeout(() => {
          log('run_stuck', { runId });
          options.onStuck();
        }, limits.stuckExitMs);
      },
      runCapMs(request.recipe, limits.runCeilingMs) + limits.overrunGraceMs,
    );
    void run()
      .catch((e: unknown) => endedWith(runId, failedWith(errorClassOf(e))))
      .then((ended) => {
        if (overran) return;
        hold(runId, ended);
        logEnd(ended);
      })
      .finally(() => {
        clearTimeout(watchdog);
        if (exitTimer !== undefined) clearTimeout(exitTimer);
        runs.release(runId);
      });
  };

  const startRun = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > PORTAL_RUN_REQUEST_MAX_BYTES) {
      refuseTooLarge(req, res);
      return;
    }
    const body = await readBody(req, PORTAL_RUN_REQUEST_MAX_BYTES);
    if (body.tooLarge) {
      refuseTooLarge(req, res);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(body.bytes.toString('utf8'));
    } catch {
      // The parser's message quotes the body: it is not repeated anywhere.
      log('run_refused', { error: 'bad_request', fields: '(not JSON)' });
      sendError(res, 'bad_request');
      return;
    }
    const parsed = RunRequestSchema.safeParse(json);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => (typeof i.path[0] === 'string' && REQUEST_FIELDS.has(i.path[0]) ? i.path[0] : '(body)')))];
      log('run_refused', { error: 'bad_request', fields: fields.join(',') });
      sendError(res, 'bad_request');
      return;
    }
    const request = parsed.data;
    const owner = { runId: request.runId, orgId: request.orgId, connectionId: request.connectionId };

    // From here to the answer nothing awaits, so two requests cannot both find the worker free.
    const held = runs.get(request.runId);
    if (held !== undefined) {
      if (held.orgId !== request.orgId || held.connectionId !== request.connectionId) {
        log('run_refused', { runId: request.runId, error: 'bad_request', fields: 'runId' });
        sendError(res, 'bad_request');
        return;
      }
      sendJson(res, 200, handleOf(held));
      return;
    }
    if (runs.active() !== null) {
      log('run_refused', { runId: request.runId, error: 'busy' });
      sendError(res, 'busy');
      return;
    }

    let decided: ReturnType<typeof beforeDecrypt>;
    try {
      decided = beforeDecrypt(request, options.keyId, destinations);
    } catch (e) {
      decided = { go: false, end: failedWith(errorClassOf(e)) };
    }
    if (!decided.go) {
      const ended = endedWith(request.runId, decided.end);
      runs.endedBeforeStart(owner, ended.result);
      logEnd(ended);
      sendJson(res, 202, { runId: request.runId, state: 'done' } satisfies RunHandle);
      return;
    }

    if (!runs.begin(owner)) {
      // Unreachable while nothing above awaits; refused rather than run twice if that ever changes.
      sendError(res, 'busy');
      return;
    }
    log('run_started', { runId: request.runId, orgId: request.orgId, connectionId: request.connectionId, dryRun: request.dryRun });
    const binding = decided.binding;
    launch(request, () => executeRun(request, binding, deps));
    sendJson(res, 202, { runId: request.runId, state: 'running' } satisfies RunHandle);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://portal-read.invalid').pathname;

    // Liveness, before the token: the platform's health check has none, and this says nothing but that the worker is up.
    if (ROUTES.health(method, path) !== null) {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (!authorized(req.headers.authorization)) {
      sendError(res, 'unauthorized');
      return;
    }
    if (ROUTES.startRun(method, path) !== null) {
      await startRun(req, res);
      return;
    }

    const state = ROUTES.runState(method, path);
    const result = ROUTES.runResult(method, path);
    const capture = ROUTES.capture(method, path);
    const params = state ?? result ?? capture;
    if (params === null) {
      sendError(res, 'not_found');
      return;
    }
    const [runId = '', index] = params;
    if (!isRunId(runId) || (capture !== null && !INDEX.test(index ?? ''))) {
      sendError(res, 'bad_request');
      return;
    }
    if (capture !== null) {
      const found = runs.capture(runId, Number(index));
      if (!found.found) {
        sendError(res, found.why === 'running' ? 'not_done' : 'not_found');
        return;
      }
      await sendCapture(res, found.capture);
      runs.fetchedInFull(runId, found.capture.capture.index);
      return;
    }
    const run = runs.get(runId);
    if (state !== null) {
      if (run === undefined) sendError(res, 'not_found');
      else sendJson(res, 200, handleOf(run));
      return;
    }
    if (run === undefined || run.state === 'forgotten') sendError(res, 'not_found');
    else if (run.state === 'running') sendError(res, 'not_done');
    else sendJson(res, 200, run.result satisfies RunResult);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      // A fault of the worker's, or a caller gone mid-answer: the class is logged, and the caller gets a bare 500 or a closed socket.
      log('request_failed', { errorClass: errorClassOf(e) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-length': '0', 'cache-control': 'no-store' });
        res.end();
      } else {
        res.destroy();
      }
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;

  const sweeper = setInterval(() => runs.sweep(), 60_000);
  sweeper.unref();

  return { server, runs, stop: () => clearInterval(sweeper) };
}
