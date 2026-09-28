/**
 * One read of a payer's portal, shaped for a workflow runtime (ADR 0057 §6,
 * §13; ADR 0062).
 *
 * The browser runs in `services/portal-read`, outside Vercel, because a
 * sign-in, an MFA prompt and pagination can outlast a function's 300 seconds.
 * This is what the job does around it, in the ledger sync's order (ADR 0057
 * §13, `ledger-job.ts`): the connection is still enabled, its member may still
 * write, the portal's terms allow a recipe to run (ADR 0057 §2), and only then
 * is the worker handed the sealed credential, its start row written first. A
 * run refused or not configured on the way writes its start row and its
 * outcome row together, and sends the worker nothing; one refused as the
 * worker is about to be called asks it only whether an earlier attempt of that
 * step already started the run, and follows the run if so. The job polls in later
 * steps, takes each capture into the ordinary door as `portal_fetch` (so a
 * notice is held `by_portal`, ADR 0057 §10), records a row per capture and one
 * outcome row, and asks for each stored capture to be read after the browser
 * is gone (§4).
 *
 * **Steps return ids and handles.** A step's return value is durable in the
 * queue, a third party (ADR 0021). The step that reads the sealed credential
 * sends it to the worker and returns the worker's handle; each capture is
 * fetched and ingested inside one step that returns its document id. No step
 * returns a credential, a code, a capture's bytes or page text (ADR 0057 §6).
 * The credential this job handles is ciphertext: the app seals and only the
 * worker opens (§7).
 *
 * **Every run that got a start row gets an outcome row.** `refused` and
 * `not_configured` are settled facts, recorded and returned so a person reads
 * them on Settings → Portals. A failure is recorded as `failed` with its class
 * name, never its message, and then thrown. A refused sign-in turns the
 * connection off before its outcome is written (ADR 0057 §8, ADR 0046's rule),
 * so no later run types the same password. The outcomes ADR 0062 §5 says reach
 * a person by email (a refused sign-in, an expired session, any failure) end
 * the job with `PortalRunAlertError` once they are recorded, which is what
 * makes the failed-run alert (ADR 0052) send.
 *
 * **Why the shapes are declared here.** `@recouple/portal` depends on this
 * package (its `ingestCaptures` runs `ingestDocument`), so this one cannot
 * import the portal's contracts. The shapes below are those contracts' field
 * for field, and `apps/web/lib/inngest-portal.ts` binds the real ones to them:
 * `PostgresPortalStore` must be a `PortalReadJobStore` and the HTTP worker
 * client a `PortalWorkerClient`, typed with the contract's own types, so a
 * field or a reason added on one side and not the other is a type error there
 * rather than a run that goes wrong. The port's members are function-typed
 * properties rather than methods on purpose: TypeScript then checks their
 * parameters strictly, in the direction that matters (this job may write only
 * what the store accepts).
 */

import { randomUUID } from 'node:crypto';
import { portalTermsVerdict, type PortalTermsAllowance } from '@recouple/core-domain';
import {
  PORTAL_SNAPSHOT_MIME,
  RejectedUploadError,
  sha256,
  type RejectionCode,
} from '@recouple/ingest';
import type { PipelineDeps, StoredDocument } from './ports';
import { ingestDocument, type IngestResult, type StoreNewDocument } from './steps';

// ---------------------------------------------------------------------------
// What a run can end as (contracts.ts: PortalRunEnd and its reason codes)
// ---------------------------------------------------------------------------

export type PortalJobOutcome = 'completed' | 'not_configured' | 'refused' | 'needs_attention' | 'failed';

/** What the worker, and the runner in it, can stop a run for, needing a person. */
export type PortalJobWorkerNeedsAttention =
  | 'mfa_unanswerable'
  | 'challenge'
  | 'page_changed'
  | 'terms_prompt'
  | 'credential_rejected'
  | 'session_expired'
  | 'account_mismatch'
  | 'binding_mismatch';

/** Every `needs_attention` reason: the worker's, and one only this job finds at the door. */
export type PortalJobNeedsAttention = PortalJobWorkerNeedsAttention | 'capture_refused';

/** The runner's hard stops. */
export type PortalJobRunnerFailure =
  | 'guard_refused'
  | 'never_click'
  | 'file_input'
  | 'cap_exceeded'
  | 'sign_in_form_refused';

/** A run's end as its outcome row records it. `errorClass` is a class name, never a message. */
export type PortalJobRunEnd =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'not_configured' | 'refused'; readonly errorClass: string }
  | { readonly outcome: 'needs_attention'; readonly reason: PortalJobNeedsAttention }
  | { readonly outcome: 'failed'; readonly reason: PortalJobRunnerFailure }
  | { readonly outcome: 'failed'; readonly reason: 'error'; readonly errorClass: string };

export interface PortalJobRunCounts {
  readonly pages: number;
  readonly captures: number;
  /** Captures that made a new document. */
  readonly newDocuments: number;
  /** Captures whose bytes the tenant already held; they keep their first arrival (ADR 0057 §9). */
  readonly deduplicated: number;
  /** Requests the guard refused. */
  readonly refusals: number;
}

/** A recipe step's name and whether it passed. Nothing else, ever. */
export interface PortalJobStepLogEntry {
  readonly step: string;
  readonly passed: boolean;
}

// ---------------------------------------------------------------------------
// The store port (contracts.ts: PortalStore, and PostgresPortalStore's owner question)
// ---------------------------------------------------------------------------

/** What this job reads of a recipe. The rest goes to the worker as the database holds it. */
export interface PortalJobRecipe {
  readonly portalKey: string;
  readonly provenance: { readonly portalAdr: string };
  readonly caps: { readonly maxRunMs: number };
}

/** A connection as this job reads it: `PortalConnectionRecord` is one. */
export interface PortalJobConnection {
  readonly connectionId: string;
  readonly orgId: string;
  readonly portalKey: string;
  /** The portal account's public identifier, which the recipe's account `expect` compares. */
  readonly accountId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  /** The member every run of this connection acts as (ADR 0057 §13). */
  readonly createdBy: string;
}

/** A recipe version as this job reads it: `PortalRecipeVersionRecord` is one. */
export interface PortalJobRecipeVersion<R extends PortalJobRecipe> {
  readonly recipeVersionId: string;
  readonly portalKey: string;
  readonly recipe: R;
  readonly review: { readonly verdict: 'promoted' | 'rejected' } | null;
}

/** Where a credential may be typed (contracts.ts: PortalBinding). It describes the portal, not the credential. */
export interface PortalJobBinding {
  readonly signInOrigin: string;
  readonly signInPaths: readonly string[];
  readonly hostsHash: string;
}

/** A sealed credential's four columns (contracts.ts: SealedPortalCredential). None opens without `kms:Decrypt`. */
export interface PortalJobSealedCredential {
  readonly cipher: string;
  readonly keyId: string;
  readonly wrappedKey: string;
  readonly ciphertext: string;
}

/** A connection's current credential, as ciphertext and binding: `PortalCredentialRecord` is one. */
export interface PortalJobCredential {
  readonly credentialId: string;
  readonly connectionId: string;
  readonly sealed: PortalJobSealedCredential;
  readonly binding: PortalJobBinding;
}

export interface PortalJobRunStart {
  readonly runId: string;
  readonly orgId: string;
  readonly connectionId: string;
  readonly recipeVersionId: string | null;
  readonly dryRun: boolean;
  readonly requestedBy: string;
}

export type PortalJobRunEndInput = {
  readonly runId: string;
  readonly orgId: string;
  readonly atStep: string | null;
  readonly counts: PortalJobRunCounts;
  readonly stepLog: readonly PortalJobStepLogEntry[];
} & PortalJobRunEnd;

export interface PortalJobCaptureRow {
  readonly runId: string;
  readonly orgId: string;
  readonly recipeVersionId: string;
  readonly kind: PortalJobCaptureKind;
  readonly stepName: string;
  readonly pagePath: string;
  readonly snapshotRuleVersion: number | null;
  readonly sha256: string;
  readonly capturedAt: Date;
}

export type PortalJobCaptureInput = PortalJobCaptureRow &
  (
    | { readonly documentId: string; readonly refusal?: never }
    | { readonly refusal: RejectionCode; readonly documentId?: never }
  );

/** What turning a connection off answered: `not_visible` when this tenant could not see it. */
export type PortalJobDisableAnswer = 'disabled' | 'newer_credential' | 'already_off' | 'not_visible';

/**
 * What the job needs of a store: `PostgresPortalStore`, as `app_rw` with the
 * acting member's claims, is one. Every member here acts as that member.
 */
export interface PortalReadJobStore<R extends PortalJobRecipe> {
  /** `app.member_may_write()`, asked of the database: an event says who, not whether they still may. */
  readonly memberMayWrite: (actor: { readonly orgId: string; readonly userId: string }) => Promise<boolean>;
  /**
   * `app.member_is_owner()`. Asked before a run as well, because turning the
   * connection off on a refused sign-in is an owner's write (migration 0038):
   * a run acting as a member who is now only a writer could meet a refused
   * sign-in and be unable to stop the next run typing the same password.
   */
  readonly memberIsOwner: (actor: { readonly orgId: string; readonly userId: string }) => Promise<boolean>;
  /** Read under the tenant's claims: another tenant's is simply not found. */
  readonly connection: (connectionId: string) => Promise<PortalJobConnection | undefined>;
  /** The connection's promoted version in effect today. */
  readonly promotedRecipe: (connectionId: string) => Promise<PortalJobRecipeVersion<R> | undefined>;
  /** One version by id, reviewed or not. */
  readonly recipeVersion: (recipeVersionId: string) => Promise<PortalJobRecipeVersion<R> | undefined>;
  /** The connection's current credential, as ciphertext and binding. */
  readonly latestCredential: (connectionId: string) => Promise<PortalJobCredential | undefined>;
  readonly recordRunStart: (input: PortalJobRunStart) => Promise<string>;
  readonly recordRunEnd: (input: PortalJobRunEndInput) => Promise<string>;
  /** A capture of bytes the tenant already held, or one the door refused: its own transaction. */
  readonly recordCapture: (input: PortalJobCaptureInput) => Promise<string>;
  /**
   * A new capture's `uploads` row, its document and its capture row, in one
   * transaction (ADR 0057 §15, ADR 0064): a failure anywhere writes none.
   */
  readonly recordNewCapture: (input: {
    readonly capture: PortalJobCaptureRow;
    readonly document: Omit<StoredDocument, 'documentId' | 'uploadId'>;
  }) => Promise<{ readonly document: StoredDocument; readonly captureId: string }>;
  /** Only while the refused credential is still the latest, so a re-entry since is never undone. */
  readonly disableConnection: (input: {
    readonly connectionId: string;
    readonly reason: 'credential_rejected';
    readonly credentialId: string;
  }) => Promise<Exclude<PortalJobDisableAnswer, 'not_visible'> | undefined>;
}

// ---------------------------------------------------------------------------
// The worker port (contracts.ts: the worker's HTTP contract)
// ---------------------------------------------------------------------------

export type PortalJobCaptureKind = 'page_snapshot' | 'download';

/** POST /runs. Ciphertext and binding, never plaintext. */
export interface PortalJobRunRequest<R extends PortalJobRecipe> {
  readonly runId: string;
  readonly orgId: string;
  readonly connectionId: string;
  readonly recipe: R;
  readonly binding: PortalJobBinding;
  readonly sealed: PortalJobSealedCredential;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly expectAccountId: string;
  readonly dryRun: boolean;
}

export interface PortalJobRunHandle {
  readonly runId: string;
  readonly state: 'running' | 'done';
}

/** A capture as a result lists it: no bytes, no filename, no path. */
export interface PortalJobCaptureSummary {
  readonly index: number;
  readonly kind: PortalJobCaptureKind;
  readonly stepName: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/** How the worker ends a run. */
export type PortalWorkerRunEnd =
  | { readonly outcome: 'completed' }
  | {
      readonly outcome: 'needs_attention';
      readonly reason: PortalJobWorkerNeedsAttention;
      readonly atStep: string | null;
    }
  | { readonly outcome: 'failed'; readonly reason: PortalJobRunnerFailure; readonly atStep: string | null }
  | {
      readonly outcome: 'failed';
      readonly reason: 'error';
      readonly errorClass: string;
      readonly atStep: string | null;
    };

export type PortalJobRunResult = {
  readonly runId: string;
  readonly counts: { readonly pages: number; readonly captures: number; readonly refusals: number };
  readonly steps: readonly PortalJobStepLogEntry[];
  readonly captures: readonly PortalJobCaptureSummary[];
} & PortalWorkerRunEnd;

/** One capture, with its bytes. Fetched and ingested inside one step; never returned from one. */
export interface PortalJobRunCapture {
  readonly runId: string;
  readonly index: number;
  readonly kind: PortalJobCaptureKind;
  readonly stepName: string;
  readonly filename: string;
  readonly contentType: string;
  readonly pagePath: string;
  readonly snapshotRuleVersion: number | null;
  readonly capturedAt: string;
  readonly sha256: string;
  readonly bodyBase64: string;
}

/**
 * The worker, over HTTP in the app. Its refusals are this module's errors:
 * `PortalWorkerBusyError` (a run is in flight), `PortalRunLostError` (it holds
 * no such run), `PortalWorkerRefusedError` (a token or a request it will not
 * take), `PortalWorkerContractError` (an answer the contract does not allow)
 * and `PortalWorkerUnavailableError` (no answer).
 */
export interface PortalWorkerClient<R extends PortalJobRecipe> {
  readonly startRun: (request: PortalJobRunRequest<R>) => Promise<PortalJobRunHandle>;
  readonly runState: (runId: string) => Promise<PortalJobRunHandle>;
  readonly runResult: (runId: string) => Promise<PortalJobRunResult>;
  readonly capture: (runId: string, index: number) => Promise<PortalJobRunCapture>;
}

/**
 * Whether this deployment has a worker, decided in one place
 * (`portalReadFromEnv`, `scannerFromEnv`'s shape). `reason` names what is
 * missing, for a log line and never for a row.
 */
export type ResolvedPortalWorker<R extends PortalJobRecipe> =
  | { readonly kind: 'ready'; readonly client: PortalWorkerClient<R> }
  | { readonly kind: 'not_configured'; readonly reason: string };

// ---------------------------------------------------------------------------
// The job's own ports
// ---------------------------------------------------------------------------

/**
 * The runtime's steps. `run` does its work once and replays what it returned
 * when the job is invoked again; `sleep` waits durably between steps. What a
 * step returns is durable in the queue, so it is ids and codes only.
 */
export interface PortalJobSteps {
  run<T>(id: string, work: () => Promise<T>): Promise<T>;
  sleep(id: string, ms: number): Promise<void>;
}

export interface PortalReadJobDeps<R extends PortalJobRecipe> {
  readonly store: PortalReadJobStore<R>;
  readonly worker: ResolvedPortalWorker<R>;
  /**
   * The ADRs whose terms record lets a recipe run (ADR 0057 §2): the app
   * supplies `PORTAL_TERMS_ALLOWED` from @recouple/core-domain, and a test
   * its own. Data only; the check is `portalTermsVerdict`, here.
   */
  readonly terms: ReadonlyMap<string, PortalTermsAllowance>;
  /** A recipe's binding: `bindingOf` in @recouple/portal, its one computation. */
  readonly bindingOf: (recipe: R) => PortalJobBinding;
  /** Where a capture becomes a document: the ordinary door, with the pipeline's store and scanner. */
  readonly ingest: Pick<PipelineDeps, 'store' | 'scanner'>;
  /** Asks for each stored capture to be read, after the run's outcome is recorded (ADR 0057 §4). */
  readonly requestReads: (documentIds: readonly string[]) => Promise<void>;
}

export interface PortalReadJobInput {
  readonly connectionId: string;
  readonly orgId: string;
  /** The member the run acts as: the connection's `created_by` (ADR 0057 §13). */
  readonly actor: { readonly userId: string };
  /**
   * ADR 0057 §3's dry run: the same runner, refusals and binding, and nothing
   * captured or stored. A read that captures is `false`, whoever started it.
   */
  readonly dryRun: boolean;
  /**
   * A dry run of the version an owner named, promoted or not. Absent, the
   * connection's promoted version in effect. A read that captures always runs
   * the promoted version, so it never names one.
   */
  readonly recipeVersionId?: string;
}

export type PortalReadJobResult = {
  readonly runId: string;
  readonly connectionId: string;
  readonly orgId: string;
  readonly dryRun: boolean;
  /** The version the run ran, or null for a run that ended before one was found. */
  readonly recipeVersionId: string | null;
  readonly atStep: string | null;
  readonly counts: PortalJobRunCounts;
  /** The documents the run's captures became and were asked to be read: ids, in capture order. */
  readonly documentIds: readonly string[];
  /** For a refused sign-in: what turning the connection off answered. */
  readonly disabled?: PortalJobDisableAnswer;
  /**
   * Why it did not run, for this deployment's own log and never for a row: a
   * `not_configured` names the variable that is missing, which is what makes
   * it fixable (ADR 0031 §2's rule).
   */
  readonly why?: string;
} & PortalJobRunEnd;

// ---------------------------------------------------------------------------
// Refusals, outcomes and failures, by name
// ---------------------------------------------------------------------------

/**
 * The class names this job records in `portal_read_runs.error_class`, for a
 * reader of that column (Settings → Portals) to compare against rather than
 * copy. Each is the `name` of the class below that says it.
 */
export const PORTAL_READ_ERROR_CLASSES = {
  // refused
  connectionDisabled: 'PortalConnectionDisabledError',
  memberMayNotWrite: 'PortalReadRefusedError',
  memberNotOwner: 'PortalReadOwnerRequiredError',
  termsNotAllowing: 'PortalTermsNotRecordedError',
  recipeRejected: 'PortalRecipeRejectedError',
  // not_configured
  workerNotConfigured: 'PortalWorkerNotConfiguredError',
  recipeNotConfigured: 'PortalRecipeNotConfiguredError',
  credentialNotConfigured: 'PortalCredentialNotConfiguredError',
  // failed
  runLost: 'PortalRunLostError',
  runTimedOut: 'PortalRunTimedOutError',
  workerBusy: 'PortalWorkerBusyError',
  workerRefused: 'PortalWorkerRefusedError',
  workerUnavailable: 'PortalWorkerUnavailableError',
  workerContract: 'PortalWorkerContractError',
  captureIntegrity: 'PortalCaptureIntegrityError',
  captureUnscanned: 'PortalCaptureUnscannedError',
} as const;

/** The connection was turned off before this run could start. Recorded `refused`. */
export class PortalConnectionDisabledError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.connectionDisabled;
  constructor(readonly connectionId: string) {
    super(`portal connection ${connectionId} is turned off`);
  }
}

/** The member the connection acts as may no longer write in its org. Recorded `refused`. */
export class PortalReadRefusedError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.memberMayNotWrite;
  constructor(orgId: string, userId: string) {
    super(`user ${userId} may no longer write in org ${orgId}`);
  }
}

/**
 * The member the connection acts as is no longer an owner, so a refused
 * sign-in could not turn the connection off (ADR 0057 §8). Recorded `refused`.
 */
export class PortalReadOwnerRequiredError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.memberNotOwner;
  constructor(orgId: string, userId: string) {
    super(`user ${userId} is no longer an owner in org ${orgId}`);
  }
}

/** The recipe's ADR does not record the portal's terms as letting it run (ADR 0057 §2). Recorded `refused`. */
export class PortalTermsNotRecordedError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.termsNotAllowing;
  constructor(recipeVersionId: string, reason: string) {
    super(`recipe version ${recipeVersionId} may not run: its portal's terms are not recorded as allowing it (${reason})`);
  }
}

/** A dry run of a version an owner rejected. Recorded `refused`. */
export class PortalRecipeRejectedError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.recipeRejected;
  constructor(recipeVersionId: string) {
    super(`recipe version ${recipeVersionId} was rejected, and is not run`);
  }
}

/** This deployment has no worker to run a recipe (ADR 0057 §6). Recorded `not_configured`. */
export class PortalWorkerNotConfiguredError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.workerNotConfigured;
  constructor(reason: string) {
    super(`no portal worker: ${reason}`);
  }
}

/** The connection's portal has no promoted recipe version in effect. Recorded `not_configured`. */
export class PortalRecipeNotConfiguredError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.recipeNotConfigured;
  constructor(connectionId: string) {
    super(`portal connection ${connectionId} has no promoted recipe version in effect`);
  }
}

/** No credential was ever stored for the connection. Recorded `not_configured`. */
export class PortalCredentialNotConfiguredError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.credentialNotConfigured;
  constructor(connectionId: string) {
    super(`portal connection ${connectionId} has no credential`);
  }
}

/**
 * The worker holds no run by this id: it restarted, or the run's result was
 * held for its hour and forgotten. The job records the run failed rather than
 * starting it again (contracts.ts). Settled.
 */
export class PortalRunLostError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.runLost;
  constructor(readonly runId: string) {
    super(`the portal worker holds no run ${runId}`);
  }
}

/** The worker did not finish the run within every cap it keeps and some slack. Settled. */
export class PortalRunTimedOutError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.runTimedOut;
  constructor(readonly runId: string, polls: number) {
    super(`portal read run ${runId} was still running after ${polls} polls`);
  }
}

/** A run is in flight on the worker and nothing was started: asked again after `retryAfterMs`. */
export class PortalWorkerBusyError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.workerBusy;
  constructor(readonly runId: string, readonly retryAfterMs: number = PORTAL_WORKER_BUSY_RETRY_MS) {
    super(`the portal worker is running another read; run ${runId} was not started`);
  }
}

/**
 * The worker refused the request itself: the token (401), a body it will not
 * take (400) or one too large (413). The same request meets the same answer,
 * so it is settled. `code` is the contract's error code, never a body.
 */
export class PortalWorkerRefusedError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.workerRefused;
  constructor(readonly route: string, readonly httpStatus: number, readonly code: string | undefined) {
    super(`the portal worker refused ${route} (${httpStatus}${code === undefined ? '' : ` ${code}`})`);
  }
}

/** No usable answer from the worker: a timeout, the network, a 5xx. Asked again. */
export class PortalWorkerUnavailableError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.workerUnavailable;
  constructor(readonly route: string, readonly detail: 'timeout' | 'network' | 'http', readonly httpStatus?: number) {
    super(`the portal worker did not answer ${route} (${detail}${httpStatus === undefined ? '' : ` ${httpStatus}`})`);
  }
}

/**
 * The worker answered something the contract does not allow: another run's
 * id, a capture that is not the one listed, a dry run that captured. A fault
 * of the worker's, settled. `rule` names the rule, never a value.
 */
export class PortalWorkerContractError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.workerContract;
  constructor(readonly runId: string, readonly rule: string) {
    super(`the portal worker broke its contract on run ${runId}: ${rule}`);
  }
}

/** A capture's bytes are not the length or hash the worker listed. Fetched again. */
export class PortalCaptureIntegrityError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.captureIntegrity;
  constructor(readonly runId: string, readonly index: number) {
    super(`capture ${index} of portal read run ${runId} is not the bytes the worker listed`);
  }
}

/**
 * The scanner gave no verdict for a stored capture. The document and its
 * capture row are written; the step is asked again, and the retry scans the
 * bytes again (ADR 0047 §10). A capture without a clean verdict is never read.
 */
export class PortalCaptureUnscannedError extends Error {
  override readonly name = PORTAL_READ_ERROR_CLASSES.captureUnscanned;
  constructor(readonly runId: string, readonly index: number, readonly documentId: string) {
    super(`capture ${index} of portal read run ${runId} is stored as document ${documentId} with no scan verdict`);
  }
}

/** A payload that does not name what this job needs, or names things at odds. Never recorded: it names no run. */
export class PortalReadJobError extends Error {
  override readonly name = 'PortalReadJobError';
}

/** A connection this tenant cannot see, or that is not there. Nothing to attribute a row to. */
export class PortalReadConnectionNotFoundError extends Error {
  override readonly name = 'PortalReadConnectionNotFoundError';
  constructor(readonly connectionId: string) {
    super(`no portal connection ${connectionId} for this tenant`);
  }
}

/** A dry run naming a recipe version this tenant cannot see. */
export class PortalReadVersionNotFoundError extends Error {
  override readonly name = 'PortalReadVersionNotFoundError';
  constructor(readonly recipeVersionId: string) {
    super(`no portal recipe version ${recipeVersionId} for this tenant`);
  }
}

/**
 * A run whose recorded end reaches a person by the failed-run alert (ADR 0062
 * §5, ADR 0052): a refused sign-in, an expired session, or any failure. Thrown
 * once its rows are written, so the job ends failed and the alert sends. Its
 * name says which, and its message carries ids and codes only.
 */
export class PortalRunAlertError extends Error {
  override readonly name: string;
  constructor(readonly result: PortalReadJobResult) {
    super(
      `portal read run ${result.runId} of connection ${result.connectionId} for org ${result.orgId} ` +
        `ended ${result.outcome}${'reason' in result ? ` (${result.reason})` : ''}` +
        `${'errorClass' in result ? `, ${result.errorClass}` : ''}` +
        `${result.atStep === null ? '' : ` at step ${result.atStep}`}` +
        `${result.disabled === undefined ? '' : `; the connection: ${result.disabled}`}`,
    );
    this.name =
      result.outcome === 'needs_attention' && result.reason === 'credential_rejected'
        ? 'PortalCredentialRejectedError'
        : result.outcome === 'needs_attention' && result.reason === 'session_expired'
          ? 'PortalSessionExpiredError'
          : 'PortalRunFailedError';
  }
}

/**
 * Whether asking again could answer differently. False for what the same
 * request meets every time: a payload at odds, a run the worker no longer
 * holds, a refusal or a contract fault of the worker's, a run that outlasted
 * every cap, and a recorded end that alerts. The app maps this to the
 * runtime's non-retriable error; everything else is tried again.
 */
export function isSettledPortalReadError(error: unknown): boolean {
  return (
    error instanceof PortalReadJobError ||
    error instanceof PortalReadConnectionNotFoundError ||
    error instanceof PortalReadVersionNotFoundError ||
    error instanceof PortalRunLostError ||
    error instanceof PortalRunTimedOutError ||
    error instanceof PortalWorkerRefusedError ||
    error instanceof PortalWorkerContractError ||
    error instanceof PortalRunAlertError
  );
}

/** How long to wait before asking again, for an error that says so. */
export function portalReadRetryAfterMs(error: unknown): number | undefined {
  return error instanceof PortalWorkerBusyError ? error.retryAfterMs : undefined;
}

/**
 * Whether a run's end reaches a person by the failed-run alert (ADR 0062 §5,
 * the runbook's table): a refused sign-in, an expired session, or any
 * failure. Every other end is on Settings → Portals, in words, and emails no
 * one.
 */
export function portalRunNeedsAlert(end: PortalJobRunEnd): boolean {
  return (
    end.outcome === 'failed' ||
    (end.outcome === 'needs_attention' &&
      (end.reason === 'credential_rejected' || end.reason === 'session_expired'))
  );
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** How long a start waits for a busy worker before asking again: about a dry run's length. */
export const PORTAL_WORKER_BUSY_RETRY_MS = 90_000;

/**
 * How the job waits for a run (ADR 0057 §6: "the job then polls in later
 * steps"). A first look soon, then every twenty seconds, for as long as the
 * worker can take: it ends a run at its recipe's `maxRunMs`, never past thirty
 * minutes, plus two minutes' grace, and stops a minute after that if the
 * browser will not close (`services/portal-read`). Past that and some slack
 * the job stops waiting and records the run failed.
 *
 * Counted in polls rather than read off a clock, so a replayed invocation
 * decides exactly as the first one did.
 */
export const PORTAL_READ_POLL = {
  firstWaitMs: 10_000,
  waitMs: 20_000,
  workerCeilingMs: 30 * 60_000,
  workerGraceMs: 3 * 60_000,
  slackMs: 2 * 60_000,
} as const;

/**
 * The most captures one run's job takes in. Each costs two steps (whether the
 * tenant held its bytes, then the capture), and a run is at most 1,000 steps
 * on the runtime; a run that would pass it is recorded failed before the
 * first is fetched, rather than cut off by the runtime with no outcome row. A
 * recipe's own caps keep far below it: SAP Business Network's captures one
 * page (ADR 0062 §4).
 */
export const PORTAL_READ_MAX_CAPTURES = 300;

/** How many polls a run of this recipe gets before the job stops waiting. */
export function portalReadPollLimit(maxRunMs: number): number {
  const cap =
    Number.isFinite(maxRunMs) && maxRunMs > 0
      ? Math.min(maxRunMs, PORTAL_READ_POLL.workerCeilingMs)
      : PORTAL_READ_POLL.workerCeilingMs;
  const waitFor = cap + PORTAL_READ_POLL.workerGraceMs + PORTAL_READ_POLL.slackMs;
  return Math.ceil(waitFor / PORTAL_READ_POLL.waitMs) + 1;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/** What the `prepare` step returns: the run ended before its worker was asked, or it may go. */
type Prepared =
  | { readonly kind: 'ended'; readonly result: PortalReadJobResult }
  | { readonly kind: 'ready'; readonly recipeVersionId: string; readonly maxRunMs: number };

/** What the `start` step returns: ended before the worker ran it, or the worker's handle. */
type Started =
  | { readonly kind: 'ended'; readonly result: PortalReadJobResult }
  | { readonly kind: 'started'; readonly credentialId: string; readonly state: 'running' | 'done' };

/** What a capture step returns: ids and a code. */
type CaptureOutcome =
  | {
      readonly kind: 'stored';
      readonly index: number;
      readonly stepName: string;
      readonly documentId: string;
      readonly deduplicated: boolean;
      /** Scanned clean, so it may be read. An infected one is stored and never read or served. */
      readonly clean: boolean;
    }
  | { readonly kind: 'refused'; readonly index: number; readonly stepName: string; readonly refusal: RejectionCode };

interface RunIds {
  readonly runId: string;
  readonly orgId: string;
  readonly connectionId: string;
  readonly dryRun: boolean;
}

/** The ids, and the member the run acts as, which only a start row names. */
interface RunActor extends RunIds {
  readonly userId: string;
}

const NO_COUNTS: PortalJobRunCounts = { pages: 0, captures: 0, newDocuments: 0, deduplicated: 0, refusals: 0 };

/**
 * One portal read, from an event's ids, over the runtime's steps.
 *
 * The order is the ledger sync's, and each question is cheaper than what
 * follows it: can this tenant see the connection, is it still on, may its
 * member still write (and turn it off), is there a version to run and do the
 * portal's terms allow it, is there a worker and a credential, and does the
 * credential's binding match the recipe's. Only then is the start row written
 * and the worker handed the ciphertext.
 *
 * A connection or a named version this tenant cannot see is thrown rather
 * than recorded: a run row names a connection, and an event naming one this
 * tenant cannot see is a payload problem rather than a run that went badly.
 */
export async function readPortalJob<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  input: PortalReadJobInput,
  steps: PortalJobSteps,
): Promise<PortalReadJobResult> {
  assertInput(input);

  // Its own step, so a retried `prepare` or `start` writes and sends the same
  // run id, which the database and the worker both answer as a replay.
  const runId = await steps.run('mint-run-id', async () => randomUUID());
  const ids: RunIds = {
    runId,
    orgId: input.orgId,
    connectionId: input.connectionId,
    dryRun: input.dryRun,
  };
  const actor: RunActor = { ...ids, userId: input.actor.userId };

  const prepared = await steps.run('prepare', () => prepareRun(deps, input, actor));
  if (prepared.kind === 'ended') return settle(prepared.result);

  // From here the start row exists, so whatever happens gets an outcome row.
  const progress: {
    recipeVersionId: string;
    result: PortalJobRunResult | undefined;
    captures: CaptureOutcome[];
    endRecorded: boolean;
  } = { recipeVersionId: prepared.recipeVersionId, result: undefined, captures: [], endRecorded: false };

  try {
    const started = await steps.run('start', () => startRun(deps, input, actor, prepared.recipeVersionId));
    if (started.kind === 'ended') {
      progress.endRecorded = true;
      return settle(started.result);
    }

    let state = started.state;
    const limit = portalReadPollLimit(prepared.maxRunMs);
    for (let poll = 1; state === 'running'; poll += 1) {
      if (poll > limit) throw new PortalRunTimedOutError(runId, limit);
      await steps.sleep(`wait-${poll}`, poll === 1 ? PORTAL_READ_POLL.firstWaitMs : PORTAL_READ_POLL.waitMs);
      state = await steps.run(`poll-${poll}`, () => pollRun(deps, runId));
    }

    const result = await steps.run('result', () => fetchResult(deps, ids));
    progress.result = result;
    if (result.captures.length > PORTAL_READ_MAX_CAPTURES) {
      throw new PortalWorkerContractError(
        runId,
        `${result.captures.length} captures, more than the ${PORTAL_READ_MAX_CAPTURES} one run takes in`,
      );
    }

    for (const summary of result.captures) {
      // Asked in a step of its own, before the capture is stored, so that a
      // capture step asked again after storing it does not count its own
      // document as one the tenant already held.
      const heldBefore = await steps.run(`known-${summary.index}`, () =>
        tenantHolds(deps, ids.orgId, summary.sha256),
      );
      progress.captures.push(
        await steps.run(`capture-${summary.index}`, () =>
          ingestCapture(deps, ids, prepared.recipeVersionId, summary, heldBefore),
        ),
      );
    }

    const { end, atStep } = endOf(result, progress.captures);
    const counts = countsOf(result, progress.captures);
    const finished = await steps.run('finish', () =>
      finishRun(deps, ids, { end, atStep, counts, stepLog: result.steps }, started.credentialId),
    );
    progress.endRecorded = true;

    const documentIds = await requestReads(deps, steps, progress.captures);
    return settle({
      ...ids,
      recipeVersionId: prepared.recipeVersionId,
      ...end,
      atStep,
      counts,
      documentIds,
      ...(finished.disabled !== undefined ? { disabled: finished.disabled } : {}),
    });
  } catch (error) {
    // An end that alerts is already recorded, as is any end written before the
    // error: both go on as they are.
    if (error instanceof PortalRunAlertError || progress.endRecorded) throw error;

    // A step that ran out of retries, or the job's own give-up. The row first,
    // then the throw, with the class name and never the message: an error off
    // this path can quote a page (invariant 4).
    const errorClass = errorClassOf(error);
    const counts = countsOf(progress.result, progress.captures);
    const stepLog = progress.result?.steps ?? [];
    await steps.run('record-failure', () =>
      deps.store.recordRunEnd({
        runId,
        orgId: input.orgId,
        outcome: 'failed',
        reason: 'error',
        errorClass,
        atStep: null,
        counts,
        stepLog,
      }),
    );
    // What was stored before it failed is a document like any other.
    const documentIds = await requestReads(deps, steps, progress.captures);
    throw new PortalRunAlertError({
      ...ids,
      recipeVersionId: progress.recipeVersionId,
      outcome: 'failed',
      reason: 'error',
      errorClass,
      atStep: null,
      counts,
      documentIds,
    });
  }
}

/** Returns the result, or throws it as an alert when its end is one that emails a person. */
function settle(result: PortalReadJobResult): PortalReadJobResult {
  if (portalRunNeedsAlert(result)) throw new PortalRunAlertError(result);
  return result;
}

function assertInput(input: PortalReadJobInput): void {
  for (const [field, value] of [
    ['connectionId', input.connectionId],
    ['orgId', input.orgId],
    ['actor.userId', input.actor?.userId],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new PortalReadJobError(`a portal read needs ${field}; this one has none`);
    }
  }
  if (typeof input.dryRun !== 'boolean') {
    throw new PortalReadJobError('a portal read says whether it is a dry run');
  }
  if (input.recipeVersionId !== undefined) {
    if (!input.dryRun) {
      throw new PortalReadJobError(
        'a read that captures runs the promoted version in effect, and names none (ADR 0057 §3)',
      );
    }
    if (typeof input.recipeVersionId !== 'string' || input.recipeVersionId.trim() === '') {
      throw new PortalReadJobError('a dry run of a named version needs its id');
    }
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * `prepare`: the questions, then the start row. A run that ends here writes
 * its start row and its outcome row together, and returns; one that may go
 * writes its start row and returns the version it will run.
 */
async function prepareRun<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  input: PortalReadJobInput,
  actor: RunActor,
): Promise<Prepared> {
  const connection = await visibleConnection(deps, input);

  const refusal = await permissionRefusal(deps, actor, connection);
  if (refusal !== undefined) {
    return { kind: 'ended', result: await endBeforeWorker(deps, actor, null, refusal, true) };
  }

  let version: PortalJobRecipeVersion<R> | undefined;
  if (input.recipeVersionId !== undefined) {
    version = await deps.store.recipeVersion(input.recipeVersionId);
    if (version === undefined) throw new PortalReadVersionNotFoundError(input.recipeVersionId);
  } else {
    version = await deps.store.promotedRecipe(connection.connectionId);
    if (version === undefined) {
      const missing = notConfigured(new PortalRecipeNotConfiguredError(connection.connectionId));
      return { kind: 'ended', result: await endBeforeWorker(deps, actor, null, missing, true) };
    }
  }
  assertSamePortal(connection, version);

  const decided = await decideRun(deps, connection, version, input.dryRun);
  if (decided.kind === 'end') {
    return {
      kind: 'ended',
      result: await endBeforeWorker(deps, actor, version.recipeVersionId, decided.end, true),
    };
  }

  await deps.store.recordRunStart(startRow(actor, version.recipeVersionId));
  return { kind: 'ready', recipeVersionId: version.recipeVersionId, maxRunMs: version.recipe.caps.maxRunMs };
}

/** A start row: always as the member the run acts as, which `visibleConnection` checked is the connection's. */
function startRow(actor: RunActor, recipeVersionId: string | null): PortalJobRunStart {
  return {
    runId: actor.runId,
    orgId: actor.orgId,
    connectionId: actor.connectionId,
    recipeVersionId,
    dryRun: actor.dryRun,
    requestedBy: actor.userId,
  };
}

/**
 * `start`: the questions again, then the worker. Asked again because this step
 * may run minutes after `prepare` (a busy worker is asked again later), and in
 * between another run of this connection may have met a refused sign-in and
 * turned it off: the same password must not be sent again. The version is the
 * one the start row names, never re-resolved.
 *
 * An end found here is recorded only once the worker says it does not hold
 * this run (`onWorkerAlready`): this step is also asked again after an attempt
 * whose start reached the worker and whose answer was lost, and that run is
 * signing in whatever the questions answer now.
 */
async function startRun<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  input: PortalReadJobInput,
  actor: RunActor,
  recipeVersionId: string,
): Promise<Started> {
  const connection = await visibleConnection(deps, input);
  const refusal = await permissionRefusal(deps, actor, connection);
  if (refusal !== undefined) {
    return (
      (await onWorkerAlready(deps, actor)) ?? {
        kind: 'ended',
        result: await endBeforeWorker(deps, actor, recipeVersionId, refusal, false),
      }
    );
  }
  const version = await deps.store.recipeVersion(recipeVersionId);
  if (version === undefined) throw new PortalReadVersionNotFoundError(recipeVersionId);
  assertSamePortal(connection, version);

  const decided = await decideRun(deps, connection, version, input.dryRun);
  if (decided.kind === 'end') {
    return (
      (await onWorkerAlready(deps, actor)) ?? {
        kind: 'ended',
        result: await endBeforeWorker(deps, actor, recipeVersionId, decided.end, false),
      }
    );
  }

  const handle = await decided.client.startRun({
    runId: actor.runId,
    orgId: actor.orgId,
    connectionId: actor.connectionId,
    recipe: version.recipe,
    // The credential row's binding and its four sealed columns, as stored.
    binding: decided.credential.binding,
    sealed: decided.credential.sealed,
    params: connection.params,
    expectAccountId: connection.accountId,
    dryRun: actor.dryRun,
  });
  if (handle.runId !== actor.runId) {
    throw new PortalWorkerContractError(actor.runId, 'the handle names another run');
  }
  return { kind: 'started', credentialId: decided.credential.credentialId, state: handle.state };
}

/**
 * The run as `start` finds it on the worker already: an earlier attempt of the
 * step reached the worker, which started the run, and its answer was lost (a
 * timeout, the network). That run is signing in, or has, whatever this
 * attempt's questions say, so it is followed and recorded as it ends. Recorded
 * as refused or not configured instead, it would say nothing was signed in to,
 * and a sign-in the portal refused would leave no hold on the credential: the
 * connection turned on again would type the refused password (ADR 0057 §8).
 *
 * `undefined` when the worker does not hold it (`PortalRunLostError`) or there
 * is no worker to ask, and the end found is then recorded. Any other failure
 * leaves the question open, so the step is asked again rather than record an
 * end that may be false.
 *
 * The credential is the latest: the one that attempt sent, or one an owner
 * entered since. Should the portal refuse the sign-in, `finish` holds the
 * latest until an owner enters one again, so a refused password is never typed
 * twice, at worst at the cost of a newer credential entered again.
 */
async function onWorkerAlready<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  actor: RunActor,
): Promise<Started | undefined> {
  if (deps.worker.kind !== 'ready') return undefined;
  let handle: PortalJobRunHandle;
  try {
    handle = await deps.worker.client.runState(actor.runId);
  } catch (error) {
    if (error instanceof PortalRunLostError) return undefined;
    throw error;
  }
  if (handle.runId !== actor.runId) {
    throw new PortalWorkerContractError(actor.runId, 'the handle names another run');
  }
  const credential = await deps.store.latestCredential(actor.connectionId);
  if (credential === undefined) {
    throw new PortalReadJobError(
      `the worker holds run ${actor.runId}, and connection ${actor.connectionId} has no credential`,
    );
  }
  return { kind: 'started', credentialId: credential.credentialId, state: handle.state };
}

/** A `poll-n` step: the run's state, which a worker that no longer holds it answers as lost. */
async function pollRun<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  runId: string,
): Promise<'running' | 'done'> {
  const handle = await requireWorker(deps).runState(runId);
  if (handle.runId !== runId) throw new PortalWorkerContractError(runId, 'the handle names another run');
  return handle.state;
}

/** The `result` step: how the run ended, its step log and its captures, listed without bytes. */
async function fetchResult<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  ids: RunIds,
): Promise<PortalJobRunResult> {
  const result = await requireWorker(deps).runResult(ids.runId);
  if (result.runId !== ids.runId) {
    throw new PortalWorkerContractError(ids.runId, 'the result names another run');
  }
  if (result.counts.captures !== result.captures.length) {
    throw new PortalWorkerContractError(ids.runId, 'counts.captures is not the number of captures listed');
  }
  if (ids.dryRun && result.captures.length > 0) {
    throw new PortalWorkerContractError(ids.runId, 'a dry run captures nothing (ADR 0057 §3)');
  }
  result.captures.forEach((capture, index) => {
    if (capture.index !== index) {
      throw new PortalWorkerContractError(ids.runId, 'captures are listed by index, from 0');
    }
  });
  return result;
}

/**
 * A `known-n` step: whether the tenant already holds a capture's bytes, by the
 * hash the result listed. A capture of bytes it holds keeps their first arrival
 * and is counted as deduplicated (ADR 0057 §9).
 */
async function tenantHolds<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  orgId: string,
  sha: string,
): Promise<boolean> {
  return (await deps.ingest.store.findDocumentByHash(orgId, sha)) !== undefined;
}

/**
 * A `capture-n` step: one capture fetched, checked against what the result
 * listed, and taken through the ordinary door as `portal_fetch` with no member
 * behind it (ADR 0057 §9). A page snapshot goes through the snapshot door, a
 * download through the one that decides a file by its bytes; a file the door
 * refuses is recorded as refused, with no bytes kept. The capture's row is
 * written with its document's arrival, in one transaction, when the
 * bytes are new, and on its own when the tenant already held them.
 *
 * Asked again, it stores nothing twice: the bytes dedupe to the document the
 * first attempt stored, and the capture row is the database's replay.
 *
 * Returns the document id and whether it may be read. Never the bytes, the
 * filename or the path.
 */
async function ingestCapture<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  ids: RunIds,
  recipeVersionId: string,
  summary: PortalJobCaptureSummary,
  heldBefore: boolean,
): Promise<CaptureOutcome> {
  const capture = await requireWorker(deps).capture(ids.runId, summary.index);
  if (
    capture.runId !== ids.runId ||
    capture.index !== summary.index ||
    capture.kind !== summary.kind ||
    capture.stepName !== summary.stepName ||
    capture.sha256 !== summary.sha256
  ) {
    throw new PortalWorkerContractError(ids.runId, `capture ${summary.index} is not the one its result listed`);
  }
  const bytes = new Uint8Array(Buffer.from(capture.bodyBase64, 'base64'));
  if (bytes.byteLength !== summary.byteLength || sha256(bytes) !== capture.sha256) {
    throw new PortalCaptureIntegrityError(ids.runId, summary.index);
  }

  const row = {
    runId: ids.runId,
    orgId: ids.orgId,
    recipeVersionId,
    kind: capture.kind,
    stepName: capture.stepName,
    pagePath: capture.pagePath,
    snapshotRuleVersion: capture.snapshotRuleVersion,
    sha256: capture.sha256,
    capturedAt: new Date(capture.capturedAt),
  } as const;

  // A capture of bytes the tenant does not hold is stored with its row, in
  // the transaction that writes its `uploads` row (ADR 0057 §15, ADR 0064), so
  // a row that fails leaves no portal arrival and no document without it.
  let rowWritten = false;
  const storeNewDocument: StoreNewDocument = async ({ upload, document }) => {
    // The door's arrival for a portal capture is always this one; a store
    // writes it as such, and anything else here is a caller's mistake.
    if (upload.source !== 'portal_fetch' || upload.createdBy !== undefined || upload.orgId !== ids.orgId) {
      throw new PortalWorkerContractError(ids.runId, 'a capture arrives as portal_fetch, with no member');
    }
    const stored = await deps.store.recordNewCapture({ capture: row, document });
    rowWritten = true;
    return stored.document;
  };

  let ingested: IngestResult;
  try {
    ingested = await ingestDocument(
      {
        orgId: ids.orgId,
        filename: capture.filename,
        bytes,
        source: 'portal_fetch',
        // The snapshot door is chosen by the source and this type together;
        // a download is decided by its bytes alone, so one that is HTML is
        // refused rather than let through as a snapshot.
        ...(capture.kind === 'page_snapshot' ? { declaredMimeType: PORTAL_SNAPSHOT_MIME } : {}),
      },
      { ...deps.ingest, storeNewDocument },
    );
  } catch (error) {
    // The door's refusal of this one capture is an outcome, recorded; the run
    // then ends `needs_attention` so a person fetches the file by hand.
    // Anything else is a fault, and propagates.
    if (!(error instanceof RejectedUploadError)) throw error;
    await deps.store.recordCapture({ ...row, refusal: error.code });
    return { kind: 'refused', index: summary.index, stepName: capture.stepName, refusal: error.code };
  }

  const documentId = ingested.document.documentId;
  if (!rowWritten) {
    // Bytes the tenant already held (or an earlier attempt of this step
    // stored): no arrival is written, and the row is its own transaction — a
    // replay of the row that attempt wrote, or a new row for held bytes.
    await deps.store.recordCapture({ ...row, documentId });
  }
  if (ingested.verdict.status === 'error') {
    throw new PortalCaptureUnscannedError(ids.runId, summary.index, documentId);
  }
  if (ingested.verdict.status === 'infected') {
    // Stored, and never read or served (`assertScannedClean`,
    // `servingRefusal`): its scan row is the record. Said here by ids alone.
    console.warn(
      `[recouple] portal read: capture ${summary.index} of run ${ids.runId} (org ${ids.orgId}) ` +
        `is document ${documentId}, which scanned infected; it is not read`,
    );
  }
  return {
    kind: 'stored',
    index: summary.index,
    stepName: capture.stepName,
    documentId,
    // Whether the tenant held these bytes before this capture, not whether
    // this attempt found them: an earlier attempt of this step may have
    // stored them.
    deduplicated: heldBefore,
    clean: ingested.verdict.status === 'clean',
  };
}

/**
 * The `finish` step: a refused sign-in turns the connection off first, then
 * the outcome row is written. First, so that however the rest goes, no later
 * run types the password the portal refused (ADR 0057 §8); a disable that
 * fails fails the step, which is asked again. Only while the refused
 * credential is still the latest (ADR 0046's rule): `newer_credential` means
 * an owner has entered one since, and the connection stays on.
 */
async function finishRun<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  ids: RunIds,
  ended: {
    readonly end: PortalJobRunEnd;
    readonly atStep: string | null;
    readonly counts: PortalJobRunCounts;
    readonly stepLog: readonly PortalJobStepLogEntry[];
  },
  credentialId: string,
): Promise<{ readonly disabled?: PortalJobDisableAnswer }> {
  let disabled: PortalJobDisableAnswer | undefined;
  if (ended.end.outcome === 'needs_attention' && ended.end.reason === 'credential_rejected') {
    disabled =
      (await deps.store.disableConnection({
        connectionId: ids.connectionId,
        reason: 'credential_rejected',
        credentialId,
      })) ?? 'not_visible';
    console.warn(
      `[recouple] portal read: run ${ids.runId}: the portal refused the sign-in for connection ` +
        `${ids.connectionId} (org ${ids.orgId}); ` +
        (disabled === 'disabled'
          ? 'turned it off until an owner enters the credential again'
          : disabled === 'newer_credential'
            ? 'an owner entered a newer credential since, so it stays on'
            : disabled === 'already_off'
              ? 'it was already off'
              : 'it is not visible to this tenant, so nothing was changed'),
    );
  }
  await deps.store.recordRunEnd({
    runId: ids.runId,
    orgId: ids.orgId,
    ...ended.end,
    atStep: ended.atStep,
    counts: ended.counts,
    stepLog: ended.stepLog,
  });
  return disabled === undefined ? {} : { disabled };
}

/**
 * Asks for every stored capture that scanned clean to be read, once each, in
 * its own step (ADR 0057 §4: after the run has ended and the browser is gone).
 * The read holds a notice or remittance `by_portal` whatever it is asked
 * (ADR 0057 §10), so nothing here opens a case.
 */
async function requestReads<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  steps: PortalJobSteps,
  captures: readonly CaptureOutcome[],
): Promise<readonly string[]> {
  const documentIds = [
    ...new Set(
      captures.flatMap((capture) => (capture.kind === 'stored' && capture.clean ? [capture.documentId] : [])),
    ),
  ];
  if (documentIds.length > 0) {
    await steps.run('request-reads', async () => {
      await deps.requestReads(documentIds);
      return documentIds.length;
    });
  }
  return documentIds;
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

async function visibleConnection<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  input: PortalReadJobInput,
): Promise<PortalJobConnection> {
  const connection = await deps.store.connection(input.connectionId);
  if (connection === undefined) throw new PortalReadConnectionNotFoundError(input.connectionId);
  if (connection.orgId !== input.orgId) {
    // The store read under this org's claims, so RLS should have hidden it:
    // the belt the in-memory stores need, as `syncLedgerJob` has.
    throw new PortalReadJobError(`connection ${input.connectionId} does not belong to org ${input.orgId}`);
  }
  if (connection.createdBy !== input.actor.userId) {
    // A run acts as the member who connected it (ADR 0057 §13), and the
    // database refuses a start row naming anyone else.
    throw new PortalReadJobError(
      `a run of connection ${input.connectionId} acts as the member who connected it, not user ${input.actor.userId}`,
    );
  }
  return connection;
}

/**
 * Is it still on, may its member still write, and is that member still an
 * owner? Asked of the database each time, before anything is read that a
 * refusal would make pointless.
 */
async function permissionRefusal<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  actor: RunActor,
  connection: PortalJobConnection,
): Promise<EndBeforeWorker | undefined> {
  if (!connection.enabled) return refused(new PortalConnectionDisabledError(connection.connectionId));
  const member = { orgId: actor.orgId, userId: actor.userId };
  if (!(await deps.store.memberMayWrite(member))) {
    return refused(new PortalReadRefusedError(actor.orgId, actor.userId));
  }
  if (!(await deps.store.memberIsOwner(member))) {
    return refused(new PortalReadOwnerRequiredError(actor.orgId, actor.userId));
  }
  return undefined;
}

function assertSamePortal<R extends PortalJobRecipe>(
  connection: PortalJobConnection,
  version: PortalJobRecipeVersion<R>,
): void {
  if (version.portalKey !== connection.portalKey || version.recipe.portalKey !== connection.portalKey) {
    throw new PortalReadJobError(
      `recipe version ${version.recipeVersionId} is not of connection ${connection.connectionId}'s portal`,
    );
  }
}

type Decided<R extends PortalJobRecipe> =
  | { readonly kind: 'end'; readonly end: EndBeforeWorker }
  | { readonly kind: 'go'; readonly client: PortalWorkerClient<R>; readonly credential: PortalJobCredential };

/** An end decided before the worker is asked, with why, for the log. */
interface EndBeforeWorker {
  readonly end: PortalJobRunEnd;
  readonly why: string;
}

/**
 * For a version this run may use: was it rejected (for a dry run), do the
 * portal's terms allow it, is there a worker, is there a credential, and is
 * the credential sealed to this recipe's binding? The last is the worker's
 * check too, before `kms:Decrypt` (ADR 0057 §6); found here first, the
 * ciphertext is not sent at all.
 */
async function decideRun<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  connection: PortalJobConnection,
  version: PortalJobRecipeVersion<R>,
  dryRun: boolean,
): Promise<Decided<R>> {
  if (dryRun && version.review?.verdict === 'rejected') {
    return { kind: 'end', end: refused(new PortalRecipeRejectedError(version.recipeVersionId)) };
  }

  const terms = portalTermsVerdict(
    { portalKey: version.recipe.portalKey, portalAdr: version.recipe.provenance.portalAdr },
    deps.terms,
  );
  if (!terms.allowed) {
    return {
      kind: 'end',
      end: refused(new PortalTermsNotRecordedError(version.recipeVersionId, terms.reason)),
    };
  }

  if (deps.worker.kind === 'not_configured') {
    return { kind: 'end', end: notConfigured(new PortalWorkerNotConfiguredError(deps.worker.reason)) };
  }

  const credential = await deps.store.latestCredential(connection.connectionId);
  if (credential === undefined) {
    return { kind: 'end', end: notConfigured(new PortalCredentialNotConfiguredError(connection.connectionId)) };
  }
  if (credential.connectionId !== connection.connectionId) {
    throw new PortalReadJobError(`the credential read for connection ${connection.connectionId} is another's`);
  }

  if (!sameBinding(deps.bindingOf(version.recipe), credential.binding)) {
    return {
      kind: 'end',
      end: {
        end: { outcome: 'needs_attention', reason: 'binding_mismatch' },
        why:
          `credential ${credential.credentialId} is sealed to another binding than recipe version ` +
          `${version.recipeVersionId}'s; an owner enters it again under this version`,
      },
    };
  }
  return { kind: 'go', client: deps.worker.client, credential };
}

/**
 * Whether two bindings name the same destination, as `sameBinding` in
 * @recouple/portal decides it: the same origin, hosts hash and paths, in the
 * same order. A binding that is not canonical matches nothing.
 */
function sameBinding(a: PortalJobBinding, b: PortalJobBinding): boolean {
  return (
    a.signInOrigin === b.signInOrigin &&
    a.hostsHash === b.hostsHash &&
    a.signInPaths.length === b.signInPaths.length &&
    a.signInPaths.every((path, index) => path === b.signInPaths[index])
  );
}

/** A refusal: its class's name for the row, its message (ids only) for the log. */
function refused(refusal: Error): EndBeforeWorker {
  return { end: { outcome: 'refused', errorClass: refusal.name }, why: refusal.message };
}

/** Something this run needs is missing: its class's name for the row, its message for the log. */
function notConfigured(missing: Error): EndBeforeWorker {
  return { end: { outcome: 'not_configured', errorClass: missing.name }, why: missing.message };
}

/**
 * Writes a run that ended before its worker ran it: the start row (unless one
 * is already written) and its outcome row, with nothing counted and no steps.
 */
async function endBeforeWorker<R extends PortalJobRecipe>(
  deps: PortalReadJobDeps<R>,
  actor: RunActor,
  recipeVersionId: string | null,
  ended: EndBeforeWorker,
  writeStart: boolean,
): Promise<PortalReadJobResult> {
  if (writeStart) await deps.store.recordRunStart(startRow(actor, recipeVersionId));
  await deps.store.recordRunEnd({
    runId: actor.runId,
    orgId: actor.orgId,
    ...ended.end,
    atStep: null,
    counts: NO_COUNTS,
    stepLog: [],
  });
  return {
    runId: actor.runId,
    orgId: actor.orgId,
    connectionId: actor.connectionId,
    dryRun: actor.dryRun,
    recipeVersionId,
    ...ended.end,
    atStep: null,
    counts: NO_COUNTS,
    documentIds: [],
    why: ended.why,
  };
}

function requireWorker<R extends PortalJobRecipe>(deps: PortalReadJobDeps<R>): PortalWorkerClient<R> {
  if (deps.worker.kind !== 'ready') {
    // A run that started had a worker; one that is gone mid-run is this
    // deployment changing under it, and is recorded as the failure it is.
    throw new PortalWorkerNotConfiguredError(deps.worker.reason);
  }
  return deps.worker.client;
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

/**
 * The run's end: the worker's, except that a completed run with a capture the
 * door refused needs a person (ADR 0057 §9), at the step that captured it.
 */
function endOf(
  result: PortalJobRunResult,
  captures: readonly CaptureOutcome[],
): { readonly end: PortalJobRunEnd; readonly atStep: string | null } {
  if (result.outcome === 'completed') {
    const refusedCapture = captures.find((capture) => capture.kind === 'refused');
    return refusedCapture === undefined
      ? { end: { outcome: 'completed' }, atStep: null }
      : { end: { outcome: 'needs_attention', reason: 'capture_refused' }, atStep: refusedCapture.stepName };
  }
  if (result.outcome === 'needs_attention') {
    return { end: { outcome: 'needs_attention', reason: result.reason }, atStep: result.atStep };
  }
  if (result.reason === 'error') {
    return { end: { outcome: 'failed', reason: 'error', errorClass: result.errorClass }, atStep: result.atStep };
  }
  return { end: { outcome: 'failed', reason: result.reason }, atStep: result.atStep };
}

function countsOf(
  result: PortalJobRunResult | undefined,
  captures: readonly CaptureOutcome[],
): PortalJobRunCounts {
  const stored = captures.filter((capture) => capture.kind === 'stored');
  return {
    pages: result?.counts.pages ?? 0,
    captures: result?.counts.captures ?? 0,
    newDocuments: stored.filter((capture) => !capture.deduplicated).length,
    deduplicated: stored.filter((capture) => capture.deduplicated).length,
    refusals: result?.counts.refusals ?? 0,
  };
}

/** A class name, as `error_class` admits one; anything else is recorded as `Error`. */
function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return typeof name === 'string' && name.length <= 100 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? name
    : 'Error';
}
