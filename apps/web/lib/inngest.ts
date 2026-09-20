import { Inngest, NonRetriableError } from 'inngest';
import { UnscannedDocumentError } from '@recouple/ingest';
import {
  CaseNotFoundError,
  DuplicateCaseError,
  InvalidJobPayloadError,
  readDocumentJob,
  type JobDeps,
  type JobStore,
  type ReadDocumentJobResult,
} from '@recouple/pipeline';
import { isUuid } from './request';

/**
 * The Inngest binding: one event, one function, and the client that sends it
 * (ADR 0021).
 *
 * Everything the job actually does lives in `@recouple/pipeline` as pure
 * functions over ports. This file is the adapter `packages/pipeline/src/ports.ts`
 * has promised since Phase 0 — it names the event, checks the payload, builds a
 * tenant-scoped store from it and hands off. It calls no model and writes no row
 * of its own.
 */

/** The app these functions belong to; the function below is `recouple/read-document`. */
export const INNGEST_APP_ID = 'recouple';

/** A document is stored and scanned clean, and wants reading. */
export const READ_REQUESTED = 'document/read.requested';

/**
 * How many documents one tenant may have being read at once.
 *
 * Keyed on the org so a supplier dropping fifty notices in at once queues behind
 * itself rather than in front of everybody else. The number is small on purpose:
 * a read is a model call, and the limit that matters for cost is the one we can
 * see.
 */
export const READS_IN_FLIGHT_PER_ORG = 4;

/**
 * What the event carries: ids, and who asked.
 *
 * Not one word of the document. The queue is a third party, the payload is
 * durable there, and document content is untrusted content we do not hand out
 * (invariant 4). Everything the read needs beyond this it fetches from the
 * database under the tenant's own claims.
 */
export interface ReadRequestedData {
  readonly documentId: string;
  readonly orgId: string;
  /** The member who uploaded it. The job reads as them, through RLS. */
  readonly userId: string;
  readonly attachToCase?: string;
}

/** A store for a job: `PipelineStore` plus `getDocument`, plus its own closing. */
export interface JobStoreHandle extends JobStore {
  close(): Promise<void>;
}

/**
 * What the function needs from the app: a store for an identity, and the
 * pipeline's dependencies for that store.
 *
 * Injected rather than imported so this file depends on neither `lib/pipeline`
 * nor `lib/session` — and so a test can watch exactly which identity a payload
 * turns into.
 */
export interface JobContext {
  storeFor(identity: { readonly orgId: string; readonly userId: string }): JobStoreHandle;
  depsFor(store: JobStoreHandle): JobDeps;
}

export interface InngestKeys {
  readonly eventKey: string;
  readonly signingKey: string;
}

/**
 * The two keys, or nothing at all.
 *
 * One without the other is not a half-working binding, it is two different
 * broken deployments: an event key with no signing key serves an endpoint that
 * cannot tell Inngest from anyone else, and a signing key with no event key
 * serves a function nothing can trigger. Both are somebody's half-finished
 * change, and ADR 0018's rule applies — half-configured is configured wrong, and
 * it says so rather than picking one of the two.
 */
export function inngestKeysFromEnv(env: NodeJS.ProcessEnv = process.env): InngestKeys | undefined {
  const eventKey = nonEmpty(env.INNGEST_EVENT_KEY);
  const signingKey = nonEmpty(env.INNGEST_SIGNING_KEY);

  if (eventKey !== undefined && signingKey !== undefined) return { eventKey, signingKey };
  if (eventKey === undefined && signingKey === undefined) return undefined;

  throw new Error(
    'INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY go together: ' +
      `this environment has ${eventKey === undefined ? 'only the signing key' : 'only the event key'}. ` +
      'Set both to run the read as a job, or neither to run it inside the request (ADR 0021).',
  );
}

/**
 * The client, in cloud mode unless `INNGEST_DEV` says otherwise.
 *
 * The signing key is passed explicitly rather than left to the SDK's search of
 * the environment, so the endpoint that verifies Inngest's signature and the
 * code that decided this deployment has a binding are reading the same value.
 *
 * One per process, and not one per request: constructing a client attaches an
 * OpenTelemetry span processor, so a fresh one on every upload would leak one
 * per upload. Kept with the keys it was built from, so a rotation that changes
 * them builds a new client rather than going on using the old one.
 */
let cached: { keys: InngestKeys; client: Inngest } | undefined;
export function inngestClient(keys: InngestKeys): Inngest {
  if (
    cached !== undefined &&
    cached.keys.eventKey === keys.eventKey &&
    cached.keys.signingKey === keys.signingKey
  ) {
    return cached.client;
  }

  cached = {
    keys,
    client: new Inngest({
      id: INNGEST_APP_ID,
      eventKey: keys.eventKey,
      signingKey: keys.signingKey,
    }),
  };
  return cached.client;
}

/** What the upload route sends once the bytes are stored and scanned clean. */
export function readRequestedEvent(data: ReadRequestedData): {
  name: string;
  data: ReadRequestedData;
} {
  return { name: READ_REQUESTED, data };
}

/**
 * The event payload, checked before it is used for anything.
 *
 * An event is the one input here that did not come from our own request
 * handler, and an id is about to become a tenant claim. A payload missing one —
 * or carrying something that is not an id — must not read as "any tenant": it
 * fails, and it fails without a retry, because a malformed event will still be
 * malformed in thirty seconds.
 */
export function parseReadRequested(data: unknown): ReadRequestedData {
  if (data === null || typeof data !== 'object') {
    throw new NonRetriableError(`${READ_REQUESTED} carried no payload object`);
  }
  const raw = data as Record<string, unknown>;
  const documentId = requireId(raw.documentId, 'documentId');
  const orgId = requireId(raw.orgId, 'orgId');
  const userId = requireId(raw.userId, 'userId');

  if (raw.attachToCase !== undefined && raw.attachToCase !== null) {
    const attachToCase = requireId(raw.attachToCase, 'attachToCase');
    return { documentId, orgId, userId, attachToCase };
  }
  return { documentId, orgId, userId };
}

/**
 * The job: build the tenant's store from the payload, read the document, close
 * the store.
 *
 * The store is `PostgresStore` as `app_rw` with these claims — the same
 * construction a request makes, because a job is not a privileged context.
 * There is no service-role key in this app and this is not the place one
 * appears (invariant 6).
 */
export async function runReadRequested(
  data: unknown,
  context: JobContext,
): Promise<ReadDocumentJobResult> {
  const payload = parseReadRequested(data);
  const store = context.storeFor({ orgId: payload.orgId, userId: payload.userId });
  try {
    return await readDocumentJob(context.depsFor(store), {
      documentId: payload.documentId,
      orgId: payload.orgId,
      actor: { userId: payload.userId },
      ...(payload.attachToCase !== undefined ? { attachToCase: payload.attachToCase } : {}),
    });
  } catch (error) {
    throw asJobFailure(error);
  } finally {
    await store.close();
  }
}

export interface ReadDocumentInvocation {
  readonly event: { readonly data: unknown };
  readonly step: {
    run(
      id: string,
      work: () => Promise<ReadDocumentJobResult>,
    ): Promise<ReadDocumentJobResult>;
  };
}

/**
 * The handler, as a function of the context so a test can invoke it with a
 * stubbed `step` and see what it built.
 *
 * One step. The read is not split into classify/extract/open, because the three
 * share one payload — the page text a scan costs money to produce — and steps
 * do not share memory: splitting them would either re-read the document or ship
 * its text between steps, and neither is something to do for a progress bar.
 */
export function readDocumentSteps(
  context: JobContext,
): (invocation: ReadDocumentInvocation) => Promise<ReadDocumentJobResult> {
  return async ({ event, step }) =>
    step.run('read-document', () => runReadRequested(event.data, context));
}

/** The one function this app serves. */
export function readDocumentFunction(client: Inngest, context: JobContext) {
  return client.createFunction(
    {
      id: 'read-document',
      name: 'Read an uploaded document',
      triggers: [{ event: READ_REQUESTED }],
      // The document id, so a redelivered event cannot open a second case. The
      // store's `unique (org_id, debtor_id, claim_id)` is the backstop behind
      // it, and `DuplicateCaseError` is what that backstop says (ADR 0019).
      idempotency: 'event.data.documentId',
      retries: 3,
      concurrency: { key: 'event.data.orgId', limit: READS_IN_FLIGHT_PER_ORG },
    },
    readDocumentSteps(context),
  );
}

/**
 * Which failures are worth trying again.
 *
 * Nothing is swallowed: every one of these still fails the run and still says
 * what happened. The question is only whether repeating it could answer
 * differently. A malformed payload, a document that is not this tenant's, a case
 * that is not attachable, a verdict that is not clean and a claim that is
 * already a case are all settled facts — and two of them are settled *after* a
 * model call, so retrying them would spend money three more times to be told the
 * same thing. Everything else — a timeout, a 500 from a vendor, a database that
 * blinked — is left retriable, which is the default.
 *
 * `DocumentNotFoundError` is deliberately in the second group. It costs nothing
 * to ask again, and the one benign cause of it is a delivery that arrived before
 * the row it names was visible. Three tries and then a failure somebody can see
 * is the right answer to a document that really is not there.
 */
function asJobFailure(error: unknown): unknown {
  const settled =
    error instanceof InvalidJobPayloadError ||
    error instanceof CaseNotFoundError ||
    error instanceof DuplicateCaseError ||
    error instanceof UnscannedDocumentError;

  if (!settled) return error;
  return new NonRetriableError((error as Error).message, { cause: error });
}

function requireId(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new NonRetriableError(
      `${READ_REQUESTED} needs ${field} to be an id; this one is ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
