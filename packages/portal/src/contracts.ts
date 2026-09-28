// The shared contracts of portal read (ADR 0057 §6, §7, §13, §15; ADR 0062):
// what the app seals, what the job sends the worker and gets back, the store
// port the job and Settings → Portals use, and the names migration 0038 gives
// its tables, columns and functions. Every unit of the build codes against
// this file, so each shape is decided once, here. The database stays the
// referee: a name below is what the migration must create, and a check below
// is one the migration repeats.
//
// Types, constants and zod schemas only. Beside zod, the one runtime import is
// the recipe schema a run request embeds, so nothing here reads the
// environment, opens a socket or holds a credential, and Playwright never
// reaches this file.
//
// No credential, TOTP secret or code, cookie, session token or page text goes
// into a log line, an event, a step's return value, an error message, a run
// row or an audit payload (ADR 0057 §7). The shapes below that reach those
// places carry ids, codes, counts, step names and hashes, and nothing else. A
// schema's refusal names the field and the rule, never the value.
import { z } from 'zod';
import type { RejectionCode } from '@recouple/ingest';
import type { StoredDocument } from '@recouple/pipeline';
import type { Capture } from './capture';
import { RecipeVersionSchema, type RecipeVersion } from './recipe';

// ---------------------------------------------------------------------------
// Limits and patterns, shared by these schemas, the store and 0038's checks
// ---------------------------------------------------------------------------

export const PORTAL_LIMITS = {
  /** A connection's label, or a credential's. */
  labelMax: 120,
  /** A portal account's public identifier (an ANID, a supplier number). */
  accountIdMax: 128,
  /** A connection's run parameters: how many, and each key's and value's length. */
  paramsMaxEntries: 32,
  paramKeyMax: 64,
  paramValueMax: 256,
  /** A recipe step's name, as a step log, a stop and a capture row carry it. */
  stepNameMax: 200,
  /** A URL path: one of a binding's sign-in paths, or a capture's page path. */
  pathMax: 2048,
  /** Sign-in paths in one binding. */
  signInPathsMax: 64,
  filenameMax: 255,
  contentTypeMax: 255,
  /** An error's class name. */
  errorClassMax: 100,
  /** A sealed credential's `cipher` and `keyId` (names, not secrets). */
  cipherNameMax: 200,
  keyIdMax: 2048,
  /** A sealed credential's `wrappedKey` and `ciphertext`, base64: `accounting_credentials`' bound. */
  sealedFieldMax: 20_000,
  /**
   * The sealed username. At least 3 characters, because the worker replaces
   * every occurrence of it in a snapshot with a placeholder (ADR 0057 §9), and
   * a one- or two-character username would replace half the page.
   */
  usernameMin: 3,
  usernameMax: 320,
  passwordMax: 1024,
  /** A TOTP secret in canonical base32: 16 characters is 80 bits. */
  totpSecretMin: 16,
  totpSecretMax: 128,
} as const;

/** A portal key is data naming a portal (`sap_business_network`), never a code path. */
export const PORTAL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * A run parameter's name. Starts with a letter, so `__proto__` and its kin are
 * never a key; a recipe's `search.fields` must name its parameters the same way.
 */
export const PORTAL_PARAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A uuid as Postgres and `crypto.randomUUID()` print it: lower-case hex, so one run has one spelling. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** SHA-256 as `sha256()` in @recouple/ingest prints it, and as `documents.sha256` holds it. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** An error's class name: an identifier, never a message. */
const ERROR_CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** RFC 4648 base32 as sealed: upper case, no padding, no spaces. Settings folds what an authenticator shows into this before sealing. */
const TOTP_SECRET_PATTERN = /^[A-Z2-7]+$/;
/** Unpadded base32 lengths modulo 8 that some byte string encodes to; 1, 3 and 6 are a mistyped key. */
const BASE32_WHOLE_REMAINDERS = new Set([0, 2, 4, 5, 7]);
const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;

const uuid = z.string().regex(UUID_PATTERN, 'a lower-case uuid');
const sha256Hex = z.string().regex(SHA256_HEX_PATTERN, 'a lower-case hex SHA-256');
const count = z.number().int().nonnegative();
const className = z.string().min(1).max(PORTAL_LIMITS.errorClassMax).regex(ERROR_CLASS_PATTERN, 'a class name');
const stepNameText = z.string().min(1).max(PORTAL_LIMITS.stepNameMax).regex(NO_CONTROL_CHARACTERS, 'no control characters');

/** Text a person typed: present, no control characters, no leading or trailing space. */
function trimmedText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .regex(NO_CONTROL_CHARACTERS, 'no control characters')
    .refine((s) => s.trim() === s, 'no leading or trailing whitespace');
}

function nonBlank(max: number) {
  return z.string().min(1).max(max).refine((s) => s.trim() !== '', 'not blank');
}

function isCanonicalOrigin(s: string): boolean {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === s;
}

/** Sorted in `Array.prototype.sort()` order (UTF-16 code units), with no duplicates. */
function isStrictlySorted(xs: readonly string[]): boolean {
  return xs.every((x, i) => i === 0 || xs[i - 1]! < x);
}

// ---------------------------------------------------------------------------
// The sealed credential (ADR 0057 §7)
// ---------------------------------------------------------------------------

/** The purpose `TokenEncryptionContext`'s portal variant carries (@recouple/crypto). */
export const PORTAL_CREDENTIAL_PURPOSE = 'portal_credential';

/**
 * The plaintext, sealed as one payload (`JSON.stringify`) and opened only by
 * the worker. It exists in the clear in Settings' request while it is sealed,
 * in the worker's memory for one run, and in the portal's bound sign-in and
 * MFA forms, and nowhere else: never a log line, an event, a step's return, an
 * error message, a run row, an audit payload or a capture (ADR 0057 §7).
 */
export interface PortalCredentialPayload {
  /** The dedicated portal user (ADR 0057 §8), never a person's own login. */
  readonly username: string;
  readonly password: string;
  /**
   * The authenticator's setup key, when the portal asks for TOTP (ADR 0057 §8,
   * option 1): canonical base32 (A–Z, 2–7, no padding or spaces). The worker
   * computes the code, and only the code crosses the network. Absent, an
   * `answer_mfa` step ends the run `mfa_unanswerable`.
   */
  readonly totpSecret?: string | undefined;
}

export const PortalCredentialPayloadSchema: z.ZodType<PortalCredentialPayload> = z
  .object({
    username: trimmedText(PORTAL_LIMITS.usernameMax).refine(
      (s) => s.length >= PORTAL_LIMITS.usernameMin,
      `at least ${PORTAL_LIMITS.usernameMin} characters`,
    ),
    password: z.string().min(1).max(PORTAL_LIMITS.passwordMax),
    totpSecret: z
      .string()
      .min(PORTAL_LIMITS.totpSecretMin)
      .max(PORTAL_LIMITS.totpSecretMax)
      .regex(TOTP_SECRET_PATTERN, 'canonical base32: A–Z and 2–7, no padding or spaces')
      .refine((s) => BASE32_WHOLE_REMAINDERS.has(s.length % 8), 'a whole base32 encoding')
      .optional(),
  })
  .strict();

/**
 * Where a credential may be typed (ADR 0057 §7). Taken from a recipe version
 * as the database holds it, never from a request's fields, when the credential
 * is sealed. It is stored beside the ciphertext and authenticated inside the
 * encryption context, so a binding altered in the row does not decrypt. It
 * describes the portal, not the credential.
 *
 * Canonical, so one recipe gives one binding wherever it is computed:
 *  - `signInOrigin` is `new URL(recipe.signIn.origin).origin`: scheme, host
 *    and port, the host lower-cased and a default port elided, with no path
 *    and no trailing slash;
 *  - `signInPaths` is `recipe.signIn.formPaths`, `mfaPaths` and `acsPaths`
 *    together (every path the guard lets `sign_in` or `answer_mfa` POST to),
 *    without duplicates, in `Array.prototype.sort()` order;
 *  - `hostsHash` is SHA-256 of the sorted `hostAllowlist`, lower-case hex, as
 *    recipe.ts's one function computes it. It is never re-derived elsewhere.
 *
 * The worker computes the binding from the recipe it is given and refuses a
 * run whose binding differs, before `kms:Decrypt` (ADR 0057 §6). A recipe
 * version that changes any of the three cannot open a credential sealed before
 * it, until an owner enters the credential again.
 */
export interface PortalBinding {
  readonly signInOrigin: string;
  readonly signInPaths: readonly string[];
  readonly hostsHash: string;
}

export const PortalBindingSchema: z.ZodType<PortalBinding> = z
  .object({
    signInOrigin: z.string().max(PORTAL_LIMITS.pathMax).refine(isCanonicalOrigin, 'an http(s) origin as URL.origin prints it'),
    signInPaths: z
      .array(z.string().min(1).max(PORTAL_LIMITS.pathMax).startsWith('/'))
      .min(1)
      .max(PORTAL_LIMITS.signInPathsMax)
      .refine(isStrictlySorted, 'sorted, with no duplicates'),
    hostsHash: sha256Hex,
  })
  .strict();

/**
 * The encryption context a portal credential is sealed and opened under: the
 * portal variant of `TokenEncryptionContext` in @recouple/crypto, field for
 * field, which carries its own AAD tag there. The purpose and the destination
 * are both authenticated, so a portal ciphertext never opens as a QuickBooks
 * one, nor for another tenant, connection or binding.
 */
export interface PortalCredentialContext extends PortalBinding {
  readonly purpose: typeof PORTAL_CREDENTIAL_PURPOSE;
  readonly orgId: string;
  readonly connectionId: string;
}

/**
 * A sealed credential exactly as `portal_credentials` stores it:
 * @recouple/crypto's `SealedToken`, field for field, declared here so this
 * package takes no dependency for four strings. Every field is safe in a
 * column and in an authenticated request body (ADR 0057 §6). None of them
 * opens without `kms:Decrypt`, which only the worker's identity may call.
 */
export interface SealedPortalCredential {
  /** Which cipher sealed it. A name. */
  readonly cipher: string;
  /** The portal KMS key that can unwrap `wrappedKey`. A name for key material, never key material. */
  readonly keyId: string;
  /** The data key, encrypted, base64. */
  readonly wrappedKey: string;
  /** The payload under the data key, base64. */
  readonly ciphertext: string;
}

/** Strict, so no fifth field (a plaintext, say) can ride along with the four. */
export const SealedPortalCredentialSchema: z.ZodType<SealedPortalCredential> = z
  .object({
    cipher: nonBlank(PORTAL_LIMITS.cipherNameMax),
    keyId: nonBlank(PORTAL_LIMITS.keyIdMax),
    wrappedKey: z.string().min(1).max(PORTAL_LIMITS.sealedFieldMax),
    ciphertext: z.string().min(1).max(PORTAL_LIMITS.sealedFieldMax),
  })
  .strict();

/**
 * A connection's run parameters (ADR 0057 §3): what differs per customer and
 * is typed into a recipe's `search` forms. Frozen with the connection. Never a
 * credential: a parameter is shown, stored in the clear and sent in a request.
 */
export type PortalRunParams = Readonly<Record<string, string>>;

/**
 * zod's record drops an own `__proto__` key without a word, so the raw object
 * is asked first: a parameter the schema would lose is refused, not lost.
 */
export const PortalRunParamsSchema: z.ZodType<PortalRunParams> = z
  .unknown()
  .refine((v) => !(typeof v === 'object' && v !== null && Object.hasOwn(v, '__proto__')), 'no __proto__ key')
  .pipe(
    z
      .record(
        z.string().regex(PORTAL_PARAM_KEY_PATTERN, 'a parameter name'),
        z.string().min(1).max(PORTAL_LIMITS.paramValueMax).regex(NO_CONTROL_CHARACTERS, 'no control characters'),
      )
      .refine((p) => Object.keys(p).length <= PORTAL_LIMITS.paramsMaxEntries, `at most ${PORTAL_LIMITS.paramsMaxEntries} parameters`),
  );

// ---------------------------------------------------------------------------
// How a run ends (ADR 0057 §13, ADR 0062 §5)
// ---------------------------------------------------------------------------

export const PORTAL_RUN_OUTCOMES = ['completed', 'not_configured', 'refused', 'needs_attention', 'failed'] as const;
export type PortalRunOutcome = (typeof PORTAL_RUN_OUTCOMES)[number];

/** What the worker, and the runner in it, can stop a run for, needing a person. */
export const PORTAL_WORKER_NEEDS_ATTENTION_REASONS = [
  // The runner's stops (runner.ts).
  'mfa_unanswerable',
  'challenge',
  'page_changed',
  'terms_prompt',
  // After the sign-in form is submitted, the browser is still on a bound
  // sign-in path and the portal shows an error (ADR 0062 §5). The job then
  // disables the connection until an owner enters the credential again
  // (ADR 0057 §8). Never retried, so a wrong password cannot lock the user out.
  'credential_rejected',
  // After sign-in succeeded, a navigation lands on a bound sign-in path again
  // (ADR 0062 §5). The runner never signs in a second time in one run.
  'session_expired',
  // The recipe's account `expect` after sign-in did not show the connection's
  // account id (ADR 0057 §13). Ends the run before anything is captured.
  'account_mismatch',
  // The recipe's binding differs from the credential's (ADR 0057 §6-7).
  // Refused before `kms:Decrypt`, so nothing was typed anywhere; an owner
  // enters the credential again under the recipe's binding. The job may find
  // it first and not call the worker at all.
  'binding_mismatch',
] as const;
export type PortalWorkerNeedsAttentionReason = (typeof PORTAL_WORKER_NEEDS_ATTENTION_REASONS)[number];

/** Every `needs_attention` reason: the worker's, and one only the job finds. */
export const PORTAL_NEEDS_ATTENTION_REASONS = [
  ...PORTAL_WORKER_NEEDS_ATTENTION_REASONS,
  // The door refused a captured file (ADR 0057 §9). Its capture row names the
  // refusal and stores no bytes, and a person fetches the file by hand.
  'capture_refused',
] as const;
export type PortalNeedsAttentionReason = (typeof PORTAL_NEEDS_ATTENTION_REASONS)[number];

/** The runner's hard stops (runner.ts): the recipe tried what the runner refuses. */
export const PORTAL_RUNNER_FAILED_REASONS = ['guard_refused', 'never_click', 'file_input', 'cap_exceeded', 'sign_in_form_refused'] as const;
export type PortalRunnerFailedReason = (typeof PORTAL_RUNNER_FAILED_REASONS)[number];

/** Every `failed` reason: the runner's, or `error`, an exception named by its class alone. */
export const PORTAL_FAILED_REASONS = [...PORTAL_RUNNER_FAILED_REASONS, 'error'] as const;
export type PortalFailedReason = (typeof PORTAL_FAILED_REASONS)[number];

/** Every reason code `portal_read_runs.reason` admits. */
export const PORTAL_RUN_REASONS = [...PORTAL_NEEDS_ATTENTION_REASONS, ...PORTAL_FAILED_REASONS] as const;
export type PortalRunReason = (typeof PORTAL_RUN_REASONS)[number];

/** Which reasons each outcome takes. The other three outcomes take none. */
export const PORTAL_REASONS_BY_OUTCOME = {
  needs_attention: PORTAL_NEEDS_ATTENTION_REASONS,
  failed: PORTAL_FAILED_REASONS,
} as const;

/**
 * A run's end, as its `portal_read_runs` row records it.
 *
 * `errorClass` is a class name and never a message (invariant 4), because an
 * error off this path can quote a page. As in `ledger_sync_runs`, it says which
 * refusal a `refused` run met (the connection was off, the member may no
 * longer write, the portal's terms are not recorded as allowing it) and what a
 * `not_configured` run lacked (the worker, a recipe version, a credential).
 * `needs_attention` never carries one: its reason says it all.
 */
export type PortalRunEnd =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'not_configured' | 'refused'; readonly errorClass: string }
  | { readonly outcome: 'needs_attention'; readonly reason: PortalNeedsAttentionReason }
  | { readonly outcome: 'failed'; readonly reason: PortalRunnerFailedReason }
  | { readonly outcome: 'failed'; readonly reason: 'error'; readonly errorClass: string };

// ---------------------------------------------------------------------------
// The worker's HTTP contract: services/portal-read (ADR 0057 §6)
// ---------------------------------------------------------------------------

/**
 * The worker's routes. Every one but `health` needs `Authorization: Bearer
 * <PORTAL_READ_TOKEN>`, compared in constant time. Bodies are JSON, and an
 * error answers `{ error: code }` (`PORTAL_WORKER_ERRORS`), never an echo of
 * the request.
 *
 *  - `startRun` takes a `RunRequest` and answers a `RunHandle`: 202 for a new
 *    run, 200 for a run id it already holds, which it does not start again, so
 *    a retried job step cannot sign in twice. A binding mismatch is not an
 *    HTTP error: the run is created already `done`, `needs_attention` with
 *    `binding_mismatch`, and `kms:Decrypt` is never called.
 *  - `runState` answers a `RunHandle`.
 *  - `runResult` answers a `RunResult` once the run is `done` (409 before).
 *  - `capture` answers one `RunCapture` by its index in the result (409 before
 *    `done`). One capture per request, so each job step fetches and ingests
 *    one capture and returns only its document id (ADR 0057 §6).
 *  - `health` answers `{ status: 'ok' }`, with no token.
 *
 * A result and its captures are held for `PORTAL_WORKER_RESULT_TTL_MS` after
 * the run ends, then forgotten, and a worker that restarted holds nothing: both
 * answer 404, and the job records the run failed rather than starting it again.
 */
export const PORTAL_WORKER_ROUTES = {
  health: { method: 'GET', path: '/health' },
  startRun: { method: 'POST', path: '/runs' },
  runState: { method: 'GET', path: '/runs/:runId' },
  runResult: { method: 'GET', path: '/runs/:runId/result' },
  capture: { method: 'GET', path: '/runs/:runId/captures/:index' },
} as const;

/** The worker's error codes, and the status each is sent with. */
export const PORTAL_WORKER_ERRORS = {
  /** No bearer token, or the wrong one. */
  unauthorized: 401,
  /** The body is not a `RunRequest`, or a path parameter is malformed. */
  bad_request: 400,
  /** The body is over `PORTAL_RUN_REQUEST_MAX_BYTES`. */
  too_large: 413,
  /** A run, or a capture index, the worker does not hold. */
  not_found: 404,
  /** A result or a capture asked of a run still running. */
  not_done: 409,
  /** At capacity. Try again later; nothing was started. */
  busy: 503,
} as const;
export type PortalWorkerErrorCode = keyof typeof PORTAL_WORKER_ERRORS;

export interface PortalWorkerErrorBody {
  readonly error: PortalWorkerErrorCode;
}

export const PortalWorkerErrorBodySchema: z.ZodType<PortalWorkerErrorBody> = z
  .object({
    error: z.enum(Object.keys(PORTAL_WORKER_ERRORS) as [PortalWorkerErrorCode, ...PortalWorkerErrorCode[]]),
  })
  .strict();

/** How long a finished run's result and captures stay fetchable. */
export const PORTAL_WORKER_RESULT_TTL_MS = 60 * 60 * 1000;

/** A `RunRequest` body's ceiling. A recipe and a sealed credential are far smaller. */
export const PORTAL_RUN_REQUEST_MAX_BYTES = 256 * 1024;

/** The shortest bearer token either side accepts (as ADR 0047's inbound secret). */
export const PORTAL_READ_TOKEN_MIN_LENGTH = 64;

/** POST /runs. */
export interface RunRequest {
  /** The `portal_read_starts` row's id, minted by the job and written before this request. */
  readonly runId: string;
  readonly orgId: string;
  readonly connectionId: string;
  /** The recipe version as the database holds it: the promoted one in effect, or for a dry run the one an owner named. */
  readonly recipe: RecipeVersion;
  /** The credential row's binding. The worker computes the recipe's and refuses a difference before decrypting. */
  readonly binding: PortalBinding;
  /** The credential row's four sealed columns, as stored. */
  readonly sealed: SealedPortalCredential;
  /** The connection's frozen run parameters, for the recipe's `search` steps. */
  readonly params?: PortalRunParams | undefined;
  /** The connection's `account_id`, which the recipe's account `expect` compares with what the portal shows. */
  readonly expectAccountId: string;
  /**
   * ADR 0057 §3's dry run: the same runner, refusals, allowlist, binding and
   * caps, but a `capture_page` or `download` step does nothing, so nothing is
   * captured or stored, and the run's record is its step log. A read that
   * captures (ADR 0062 §4's landing page, ingested and held `by_portal`) is
   * `false`, whoever started it.
   */
  readonly dryRun: boolean;
}

export const RunRequestSchema: z.ZodType<RunRequest> = z
  .object({
    runId: uuid,
    orgId: uuid,
    connectionId: uuid,
    recipe: RecipeVersionSchema,
    binding: PortalBindingSchema,
    sealed: SealedPortalCredentialSchema,
    params: PortalRunParamsSchema.optional(),
    expectAccountId: trimmedText(PORTAL_LIMITS.accountIdMax),
    dryRun: z.boolean(),
  })
  .strict();

export const PORTAL_RUN_STATES = ['running', 'done'] as const;

/** What `startRun` and `runState` answer. Safe for a job step to return: an id and a state. */
export interface RunHandle {
  readonly runId: string;
  readonly state: (typeof PORTAL_RUN_STATES)[number];
}

export const RunHandleSchema: z.ZodType<RunHandle> = z
  .object({ runId: uuid, state: z.enum(PORTAL_RUN_STATES) })
  .strict();

export interface RunCounts {
  /** Page loads the run made: each main-frame navigation that settled. */
  readonly pages: number;
  /** Captures made, snapshots and downloads together. None in a dry run. */
  readonly captures: number;
  /** Requests the guard refused, sub-resources included. Counted, never listed: a URL can carry a query. */
  readonly refusals: number;
}

const RunCountsSchema: z.ZodType<RunCounts> = z
  .object({ pages: count, captures: count, refusals: count })
  .strict();

/**
 * One line of a run's step log: a recipe step's name and whether it passed,
 * with no values (ADR 0057 §3). One line per step name (a recipe's names are
 * unique), in the order each step first ran, so the log is never longer than
 * the recipe. `passed` is false for the step the run stopped at, and for a
 * `for_each` around it; a step inside `for_each` otherwise passed if it passed
 * every time. Steps never reached have no line. A dry run's `capture_page` and
 * `download` steps pass without capturing.
 */
export interface RunStepLogEntry {
  readonly step: string;
  readonly passed: boolean;
}

const RunStepLogEntrySchema: z.ZodType<RunStepLogEntry> = z
  .object({ step: stepNameText, passed: z.boolean() })
  .strict();

/** The capture kinds a run makes, as the runner's `Capture` names them. */
export const PORTAL_CAPTURE_KINDS = ['page_snapshot', 'download'] as const satisfies readonly Capture['kind'][];
export type CaptureKind = (typeof PORTAL_CAPTURE_KINDS)[number];

/**
 * A capture as a result lists it: no bytes, no filename and no path, so a job
 * step may return it. The bytes and the rest come from `capture`, one at a
 * time, inside the step that ingests them.
 */
export interface RunCaptureSummary {
  /** Its position in the result, which `capture` fetches it by. */
  readonly index: number;
  readonly kind: CaptureKind;
  /** The recipe step that captured it. */
  readonly stepName: string;
  /** Of the bytes as captured. The job checks the fetched body against it before ingesting it. */
  readonly sha256: string;
  readonly byteLength: number;
}

const RunCaptureSummarySchema: z.ZodType<RunCaptureSummary> = z
  .object({
    index: count,
    kind: z.enum(PORTAL_CAPTURE_KINDS),
    stepName: stepNameText,
    sha256: sha256Hex,
    byteLength: count,
  })
  .strict();

/** How the worker ends a run. `not_configured` and `refused` are the job's, and `capture_refused` is found only at ingest. */
export type WorkerRunEnd =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'needs_attention'; readonly reason: PortalWorkerNeedsAttentionReason; readonly atStep: string | null }
  | { readonly outcome: 'failed'; readonly reason: PortalRunnerFailedReason; readonly atStep: string | null }
  | { readonly outcome: 'failed'; readonly reason: 'error'; readonly errorClass: string; readonly atStep: string | null };

/**
 * GET /runs/:runId/result, once the run is `done`. A run that stopped still
 * lists what it captured before it stopped, and those captures still name its
 * start row (ADR 0057 §9). `atStep` is the recipe step it stopped at, or null
 * when it stopped before any step (a binding mismatch).
 */
export type RunResult = {
  readonly runId: string;
  readonly counts: RunCounts;
  readonly steps: readonly RunStepLogEntry[];
  readonly captures: readonly RunCaptureSummary[];
} & WorkerRunEnd;

const runResultBase = {
  runId: uuid,
  counts: RunCountsSchema,
  steps: z.array(RunStepLogEntrySchema),
  captures: z.array(RunCaptureSummarySchema),
};

export const RunResultSchema: z.ZodType<RunResult> = z
  .union([
    z.object({ ...runResultBase, outcome: z.literal('completed') }).strict(),
    z
      .object({
        ...runResultBase,
        outcome: z.literal('needs_attention'),
        reason: z.enum(PORTAL_WORKER_NEEDS_ATTENTION_REASONS),
        atStep: stepNameText.nullable(),
      })
      .strict(),
    z
      .object({
        ...runResultBase,
        outcome: z.literal('failed'),
        reason: z.enum(PORTAL_RUNNER_FAILED_REASONS),
        atStep: stepNameText.nullable(),
      })
      .strict(),
    z
      .object({
        ...runResultBase,
        outcome: z.literal('failed'),
        reason: z.literal('error'),
        errorClass: className,
        atStep: stepNameText.nullable(),
      })
      .strict(),
  ])
  .superRefine((r, ctx) => {
    if (r.counts.captures !== r.captures.length) {
      ctx.addIssue({ code: 'custom', path: ['counts', 'captures'], message: 'counts.captures is not the number of captures listed' });
    }
    r.captures.forEach((c, i) => {
      if (c.index !== i) ctx.addIssue({ code: 'custom', path: ['captures', i, 'index'], message: 'captures are listed by index, from 0' });
    });
    if (new Set(r.steps.map((s) => s.step)).size !== r.steps.length) {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: 'one line per step name' });
    }
  });

/**
 * GET /runs/:runId/captures/:index: one capture, with its bytes. Fetched and
 * ingested inside one job step, which returns only the document id; neither
 * the body nor the filename nor the path is ever a step's return value.
 */
export interface RunCapture {
  readonly runId: string;
  readonly index: number;
  readonly kind: CaptureKind;
  readonly stepName: string;
  /** A snapshot's is `<step>.html`; a download's is the portal's, with the sealed username replaced as in a snapshot. */
  readonly filename: string;
  /** What the runner saw. Informational: the door decides a file's type by its bytes and its source. */
  readonly contentType: string;
  /**
   * The path of the page the capture was made on (ADR 0057 §9), and only the
   * path: no query, no fragment, no `;` parameters (a `;jsessionid=` is a
   * session token) and no ASP.NET cookieless segment (`/(S(…))/`, whose `F`
   * form is an authentication ticket). The worker strips them, and the schema
   * refuses a path that still carries one.
   */
  readonly pagePath: string;
  /** The snapshot serialiser's `SNAPSHOT_RULE_VERSION` for a `page_snapshot`; null for a download. */
  readonly snapshotRuleVersion: number | null;
  /** When the worker captured it, ISO 8601. */
  readonly capturedAt: string;
  /** Of the decoded body. The job checks it before ingesting. */
  readonly sha256: string;
  /** The bytes as captured, base64. A snapshot is already serialised (ADR 0057 §9). */
  readonly bodyBase64: string;
}

export const RunCaptureSchema: z.ZodType<RunCapture> = z
  .object({
    runId: uuid,
    index: count,
    kind: z.enum(PORTAL_CAPTURE_KINDS),
    stepName: stepNameText,
    filename: z.string().min(1).max(PORTAL_LIMITS.filenameMax).regex(NO_CONTROL_CHARACTERS, 'no control characters'),
    contentType: z.string().min(1).max(PORTAL_LIMITS.contentTypeMax).regex(NO_CONTROL_CHARACTERS, 'no control characters'),
    pagePath: z
      .string()
      .min(1)
      .max(PORTAL_LIMITS.pathMax)
      .startsWith('/')
      .regex(/^[^?#;\p{Cc}]*$/u, 'a path, with no query, fragment or ; parameters')
      .refine((p) => !/\([A-Za-z]\(/.test(p), 'no ASP.NET cookieless session segment'),
    snapshotRuleVersion: z.number().int().positive().nullable(),
    capturedAt: z.iso.datetime({ offset: true }),
    sha256: sha256Hex,
    bodyBase64: z.base64(),
  })
  .strict()
  .refine(
    (c) => (c.kind === 'page_snapshot') === (c.snapshotRuleVersion !== null),
    { path: ['snapshotRuleVersion'], message: 'a snapshot names its serialiser version, and a download has none' },
  );

// ---------------------------------------------------------------------------
// The store port the job and Settings → Portals use
// ---------------------------------------------------------------------------

/** A new connection (ADR 0057 §13). Everything but the label is frozen once written. */
export interface NewPortalConnection {
  /** The portal (`sap_business_network`), which a recipe's `portalKey` must name to apply. */
  readonly portalKey: string;
  readonly label: string;
  /** The portal account's public identifier (for SAP Business Network, the ANID), never the username. */
  readonly accountId: string;
  readonly params: PortalRunParams;
}

export const NewPortalConnectionSchema: z.ZodType<NewPortalConnection> = z
  .object({
    portalKey: z.string().regex(PORTAL_KEY_PATTERN, 'a portal key'),
    label: trimmedText(PORTAL_LIMITS.labelMax),
    accountId: trimmedText(PORTAL_LIMITS.accountIdMax),
    params: PortalRunParamsSchema,
  })
  .strict();

export interface PortalConnectionRecord {
  readonly connectionId: string;
  readonly orgId: string;
  readonly portalKey: string;
  readonly label: string;
  readonly accountId: string;
  readonly params: PortalRunParams;
  readonly enabled: boolean;
  /** The member every run of this connection acts as (ADR 0057 §13). */
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A credential to seal and store (ADR 0057 §7). The binding is not an input: the store reads it from the version named. */
export interface NewPortalCredential {
  readonly connectionId: string;
  /** The version whose binding it is sealed to: the promoted one, or for a dry run the one an owner names. */
  readonly recipeVersionId: string;
  /** Names the credential for a person. Never the username: Settings refuses a label that contains it. */
  readonly label?: string | undefined;
  /** The plaintext. Sealed before anything is written; never logged, returned or put in an error. */
  readonly payload: PortalCredentialPayload;
}

/** A connection's current credential: the latest row by `seq`, as ciphertext and binding. */
export interface PortalCredentialRecord {
  readonly credentialId: string;
  readonly connectionId: string;
  readonly label: string | null;
  readonly sealed: SealedPortalCredential;
  readonly binding: PortalBinding;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** A recipe version to store. Immutable once written; a changed portal is a new version. */
export interface NewPortalRecipeVersion {
  /** As `parseRecipe` returned it. Its `portalKey`, `version` and `effectiveFrom` become the row's columns. */
  readonly recipe: RecipeVersion;
  /** Only for a version an agent session drafted (ADR 0057 §5); the caller is then the owner who started it. */
  readonly agentSessionId?: string | undefined;
}

export const PORTAL_REVIEW_VERDICTS = ['promoted', 'rejected'] as const;
export type PortalReviewVerdict = (typeof PORTAL_REVIEW_VERDICTS)[number];

export const PORTAL_ADDITION_KINDS = ['host', 'post_as_read', 'dismiss'] as const;

/**
 * One thing a version adds beyond the promoted version in effect when it was
 * reviewed (ADR 0057 §3): a host, a POST-as-read entry, or a `dismiss` step
 * whose control is on the never-click floor. A review row names each one, and
 * promotion refuses an agent-drafted version that has any.
 */
export type PortalRecipeAddition =
  | { readonly kind: 'host'; readonly host: string }
  | {
      readonly kind: 'post_as_read';
      readonly step: string;
      readonly path: string;
      readonly bodyDiscriminator: { readonly field: string; readonly equals: string } | null;
    }
  | { readonly kind: 'dismiss'; readonly step: string; readonly label: string };

export interface PortalRecipeReviewInput {
  readonly recipeVersionId: string;
  readonly verdict: PortalReviewVerdict;
}

export interface PortalRecipeReviewRecord {
  readonly reviewId: string;
  readonly verdict: PortalReviewVerdict;
  readonly reviewer: string;
  /** The promoted version in effect that `additions` were counted against; null for a portal's first. */
  readonly comparedWithVersionId: string | null;
  readonly additions: readonly PortalRecipeAddition[];
  readonly createdAt: Date;
}

export interface PortalRecipeVersionRecord {
  readonly recipeVersionId: string;
  readonly orgId: string;
  readonly portalKey: string;
  readonly version: number;
  /** YYYY-MM-DD. */
  readonly effectiveFrom: string;
  readonly recipe: RecipeVersion;
  readonly createdBy: string;
  readonly agentSessionId: string | null;
  readonly createdAt: Date;
  /** Its one review, or null while it has none. */
  readonly review: PortalRecipeReviewRecord | null;
}

/** Written through `app.record_portal_read_start()` before the worker is called (ADR 0057 §13). */
export interface PortalRunStartInput {
  /** Minted by the job, so a retried step replays the same row rather than writing a second. */
  readonly runId: string;
  readonly orgId: string;
  readonly connectionId: string;
  /**
   * Null only for a run that found no version to run, or that was refused
   * before it looked for one (a member who may no longer write, a connection
   * turned off, terms not allowed): it then ends `not_configured` or `refused`.
   */
  readonly recipeVersionId: string | null;
  readonly dryRun: boolean;
  /** The member the run acts as: the connection's `created_by`, whose claims the store holds. */
  readonly requestedBy: string;
}

export interface PortalRunCounts {
  readonly pages: number;
  readonly captures: number;
  /** Captures that made a new document. */
  readonly newDocuments: number;
  /** Captures whose bytes the tenant already held; they keep their first arrival (ADR 0057 §9). */
  readonly deduplicated: number;
  /** Requests the guard refused. */
  readonly refusals: number;
}

/** Written once, when the run ends, and complete, through `app.record_portal_read_run()` (ADR 0023's shape). */
export type PortalRunEndInput = {
  readonly runId: string;
  readonly orgId: string;
  readonly atStep: string | null;
  readonly counts: PortalRunCounts;
  readonly stepLog: readonly RunStepLogEntry[];
} & PortalRunEnd;

/** What a capture row says of the run and the bytes, before it is stored or refused. */
export interface PortalCaptureRow {
  readonly runId: string;
  readonly orgId: string;
  readonly recipeVersionId: string;
  readonly kind: CaptureKind;
  readonly stepName: string;
  readonly pagePath: string;
  readonly snapshotRuleVersion: number | null;
  readonly sha256: string;
  readonly capturedAt: Date;
}

/** One capture, stored as a document or refused at the door. The refusal is the door's code; no bytes are kept. */
export type PortalCaptureInput = PortalCaptureRow &
  ({ readonly documentId: string; readonly refusal?: never } | { readonly refusal: RejectionCode; readonly documentId?: never });

/**
 * A capture whose bytes the tenant does not hold yet: the row, and the
 * document the door accepted, whose hash is the row's. Its `uploads` row is
 * `portal_fetch` with no member behind it (ADR 0057 §9).
 */
export interface PortalNewCaptureInput {
  readonly capture: PortalCaptureRow;
  readonly document: Omit<StoredDocument, 'documentId' | 'uploadId'>;
}

/**
 * Why a connection was turned off. `credential_rejected` is the job's, on the
 * portal refusing the sign-in (ADR 0057 §8); the other two are an owner's.
 * Removing a credential disables the connection (ADR 0057 §7).
 */
export const PORTAL_DISABLE_REASONS = ['credential_rejected', 'credential_removed', 'turned_off'] as const;
export type PortalDisableReason = (typeof PORTAL_DISABLE_REASONS)[number];

export type DisablePortalConnectionInput =
  | {
      readonly connectionId: string;
      readonly reason: 'credential_rejected';
      /** The credential the portal refused. Disables only while it is still the latest, so a re-entry since is never undone (ADR 0046's rule). */
      readonly credentialId: string;
    }
  | { readonly connectionId: string; readonly reason: 'credential_removed' | 'turned_off' };

/** `newer_credential`: an owner entered a credential after the refused one, and nothing was written. */
export type PortalDisableOutcome = 'disabled' | 'newer_credential' | 'already_off';
export type PortalEnableOutcome = 'enabled' | 'already_on';

export type PortalRunEndRecord = PortalRunEnd & {
  readonly atStep: string | null;
  readonly counts: PortalRunCounts;
  readonly stepLog: readonly RunStepLogEntry[];
  readonly finishedAt: Date;
};

/** A run as a start row and, once it ended, its outcome row. */
export interface PortalRunRecord {
  readonly runId: string;
  readonly connectionId: string;
  readonly recipeVersionId: string | null;
  readonly dryRun: boolean;
  readonly requestedBy: string;
  readonly startedAt: Date;
  /** Null while the start has no outcome: running still, or a run that did not finish. */
  readonly end: PortalRunEndRecord | null;
}

/** What the fan-out is handed: ids and the portal key, nothing else (ADR 0057 §13). */
export interface PortalConnectionToRead {
  readonly connectionId: string;
  readonly orgId: string;
  readonly portalKey: string;
  readonly createdBy: string;
}

/**
 * The store the portal job and Settings → Portals use (ADR 0057 §6, §7, §13).
 *
 * Every method but `connectionsToRead` acts as one member of one tenant, the
 * claims the store was opened with, as `app_rw` and never as the service role.
 * Who may do what is the database's rule: owner-only writes, the caller as
 * author, and the append-only tables refusing an UPDATE (ADR 0057 §15). A
 * refusal surfaces as a named error, never as `undefined`; `undefined` means
 * only that this tenant cannot see the row.
 */
export interface PortalStore {
  /** Whether this member may write in this org: `app.member_may_write()`, asked of the database. */
  memberMayWrite(actor: { readonly orgId: string; readonly userId: string }): Promise<boolean>;
  /** Adds an enabled connection as the store's member, an owner; returns its id. One enabled connection per portal account across the deployment. */
  createConnection(input: NewPortalConnection): Promise<string>;
  /** The tenant's connections, enabled or not, newest first. */
  listConnections(): Promise<readonly PortalConnectionRecord[]>;
  /** One connection, or `undefined` when this tenant cannot see it. */
  connection(connectionId: string): Promise<PortalConnectionRecord | undefined>;
  /** Seals the payload against the binding of the named version (of the connection's portal) as the database holds it, then, and only then, writes a new credential row as an owner; returns its id. */
  sealAndStoreCredential(input: NewPortalCredential): Promise<string>;
  /** The connection's current credential, or `undefined` when none was ever stored. */
  latestCredential(connectionId: string): Promise<PortalCredentialRecord | undefined>;
  /** Stores a recipe version as the store's member, the version refused unless `parseRecipe` accepts it; returns its id. */
  addRecipeVersion(input: NewPortalRecipeVersion): Promise<string>;
  /** Records an owner's one verdict on a version, naming its additions; refuses promoting an agent draft that has any. Returns the review's id. */
  reviewRecipeVersion(input: PortalRecipeReviewInput): Promise<string>;
  /** One version by id, reviewed or not: the one a dry run or a credential names. */
  recipeVersion(recipeVersionId: string): Promise<PortalRecipeVersionRecord | undefined>;
  /** The connection's promoted version in effect today (UTC): the latest `effective_from` not after today, the highest version breaking a tie. */
  promotedRecipe(connectionId: string): Promise<PortalRecipeVersionRecord | undefined>;
  /** Writes the run's start row through `app.record_portal_read_start()`; returns the run id. A replay of the same start writes nothing. */
  recordRunStart(input: PortalRunStartInput): Promise<string>;
  /** Writes the run's one outcome row through `app.record_portal_read_run()`; returns its id. A replay of the same outcome writes nothing. */
  recordRunEnd(input: PortalRunEndInput): Promise<string>;
  /**
   * Writes a capture of bytes the tenant already held, or one the door
   * refused, in a transaction of its own: neither writes an `uploads` row.
   * Returns its id; a replay of the same capture writes nothing.
   */
  recordCapture(input: PortalCaptureInput): Promise<string>;
  /**
   * Writes a new capture's `uploads` row, its document (bytes and text pages)
   * and its capture row in one transaction (ADR 0057 §15, ADR 0064): a failure
   * anywhere writes none of them. Returns the document and the capture row's id.
   */
  recordNewCapture(input: PortalNewCaptureInput): Promise<{ readonly document: StoredDocument; readonly captureId: string }>;
  /** Turns the connection off, with an audit row naming the reason; `undefined` when this tenant cannot see it. */
  disableConnection(input: DisablePortalConnectionInput): Promise<PortalDisableOutcome | undefined>;
  /** Turns the connection back on, as an owner, with an audit row; `undefined` when this tenant cannot see it. Storing a credential does not. */
  enableConnection(connectionId: string): Promise<PortalEnableOutcome | undefined>;
  /** The connection's runs, newest first, each start with its outcome or none. */
  listRuns(connectionId: string, limit?: number): Promise<readonly PortalRunRecord[]>;
  /** Every enabled connection in the deployment, through `app.portal_connections_to_read()`: untenanted, and refused to a caller carrying any claim. */
  connectionsToRead(): Promise<readonly PortalConnectionToRead[]>;
}

// ---------------------------------------------------------------------------
// Migration 0038's names (ADR 0057 §15)
// ---------------------------------------------------------------------------

export const PORTAL_TABLES = {
  /** The registry. Not append-only (`enabled` flips); every column but `label` and `enabled` frozen by trigger; owner-only writes. */
  connections: 'portal_connections',
  /** Sealed, append-only; INSERT owner-only and as the caller. */
  credentials: 'portal_credentials',
  /** Append-only and immutable; INSERT as the caller. */
  recipeVersions: 'portal_recipe_versions',
  /** Append-only; INSERT owner-only and as the caller. */
  recipeReviews: 'portal_recipe_reviews',
  /** Append-only; written only by `app.record_portal_read_start()`, app_rw SELECT only. */
  readStarts: 'portal_read_starts',
  /** Append-only; written only by `app.record_portal_read_run()`, app_rw SELECT only. */
  readRuns: 'portal_read_runs',
  /** Append-only. */
  captures: 'portal_captures',
} as const;
export type PortalTableName = (typeof PORTAL_TABLES)[keyof typeof PORTAL_TABLES];

/** The six append-only tables: RLS, `no_update_delete`, `no_truncate`, and no UPDATE or DELETE grant (suites 01 and 24). */
export const PORTAL_APPEND_ONLY_TABLES = [
  'portal_credentials',
  'portal_recipe_versions',
  'portal_recipe_reviews',
  'portal_read_starts',
  'portal_read_runs',
  'portal_captures',
] as const satisfies readonly PortalTableName[];

/** The registry's only columns an UPDATE may change (`updated_at` is the trigger's). */
export const PORTAL_CONNECTION_MUTABLE_COLUMNS = ['label', 'enabled'] as const;

/**
 * Every column of every table, in the migration's order. A suite reads each
 * table's columns back from the catalogue and compares, in both directions, so
 * a column nobody decided on fails the day it is written (suite 21's rule).
 * The comment on each is the type and the check it gets.
 */
export const PORTAL_COLUMNS = {
  portal_connections: [
    'id', //          uuid pk default gen_random_uuid(); unique (org_id, id) for the composite keys below
    'org_id', //      uuid not null → organizations
    'portal_key', //  text not null, PORTAL_KEY_PATTERN; frozen
    'label', //       text not null, trimmed, 1–labelMax; mutable
    'account_id', //  text not null, trimmed, 1–accountIdMax; the portal account's public id, never the username; frozen
    'params', //      jsonb not null default '{}', an object of strings (PortalRunParamsSchema); frozen
    'enabled', //     boolean not null default true; mutable
    'created_by', //  uuid not null → users; the caller, an owner; the member every run acts as; frozen
    'created_at', //  timestamptz not null default now(); frozen
    'updated_at', //  timestamptz not null default now(); the trigger's
  ],
  portal_credentials: [
    'id', //             uuid pk default gen_random_uuid()
    'seq', //            bigint generated always as identity; the latest by seq is current
    'org_id', //         uuid not null → organizations
    'connection_id', //  uuid not null; (org_id, connection_id) → portal_connections (org_id, id)
    'label', //          text null, trimmed, 1–labelMax; never the username
    'cipher', //         text not null, not blank
    'key_id', //         text not null, not blank; a KMS key's name, never key material
    'wrapped_key', //    text not null, 1–sealedFieldMax
    'ciphertext', //     text not null, 1–sealedFieldMax
    'sign_in_origin', // text not null; the binding (PortalBinding), which describes the portal and not the credential
    'sign_in_paths', //  text[] not null, 1–signInPathsMax paths, sorted, no duplicates
    'hosts_hash', //     text not null, ^[0-9a-f]{64}$
    'created_by', //     uuid not null → users; = app.current_user_id(), an owner (the INSERT policy)
    'created_at', //     timestamptz not null default now()
  ],
  portal_recipe_versions: [
    'id', //               uuid pk default gen_random_uuid(); unique (org_id, id)
    'org_id', //           uuid not null → organizations
    'portal_key', //       text not null, PORTAL_KEY_PATTERN; = recipe->>'portalKey'
    'version', //          integer not null > 0; = (recipe->>'version')::int; unique (org_id, portal_key, version)
    'effective_from', //   date not null; = (recipe->>'effectiveFrom')::date
    'recipe', //           jsonb not null; the RecipeVersion as parseRecipe returned it
    'created_by', //       uuid not null → users; = app.current_user_id(): its author, or the owner who started the agent session
    'agent_session_id', // text null; the drafting agent session (ADR 0057 §5); null for a person's version
    'created_at', //       timestamptz not null default now()
  ],
  portal_recipe_reviews: [
    'id', //                       uuid pk default gen_random_uuid()
    'org_id', //                   uuid not null → organizations
    'recipe_version_id', //        uuid not null; (org_id, recipe_version_id) → versions; unique: one review per version
    'verdict', //                  text not null, PORTAL_REVIEW_VERDICTS
    'reviewer', //                 uuid not null → users; = app.current_user_id(), an owner (the INSERT policy)
    'compared_with_version_id', // uuid null; (org_id, compared_with_version_id) → versions; null for a portal's first
    'additions', //                jsonb not null default '[]'; PortalRecipeAddition[]
    'created_at', //               timestamptz not null default now()
  ],
  portal_read_starts: [
    'id', //                uuid pk, the run id (RunRequest.runId), minted by the job; unique (org_id, id)
    'org_id', //            uuid not null → organizations
    'connection_id', //     uuid not null; (org_id, connection_id) → portal_connections
    'recipe_version_id', // uuid null; (org_id, recipe_version_id) → versions, of the connection's portal key
    'dry_run', //           boolean not null
    'requested_by', //      uuid not null → users; = app.current_user_id(), the member the run acts as
    'started_at', //        timestamptz not null default now()
  ],
  portal_read_runs: [
    'id', //                 uuid pk default gen_random_uuid()
    'org_id', //             uuid not null → organizations
    'run_id', //             uuid not null; (org_id, run_id) → portal_read_starts (org_id, id); unique: one outcome per run
    'outcome', //            text not null, PORTAL_RUN_OUTCOMES
    'reason', //             text null; PORTAL_REASONS_BY_OUTCOME for needs_attention and failed, null otherwise
    'error_class', //        text null, ^[A-Za-z_$][A-Za-z0-9_$]*$, ≤ errorClassMax; set exactly as PortalRunEnd says
    'at_step', //            text null, ≤ stepNameMax; null when the run stopped at no step
    'page_count', //         integer not null default 0, ≥ 0
    'capture_count', //      integer not null default 0, ≥ 0
    'new_document_count', // integer not null default 0, ≥ 0
    'deduplicated_count', // integer not null default 0, ≥ 0
    'refusal_count', //      integer not null default 0, ≥ 0
    'step_log', //           jsonb not null default '[]'; RunStepLogEntry[], names and pass or fail only
    'finished_at', //        timestamptz not null default now()
  ],
  portal_captures: [
    'id', //                    uuid pk default gen_random_uuid()
    'org_id', //                uuid not null → organizations
    'run_id', //                uuid not null; (org_id, run_id) → portal_read_starts
    'recipe_version_id', //     uuid not null; (org_id, recipe_version_id) → versions; the run's
    'document_id', //           uuid null; (org_id, document_id) → documents; null exactly when refusal is set
    'refusal', //               text null; the door's RejectionCode, for a capture it refused
    'kind', //                  text not null, PORTAL_CAPTURE_KINDS
    'step_name', //             text not null, ≤ stepNameMax
    'page_path', //             text not null; a path, with no query, fragment or ; parameters (RunCapture.pagePath)
    'snapshot_rule_version', // integer null; set exactly for a page_snapshot
    'sha256', //                text not null, ^[0-9a-f]{64}$; the captured bytes', stored or refused
    'captured_at', //           timestamptz not null; when the worker captured it
    'created_at', //            timestamptz not null default now()
  ],
} as const satisfies Record<PortalTableName, readonly string[]>;

/** The names the store matches a refusal on, so 0038 must give these exactly. */
export const PORTAL_CONSTRAINTS = {
  /** Partial unique index on (portal_key, the account id folded: lower case, only letters and digits) where enabled, across every org. */
  oneEnabledPerAccount: 'portal_connections_one_enabled_per_account',
  /** unique (org_id, portal_key, version). */
  oneVersionPerNumber: 'portal_recipe_versions_one_per_number',
  /** unique (recipe_version_id). */
  oneReviewPerVersion: 'portal_recipe_reviews_one_per_version',
  /** unique (run_id). */
  oneOutcomePerRun: 'portal_read_runs_one_per_run',
} as const;

/**
 * The definer functions, with their parameters in order. Each is pinned
 * (`set search_path`), revoked from public and executable by `app_rw` alone.
 *
 *  - `recordReadStart` and `recordReadRun` refuse a caller with no claims and
 *    a `p_org_id` other than its org claim, as `app.record_ledger_sync_run()`
 *    does. `recordReadStart` refuses a `p_requested_by` other than the
 *    caller's subject, and `recordReadRun` a caller who is not its start's
 *    `requested_by`. They escape `app.member_may_write()` and nothing else, so
 *    a run refused because its member may no longer write can still record
 *    that refusal. Each checks that what it names is the same org's, and that
 *    the start's version is of its connection's portal key. A call repeating a
 *    row already written, argument for argument, returns that row's id and
 *    writes nothing; any other second call is refused.
 *  - `connectionsToRead` lists every enabled connection, across orgs, and
 *    refuses any caller carrying an `org_id` or a `sub` claim (migration
 *    0033's rule).
 */
export const PORTAL_FUNCTIONS = {
  recordReadStart: {
    name: 'app.record_portal_read_start',
    params: [
      ['p_run_id', 'uuid'],
      ['p_org_id', 'uuid'],
      ['p_connection_id', 'uuid'],
      ['p_recipe_version_id', 'uuid'],
      ['p_dry_run', 'boolean'],
      ['p_requested_by', 'uuid'],
    ],
    returns: 'uuid',
  },
  recordReadRun: {
    name: 'app.record_portal_read_run',
    params: [
      ['p_run_id', 'uuid'],
      ['p_org_id', 'uuid'],
      ['p_outcome', 'text'],
      ['p_reason', 'text'],
      ['p_error_class', 'text'],
      ['p_at_step', 'text'],
      ['p_page_count', 'integer'],
      ['p_capture_count', 'integer'],
      ['p_new_document_count', 'integer'],
      ['p_deduplicated_count', 'integer'],
      ['p_refusal_count', 'integer'],
      ['p_step_log', 'jsonb'],
    ],
    returns: 'uuid',
  },
  connectionsToRead: {
    name: 'app.portal_connections_to_read',
    params: [],
    returns: 'table (connection_id uuid, org_id uuid, portal_key text, created_by uuid)',
  },
} as const;

/**
 * `audit_log.action` for what an owner, or the job, does to portal data. A
 * payload carries ids and the codes above (a disable's `reason`, a review's
 * `verdict`), never a credential, a label or page text.
 */
export const PORTAL_AUDIT_ACTIONS = {
  connectionCreated: 'portal_connection.created',
  connectionEnabled: 'portal_connection.enabled',
  connectionDisabled: 'portal_connection.disabled',
  credentialStored: 'portal_credential.stored',
  recipeVersionAdded: 'portal_recipe_version.added',
  recipeVersionReviewed: 'portal_recipe_version.reviewed',
} as const;

// ---------------------------------------------------------------------------
// Environment variables, Production only (ADR 0057 §6, ADR 0062 §6)
// ---------------------------------------------------------------------------

export const PORTAL_ENV = {
  /** The worker's base URL, set on the app. */
  readUrl: 'PORTAL_READ_URL',
  /** The bearer token, at least PORTAL_READ_TOKEN_MIN_LENGTH characters. The app presents it, and the worker refuses to start without it. */
  readToken: 'PORTAL_READ_TOKEN',
  /**
   * The portal-credential KMS key, never the QuickBooks one. The app's identity
   * may generate data keys under it (to seal) and not decrypt; the worker's may
   * decrypt and not generate, and the worker refuses a credential whose
   * `keyId` names any other key.
   */
  kmsKeyId: 'PORTAL_KMS_KEY_ID',
} as const;
