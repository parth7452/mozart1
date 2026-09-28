// What the worker runs of @recouple/portal, in one place.
//
// The worker is not a pnpm workspace package: pnpm-workspace.yaml names
// `apps/*` and `packages/*`, so `@recouple/portal` does not resolve from here.
// Even if it did, the package's index also loads `ingestCaptures` and, through
// it, the whole pipeline, which a process holding decrypted credentials has no
// use for. So the modules the worker runs are imported by path: the contracts,
// the binding, the guard, the TOTP code, the runner, its egress proxy and the
// destination policy the proxy and this worker's pre-decrypt check share.
// Between them they need Playwright, zod and Node's own modules, and nothing
// else at run time.
//
// When the worker joins the workspace, this file is the one to change.
export {
  PORTAL_ENV,
  PORTAL_LIMITS,
  PORTAL_READ_TOKEN_MIN_LENGTH,
  PORTAL_RUN_REQUEST_MAX_BYTES,
  PORTAL_WORKER_ERRORS,
  PORTAL_WORKER_RESULT_TTL_MS,
  PORTAL_WORKER_ROUTES,
  PortalCredentialPayloadSchema,
  RunCaptureSchema,
  RunHandleSchema,
  RunRequestSchema,
  RunResultSchema,
  type PortalBinding,
  type PortalCredentialPayload,
  type PortalWorkerErrorCode,
  type RunCapture,
  type RunCaptureSummary,
  type RunHandle,
  type RunRequest,
  type RunResult,
  type RunStepLogEntry,
  type WorkerRunEnd,
} from '../../../packages/portal/src/contracts';
export { PortalBindingError, bindingOf, portalCredentialContext, sameBinding } from '../../../packages/portal/src/binding';
export { decideRequest } from '../../../packages/portal/src/guard';
export { stepName, type RecipeStep, type RecipeVersion } from '../../../packages/portal/src/recipe';
export { TOTP_STEP_SECONDS, totpCode, totpStepRemainingMs } from '../../../packages/portal/src/totp';
export {
  runRecipe,
  type CredentialSource,
  type RunOptions,
  type RunOutcome,
  type RunnerCapture,
} from '../../../packages/portal/src/runner/runner';
export { egressSwitches, startEgress, type Resolver } from '../../../packages/portal/src/runner/egress';
export {
  PUBLIC_DESTINATIONS_ONLY,
  isLoopbackHostname,
  isPublicHostname,
  type DestinationPolicy,
} from '../../../packages/portal/src/runner/destination-policy';
export { withoutUsername } from '../../../packages/portal/src/runner/snapshot';
