import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRecipe, type RecipeStep } from '../src/recipe';
import { runRecipe, type CredentialSource } from '../src/runner/runner';
import { startFixturePortal, type FixturePortal } from './fixture-portal/server';
import { recipeJson } from './recipe-fixture';

// The container keeps a Chromium at /opt/pw-browsers; CI installs Playwright's
// own (`playwright install chromium`). In CI a missing browser fails the run
// rather than skipping it, because a skipped guard test is not a passing one.
const CHROMIUM = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath();
if (process.env.CI && !existsSync(CHROMIUM)) {
  throw new Error(`no Chromium at ${CHROMIUM}: run \`pnpm exec playwright install --with-deps chromium\``);
}
const creds: CredentialSource = { username: () => 'jane.doe@acme.test', password: () => 'pw-not-real' };

describe.skipIf(!existsSync(CHROMIUM))('runRecipe against the fixture portal', { timeout: 60_000 }, () => {
  let portal: FixturePortal;
  beforeEach(async () => { portal = await startFixturePortal(); });
  afterEach(async () => { await portal.close(); });

  const run = (steps: RecipeStep[], over: Record<string, unknown> = {}, c: CredentialSource = creds) =>
    runRecipe(parseRecipe(recipeJson(portal.origin, { steps, ...over })), c, { executablePath: CHROMIUM });
  const signedIn = (): RecipeStep[] => [{ kind: 'open', name: 'start', url: `${portal.origin}/login.html` }, { kind: 'sign_in' }];
  const nonGet = () => portal.hits.filter((h) => h.method !== 'GET' && h.method !== 'HEAD');
  const saw = (path: string) => portal.hits.some((h) => h.path === path);

  it('signs in, captures the deductions page and downloads the export', async () => {
    const out = await run([...signedIn(), { kind: 'expect', name: 'on-list', selector: '#deductions' }, { kind: 'capture_page', name: 'list' }, { kind: 'download', name: 'export', label: 'Export statement' }]);
    expect(out.status).toBe('completed');
    expect(out.captures.map((c) => [c.kind, c.mimeType])).toEqual([['page_snapshot', 'text/html'], ['download', 'application/pdf']]);
    const html = new TextDecoder().decode(out.captures[0]!.bytes);
    expect(html).toContain('DN-1002');
    expect(html).not.toContain('<form');
    expect(new TextDecoder().decode(out.captures[1]!.bytes.slice(0, 5))).toBe('%PDF-');
    expect(nonGet()).toEqual([{ method: 'POST', path: '/login' }]);
  });

  it('answers MFA through the bound form, and stops when it cannot', async () => {
    await portal.close();
    portal = await startFixturePortal({ mfa: true });
    const steps = (): RecipeStep[] => [...signedIn(), { kind: 'answer_mfa' }, { kind: 'expect', name: 'on-list', selector: '#deductions' }];
    expect((await run(steps(), {}, { ...creds, totp: () => '123456' })).status).toBe('completed');
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
    const out = await run([...signedIn(), { kind: 'follow', name: 'dispute', label: 'Submit dispute' }]);
    expect(out).toMatchObject({ status: 'failed', reason: 'never_click', atStep: 'dispute' });
    expect(saw('/dispute')).toBe(false);
  });

  it('refuses a search whose form is not the one recorded', async () => {
    for (const id of ['reauth', 'change']) {
      const out = await run([...signedIn(), { kind: 'open', name: 'reauth', url: `${portal.origin}/reauth.html` },
        { kind: 'search', name: 'find', formSelector: `#${id}`, fields: { 'input[name=q]': 'claim' }, recordedMethod: 'post', recordedAction: `${portal.origin}/search` }], {}, creds);
      expect(out).toMatchObject({ status: 'failed', reason: 'guard_refused' });
    }
    expect(saw('/reauth')).toBe(false);
    expect(saw('/change-password')).toBe(false);
  });

  it('allows a search to its recorded action', async () => {
    const out = await runRecipe(parseRecipe(recipeJson(portal.origin, { steps: [{ kind: 'open', name: 'start', url: `${portal.origin}/reauth.html` },
      { kind: 'search', name: 'find', formSelector: '#search', fields: { 'input[name=q]': 'claim' }, recordedMethod: 'post', recordedAction: `${portal.origin}/search` }] })),
      creds, { executablePath: CHROMIUM, params: { claim: 'DN-1001' } });
    expect(out.status).toBe('completed');
    expect(nonGet()).toEqual([{ method: 'POST', path: '/search' }]);
  });

  it('aborts a POST a page script makes, and records it', async () => {
    const out = await run([{ kind: 'open', name: 'start', url: `${portal.origin}/script-post.html` }, { kind: 'wait_for', name: 'done', selector: 'body[data-done]' }]);
    expect(out.status).toBe('completed');
    expect(out.refused).toEqual([{ method: 'POST', url: `${portal.origin}/dispute`, reason: 'non_get_not_allowed', atStep: 'start' }]);
    expect(saw('/dispute')).toBe(false);
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

  it('stops at a challenge, a terms dialog and a changed page', async () => {
    expect(await run([{ kind: 'open', name: 'start', url: `${portal.origin}/challenge.html` }, { kind: 'capture_page', name: 'c' }]))
      .toMatchObject({ status: 'needs_attention', reason: 'challenge', captures: [] });
    expect(await run([{ kind: 'open', name: 'start', url: `${portal.origin}/terms.html` }, { kind: 'capture_page', name: 'c' }]))
      .toMatchObject({ status: 'needs_attention', reason: 'terms_prompt', captures: [] });
    expect(await run([...signedIn(), { kind: 'expect', name: 'grid', selector: '#no-such-grid' }]))
      .toMatchObject({ status: 'needs_attention', reason: 'page_changed', atStep: 'grid' });
  });

  it('stops at the download cap', async () => {
    const out = await run([...signedIn(), { kind: 'download', name: 'export', label: 'Export statement' }], { caps: { maxPages: 5, maxDownloads: 0, maxRunMs: 30_000 } });
    expect(out).toMatchObject({ status: 'failed', reason: 'cap_exceeded' });
    expect(saw('/export.pdf')).toBe(false);
  });
});
