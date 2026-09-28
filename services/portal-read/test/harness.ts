// What the worker's tests share: spawning the real worker process, sealing a
// credential as the app does, the recipes and requests the job would send, and
// an HTTP client that checks every answer against the contract's own schemas.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chownSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TokenCipher } from '@recouple/crypto';
import { chromium } from 'playwright';
import { parseRecipe } from '../../../packages/portal/src/recipe';
import {
  PortalWorkerErrorBodySchema,
  type PortalCredentialPayload,
  type PortalRunParams,
  type SealedPortalCredential,
} from '../../../packages/portal/src/contracts';
import {
  RunCaptureSchema,
  RunHandleSchema,
  RunResultSchema,
  bindingOf,
  portalCredentialContext,
  type PortalBinding,
  type RecipeStep,
  type RecipeVersion,
  type RunCapture,
  type RunHandle,
  type RunRequest,
  type RunResult,
} from '../src/portal';
import { sandboxFaults, settledChromiumTree, type ChromiumTree } from '../src/sandbox';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/**
 * The production entry point: `src/main.ts`, run under tsx. Or, when
 * `PORTAL_READ_MAIN` names one, the bundle the image runs (build.mjs's
 * `portal-read.mjs`), run by Node alone. main.test.ts then tests the artifact
 * the image holds (see the README).
 */
export const MAIN = process.env.PORTAL_READ_MAIN || fileURLToPath(new URL('../src/main.ts', import.meta.url));
/** The same start, with an open-only local cipher in place of KMS, and the loopback fixture portal reachable. */
export const LOCAL_CIPHER_ENTRY = fileURLToPath(new URL('./serve-local-cipher.ts', import.meta.url));
/** `main.ts`'s own start, KMS cipher and all, with the loopback fixture portal reachable. */
export const KMS_ENTRY = fileURLToPath(new URL('./serve-kms.ts', import.meta.url));

/**
 * Who a spawned worker runs as: the tests' own user, or, where the tests run
 * as root, `nobody`, as the image runs the worker as `node`. Chromium's
 * sandbox will not start as root, and the worker refuses to run as root.
 */
export const WORKER_USER: { readonly uid: number; readonly gid: number } | undefined =
  process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : undefined;

/** Hands `path` to the user a spawned worker runs as, where that is not the tests' own. */
export function giveToWorker(path: string): string {
  if (WORKER_USER !== undefined) chownSync(path, WORKER_USER.uid, WORKER_USER.gid);
  return path;
}

/** A new, empty directory the worker's user owns. */
function workerDirectory(prefix: string): string {
  return giveToWorker(mkdtempSync(join(tmpdir(), prefix)));
}

// As the runner's tests find it: the container keeps a Chromium at
// /opt/pw-browsers, and CI installs Playwright's own. In CI a missing browser
// fails the run rather than skipping it, because a skipped worker test is not a
// passing one.
export const CHROMIUM = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath();
export const HAS_CHROMIUM = existsSync(CHROMIUM);
if (process.env.CI && !HAS_CHROMIUM) {
  throw new Error(`no Chromium at ${CHROMIUM}: run \`pnpm exec playwright install --with-deps chromium\``);
}

/** The bearer token of every worker a test starts: 64 characters, the shortest either side accepts. */
export const TOKEN = randomBytes(32).toString('hex');
/** The portal key the worker is configured with, as KMS would name it when the app sealed. */
export const KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/0f8fad5b-d9cb-469f-a165-70867728950e';
/** Another key in the same account: one the worker must refuse. */
export const OTHER_KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/7c9e6679-7425-40de-944b-e07fc1f90ae7';

export interface WorkerProcess {
  readonly child: ChildProcess;
  readonly origin: string;
  /** The process's environment's TMPDIR: where the browser's profile and downloads go while a run is in flight. */
  readonly tmpdir: string;
  /** Everything it wrote to stdout and stderr so far. */
  output(): string;
  /** Its exit code, once it exits. */
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

/**
 * Spawns `entry` under tsx, as `WORKER_USER`, with an environment built from
 * nothing: what a worker is given in production (its token, its key, a port),
 * a Chromium, a home and a temporary directory of its own, and `extra`.
 * Nothing of the test process's environment reaches it but PATH.
 */
export async function startWorkerProcess(entry: string, extra: Readonly<Record<string, string>> = {}): Promise<WorkerProcess> {
  const home = workerDirectory('portal-read-home-');
  const tmp = workerDirectory('portal-read-tmp-');
  const child = spawn(process.execPath, nodeArgs(entry), {
    ...WORKER_USER,
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: tmp,
      // tsx keeps a compile cache in TMPDIR; the tests look there for what a run left behind.
      TSX_DISABLE_CACHE: '1',
      PORT: '0',
      PORTAL_READ_TOKEN: TOKEN,
      PORTAL_KMS_KEY_ID: KEY_ARN,
      PORTAL_CHROMIUM_PATH: CHROMIUM,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let seen = '';
  child.stdout?.on('data', (chunk: Buffer) => { seen += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { seen += chunk.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  const port = await new Promise<number>((resolve, reject) => {
    // Before it listens, the worker starts its browser once to check the sandbox.
    const failed = setTimeout(() => reject(new Error(`the worker never said it was listening:\n${seen}`)), 45_000);
    const look = (): void => {
      const match = /"event":"listening","port":(\d+)/.exec(seen);
      if (match?.[1] !== undefined) {
        clearTimeout(failed);
        resolve(Number(match[1]));
      }
    };
    child.stdout?.on('data', look);
    void exited.then((code) => {
      clearTimeout(failed);
      reject(new Error(`the worker exited with ${code} before listening:\n${seen}`));
    });
  });

  return {
    child,
    origin: `http://127.0.0.1:${port}`,
    tmpdir: tmp,
    output: () => seen,
    exited,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

/** How Node runs `entry`: TypeScript under tsx, a built bundle as it is. */
function nodeArgs(entry: string): string[] {
  return entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];
}

/** Runs `entry` to its exit, as `WORKER_USER`, for a worker that should refuse to start; its code and what it wrote. */
export async function runToExit(entry: string, env: Readonly<Record<string, string>>): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, nodeArgs(entry), {
    ...WORKER_USER,
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: workerDirectory('portal-read-home-'), TMPDIR: workerDirectory('portal-read-tmp-'), TSX_DISABLE_CACHE: '1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  clearTimeout(timer);
  return { code, output };
}

/**
 * A recipe for the fixture portal at `origin`, as a person would promote one:
 * its sign-in form at `/login`, its MFA form at `/mfa`, and the one host.
 */
export function fixtureRecipe(origin: string, steps: RecipeStep[], over: Record<string, unknown> = {}): RecipeVersion {
  return parseRecipe({
    portalKey: 'fixture_portal',
    version: 1,
    effectiveFrom: '2026-09-27',
    hostAllowlist: [new URL(origin).host],
    signIn: { origin, formPaths: ['/login'], mfaPaths: ['/mfa'], acsPaths: [] },
    neverClick: [],
    postAsRead: [],
    caps: { maxPages: 10, maxDownloads: 2, maxRunMs: 60_000 },
    provenance: { draftedBy: { kind: 'person', id: 'worker-test' }, source: 'fixture portal', portalAdr: '0062' },
    steps,
    ...over,
  });
}

export interface Ids {
  readonly orgId: string;
  readonly connectionId: string;
}

export function newIds(): Ids {
  return { orgId: randomUUID(), connectionId: randomUUID() };
}

/** Seals `payload` as Settings → Portals does: under the binding of `recipe`, for this tenant and connection. */
export async function seal(
  cipher: TokenCipher,
  ids: Ids,
  recipe: RecipeVersion,
  payload: PortalCredentialPayload,
): Promise<{ sealed: SealedPortalCredential; binding: PortalBinding }> {
  const binding = bindingOf(recipe);
  const sealed = await cipher.encrypt(JSON.stringify(payload), portalCredentialContext(ids, binding));
  return { sealed, binding };
}

/** A run request as the job sends one: the credential row's binding and sealed columns, with the recipe to run. */
export function runRequest(input: {
  readonly ids: Ids;
  readonly recipe: RecipeVersion;
  readonly binding: PortalBinding;
  readonly sealed: SealedPortalCredential;
  readonly expectAccountId: string;
  readonly dryRun?: boolean;
  readonly params?: PortalRunParams;
  readonly runId?: string;
}): RunRequest {
  return {
    runId: input.runId ?? randomUUID(),
    orgId: input.ids.orgId,
    connectionId: input.ids.connectionId,
    recipe: input.recipe,
    binding: input.binding,
    sealed: input.sealed,
    ...(input.params === undefined ? {} : { params: input.params }),
    expectAccountId: input.expectAccountId,
    dryRun: input.dryRun ?? false,
  };
}

export type Answer = { readonly status: number; readonly body: unknown; readonly headers: Headers };

export async function call(
  origin: string,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly token?: string | null; readonly body?: string; readonly headers?: Record<string, string> } = {},
): Promise<Answer> {
  const token = options.token === undefined ? TOKEN : options.token;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown), headers: response.headers };
}

/** POST /runs; the handle, checked against the contract. */
export async function startRun(origin: string, request: RunRequest): Promise<{ status: number; handle: RunHandle }> {
  const answer = await call(origin, 'POST', '/runs', { body: JSON.stringify(request) });
  if (answer.status !== 200 && answer.status !== 202) {
    throw new Error(`POST /runs answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  }
  return { status: answer.status, handle: RunHandleSchema.parse(answer.body) };
}

/** Polls the run until it is done, then fetches its result, checked against the contract. */
export async function resultOf(origin: string, runId: string, timeoutMs = 90_000): Promise<RunResult> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const state = await call(origin, 'GET', `/runs/${runId}`);
    if (state.status !== 200) throw new Error(`GET /runs/${runId} answered ${state.status}`);
    if (RunHandleSchema.parse(state.body).state === 'done') break;
    if (Date.now() > until) throw new Error(`run ${runId} was not done within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const answer = await call(origin, 'GET', `/runs/${runId}/result`);
  if (answer.status !== 200) throw new Error(`GET /runs/${runId}/result answered ${answer.status}`);
  return RunResultSchema.parse(answer.body);
}

/** One capture, checked against the contract. */
export async function captureOf(origin: string, runId: string, index: number): Promise<RunCapture> {
  const answer = await call(origin, 'GET', `/runs/${runId}/captures/${index}`);
  if (answer.status !== 200) throw new Error(`GET capture ${index} answered ${answer.status}`);
  return RunCaptureSchema.parse(answer.body);
}

/** An error answer: its status, and a body that is `{ error: code }` and nothing else. */
export function errorOf(answer: Answer): { status: number; error: string } {
  return { status: answer.status, error: PortalWorkerErrorBodySchema.parse(answer.body).error };
}

/** The browser a worker started for its run in flight, as /proc shows it, and the environment it was started with. */
export interface RunBrowser {
  readonly tree: ChromiumTree;
  readonly environment: readonly string[];
  readonly commandLine: readonly string[];
}

/**
 * The browser the worker launched for its run in flight, once a renderer is
 * running under it and has settled (sandbox.ts: a renderer turns its seccomp
 * filter on a moment after it is forked), or as it was last seen when
 * `timeoutMs` passes with a fault still showing, for the caller to report.
 * Linux only: the caller checks that /proc is there.
 */
export async function browserOfRun(worker: WorkerProcess, timeoutMs = 10_000): Promise<RunBrowser> {
  const pid = worker.child.pid;
  if (pid === undefined) throw new Error('the worker has no pid');
  let seen: RunBrowser | undefined;
  const hasRenderer = (tree: ChromiumTree): boolean => tree.descendants.some((p) => p.type === 'renderer');
  await settledChromiumTree(pid, {
    timeoutMs,
    intervalMs: 20,
    until: (tree) => {
      if (!hasRenderer(tree)) return false;
      try {
        const read = (what: string): string[] => readFileSync(`/proc/${tree.browser.pid}/${what}`, 'utf8').split('\0').filter((entry) => entry !== '');
        seen = { tree, environment: read('environ'), commandLine: read('cmdline') };
      } catch {
        // The browser closed between the listing and the read: what was seen before stands.
        return false;
      }
      return sandboxFaults(tree).length === 0;
    },
  });
  if (seen === undefined) throw new Error('no browser with a renderer started under the worker');
  return seen;
}
