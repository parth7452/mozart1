/**
 * The production entry point, `src/main.ts`, spawned exactly as the image runs
 * it (ADR 0057 §6-7, ADR 0062 §6), and the same worker with its KMS cipher
 * against a portal on this machine.
 *
 * First, what `main.ts` refuses to start without: its token, the portal key's
 * ARN, a Chromium that starts with its sandbox, quiet debug logging. Then what
 * it refuses to run: a recipe that would send its browser to loopback, refused
 * before KMS is asked anything. A production worker sends its browser to public
 * destinations only, so the whole run through KMS is made by `serve-kms.ts`:
 * `main.ts`'s own start and cipher, with the loopback fixture portal
 * reachable and nothing else changed. Its cipher is open-only, over the AWS
 * SDK, against a fake KMS on loopback (`AWS_ENDPOINT_URL_KMS`) that keeps its
 * own root key; the credential is sealed as the app seals one, with a
 * seal-only `KmsTokenCipher`. While that run is in flight, the test reads the
 * browser the worker started out of /proc: its command line, its environment,
 * and whether each renderer runs under seccomp in a PID namespace of its own.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { KMS_CIPHER_NAME, KmsTokenCipher } from '@recouple/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_PASSWORD,
  FIXTURE_TOTP_SECRET,
  FIXTURE_USERNAME,
  startFixturePortal,
  type FixturePortal,
} from '../../../packages/portal/test/fixture-portal/server';
import { bindingOf, type RecipeStep } from '../src/portal';
import { sandboxFaults } from '../src/sandbox';
import { startFakeKms, type FakeKms } from './fake-kms';
import {
  CHROMIUM,
  HAS_CHROMIUM,
  KEY_ARN,
  KMS_ENTRY,
  MAIN,
  OTHER_KEY_ARN,
  TOKEN,
  browserOfRun,
  call,
  captureOf,
  errorOf,
  fixtureRecipe,
  newIds,
  resultOf,
  runRequest,
  runToExit,
  seal,
  startRun,
  startWorkerProcess,
  type WorkerProcess,
} from './harness';

/** The example keys AWS's own documentation uses: a signature the fake never checks. */
const AWS_EXAMPLE_KEYS = { AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
/** The only variables the browser's launcher passes on (launch-chromium.sh). */
const BROWSER_VARIABLES = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ']);
const HAS_PROC = existsSync('/proc/self/stat');

/** Every JSON line a worker wrote, parsed. */
const linesOf = (output: string): Record<string, unknown>[] =>
  output.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);

describe('refusing to start', () => {
  /** Everything a worker needs. */
  const complete = { PORTAL_READ_TOKEN: TOKEN, PORTAL_KMS_KEY_ID: KEY_ARN, PORTAL_CHROMIUM_PATH: CHROMIUM };
  const without = (name: string): Record<string, string> => Object.fromEntries(Object.entries(complete).filter(([k]) => k !== name));

  it.each([
    ['no token', without('PORTAL_READ_TOKEN'), 'PORTAL_READ_TOKEN is not set'],
    ['a token shorter than 64 characters', { ...complete, PORTAL_READ_TOKEN: TOKEN.slice(0, 63) }, 'PORTAL_READ_TOKEN is shorter than 64'],
    ['a token a header cannot carry', { ...complete, PORTAL_READ_TOKEN: `${TOKEN} ${TOKEN}` }, 'PORTAL_READ_TOKEN must be printable ASCII'],
    ['no key', without('PORTAL_KMS_KEY_ID'), 'PORTAL_KMS_KEY_ID is not set'],
    ['a key alias', { ...complete, PORTAL_KMS_KEY_ID: 'alias/recouple-portal-credentials' }, "PORTAL_KMS_KEY_ID must be the portal key's ARN"],
    ['a bare key id', { ...complete, PORTAL_KMS_KEY_ID: '0f8fad5b-d9cb-469f-a165-70867728950e' }, "PORTAL_KMS_KEY_ID must be the portal key's ARN"],
    ['an alias ARN', { ...complete, PORTAL_KMS_KEY_ID: 'arn:aws:kms:us-east-1:111122223333:alias/recouple-portal-credentials' }, "PORTAL_KMS_KEY_ID must be the portal key's ARN"],
    ['Playwright\'s debug logging', { ...complete, DEBUG: 'pw:api' }, 'DEBUG is set'],
    ['the Playwright inspector', { ...complete, PWDEBUG: '1' }, 'PWDEBUG is set'],
    ['no Chromium', { ...complete, PORTAL_CHROMIUM_PATH: '/opt/no-browser-here/chrome' }, 'no Chromium at /opt/no-browser-here/chrome'],
    ['a Chromium named by a relative path', { ...complete, PORTAL_CHROMIUM_PATH: 'chrome' }, 'PORTAL_CHROMIUM_PATH must be an absolute path'],
    ['a port that is not one', { ...complete, PORT: '80a' }, 'PORT must be a port number'],
  ])('refuses %s', async (_what, env, reason) => {
    const { code, output } = await runToExit(MAIN, env);
    expect(code).toBe(1);
    const lines = linesOf(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'refused_to_start' });
    expect(lines[0]!.reason).toContain(reason);
    // It names the rule, never the value.
    expect(output).not.toContain(TOKEN.slice(0, 32));
  });

  // Node itself, standing in for Chromium: the launcher starts it, and it is no browser, let alone a sandboxed one.
  it('refuses a browser that does not start with its sandbox', async () => {
    const { code, output } = await runToExit(MAIN, { ...complete, PORTAL_CHROMIUM_PATH: process.execPath });
    expect(code).toBe(1);
    const lines = linesOf(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'refused_to_start' });
    expect(lines[0]!.reason).toContain('Chromium did not start with its sandbox');
  });

  it.skipIf(!HAS_CHROMIUM)('starts with all of them once its browser is shown sandboxed, answers /health, and refuses a caller without the token', async () => {
    const worker = await startWorkerProcess(MAIN);
    try {
      expect(linesOf(worker.output()).find((line) => line.event === 'listening')).toMatchObject({
        browserSandbox: 'checked',
        awsCredentials: 'provider_chain',
        loopbackAllowed: false,
      });
      expect(await call(worker.origin, 'GET', '/health', { token: null })).toMatchObject({ status: 200, body: { status: 'ok' } });
      expect(errorOf(await call(worker.origin, 'GET', `/runs/${randomUUID()}`, { token: null }))).toEqual({ status: 401, error: 'unauthorized' });
      expect(errorOf(await call(worker.origin, 'GET', `/runs/${randomUUID()}`))).toEqual({ status: 404, error: 'not_found' });
    } finally {
      await worker.stop();
    }
    expect(await worker.exited).toBe(0);
    expect(worker.output()).not.toContain(TOKEN);
  });
});

describe.skipIf(!HAS_CHROMIUM)('KMS', { timeout: 120_000 }, () => {
  let kms: FakeKms;
  let portal: FixturePortal;
  const awsEnvironment = (): Record<string, string> => ({ ...AWS_EXAMPLE_KEYS, AWS_ENDPOINT_URL_KMS: kms.endpoint, AWS_EC2_METADATA_DISABLED: 'true' });

  beforeAll(async () => {
    kms = await startFakeKms(KEY_ARN);
  });
  afterAll(async () => {
    await kms.close();
  });
  beforeEach(async () => {
    portal = await startFixturePortal({ mfa: true });
  });
  afterEach(async () => {
    await portal.close();
  });

  /** The app's cipher: GenerateDataKey only. */
  const appCipher = (): KmsTokenCipher => new KmsTokenCipher({ keyId: KEY_ARN, kms: { generateDataKey: (input) => kms.generateDataKey(input) }, mode: 'seal_only' });
  const steps = (): RecipeStep[] => [
    { kind: 'open', name: 'start', url: `${portal.origin}/login.html` },
    { kind: 'sign_in' },
    { kind: 'answer_mfa' },
    { kind: 'expect', name: 'on-account', selector: '#account' },
    { kind: 'capture_page', name: 'landing' },
    { kind: 'sign_out' },
  ];
  const sealedRun = async () => {
    const recipe = fixtureRecipe(portal.origin, steps());
    const ids = newIds();
    const { sealed, binding } = await seal(appCipher(), ids, recipe, { username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD, totpSecret: FIXTURE_TOTP_SECRET });
    expect(sealed).toMatchObject({ cipher: KMS_CIPHER_NAME, keyId: KEY_ARN });
    return runRequest({ ids, recipe, binding, sealed, expectAccountId: FIXTURE_ACCOUNT_ID });
  };

  describe('main.ts', () => {
    let worker: WorkerProcess;
    beforeAll(async () => {
      worker = await startWorkerProcess(MAIN, awsEnvironment());
    }, 60_000);
    afterAll(async () => {
      await worker.stop();
    });

    it('refuses a recipe that would send its browser to loopback, before KMS is asked anything and before the portal hears a thing', async () => {
      const request = await sealedRun();
      const before = kms.targets.length;
      expect(await startRun(worker.origin, request)).toEqual({ status: 202, handle: { runId: request.runId, state: 'done' } });
      expect(await resultOf(worker.origin, request.runId)).toEqual({
        runId: request.runId,
        outcome: 'failed',
        reason: 'error',
        errorClass: 'RecipeHostNotPublicError',
        atStep: null,
        counts: { pages: 0, captures: 0, refusals: 0 },
        steps: [],
        captures: [],
      });
      expect(kms.targets.length).toBe(before);
      expect(portal.received).toEqual([]);
    });
  });

  describe('serve-kms.ts: main.ts with the loopback fixture reachable', () => {
    let worker: WorkerProcess;
    beforeAll(async () => {
      worker = await startWorkerProcess(KMS_ENTRY, awsEnvironment());
    }, 60_000);
    afterAll(async () => {
      await worker.stop();
    });

    it('opens the credential with one Decrypt naming its own key and the portal context, and completes the run in a sandboxed browser that holds none of the worker\'s configuration', async () => {
      expect(linesOf(worker.output()).find((line) => line.event === 'listening')).toMatchObject({ browserSandbox: 'checked', awsCredentials: 'static_keys', loopbackAllowed: true });
      const request = await sealedRun();
      const before = kms.decrypts.length;
      expect(await startRun(worker.origin, request)).toEqual({ status: 202, handle: { runId: request.runId, state: 'running' } });
      const browser = HAS_PROC ? await browserOfRun(worker) : undefined;
      const result = await resultOf(worker.origin, request.runId);
      expect(result).toMatchObject({ outcome: 'completed', counts: { captures: 1 } });
      expect(Buffer.from((await captureOf(worker.origin, request.runId, 0)).bodyBase64, 'base64').toString('utf8')).toContain('Signed in as [portal-user]');

      const binding = bindingOf(request.recipe);
      expect(kms.decrypts.slice(before)).toEqual([
        {
          keyId: KEY_ARN,
          encryptionContext: {
            purpose: 'portal_credential',
            org_id: request.orgId,
            connection_id: request.connectionId,
            sign_in_origin: portal.origin,
            sign_in_paths: JSON.stringify(['/login', '/mfa']),
            hosts_hash: binding.hostsHash,
          },
        },
      ]);
      expect(kms.targets.every((target) => target === 'TrentService.Decrypt')).toBe(true);
      expect(portal.received.filter((r) => r.method === 'POST').map((r) => new URL(r.target, portal.origin).pathname)).toEqual(['/login', '/mfa']);

      if (browser !== undefined) {
        // Its sandbox: not turned off on its command line, and every renderer under a seccomp filter in a PID namespace of its own.
        expect(browser.commandLine.some((arg) => arg === '--no-sandbox' || arg.startsWith('--no-sandbox='))).toBe(false);
        expect(sandboxFaults(browser.tree)).toEqual([]);
        const renderers = browser.tree.descendants.filter((p) => p.type === 'renderer');
        expect(renderers.length).toBeGreaterThan(0);
        expect(renderers.every((p) => p.seccomp === 2 && p.pidNamespaces > 1)).toBe(true);
        // Its environment: the launcher's few variables, and nothing of the worker's, which held AWS keys and a KMS endpoint.
        const names = browser.environment.map((entry) => entry.slice(0, entry.indexOf('=')));
        expect(names.filter((name) => !BROWSER_VARIABLES.has(name))).toEqual([]);
        expect(names.some((name) => name.startsWith('AWS_'))).toBe(false);
        for (const value of [TOKEN, KEY_ARN, AWS_EXAMPLE_KEYS.AWS_ACCESS_KEY_ID, AWS_EXAMPLE_KEYS.AWS_SECRET_ACCESS_KEY, kms.endpoint]) {
          expect(browser.environment.some((entry) => entry.includes(value))).toBe(false);
        }
      }
    });

    it('asks KMS nothing for a recipe whose binding is not the credential\'s, or a credential under another key', async () => {
      const request = await sealedRun();
      const moved = fixtureRecipe(portal.origin, steps(), { hostAllowlist: [new URL(portal.origin).host, 'portal-cdn.example.com'] });
      const before = kms.targets.length;

      const mismatch = { ...request, runId: randomUUID(), recipe: moved };
      expect(await startRun(worker.origin, mismatch)).toEqual({ status: 202, handle: { runId: mismatch.runId, state: 'done' } });
      expect(await resultOf(worker.origin, mismatch.runId)).toMatchObject({ outcome: 'needs_attention', reason: 'binding_mismatch', atStep: null });

      const foreign = { ...request, runId: randomUUID(), sealed: { ...request.sealed, keyId: OTHER_KEY_ARN } };
      expect(await startRun(worker.origin, foreign)).toEqual({ status: 202, handle: { runId: foreign.runId, state: 'done' } });
      expect(await resultOf(worker.origin, foreign.runId)).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'PortalKeyMismatchError', atStep: null });

      expect(kms.targets.length).toBe(before);
      expect(portal.received).toEqual([]);
    });

    it('names, on its run_ended line, the class of what refused a Decrypt: here KMS, for a context the key was not generated under', async () => {
      const request = await sealedRun();
      // The same ciphertext, asked for as another connection's: KMS authenticates the context and refuses.
      const elsewhere = { ...request, runId: randomUUID(), connectionId: randomUUID() };
      expect(await startRun(worker.origin, elsewhere)).toEqual({ status: 202, handle: { runId: elsewhere.runId, state: 'running' } });
      expect(await resultOf(worker.origin, elsewhere.runId)).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'TokenDecryptionError', atStep: null });
      const ended = linesOf(worker.output()).find((line) => line.event === 'run_ended' && line.runId === elsewhere.runId);
      expect(ended).toMatchObject({ errorClass: 'TokenDecryptionError', decryptCause: 'InvalidCiphertextException' });
      expect(portal.received).toEqual([]);
    });

    it('writes no credential, token, AWS secret or page text to its output', () => {
      const output = worker.output().toLowerCase();
      for (const secret of [FIXTURE_USERNAME, FIXTURE_PASSWORD, FIXTURE_TOTP_SECRET, TOKEN, AWS_EXAMPLE_KEYS.AWS_SECRET_ACCESS_KEY, 'DN-1002', 'Signed in as']) {
        expect(output).not.toContain(secret.toLowerCase());
      }
      expect(output).toContain('"event":"run_ended"');
    });
  });
});
