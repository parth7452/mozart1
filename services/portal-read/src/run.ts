// One run (ADR 0057 §6): the refusals made before anything is decrypted, then
// the credential opened for the recipe's binding, the recipe run, and its
// outcome turned into the contract's `RunResult` and the captures the worker
// holds for the job.
//
// What is refused before `kms:Decrypt` is refused on the request alone, so
// nothing is opened, no browser starts and nothing is typed anywhere:
//  - a recipe whose own text can send the browser somewhere it may not go
//    (destinations.ts): a host that is not public (the operator's own
//    network, a cloud metadata address, a private name); a step URL the guard
//    would not let a browser load, which a navigation the runner starts itself
//    would never put to it (`data:`, `about:`, a host off the allowlist); or a
//    sign-in origin or step URL that is not https;
//  - a recipe whose binding is not the credential's (`binding_mismatch`). The
//    binding is computed here from the recipe the runner would run, never
//    taken from the request (ADR 0057 §6-7);
//  - a credential sealed under any key but this worker's (the contract's
//    `PORTAL_ENV.kmsKeyId`);
//  - a recipe whose step names a result could not carry.
import { TokenDecryptionError, type TokenCipher } from '@recouple/crypto';
import { captureSummary, checkableCapture, heldCapture, type HeldCapture } from './capture';
import { holdCredential, openCredential, type Clock, type HeldCredential, type TotpSteps } from './credentials';
import { destinationRefusal, type DestinationPolicy, type DestinationRefusal } from './destinations';
import { classNameOr, errorClassOf, type WorkerLog } from './log';
import {
  PORTAL_LIMITS,
  PortalBindingError,
  RunCaptureSchema,
  RunResultSchema,
  bindingOf,
  sameBinding,
  stepName,
  type CredentialSource,
  type PortalBinding,
  type RecipeStep,
  type RecipeVersion,
  type Resolver,
  type RunOptions,
  type RunOutcome,
  type RunRequest,
  type RunResult,
  type RunStepLogEntry,
  type WorkerRunEnd,
} from './portal';

/**
 * The class names a run's end records for what the worker refuses or cuts
 * short itself. Each is a name, never a message, as every `errorClass` is.
 */
export const WORKER_ERROR_CLASSES = {
  /** A host on the recipe's allowlist, or its sign-in origin's, is not a public destination. Nothing was decrypted. */
  hostNotPublic: 'RecipeHostNotPublicError',
  /**
   * A step's URL (an `open` step's, a `search` step's recorded action) is not
   * http(s), names a host off the recipe's allowlist, or carries a user name or
   * password. Nothing was decrypted.
   */
  stepUrl: 'RecipeStepUrlError',
  /** The recipe signs in, or opens or posts to a page, over plain http, which only a test's loopback fixture may. Nothing was decrypted. */
  notHttps: 'RecipeNotHttpsError',
  /** The sealed credential names a KMS key other than this worker's. Nothing was decrypted. */
  keyMismatch: 'PortalKeyMismatchError',
  /** A recipe step's name is one no result can carry (the contract's step-name rule). Nothing was decrypted. */
  stepName: 'RecipeStepNameError',
  /** The run outlasted every cap and its grace; the worker ended it, and stops if its browser does not close. */
  overran: 'PortalRunOverranError',
  /** What the run produced did not pass the contract's own schemas: a worker fault. Its captures are not offered. */
  invalidResult: 'PortalResultInvalidError',
  /** A capture was larger than the door takes in (`maxCaptureBytes`). No capture of the run is offered. */
  captureTooLarge: 'PortalCaptureTooLargeError',
  /** The run's captures together passed `maxRunCaptureBytes`. No capture of the run is offered. */
  capturesTooLarge: 'PortalRunCapturesTooLargeError',
} as const;

/** The runner, as the worker calls it: `runRecipe`, unless a test names another. */
export type RunRecipe = (recipe: RecipeVersion, creds: CredentialSource, opts: RunOptions) => Promise<RunOutcome>;

/** What bounds one run. */
export interface RunLimits {
  /** The longest a run may take, whatever its recipe's `maxRunMs` says. The runner is handed the lower of the two. */
  readonly runCeilingMs: number;
  /** The largest capture the worker holds: the door's own ceiling (@recouple/ingest's `MAX_UPLOAD_BYTES`). */
  readonly maxCaptureBytes: number;
  /** The most one run's captures may hold together. */
  readonly maxRunCaptureBytes: number;
}

export interface RunDeps extends Clock {
  readonly cipher: TokenCipher;
  readonly executablePath: string;
  readonly runRecipe: RunRecipe;
  /**
   * Where the run's browser may connect: this worker's policy, handed to the
   * runner, whose egress proxy holds every connection to it (the resolved
   * address included). The same policy `beforeDecrypt` read the recipe's text
   * against.
   */
  readonly destinations: DestinationPolicy;
  /** How the runner's egress proxy resolves a name: `dns.lookup`, unless a test's worker answers for it. */
  readonly resolve?: Resolver | undefined;
  readonly log: WorkerLog;
  /** Every connection's last TOTP step, shared by every run this worker makes. */
  readonly totpSteps: TotpSteps;
  readonly limits: RunLimits;
}

/** How a run ended, with what it captured, each capture checked against the contract. */
export interface EndedRun {
  readonly result: RunResult;
  readonly captures: readonly HeldCapture[];
  /**
   * Why the credential did not open, when it did not: the class of the error
   * the cipher wrapped (`TokenDecryptionError.reason`), such as
   * `AccessDeniedException` or `InvalidCiphertextException`. A class name, for
   * the log line alone; the result names `TokenDecryptionError` and no more.
   */
  readonly decryptCause?: string | undefined;
}

/** The contract's rule for a step name, as a result, a step log and a capture carry one. */
const STEP_NAME_CHARACTERS = /^[^\p{Cc}]*$/u;

/** The class name each of destinations.ts's refusals ends a run under. */
const DESTINATION_REFUSED_AS: Readonly<Record<DestinationRefusal, string>> = {
  host_not_public: WORKER_ERROR_CLASSES.hostNotPublic,
  step_url_not_allowed: WORKER_ERROR_CLASSES.stepUrl,
  not_https: WORKER_ERROR_CLASSES.notHttps,
};

export type BeforeDecrypt = { readonly go: true; readonly binding: PortalBinding } | { readonly go: false; readonly end: WorkerRunEnd };

/**
 * What the request alone decides, before anything is opened. `keyId` is this
 * worker's portal key, and `destinations` where it lets a browser go. Nothing
 * here throws on a request the contract admits.
 */
export function beforeDecrypt(request: RunRequest, keyId: string, destinations: DestinationPolicy): BeforeDecrypt {
  // First, whatever the credential: a recipe whose text could send the browser
  // somewhere it may not go runs for nobody, so no owner is asked to enter a
  // credential again for it.
  const refused = destinationRefusal(request.recipe, destinations);
  if (refused !== null) {
    return { go: false, end: failedWith(DESTINATION_REFUSED_AS[refused]) };
  }
  let binding: PortalBinding;
  try {
    binding = bindingOf(request.recipe);
  } catch (e) {
    // A recipe no binding describes cannot be where any credential was sealed for.
    if (e instanceof PortalBindingError) return { go: false, end: { outcome: 'needs_attention', reason: 'binding_mismatch', atStep: null } };
    throw e;
  }
  if (!sameBinding(binding, request.binding)) {
    return { go: false, end: { outcome: 'needs_attention', reason: 'binding_mismatch', atStep: null } };
  }
  if (request.sealed.keyId !== keyId) {
    return { go: false, end: failedWith(WORKER_ERROR_CLASSES.keyMismatch) };
  }
  if (!everyStep(request.recipe.steps).every((s) => stepNameFits(stepName(s)))) {
    return { go: false, end: failedWith(WORKER_ERROR_CLASSES.stepName) };
  }
  return { go: true, binding };
}

/** How long a run of `recipe` may take on this worker: its own cap, never past the worker's ceiling. */
export function runCapMs(recipe: RecipeVersion, ceilingMs: number): number {
  return Math.min(recipe.caps.maxRunMs, ceilingMs);
}

/**
 * The recipe as the runner is handed it: the same, with its run cap lowered to
 * the worker's ceiling where it is higher, so the runner stops itself in time
 * rather than being stopped. Caps are not part of the binding.
 */
export function withRunCap(recipe: RecipeVersion, ceilingMs: number): RecipeVersion {
  const maxRunMs = runCapMs(recipe, ceilingMs);
  return maxRunMs === recipe.caps.maxRunMs ? recipe : { ...recipe, caps: { ...recipe.caps, maxRunMs } };
}

/**
 * Opens the credential for `binding`, runs the recipe with it, and releases
 * it, whatever happened. An exception anywhere ends the run `failed`, named by
 * its class alone.
 */
export async function executeRun(request: RunRequest, binding: PortalBinding, deps: RunDeps): Promise<EndedRun> {
  let held: HeldCredential;
  try {
    held = holdCredential(await openCredential(request, binding, deps.cipher), deps, deps.totpSteps.of(request));
  } catch (e) {
    return { ...endedWith(request.runId, failedWith(errorClassOf(e))), decryptCause: decryptCauseOf(e) };
  }
  try {
    const outcome = await deps.runRecipe(withRunCap(request.recipe, deps.limits.runCeilingMs), held.source, {
      executablePath: deps.executablePath,
      params: request.params,
      now: deps.now,
      dryRun: request.dryRun,
      expectAccountId: request.expectAccountId,
      destinations: deps.destinations,
      resolve: deps.resolve,
    });
    return checked(request, outcome, held.username(), deps);
  } catch (e) {
    return endedWith(request.runId, failedWith(errorClassOf(e)));
  } finally {
    held.release();
  }
}

/** A run that ended with nothing captured and no step run: refused, or cut short. */
export function endedWith(runId: string, end: WorkerRunEnd): EndedRun {
  return { result: { runId, counts: { pages: 0, captures: 0, refusals: 0 }, steps: [], captures: [], ...end }, captures: [] };
}

export function failedWith(errorClass: string, atStep: string | null = null): WorkerRunEnd {
  return { outcome: 'failed', reason: 'error', errorClass, atStep };
}

function decryptCauseOf(e: unknown): string | undefined {
  return e instanceof TokenDecryptionError ? classNameOr(e.reason, 'Error') : undefined;
}

/**
 * The runner's outcome as the contract's result and the captures the worker
 * holds, each checked by the contract's own schema.
 *
 * A capture past `maxCaptureBytes`, or one that takes the run's captures past
 * `maxRunCaptureBytes`, ends the run `failed` at the step that made it, and no
 * capture of the run is offered; its bytes are never encoded or held. What
 * fails a schema is a worker fault: the run ends `failed` under
 * `invalidResult` and offers no capture, and the line logged names the fields
 * and the rules and never a value.
 */
function checked(request: RunRequest, outcome: RunOutcome, username: string, deps: Pick<RunDeps, 'limits' | 'log'>): EndedRun {
  const { runId } = request;
  const counts = { pages: outcome.pages, refusals: outcome.refused.length };
  const tooLarge = captureLimitHit(outcome, deps.limits);
  let ended: EndedRun;
  if (tooLarge !== undefined) {
    const at = outcome.captures[tooLarge.index]!.stepName;
    deps.log('captures_refused', { runId, index: tooLarge.index, atStep: at, errorClass: tooLarge.errorClass, bytes: outcome.captures[tooLarge.index]!.bytes.byteLength });
    ended = {
      result: { runId, counts: { ...counts, captures: 0 }, steps: stoppedAt(outcome.steps, request.recipe, at), captures: [], ...failedWith(tooLarge.errorClass, at) },
      captures: [],
    };
  } else {
    const captures = outcome.captures.map((c, index) => heldCapture(runId, index, c, username));
    ended = { result: { runId, counts: { ...counts, captures: captures.length }, steps: outcome.steps, captures: captures.map(captureSummary), ...endOf(outcome) }, captures };
  }
  const issues = [
    ...issuesOf(RunResultSchema.safeParse(ended.result), 'result'),
    ...ended.captures.flatMap((c) => issuesOf(RunCaptureSchema.safeParse(checkableCapture(c)), `capture.${c.capture.index}`)),
  ];
  if (issues.length > 0) {
    deps.log('result_invalid', { runId, issues: issues.join(', ') });
    return {
      result: { runId, counts: { ...counts, captures: 0 }, steps: [], captures: [], ...failedWith(WORKER_ERROR_CLASSES.invalidResult) },
      captures: [],
    };
  }
  return ended;
}

/** The first capture the worker will not hold, and why: too large alone, or too much with those before it. */
function captureLimitHit(outcome: RunOutcome, limits: RunLimits): { readonly index: number; readonly errorClass: string } | undefined {
  let total = 0;
  for (const [index, capture] of outcome.captures.entries()) {
    const bytes = capture.bytes.byteLength;
    if (bytes > limits.maxCaptureBytes) return { index, errorClass: WORKER_ERROR_CLASSES.captureTooLarge };
    total += bytes;
    if (total > limits.maxRunCaptureBytes) return { index, errorClass: WORKER_ERROR_CLASSES.capturesTooLarge };
  }
  return undefined;
}

/**
 * The step log with `name`, the step the run is taken to have stopped at, and
 * every `for_each` around it, marked as not passed (the contract's
 * `RunStepLogEntry` rule). Every other line is the runner's.
 */
function stoppedAt(steps: readonly RunStepLogEntry[], recipe: RecipeVersion, name: string): RunStepLogEntry[] {
  const failed = new Set(pathTo(recipe.steps, name) ?? [name]);
  return steps.map((line) => (failed.has(line.step) ? { step: line.step, passed: false } : line));
}

/** The names from the outermost step down to the step named `name`, or undefined when no step has that name. */
function pathTo(steps: readonly RecipeStep[], name: string): string[] | undefined {
  for (const step of steps) {
    if (stepName(step) === name) return [name];
    if (step.kind === 'for_each') {
      const inner = pathTo(step.steps, name);
      if (inner !== undefined) return [step.name, ...inner];
    }
  }
  return undefined;
}

function endOf(outcome: RunOutcome): WorkerRunEnd {
  switch (outcome.status) {
    case 'completed':
      return { outcome: 'completed' };
    case 'needs_attention':
      return { outcome: 'needs_attention', reason: outcome.reason, atStep: outcome.atStep };
    case 'failed':
      return outcome.reason === 'error'
        ? { outcome: 'failed', reason: 'error', errorClass: outcome.errorClass, atStep: outcome.atStep }
        : { outcome: 'failed', reason: outcome.reason, atStep: outcome.atStep };
  }
}

/** A schema's refusal as `where.path:code`: the field and the rule, never the value. */
function issuesOf(parsed: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; code: string }[] } | undefined }, where: string): string[] {
  if (parsed.success || parsed.error === undefined) return [];
  return parsed.error.issues.map((i) => `${[where, ...i.path.map(String)].join('.')}:${i.code}`);
}

function stepNameFits(name: string): boolean {
  return name.length >= 1 && name.length <= PORTAL_LIMITS.stepNameMax && STEP_NAME_CHARACTERS.test(name);
}

function everyStep(steps: readonly RecipeStep[]): RecipeStep[] {
  return steps.flatMap((s) => (s.kind === 'for_each' ? [s, ...everyStep(s.steps)] : [s]));
}
