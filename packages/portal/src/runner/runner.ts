// The read-only runner (ADR 0057 §1, §3). Every request the browser makes is
// routed through decideRequest; a refused navigation or form submission ends
// the run. No model and no tool: a recipe is interpreted, never reasoned about.
// setInputFiles is never called. This module is the only place Playwright is
// imported, and the package index does not re-export it.
import { readFile } from 'node:fs/promises';
import { chromium, type Locator, type Page, type Request, type Route } from 'playwright';
import { decideRequest, type GuardDecision, type RequestContext } from '../guard';
import { effectiveNeverClick, matchesNeverClick, stepName, type RecipeStep, type RecipeVersion } from '../recipe';
import { serialiseSnapshot } from './snapshot';

export interface CredentialSource { username(): string; password(): string; totp?(): string } // test-only values; no KMS here

import type { Capture } from '../capture';
export type { Capture };
export type RefusedRequest = { method: string; url: string; reason: Exclude<GuardDecision, { allow: true }>['reason']; atStep: string | null };
type Refusals = { refused: RefusedRequest[] };
export type RunOutcome =
  | ({ status: 'completed'; captures: Capture[] } & Refusals)
  | ({ status: 'needs_attention'; reason: 'challenge' | 'page_changed' | 'terms_prompt' | 'mfa_unanswerable'; captures: Capture[]; atStep: string } & Refusals)
  | ({ status: 'failed'; reason: 'guard_refused' | 'never_click' | 'file_input' | 'cap_exceeded' | 'sign_in_form_refused'; captures: Capture[]; atStep: string } & Refusals);

type Stop =
  | { status: 'needs_attention'; reason: 'challenge' | 'page_changed' | 'terms_prompt' | 'mfa_unanswerable' }
  | { status: 'failed'; reason: 'guard_refused' | 'never_click' | 'file_input' | 'cap_exceeded' | 'sign_in_form_refused' };

class StopRun extends Error {
  constructor(readonly stop: Stop, readonly atStep: string) { super(`${stop.status}:${stop.reason}`); }
}

const STEP_TIMEOUT_MS = 5_000;
const CHALLENGE_SELECTORS = ['#captcha', '.captcha', '.g-recaptcha', '.h-captcha', 'iframe[src*="captcha" i]', 'iframe[title*="challenge" i]'];
const CHALLENGE_TEXT = /verify (that )?you are (a )?human|captcha/i;

export async function runRecipe(
  recipe: RecipeVersion,
  creds: CredentialSource,
  opts: { executablePath: string; params?: Record<string, string>; now?: () => number },
): Promise<RunOutcome> {
  const now = opts.now ?? Date.now;
  const started = now();
  const neverClick = effectiveNeverClick(recipe);
  const captures: Capture[] = [];
  const refused: RefusedRequest[] = [];
  let active: RequestContext['activeStep'] = null;
  let navigationRefused = false;
  let pages = 0;
  let downloads = 0;

  const browser = await chromium.launch({ executablePath: opts.executablePath, headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, javaScriptEnabled: true });
    await context.route('**/*', async (route: Route, request: Request) => {
      const decision = decideRequest(recipe, { method: request.method(), url: request.url(), body: request.postData(), activeStep: active });
      const refuse = async (method: string, url: string, reason: RefusedRequest['reason']): Promise<void> => {
        refused.push({ method, url, reason, atStep: active?.name ?? null });
        if (request.isNavigationRequest()) navigationRefused = true;
        await route.abort('blockedbyclient');
      };
      if (!decision.allow) { await refuse(request.method(), request.url(), decision.reason); return; }
      // The browser follows a redirect without asking the route again, so the
      // hop is fetched here, unfollowed, and its target put to the same guard:
      // a 307/308 re-sends the method and body, anything else becomes a GET.
      const resp = await route.fetch({ maxRedirects: 0 });
      const location = resp.status() >= 300 && resp.status() < 400 ? resp.headers()['location'] : undefined;
      if (location !== undefined) {
        const keep = resp.status() === 307 || resp.status() === 308;
        const next = { method: keep ? request.method() : 'GET', url: new URL(location, request.url()).href, body: keep ? request.postData() : null };
        const hop = decideRequest(recipe, { ...next, activeStep: active });
        if (!hop.allow) { await refuse(next.method, next.url, hop.reason); return; }
      }
      await route.fulfill({ response: resp });
    });
    // A WebSocket never passes through context.route; none is allowed.
    await context.routeWebSocket(/.*/, async (ws) => {
      refused.push({ method: 'WEBSOCKET', url: ws.url(), reason: 'scheme_not_allowed', atStep: active?.name ?? null });
      await ws.close();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);

    const stop = (s: Stop, at: string): never => { throw new StopRun(s, at); };

    const settle = async (at: string, action: () => Promise<unknown>): Promise<void> => {
      await Promise.all([page.waitForNavigation({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined), action()]);
      await page.waitForLoadState('load').catch(() => undefined);
      if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
    };

    const checkPage = async (at: string): Promise<void> => {
      if (page.url() === 'about:blank') return;
      for (const sel of CHALLENGE_SELECTORS) {
        if ((await page.locator(sel).count()) > 0) stop({ status: 'needs_attention', reason: 'challenge' }, at);
      }
      const body = await page.locator('body').innerText().catch(() => '');
      if (CHALLENGE_TEXT.test(body)) stop({ status: 'needs_attention', reason: 'challenge' }, at);
      const dismissTexts = collectDismiss(recipe.steps).map((d) => norm(d.containerText));
      const dialogs = page.locator('[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]');
      for (let i = 0; i < (await dialogs.count()); i++) {
        const dialog = dialogs.nth(i);
        if (!(await dialog.isVisible())) continue;
        const controls = await dialog.locator('button, a, [role="button"], input[type="submit"], input[type="button"]').allInnerTexts();
        if (controls.some((c) => matchesNeverClick(c, neverClick)) && !dismissTexts.includes(norm(await dialog.innerText()))) {
          stop({ status: 'needs_attention', reason: 'terms_prompt' }, at);
        }
      }
    };

    const guardedClick = async (el: Locator, label: string, at: string): Promise<void> => {
      if ((await el.count()) !== 1) stop({ status: 'needs_attention', reason: 'page_changed' }, at);
      const tag = await el.evaluate((n) => { const e = n as unknown as { tagName: string; type?: string }; return e.tagName.toLowerCase() === 'input' ? (e.type ?? '') : e.tagName.toLowerCase(); });
      if (tag === 'file') stop({ status: 'failed', reason: 'file_input' }, at);
      const visible = await el.innerText().catch(() => '');
      const aria = (await el.getAttribute('aria-label')) ?? '';
      if ([label, visible, aria].some((t) => matchesNeverClick(t, neverClick))) stop({ status: 'failed', reason: 'never_click' }, at);
    };

    const clickable = (scope: Page | Locator, label: string): Locator =>
      scope.getByRole('link', { name: label, exact: true }).or(scope.getByRole('button', { name: label, exact: true }));

    const boundForm = async (paths: readonly string[], at: string, refusal: Stop): Promise<Locator> => {
      const origin = new URL(recipe.signIn.origin).origin;
      const forms = page.locator('form');
      const matches: Locator[] = [];
      for (let i = 0; i < (await forms.count()); i++) {
        const action = await forms.nth(i).evaluate((f) => (f as unknown as FormLike).action);
        const u = new URL(action);
        if (u.origin === origin && paths.includes(u.pathname)) matches.push(forms.nth(i));
      }
      if (matches.length !== 1) stop(refusal, at);
      return matches[0]!;
    };

    const runSteps = async (steps: readonly RecipeStep[], scope: Page | Locator): Promise<void> => {
      for (const step of steps) {
        const at = stepName(step);
        if (now() - started > recipe.caps.maxRunMs) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
        await checkPage(at);
        active = { kind: step.kind, name: at, ...(step.kind === 'search' ? { recordedAction: step.recordedAction } : {}) };
        switch (step.kind) {
          case 'open':
            await settle(at, () => page.goto(step.url).catch(() => undefined));
            break;
          case 'sign_in': {
            const form = await boundForm(recipe.signIn.formPaths, at, { status: 'failed', reason: 'sign_in_form_refused' });
            if ((await form.locator('input[type="password"]').count()) !== 1) stop({ status: 'failed', reason: 'sign_in_form_refused' }, at);
            const user = form.locator('input[type="text"], input[type="email"], input:not([type])');
            if ((await user.count()) !== 1) stop({ status: 'failed', reason: 'sign_in_form_refused' }, at);
            await user.fill(creds.username());
            await form.locator('input[type="password"]').fill(creds.password());
            await settle(at, () => form.evaluate((f) => (f as unknown as FormLike).requestSubmit()));
            break;
          }
          case 'answer_mfa': {
            if (creds.totp === undefined) stop({ status: 'needs_attention', reason: 'mfa_unanswerable' }, at);
            const form = await boundForm(recipe.signIn.mfaPaths, at, { status: 'needs_attention', reason: 'mfa_unanswerable' });
            const input = form.locator('input[type="text"], input[type="number"], input:not([type])');
            if ((await input.count()) !== 1) stop({ status: 'needs_attention', reason: 'mfa_unanswerable' }, at);
            await input.fill(creds.totp!());
            await settle(at, () => form.evaluate((f) => (f as unknown as FormLike).requestSubmit()));
            break;
          }
          case 'dismiss': {
            const container = page.locator(step.selector);
            if ((await container.count()) !== 1 || norm(await container.innerText()) !== norm(step.containerText)) {
              stop({ status: 'needs_attention', reason: 'terms_prompt' }, at);
            }
            const control = clickable(container, step.label);
            if ((await control.count()) !== 1) stop({ status: 'needs_attention', reason: 'terms_prompt' }, at);
            await guardedClick(control, step.label, at);
            await settle(at, () => control.click());
            break;
          }
          case 'follow':
          case 'next_page': {
            const el = clickable(scope, step.label);
            if (step.kind === 'next_page' && (await el.count()) === 0) break; // no further page
            await guardedClick(el, step.label, at);
            if (step.kind === 'next_page' && ++pages > Math.min(step.maxPages, recipe.caps.maxPages)) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
            await settle(at, () => el.click());
            break;
          }
          case 'search': {
            const form = page.locator(step.formSelector);
            if ((await form.count()) !== 1) stop({ status: 'needs_attention', reason: 'page_changed' }, at);
            if ((await form.locator('input[type="file"]').count()) > 0) stop({ status: 'failed', reason: 'file_input' }, at);
            const { method, action } = await form.evaluate((f) => ({ method: (f as unknown as FormLike).method, action: (f as unknown as FormLike).action }));
            if (method.toUpperCase() !== step.recordedMethod.toUpperCase() || action !== new URL(step.recordedAction).href) {
              stop({ status: 'failed', reason: 'guard_refused' }, at);
            }
            const named = Object.keys(step.fields);
            const fields = form.locator('input:not([type="submit"]):not([type="button"]):not([type="hidden"]), select, textarea');
            for (let i = 0; i < (await fields.count()); i++) {
              const f = fields.nth(i);
              if (!(await Promise.all(named.map((sel) => f.evaluate((n, s) => n.matches(s), sel)))).some(Boolean)) {
                stop({ status: 'failed', reason: 'guard_refused' }, at);
              }
            }
            for (const [sel, param] of Object.entries(step.fields)) {
              const value = opts.params?.[param];
              if (value === undefined) stop({ status: 'needs_attention', reason: 'page_changed' }, at);
              await form.locator(sel).fill(value!);
            }
            await settle(at, () => form.evaluate((f) => (f as unknown as FormLike).requestSubmit()));
            break;
          }
          case 'wait_for':
            if (!(await page.waitForSelector(step.selector, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false))) {
              stop({ status: 'needs_attention', reason: 'page_changed' }, at);
            }
            break;
          case 'expect': {
            const bySelector = step.selector === undefined || (await scope.locator(step.selector).count()) > 0;
            const byText = step.text === undefined || (await page.locator('body').innerText()).includes(step.text);
            if (!bySelector || !byText) stop({ status: 'needs_attention', reason: 'page_changed' }, at);
            break;
          }
          case 'capture_page': {
            if (captures.filter((c) => c.kind === 'page_snapshot').length >= recipe.caps.maxPages) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
            const html = serialiseSnapshot(await page.content(), creds.username());
            captures.push({ kind: 'page_snapshot', stepName: at, filename: `${at}.html`, bytes: new TextEncoder().encode(html), mimeType: 'text/html' });
            break;
          }
          case 'download': {
            const el = clickable(scope, step.label);
            await guardedClick(el, step.label, at);
            if (downloads >= recipe.caps.maxDownloads) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
            downloads++;
            const [download] = await Promise.all([page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }), el.click()]);
            if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
            const path = await download.path();
            const filename = download.suggestedFilename();
            captures.push({ kind: 'download', stepName: at, filename, bytes: new Uint8Array(await readFile(path)), mimeType: mimeFor(filename) });
            break;
          }
          case 'for_each': {
            const rows = page.locator(step.rowSelector);
            const n = Math.min(await rows.count(), step.maxRows);
            const url = page.url();
            for (let i = 0; i < n; i++) {
              await runSteps(step.steps, rows.nth(i));
              if (page.url() !== url) await settle(at, () => page.goto(url));
            }
            break;
          }
          case 'sign_out': {
            const out = page.getByRole('link', { name: /^(sign|log) ?out$/i }).or(page.getByRole('button', { name: /^(sign|log) ?out$/i }));
            if ((await out.count()) === 1) await settle(at, () => out.click());
            break;
          }
        }
        if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
      }
    };

    try {
      await runSteps(recipe.steps, page);
      return { status: 'completed', captures, refused };
    } catch (e) {
      if (e instanceof StopRun) return { ...e.stop, captures, atStep: e.atStep, refused } as RunOutcome;
      throw e;
    }
  } finally {
    await browser.close();
  }
}

/** The browser-side form, typed without the DOM lib. */
type FormLike = { action: string; method: string; requestSubmit(): void };

function collectDismiss(steps: readonly RecipeStep[]): Extract<RecipeStep, { kind: 'dismiss' }>[] {
  return steps.flatMap((s) => (s.kind === 'dismiss' ? [s] : s.kind === 'for_each' ? collectDismiss(s.steps) : []));
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}
