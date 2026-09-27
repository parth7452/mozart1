# 07 — Portal-read engine and a test portal (ADR 0057, proposed; no real portal)

## Goal
Build the testable core of `docs/adr/0057-a-portal-is-read-never-written.md` against a local fixture portal only: the recipe as data, a read-only Playwright runner whose write guard is method + target, a fixture portal that tries to make it write, and captures handed to the existing ingest as `portal_fetch` documents held for a person.

## Why
STRATEGY §5.4 moved portal **read** early; the ~70% of deductions a supplier never surfaces sit in portals. The guards are the product here: every one must be proven to refuse before any real portal or credential exists.

## What exists today (grounded)
- `playwright@1.63.0` is a root devDependency (`package.json:51`); a browser binary is at `/opt/pw-browsers/chromium`. No package depends on it yet.
- `IngestSource = Extract<UploadSource, 'web_upload' | 'email_in' | 'email_body'>` (`packages/pipeline/src/ports.ts:58`). `UploadSource` already includes `portal_fetch` (database check, migration 0003/0019).
- `ingestDocument(input, deps)` (`packages/pipeline/src/steps.ts:196`) picks `acceptEmailBody` by `input.source === 'email_body'`, else `acceptUpload`; dedupes by hash (no second `uploads` row).
- Email hold: `steps.ts:926` `const byEmail = arrival === 'email_in' || arrival === 'email_body';` from `deps.store.uploadSourceFor(...)`; reason `'by_email'` at `steps.ts:992`. `HOLD_REASONS` at `packages/pipeline/src/hold.ts:65`.
- In-memory store: `InMemoryStore` (`packages/pipeline/src/testing/memory-store.ts:192`), under `@recouple/pipeline/testing` only.
- ADR 0057 §1 (guard), §3 (step kinds, recipe contents), §9 (captures, snapshot serialisation allowlist, HTML only for `portal_fetch`), §13 (`needs_attention` reasons: `mfa_unanswerable`, `challenge`, `page_changed`, `terms_prompt`, `account_mismatch`).

## Decisions (fixed)
- New package `packages/portal` (`@recouple/portal`), pure TS + Playwright. Playwright is imported only from `packages/portal/src/runner/*`; the recipe schema and guard are Playwright-free.
- ADR 0057 stays **proposed**. No migration, no credential table, no KMS. Credentials in tests are a plain in-test `{ username, password, totp? }` passed to the runner's constructor as a `CredentialSource` port; the recipe never holds one.
- The guard is a pure function `decideRequest(...)`; the runner routes **every** request (`context.route('**/*')`) through it and aborts on `refuse`. Tests call the pure function directly and also end-to-end.
- A page snapshot is stored as `text/html` only when `source === 'portal_fetch'`.
- A `portal_fetch` notice or remittance is held with a new hold reason `by_portal`.

### 07.1 Recipe schema + request guard (no browser)
Files:
- `packages/portal/package.json` (`"name": "@recouple/portal"`, deps `zod` at the workspace's version, `@recouple/core-domain` if needed; devDep none — playwright is root), `tsconfig.json` copied from `packages/adapters`, `vitest.config.ts` likewise; add to root tsconfig references if the workspace uses them (`grep -n references tsconfig*.json`).
- `packages/portal/src/recipe.ts`:
```ts
export const NEVER_CLICK_FLOOR = ['dispute','appeal','submit','upload','attach','approve','accept','agree','delete','remove','save','create','request','send','pay','confirm','continue','yes','ok','finish','complete','withdraw','cancel','enroll','opt in','subscribe','register','update','edit','reset','resend','authorize'] as const; // ADR 0057 §1, verbatim
export const STEP_KINDS = ['open','sign_in','answer_mfa','dismiss','follow','search','wait_for','expect','capture_page','download','for_each','next_page','sign_out'] as const; // §3, closed
export const RecipeStepSchema: z.ZodType<RecipeStep>; // discriminated union on `kind`; sign_in/answer_mfa/sign_out are `{kind}` .strict() — any extra key refused
export const PostAsReadSchema = z.object({ step: z.string(), path: z.string().startsWith('/'), bodyDiscriminator: z.object({ field: z.string(), equals: z.string() }).optional() }).strict();
export const RecipeVersionSchema = z.object({
  portalKey: z.string(), version: z.number().int().positive(), effectiveFrom: z.string().date(),
  hostAllowlist: z.array(z.string()).min(1),            // exact host[:port], no wildcards
  signIn: z.object({ origin: z.string().url(), formPaths: z.array(z.string()).min(1), mfaPaths: z.array(z.string()), acsPaths: z.array(z.string()) }).strict(),
  neverClick: z.array(z.string()),                      // additions only
  postAsRead: z.array(PostAsReadSchema),
  caps: z.object({ maxPages: z.number().int().positive(), maxDownloads: z.number().int().positive(), maxRunMs: z.number().int().positive() }).strict(),
  provenance: z.object({ draftedBy: z.object({ kind: z.enum(['person','agent_session']), id: z.string() }), source: z.string(), portalAdr: z.string() }).strict(),
  steps: z.array(RecipeStepSchema).min(1),
}).strict().superRefine(/* signIn.origin host ∈ hostAllowlist; every step name unique; search steps carry recordedMethod+recordedAction */);
export function parseRecipe(json: unknown): RecipeVersion; // throws RecipeRefusedError(issues)
export function effectiveNeverClick(r: RecipeVersion): readonly string[]; // floor ∪ additions, lower-cased
export function matchesNeverClick(label: string, list: readonly string[]): boolean; // word-boundary, case-insensitive: "Submit dispute" → true, "Deductions" → false
```
- `packages/portal/src/guard.ts`:
```ts
export type RequestContext = { method: string; url: string; body: string | null; activeStep: { kind: StepKind; name: string; recordedAction?: string } | null };
export type GuardDecision = { allow: true } | { allow: false; reason: 'host_not_allowed' | 'non_get_not_allowed' | 'body_discriminator_mismatch' | 'scheme_not_allowed' };
export function decideRequest(recipe: RecipeVersion, req: RequestContext): GuardDecision;
```
Rules exactly per §1: scheme must be http(s) (tests use http://127.0.0.1); host (with port) ∉ allowlist → refuse, any method. GET/HEAD allowed on-allowlist. Non-GET allowed only (a) during `sign_in`/`answer_mfa` to `signIn.origin` + a path in formPaths/mfaPaths/acsPaths; (b) during `search` to its recorded action URL exactly; (c) matching a `postAsRead` entry by step name + path, and if `bodyDiscriminator` set, the JSON (or urlencoded) body's field equals the value. Everything else refused. Path compare is exact on `URL.pathname`, no prefix match.
- `packages/portal/src/index.ts` re-exports recipe + guard (not the runner).

Tests `packages/portal/test/recipe.test.ts`, `guard.test.ts` (no DB): unknown step kind refused; `sign_in` with an argument refused; recipe without allowlist refused; floor cannot be removed (neverClick only adds); POST to login path outside sign_in refused; POST to `/graphql` with `operationName: 'ListDeductions'` allowed, `'SubmitDispute'` refused; POST to off-allowlist host refused even during sign_in; prefix trick `/login/../change-password` and `/loginx` refused; PUT/DELETE/PATCH always refused.

Verify: `pnpm --filter @recouple/portal test && pnpm typecheck`.

### 07.2 Fixture portal + read-only runner (Playwright)
Files:
- `packages/portal/test/fixture-portal/` static HTML: `login.html` (form `POST /login`, one password input), `mfa.html` (`POST /mfa`), `deductions.html` (table of 3 deductions, link to export, "Submit dispute" button posting `/dispute`, a link "Change password" to `change-password.html`, an `<input type=file>`), `export.csv` or `export.pdf` (use a tiny valid PDF from `packages/fixtures` — the door refuses CSV until ADR 0056 lands; grep `packages/fixtures` for an existing small PDF), `reauth.html` (decoy "Re-enter password" form posting `/reauth`), `change-password.html` (`POST /change-password`), `terms.html` (`role=dialog aria-modal` with "Accept"), `challenge.html` (element `#captcha` / text "verify you are human").
- `packages/portal/test/fixture-portal/server.ts`: `startFixturePortal(): Promise<{ origin: string; hits: Array<{method: string; path: string}>; close(): Promise<void> }>` — node `http` on `127.0.0.1:0`; records every request; `/login` sets a cookie and 303s to `/mfa` or `/deductions`. A second server (`startFixturePortal()` again) acts as the off-allowlist host.
- `packages/portal/src/runner/runner.ts`:
```ts
export interface CredentialSource { username(): string; password(): string; totp?(): string } // test-only values; no KMS here
export type Capture = { kind: 'page_snapshot' | 'download'; stepName: string; filename: string; bytes: Uint8Array; mimeType: string };
export type RunOutcome = { status: 'completed'; captures: Capture[] } | { status: 'needs_attention'; reason: 'challenge' | 'page_changed' | 'terms_prompt' | 'mfa_unanswerable'; captures: Capture[]; atStep: string } | { status: 'failed'; reason: 'guard_refused' | 'never_click' | 'file_input' | 'cap_exceeded' | 'sign_in_form_refused'; captures: Capture[]; atStep: string };
export async function runRecipe(recipe: RecipeVersion, creds: CredentialSource, opts: { executablePath: string; params?: Record<string,string>; now?: () => number }): Promise<RunOutcome>;
```
Launch `chromium.launch({ executablePath: opts.executablePath, headless: true })`; `context.route('**/*', …)` calls `decideRequest` with the active step and aborts refused requests, recording them; any refused **navigation or form submission** ends the run `failed/guard_refused`. `sign_in` locates the form whose `action` path ∈ `signIn.formPaths` on `signIn.origin`, refuses if it has ≠1 password input, fills and submits; takes no argument. `follow`/`download`/`dismiss` check `matchesNeverClick` on accessible name and visible text before clicking. Before each step: challenge check (selector list + text "verify you are human"/captcha iframe) → `needs_attention/challenge`; dialog/aria-modal with a floor-listed control not matching a recorded `dismiss` container → `needs_attention/terms_prompt`. Never call `setInputFiles`. `capture_page` → `serialiseSnapshot(page, creds.username())`.
- `packages/portal/src/runner/snapshot.ts`: `export const SNAPSHOT_RULE_VERSION = 1; export function serialiseSnapshot(html: string, username: string): string` — pure (runs on `page.content()`), keeps text and `table thead tbody tr th td ul ol li h1-h6 p`, only `colspan`/`rowspan`; drops everything else (§9); replaces every occurrence of the username with `[portal-user]`. Parse with a tiny tokenizer in-house, or `parse5` only if it already is in `node_modules` (`ls node_modules/.pnpm | grep parse5`); do not add a new HTML library without noting it.
- `packages/portal/package.json` export `"./runner": "./src/runner/runner.ts"`; index does not re-export it.

Tests `packages/portal/test/runner.test.ts` (no DB; `describe.skipIf(!existsSync('/opt/pw-browsers/chromium'))`, timeout 60s): happy path — sign in, follow to deductions, capture page, download export → `completed`, 2 captures, server `hits` contain no non-GET except `POST /login` (+`/mfa`). Refusals, each asserting the server never saw the forbidden request: a `follow` to "Submit dispute" → `never_click`; a recipe step that submits `/reauth` or `/change-password` via `search` whose recordedAction differs → `guard_refused`; a page script doing `fetch('/dispute',{method:'POST'})` → aborted, recorded; `open` of the second server's origin → `guard_refused`; challenge page → `needs_attention/challenge`; terms dialog → `terms_prompt`; `expect` miss → `page_changed`; `maxDownloads: 0` → `cap_exceeded`. Snapshot test (`snapshot.test.ts`, pure): no `<script>`, `<a href>`, `<form>`, `<input>`, `on*=` or `javascript:` survives; username replaced.

Verify: `pnpm --filter @recouple/portal test && pnpm typecheck`. No network: every URL is `127.0.0.1`.

### 07.3 Captures into ingest as `portal_fetch`, held `by_portal`
Files:
- `packages/pipeline/src/ports.ts:58`: widen `IngestSource` to add `'portal_fetch'`; fix the comment above it.
- `packages/ingest`: add `acceptPortalSnapshot(bytes: Uint8Array)` (next to `acceptEmailBody`; grep its file) — UTF-8 text/html, size cap reused from the email-body limit, rejects if it contains `<script` or `<form` (the serialiser must have removed them). HTML stays refused by `acceptUpload`.
- `packages/pipeline/src/steps.ts:196-205`: choose by source — `email_body` → `acceptEmailBody`; `portal_fetch` with `mimeType text/html` → `acceptPortalSnapshot`; else `acceptUpload` (a portal download goes through the ordinary door by magic bytes).
- `packages/pipeline/src/hold.ts:65`: add `'by_portal'` to `HOLD_REASONS`; `steps.ts:926`: `const byPortal = arrival === 'portal_fetch';` and hold like `byEmail` with reason `'by_portal'` (grep every `byEmail` use in `readDocument` and mirror it). Check `hold` parsing in `store-postgres` (`grep -rn HOLD_REASONS packages apps`) accepts the new value — it's in `audit_log` JSON, no migration.
- `packages/portal/src/ingest.ts`: `export async function ingestCaptures(captures: Capture[], orgId: string, deps: Pick<PipelineDeps,'store'|'scanner'>): Promise<IngestResult[]>` — calls `ingestDocument({ source: 'portal_fetch', createdBy: null, … })` per capture (grep `IngestInput` for exact field names).

Tests: `packages/pipeline/test/portal-fetch.test.ts` with `InMemoryStore` and the test scanner from `@recouple/pipeline/testing` (no DB): snapshot stored with an `uploads` row `portal_fetch`, `created_by` null; same HTML via `web_upload` refused; re-captured bytes keep the first arrival; a notice read from a portal capture (recorded fixture classifier/extractor from existing tests, grep `by_email` tests to copy) is held `by_portal` and opens no case; `packages/ingest/test` case for `acceptPortalSnapshot`. If the web case list renders hold reasons (`grep -rn "by_email" apps/web`), add the `by_portal` wording and run `env -u DATABASE_URL pnpm build:web`.

Verify: `pnpm typecheck`; `env -u DATABASE_URL TEST_DATABASE_URL=postgres://tester:tester@127.0.0.1:5432/recouple_test RECOUPLE_TEST_DATABASE=1 pnpm db:test` then the same prefix with `pnpm test` (the widened type touches store-postgres readers).

## Verification
`pnpm typecheck`; `pnpm db:test` then `pnpm test` with the test-DB prefix above; `env -u DATABASE_URL pnpm build:web` if apps/web changed. Never `pnpm record:cassettes`.

## Acceptance
- [ ] Recipe is a zod-validated, versioned, effective-dated value with provenance; unknown step kinds and arguments to `sign_in`/`answer_mfa` refused.
- [ ] Every request goes through `decideRequest`; each refusal case in 07.1/07.2 has a test that asserts the fixture server never received it.
- [ ] Never-click floor verbatim from §1; recipes only add.
- [ ] No `setInputFiles`, no tool/model in the runner.
- [ ] Challenge, terms, page change stop the run as `needs_attention`.
- [ ] Captures ingest as `portal_fetch`, HTML only for that source, held `by_portal`.
- [ ] No migration, no credential storage, no network beyond 127.0.0.1.

## Pitfalls
- `route('**/*')` does not see requests from service workers; set `serviceWorkers: 'block'` on the context.
- Compare hosts with ports (`127.0.0.1:54321`); two fixture servers differ only by port.
- Prefix-matching paths lets `/login-evil` through; compare `pathname` exactly after `new URL` normalisation.
- A POST can be triggered by page script, not a click; the guard, not the floor, must stop it.
- Do not re-export the runner from the package index (Playwright must not reach app bundles).
- `ADR 0057` is proposed: the `require-adr.sh` hook blocks only migrations/invariants, which this plan does not touch.

## Out of scope
Credential tables/migration, KMS sealing, `portal_captures` table, worker deployment, scheduling, recipe-drafting agent, promotion/review rows, any real portal or UNFI recipe, anything that submits, web UI for recipes.

## Open questions (defaults used)
1. Package location — default `packages/portal`.
2. Hold reason name — default `by_portal` (ADR §10 names it).
3. Portal CSV exports refused until ADR 0056 lands — default: fixture export is a PDF; a CSV capture records a refused capture (`failed` with no bytes stored) in a test.
4. HTML parser — default: no new dependency; in-house allowlist tokenizer.

## Depends on
Nothing merged beyond main. Sub-tasks run in order 07.1 → 07.2 → 07.3.
