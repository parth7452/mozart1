import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { basename, dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRecipe, type RecipeStep } from '../src/recipe';
import { showsAccountId } from '../src/runner/account-id';
import { egressCertificate } from '../src/runner/certificate';
import { PUBLIC_DESTINATIONS_ONLY, type DestinationPolicy } from '../src/runner/destination-policy';
import { MAX_BODY_BYTES, startEgress, type Egress, type EgressRefusal, type EgressRequest, type Resolver } from '../src/runner/egress';
import { runRecipe, type CredentialSource, type RunOptions, type RunOutcome } from '../src/runner/runner';
import { SNAPSHOT_RULE_VERSION, USERNAME_PLACEHOLDER, withoutUsername } from '../src/runner/snapshot';
import { totpCode } from '../src/totp';
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_PASSWORD,
  FIXTURE_SUPPLIER_NUMBER,
  FIXTURE_TOTP_SECRET,
  FIXTURE_USERNAME,
  startFixturePortal,
  startUdpSink,
  type FixturePortal,
  type FixturePortalOptions,
} from './fixture-portal/server';
import { recipeJson } from './recipe-fixture';

// The container keeps a Chromium at /opt/pw-browsers; CI installs Playwright's
// own (`playwright install chromium`). In CI a missing browser fails the run
// rather than skipping it, because a skipped guard test is not a passing one.
const CHROMIUM = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath();
if (process.env.CI && !existsSync(CHROMIUM)) {
  throw new Error(`no Chromium at ${CHROMIUM}: run \`pnpm exec playwright install --with-deps chromium\``);
}
/**
 * Chromium's headless shell, the other build a worker could drive, installed
 * beside the browser by `playwright install chromium` and in the container.
 * It reads some switches under other names than the browser does, so what
 * holds a page's traffic is tested in both.
 */
const HEADLESS_SHELL = headlessShellBeside(CHROMIUM);
if (process.env.CI && HEADLESS_SHELL === undefined) {
  throw new Error(`no Chromium headless shell beside ${CHROMIUM}: run \`pnpm exec playwright install --with-deps chromium\``);
}
const BUILDS: [string, string][] = [['the browser', CHROMIUM], ...(HEADLESS_SHELL === undefined ? [] : [['the headless shell', HEADLESS_SHELL] as [string, string]])];

/** `<browsers>/chromium-<rev>/<dir>/chrome` to `<browsers>/chromium_headless_shell-<rev>/<dir>/` and the shell, by either name it has had. */
function headlessShellBeside(browser: string): string | undefined {
  if (!existsSync(browser)) return undefined;
  const revision = dirname(dirname(realpathSync(browser)));
  const shellRoot = join(dirname(revision), basename(revision).replace(/^chromium-/, 'chromium_headless_shell-'));
  if (shellRoot === revision || !existsSync(shellRoot)) return undefined;
  for (const dir of readdirSync(shellRoot)) {
    for (const name of ['chrome-headless-shell', 'headless_shell']) {
      if (existsSync(join(shellRoot, dir, name))) return join(shellRoot, dir, name);
    }
  }
  return undefined;
}

const creds: CredentialSource = { username: () => FIXTURE_USERNAME, password: () => FIXTURE_PASSWORD };

/** The fixture portal serves plain http on loopback, which only a policy that admits loopback reaches: a test's worker's. */
const FIXTURE_DESTINATIONS: DestinationPolicy = { allowLoopback: true };

/** Credentials with the fixture's TOTP secret, computing each code as it is typed, as the worker does, and keeping what they gave. */
function withTotp(codes: string[] = []): CredentialSource {
  return {
    ...creds,
    totp: () => {
      const code = totpCode(FIXTURE_TOTP_SECRET, Date.now());
      codes.push(code);
      return code;
    },
  };
}

/** A six-digit code the fixture refuses: none of the codes for the steps around now. */
function wrongCode(): string {
  const now = Date.now();
  const near = new Set([-2, -1, 0, 1, 2].map((k) => totpCode(FIXTURE_TOTP_SECRET, now + k * 30_000)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!near.has(code)) return code;
  }
}

/**
 * Which of `secrets` appear anywhere in an outcome, in any case, as typed or
 * percent-encoded: its captures decoded, their filenames, the step log, the
 * refusals.
 */
function leaked(out: RunOutcome, secrets: readonly string[]): string[] {
  const text = JSON.stringify({ ...out, captures: out.captures.map((c) => ({ ...c, bytes: new TextDecoder().decode(c.bytes) })) }).toLowerCase();
  return secrets.filter((s) => [s, encodeURIComponent(s)].some((spelling) => text.includes(spelling.toLowerCase())));
}

/** A binding whose assertion-consumer path is the fixture's `/sso`. */
const withSso = (origin: string) => ({ signIn: { origin, formPaths: ['/login'], mfaPaths: ['/mfa'], acsPaths: ['/sso'] } });

describe.skipIf(!existsSync(CHROMIUM))('runRecipe against the fixture portal', { timeout: 60_000 }, () => {
  let portal: FixturePortal;
  beforeEach(async () => { portal = await startFixturePortal(); });
  afterEach(async () => { await portal.close(); });

  /** The fixture again, behaving another way. */
  const restart = async (o: FixturePortalOptions): Promise<void> => {
    await portal.close();
    portal = await startFixturePortal(o);
  };
  /** A run against the fixture, in the browser unless another build is named. */
  const run = (steps: RecipeStep[], over: Record<string, unknown> = {}, c: CredentialSource = creds, o: Partial<RunOptions> = {}) =>
    runRecipe(parseRecipe(recipeJson(portal.origin, { steps, ...over })), c, { executablePath: CHROMIUM, destinations: FIXTURE_DESTINATIONS, ...o });
  const signedIn = (): RecipeStep[] => [{ kind: 'open', name: 'start', url: `${portal.origin}/login.html` }, { kind: 'sign_in' }];
  /** Signed in and the landing page checked, as ADR 0062 §4 has it, so that a step that acts next has no sign-in window to wait out. */
  const checkedIn = (): RecipeStep[] => [...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }];
  const nonGet = () => portal.hits.filter((h) => h.method !== 'GET' && h.method !== 'HEAD');
  const saw = (path: string) => portal.hits.some((h) => h.path === path);
  const pathOf = (target: string) => new URL(target, portal.origin).pathname;
  /** Every write the fixture received, as `METHOD /path`: a run may send only the bound sign-in and MFA forms. */
  const writes = () => portal.received.filter((r) => r.method !== 'GET' && r.method !== 'HEAD').map((r) => `${r.method} ${pathOf(r.target)}`);
  /** Every request that carried `secret` anywhere, its query and body decoded, as `METHOD /path`. */
  const carrying = (secret: string) => portal.received
    .filter((r) => [r.target, r.body, ...new URL(r.target, portal.origin).searchParams.values(), ...new URLSearchParams(r.body).values()].some((t) => t.includes(secret)))
    .map((r) => `${r.method} ${pathOf(r.target)}`);
  const log = (...steps: [string, boolean][]) => steps.map(([step, passed]) => ({ step, passed }));

  it('signs in, captures the deductions page and downloads the export', async () => {
    const out = await run([...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }, { kind: 'capture_page', name: 'list' }, { kind: 'download', name: 'export', label: 'Export statement' }]);
    expect(out.status).toBe('completed');
    expect(out.captures.map((c) => [c.kind, c.mimeType])).toEqual([['page_snapshot', 'text/html'], ['download', 'application/pdf']]);
    const html = new TextDecoder().decode(out.captures[0]!.bytes);
    expect(html).toContain('DN-1002');
    expect(html).not.toContain('<form');
    expect(html).toContain('Signed in as [portal-user]');
    expect(new TextDecoder().decode(out.captures[1]!.bytes.slice(0, 5))).toBe('%PDF-');
    expect(nonGet()).toEqual([{ method: 'POST', path: '/login' }]);
  });

  it('answers MFA through the bound form, and stops when it cannot', async () => {
    await restart({ mfa: true });
    const steps = (): RecipeStep[] => [...signedIn(), { kind: 'answer_mfa' }, { kind: 'expect', name: 'on-list', selector: '#deductions' }];
    expect((await run(steps(), {}, withTotp())).status).toBe('completed');
    expect(nonGet()).toEqual([{ method: 'POST', path: '/login' }, { method: 'POST', path: '/mfa' }]);
    const out = await run(steps());
    expect(out).toMatchObject({ status: 'needs_attention', reason: 'mfa_unanswerable' });
  });

  it('refuses a sign-in form with two password inputs', async () => {
    const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/login-two-passwords.html` }, { kind: 'sign_in' }]);
    expect(out).toMatchObject({ status: 'failed', reason: 'sign_in_form_refused' });
    expect(nonGet()).toEqual([]);
  });

  it('never clicks "Submit dispute"', async () => {
    const out = await run([...checkedIn(), { kind: 'follow', name: 'dispute', label: 'Submit dispute' }]);
    expect(out).toMatchObject({ status: 'failed', reason: 'never_click', atStep: 'dispute' });
    expect(saw('/dispute')).toBe(false);
  });

  it('refuses a search whose form is not the one recorded', async () => {
    for (const id of ['reauth', 'change']) {
      const out = await run([...checkedIn(), { kind: 'open', name: 'reauth', url: `${portal.origin}/reauth.html` },
        { kind: 'search', name: 'find', formSelector: `#${id}`, fields: { 'input[name=q]': 'claim' }, recordedMethod: 'post', recordedAction: `${portal.origin}/search` }], {}, creds);
      expect(out).toMatchObject({ status: 'failed', reason: 'guard_refused' });
    }
    expect(saw('/reauth')).toBe(false);
    expect(saw('/change-password')).toBe(false);
  });

  it('allows a search to its recorded action', async () => {
    const out = await runRecipe(parseRecipe(recipeJson(portal.origin, { steps: [{ kind: 'open', name: 'start', url: `${portal.origin}/reauth.html` },
      { kind: 'search', name: 'find', formSelector: '#search', fields: { 'input[name=q]': 'claim' }, recordedMethod: 'post', recordedAction: `${portal.origin}/search` }] })),
      creds, { executablePath: CHROMIUM, destinations: FIXTURE_DESTINATIONS, params: { claim: 'DN-1001' } });
    expect(out.status).toBe('completed');
    expect(nonGet()).toEqual([{ method: 'POST', path: '/search' }]);
  });

  it('aborts a POST a page script makes, and records it', async () => {
    const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/script-post.html` }, { kind: 'wait_for', name: 'done', selector: 'body[data-done]' }]);
    expect(out.status).toBe('completed');
    expect(out.refused).toEqual([{ method: 'POST', url: `${portal.origin}/dispute`, reason: 'non_get_not_allowed', atStep: 'start' }]);
    expect(saw('/dispute')).toBe(false);
  });

  it.each(BUILDS)('lets no worker write in %s: a dedicated worker\'s POST is refused, and a shared worker never starts', async (_build, executablePath) => {
    // Playwright routes a dedicated worker's requests, and not a shared worker's, which would reach the portal undecided.
    const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/workers.html` }, { kind: 'wait_for', name: 'done', selector: 'body[data-done]' }], {}, creds, { executablePath });
    expect(out.status).toBe('completed');
    expect(out.refused).toContainEqual(expect.objectContaining({ method: 'POST', url: `${portal.origin}/dispute-from-dedicated-worker`, reason: 'non_get_not_allowed' }));
    expect(saw('/dedicated-worker.js')).toBe(true);
    expect(saw('/shared-worker.js')).toBe(false);
    expect(saw('/dispute-from-shared-worker')).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('refuses to open a host off the allowlist', async () => {
    const other = await startFixturePortal();
    try {
      const out = await run([{ kind: 'open', name: 'elsewhere', url: `${other.origin}/deductions.html` }]);
      expect(out).toMatchObject({ status: 'failed', reason: 'guard_refused', atStep: 'elsewhere' });
      expect(other.hits).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it.each(BUILDS)('refuses a redirect %s follows by itself to a host off the allowlist, before it is sent', async (_build, executablePath) => {
    // `/hop1` → `/hop2` → the other host. The route handler sees only `/hop1`;
    // the egress proxy is all that stands between the browser and the rest.
    const other = await startFixturePortal();
    try {
      await restart({ hopTo: `${other.origin}/deductions.html` });
      const out = await run([{ kind: 'open', name: 'hops', url: `${portal.origin}/hop1` }], {}, creds, { executablePath });
      expect(out).toMatchObject({ status: 'failed', reason: 'guard_refused', atStep: 'hops' });
      expect(out.refused).toContainEqual({ method: 'GET', url: `${other.origin}/deductions.html`, reason: 'host_not_allowed', atStep: 'hops' });
      expect(saw('/hop2')).toBe(true);
      expect(other.hits).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('refuses a sign-in POST redirected with its body to a host off the allowlist', async () => {
    const other = await startFixturePortal();
    const bouncing = await startFixturePortal({ loginRedirect: `${other.origin}/login` });
    try {
      const out = await runRecipe(
        parseRecipe(recipeJson(bouncing.origin, { steps: [{ kind: 'open', name: 'start', url: `${bouncing.origin}/login.html` }, { kind: 'sign_in' }] })),
        creds, { executablePath: CHROMIUM, destinations: FIXTURE_DESTINATIONS },
      );
      expect(out.status).toBe('failed');
      expect(out.refused).toContainEqual(expect.objectContaining({ method: 'POST', url: `${other.origin}/login`, reason: 'host_not_allowed' }));
      expect(other.hits).toEqual([]);
    } finally {
      await bouncing.close();
      await other.close();
    }
  });

  it('follows a 307 itself: to a bound path, sending the body there once; to any other, not at all', async () => {
    await restart({ loginRedirect: '/signin' });
    const out = await run([...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }],
      { signIn: { origin: portal.origin, formPaths: ['/login', '/signin'], mfaPaths: ['/mfa'], acsPaths: [] } });
    expect(out.status).toBe('completed');
    expect(writes()).toEqual(['POST /login', 'POST /signin']);
    const [first, second] = portal.received.filter((r) => r.method === 'POST');
    expect(second!.body).toBe(first!.body);
    expect(carrying(FIXTURE_PASSWORD)).toEqual(['POST /login', 'POST /signin']);
    // An allowlisted host, so the egress proxy would let a browser following it by itself through: the hop is decided before it is sent.
    await restart({ loginRedirect: '/dispute' });
    const refused = await run(signedIn());
    expect(refused).toMatchObject({ status: 'failed', reason: 'guard_refused', atStep: 'sign_in' });
    expect(refused.refused).toContainEqual({ method: 'POST', url: `${portal.origin}/dispute`, reason: 'non_get_not_allowed', atStep: 'sign_in' });
    expect(saw('/dispute')).toBe(false);
    expect(writes()).toEqual(['POST /login']);
  });

  it('fails, naming no URL, when the portal drops the connection', async () => {
    const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/login.html` }, { kind: 'open', name: 'dropped', url: `${portal.origin}/drop` }]);
    expect(out).toMatchObject({ status: 'failed', reason: 'error', errorClass: 'PortalPageUnavailableError', atStep: 'dropped', refused: [] });
    expect(out.steps).toEqual(log(['start', true], ['dropped', false]));
    expect(saw('/drop')).toBe(true);
    const text = JSON.stringify(out);
    expect(text).not.toContain(portal.origin);
    expect(text).not.toContain('/drop');
  });

  it('refuses every WebSocket a page opens', async () => {
    const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/ws.html` }, { kind: 'wait_for', name: 'w', selector: 'p' }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(out.refused).toContainEqual(expect.objectContaining({ method: 'WEBSOCKET', reason: 'scheme_not_allowed' }));
    expect(saw('/leak')).toBe(false);
  });

  /** A worker's WebSocket from a blob and from a URL, and a WebSocketStream: none reaches the stand-in Playwright puts in a page's frames. */
  const WS_PATHS = ['/ws-from-blob-worker', '/ws-from-script-worker', '/ws-from-websocketstream'] as const;
  const wsSteps = (query = ''): RecipeStep[] => [
    { kind: 'open', name: 'start', url: `${portal.origin}/ws-workers.html${query}` },
    // This build has WebSocketStream, so its refusal below is not a test of nothing.
    { kind: 'expect', name: 'has-stream', selector: 'body[data-stream="yes"]' },
    { kind: 'wait_for', name: 'done', selector: 'body[data-done]' },
  ];

  it.each(BUILDS)('refuses in %s a WebSocket from a worker, and a WebSocketStream: the egress proxy reads each upgrade and refuses it', async (_build, executablePath) => {
    const out = await run(wsSteps(), {}, creds, { executablePath });
    expect(out.status).toBe('completed');
    const ws = `ws://${new URL(portal.origin).host}`;
    for (const path of WS_PATHS) {
      expect(out.refused).toContainEqual(expect.objectContaining({ method: 'WEBSOCKET', url: `${ws}${path}`, reason: 'scheme_not_allowed' }));
      expect(saw(path)).toBe(false);
    }
    expect(writes()).toEqual([]);
  });

  it.each(BUILDS)('refuses in %s a worker\'s WebSocket inside TLS too, read with the proxy\'s own key, before anything is resolved', async (_build, executablePath) => {
    const named = `portal.example:${new URL(portal.origin).port}`;
    const asked: string[] = [];
    const out = await run(wsSteps(`?scheme=wss&host=${named}`), { hostAllowlist: [new URL(portal.origin).host, named] }, creds, {
      executablePath,
      resolve: async (hostname) => { asked.push(hostname); return []; },
    });
    expect(out.status).toBe('completed');
    for (const path of WS_PATHS) {
      expect(out.refused).toContainEqual(expect.objectContaining({ method: 'WEBSOCKET', url: `wss://${named}${path}`, reason: 'scheme_not_allowed' }));
    }
    // Refused as it was read: nothing was looked up, let alone connected to.
    expect(asked).toEqual([]);
  });

  it.each(BUILDS)('lets nothing a page sends as it goes away write in %s: a beacon or a keepalive fetch, from a popup, a page or a frame', async (_build, executablePath) => {
    // Each is sent after its frame has gone, or as it goes, where Playwright routes nothing: the egress proxy decides it.
    const pages: [page: string, path: string][] = [
      ['beacon-popup.html', '/beacon-from-closed-popup'],
      ['beacon-self-nav.html', '/beacon-on-pagehide'],
      ['keepalive.html', '/keepalive-on-pagehide'],
      ['keepalive-then-leave.html', '/keepalive-then-leave'],
      ['beacon-iframe.html', '/beacon-from-removed-frame'],
    ];
    for (const [page, path] of pages) {
      const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/${page}` }, { kind: 'wait_for', name: 'done', selector: 'body[data-done]' }], {}, creds, { executablePath });
      expect(out.status).toBe('completed');
      // Whichever way it left, it was refused, and counted, never sent.
      for (const r of out.refused) expect(r).toMatchObject({ method: 'POST', url: `${portal.origin}${path}`, reason: 'non_get_not_allowed' });
      expect(saw(path)).toBe(false);
    }
    expect(writes()).toEqual([]);
  });

  it.each(BUILDS)('counts in %s what a page sends as it goes, refused whenever the browser sends it', async (_build, executablePath) => {
    const steps = (page: string): RecipeStep[] => [{ kind: 'open', name: 'start', url: `${portal.origin}/${page}` }, { kind: 'wait_for', name: 'done', selector: 'body[data-done]' }];
    // A popup that closed itself has no frame left when its beacon goes, so nothing routes it: Chromium sends it to the
    // proxy every time, and every time it is refused and counted.
    const popup = await run(steps('beacon-popup.html'), {}, creds, { executablePath });
    expect(popup.refused).toContainEqual(expect.objectContaining({ method: 'POST', url: `${portal.origin}/beacon-from-closed-popup`, reason: 'non_get_not_allowed' }));
    // A keepalive fetch started as a page sends itself away outlives the page, and Chromium sends it every time: it is
    // refused and counted. One sent from `pagehide` Chromium sends only sometimes, under load about one run in three,
    // however long the run waits after (measured 2026-09-28), so counting it cannot be asked of one run; the test
    // above holds that it is never sent on, whenever it comes.
    const leaving = await run(steps('keepalive-then-leave.html'), {}, creds, { executablePath });
    expect(leaving.refused).toContainEqual(expect.objectContaining({ method: 'POST', url: `${portal.origin}/keepalive-then-leave`, reason: 'non_get_not_allowed' }));
    expect(saw('/keepalive-then-leave')).toBe(false);
    expect(writes()).toEqual([]);
  });

  // The worker's production policy admits public addresses only, over https; a test's worker admits loopback as well,
  // for the fixture. Either way the egress proxy resolves every name the browser asks for and connects to the answer
  // it checked, whatever the recipe's text said the host was.
  describe('connects only where its destinations admit', () => {
    /** A resolver that answers `portal.example` with `address` and nothing else, and keeps what it was asked. */
    const answering = (address: string, asked: string[] = []): Resolver => async (hostname) => {
      asked.push(hostname);
      return hostname === 'portal.example' ? [{ address, family: 4 }] : [];
    };

    it.each(BUILDS)('refuses in %s a public name that resolves to loopback, under the production policy, read inside TLS with the proxy\'s own key', async (_build, executablePath) => {
      // An https recipe on a public-looking name passes every check the worker makes before decrypt. Only its answer is private.
      const named = `https://portal.example:${new URL(portal.origin).port}`;
      const asked: string[] = [];
      const out = await runRecipe(parseRecipe(recipeJson(named, { steps: [{ kind: 'open', name: 'start', url: `${named}/login.html` }] })), creds,
        { executablePath, destinations: PUBLIC_DESTINATIONS_ONLY, resolve: answering('127.0.0.1', asked) });
      expect(out).toMatchObject({ status: 'failed', reason: 'guard_refused', atStep: 'start' });
      // Read inside the tunnel, so the browser took the proxy's key; refused for where the name led.
      expect(out.refused).toContainEqual({ method: 'GET', url: `${named}/login.html`, reason: 'address_not_allowed', atStep: 'start' });
      expect(asked).toContain('portal.example');
      expect(portal.hits).toEqual([]);
    });

    it('refuses plain http under the production policy, even to the loopback a test\'s worker may reach', async () => {
      const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/login.html` }], {}, creds, { destinations: PUBLIC_DESTINATIONS_ONLY });
      expect(out).toMatchObject({ status: 'failed', reason: 'guard_refused', atStep: 'start' });
      expect(out.refused).toContainEqual({ method: 'GET', url: `${portal.origin}/login.html`, reason: 'address_not_allowed', atStep: 'start' });
      expect(portal.hits).toEqual([]);
    });

    it('refuses a name that resolves to a private address, navigated to and as a redirect the browser follows, and reaches it when it resolves to the fixture', async () => {
      /** The name, on the fixture's port as it is now, and an allowlist naming it beside the fixture. */
      const named = () => `http://portal.example:${new URL(portal.origin).port}`;
      const over = () => ({ hostAllowlist: [new URL(portal.origin).host, new URL(named()).host] });
      const direct = await run([{ kind: 'open', name: 'start', url: `${named()}/login.html` }], over(), creds, { resolve: answering('10.0.0.7') });
      expect(direct).toMatchObject({ status: 'failed', reason: 'guard_refused', atStep: 'start' });
      expect(direct.refused).toContainEqual({ method: 'GET', url: `${named()}/login.html`, reason: 'address_not_allowed', atStep: 'start' });
      expect(portal.hits).toEqual([]);

      // `/hop1` → `/hop2` → the name, on a second fixture's port: the route handler sees only `/hop1`, and each hop's
      // host is one the allowlist names.
      const target = await startFixturePortal();
      try {
        const hopTo = `http://portal.example:${new URL(target.origin).port}/deductions.html`;
        await restart({ hopTo });
        const hopOver = { hostAllowlist: [new URL(portal.origin).host, new URL(hopTo).host] };
        const hopped = await run([{ kind: 'open', name: 'hops', url: `${portal.origin}/hop1` }], hopOver, creds, { resolve: answering('10.0.0.7') });
        expect(hopped).toMatchObject({ status: 'failed', reason: 'guard_refused', atStep: 'hops' });
        expect(hopped.refused).toContainEqual({ method: 'GET', url: hopTo, reason: 'address_not_allowed', atStep: 'hops' });
        expect(saw('/hop2')).toBe(true);
        expect(target.hits).toEqual([]);

        // The same hop, the name answering with the loopback address the second fixture listens on: what the proxy
        // connects to is the answer.
        const reached = await run([{ kind: 'open', name: 'hops', url: `${portal.origin}/hop1` }], hopOver, creds, { resolve: answering('127.0.0.1') });
        expect(reached).toMatchObject({ status: 'completed', refused: [] });
        expect(target.hits).toContainEqual({ method: 'GET', path: '/deductions.html' });
      } finally {
        await target.close();
      }
    });
  });

  it.each(BUILDS)('lets a page in %s send no UDP, by WebRTC or WebTransport, though the egress proxy alone would not stop it', async (_build, executablePath) => {
    // Two loopback ports no allowlist names: one for the page behind the egress proxy and nothing else, one for the runner.
    const control = await startUdpSink();
    const sink = await startUdpSink();
    const tried = 'body[data-tried="webrtc webtransport"]';
    try {
      const egress = await startEgress({
        destinationAllowed: (url) => url.host === new URL(portal.origin).host,
        decide: () => ({ allow: true }),
        refused: () => undefined,
        destinations: FIXTURE_DESTINATIONS,
      });
      try {
        const browser = await chromium.launch({ executablePath, headless: true, args: [`--proxy-server=${egress.server}`, '--proxy-bypass-list=<-loopback>'] });
        try {
          const page = await browser.newPage();
          await page.goto(`${portal.origin}/udp.html?port=${control.port}`);
          await page.waitForSelector(tried, { timeout: 10_000 });
        } finally {
          await browser.close();
        }
      } finally {
        await egress.close();
      }
      // The page does reach a UDP port by itself, so the silence below is the runner's doing and not the page's.
      expect(control.datagrams()).toBeGreaterThan(0);
      const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/udp.html?port=${sink.port}` }, { kind: 'wait_for', name: 'tried', selector: tried }],
        {}, creds, { executablePath });
      expect(out).toMatchObject({ status: 'completed', refused: [] });
      // The runner's browser is closed; a moment for the sink to read whatever was already sent.
      await new Promise((r) => setTimeout(r, 500));
      expect(sink.datagrams()).toBe(0);
    } finally {
      await control.close();
      await sink.close();
    }
  });

  it('stops at a challenge, a terms dialog and a changed page', async () => {
    expect(await run([{ kind: 'open', name: 'start', url: `${portal.origin}/challenge.html` }, { kind: 'capture_page', name: 'c' }]))
      .toMatchObject({ status: 'needs_attention', reason: 'challenge', captures: [] });
    expect(await run([{ kind: 'open', name: 'start', url: `${portal.origin}/terms.html` }, { kind: 'capture_page', name: 'c' }]))
      .toMatchObject({ status: 'needs_attention', reason: 'terms_prompt', captures: [] });
    expect(await run([...signedIn(), { kind: 'expect', name: 'grid', selector: '#no-such-grid' }]))
      .toMatchObject({ status: 'needs_attention', reason: 'page_changed', atStep: 'grid' });
  });

  it('stops at the download cap', async () => {
    const out = await run([...checkedIn(), { kind: 'download', name: 'export', label: 'Export statement' }], { caps: { maxPages: 5, maxDownloads: 0, maxRunMs: 30_000 } });
    expect(out).toMatchObject({ status: 'failed', reason: 'cap_exceeded' });
    expect(saw('/export.pdf')).toBe(false);
  });

  // ADR 0062 §5, and the run record the worker returns (the contract's RunResult).
  describe('signing in', () => {
    it('completes a run shaped as ADR 0062 §4: sign in, answer TOTP, check the account, capture, sign out', async () => {
      await restart({ mfa: true });
      const codes: string[] = [];
      const out = await run([
        ...signedIn(),
        { kind: 'answer_mfa' },
        { kind: 'expect', name: 'account', selector: '#account' },
        { kind: 'capture_page', name: 'landing' },
        { kind: 'download', name: 'export', label: 'Export statement' },
        { kind: 'download', name: 'mine', label: 'Export my statement' },
        { kind: 'download', name: 'upper', label: 'Export user statement' },
        { kind: 'download', name: 'encoded', label: 'Export encoded statement' },
        { kind: 'sign_out' },
      ], {}, withTotp(codes), { expectAccountId: FIXTURE_ACCOUNT_ID.toLowerCase() });
      expect(out.status).toBe('completed');
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['answer_mfa', true], ['account', true], ['landing', true],
        ['export', true], ['mine', true], ['upper', true], ['encoded', true], ['sign_out', true]));
      // A filename the portal built from the username keeps the placeholder in its place: as typed, in capitals, or percent-encoded.
      expect(out.captures.map((c) => [c.kind, c.filename, c.pagePath, c.snapshotRuleVersion])).toEqual([
        ['page_snapshot', 'landing.html', '/deductions.html', SNAPSHOT_RULE_VERSION],
        ['download', 'export.pdf', '/deductions.html', null],
        ['download', 'statement-[portal-user].pdf', '/deductions.html', null],
        ['download', 'statement-[portal-user].pdf', '/deductions.html', null],
        ['download', 'statement-[portal-user].pdf', '/deductions.html', null],
      ]);
      for (const c of out.captures) expect(new Date(c.capturedAt).toISOString()).toBe(c.capturedAt);
      const html = new TextDecoder().decode(out.captures[0]!.bytes);
      expect(html).toContain('Signed in as [portal-user]');
      // The portal prints the username in capitals too.
      expect(html).toContain('User ID: [portal-user]');
      expect(html).toContain(FIXTURE_ACCOUNT_ID);
      // The sign-in page, the MFA page, the landing page and the sign-in page again after signing out.
      expect(out.pages).toBeGreaterThanOrEqual(4);
      // The fixture checked the code against its own RFC 6238, and took it.
      expect(codes).toHaveLength(1);
      expect(writes()).toEqual(['POST /login', 'POST /mfa']);
      // The username and password went once, into the bound sign-in form; the code once, into the bound MFA form.
      expect(carrying(FIXTURE_USERNAME)).toEqual(['POST /login']);
      expect(carrying(FIXTURE_PASSWORD)).toEqual(['POST /login']);
      expect(carrying(codes[0]!)).toEqual(['POST /mfa']);
      expect(carrying(FIXTURE_TOTP_SECRET)).toEqual([]);
      expect(leaked(out, [FIXTURE_USERNAME, FIXTURE_PASSWORD, FIXTURE_TOTP_SECRET])).toEqual([]);
      expect(leaked({ ...out, captures: out.captures.filter((c) => c.kind === 'page_snapshot') }, codes)).toEqual([]);
      // Signing out lands on a bound sign-in path, which is not a session that ran out.
      expect(saw('/logout')).toBe(true);
    });

    it('ends credential_rejected when the portal refuses the password, and never tries again', async () => {
      const out = await run([...signedIn(), { kind: 'answer_mfa' }, { kind: 'capture_page', name: 'landing' }], {}, { ...creds, password: () => 'pw-wrong' });
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', false]));
      expect(writes()).toEqual(['POST /login']);
      expect(carrying('pw-wrong')).toEqual(['POST /login']);
      expect(leaked(out, [FIXTURE_USERNAME, 'pw-wrong'])).toEqual([]);
    });

    it('knows a refused sign-in by the bound form and its error, wherever the portal shows them', async () => {
      await restart({ rejectBy: 'redirect' });
      const out = await run([...signedIn(), { kind: 'capture_page', name: 'landing' }], {}, { ...creds, password: () => 'pw-wrong' });
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in', captures: [] });
      expect(saw('/login-rejected.html')).toBe(true);
      expect(writes()).toEqual(['POST /login']);
      expect(leaked(out, [FIXTURE_USERNAME, 'pw-wrong'])).toEqual([]);
    });

    it('reads the portal\'s answer, not the page that passes the browser on to it', async () => {
      await restart({ rejectBy: 'redirect', interstitialMs: 300 });
      const refusedOut = await run([...signedIn(), { kind: 'capture_page', name: 'landing' }], {}, { ...creds, password: () => 'pw-wrong' });
      expect(refusedOut).toMatchObject({ status: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in', captures: [] });
      const out = await run([...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }]);
      expect(out.status).toBe('completed');
      expect(portal.hits.filter((h) => h.path === '/processing.html')).toHaveLength(2);
      expect(writes()).toEqual(['POST /login', 'POST /login']);
    });

    it('reads a refusal that comes late, at a bound path, as a refusal and not a session that ended', async () => {
      // The portal answers through a page that holds for 2.5 s, well past the 1 s that makes a page an answer, and then
      // sends the browser to `/login?error=1`.
      await restart({ rejectBy: 'query', interstitialMs: 2500 });
      const out = await run([...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }], {}, { ...creds, password: () => 'pw-wrong' });
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', false], ['on-list', false]));
      expect(portal.received.some((r) => r.method === 'GET' && r.target === '/login?error=1')).toBe(true);
      expect(writes()).toEqual(['POST /login']);
      expect(leaked(out, [FIXTURE_USERNAME, 'pw-wrong'])).toEqual([]);
    });

    it('waits for a refusal that may still come before any step acts on the page, and before the run ends', async () => {
      // As above, the portal holds a page for 2.5 s before it sends the browser to `/login?error=1`, long after the sign-in's
      // answer was read. Had the next step navigated first, it would have landed on the sign-in page with the refusal never
      // shown, and a wrong password would have read as a session that ended.
      await restart({ rejectBy: 'query', interstitialMs: 2500 });
      const wrong = { ...creds, password: () => 'pw-wrong' };
      const shapes: [RecipeStep[], [string, boolean][]][] = [
        [[{ kind: 'open', name: 'account', url: `${portal.origin}/account.html` }, { kind: 'expect', name: 'on-account', selector: '#account' }], [['account', false]]],
        [[{ kind: 'capture_page', name: 'landing' }], [['landing', false]]],
        [[{ kind: 'sign_out' }], [['sign_out', false]]],
        [[], []],
      ];
      for (const [after, logged] of shapes) {
        const out = await run([...signedIn(), ...after], {}, wrong);
        expect(out).toMatchObject({ status: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in', captures: [] });
        expect(out.steps).toEqual(log(['start', true], ['sign_in', false], ...logged));
        expect(leaked(out, [FIXTURE_USERNAME, 'pw-wrong'])).toEqual([]);
      }
      // Every refusal was seen, and no step took the page away before it came.
      expect(portal.received.filter((r) => r.method === 'GET' && r.target === '/login?error=1')).toHaveLength(shapes.length);
      expect(saw('/account.html')).toBe(false);
      expect(saw('/logout')).toBe(false);
      expect(writes()).toEqual(shapes.map(() => 'POST /login'));
    });

    it('lets a step act once a sign-in that forwards the browser slowly has had its window, and signs in once', async () => {
      await restart({ interstitialMs: 2500 });
      const out = await run([...signedIn(), { kind: 'open', name: 'account', url: `${portal.origin}/account.html` }, { kind: 'expect', name: 'on-account', selector: '#account' }]);
      expect(out.status).toBe('completed');
      expect(saw('/deductions.html')).toBe(true);
      expect(saw('/account.html')).toBe(true);
      expect(writes()).toEqual(['POST /login']);
    });

    it('waits for a code the portal asks for late, past a page that forwards the browser slowly', async () => {
      await restart({ mfa: true, interstitialMs: 2500 });
      const out = await run([...signedIn(), { kind: 'answer_mfa' }, { kind: 'expect', name: 'on-list', selector: '#deductions' }], {}, withTotp());
      expect(out.status).toBe('completed');
      expect(writes()).toEqual(['POST /login', 'POST /mfa']);
    });

    it('takes a bound page the sign-in passes through on its way in for the sign-in\'s, not a session that ended', async () => {
      // Signed in, the portal holds a page for 2.5 s, then forwards the browser through `/sso`, bound here, to the deductions page.
      await restart({ interstitialMs: 2500, ssoHop: true });
      const out = await run([...signedIn(), { kind: 'wait_for', name: 'on-list', selector: '#deductions' }, { kind: 'capture_page', name: 'landing' }],
        withSso(portal.origin));
      expect(out.status).toBe('completed');
      expect(saw('/sso')).toBe(true);
      expect(out.captures.map((c) => c.pagePath)).toEqual(['/deductions.html']);
      expect(writes()).toEqual(['POST /login']);
    });

    it('signs in where the portal shows its signed-in page at the path the form posted to, and calls that no session that ended', async () => {
      await restart({ renderAtLogin: true });
      const out = await run([...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }, { kind: 'capture_page', name: 'landing' }]);
      expect(out.status).toBe('completed');
      expect(out.captures.map((c) => c.pagePath)).toEqual(['/login']);
      expect(writes()).toEqual(['POST /login']);
    });

    it('does not call a sign-in refused when the portal shows no new error: detected, never assumed', async () => {
      // The form comes back with only the maintenance notice it had before, which is not an answer.
      await restart({ rejectBy: 'silent' });
      const out = await run(signedIn(), {}, { ...creds, password: () => 'pw-wrong' });
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'page_changed', atStep: 'sign_in', captures: [] });
      expect(writes()).toEqual(['POST /login']);
    });

    it('ends credential_rejected when the portal refuses the TOTP code, and never tries again', async () => {
      await restart({ mfa: true });
      const out = await run([...signedIn(), { kind: 'answer_mfa' }, { kind: 'capture_page', name: 'landing' }], {}, { ...creds, totp: wrongCode });
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'credential_rejected', atStep: 'answer_mfa', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['answer_mfa', false]));
      expect(writes()).toEqual(['POST /login', 'POST /mfa']);
      expect(leaked(out, [FIXTURE_USERNAME, FIXTURE_PASSWORD])).toEqual([]);
    });

    it('refuses a bound sign-in form that would submit by GET, and sends nothing typed into it', async () => {
      // One says GET; one says nothing, which is GET too; one posts until its password is typed, then says GET.
      for (const page of ['login-get.html', 'login-no-method.html', 'login-turns-get.html']) {
        const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/${page}` }, { kind: 'sign_in' }]);
        expect(out).toMatchObject({ status: 'failed', reason: 'sign_in_form_refused', atStep: 'sign_in' });
        expect(leaked(out, [FIXTURE_USERNAME, FIXTURE_PASSWORD])).toEqual([]);
      }
      // The first two pages report the first thing typed into them: a form that says GET is refused before anything is.
      expect(saw('/typed')).toBe(false);
      expect(carrying(FIXTURE_USERNAME)).toEqual([]);
      expect(carrying(FIXTURE_PASSWORD)).toEqual([]);
      expect(writes()).toEqual([]);
    });

    it('refuses a bound MFA form that would submit by GET, and computes no code for it', async () => {
      await restart({ mfa: true, mfaPage: '/mfa-get.html' });
      const codes: string[] = [];
      const out = await run([...signedIn(), { kind: 'answer_mfa' }], {}, withTotp(codes));
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'mfa_unanswerable', atStep: 'answer_mfa' });
      expect(codes).toEqual([]);
      expect(saw('/mfa')).toBe(false);
      expect(writes()).toEqual(['POST /login']);
    });

    it('ends session_expired when a later page is sent back to sign in, and never signs in again', async () => {
      await restart({ sessionPages: 1 });
      const out = await run([
        ...signedIn(),
        { kind: 'expect', name: 'on-list', selector: '#deductions' },
        { kind: 'open', name: 'account', url: `${portal.origin}/account.html` },
        { kind: 'capture_page', name: 'account-page' },
      ]);
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'session_expired', atStep: 'account', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['on-list', true], ['account', false]));
      expect(saw('/account.html')).toBe(true);
      expect(writes()).toEqual(['POST /login']);
      expect(carrying(FIXTURE_PASSWORD)).toEqual(['POST /login']);
      expect(leaked(out, [FIXTURE_USERNAME, FIXTURE_PASSWORD])).toEqual([]);
    });

    it('knows the sign-in page by its bound form when a session ends somewhere the binding does not name', async () => {
      await restart({ sessionPages: 1, signInRedirect: '/login.html' });
      const out = await run([...signedIn(), { kind: 'open', name: 'account', url: `${portal.origin}/account.html` }, { kind: 'capture_page', name: 'account-page' }]);
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'session_expired', atStep: 'account', captures: [] });
      expect(writes()).toEqual(['POST /login']);
    });

    it('ends session_expired when a navigation lands on a bound path, whatever that page shows', async () => {
      // The first step after signing in, while a late answer could still come: `/sso` shows no form, and is no sign-in's answer.
      await restart({ sessionPages: 1, signInRedirect: '/sso' });
      const out = await run([...signedIn(), { kind: 'open', name: 'account', url: `${portal.origin}/account.html` }, { kind: 'capture_page', name: 'account-page' }],
        withSso(portal.origin));
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'session_expired', atStep: 'account', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['account', false]));
      expect(saw('/sso')).toBe(true);
      expect(writes()).toEqual(['POST /login']);
    });

    it('ends session_expired when the first step after answering MFA lands on a bound path', async () => {
      await restart({ mfa: true, sessionPages: 1, signInRedirect: '/sso' });
      const out = await run([...signedIn(), { kind: 'answer_mfa' }, { kind: 'open', name: 'account', url: `${portal.origin}/account.html` }, { kind: 'capture_page', name: 'account-page' }],
        withSso(portal.origin), withTotp());
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'session_expired', atStep: 'account', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['answer_mfa', true], ['account', false]));
      expect(saw('/sso')).toBe(true);
      expect(writes()).toEqual(['POST /login', 'POST /mfa']);
    });

    it('never signs in twice in one run, even after signing out', async () => {
      // Two rows, so the steps inside run twice: the second sign-in is refused before anything is typed.
      const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/login.html` },
        { kind: 'for_each', name: 'twice', rowSelector: 'input[name=username], input[name=password]', maxRows: 2, steps: [{ kind: 'sign_in' }, { kind: 'sign_out' }] }]);
      expect(out).toMatchObject({ status: 'failed', reason: 'sign_in_form_refused', atStep: 'sign_in' });
      expect(out.steps).toEqual(log(['start', true], ['twice', false], ['sign_in', false], ['sign_out', true]));
      expect(writes()).toEqual(['POST /login']);
      expect(carrying(FIXTURE_PASSWORD)).toEqual(['POST /login']);
    });

    it('does not take a sign-in form nobody can see for the portal asking to sign in again', async () => {
      // The account page carries a "switch user" form under visibility: hidden, and another under opacity: 0.
      const out = await run([...checkedIn(), { kind: 'open', name: 'account', url: `${portal.origin}/account.html` }, { kind: 'expect', name: 'on-account', selector: '#account' }]);
      expect(out.status).toBe('completed');
      expect(writes()).toEqual(['POST /login']);
    });

    it('ends mfa_unanswerable when the credential has no TOTP secret, and sends no code', async () => {
      await restart({ mfa: true });
      const out = await run([...signedIn(), { kind: 'answer_mfa' }, { kind: 'capture_page', name: 'landing' }]);
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'mfa_unanswerable', atStep: 'answer_mfa', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['answer_mfa', false]));
      expect(writes()).toEqual(['POST /login']);
      expect(leaked(out, [FIXTURE_USERNAME, FIXTURE_PASSWORD])).toEqual([]);
    });

    it('answers MFA once per run: a second pass through a for_each computes no second code and posts nothing', async () => {
      await restart({ mfa: true });
      const codes: string[] = [];
      // Two rows on the MFA page (its heading and its form), so the steps inside run twice.
      const out = await run([...signedIn(), { kind: 'for_each', name: 'twice', rowSelector: 'h1, form', maxRows: 2,
        steps: [{ kind: 'answer_mfa' }, { kind: 'expect', name: 'on-list', text: 'Deductions' }] }], {}, withTotp(codes));
      expect(out).toMatchObject({ status: 'failed', reason: 'sign_in_form_refused', atStep: 'answer_mfa' });
      expect(codes).toHaveLength(1);
      expect(writes()).toEqual(['POST /login', 'POST /mfa']);
      expect(carrying(codes[0]!)).toEqual(['POST /mfa']);
    });

    it('computes no code when this run\'s sign-in asked for none: before signing in, or signed in and out without being asked', async () => {
      await restart({ mfa: true });
      const codes: string[] = [];
      const before = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/mfa.html` }, { kind: 'answer_mfa' }], {}, withTotp(codes));
      expect(before).toMatchObject({ status: 'needs_attention', reason: 'mfa_unanswerable', atStep: 'answer_mfa' });
      await restart({});
      const after = await run([...checkedIn(), { kind: 'sign_out' }, { kind: 'open', name: 'mfa-page', url: `${portal.origin}/mfa.html` }, { kind: 'answer_mfa' }], {}, withTotp(codes));
      expect(after).toMatchObject({ status: 'needs_attention', reason: 'mfa_unanswerable', atStep: 'answer_mfa' });
      expect(codes).toEqual([]);
      expect(writes()).toEqual(['POST /login']);
    });

    it('ends mfa_unanswerable when the portal asks for a code the recipe never gives', async () => {
      await restart({ mfa: true });
      const out = await run([...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }], {}, withTotp());
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'mfa_unanswerable', atStep: 'on-list', captures: [] });
      expect(writes()).toEqual(['POST /login']);
    });

    it('ends account_mismatch when the portal shows another account, before anything is captured', async () => {
      // The production ANID, while the portal shows its -T test account.
      const out = await run([...signedIn(), { kind: 'expect', name: 'account', selector: '#account' }, { kind: 'capture_page', name: 'landing' }], {}, creds,
        { expectAccountId: 'AN0100000001' });
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'account_mismatch', atStep: 'account', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['account', false]));
    });

    it('knows an account id the portal prints with a space in it, as whole words', async () => {
      const steps = (): RecipeStep[] => [...signedIn(), { kind: 'expect', name: 'supplier', selector: '#supplier' }, { kind: 'capture_page', name: 'landing' }];
      const shown = await run(steps(), {}, creds, { expectAccountId: FIXTURE_SUPPLIER_NUMBER });
      expect(shown.status).toBe('completed');
      expect(shown.captures).toHaveLength(1);
      // The page prints SUP 4471, which is not SUP 447.
      expect(await run(steps(), {}, creds, { expectAccountId: 'SUP 447' }))
        .toMatchObject({ status: 'needs_attention', reason: 'account_mismatch', atStep: 'supplier', captures: [] });
    });

    it('captures nothing, and presses no download, before the account has been shown', async () => {
      const out = await run([...signedIn(), { kind: 'capture_page', name: 'landing' }, { kind: 'download', name: 'export', label: 'Export statement' }], {}, creds,
        { expectAccountId: FIXTURE_ACCOUNT_ID });
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'account_mismatch', atStep: 'landing', captures: [] });
      expect(saw('/export.pdf')).toBe(false);
    });

    it('in a dry run, runs every step, checks the download control and captures nothing', async () => {
      const steps = (label: string): RecipeStep[] => [
        ...signedIn(),
        { kind: 'expect', name: 'account', selector: '#account' },
        { kind: 'capture_page', name: 'landing' },
        { kind: 'download', name: 'export', label },
        { kind: 'sign_out' },
      ];
      const out = await run(steps('Export statement'), {}, creds, { dryRun: true, expectAccountId: FIXTURE_ACCOUNT_ID });
      expect(out.status).toBe('completed');
      expect(out.captures).toEqual([]);
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['account', true], ['landing', true], ['export', true], ['sign_out', true]));
      expect(saw('/export.pdf')).toBe(false);
      // The same refusals as a real run: a control on the never-click floor is refused, never pressed.
      expect(await run(steps('Submit dispute'), {}, creds, { dryRun: true })).toMatchObject({ status: 'failed', reason: 'never_click', atStep: 'export' });
      expect(saw('/dispute')).toBe(false);
      expect(writes()).toEqual(['POST /login', 'POST /login']);
    });

    it('names an exception by its class alone, and keeps what the run did before it', async () => {
      await restart({ mfa: true });
      class TotpUnavailable extends Error {
        override readonly name = 'TotpUnavailable';
      }
      const out = await run([...signedIn(), { kind: 'answer_mfa' }], {}, { ...creds, totp: () => { throw new TotpUnavailable(`no code from ${FIXTURE_TOTP_SECRET}`); } });
      expect(out).toMatchObject({ status: 'failed', reason: 'error', errorClass: 'TotpUnavailable', atStep: 'answer_mfa', captures: [] });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['answer_mfa', false]));
      expect(leaked(out, [FIXTURE_TOTP_SECRET, FIXTURE_USERNAME, FIXTURE_PASSWORD])).toEqual([]);
      expect(writes()).toEqual(['POST /login']);
    });

    it('logs each step once, and fails the for_each around the step that stopped', async () => {
      const out = await run([...signedIn(), { kind: 'for_each', name: 'rows', rowSelector: '#deductions tbody tr', maxRows: 3,
        steps: [{ kind: 'expect', name: 'first-claim', selector: 'td:text-is("DN-1001")' }] }]);
      expect(out).toMatchObject({ status: 'needs_attention', reason: 'page_changed', atStep: 'first-claim' });
      expect(out.steps).toEqual(log(['start', true], ['sign_in', true], ['rows', false], ['first-claim', false]));
    });
  });
});

/**
 * Speaks to a proxy as a browser does, on one connection: `first`, and then,
 * once a CONNECT is answered 200, `through` the tunnel. Resolves with every
 * byte the proxy sent back before the connection closed.
 */
function viaProxy(proxy: string, first: string, through?: string): Promise<string> {
  const { hostname, port } = new URL(proxy);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => { socket.write(first); });
    let answer = '';
    let tunnelled = false;
    socket.setTimeout(5_000, () => {
      reject(new Error('the proxy neither answered nor closed the connection'));
      socket.destroy();
    });
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1');
      if (through !== undefined && !tunnelled && answer.startsWith('HTTP/1.1 200') && answer.includes('\r\n\r\n')) {
        tunnelled = true;
        socket.write(through);
      }
    });
    // A connection the proxy resets is closed as surely as one it ends: what arrived before is the answer, and 'close' follows.
    socket.on('error', () => undefined);
    socket.on('close', () => { resolve(answer); });
  });
}

describe('the egress proxy', () => {
  let allowed: FixturePortal;
  let other: FixturePortal;
  let egress: Egress;
  /** Every destination the proxy asked about, as it asked. */
  const asked: string[] = [];
  const hostOf = (p: FixturePortal) => new URL(p.origin).host;
  beforeEach(async () => {
    allowed = await startFixturePortal();
    other = await startFixturePortal();
    asked.length = 0;
    egress = await startEgress({
      destinationAllowed: (url) => {
        asked.push(url.href);
        return url.host === hostOf(allowed);
      },
      decide: () => ({ allow: true }),
      refused: () => undefined,
      destinations: FIXTURE_DESTINATIONS,
    });
  });
  afterEach(async () => {
    await egress.close();
    await allowed.close();
    await other.close();
  });

  it('tunnels a CONNECT to an allowed host, and answers one to any other host 403', async () => {
    const tunnelled = await viaProxy(egress.server, `CONNECT ${hostOf(allowed)} HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\n\r\n`,
      `GET /login.html HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nConnection: close\r\n\r\n`);
    expect(tunnelled).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK\r\n/);
    expect(tunnelled).toContain('Supplier portal');
    expect(allowed.hits).toEqual([{ method: 'GET', path: '/login.html' }]);
    const refused = await viaProxy(egress.server, `CONNECT ${hostOf(other)} HTTP/1.1\r\nHost: ${hostOf(other)}\r\n\r\n`,
      `GET /login.html HTTP/1.1\r\nHost: ${hostOf(other)}\r\nConnection: close\r\n\r\n`);
    expect(refused).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(refused).not.toContain('Supplier portal');
    expect(other.hits).toEqual([]);
    // A tunnel's destination is asked as an https origin: what is said inside it is the portal's.
    expect(asked).toEqual([`https://${hostOf(allowed)}/`, `https://${hostOf(other)}/`]);
  });

  it('forwards a plain-http request to an allowed host, and closes unanswered the connection of any other', async () => {
    const forwarded = await viaProxy(egress.server, `GET ${allowed.origin}/login.html HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nConnection: close\r\n\r\n`);
    expect(forwarded).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(forwarded).toContain('Supplier portal');
    expect(await viaProxy(egress.server, `GET ${other.origin}/login.html HTTP/1.1\r\nHost: ${hostOf(other)}\r\nConnection: close\r\n\r\n`)).toBe('');
    // Nor anything that is not a browser asking its proxy for a URL: a request in origin form, a URL carrying credentials.
    expect(await viaProxy(egress.server, `GET /login.html HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nConnection: close\r\n\r\n`)).toBe('');
    expect(await viaProxy(egress.server, `GET http://user:pw@${hostOf(allowed)}/login.html HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nConnection: close\r\n\r\n`)).toBe('');
    expect(allowed.hits).toEqual([{ method: 'GET', path: '/login.html' }]);
    expect(other.hits).toEqual([]);
    // A plain request's destination is asked as its own URL.
    expect(asked).toEqual([`${allowed.origin}/login.html`, `${other.origin}/login.html`]);
  });

  /** A proxy that lets GETs and HEADs to `allowed` through and refuses every other request it reads, keeping what it refused. */
  const guarded = (o: { destinations?: DestinationPolicy; resolve?: Resolver; hosts?: string[] } = {}) => {
    const refusals: [method: string, url: string, reason: EgressRefusal, navigation: boolean][] = [];
    const started = startEgress({
      destinationAllowed: (url) => (o.hosts ?? [hostOf(allowed)]).includes(url.host),
      decide: (r: EgressRequest) => (r.method === 'GET' || r.method === 'HEAD' ? { allow: true } : { allow: false, reason: 'non_get_not_allowed' }),
      refused: (r, reason) => { refusals.push([r.method, r.url, reason, r.navigation]); },
      destinations: o.destinations ?? FIXTURE_DESTINATIONS,
      resolve: o.resolve,
    });
    return { started, refusals };
  };

  it('reads what the browser says inside a tunnel: refuses an upgrade and what the guard refuses there, counting each, and sends neither', async () => {
    const { started, refusals } = guarded();
    const proxy = await started;
    try {
      const connect = `CONNECT ${hostOf(allowed)} HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\n\r\n`;
      const upgrade = await viaProxy(proxy.server, connect,
        `GET /ws HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      expect(upgrade).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 403 Forbidden\r\n/);
      const post = await viaProxy(proxy.server, connect,
        `POST /dispute HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 13\r\nConnection: close\r\n\r\nclaim=DN-1001`);
      expect(post).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 403 Forbidden\r\n/);
      const get = await viaProxy(proxy.server, connect, `GET /login.html HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nConnection: close\r\n\r\n`);
      expect(get).toContain('Supplier portal');
      expect(refusals).toEqual([
        ['WEBSOCKET', `ws://${hostOf(allowed)}/ws`, 'scheme_not_allowed', false],
        ['POST', `http://${hostOf(allowed)}/dispute`, 'non_get_not_allowed', false],
      ]);
      expect(allowed.hits).toEqual([{ method: 'GET', path: '/login.html' }]);
    } finally {
      await proxy.close();
    }
  });

  it('sends a request to the host it decided, whatever Host the request names, and refuses a body larger than it reads', async () => {
    const { started, refusals } = guarded();
    const proxy = await started;
    try {
      // A Host naming another site on the same address is written over with the host that was decided.
      const answered = await viaProxy(proxy.server, `GET ${allowed.origin}/login.html HTTP/1.1\r\nHost: internal.example\r\nConnection: close\r\n\r\n`);
      expect(answered).toContain('Supplier portal');
      expect(allowed.received.map((r) => r.host)).toEqual([hostOf(allowed)]);
      const big = 'x'.repeat(MAX_BODY_BYTES + 1);
      const refused = await viaProxy(proxy.server, `POST ${allowed.origin}/search HTTP/1.1\r\nHost: ${hostOf(allowed)}\r\nContent-Length: ${big.length}\r\nConnection: close\r\n\r\n${big}`);
      expect(refused).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
      expect(refusals).toEqual([['POST', `${allowed.origin}/search`, 'body_too_large', false]]);
      expect(allowed.hits).toEqual([{ method: 'GET', path: '/login.html' }]);
    } finally {
      await proxy.close();
    }
  });

  it('connects only to an address its destinations admit, every answer for a name checked, and to the answer it checked', async () => {
    const port = new URL(allowed.origin).port;
    const named = `http://portal.example:${port}`;
    const cases: [policy: DestinationPolicy, answers: string[], reaches: boolean][] = [
      [FIXTURE_DESTINATIONS, ['127.0.0.1'], true],
      // Loopback is all a test's policy adds: a private answer is refused.
      [FIXTURE_DESTINATIONS, ['10.0.0.7'], false],
      [FIXTURE_DESTINATIONS, ['169.254.169.254'], false],
      // One answer not admitted refuses the name, whichever answer a connection would have taken.
      [FIXTURE_DESTINATIONS, ['127.0.0.1', '10.0.0.7'], false],
      // The production policy: public addresses over https, so plain http reaches nothing, loopback least of all.
      [PUBLIC_DESTINATIONS_ONLY, ['127.0.0.1'], false],
      [PUBLIC_DESTINATIONS_ONLY, ['93.184.215.14'], false],
    ];
    for (const [policy, answers, reaches] of cases) {
      const asked: string[] = [];
      const { started, refusals } = guarded({
        destinations: policy,
        hosts: [`portal.example:${port}`],
        resolve: async (hostname) => { asked.push(hostname); return answers.map((address) => ({ address, family: 4 })); },
      });
      const proxy = await started;
      try {
        const hitsBefore = allowed.hits.length;
        const answer = await viaProxy(proxy.server, `GET ${named}/login.html HTTP/1.1\r\nHost: portal.example:${port}\r\nConnection: close\r\n\r\n`);
        if (reaches) {
          expect(answer).toContain('Supplier portal');
          expect(refusals).toEqual([]);
          expect(allowed.hits.slice(hitsBefore)).toEqual([{ method: 'GET', path: '/login.html' }]);
        } else {
          expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
          expect(refusals).toEqual([['GET', `${named}/login.html`, 'address_not_allowed', false]]);
          expect(allowed.hits.slice(hitsBefore)).toEqual([]);
        }
        // Plain http under the production policy is refused before any name is looked up.
        expect(asked).toEqual(policy.allowLoopback ? ['portal.example'] : []);
      } finally {
        await proxy.close();
      }
    }
    // An address written as the host is held to the same rule, with no lookup to make.
    const { started, refusals } = guarded({ hosts: ['10.0.0.7'] });
    const proxy = await started;
    try {
      expect(await viaProxy(proxy.server, 'GET http://10.0.0.7/ HTTP/1.1\r\nHost: 10.0.0.7\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
      expect(refusals).toEqual([['GET', 'http://10.0.0.7/', 'address_not_allowed', false]]);
    } finally {
      await proxy.close();
    }
  });

  it('answers TLS in a tunnel with its own key, and sends a request on only to a portal whose certificate a root vouches for', async () => {
    // A portal whose certificate nothing vouches for, as one impersonated on the way would present.
    const own = egressCertificate();
    let reachedUpstream = 0;
    const upstream = createHttpsServer({ key: own.key, cert: own.cert }, (_req, res) => { reachedUpstream++; res.end('reached'); });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const port = (upstream.address() as AddressInfo).port;
    const asked: string[] = [];
    const { started, refusals } = guarded({
      hosts: [`portal.example:${port}`],
      resolve: async (hostname) => { asked.push(hostname); return [{ address: '127.0.0.1', family: 4 }]; },
    });
    const proxy = await started;
    try {
      const { spkiSha256, answer } = await throughTls(proxy.server, `portal.example:${port}`,
        `GET /statement HTTP/1.1\r\nHost: portal.example:${port}\r\nConnection: close\r\n\r\n`);
      // The proxy answered the handshake itself, with the key the browser is told to accept.
      expect(spkiSha256).toBe(proxy.spkiSha256);
      // Decided, resolved, and cut when the portal's certificate did not verify: the page is a network error, never the impostor's.
      expect(asked).toEqual(['portal.example']);
      expect(answer).toBe('');
      expect(refusals).toEqual([]);
      expect(reachedUpstream).toBe(0);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

/**
 * Opens a tunnel to `target` through the proxy, speaks TLS in it as a browser
 * would (accepting whatever key answers, and saying which), sends `request`,
 * and resolves with what came back before the connection closed.
 */
function throughTls(proxy: string, target: string, request: string): Promise<{ spkiSha256: string; answer: string }> {
  const { hostname, port } = new URL(proxy);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => { socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`); });
    socket.setTimeout(10_000, () => {
      reject(new Error('the proxy neither answered nor closed the tunnel'));
      socket.destroy();
    });
    let head = '';
    const onHead = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.off('data', onHead);
      if (!head.startsWith('HTTP/1.1 200')) {
        reject(new Error('the proxy refused the tunnel'));
        socket.destroy();
        return;
      }
      const tls = tlsConnect({ socket, servername: target.split(':')[0], rejectUnauthorized: false }, () => {
        const spki = tls.getPeerX509Certificate()!.publicKey.export({ type: 'spki', format: 'der' });
        const spkiSha256 = createHash('sha256').update(spki).digest('base64');
        let answer = '';
        tls.on('data', (data: Buffer) => { answer += data.toString('latin1'); });
        tls.on('error', () => undefined);
        tls.on('close', () => resolve({ spkiSha256, answer }));
        tls.write(request);
      });
      tls.on('error', (e) => reject(e));
    };
    socket.on('data', onHead);
    socket.on('error', () => undefined);
  });
}

describe('showsAccountId', () => {
  it('matches the id folded as the index folds it, over whole words and runs of them', () => {
    expect(showsAccountId('ANID: AN0100000001-T', FIXTURE_ACCOUNT_ID)).toBe(true);
    expect(showsAccountId('ANID: AN0100000001-T', 'an0100000001 t')).toBe(true);
    expect(showsAccountId('Supplier no. SUP 4471', FIXTURE_SUPPLIER_NUMBER)).toBe(true);
    expect(showsAccountId('Supplier no. SUP 4471', 'SUP4471')).toBe(true);
    expect(showsAccountId('Supplier no. SUP - 4471', 'sup-4471')).toBe(true);
    expect(showsAccountId('Supplier\nSUP\n4471', FIXTURE_SUPPLIER_NUMBER)).toBe(true);
  });

  it('matches no part of a word: another account is not this one', () => {
    expect(showsAccountId('ANID: AN0100000001-T', 'AN0100000001')).toBe(false);
    expect(showsAccountId('Supplier no. SUP 4471', 'SUP 447')).toBe(false);
    expect(showsAccountId('Supplier no. SUP 4471', 'UP 4471')).toBe(false);
    expect(showsAccountId('Supplier no. SUP 44710', FIXTURE_SUPPLIER_NUMBER)).toBe(false);
    expect(showsAccountId('Supplier no. XSUP 4471', FIXTURE_SUPPLIER_NUMBER)).toBe(false);
  });

  it('shows nothing for an id with no letters or digits', () => {
    expect(showsAccountId('- -- ---', '---')).toBe(false);
    expect(showsAccountId('', FIXTURE_SUPPLIER_NUMBER)).toBe(false);
  });
});

describe('withoutUsername, as a run applies it to a snapshot and to a download\'s name', () => {
  it('replaces the username in any case, percent-encoded and HTML-escaped', () => {
    for (const name of ['statement-jane.doe@acme.test.pdf', 'statement-JANE.DOE@ACME.TEST.pdf', 'statement-jane.doe%40acme.test.pdf', 'statement-JANE.DOE%40ACME.TEST.pdf']) {
      expect(withoutUsername(name, FIXTURE_USERNAME)).toBe(`statement-${USERNAME_PLACEHOLDER}.pdf`);
    }
    expect(withoutUsername('a&amp;b and A&B', 'a&b')).toBe(`${USERNAME_PLACEHOLDER} and ${USERNAME_PLACEHOLDER}`);
    // A snapshot folds each run of whitespace to one space.
    expect(withoutUsername('Signed in as Jane  Doe', 'jane doe')).toBe(`Signed in as ${USERNAME_PLACEHOLDER}`);
  });

  it('matches the username literally, and one no URL can carry still', () => {
    expect(withoutUsername('a.b.c and axb', 'a.b')).toBe(`${USERNAME_PLACEHOLDER}.c and axb`);
    expect(withoutUsername('x\uD800y', 'x\uD800y')).toBe(USERNAME_PLACEHOLDER);
  });
});
