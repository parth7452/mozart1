/**
 * The worker, spawned as a process, against the fixture portal (ADR 0057 §6,
 * ADR 0062 §5).
 *
 * Everything between the job's request and the portal's sign-in form is real:
 * the HTTP front door and its token check, the binding recomputed from the
 * recipe, the open-only cipher, the TOTP code, the runner and its Chromium, and
 * the contract's schemas, which check every answer. Only the key differs from
 * production. The worker opens credentials with an open-only `LocalTokenCipher`
 * (serve-local-cipher.ts), and the test seals them with a seal-only one on the
 * same root key, as the app seals with its seal-only KMS cipher. That cipher
 * writes a line for each `decrypt`, so a run refused before decrypt can be
 * shown never to have called it. main.test.ts runs the production entry, with
 * KMS, against the same portal.
 *
 * The fixture portal records every request it receives, bodies included. So a
 * test can show that a password went only into the bound sign-in form, a code
 * only into the bound MFA form, and a refused run sent the portal nothing. The
 * last test reads everything the worker wrote to stdout and stderr, and finds
 * no credential, code, token or page text in it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_PASSWORD,
  FIXTURE_TOTP_SECRET,
  FIXTURE_USERNAME,
  startFixturePortal,
  type FixturePortal,
  type FixturePortalOptions,
} from '../../../packages/portal/test/fixture-portal/server';
import { SNAPSHOT_RULE_VERSION } from '../../../packages/portal/src/runner/snapshot';
import { bindingOf, type PortalCredentialPayload, type RecipeStep, type RecipeVersion, type RunRequest, type RunResult } from '../src/portal';
import {
  HAS_CHROMIUM,
  KEY_ARN,
  LOCAL_CIPHER_ENTRY,
  OTHER_KEY_ARN,
  TOKEN,
  call,
  captureOf,
  errorOf,
  fixtureRecipe,
  giveToWorker,
  newIds,
  resultOf,
  runRequest,
  seal,
  startRun,
  startWorkerProcess,
  type Ids,
  type WorkerProcess,
} from './harness';

const ROOT_KEY = randomBytes(32);
/** The app's side: seals, and could never open. */
const sealer = new LocalTokenCipher({ rootKey: ROOT_KEY, keyId: KEY_ARN, mode: 'seal_only' });
const DECRYPT_LOG = join(giveToWorker(mkdtempSync(join(tmpdir(), 'portal-read-decrypts-'))), 'decrypts');
writeFileSync(DECRYPT_LOG, '');
giveToWorker(DECRYPT_LOG);
/** The connection id of every `decrypt` the worker has made, in order. */
const decrypts = (): string[] => readFileSync(DECRYPT_LOG, 'utf8').split('\n').filter((line) => line !== '');

const CREDENTIAL: PortalCredentialPayload = { username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD, totpSecret: FIXTURE_TOTP_SECRET };
const WRONG_PASSWORD = 'pw-wrong-on-purpose';

const log = (...steps: [string, boolean][]) => steps.map(([step, passed]) => ({ step, passed }));

describe.skipIf(!HAS_CHROMIUM)('the worker, spawned, against the fixture portal', { timeout: 120_000 }, () => {
  let worker: WorkerProcess;
  let portal: FixturePortal;
  /** Every TOTP code any fixture portal took, and every sealed value sent: none may reach the worker's output. */
  const codesTyped: string[] = [];
  const sealedSent: string[] = [];

  beforeAll(async () => {
    worker = await startWorkerProcess(LOCAL_CIPHER_ENTRY, {
      PORTAL_READ_TEST_ROOT_KEY: ROOT_KEY.toString('hex'),
      PORTAL_READ_TEST_DECRYPT_LOG: DECRYPT_LOG,
    });
  }, 60_000);
  afterAll(async () => {
    await worker.stop();
  });

  const keepCodes = (p: FixturePortal): void => {
    for (const r of p.received) {
      if (r.method === 'POST' && pathOf(p, r.target) === '/mfa') codesTyped.push(new URLSearchParams(r.body).get('code') ?? '');
    }
  };
  beforeEach(async () => {
    portal = await startFixturePortal();
  });
  afterEach(async () => {
    keepCodes(portal);
    await portal.close();
  });
  /** The fixture again, behaving another way. */
  const restart = async (o: FixturePortalOptions): Promise<void> => {
    keepCodes(portal);
    await portal.close();
    portal = await startFixturePortal(o);
  };

  const pathOf = (p: FixturePortal, target: string): string => new URL(target, p.origin).pathname;
  /** Every write the fixture received, as `METHOD /path`: a run may send only the bound sign-in and MFA forms. */
  const writes = (): string[] => portal.received.filter((r) => r.method !== 'GET' && r.method !== 'HEAD').map((r) => `${r.method} ${pathOf(portal, r.target)}`);
  /** Every request that carried `secret`, its query and body decoded, as `METHOD /path`. */
  const carrying = (secret: string): string[] =>
    portal.received
      .filter((r) => [r.target, r.body, ...new URL(r.target, portal.origin).searchParams.values(), ...new URLSearchParams(r.body).values()].some((t) => t.includes(secret)))
      .map((r) => `${r.method} ${pathOf(portal, r.target)}`);
  const mfaCodes = (): string[] =>
    portal.received.filter((r) => r.method === 'POST' && pathOf(portal, r.target) === '/mfa').map((r) => new URLSearchParams(r.body).get('code') ?? '');

  /** ADR 0062 §4's run: sign in, answer the code, expect the account, capture the landing page once, sign out. */
  const landing = (o: { mfa: boolean }): RecipeStep[] => [
    { kind: 'open', name: 'start', url: `${portal.origin}/login.html` },
    { kind: 'sign_in' },
    ...(o.mfa ? [{ kind: 'answer_mfa' } as RecipeStep] : []),
    { kind: 'expect', name: 'on-account', selector: '#account' },
    { kind: 'capture_page', name: 'landing' },
    { kind: 'sign_out' },
  ];

  /** A credential sealed for `recipe`, and the request the job would send with it. */
  const sealedRun = async (
    recipe: RecipeVersion,
    o: { payload?: PortalCredentialPayload; ids?: Ids; expectAccountId?: string; dryRun?: boolean; params?: Record<string, string> } = {},
  ): Promise<RunRequest> => {
    const ids = o.ids ?? newIds();
    const { sealed, binding } = await seal(sealer, ids, recipe, o.payload ?? CREDENTIAL);
    sealedSent.push(sealed.ciphertext, sealed.wrappedKey);
    return runRequest({
      ids,
      recipe,
      binding,
      sealed,
      expectAccountId: o.expectAccountId ?? FIXTURE_ACCOUNT_ID,
      ...(o.dryRun === undefined ? {} : { dryRun: o.dryRun }),
      ...(o.params === undefined ? {} : { params: o.params }),
    });
  };

  /** Whether a browser profile shows up in the worker's TMPDIR within a few seconds: a run's browser is open. */
  const profileAppears = async (): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      if (readdirSync(worker.tmpdir).some((entry) => entry.startsWith('playwright_chromiumdev_profile-'))) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  /** Starts a run, expecting a new one, and waits for its result. */
  const run = async (request: RunRequest): Promise<RunResult> => {
    const started = await startRun(worker.origin, request);
    expect(started).toEqual({ status: 202, handle: { runId: request.runId, state: 'running' } });
    return resultOf(worker.origin, request.runId);
  };

  /** Starts a run the worker must refuse before decrypt: created already done. */
  const refusedBeforeDecrypt = async (request: RunRequest): Promise<RunResult> => {
    const started = await startRun(worker.origin, request);
    expect(started).toEqual({ status: 202, handle: { runId: request.runId, state: 'done' } });
    return resultOf(worker.origin, request.runId);
  };

  it('answers /health without a token', async () => {
    expect(await call(worker.origin, 'GET', '/health', { token: null })).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  it('signs in, answers TOTP, checks the account and captures the landing page, typing each value only into its bound form', async () => {
    await restart({ mfa: true });
    const request = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: true })));
    const before = decrypts();

    const result = await run(request);
    expect(result).toMatchObject({ runId: request.runId, outcome: 'completed', counts: { captures: 1, refusals: 0 } });
    expect(result.steps).toEqual(log(['start', true], ['sign_in', true], ['answer_mfa', true], ['on-account', true], ['landing', true], ['sign_out', true]));
    // The sign-in page, the MFA page, the landing page and the sign-in page again after signing out.
    expect(result.counts.pages).toBeGreaterThanOrEqual(4);

    const capture = await captureOf(worker.origin, request.runId, 0);
    const body = Buffer.from(capture.bodyBase64, 'base64');
    expect(capture).toMatchObject({
      runId: request.runId,
      index: 0,
      kind: 'page_snapshot',
      stepName: 'landing',
      filename: 'landing.html',
      contentType: 'text/html',
      pagePath: '/deductions.html',
      snapshotRuleVersion: SNAPSHOT_RULE_VERSION,
    });
    expect(createHash('sha256').update(body).digest('hex')).toBe(capture.sha256);
    expect(result.captures).toEqual([{ index: 0, kind: 'page_snapshot', stepName: 'landing', sha256: capture.sha256, byteLength: body.length }]);
    const html = body.toString('utf8');
    expect(html).toContain('DN-1002');
    expect(html).toContain(FIXTURE_ACCOUNT_ID);
    expect(html).toContain('Signed in as [portal-user]');
    expect(html.toLowerCase()).not.toContain(FIXTURE_USERNAME);

    // Opened once, for this connection, and typed once: the username and password into the bound sign-in form, the
    // code into the bound MFA form, and the TOTP secret nowhere.
    expect(decrypts().slice(before.length)).toEqual([request.connectionId]);
    expect(writes()).toEqual(['POST /login', 'POST /mfa']);
    expect(carrying(FIXTURE_USERNAME)).toEqual(['POST /login']);
    expect(carrying(FIXTURE_PASSWORD)).toEqual(['POST /login']);
    const codes = mfaCodes();
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatch(/^\d{6}$/);
    expect(carrying(codes[0]!)).toEqual(['POST /mfa']);
    expect(carrying(FIXTURE_TOTP_SECRET)).toEqual([]);

    // The same start again is the same run, never a second sign-in.
    expect(await startRun(worker.origin, request)).toEqual({ status: 200, handle: { runId: request.runId, state: 'done' } });
    expect(await resultOf(worker.origin, request.runId)).toEqual(result);
    expect(writes()).toEqual(['POST /login', 'POST /mfa']);
    expect(decrypts().slice(before.length)).toEqual([request.connectionId]);
  });

  it('runs a dry run through every step and captures nothing', async () => {
    await restart({ mfa: true });
    const request = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: true })), { dryRun: true });
    const result = await run(request);
    expect(result).toMatchObject({ outcome: 'completed', counts: { captures: 0 }, captures: [] });
    expect(result.steps).toEqual(log(['start', true], ['sign_in', true], ['answer_mfa', true], ['on-account', true], ['landing', true], ['sign_out', true]));
    expect(errorOf(await call(worker.origin, 'GET', `/runs/${request.runId}/captures/0`))).toEqual({ status: 404, error: 'not_found' });
    expect(writes()).toEqual(['POST /login', 'POST /mfa']);
  });

  it('ends credential_rejected when the portal refuses the password, and types it once', async () => {
    const request = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: false })), { payload: { ...CREDENTIAL, password: WRONG_PASSWORD } });
    const result = await run(request);
    expect(result).toMatchObject({ outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in', captures: [] });
    expect(result.steps).toEqual(log(['start', true], ['sign_in', false]));
    expect(writes()).toEqual(['POST /login']);
    expect(carrying(WRONG_PASSWORD)).toEqual(['POST /login']);
  });

  it('ends mfa_unanswerable when no TOTP secret was sealed, and sends the MFA form nothing', async () => {
    await restart({ mfa: true });
    const request = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: true })), { payload: { username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD } });
    const result = await run(request);
    expect(result).toMatchObject({ outcome: 'needs_attention', reason: 'mfa_unanswerable', atStep: 'answer_mfa', captures: [] });
    expect(writes()).toEqual(['POST /login']);
  });

  it('ends session_expired when a later page is sent back to sign in, and never signs in again', async () => {
    await restart({ sessionPages: 1 });
    const request = await sealedRun(
      fixtureRecipe(portal.origin, [
        { kind: 'open', name: 'start', url: `${portal.origin}/login.html` },
        { kind: 'sign_in' },
        // The first expect after sign-in is the account's (ADR 0057 §13), and the worker always passes the account id.
        { kind: 'expect', name: 'on-account', selector: '#account' },
        { kind: 'open', name: 'account', url: `${portal.origin}/account.html` },
        { kind: 'capture_page', name: 'account-page' },
      ]),
    );
    const result = await run(request);
    expect(result).toMatchObject({ outcome: 'needs_attention', reason: 'session_expired', atStep: 'account', captures: [] });
    expect(result.steps).toEqual(log(['start', true], ['sign_in', true], ['on-account', true], ['account', false]));
    expect(writes()).toEqual(['POST /login']);
    expect(carrying(FIXTURE_PASSWORD)).toEqual(['POST /login']);
  });

  it('ends account_mismatch when the portal shows another account, before anything is captured', async () => {
    const request = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: false })), { expectAccountId: 'AN0100000001' });
    const result = await run(request);
    expect(result).toMatchObject({ outcome: 'needs_attention', reason: 'account_mismatch', atStep: 'on-account', captures: [] });
    expect(writes()).toEqual(['POST /login']);
  });

  it('hands over a download byte for byte, with the username out of its name', async () => {
    const request = await sealedRun(
      fixtureRecipe(portal.origin, [
        { kind: 'open', name: 'start', url: `${portal.origin}/login.html` },
        { kind: 'sign_in' },
        { kind: 'expect', name: 'on-account', selector: '#account' },
        // The portal names this file after the user: statement-jane.doe@acme.test.pdf.
        { kind: 'download', name: 'export', label: 'Export my statement' },
      ]),
    );
    const result = await run(request);
    expect(result).toMatchObject({ outcome: 'completed', counts: { captures: 1 } });
    const capture = await captureOf(worker.origin, request.runId, 0);
    expect(capture).toMatchObject({
      kind: 'download',
      stepName: 'export',
      filename: 'statement-[portal-user].pdf',
      contentType: 'application/pdf',
      pagePath: '/deductions.html',
      snapshotRuleVersion: null,
    });
    const exported = readFileSync(new URL('../../../packages/portal/test/fixture-portal/export.pdf', import.meta.url));
    expect(Buffer.from(capture.bodyBase64, 'base64').equals(exported)).toBe(true);
    expect(capture.sha256).toBe(createHash('sha256').update(exported).digest('hex'));
    expect(result.captures).toEqual([{ index: 0, kind: 'download', stepName: 'export', sha256: capture.sha256, byteLength: exported.length }]);
  });

  it('types the connection\'s run parameters into a search form', async () => {
    const request = await sealedRun(
      fixtureRecipe(portal.origin, [
        { kind: 'open', name: 'start', url: `${portal.origin}/reauth.html` },
        { kind: 'search', name: 'find', formSelector: '#search', fields: { 'input[name=q]': 'claim' }, recordedMethod: 'post', recordedAction: `${portal.origin}/search` },
      ]),
      { params: { claim: 'DN-1001' } },
    );
    expect(await run(request)).toMatchObject({ outcome: 'completed' });
    expect(portal.received.filter((r) => r.method === 'POST').map((r) => [pathOf(portal, r.target), r.body])).toEqual([['/search', 'q=DN-1001']]);
  });

  describe('refusing a credential before it is opened', () => {
    it('refuses a recipe whose binding is not the credential\'s, before decrypt, sending the portal nothing', async () => {
      const recipe = fixtureRecipe(portal.origin, landing({ mfa: false }));
      const good = await sealedRun(recipe);
      const before = decrypts();
      // A host added to the allowlist, and an MFA path added to the sign-in paths: each changes where the credential could go.
      const moved = [
        fixtureRecipe(portal.origin, landing({ mfa: false }), { hostAllowlist: [new URL(portal.origin).host, 'portal-cdn.example.com'] }),
        fixtureRecipe(portal.origin, landing({ mfa: false }), { signIn: { origin: portal.origin, formPaths: ['/login'], mfaPaths: ['/mfa', '/mfa/verify'], acsPaths: [] } }),
      ];
      for (const other of moved) {
        const result = await refusedBeforeDecrypt({ ...good, runId: randomUUID(), recipe: other });
        expect(result).toEqual({
          runId: result.runId,
          outcome: 'needs_attention',
          reason: 'binding_mismatch',
          atStep: null,
          counts: { pages: 0, captures: 0, refusals: 0 },
          steps: [],
          captures: [],
        });
      }
      expect(decrypts()).toEqual(before);
      expect(portal.received).toEqual([]);
    });

    it('opens nothing for a binding altered to match another recipe: the binding is inside the ciphertext', async () => {
      const good = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: false })));
      const other = fixtureRecipe(portal.origin, landing({ mfa: false }), { hostAllowlist: [new URL(portal.origin).host, 'portal-cdn.example.com'] });
      const before = decrypts();
      const result = await run({ ...good, runId: randomUUID(), recipe: other, binding: bindingOf(other) });
      expect(result).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'TokenDecryptionError', atStep: null, steps: [], captures: [] });
      // Asked once, and it did not open, so nothing reached the portal.
      expect(decrypts().slice(before.length)).toEqual([good.connectionId]);
      expect(portal.received).toEqual([]);
    });

    it('refuses a recipe whose step opens a URL the guard would never see, before decrypt, sending the portal nothing', async () => {
      // Run by the runner, a data: page reached neither the route handler nor the egress proxy, ran to `completed`,
      // and its text was captured as the portal's. The same recipe with a host off the allowlist, or a sign-in page
      // outside the fixture's origin, is refused alike: the step URLs are held to the guard's rule from the recipe's
      // text, whatever the binding says.
      const before = decrypts();
      const forged = [
        { kind: 'open', name: 'forged', url: 'data:text/html,<p id="account">AN0100000001-T</p><p>DN-9999 $1,000.00</p>' },
        { kind: 'capture_page', name: 'landing' },
      ] satisfies RecipeStep[];
      const offList = [{ kind: 'open', name: 'start', url: 'https://portal-cdn.example.com/login.html' }, ...landing({ mfa: false }).slice(1)] satisfies RecipeStep[];
      for (const steps of [forged, offList]) {
        const result = await refusedBeforeDecrypt(await sealedRun(fixtureRecipe(portal.origin, steps)));
        expect(result).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'RecipeStepUrlError', atStep: null, steps: [], captures: [] });
      }
      expect(decrypts()).toEqual(before);
      expect(portal.received).toEqual([]);
    });

    it('refuses a credential sealed under another key, before decrypt', async () => {
      const good = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: false })));
      const before = decrypts();
      const result = await refusedBeforeDecrypt({ ...good, sealed: { ...good.sealed, keyId: OTHER_KEY_ARN } });
      expect(result).toMatchObject({ outcome: 'failed', reason: 'error', errorClass: 'PortalKeyMismatchError', atStep: null });
      expect(decrypts()).toEqual(before);
      expect(portal.received).toEqual([]);
    });
  });

  describe('the token', () => {
    it('refuses every route but /health without the right token, and starts nothing', async () => {
      const request = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: false })));
      const before = decrypts();
      const wrong: { token: string | null; headers?: Record<string, string> }[] = [
        { token: null },
        { token: 'wrong' },
        { token: `${TOKEN}0` },
        { token: TOKEN.slice(0, -1) },
        { token: TOKEN.toUpperCase() },
        { token: null, headers: { authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` } },
        { token: null, headers: { authorization: TOKEN } },
      ];
      for (const w of wrong) {
        const attempts = [
          await call(worker.origin, 'POST', '/runs', { ...w, body: JSON.stringify(request) }),
          await call(worker.origin, 'GET', `/runs/${request.runId}`, w),
          await call(worker.origin, 'GET', `/runs/${request.runId}/result`, w),
          await call(worker.origin, 'GET', `/runs/${request.runId}/captures/0`, w),
          await call(worker.origin, 'GET', '/nowhere', w),
        ];
        for (const answer of attempts) {
          expect(errorOf(answer)).toEqual({ status: 401, error: 'unauthorized' });
          expect(answer.headers.get('www-authenticate')).toBe('Bearer');
        }
      }
      expect(errorOf(await call(worker.origin, 'GET', `/runs/${request.runId}`))).toEqual({ status: 404, error: 'not_found' });
      expect(decrypts()).toEqual(before);
      expect(portal.received).toEqual([]);
    });
  });

  describe('one run at a time', () => {
    it('is busy while a run is in flight, answers the run\'s own start again, and runs nothing twice', async () => {
      await restart({ mfa: true });
      const recipe = fixtureRecipe(portal.origin, landing({ mfa: true }));
      const first = await sealedRun(recipe);
      const second = await sealedRun(recipe);
      expect(await startRun(worker.origin, first)).toEqual({ status: 202, handle: { runId: first.runId, state: 'running' } });

      expect(errorOf(await call(worker.origin, 'POST', '/runs', { body: JSON.stringify(second) }))).toEqual({ status: 503, error: 'busy' });
      // While it is in flight, its browser's profile is in the worker's TMPDIR: the place the last tests find empty.
      expect(await profileAppears()).toBe(true);
      expect(await startRun(worker.origin, first)).toEqual({ status: 200, handle: { runId: first.runId, state: 'running' } });
      // The same id from another tenant is not this run.
      expect(errorOf(await call(worker.origin, 'POST', '/runs', { body: JSON.stringify({ ...first, orgId: randomUUID() }) }))).toEqual({ status: 400, error: 'bad_request' });
      expect(errorOf(await call(worker.origin, 'GET', `/runs/${first.runId}/result`))).toEqual({ status: 409, error: 'not_done' });
      expect(errorOf(await call(worker.origin, 'GET', `/runs/${first.runId}/captures/0`))).toEqual({ status: 409, error: 'not_done' });

      expect(await resultOf(worker.origin, first.runId)).toMatchObject({ outcome: 'completed' });
      expect(errorOf(await call(worker.origin, 'GET', `/runs/${second.runId}`))).toEqual({ status: 404, error: 'not_found' });
      expect(writes()).toEqual(['POST /login', 'POST /mfa']);

      // Free again once the first run's browser has closed.
      expect(await run(second)).toMatchObject({ outcome: 'completed' });
      expect(writes()).toEqual(['POST /login', 'POST /mfa', 'POST /login', 'POST /mfa']);
    });
  });

  describe('what it refuses to read', () => {
    it('answers a body that is not a run request with bad_request, and never echoes it', async () => {
      const request = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: false })));
      const bodies = [
        'not json',
        JSON.stringify({ ...request, sealed: { ...request.sealed, plaintext: FIXTURE_PASSWORD } }),
        JSON.stringify({ ...request, runId: request.runId.toUpperCase() }),
        JSON.stringify({ ...request, dryRun: 'no' }),
        JSON.stringify([request]),
      ];
      for (const body of bodies) {
        const answer = await call(worker.origin, 'POST', '/runs', { body });
        expect(answer).toMatchObject({ status: 400, body: { error: 'bad_request' } });
      }
      expect(portal.received).toEqual([]);
    });

    it('refuses a body over the ceiling, declared or chunked', async () => {
      const big = JSON.stringify({ padding: 'x'.repeat(300 * 1024) });
      expect(errorOf(await call(worker.origin, 'POST', '/runs', { body: big }))).toEqual({ status: 413, error: 'too_large' });
      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (let sent = 0; sent <= 300 * 1024; sent += 16 * 1024) yield new Uint8Array(16 * 1024).fill(32);
      }
      const response = await fetch(`${worker.origin}/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: chunks(),
        // Node's fetch needs this for a streamed body; it is not in the DOM RequestInit type.
        duplex: 'half',
      } as unknown as RequestInit);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'too_large' });
    });

    it('answers a malformed id or index with bad_request, and an unknown run, capture or route with not_found', async () => {
      const done = await sealedRun(fixtureRecipe(portal.origin, landing({ mfa: false })), { dryRun: true });
      expect(await run(done)).toMatchObject({ outcome: 'completed' });
      for (const path of ['/runs/not-a-run', `/runs/${done.runId.toUpperCase()}`, `/runs/${done.runId}x/result`]) {
        expect(errorOf(await call(worker.origin, 'GET', path))).toEqual({ status: 400, error: 'bad_request' });
      }
      for (const index of ['01', '-1', '1e0', 'x', '0.0']) {
        expect(errorOf(await call(worker.origin, 'GET', `/runs/${done.runId}/captures/${index}`))).toEqual({ status: 400, error: 'bad_request' });
      }
      const unknown = randomUUID();
      for (const path of [`/runs/${unknown}`, `/runs/${unknown}/result`, `/runs/${unknown}/captures/0`, `/runs/${done.runId}/captures/0`, '/runs', '/']) {
        expect(errorOf(await call(worker.origin, 'GET', path))).toEqual({ status: 404, error: 'not_found' });
      }
      expect(errorOf(await call(worker.origin, 'POST', `/runs/${done.runId}`, { body: '{}' }))).toEqual({ status: 404, error: 'not_found' });
    });
  });

  it('leaves nothing of a run on disk: no profile, no download, no trace', async () => {
    // Every run above has ended, and each browser has closed. What Playwright makes lives in TMPDIR while a run is in
    // flight: the profile and the downloads. Nothing may be left of it.
    expect(readdirSync(worker.tmpdir)).toEqual([]);
  });

  it('writes no credential, code, token, sealed value or page text to its output', () => {
    keepCodes(portal);
    const output = worker.output();
    const lower = output.toLowerCase();
    const secrets = [FIXTURE_USERNAME, FIXTURE_PASSWORD, WRONG_PASSWORD, FIXTURE_TOTP_SECRET, TOKEN, ROOT_KEY.toString('hex'), ...codesTyped, ...sealedSent];
    expect(codesTyped.length).toBeGreaterThan(0);
    expect(secrets.filter((s) => s !== '' && [s, encodeURIComponent(s)].some((spelling) => lower.includes(spelling.toLowerCase())))).toEqual([]);
    for (const text of ['DN-1002', 'Supplier portal', 'Scheduled maintenance', 'ANID', 'Signed in as', 'user name or password']) {
      expect(output).not.toContain(text);
    }
    // Every line is one JSON object of ids, codes, counts and step names.
    const lines = output.split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.values(parsed).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))).toBe(true);
    }
  });
});

// ADR 0057 §6's egress rule, in the worker `main.ts` starts: public destinations only, over https. A recipe whose hosts
// are public names passes every check made before decrypt, however those names resolve, so what keeps the browser off
// the operator's own network at run time is the egress proxy: every connection the browser makes goes through it, and it
// resolves each name, refuses when any answer is not public, and connects only to the answer it checked. Here a
// public-looking name answers with the fixture portal's loopback address, as a name an owner controls could.
describe.skipIf(!HAS_CHROMIUM)('a worker with main.ts\'s own policy, whose recipe names a public host that resolves to loopback', { timeout: 120_000 }, () => {
  let worker: WorkerProcess;
  let portal: FixturePortal;

  beforeAll(async () => {
    worker = await startWorkerProcess(LOCAL_CIPHER_ENTRY, {
      PORTAL_READ_TEST_ROOT_KEY: ROOT_KEY.toString('hex'),
      PORTAL_READ_TEST_DECRYPT_LOG: DECRYPT_LOG,
      PORTAL_READ_TEST_DESTINATIONS: 'public',
      PORTAL_READ_TEST_HOSTS: JSON.stringify({ 'portal.example': '127.0.0.1' }),
    });
  }, 60_000);
  afterAll(async () => {
    await worker.stop();
  });
  beforeEach(async () => {
    portal = await startFixturePortal();
  });
  afterEach(async () => {
    await portal.close();
  });

  it('says it admits no loopback', () => {
    expect(worker.output()).toMatch(/"event":"listening".*"loopbackAllowed":false/);
  });

  it('decrypts for the run, and reaches nothing at the loopback address the name resolves to', async () => {
    const named = `https://portal.example:${new URL(portal.origin).port}`;
    const recipe = fixtureRecipe(named, [
      { kind: 'open', name: 'start', url: `${named}/login.html` },
      { kind: 'sign_in' },
      { kind: 'expect', name: 'on-account', selector: '#account' },
      { kind: 'capture_page', name: 'landing' },
    ]);
    const ids = newIds();
    const { sealed, binding } = await seal(sealer, ids, recipe, CREDENTIAL);
    const request = runRequest({ ids, recipe, binding, sealed, expectAccountId: FIXTURE_ACCOUNT_ID });
    const before = decrypts();

    // Every check before decrypt passes: the host is a public name, and every URL is https.
    const started = await startRun(worker.origin, request);
    expect(started).toEqual({ status: 202, handle: { runId: request.runId, state: 'running' } });
    const result = await resultOf(worker.origin, request.runId);
    expect(decrypts().slice(before.length)).toEqual([request.connectionId]);

    // At run time the name's answer is loopback, which this worker does not admit: the first page is refused, the run
    // ends there, and the portal on that address is sent nothing, the credential least of all.
    expect(result).toMatchObject({ outcome: 'failed', reason: 'guard_refused', atStep: 'start', captures: [] });
    expect(result.counts.refusals).toBeGreaterThanOrEqual(1);
    expect(portal.received).toEqual([]);
  });
});
