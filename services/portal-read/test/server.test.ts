/**
 * The worker's HTTP server in this process, with the real routes, registry
 * and credential handling, and a runner the test controls (ADR 0057 §6).
 * worker.test.ts runs the same server as a process with the real runner. This
 * file pins down what a real browser run makes slow or cannot show: that a
 * refusal reaches neither `decrypt` nor the runner, that the runner's
 * credential stops answering once the run ends and never types a TOTP code
 * twice for one connection, that a result is forgotten after its time while
 * its id is never run again, what the worker holds of a run's captures and
 * for how many runs, and what the watchdog does with a run that will not end.
 *
 * The runner here reaches no portal, so its recipes name a public host over
 * https, as a production worker requires (destinations.ts).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MAX_UPLOAD_BYTES } from '@recouple/ingest';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialReleasedError } from '../src/credentials';
import type { DestinationPolicy } from '../src/destinations';
import { jsonLines } from '../src/log';
import {
  PORTAL_LIMITS,
  bindingOf,
  totpCode,
  type CredentialSource,
  type PortalCredentialPayload,
  type RecipeStep,
  type RecipeVersion,
  type RunOptions,
  type RunOutcome,
  type RunRequest,
  type RunnerCapture,
} from '../src/portal';
import type { RunRecipe } from '../src/run';
import { MAX_CAPTURE_BYTES, WORKER_LIMITS, WorkerLimitsError, createWorker, type WorkerLimits } from '../src/server';
import { KEY_ARN, OTHER_KEY_ARN, TOKEN, call, captureOf, errorOf, fixtureRecipe, newIds, resultOf, runRequest, seal, startRun, type Ids } from './harness';

const ORIGIN = 'https://portal.example.com';
const ROOT_KEY = randomBytes(32);
const sealer = new LocalTokenCipher({ rootKey: ROOT_KEY, keyId: KEY_ARN, mode: 'seal_only' });
const CREDENTIAL: PortalCredentialPayload = { username: 'svc.reader@acme.test', password: 'pw-in-process', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
const STEPS: RecipeStep[] = [
  { kind: 'open', name: 'start', url: `${ORIGIN}/login.html` },
  { kind: 'sign_in' },
  { kind: 'answer_mfa' },
  { kind: 'expect', name: 'on-account', selector: '#account' },
  { kind: 'capture_page', name: 'landing' },
];

/** An open-only cipher on the test's root key that counts what it is asked. */
function countingOpener(decryptAs?: (plaintext: string) => string) {
  const inner = new LocalTokenCipher({ rootKey: ROOT_KEY, keyId: KEY_ARN, mode: 'open_only' });
  const calls = { decrypt: 0 };
  return {
    calls,
    cipher: {
      name: inner.name,
      mode: inner.mode,
      encrypt: inner.encrypt.bind(inner),
      decrypt: async (...args: Parameters<typeof inner.decrypt>) => {
        calls.decrypt++;
        const plaintext = await inner.decrypt(...args);
        return decryptAs === undefined ? plaintext : decryptAs(plaintext);
      },
    },
  };
}

type RunnerCall = { recipe: RecipeVersion; creds: CredentialSource; opts: RunOptions };

/** A runner that records how it was called and answers as `answer` says. */
function fakeRunner(answer: (call: RunnerCall) => RunOutcome | Promise<RunOutcome> = () => completed()) {
  const calls: RunnerCall[] = [];
  const run: RunRecipe = async (recipe, creds, opts) => {
    const call = { recipe, creds, opts };
    calls.push(call);
    return answer(call);
  };
  return { run, calls };
}

function completed(captures: RunnerCapture[] = [], steps = [{ step: 'start', passed: true }]): RunOutcome {
  return { status: 'completed', captures, refused: [], steps, pages: 3 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The run_ended line the worker logged for `runId`. */
function runEnded(output: string, runId: string): Record<string, unknown> | undefined {
  return output
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('onStuck'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line.event === 'run_ended' && line.runId === runId);
}

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

/** The worker's server on an ephemeral port, as `startWorker` builds it but with the test's runner, clock and limits. */
async function inProcess(o: {
  runner?: RunRecipe;
  cipher?: ReturnType<typeof countingOpener>['cipher'];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  destinations?: DestinationPolicy;
  limits?: Partial<WorkerLimits>;
  onStuck?: () => void;
} = {}) {
  const lines: string[] = [];
  const worker = createWorker({
    token: TOKEN,
    keyId: KEY_ARN,
    cipher: o.cipher ?? countingOpener().cipher,
    executablePath: '/opt/no-browser-here/chrome',
    log: jsonLines({ write: (line: string) => lines.push(line) }),
    runRecipe: o.runner ?? fakeRunner().run,
    now: o.now,
    sleep: o.sleep,
    destinations: o.destinations,
    limits: o.limits,
    onStuck: o.onStuck ?? (() => { lines.push('onStuck\n'); }),
  });
  await new Promise<void>((resolve) => worker.server.listen(0, '127.0.0.1', () => resolve()));
  const address = worker.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const handle = {
    origin: `http://127.0.0.1:${address.port}`,
    worker,
    output: () => lines.join(''),
    close: async () => {
      worker.stop();
      await new Promise<void>((resolve) => worker.server.close(() => resolve()));
    },
  };
  running.push(handle);
  return handle;
}

async function sealedRequest(o: { recipe?: RecipeVersion; payload?: PortalCredentialPayload; ids?: Ids; params?: Record<string, string>; dryRun?: boolean } = {}): Promise<RunRequest> {
  const recipe = o.recipe ?? fixtureRecipe(ORIGIN, STEPS);
  const ids = o.ids ?? newIds();
  const { sealed, binding } = await seal(sealer, ids, recipe, o.payload ?? CREDENTIAL);
  return runRequest({
    ids,
    recipe,
    binding,
    sealed,
    expectAccountId: 'AN0100000001-T',
    ...(o.params === undefined ? {} : { params: o.params }),
    ...(o.dryRun === undefined ? {} : { dryRun: o.dryRun }),
  });
}

/** A run's end refused before decrypt under one of the worker's own class names. */
const refusedAs = (errorClass: string): Record<string, unknown> => ({ outcome: 'failed', reason: 'error', errorClass, atStep: null });

/**
 * The request for `recipe` with the binding that recipe gives, as a credential
 * sealed for it would carry: whatever refuses it, it is not the binding.
 */
function boundTo(r: RunRequest, recipe: RecipeVersion): RunRequest {
  return { ...r, recipe, binding: bindingOf(recipe) };
}

/** STEPS with `step` first, on the recipe at ORIGIN: a production worker's portal, signed in to over https. */
function opening(step: RecipeStep): RecipeVersion {
  return fixtureRecipe(ORIGIN, [step, ...STEPS]);
}

describe('what is refused before the credential is opened', () => {
  const refusals: [string, (r: RunRequest) => RunRequest, Record<string, unknown>][] = [
    [
      'a recipe that sends the credential to another host',
      (r) => ({ ...r, recipe: fixtureRecipe(ORIGIN, STEPS, { hostAllowlist: ['portal.example.com', 'cdn.example.com'] }) }),
      { outcome: 'needs_attention', reason: 'binding_mismatch', atStep: null },
    ],
    [
      'a recipe with another sign-in path',
      (r) => ({ ...r, recipe: fixtureRecipe(ORIGIN, STEPS, { signIn: { origin: ORIGIN, formPaths: ['/login', '/signin'], mfaPaths: ['/mfa'], acsPaths: [] } }) }),
      { outcome: 'needs_attention', reason: 'binding_mismatch', atStep: null },
    ],
    [
      'a recipe no binding can describe: more sign-in paths than a binding holds',
      (r) => {
        // As many form paths as a binding holds, and the MFA path besides.
        const formPaths = Array.from({ length: PORTAL_LIMITS.signInPathsMax }, (_, i) => `/login-${String(i).padStart(2, '0')}`);
        return { ...r, recipe: fixtureRecipe(ORIGIN, STEPS, { signIn: { origin: ORIGIN, formPaths, mfaPaths: ['/mfa'], acsPaths: [] } }) };
      },
      { outcome: 'needs_attention', reason: 'binding_mismatch', atStep: null },
    ],
    // A navigation the runner starts itself, to a URL that is not http(s), reaches neither the guard nor the egress
    // proxy: a data: page ran to `completed` and was captured as the portal's. So a step URL is held to the guard's
    // rule here, from the recipe's text, even when the binding matches.
    ...(
      [
        ['data:', 'data:text/html,<p>a remittance nobody sent</p>'],
        ['about:', 'about:blank'],
        ['chrome:', 'chrome://version'],
        ['javascript:', "javascript:document.write('written by the recipe')"],
        ['file:', 'file:///proc/self/environ'],
        ['view-source:', `view-source:${ORIGIN}/login.html`],
        ['ftp:', 'ftp://portal.example.com/statement.pdf'],
        ['ws:', 'wss://portal.example.com/socket'],
      ] as const
    ).map(([scheme, url]): [string, (r: RunRequest) => RunRequest, Record<string, unknown>] => [
      `a recipe that opens a ${scheme} URL`,
      (r) => boundTo(r, opening({ kind: 'open', name: 'elsewhere', url })),
      refusedAs('RecipeStepUrlError'),
    ]),
    [
      'a recipe that opens a host off its allowlist',
      (r) => boundTo(r, opening({ kind: 'open', name: 'elsewhere', url: 'https://elsewhere.example.net/statement' })),
      refusedAs('RecipeStepUrlError'),
    ],
    [
      'a recipe that opens its own host on a port the allowlist does not name',
      (r) => boundTo(r, opening({ kind: 'open', name: 'elsewhere', url: 'https://portal.example.com:8443/statement' })),
      refusedAs('RecipeStepUrlError'),
    ],
    [
      'a recipe that opens a URL carrying a user name and a password',
      (r) => boundTo(r, opening({ kind: 'open', name: 'elsewhere', url: 'https://svc.reader:pw-in-a-url@portal.example.com/login.html' })),
      refusedAs('RecipeStepUrlError'),
    ],
    [
      'a recipe that opens a data: URL inside a for_each',
      (r) => boundTo(r, fixtureRecipe(ORIGIN, [...STEPS, { kind: 'for_each', name: 'rows', rowSelector: 'tr', maxRows: 2, steps: [{ kind: 'open', name: 'row', url: 'data:text/html,<p>row</p>' }] }])),
      refusedAs('RecipeStepUrlError'),
    ],
    [
      'a recipe whose search posts to a host off its allowlist',
      (r) => boundTo(r, opening({ kind: 'search', name: 'find', formSelector: '#search', fields: {}, recordedMethod: 'post', recordedAction: 'https://elsewhere.example.net/search' })),
      refusedAs('RecipeStepUrlError'),
    ],
    [
      'a recipe whose search posts to a data: URL',
      (r) => boundTo(r, opening({ kind: 'search', name: 'find', formSelector: '#search', fields: {}, recordedMethod: 'post', recordedAction: 'data:text/plain,x' })),
      refusedAs('RecipeStepUrlError'),
    ],
    // What a production worker's browser types a credential into, and posts it to, the internet cannot read.
    [
      'a recipe that signs in over plain http, on a public host',
      (r) => boundTo(r, fixtureRecipe('http://portal.example.com', STEPS)),
      refusedAs('RecipeNotHttpsError'),
    ],
    [
      'a recipe that opens its sign-in page over plain http, though its sign-in origin is https',
      (r) => boundTo(r, fixtureRecipe(ORIGIN, STEPS.map((s) => (s.kind === 'open' ? { ...s, url: 'http://portal.example.com/login.html' } : s)))),
      refusedAs('RecipeNotHttpsError'),
    ],
    [
      'a recipe whose search posts over plain http',
      (r) => boundTo(r, opening({ kind: 'search', name: 'find', formSelector: '#search', fields: {}, recordedMethod: 'post', recordedAction: 'http://portal.example.com/search' })),
      refusedAs('RecipeNotHttpsError'),
    ],
    [
      'a recipe that signs in by ftp, before a binding is asked of it',
      (r) => ({ ...r, recipe: fixtureRecipe(ORIGIN, STEPS, { signIn: { origin: 'ftp://portal.example.com', formPaths: ['/login'], mfaPaths: ['/mfa'], acsPaths: [] } }) }),
      refusedAs('RecipeNotHttpsError'),
    ],
    [
      'a credential sealed under another key',
      (r) => ({ ...r, sealed: { ...r.sealed, keyId: OTHER_KEY_ARN } }),
      { outcome: 'failed', reason: 'error', errorClass: 'PortalKeyMismatchError', atStep: null },
    ],
    ...(
      [
        ['a cloud metadata address', '169.254.169.254'],
        ['a private address', '10.0.0.5'],
        ['loopback', '127.0.0.1:4000'],
        ['loopback spelled as one number', '2130706433'],
        ['Fly\'s private network', 'my-app.internal'],
        ['Fly\'s private proxy', 'my-app.flycast:8080'],
        ['a name with no dot', 'metadata'],
      ] as const
    ).map(([what, host]): [string, (r: RunRequest) => RunRequest, Record<string, unknown>] => [
      `a recipe that can send the browser to ${what}, even with a binding that matches`,
      (r) => {
        const recipe = fixtureRecipe(ORIGIN, STEPS, { hostAllowlist: ['portal.example.com', host] });
        return { ...r, recipe, binding: bindingOf(recipe) };
      },
      { outcome: 'failed', reason: 'error', errorClass: 'RecipeHostNotPublicError', atStep: null },
    ]),
    [
      'a recipe that can send the browser into a private network, before its binding is asked',
      (r) => ({ ...r, recipe: fixtureRecipe(ORIGIN, STEPS, { hostAllowlist: ['portal.example.com', '192.168.1.1'] }) }),
      { outcome: 'failed', reason: 'error', errorClass: 'RecipeHostNotPublicError', atStep: null },
    ],
    [
      'a step name too long for a result to carry',
      (r) => {
        const recipe = fixtureRecipe(ORIGIN, [...STEPS, { kind: 'capture_page', name: 'x'.repeat(201) }]);
        return { ...r, recipe, binding: bindingOf(recipe) };
      },
      { outcome: 'failed', reason: 'error', errorClass: 'RecipeStepNameError', atStep: null },
    ],
    [
      'a step name with a control character, inside a for_each',
      (r) => {
        const recipe = fixtureRecipe(ORIGIN, [...STEPS, { kind: 'for_each', name: 'rows', rowSelector: 'tr', maxRows: 2, steps: [{ kind: 'capture_page', name: 'row\u0007' }] }]);
        return { ...r, recipe, binding: bindingOf(recipe) };
      },
      { outcome: 'failed', reason: 'error', errorClass: 'RecipeStepNameError', atStep: null },
    ],
  ];

  it.each(refusals)('refuses %s: created done, and neither decrypt nor the runner is called', async (_what, change, end) => {
    const opener = countingOpener();
    const runner = fakeRunner();
    const worker = await inProcess({ cipher: opener.cipher, runner: runner.run });
    const request = change(await sealedRequest());
    expect(await startRun(worker.origin, request)).toEqual({ status: 202, handle: { runId: request.runId, state: 'done' } });
    expect(await resultOf(worker.origin, request.runId)).toEqual({
      runId: request.runId,
      counts: { pages: 0, captures: 0, refusals: 0 },
      steps: [],
      captures: [],
      ...end,
    });
    expect(opener.calls.decrypt).toBe(0);
    expect(runner.calls).toHaveLength(0);
    // Refused runs are not in flight: the next start is not busy.
    expect((await startRun(worker.origin, await sealedRequest())).status).toBe(202);
  });

  it('lets a test\'s worker, and only one, send its browser to a fixture portal on loopback, and to nothing else private', async () => {
    const loopback = fixtureRecipe('http://127.0.0.1:4000', STEPS.map((s) => (s.kind === 'open' ? { ...s, url: 'http://127.0.0.1:4000/login.html' } : s)));
    const privateToo = fixtureRecipe('http://127.0.0.1:4000', STEPS, { hostAllowlist: ['127.0.0.1:4000', '10.0.0.5'] });

    const runner = fakeRunner();
    const testWorker = await inProcess({ runner: runner.run, destinations: { allowLoopback: true } });
    const admitted = await sealedRequest({ recipe: loopback });
    await startRun(testWorker.origin, admitted);
    expect(await resultOf(testWorker.origin, admitted.runId)).toMatchObject({ outcome: 'completed' });
    const refused = await sealedRequest({ recipe: privateToo });
    await startRun(testWorker.origin, refused);
    expect(await resultOf(testWorker.origin, refused.runId)).toMatchObject({ errorClass: 'RecipeHostNotPublicError' });
    expect(runner.calls).toHaveLength(1);

    const production = await inProcess({ runner: runner.run });
    const again = await sealedRequest({ recipe: loopback });
    await startRun(production.origin, again);
    expect(await resultOf(production.origin, again.runId)).toMatchObject({ errorClass: 'RecipeHostNotPublicError' });
    expect(runner.calls).toHaveLength(1);
  });

  it('holds a test\'s worker to the same step rules, and admits plain http to its loopback fixture alone', async () => {
    const LOOPBACK = 'http://127.0.0.1:4000';
    const steps = (url: string): RecipeStep[] => [{ kind: 'open', name: 'start', url }, { kind: 'sign_in' }, { kind: 'capture_page', name: 'landing' }];
    const cases: [string, RecipeVersion, string | null][] = [
      ['its fixture portal, over http on loopback', fixtureRecipe(LOOPBACK, steps(`${LOOPBACK}/login.html`)), null],
      ['a data: URL', fixtureRecipe(LOOPBACK, steps('data:text/html,<p>x</p>')), 'RecipeStepUrlError'],
      ['a host off the allowlist', fixtureRecipe(LOOPBACK, steps('https://portal.example.com/login.html')), 'RecipeStepUrlError'],
      ['a public host over plain http', fixtureRecipe('http://portal.example.com', steps('http://portal.example.com/login.html')), 'RecipeNotHttpsError'],
    ];
    const opener = countingOpener();
    const runner = fakeRunner();
    const testWorker = await inProcess({ cipher: opener.cipher, runner: runner.run, destinations: { allowLoopback: true } });
    for (const [what, recipe, errorClass] of cases) {
      const request = await sealedRequest({ recipe });
      await startRun(testWorker.origin, request);
      const result = await resultOf(testWorker.origin, request.runId);
      expect({ what, result }).toMatchObject({ what, result: errorClass === null ? { outcome: 'completed' } : refusedAs(errorClass) });
    }
    // Only the fixture's run opened its credential and reached the runner.
    expect(opener.calls.decrypt).toBe(1);
    expect(runner.calls).toHaveLength(1);
  });
});

describe('opening the credential', () => {
  it('ends failed, named by class, when it does not open, and never calls the runner', async () => {
    const runner = fakeRunner();
    const worker = await inProcess({ runner: runner.run });
    const request = await sealedRequest();
    const other = await sealedRequest({ ids: newIds() });
    // Another connection's ciphertext: its context is not this request's.
    const result = await (async () => {
      await startRun(worker.origin, { ...request, sealed: other.sealed });
      return resultOf(worker.origin, request.runId);
    })();
    expect(result).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'TokenDecryptionError', atStep: null, steps: [], captures: [] });
    expect(runner.calls).toHaveLength(0);
    // The line logged also names what the cipher refused with, by its class: here AES-GCM's own error, which Node names Error.
    expect(runEnded(worker.output(), request.runId)).toMatchObject({ errorClass: 'TokenDecryptionError', decryptCause: 'Error' });
  });

  it.each([
    ['not JSON', () => 'pw-not-json-secret-value'],
    ['JSON that is not a payload', (p: string) => JSON.stringify({ ...(JSON.parse(p) as object), extra: 'pw-extra-secret-value' })],
    ['a payload with a username too short to replace', () => JSON.stringify({ username: 'jd', password: 'pw-short-user-secret' })],
  ])('refuses a plaintext that is %s, by name, never quoting it', async (_what, decryptAs) => {
    const runner = fakeRunner();
    const worker = await inProcess({ cipher: countingOpener(decryptAs).cipher, runner: runner.run });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'PortalCredentialPayloadError', atStep: null });
    expect(runner.calls).toHaveLength(0);
    expect(worker.output()).not.toMatch(/pw-|svc\.reader/);
    // It opened, so nothing refused a decrypt.
    expect(runEnded(worker.output(), request.runId)).not.toHaveProperty('decryptCause');
  });
});

describe('the run', () => {
  it('hands the runner the request\'s recipe, parameters, account and dry run, and a credential that stops answering when the run ends', async () => {
    const runner = fakeRunner(async ({ creds }) => {
      // Asked as the runner types each value, and computed fresh.
      expect(creds.username()).toBe(CREDENTIAL.username);
      expect(creds.password()).toBe(CREDENTIAL.password);
      expect(await creds.totp?.()).toMatch(/^\d{6}$/);
      return completed();
    });
    const worker = await inProcess({ runner: runner.run });
    const request = await sealedRequest({ params: { claim: 'DN-1001' }, dryRun: true });
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({ outcome: 'completed' });

    expect(runner.calls).toHaveLength(1);
    const [{ recipe, creds, opts }] = runner.calls as [RunnerCall];
    expect(recipe).toEqual(request.recipe);
    expect(opts).toMatchObject({ executablePath: '/opt/no-browser-here/chrome', params: { claim: 'DN-1001' }, dryRun: true, expectAccountId: 'AN0100000001-T' });
    expect(typeof opts.now).toBe('function');
    // Released: whatever still holds the source gets nothing from it.
    expect(() => creds.username()).toThrow(CredentialReleasedError);
    expect(() => creds.password()).toThrow(CredentialReleasedError);
    await expect(Promise.resolve().then(() => creds.totp?.())).rejects.toThrow(CredentialReleasedError);
  });

  it('gives the runner no TOTP at all when no secret was sealed', async () => {
    const runner = fakeRunner();
    const worker = await inProcess({ runner: runner.run });
    const request = await sealedRequest({ payload: { username: CREDENTIAL.username, password: CREDENTIAL.password } });
    await startRun(worker.origin, request);
    await resultOf(worker.origin, request.runId);
    expect(runner.calls[0]!.creds.totp).toBeUndefined();
  });

  it('computes the code the portal would expect for now', async () => {
    let code: string | undefined;
    const runner = fakeRunner(async ({ creds }) => {
      code = await creds.totp?.();
      return completed();
    });
    const worker = await inProcess({ runner: runner.run });
    const request = await sealedRequest();
    const before = Date.now();
    await startRun(worker.origin, request);
    await resultOf(worker.origin, request.runId);
    // At most one step boundary can have passed, and a code is never computed with less than five seconds of its step left.
    expect([totpCode(CREDENTIAL.totpSecret!, before), totpCode(CREDENTIAL.totpSecret!, before + 30_000)]).toContain(code);
  });

  it('ends failed, named by class, when the runner throws, and never repeats the message', async () => {
    const worker = await inProcess({ runner: fakeRunner(() => { throw new TypeError('the page said DN-1001 for $1,200.00'); }).run });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'TypeError', atStep: null });
    expect(worker.output()).not.toContain('DN-1001');
  });

  it('passes the runner\'s end through: its reason, its step and its step log', async () => {
    const worker = await inProcess({
      runner: fakeRunner(() => ({
        status: 'needs_attention',
        reason: 'session_expired',
        atStep: 'on-account',
        captures: [],
        refused: [{ method: 'GET', url: `${ORIGIN}/elsewhere?session=abc`, reason: 'host_not_allowed', atStep: 'start' }],
        steps: [{ step: 'start', passed: true }, { step: 'on-account', passed: false }],
        pages: 2,
      })).run,
    });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toEqual({
      runId: request.runId,
      outcome: 'needs_attention',
      reason: 'session_expired',
      atStep: 'on-account',
      counts: { pages: 2, captures: 0, refusals: 1 },
      steps: [{ step: 'start', passed: true }, { step: 'on-account', passed: false }],
      captures: [],
    });
    // A refusal is counted, never listed: its URL can carry a query.
    expect(worker.output()).not.toContain('session=abc');
  });

  it('strips a capture\'s path to the contract\'s rule and takes the username out of it', async () => {
    const bytes = new TextEncoder().encode('<!doctype html><p>landing</p>');
    const worker = await inProcess({
      runner: fakeRunner(() =>
        completed([
          {
            kind: 'page_snapshot',
            stepName: 'landing',
            filename: 'landing.html',
            bytes,
            mimeType: 'text/html',
            pagePath: '/app;jsessionid=A1B2C3/(S(abcdef123456))/users/SVC.READER%40ACME.TEST/home;v=2',
            capturedAt: '2026-09-28T10:00:00.000Z',
            snapshotRuleVersion: 1,
          },
          {
            kind: 'download',
            stepName: 'landing',
            filename: `report\u0007-${'r'.repeat(300)}.csv`,
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'text/csv',
            pagePath: '/(X(1)F(authticket))/exports',
            capturedAt: '2026-09-28T10:00:01.000Z',
            snapshotRuleVersion: null,
          },
        ]),
      ).run,
    });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({ outcome: 'completed', counts: { captures: 2 } });
    const snapshot = await captureOf(worker.origin, request.runId, 0);
    expect(snapshot.pagePath).toBe('/app/users/[portal-user]/home');
    expect(Buffer.from(snapshot.bodyBase64, 'base64').toString('utf8')).toBe('<!doctype html><p>landing</p>');
    const download = await captureOf(worker.origin, request.runId, 1);
    expect(download.pagePath).toBe('/exports');
    expect(download.filename.length).toBeLessThanOrEqual(255);
    expect(download.filename).toMatch(/^report_-r+\.csv$/);
  });

  it('offers no capture when what the run produced breaks the contract, and says which rule', async () => {
    const bytes = new Uint8Array([1]);
    const worker = await inProcess({
      runner: fakeRunner(() =>
        completed(
          [{ kind: 'page_snapshot', stepName: 'landing', filename: 'landing.html', bytes, mimeType: 'text/html', pagePath: '/', capturedAt: '2026-09-28T10:00:00.000Z', snapshotRuleVersion: 1 }],
          // One line per step name is the contract's rule.
          [{ step: 'landing', passed: true }, { step: 'landing', passed: true }],
        ),
      ).run,
    });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({
      outcome: 'failed',
      reason: 'error',
      errorClass: 'PortalResultInvalidError',
      counts: { pages: 3, captures: 0, refusals: 0 },
      steps: [],
      captures: [],
    });
    expect(errorOf(await call(worker.origin, 'GET', `/runs/${request.runId}/captures/0`))).toEqual({ status: 404, error: 'not_found' });
    expect(worker.output()).toContain('"issues":"result.steps:custom"');
  });
});

describe('the runs a worker holds', () => {
  it('forgets a result after its time, and never runs the same id again', async () => {
    let clock = Date.parse('2026-09-28T10:00:00Z');
    const runner = fakeRunner(() =>
      completed([{ kind: 'page_snapshot', stepName: 'landing', filename: 'landing.html', bytes: new Uint8Array([60]), mimeType: 'text/html', pagePath: '/', capturedAt: '2026-09-28T10:00:00.000Z', snapshotRuleVersion: 1 }]),
    );
    const worker = await inProcess({ runner: runner.run, now: () => clock, limits: { resultTtlMs: 60_000 } });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    await resultOf(worker.origin, request.runId);
    await captureOf(worker.origin, request.runId, 0);

    clock += 59_999;
    expect((await call(worker.origin, 'GET', `/runs/${request.runId}/result`)).status).toBe(200);
    clock += 1;
    expect(errorOf(await call(worker.origin, 'GET', `/runs/${request.runId}/result`))).toEqual({ status: 404, error: 'not_found' });
    expect(errorOf(await call(worker.origin, 'GET', `/runs/${request.runId}/captures/0`))).toEqual({ status: 404, error: 'not_found' });
    expect((await call(worker.origin, 'GET', `/runs/${request.runId}`)).body).toEqual({ runId: request.runId, state: 'done' });
    // A retried start finds the run it started, and starts nothing.
    expect(await startRun(worker.origin, request)).toEqual({ status: 200, handle: { runId: request.runId, state: 'done' } });
    expect(runner.calls).toHaveLength(1);
  });

  it('keeps at most maxForgotten forgotten ids, dropping the oldest', async () => {
    let clock = Date.parse('2026-09-28T10:00:00Z');
    const worker = await inProcess({ now: () => clock, limits: { resultTtlMs: 1_000, maxForgotten: 2 } });
    const requests: RunRequest[] = [];
    for (let i = 0; i < 4; i++) {
      // Refused before decrypt, so each is done at once.
      const request = await sealedRequest();
      const refused = { ...request, sealed: { ...request.sealed, keyId: OTHER_KEY_ARN } };
      requests.push(refused);
      await startRun(worker.origin, refused);
      clock += 10;
    }
    clock += 1_000;
    const states = [];
    for (const r of requests) states.push((await call(worker.origin, 'GET', `/runs/${r.runId}`)).status);
    expect(states).toEqual([404, 404, 200, 200]);
  });

  it('is busy while a run is in flight, answers that run\'s own start again, and refuses its id from another tenant', async () => {
    const gate = deferred<RunOutcome>();
    const runner = fakeRunner(() => gate.promise);
    const worker = await inProcess({ runner: runner.run });
    const first = await sealedRequest();
    expect(await startRun(worker.origin, first)).toEqual({ status: 202, handle: { runId: first.runId, state: 'running' } });
    const second = await sealedRequest();
    expect(errorOf(await call(worker.origin, 'POST', '/runs', { body: JSON.stringify(second) }))).toEqual({ status: 503, error: 'busy' });
    // Even a request that would be refused before decrypt waits its turn: nothing is started while a run is in flight.
    expect(errorOf(await call(worker.origin, 'POST', '/runs', { body: JSON.stringify({ ...second, sealed: { ...second.sealed, keyId: OTHER_KEY_ARN } }) }))).toEqual({ status: 503, error: 'busy' });
    expect(await startRun(worker.origin, first)).toEqual({ status: 200, handle: { runId: first.runId, state: 'running' } });
    expect(errorOf(await call(worker.origin, 'POST', '/runs', { body: JSON.stringify({ ...first, connectionId: randomUUID() }) }))).toEqual({ status: 400, error: 'bad_request' });
    expect(errorOf(await call(worker.origin, 'GET', `/runs/${first.runId}/result`))).toEqual({ status: 409, error: 'not_done' });

    gate.resolve(completed());
    expect(await resultOf(worker.origin, first.runId)).toMatchObject({ outcome: 'completed' });
    expect((await startRun(worker.origin, second)).status).toBe(202);
    await resultOf(worker.origin, second.runId);
    expect(runner.calls).toHaveLength(2);
  });
});

describe('a run that will not end', () => {
  const limits = { runCeilingMs: 20, overrunGraceMs: 20 };

  /** Waits until `check` holds, for up to `ms`. */
  const until = async (check: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  };

  it('is ended as overran, stays in flight while its browser may be open, and stops the worker if it never lets go', async () => {
    const stuck: number[] = [];
    const worker = await inProcess({ runner: fakeRunner(() => new Promise<RunOutcome>(() => undefined)).run, limits: { ...limits, stuckExitMs: 1_500 }, onStuck: () => stuck.push(Date.now()) });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId, 5_000)).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'PortalRunOverranError', atStep: null });
    expect(errorOf(await call(worker.origin, 'POST', '/runs', { body: JSON.stringify(await sealedRequest()) }))).toEqual({ status: 503, error: 'busy' });
    expect(stuck).toEqual([]);
    expect(await until(() => stuck.length > 0, 5_000)).toBe(true);
    expect(stuck).toHaveLength(1);
    expect(worker.output()).toContain('"event":"run_stuck"');
  });

  it('frees the worker, keeps the overran end and stops nothing when the run lets go in time', async () => {
    const late = deferred<RunOutcome>();
    const stuck: number[] = [];
    const worker = await inProcess({ runner: fakeRunner(() => late.promise).run, limits: { ...limits, stuckExitMs: 1_500 }, onStuck: () => stuck.push(Date.now()) });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId, 5_000)).toMatchObject({ errorClass: 'PortalRunOverranError' });
    late.resolve(completed());
    // Free once the run has let go: a new run starts rather than being busy.
    const request2 = await sealedRequest();
    let status = 0;
    for (let i = 0; i < 100 && status !== 202; i++) {
      status = (await call(worker.origin, 'POST', '/runs', { body: JSON.stringify(request2) })).status;
      if (status === 503) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toBe(202);
    // The first end is kept, and the process is never stopped.
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({ errorClass: 'PortalRunOverranError' });
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(stuck).toEqual([]);
  });
});

describe('one TOTP code per step for each connection (RFC 6238 §5.2)', () => {
  it('makes a second run of the same connection within one step wait for the next step and type its code, and makes another connection wait for nothing', async () => {
    const stepStart = Date.parse('2026-09-28T10:00:00Z');
    let clock = stepStart + 1_000;
    const slept: number[] = [];
    const codes: (string | undefined)[] = [];
    const runner = fakeRunner(async ({ creds }) => {
      codes.push(await creds.totp?.());
      return completed();
    });
    const worker = await inProcess({ runner: runner.run, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
    const ids = newIds();

    const first = await sealedRequest({ ids });
    await startRun(worker.origin, first);
    await resultOf(worker.origin, first.runId);
    // Twelve seconds on, the owner presses Dry run again: the same step, and the same code if nothing kept track.
    clock += 12_000;
    const second = await sealedRequest({ ids });
    await startRun(worker.origin, second);
    await resultOf(worker.origin, second.runId);
    const elsewhere = await sealedRequest();
    await startRun(worker.origin, elsewhere);
    await resultOf(worker.origin, elsewhere.runId);

    expect(codes[0]).toBe(totpCode(CREDENTIAL.totpSecret!, stepStart));
    expect(codes[1]).toBe(totpCode(CREDENTIAL.totpSecret!, stepStart + 30_000));
    expect(codes[1]).not.toBe(codes[0]);
    // Only the second run waited, to the start of the next step and a little past it.
    expect(slept).toEqual([30_000 - 13_000 + 50]);
    // Another connection, in the step the second run used: no wait, and the same secret gives the same code.
    expect(codes[2]).toBe(codes[1]);
  });
});

describe('the run\'s time', () => {
  it('hands the runner the recipe with its run cap lowered to the worker\'s ceiling, and nothing else changed, the binding included', async () => {
    const runner = fakeRunner();
    const worker = await inProcess({ runner: runner.run, limits: { runCeilingMs: 5_000 } });
    const recipe = fixtureRecipe(ORIGIN, STEPS, { caps: { maxPages: 10, maxDownloads: 2, maxRunMs: 2 * 60 * 60_000 } });
    const request = await sealedRequest({ recipe });
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({ outcome: 'completed' });
    const handed = runner.calls[0]!.recipe;
    expect(handed.caps).toEqual({ maxPages: 10, maxDownloads: 2, maxRunMs: 5_000 });
    expect({ ...handed, caps: recipe.caps }).toEqual(recipe);
    expect(bindingOf(handed)).toEqual(bindingOf(recipe));
  });
});

describe('what the worker holds of a run\'s captures', () => {
  const capture = (kind: RunnerCapture['kind'], stepName: string, bytes: Uint8Array): RunnerCapture =>
    kind === 'page_snapshot'
      ? { kind, stepName, filename: `${stepName}.html`, bytes, mimeType: 'text/html', pagePath: '/', capturedAt: '2026-09-28T10:00:00.000Z', snapshotRuleVersion: 1 }
      : { kind, stepName, filename: 'statement.pdf', bytes, mimeType: 'application/pdf', pagePath: '/', capturedAt: '2026-09-28T10:00:00.000Z', snapshotRuleVersion: null };
  const filled = (size: number): Uint8Array => new Uint8Array(size).fill(60);
  /** A recipe whose `export` downloads run once for each row, inside `rows`. */
  const exporting = fixtureRecipe(ORIGIN, [
    ...STEPS,
    { kind: 'for_each', name: 'rows', rowSelector: 'tr', maxRows: 5, steps: [{ kind: 'download', name: 'export', label: 'Export' }] },
  ]);
  const passedEveryStep = ['start', 'sign_in', 'answer_mfa', 'on-account', 'landing', 'rows', 'export'].map((step) => ({ step, passed: true }));
  const small = { maxCaptureBytes: 100, maxRunCaptureBytes: 250, maxHeldCaptureBytes: 250 };

  it('takes the door\'s own ceiling for a capture: nothing larger would be taken in', () => {
    expect(MAX_CAPTURE_BYTES).toBe(MAX_UPLOAD_BYTES);
    expect(WORKER_LIMITS.maxCaptureBytes).toBe(MAX_UPLOAD_BYTES);
    expect(WORKER_LIMITS.maxCaptureBytes).toBeLessThanOrEqual(WORKER_LIMITS.maxRunCaptureBytes);
    expect(WORKER_LIMITS.maxRunCaptureBytes).toBeLessThanOrEqual(WORKER_LIMITS.maxHeldCaptureBytes);
  });

  it('ends a run failed at the step of a capture over the ceiling, marks that step and the loop around it as not passed, and offers none of its captures', async () => {
    const worker = await inProcess({
      limits: small,
      runner: fakeRunner(() => completed([capture('page_snapshot', 'landing', filled(10)), capture('download', 'export', filled(101))], passedEveryStep)).run,
    });
    const request = await sealedRequest({ recipe: exporting });
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toEqual({
      runId: request.runId,
      outcome: 'failed',
      reason: 'error',
      errorClass: 'PortalCaptureTooLargeError',
      atStep: 'export',
      counts: { pages: 3, captures: 0, refusals: 0 },
      steps: passedEveryStep.map((line) => (line.step === 'rows' || line.step === 'export' ? { ...line, passed: false } : line)),
      captures: [],
    });
    expect(errorOf(await call(worker.origin, 'GET', `/runs/${request.runId}/captures/0`))).toEqual({ status: 404, error: 'not_found' });
    expect(worker.worker.runs.heldBytes()).toBe(0);
    expect(worker.output()).toContain('"event":"captures_refused"');
  });

  it('ends a run failed at the capture that takes its captures together past the run\'s ceiling', async () => {
    const worker = await inProcess({
      limits: small,
      runner: fakeRunner(() => completed([100, 100, 100].map((size) => capture('download', 'export', filled(size))), passedEveryStep)).run,
    });
    const request = await sealedRequest({ recipe: exporting });
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({
      outcome: 'failed',
      errorClass: 'PortalRunCapturesTooLargeError',
      atStep: 'export',
      counts: { captures: 0 },
      captures: [],
    });
    expect(runEnded(worker.output(), request.runId)).toMatchObject({ errorClass: 'PortalRunCapturesTooLargeError', atStep: 'export' });
  });

  it('streams a capture larger than one piece of its encoding, byte for byte, with the length it says', async () => {
    const bytes = randomBytes(3 * 256 * 1024 * 2 + 5);
    const worker = await inProcess({ runner: fakeRunner(() => completed([capture('download', 'landing', bytes)])).run });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    expect(await resultOf(worker.origin, request.runId)).toMatchObject({ outcome: 'completed', captures: [{ byteLength: bytes.length }] });

    const response = await fetch(`${worker.origin}/runs/${request.runId}/captures/0`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(text));
    const answered = await captureOf(worker.origin, request.runId, 0);
    expect(Buffer.from(answered.bodyBase64, 'base64').equals(bytes)).toBe(true);
    expect(answered.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(JSON.parse(text)).toEqual(answered);
  });

  it('lets go of other runs\' captures to hold a new run\'s, those fetched in full before the rest, oldest first, and keeps their results', async () => {
    let clock = Date.parse('2026-09-28T10:00:00Z');
    const worker = await inProcess({
      now: () => clock,
      limits: small,
      runner: fakeRunner(() => completed([capture('page_snapshot', 'landing', filled(100))])).run,
    });
    const run = async (): Promise<RunRequest> => {
      clock += 1_000;
      const request = await sealedRequest();
      await startRun(worker.origin, request);
      await resultOf(worker.origin, request.runId);
      return request;
    };
    const status = async (request: RunRequest): Promise<number> => (await call(worker.origin, 'GET', `/runs/${request.runId}/captures/0`)).status;

    const a = await run();
    const b = await run();
    expect(worker.worker.runs.heldBytes()).toBe(200);
    // The job for b has fetched its capture; a's has not.
    expect(await status(b)).toBe(200);

    const c = await run();
    // Past 250: b's capture goes first, though a's is older, because b's job already has it.
    expect(worker.worker.runs.heldBytes()).toBe(200);
    expect(await status(b)).toBe(404);
    expect((await call(worker.origin, 'GET', `/runs/${b.runId}/result`)).status).toBe(200);
    expect(await status(a)).toBe(200);
    expect(await status(c)).toBe(200);
    expect(worker.output()).toContain(`"event":"captures_let_go","runId":"${b.runId}","forRunId":"${c.runId}"`);

    // Every run held is now fetched in full: the oldest goes.
    const d = await run();
    expect(await status(a)).toBe(404);
    expect(await status(c)).toBe(200);
    expect(await status(d)).toBe(200);
    expect(worker.worker.runs.heldBytes()).toBe(200);
  });

  it('forgets a run\'s bytes with its result when its time is up', async () => {
    let clock = Date.parse('2026-09-28T10:00:00Z');
    const worker = await inProcess({ now: () => clock, limits: { ...small, resultTtlMs: 60_000 }, runner: fakeRunner(() => completed([capture('page_snapshot', 'landing', filled(100))])).run });
    const request = await sealedRequest();
    await startRun(worker.origin, request);
    await resultOf(worker.origin, request.runId);
    expect(worker.worker.runs.heldBytes()).toBe(100);
    clock += 60_000;
    expect(errorOf(await call(worker.origin, 'GET', `/runs/${request.runId}/captures/0`))).toEqual({ status: 404, error: 'not_found' });
    expect(worker.worker.runs.heldBytes()).toBe(0);
  });

  it('refuses limits that do not nest when the worker is made', () => {
    const make = (limits: Partial<WorkerLimits>) => () =>
      createWorker({ token: TOKEN, keyId: KEY_ARN, cipher: countingOpener().cipher, executablePath: '/opt/no-browser-here/chrome', log: () => undefined, limits, onStuck: () => undefined });
    expect(make({ maxCaptureBytes: 200, maxRunCaptureBytes: 100 })).toThrow(WorkerLimitsError);
    expect(make({ maxRunCaptureBytes: 300, maxHeldCaptureBytes: 200 })).toThrow(WorkerLimitsError);
  });
});
