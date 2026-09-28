// The read-only runner (ADR 0057 §1, §3). Every request the browser sends is
// put to decideRequest before it reaches the network, in one of two places:
//  - the route handler, for every request Playwright routes: a page's, from
//    any of its frames or a dedicated worker. A refusal is aborted there, in
//    the browser; an allowed request is handed back to the browser to send;
//  - the egress proxy (egress.ts), the browser's only way out, for everything
//    the browser sends: what the route handler allowed, decided again, and
//    what Playwright never routes. That is each hop of a redirect (a 307 that
//    re-sends a body among them), a request whose frame has gone (a beacon or
//    a keepalive fetch as a page unloads), a WebSocket from a worker or a
//    `WebSocketStream`, a download. The proxy reads inside https as well, and
//    connects only to an address the run's `destinations` admit, so a public
//    name whose DNS answer is private reaches nothing.
// Shared workers are switched off and service workers blocked, since neither
// is routed. A refused navigation or form submission ends the run. No model
// and no tool: a recipe is interpreted, never reasoned about. setInputFiles is
// never called. This module is the only place Playwright is imported, and the
// package index does not re-export it.
//
// A credential is typed once per run, only into the bound forms (ADR 0057 §7),
// and only into one that posts: a form that submits by GET would put what was
// typed in the URL. After a bound form is submitted, a page that is still a
// sign-in page and shows an error the submission added ends the run
// `credential_rejected`, and nothing here tries again; so does one that comes
// later, past a page that forwards the browser, within the submission's
// window, for until that window closes no step acts on the page and no run
// completes, unless a step has checked the page first. After sign-in
// succeeded, a navigation that lands on a bound path, or a page that shows the
// bound sign-in form, ends it `session_expired`, in whichever step it came, and
// the credential is not typed a second time (ADR 0062 §5).
//
// However a run ends, its outcome carries the step log, the page count and
// what was captured before it ended (the contract's `RunResult`), and nothing
// that was typed.
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Locator, type Page, type Request, type Route } from 'playwright';
import type { Capture } from '../capture';
import {
  PORTAL_LIMITS,
  type PortalRunnerFailedReason,
  type PortalWorkerNeedsAttentionReason,
  type RunStepLogEntry,
} from '../contracts';
import { decideRequest, type RequestContext } from '../guard';
import { effectiveNeverClick, matchesNeverClick, stepName, type RecipeStep, type RecipeVersion } from '../recipe';
import { showsAccountId } from './account-id';
import type { DestinationPolicy } from './destination-policy';
import { egressSwitches, startEgress, type EgressRefusal, type Resolver } from './egress';
import { SNAPSHOT_RULE_VERSION, serialiseSnapshot, withoutUsername } from './snapshot';

export type { Capture };

/**
 * Where the runner gets what it types (ADR 0057 §7-8): the worker's reads the
 * payload it decrypted for this run, a test's holds plain test values. Each
 * value is asked for as it is typed, into a bound form and nowhere else, and
 * the runner keeps none of them: no value reaches a capture, an outcome, a
 * refusal or an error. The username is also asked for to replace it in what is
 * captured (§9).
 *
 * `totp` gives the code for the bound MFA form, computed from the credential's
 * TOTP secret when it is about to be typed; it may wait for a fresh step first,
 * so it may return a promise. Absent, an `answer_mfa` step ends the run
 * `mfa_unanswerable`.
 */
export interface CredentialSource {
  username(): string;
  password(): string;
  totp?(): string | Promise<string>;
}

export interface RunOptions {
  /** The Chromium to drive: the worker's, or the test container's. */
  readonly executablePath: string;
  /** The connection's run parameters, which `search` steps type into their fields. */
  readonly params?: Readonly<Record<string, string>> | undefined;
  /** The clock the run-time cap is measured by. */
  readonly now?: (() => number) | undefined;
  /**
   * ADR 0057 §3's dry run: the same steps, refusals, allowlist, binding and
   * caps, but a `capture_page` step captures nothing and a `download` step
   * checks its control as a real run would and never presses it. Nothing is
   * captured; the run's record is its step log.
   */
  readonly dryRun?: boolean | undefined;
  /**
   * The connection's account id (ADR 0057 §13). When given, the first `expect`
   * after sign-in must also show it (in what its selector matches, else on the
   * page), as whole words folded as `portal_connections_one_enabled_per_account`
   * folds it (account-id.ts): `AN 0100000001` shows `AN0100000001`, and
   * `AN0100000001-T` does not. If it does not, the run ends `account_mismatch`;
   * and nothing is captured, nor any download pressed, before it has been
   * shown.
   */
  readonly expectAccountId?: string | undefined;
  /**
   * Which addresses the browser may connect to (destination-policy.ts). The
   * worker passes its own: public destinations only, over https, in
   * production; loopback as well for a test's worker, whose fixture portal
   * serves plain http there. Required, so no caller runs a recipe without
   * saying which.
   */
  readonly destinations: DestinationPolicy;
  /** How the egress proxy resolves a name: `dns.lookup`, unless a test answers for it. */
  readonly resolve?: Resolver | undefined;
}

/**
 * A capture as a run makes it: what ingest takes (`Capture`), with the path of
 * the page it was made on and when (the contract's `RunCapture`). The path is
 * the URL's pathname, never its query or fragment; it can still carry `;`
 * parameters or a cookieless session segment, which the worker strips before
 * the path goes anywhere (the contract's `pagePath` rule).
 */
export type RunnerCapture = Capture & {
  readonly pagePath: string;
  /** ISO 8601, by the run's clock. */
  readonly capturedAt: string;
  /** The rule that serialised a page snapshot (`SNAPSHOT_RULE_VERSION`); null for a download, stored as it arrived. */
  readonly snapshotRuleVersion: number | null;
};

/**
 * A request refused: by the guard, where the route handler, the runner or the
 * egress proxy put it to the guard, or by the proxy's own rules (an address
 * the run's `destinations` do not admit, a body too large to decide on). For
 * the worker to count, never to list or log: a URL can carry a query.
 */
export type RefusedRequest = { method: string; url: string; reason: EgressRefusal; atStep: string | null };

/** The `needs_attention` reasons a run can end with. `binding_mismatch` is the worker's, found before a run starts. */
export type RunnerNeedsAttentionReason = Exclude<PortalWorkerNeedsAttentionReason, 'binding_mismatch'>;

/** What every outcome carries, however the run ended. */
type RunRecord = {
  /** What was captured before the run ended. Never anything in a dry run. */
  captures: RunnerCapture[];
  refused: RefusedRequest[];
  /**
   * One line per step name, in the order each first ran: false for the step
   * the run stopped at and each `for_each` around it, true for every other
   * step that ran. No values (the contract's `RunStepLogEntry`).
   */
  steps: RunStepLogEntry[];
  /** Main-frame page loads that settled. */
  pages: number;
};

export type RunOutcome =
  | ({ status: 'completed' } & RunRecord)
  | ({ status: 'needs_attention'; reason: RunnerNeedsAttentionReason; atStep: string } & RunRecord)
  | ({ status: 'failed'; reason: PortalRunnerFailedReason; atStep: string } & RunRecord)
  // An exception, named by its class alone: its message could quote a page, a URL or a value typed.
  | ({ status: 'failed'; reason: 'error'; errorClass: string; atStep: string | null } & RunRecord);

/**
 * A page the run navigated to could not be fetched: the portal's server
 * dropped the request or could not be reached, or answered with a redirect no
 * browser follows. The run ends `failed` under this name; no URL is kept.
 */
export class PortalPageUnavailableError extends Error {
  override readonly name = 'PortalPageUnavailableError';
  constructor() {
    super('a page the run navigated to could not be fetched');
  }
}

type Stop =
  | { status: 'needs_attention'; reason: RunnerNeedsAttentionReason }
  | { status: 'failed'; reason: PortalRunnerFailedReason };

class StopRun extends Error {
  constructor(readonly stop: Stop, readonly atStep: string) { super(`${stop.status}:${stop.reason}`); }
}

function stop(s: Stop, at: string): never {
  throw new StopRun(s, at);
}

/** How a run that did not complete ends. */
type End =
  | { status: 'needs_attention'; reason: RunnerNeedsAttentionReason; atStep: string }
  | { status: 'failed'; reason: PortalRunnerFailedReason; atStep: string }
  | { status: 'failed'; reason: 'error'; errorClass: string; atStep: string | null };

/**
 * Where a run is in signing in. `submitted` is from the moment the sign-in
 * form is filled until its answer is read, `mfa_pending` while the portal
 * waits for a code, and `signed_out` after a `sign_out` step, when the sign-in
 * page is where a portal is expected to go.
 */
type SignInState = 'not_yet' | 'submitted' | 'mfa_pending' | 'signed_in' | 'signed_out';

/** The steps that submit a bound form. */
type Stage = 'sign_in' | 'answer_mfa';

/** The bound forms a page shows: visible, posting to a bound path on the sign-in origin. */
type BoundForms = { signInForm: boolean; mfaForm: boolean };

/** Where a bound form's submission has left the page, the form a page shows before the path it is at. */
type Place = 'sign_in_form' | 'mfa_form' | 'sign_in_path' | 'mfa_path' | 'acs_path' | 'elsewhere';

/**
 * What a bound form's submission was answered with:
 *  - `signed_in`: off every sign-in page, and that held, or the window closed
 *    there;
 *  - `bound_path`: when the window closed, a bound path showing neither form:
 *    a redirect page, or the portal's own page rendered where the form posted.
 *    Signed in, for the next step to check;
 *  - `mfa`: after the sign-in form, the bound MFA page;
 *  - `rejected`: still on a bound page, with an error the submission added;
 *  - `sign_in_form`, `mfa_form`: still on that bound form when the window
 *    closed, with no error to say why.
 */
type Answer = 'signed_in' | 'bound_path' | 'mfa' | 'rejected' | 'sign_in_form' | 'mfa_form';

const STEP_TIMEOUT_MS = 5_000;
/** How long a bound form's submission may take to leave the sign-in pages: redirects, a SAML post, an MFA page. */
const SIGN_IN_SETTLE_MS = 10_000;
/** How long a reading of the page after a submission must hold before it is believed: a status shown while the portal works is not its answer. */
const SIGN_IN_STEADY_MS = 1_000;
const SIGN_IN_POLL_MS = 100;
/** How long a run that has stopped waits to read whether the page is the sign-in page. */
const SESSION_READ_MS = 1_000;
/**
 * How a request the browser gave up on reads when it is not a failure of the
 * page: the route handler's own abort of a refused one, and one the browser
 * cancelled (a navigation another replaced, one that became a download).
 */
const NOT_A_FAILED_PAGE = new Set(['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_ABORTED']);
const CHALLENGE_SELECTORS = ['#captcha', '.captcha', '.g-recaptcha', '.h-captcha', 'iframe[src*="captcha" i]', 'iframe[title*="challenge" i]'];
const CHALLENGE_TEXT = /verify (that )?you are (a )?human|captcha/i;
/**
 * How a page marks an error, in markup any portal may use: an alert, an
 * invalid field, or an element whose class or id names an error. Only an
 * error a submission added counts (ADR 0062 §5: detected, not assumed).
 */
const SIGN_IN_ERROR_SELECTOR = '[role="alert"], [aria-live="assertive"], [aria-invalid="true"], [class*="error" i], [id*="error" i]';
/** An error message is a sentence or two; a longer text is a region of the page. */
const SIGN_IN_ERROR_MAX_CHARS = 500;
/**
 * The stops that can be the session ending, seen from inside a step: the page
 * is not what the step expected. The sign-in's own answers, an account shown
 * that is not the connection's, and every hard stop are what they say.
 */
const YIELDS_TO_SESSION: ReadonlySet<Stop['reason']> = new Set(['page_changed', 'challenge', 'terms_prompt', 'mfa_unanswerable']);
/**
 * The steps that act on the page or keep what it shows: they navigate, click,
 * submit or capture. None starts while a sign-in's answer may still come
 * (settleSignIn): a page that forwards the browser slowly can still be on its
 * way to a refusal, and a step that navigated first would land on the sign-in
 * page with the refusal never shown, a wrong password read as a session that
 * ended (ADR 0062 §5).
 */
const ACTS_ON_PAGE: ReadonlySet<RecipeStep['kind']> = new Set(['open', 'dismiss', 'follow', 'next_page', 'search', 'download', 'capture_page', 'sign_out']);
/** The steps that check the page is the one the recipe expects. One that passes after a sign-in is the portal having let the run in. */
const CHECKS_PAGE: ReadonlySet<RecipeStep['kind']> = new Set(['expect', 'wait_for']);
/**
 * What counts as shown: not hidden by `display`, `content-visibility`,
 * `visibility` or `opacity`. Chromium's `checkVisibility()` checks only the
 * first two unless asked; the options carry the names it took before 121 too.
 */
const SEEN = { visibilityProperty: true, opacityProperty: true, checkVisibilityCSS: true, checkOpacity: true } as const;
/** A class name as a run row takes one (the contract's `errorClass`). */
const ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/**
 * What a page could run that the route handler never sees. Playwright routes
 * the requests of a page, its frames and its dedicated workers, and not a
 * shared worker's; the egress proxy would still decide each of them, but a
 * shared worker outlives the page that started it, and nothing here needs
 * one. So shared workers are off; the context blocks service workers.
 */
const UNROUTED_OFF = ['--disable-shared-workers'];

export async function runRecipe(recipe: RecipeVersion, creds: CredentialSource, opts: RunOptions): Promise<RunOutcome> {
  const now = opts.now ?? Date.now;
  const started = now();
  const neverClick = effectiveNeverClick(recipe);
  const dismissTexts = collectDismiss(recipe.steps).map((d) => norm(d.containerText));
  const signInOrigin = new URL(recipe.signIn.origin).origin;
  /** Every path the binding names (ADR 0057 §7): the sign-in, MFA and assertion-consumer paths. */
  const signInPaths = [...recipe.signIn.formPaths, ...recipe.signIn.mfaPaths, ...recipe.signIn.acsPaths];
  const answersMfa = everyStep(recipe.steps).some((s) => s.kind === 'answer_mfa');
  const expectAccountId = opts.expectAccountId;
  const dryRun = opts.dryRun === true;
  const captures: RunnerCapture[] = [];
  const refused: RefusedRequest[] = [];
  /** Each step name, in the order it first ran, and whether it passed. */
  const log = new Map<string, boolean>();
  /** The steps running now, outermost first: a `for_each` and the step inside it. */
  const path: string[] = [];
  let active: RequestContext['activeStep'] = null;
  let navigationRefused = false;
  let navigationFailed = false;
  // Widened on purpose: the steps change it inside closures, where the compiler cannot follow.
  let signIn = 'not_yet' as SignInState;
  /** Whether this run has computed an MFA code: at most one per run, ever. */
  let mfaAnswered = false;
  /**
   * Whether a main-frame navigation has landed on a bound path since the
   * sign-in's answer was read (ADR 0062 §5). Only a navigation counts: the
   * page the answer was read on is that answer, whatever path it is at.
   */
  let landedOnSignIn = false;
  /**
   * A sign-in's answer that may still come (ADR 0062 §5). A bound form's
   * submission is taken as answered once a page other than a sign-in page has
   * held, or when its window closes on a bound path showing neither form; a
   * page that forwards the browser more slowly than that can still bring the
   * portal's answer, until `until`, the submission's window, has closed, or a
   * step that checks the page (CHECKS_PAGE) has passed. Until then no step
   * acts on the page (ACTS_ON_PAGE) and the run does not complete: each waits
   * for the answer first (settleSignIn).
   */
  let pending = null as { stage: Stage; before: ReadonlySet<string>; until: number } | null;
  let accountShown = expectAccountId === undefined;
  let loads = 0;
  let pagesFollowed = 0;
  let snapshots = 0;
  let downloads = 0;

  const onSignInPath = (url: string, paths: readonly string[]): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false; // not a URL, so not a bound path
    }
    return parsed.origin === signInOrigin && paths.includes(parsed.pathname);
  };

  // Beneath the browser, and so beneath everything the route handler never
  // sees, and again beneath what it allowed: the guard for every request the
  // browser sends, with the step running when it arrives, and the run's
  // destinations for every connection it opens. A destination off the
  // allowlist is refused unread and uncounted (most of it is the browser's own
  // traffic; the page's is counted where the route handler and the hop
  // listener below see it); a request read and refused is counted here, and a
  // navigation refused ends the run.
  const egress = await startEgress({
    destinationAllowed: (url) => decideRequest(recipe, { method: 'GET', url: url.href, body: null, activeStep: null }).allow,
    decide: (request) => decideRequest(recipe, { method: request.method, url: request.url, body: request.body, activeStep: active }),
    refused: (request, reason) => {
      refused.push({ method: request.method, url: request.url, reason, atStep: active?.name ?? null });
      if (request.navigation) navigationRefused = true;
    },
    destinations: opts.destinations,
    resolve: opts.resolve,
  });
  try {
    const browser = await chromium.launch({ executablePath: opts.executablePath, headless: true, args: [...egressSwitches(egress), ...UNROUTED_OFF] });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, javaScriptEnabled: true });
      // A refusal is aborted in the browser, and so never reaches the proxy. An
      // allowed request is handed back to the browser, which sends it through
      // the proxy: decided again there, and sent on only to an address the run
      // admits. So is every hop the browser follows after it, a 307 that
      // re-sends a body among them, since Playwright routes a chain's first
      // request and no hop after it.
      const guardRequest = async (route: Route, request: Request): Promise<void> => {
        const decision = decideRequest(recipe, { method: request.method(), url: request.url(), body: request.postData(), activeStep: active });
        if (!decision.allow) {
          refused.push({ method: request.method(), url: request.url(), reason: decision.reason, atStep: active?.name ?? null });
          if (request.isNavigationRequest()) navigationRefused = true;
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      };
      await context.route('**/*', async (route: Route, request: Request) => {
        try {
          await guardRequest(route, request);
        } catch {
          // The request was already answered, or the browser is closing. It
          // fails in the browser as a network error would, and a page that
          // could not be fetched ends the run (PortalPageUnavailableError). A
          // rejection left here would be unhandled, and would end the worker's
          // process.
          if (isTopLevelNavigation(request)) navigationFailed = true;
          // An abort that fails finds the request already answered, or the browser gone: nothing is left to end.
          await route.abort('failed').catch(() => undefined);
        }
      });
      // A hop the browser follows by itself never reaches the route handler.
      // The proxy decides it before it is sent; here it is put to the guard as
      // well, so that a refused navigation ends the run as any refused
      // navigation does. A hop to a destination the proxy refuses unread (a
      // host off the allowlist, a scheme that is not http(s)) is counted here;
      // any other refusal the proxy reads, and counts.
      context.on('request', (request: Request) => {
        if (request.redirectedFrom() === null) return; // the route handler decided it
        const decision = decideRequest(recipe, { method: request.method(), url: request.url(), body: request.postData(), activeStep: active });
        if (decision.allow) return;
        if (decision.reason === 'host_not_allowed' || decision.reason === 'scheme_not_allowed') {
          refused.push({ method: request.method(), url: request.url(), reason: decision.reason, atStep: active?.name ?? null });
        }
        if (request.isNavigationRequest()) navigationRefused = true;
      });
      // A page the browser could not fetch: the portal's server dropped the
      // request or could not be reached, or its certificate did not verify.
      // Whichever step it came in, the run ends (PortalPageUnavailableError).
      // No URL is kept.
      context.on('requestfailed', (request: Request) => {
        if (isTopLevelNavigation(request) && !NOT_A_FAILED_PAGE.has(request.failure()?.errorText ?? '')) navigationFailed = true;
      });
      // A page's own WebSocket, in any of its frames, never connects: Playwright
      // answers it here. One from a worker, or a `WebSocketStream`, which this
      // does not reach, goes to the proxy as an upgrade, and is refused there.
      await context.routeWebSocket(/.*/, async (ws) => {
        refused.push({ method: 'WEBSOCKET', url: ws.url(), reason: 'scheme_not_allowed', atStep: active?.name ?? null });
        // Never connected to the server; a close that fails finds the page gone. Left unhandled, it would end the worker's process.
        await ws.close().catch(() => undefined);
      });
      const page = await context.newPage();
      page.setDefaultTimeout(STEP_TIMEOUT_MS);
      page.on('load', () => { loads++; });
      // After sign-in, a main-frame navigation that lands on a bound path is the
      // portal asking to sign in again, an assertion-consumer path as much as a
      // sign-in or MFA path, in whichever step it comes. While a sign-in's
      // answer may still come, the page it lands on is read for that answer
      // first (lateAnswer).
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() && signIn === 'signed_in' && onSignInPath(frame.url(), signInPaths)) landedOnSignIn = true;
      });

      const settle = async (at: string, action: () => Promise<unknown>): Promise<void> => {
        await Promise.all([page.waitForNavigation({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined), action()]);
        await page.waitForLoadState('load').catch(() => undefined);
        if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
        if (navigationFailed) throw new PortalPageUnavailableError();
      };

      const challengeShown = async (bodyWaitMs: number = STEP_TIMEOUT_MS): Promise<boolean> => {
        for (const sel of CHALLENGE_SELECTORS) {
          if ((await page.locator(sel).count()) > 0) return true;
        }
        return CHALLENGE_TEXT.test(await page.locator('body').innerText({ timeout: bodyWaitMs }).catch(() => ''));
      };

      const checkPage = async (at: string): Promise<void> => {
        if (page.url() === 'about:blank') return;
        if (await challengeShown()) stop({ status: 'needs_attention', reason: 'challenge' }, at);
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

      // The page readers below run in the browser. They name no inner function,
      // so a transpiler that wraps named functions in a helper of its own cannot
      // put a call to it where the page has none.
      const readForms = (): Promise<BoundForms> =>
        page.locator('form').evaluateAll(
          (nodes, bound) => {
            let signInForm = false;
            let mfaForm = false;
            for (const node of nodes) {
              const form = node as unknown as ElementLike;
              // A control named "action" shadows the property: not a form this can place.
              if (!form.checkVisibility(bound.seen) || typeof form.action !== 'string') continue;
              let url: URL;
              try {
                url = new URL(form.action);
              } catch {
                continue;
              }
              if (url.origin !== bound.origin) continue;
              if (bound.formPaths.includes(url.pathname) && form.querySelector('input[type="password"]') !== null) signInForm = true;
              if (bound.mfaPaths.includes(url.pathname)) mfaForm = true;
            }
            return { signInForm, mfaForm };
          },
          { origin: signInOrigin, formPaths: recipe.signIn.formPaths, mfaPaths: recipe.signIn.mfaPaths, seen: SEEN },
        );

      /** The error messages the page shows, by text, and an invalid field by a marker. Compared, never kept. */
      const readErrors = (): Promise<string[]> =>
        page.locator(SIGN_IN_ERROR_SELECTOR).evaluateAll(
          (nodes, a) =>
            nodes.flatMap((node) => {
              const el = node as unknown as ElementLike;
              if (!el.checkVisibility(a.seen)) return [];
              const tag = el.tagName.toUpperCase();
              if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
                return el.getAttribute('aria-invalid') === 'true' ? [`invalid field ${el.getAttribute('name') ?? ''}`] : [];
              }
              // A region that holds a form or its controls is the page, not a message on it.
              if (tag === 'HTML' || tag === 'BODY' || tag === 'FORM' || el.querySelector('form, input, select, textarea, button') !== null) return [];
              const text = el.innerText.replace(/\s+/g, ' ').trim();
              return text !== '' && text.length <= a.maxChars ? [text] : [];
            }),
          { maxChars: SIGN_IN_ERROR_MAX_CHARS, seen: SEEN },
        );

      const readFormsSettled = async (): Promise<BoundForms> => {
        try {
          return await readForms();
        } catch {
          // A navigation replaced the document as it was read: read the one it loaded, and fail if that cannot be read either.
          await page.waitForLoadState('load').catch(() => undefined);
          return readForms();
        }
      };

      const placeOf = (url: string, forms: BoundForms): Place =>
        forms.signInForm ? 'sign_in_form'
          : forms.mfaForm ? 'mfa_form'
            : onSignInPath(url, recipe.signIn.formPaths) ? 'sign_in_path'
              : onSignInPath(url, recipe.signIn.mfaPaths) ? 'mfa_path'
                : onSignInPath(url, recipe.signIn.acsPaths) ? 'acs_path'
                  : 'elsewhere';

      /**
       * What a bound form's submission was answered with (ADR 0062 §5), read
       * until the reading holds or `until`, with the step still active so that
       * a SAML post to a bound path is still the sign-in's:
       *  - off every sign-in page, once that has held, is signed in: a page
       *    that sends the browser on at once (an interstitial) is not the
       *    portal's answer;
       *  - after the sign-in form, a bound MFA page means a code is wanted;
       *  - still on a bound page, with an error the submission added that has
       *    held, is a rejection: a status shown while the portal works is not
       *    its answer;
       *  - still on a bound form when the window closes, with no error to say
       *    why, is that form again: a rejection is detected, never assumed;
       *  - a bound path showing neither form (a redirect page, or the portal's
       *    page rendered where the form posted) is waited out, then taken as
       *    signed in for the next step to check (`bound_path`).
       */
      const readAnswer = async (at: string, stage: Stage, before: ReadonlySet<string>, until: number): Promise<Answer> => {
        let seenUrl = page.url();
        let reading = '';
        let since = Date.now();
        for (;;) {
          if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
          if (navigationFailed) throw new PortalPageUnavailableError();
          const last = Date.now() >= until;
          const url = page.url();
          if (url !== seenUrl && !last) {
            // A later hop: read the page it loads, not the one it replaces.
            seenUrl = url;
            await page.waitForLoadState('load', { timeout: Math.max(1, until - Date.now()) }).catch(() => undefined);
            continue;
          }
          let forms: BoundForms;
          let errors: string[];
          let challenge: boolean;
          try {
            forms = await readForms();
            errors = await readErrors();
            challenge = await challengeShown(SIGN_IN_POLL_MS);
          } catch (e) {
            // The document was replaced as it was read. Read again, unless the window has closed.
            if (last) throw e;
            await sleep(SIGN_IN_POLL_MS);
            continue;
          }
          // A navigation committed while the page was read, so what was read may be either page's: read the new one.
          if (page.url() !== url && !last) continue;
          if (challenge) stop({ status: 'needs_attention', reason: 'challenge' }, at);
          const where = placeOf(url, forms);
          const rejected = where !== 'elsewhere' && where !== 'acs_path' && errors.some((e) => !before.has(e));
          const key = `${where} ${String(rejected)} ${url}`;
          if (key !== reading) {
            reading = key;
            since = Date.now();
          }
          const held = Date.now() - since >= SIGN_IN_STEADY_MS;
          if (where === 'elsewhere' && held) return 'signed_in';
          if (stage === 'sign_in' && (where === 'mfa_form' || where === 'mfa_path')) return 'mfa';
          if (rejected && (held || last)) return 'rejected';
          if (last) return where === 'sign_in_form' || where === 'mfa_form' ? where : where === 'elsewhere' ? 'signed_in' : 'bound_path';
          await sleep(SIGN_IN_POLL_MS);
        }
      };

      /** A submission's answer, read as its step reads it: a rejection, or the form again, ends the run there. */
      const answerOf = async (at: string, stage: Stage, before: ReadonlySet<string>): Promise<'signed_in' | 'mfa'> => {
        const until = Date.now() + SIGN_IN_SETTLE_MS;
        const answer = await readAnswer(at, stage, before, until);
        if (answer === 'rejected') stop({ status: 'needs_attention', reason: 'credential_rejected' }, at);
        if (answer === 'sign_in_form') stop({ status: 'needs_attention', reason: 'page_changed' }, at);
        if (answer === 'mfa_form') stop({ status: 'needs_attention', reason: 'mfa_unanswerable' }, at);
        if (answer === 'mfa') return 'mfa';
        // Signed in, or left on a bound path for the next step to check: the portal's answer may still come.
        pending = { stage, before, until };
        return 'signed_in';
      };

      /**
       * Whether a sign-in's late answer has come, by `until` (at once, if that
       * has passed): a navigation since the answer was read has landed on a
       * bound path, or the page shows a bound sign-in or MFA form. A bound path
       * the answer was read on was read until its window closed, and is not
       * read again. Never throws.
       */
      const lateAnswerCame = async (until: number): Promise<boolean> => {
        for (;;) {
          if (landedOnSignIn) return true;
          const forms = await within(SESSION_READ_MS, readForms(), undefined);
          if (forms !== undefined && (forms.signInForm || forms.mfaForm)) return true;
          if (Date.now() >= until) return false;
          await sleep(SIGN_IN_POLL_MS);
        }
      };

      /**
       * A sign-in's answer that came late (ADR 0062 §5), while one may still
       * come (`pending`). It is read as the submission's answer is, until it
       * holds, and with the submitting step active, so that a SAML post to a
       * bound path is still the sign-in's; a rejection ends the run at the
       * step that submitted, never retried. The MFA page after the sign-in is
       * a code wanted. A page that moved on, off every sign-in page, and held
       * there was still on its way in: the bound pages it passed were the
       * sign-in's, not a session that ended. The sign-in form again with no
       * error to say why, and a bound path the page stays on, are left to the
       * session's rule. `waitForIt` waits for such a page until the
       * submission's window closes; otherwise the page is read as it is now.
       */
      const lateAnswer = async (waitForIt: boolean): Promise<void> => {
        const p = pending;
        if (p === null) return;
        const was = active;
        active = { kind: p.stage, name: p.stage };
        try {
          if (!(await lateAnswerCame(waitForIt ? p.until : 0))) return;
          pending = null;
          const answer = await readAnswer(p.stage, p.stage, p.before, Math.max(p.until, Date.now() + 2 * SIGN_IN_STEADY_MS));
          if (answer === 'rejected') stop({ status: 'needs_attention', reason: 'credential_rejected' }, p.stage);
          if (answer === 'mfa_form') stop({ status: 'needs_attention', reason: 'mfa_unanswerable' }, p.stage);
          if (answer === 'mfa') signIn = 'mfa_pending';
          if (answer === 'mfa' || answer === 'signed_in') landedOnSignIn = false;
        } finally {
          active = was;
        }
      };

      /**
       * Waits out a sign-in's answer that may still come, before a step acts
       * on the page (ACTS_ON_PAGE) or the run completes: until the answer
       * comes, read as lateAnswer reads it, or the submission's window closes
       * with none, and the answer already read stands. It costs a run the rest
       * of that window only when a step that acts comes before any step that
       * checks the page, which a recipe shaped as ADR 0062 §4 never has.
       */
      const settleSignIn = async (): Promise<void> => {
        if (pending === null) return;
        await lateAnswer(true);
        pending = null;
      };

      /**
       * After sign-in succeeded, the sign-in page again means the session ended
       * (ADR 0062 §5): a navigation landed on a bound path, or the page shows the
       * bound sign-in form. The run stops; the credential is not typed again.
       * While the sign-in's answer may still come, the page is read for that
       * answer first.
       */
      const checkSession = async (at: string): Promise<void> => {
        if (signIn !== 'signed_in') return;
        await lateAnswer(false);
        if (signIn === 'signed_in' && (landedOnSignIn || (await readFormsSettled()).signInForm)) {
          stop({ status: 'needs_attention', reason: 'session_expired' }, at);
        }
      };

      /** Whether the page shows the bound sign-in form, read once a load in progress has finished. */
      const showsSignInForm = async (): Promise<boolean> => {
        await page.waitForLoadState('load', { timeout: SESSION_READ_MS }).catch(() => undefined);
        return (await readForms()).signInForm;
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

      /**
       * The one form that submits to a bound path among `paths`, and submits by
       * POST (ADR 0057 §7), or the run stops with `refusal` before anything is
       * typed. A form that submits by GET, as one with no method does, would
       * put what is typed into it in the URL: in the portal's logs, a Referer
       * and the page's own address, which a `for_each` loads again.
       */
      const boundForm = async (paths: readonly string[], at: string, refusal: Stop): Promise<Locator> => {
        const forms = page.locator('form');
        const matches: { form: Locator; method: string }[] = [];
        for (let i = 0; i < (await forms.count()); i++) {
          const read = await forms.nth(i).evaluate((f) => {
            const form = f as unknown as ElementLike;
            // A control named "action" or "method" shadows the property: not a form this can place.
            return typeof form.action === 'string' && typeof form.method === 'string' ? { action: form.action, method: form.method } : null;
          });
          if (read === null) continue;
          const u = new URL(read.action);
          if (u.origin === signInOrigin && paths.includes(u.pathname)) matches.push({ form: forms.nth(i), method: read.method });
        }
        if (matches.length !== 1 || matches[0]!.method.toLowerCase() !== 'post') stop(refusal, at);
        return matches[0]!.form;
      };

      /**
       * Submits a bound form, by POST only. A page's script may have changed
       * the method while the form was being filled, so it is read again once
       * it is filled, and again in the call that submits it.
       */
      const submitBound = async (form: Locator, at: string, refusal: Stop): Promise<void> => {
        const posts = await form.evaluate((f) => {
          const method = (f as unknown as ElementLike).method;
          return typeof method === 'string' && method.toLowerCase() === 'post';
        });
        if (!posts) stop(refusal, at);
        let posted = false;
        await settle(at, async () => {
          posted = await form.evaluate((f) => {
            const el = f as unknown as ElementLike & { requestSubmit(): void };
            if (typeof el.method !== 'string' || el.method.toLowerCase() !== 'post') return false;
            el.requestSubmit();
            return true;
          });
        });
        if (!posted) stop(refusal, at);
      };

      const runSteps = async (steps: readonly RecipeStep[], scope: Page | Locator): Promise<void> => {
        for (const step of steps) {
          const at = stepName(step);
          path.push(at);
          if (!log.has(at)) log.set(at, true);
          // Nothing acts on a page that may still bring the sign-in's answer.
          if (ACTS_ON_PAGE.has(step.kind)) await settleSignIn();
          if (now() - started > recipe.caps.maxRunMs) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
          await checkPage(at);
          // The portal wants a code, and the recipe has no step that gives one.
          if (signIn === 'mfa_pending' && !answersMfa) stop({ status: 'needs_attention', reason: 'mfa_unanswerable' }, at);
          await checkSession(at);
          // A navigation refused, or a page that could not be fetched, since the last step ended: nothing is done on what is left.
          if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
          if (navigationFailed) throw new PortalPageUnavailableError();
          active = { kind: step.kind, name: at, ...(step.kind === 'search' ? { recordedAction: step.recordedAction } : {}) };
          switch (step.kind) {
            case 'open':
              await settle(at, () => page.goto(step.url).catch(() => undefined));
              break;
            case 'sign_in': {
              const refusal: Stop = { status: 'failed', reason: 'sign_in_form_refused' };
              // One sign-in per run: the credential is typed once, and never again (ADR 0062 §5).
              if (signIn !== 'not_yet') stop(refusal, at);
              const form = await boundForm(recipe.signIn.formPaths, at, refusal);
              if ((await form.locator('input[type="password"]').count()) !== 1) stop(refusal, at);
              const user = form.locator('input[type="text"], input[type="email"], input:not([type])');
              if ((await user.count()) !== 1) stop(refusal, at);
              const before = new Set(await readErrors());
              signIn = 'submitted';
              await user.fill(creds.username());
              await form.locator('input[type="password"]').fill(creds.password());
              await submitBound(form, at, refusal);
              signIn = (await answerOf(at, 'sign_in', before)) === 'mfa' ? 'mfa_pending' : 'signed_in';
              // Only a navigation from here on can be the session ending.
              landedOnSignIn = false;
              break;
            }
            case 'answer_mfa': {
              // The sign-in was taken as answered once a page other than its own
              // had held. Past a page that forwards the browser more slowly, the
              // portal may still ask for a code, or refuse the sign-in: that
              // answer is waited for before a code is looked for.
              if (pending?.stage === 'sign_in') await settleSignIn();
              const refusal: Stop = { status: 'needs_attention', reason: 'mfa_unanswerable' };
              // A code is answered once per run, as the password is typed once
              // (ADR 0062 §5): a second is a second authentication with the
              // sealed secret, and repeated attempts lock the dedicated user out
              // (ADR 0057 §8). A recipe reaches one only through a `for_each`.
              if (mfaAnswered) stop({ status: 'failed', reason: 'sign_in_form_refused' }, at);
              // And only when this run's sign-in was answered with a request for
              // one: before signing in, after signing out, or signed in without
              // being asked, no code is computed and nothing is typed.
              if (signIn !== 'mfa_pending') stop(refusal, at);
              const totp = creds.totp;
              if (totp === undefined) stop(refusal, at);
              const form = await boundForm(recipe.signIn.mfaPaths, at, refusal);
              const input = form.locator('input[type="text"], input[type="number"], input[type="tel"], input[type="password"], input:not([type])');
              if ((await input.count()) !== 1) stop(refusal, at);
              const before = new Set(await readErrors());
              mfaAnswered = true;
              // Computed as it is typed, so that it is current when the portal checks it.
              await input.fill(await totp.call(creds));
              await submitBound(form, at, refusal);
              await answerOf(at, 'answer_mfa', before);
              signIn = 'signed_in';
              // Only a navigation from here on can be the session ending.
              landedOnSignIn = false;
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
              if (step.kind === 'next_page' && ++pagesFollowed > Math.min(step.maxPages, recipe.caps.maxPages)) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
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
                await form.locator(sel).fill(value);
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
              // The first expect after sign-in is the account's (ADR 0057 §13).
              if (expectAccountId !== undefined && !accountShown && signIn === 'signed_in') {
                const shown = step.selector === undefined
                  ? await page.locator('body').innerText()
                  : (await scope.locator(step.selector).allInnerTexts()).join('\n');
                if (!showsAccountId(shown, expectAccountId)) stop({ status: 'needs_attention', reason: 'account_mismatch' }, at);
                accountShown = true;
              }
              break;
            }
            case 'capture_page': {
              if (!accountShown) stop({ status: 'needs_attention', reason: 'account_mismatch' }, at);
              if (snapshots >= recipe.caps.maxPages) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
              snapshots++;
              if (dryRun) break; // a dry run captures nothing (ADR 0057 §3)
              const html = serialiseSnapshot(await page.content(), creds.username());
              captures.push({
                kind: 'page_snapshot', stepName: at, filename: `${at}.html`, bytes: new TextEncoder().encode(html), mimeType: 'text/html',
                pagePath: new URL(page.url()).pathname, capturedAt: new Date(now()).toISOString(), snapshotRuleVersion: SNAPSHOT_RULE_VERSION,
              });
              break;
            }
            case 'download': {
              if (!accountShown) stop({ status: 'needs_attention', reason: 'account_mismatch' }, at);
              const el = clickable(scope, step.label);
              await guardedClick(el, step.label, at);
              if (downloads >= recipe.caps.maxDownloads) stop({ status: 'failed', reason: 'cap_exceeded' }, at);
              downloads++;
              if (dryRun) break; // checked as a real run checks it, and never pressed (ADR 0057 §3)
              const pagePath = new URL(page.url()).pathname;
              const [download] = await Promise.all([page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }), el.click()]);
              if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
              // An `<a download>` file is fetched by the browser itself, and never
              // routed: its URL, the last its redirects reached, is put to the guard
              // here, and the egress proxy has already held it to the allowlist.
              const source = decideRequest(recipe, { method: 'GET', url: download.url(), body: null, activeStep: active });
              if (!source.allow) {
                refused.push({ method: 'GET', url: download.url(), reason: source.reason, atStep: at });
                stop({ status: 'failed', reason: 'guard_refused' }, at);
              }
              // A file sent from a bound sign-in path is the portal asking to sign in again, not the file the step pressed for.
              if (signIn === 'signed_in' && onSignInPath(download.url(), signInPaths)) stop({ status: 'needs_attention', reason: 'session_expired' }, at);
              const file = await download.path();
              const filename = withoutUsername(download.suggestedFilename(), creds.username());
              captures.push({
                kind: 'download', stepName: at, filename, bytes: new Uint8Array(await readFile(file)), mimeType: mimeFor(filename),
                pagePath, capturedAt: new Date(now()).toISOString(), snapshotRuleVersion: null,
              });
              break;
            }
            case 'for_each': {
              const rows = page.locator(step.rowSelector);
              const n = Math.min(await rows.count(), step.maxRows);
              const url = page.url();
              for (let i = 0; i < n; i++) {
                await runSteps(step.steps, rows.nth(i));
                if (page.url() !== url) {
                  await settle(at, () => page.goto(url));
                  await checkSession(at);
                }
              }
              break;
            }
            case 'sign_out': {
              // What the portal shows after this, its sign-in page included, is not a session that ran out.
              signIn = 'signed_out';
              const out = page.getByRole('link', { name: /^(sign|log) ?out$/i }).or(page.getByRole('button', { name: /^(sign|log) ?out$/i }));
              if ((await out.count()) === 1) await settle(at, () => out.click());
              break;
            }
          }
          if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, at);
          if (navigationFailed) throw new PortalPageUnavailableError();
          await checkSession(at);
          // The page is the one the recipe expects once signed in: what comes now is not the submission's answer.
          if (pending !== null && CHECKS_PAGE.has(step.kind)) pending = null;
          path.pop();
        }
      };

      /**
       * How a run that stopped, or threw, at `atStep` ends. A refused navigation
       * is a refusal, whatever it made the step do; a hard stop is what the
       * recipe tried, whatever the page showed. Then, while signed in, a stop
       * that could be the page not being what the step expected, or an
       * exception, is read against the sign-in first: its late answer, while
       * one may still come, and then the session. Only then is it the stop
       * itself, or the exception by its class.
       */
      const endOf = async (e: unknown, atStep: string | null): Promise<End> => {
        if (navigationRefused && atStep !== null) return { status: 'failed', reason: 'guard_refused', atStep };
        const stopped = e instanceof StopRun ? e : null;
        if (stopped !== null && stopped.stop.status === 'failed') return { ...stopped.stop, atStep: stopped.atStep };
        if (atStep !== null && signIn === 'signed_in' && (stopped === null || YIELDS_TO_SESSION.has(stopped.stop.reason))) {
          try {
            await lateAnswer(true);
          } catch (late) {
            if (late instanceof StopRun) return { ...late.stop, atStep: late.atStep } as End;
            // The page could not be read: what the step met stands.
          }
          if (signIn === 'signed_in' && (landedOnSignIn || (await within(2 * SESSION_READ_MS, showsSignInForm(), false)))) {
            return { status: 'needs_attention', reason: 'session_expired', atStep };
          }
        }
        if (stopped !== null) return { ...stopped.stop, atStep: stopped.atStep } as End;
        if (navigationFailed) return { status: 'failed', reason: 'error', errorClass: 'PortalPageUnavailableError', atStep };
        return { status: 'failed', reason: 'error', errorClass: errorClassOf(e), atStep };
      };

      // Taken as the run ends: a refusal the proxy meets while the browser closes is still refused, and does not change an outcome already made.
      const record = (): RunRecord => ({ captures, refused: [...refused], steps: [...log].map(([step, passed]) => ({ step, passed })), pages: loads });
      /** The step a run stopped at fails, and so does each step running around it. */
      const failAt = (at: string | null): void => {
        for (const name of at === null ? path : [...path, at]) {
          if (log.has(name)) log.set(name, false);
        }
      };

      /** The last step, once every step has passed: where what is read after them is put. */
      let finished: string | null = null;
      try {
        await runSteps(recipe.steps, page);
        const last = stepName(recipe.steps.at(-1)!);
        finished = last;
        // No run completes while the sign-in's answer may still be a refusal.
        if (pending !== null) {
          await settleSignIn();
          await checkSession(last);
        }
        if (navigationRefused) stop({ status: 'failed', reason: 'guard_refused' }, last);
        // Signed in, and the portal still waits for a code the recipe never gave.
        if (signIn === 'mfa_pending') stop({ status: 'needs_attention', reason: 'mfa_unanswerable' }, last);
        return { status: 'completed', ...record() };
      } catch (e) {
        const atStep = e instanceof StopRun ? e.atStep : path.at(-1) ?? finished;
        failAt(atStep);
        const end = await endOf(e, atStep);
        // A late answer is the submitting step's: it fails too.
        failAt(end.atStep);
        return { ...end, ...record() } as RunOutcome;
      }
    } finally {
      await browser.close();
    }
  } finally {
    await egress.close();
  }
}

/** The browser-side form, typed without the DOM lib. */
type FormLike = { action: string; method: string; requestSubmit(): void };

/** A browser-side element, typed without the DOM lib: only what the page readers use. */
type ElementLike = {
  readonly tagName: string;
  readonly innerText: string;
  readonly action?: unknown;
  readonly method?: unknown;
  getAttribute(name: string): string | null;
  checkVisibility(options: typeof SEEN): boolean;
  querySelector(selectors: string): unknown;
};

/** A request that loads a page's top frame. A navigation whose frame does not exist yet is a new page's. */
function isTopLevelNavigation(request: Request): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return true;
  }
}

/** `p`'s value, or `fallback` when it fails or takes longer than `ms`: for reading a page that may be navigating, or gone. `p` is never left to reject unhandled. */
async function within<T, F>(ms: number, p: Promise<T>, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([p.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error's class name for the run row, never its message. */
function errorClassOf(e: unknown): string {
  const name = e instanceof Error ? e.name : undefined;
  return name !== undefined && ERROR_CLASS.test(name) && name.length <= PORTAL_LIMITS.errorClassMax ? name : 'Error';
}

function everyStep(steps: readonly RecipeStep[]): RecipeStep[] {
  return steps.flatMap((s) => (s.kind === 'for_each' ? [s, ...everyStep(s.steps)] : [s]));
}

function collectDismiss(steps: readonly RecipeStep[]): Extract<RecipeStep, { kind: 'dismiss' }>[] {
  return everyStep(steps).flatMap((s) => (s.kind === 'dismiss' ? [s] : []));
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
