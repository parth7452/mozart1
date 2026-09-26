import { createHash } from 'node:crypto';
import { Inngest, NonRetriableError, RetryAfterError } from 'inngest';
import type { ConcurrencyOption } from 'inngest/types';
import { UnscannedDocumentError } from '@recouple/ingest';
import {
  CaseMergedAwayError,
  CaseNotFoundError,
  ClassificationFloorError,
  ClassificationRefusedError,
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
 * The concurrency limit of the Inngest plan this app is on.
 *
 * Not a preference: a function whose keyless concurrency limit exceeds it is
 * rejected when the app syncs, so the whole app fails to deploy. Recorded here
 * because nothing else in this repository knows what plan we are on.
 */
export const INNGEST_PLAN_CONCURRENCY_LIMIT = 5;

/**
 * How many documents one tenant may have being read at once.
 *
 * Keyed on the org so a supplier dropping fifty notices in at once queues behind
 * itself rather than in front of everybody else. The number is small on purpose:
 * a read is a model call, and the limit that matters for cost is the one we can
 * see. It is deliberately well under `READS_IN_FLIGHT` — at two, a second
 * tenant can still get a document read while the first one's bulk upload is in
 * flight, which a per-org limit equal to the fleet cap would not allow.
 */
export const READS_IN_FLIGHT_PER_ORG = 2;

/**
 * How many documents this app may have being read at once, across every tenant.
 *
 * The per-org limit bounds one tenant; nothing bounded the fleet. Fifty tenants
 * dropping four notices each is two hundred concurrent reads — two hundred
 * Anthropic calls, two hundred Reducto calls and two hundred database
 * connections from a pool of four per instance — and the first thing anyone
 * would see is a vendor rate-limiting us or the pool timing out, neither of
 * which reads as "too much work at once". A ceiling that is visible in the
 * function's own configuration is the one we can reason about.
 *
 * It is also not ours alone to choose. Inngest refuses to sync an app whose
 * function asks for more concurrency than the plan allows — "The function 'Read
 * an uploaded document' has higher concurrency limits (16) than your plan limit
 * of 5" — and a refused sync is not a slower read, it is no deployed function at
 * all. So this must stay at or below `INNGEST_PLAN_CONCURRENCY_LIMIT`; raising
 * it means raising the plan first, and moving the constant below with it.
 */
export const READS_IN_FLIGHT = 5;

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
  /**
   * What makes two events the same request to read, for the runtime's
   * idempotency window.
   *
   * An upload sets it to the document id, so a redelivery of *that* event — the
   * same upload, delivered twice — is one read rather than two. A deliberate
   * re-drive sets a fresh `randomUUID()`, so it is a different request and the
   * window does not swallow it. That distinction is the whole reason the key is
   * a field rather than `event.data.documentId`: keying on the document made a
   * stalled read unrecoverable for twenty-four hours, because the recovery was
   * an event for the same document (ADR 0021).
   *
   * An upload that names a case to attach to keys on the document *and* the
   * case (`attachReadKey`), since 2026-09-26. The same bytes uploaded to case A
   * and then to case B before A's read has recorded anything dedupe to one
   * document, and keyed on the document alone B's event was A's for the
   * window's purposes: swallowed, while the reviewer on B was told the file was
   * being read for B. Keyed on the pair, a redelivery of B's own upload is
   * still one event and B's upload is no longer A's.
   *
   * Not a secret and not a claim: it decides nothing about who may read what.
   */
  readonly readKey: string;
  /**
   * Whether the read this event asks for may open a case for a notice that has
   * none. Absent means yes, which is what an upload is.
   *
   * A boolean, so it travels through a third party's queue the way the ids do
   * — there is nothing of the document in it.
   */
  readonly allowCaseOpen?: boolean;
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

/**
 * The `readKey` of an upload that attaches its document to a case: one value
 * per (document, case), the same every time it is asked.
 *
 * Deterministic on purpose, and not a `randomUUID()`. The key's whole promise
 * is that a redelivery of one upload's event is one read; a random key per
 * upload would keep that for nothing but the upload-with-no-case. Two uploads
 * of the same bytes to the same case are the same request — the second is
 * answered from the record once the first has finished, and swallowed by the
 * window while it has not, which is right, because the first will file it
 * there.
 *
 * UUID-shaped because `parseReadRequested` refuses anything else: the first
 * sixteen bytes of SHA-256 over `read:<document>:<case>`, with the version
 * nibble set to 8 (RFC 9562's custom version) and the RFC variant bits, so it
 * can never be mistaken for a random (version 4) one. Both ids are lowercased
 * first, so a case id written in capitals is still the same key. Not a secret:
 * it decides nothing about who may read what.
 */
export function attachReadKey(documentId: string, caseId: string): string {
  const bytes = createHash('sha256')
    .update(`read:${documentId.toLowerCase()}:${caseId.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * How long an attachment waits before asking again, when another delivery was
 * reading its document.
 *
 * Two minutes, with `READ_DOCUMENT_CONFIG.retries` at three, gives the read in
 * front about six minutes to finish. That figure is an estimate, not a
 * measurement: a dense remittance streams for a few minutes (CLAUDE.md, ~250
 * output tokens a row) and OCR comes before it, but no slow dense read has been
 * timed against it. A read that outlasts it fails this run loudly —
 * `alert-on-failure` emails that `read-document` failed (ADR 0052) — and the
 * reviewer uploads the file to the case again, which files the recorded
 * reading with no model call. The case is never left without its document and
 * nobody told.
 */
export const ATTACH_WAITS_FOR_READ_MS = 2 * 60 * 1000;

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
  // Required, like the ids: the runtime's idempotency expression reads it, and
  // an event with none is an event this app did not send. Refusing it loudly
  // is the same choice as refusing a payload with no org — a missing key must
  // not read as "no window", silently, in the one place where a second read
  // costs a second document's worth of model calls.
  const readKey = requireId(raw.readKey, 'readKey');

  // Absent is the default and the default is true; only an explicit `false`
  // narrows the read. Anything that is not a boolean is a payload we did not
  // write, and a truthy string would turn a refusal into permission.
  let allowCaseOpen: boolean | undefined;
  if (raw.allowCaseOpen !== undefined && raw.allowCaseOpen !== null) {
    if (typeof raw.allowCaseOpen !== 'boolean') {
      throw new NonRetriableError(
        `${READ_REQUESTED} needs allowCaseOpen to be a boolean; this one is ${JSON.stringify(raw.allowCaseOpen)}`,
      );
    }
    allowCaseOpen = raw.allowCaseOpen;
  }

  return {
    documentId,
    orgId,
    userId,
    readKey,
    ...(raw.attachToCase !== undefined && raw.attachToCase !== null
      ? { attachToCase: requireId(raw.attachToCase, 'attachToCase') }
      : {}),
    ...(allowCaseOpen !== undefined ? { allowCaseOpen } : {}),
  };
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
      ...(payload.allowCaseOpen !== undefined ? { allowCaseOpen: payload.allowCaseOpen } : {}),
    });
  } catch (error) {
    throw asJobFailure(error, { documentId: payload.documentId, orgId: payload.orgId });
  } finally {
    await store.close();
  }
}

export interface ReadDocumentInvocation {
  readonly event: { readonly data: unknown };
  /**
   * Inngest's zero-indexed attempt number and the most it will make, from the
   * handler's context. Only a log line reads them, to say whether a claimed
   * attachment will be asked again; `maxAttempts` is optional in the SDK's
   * types, and without it the line says only that it asks again if retries
   * remain.
   */
  readonly attempt?: number;
  readonly maxAttempts?: number;
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
 *
 * **It says where it got to.** A run that is invoked and then never comes back
 * to execute its step is the failure this logging exists for: the SDK answers
 * the first call with a step plan, the runtime is meant to call again to run
 * the step, and when it does not there is no error anywhere — the document
 * simply stays unread while the reviewer is told for ever that it is being
 * read. Four lines make the two halves distinguishable in the platform's own
 * logs: the run was entered, the step body actually ran, what it concluded, and
 * the run returned. A run line with no step line is a stall at exactly that
 * seam, and there was no way to see it from here before.
 *
 * What a line may carry is the rule the event payload follows: ids, flags and a
 * doc type, which is a closed set. Never a filename, never a quote, never a page
 * (invariant 4). `haltedBecause` is reduced to yes or no for that reason — it
 * is a sentence built around a scanner's own words. A hold's reason is said in
 * full, because it is one of two constants (ADR 0044).
 */
export function readDocumentSteps(
  context: JobContext,
): (invocation: ReadDocumentInvocation) => Promise<ReadDocumentJobResult> {
  return async ({ event, step, attempt, maxAttempts }) => {
    const where = whereFor(event.data);
    console.log(`[recouple] read job: run entered, ${where}`);
    const result = await step.run('read-document', async () => {
      console.log(`[recouple] read job: step read-document entered, ${where}`);
      const read = await runReadRequested(event.data, context);
      const waitingToFileOn = read.beingRead ? attachTargetOf(event.data) : undefined;
      console.log(
        '[recouple] read job: step read-document ' +
          (read.beingRead
            ? waitingToFileOn !== undefined
              ? `found another delivery reading it, spent nothing, and ${
                  isLastAttempt(attempt, maxAttempts)
                    ? 'cannot file it on case ' + waitingToFileOn + ': last attempt; the run will fail'
                    : maxAttempts === undefined || attempt === undefined
                      ? 'will ask again, if retries remain, to file it on case ' + waitingToFileOn
                      : 'will ask again to file it on case ' + waitingToFileOn
                }`
              : 'found another delivery reading it and spent nothing'
            : read.filedFromRecord
              ? 'found it already read, filed that reading on the case and spent nothing'
              : read.alreadyRead
                ? 'found it already read and spent nothing'
                : 'finished the read') +
          `, ${where}, doc type ${read.docType ?? 'none'}, case ${read.deductionId ?? 'none'}, ` +
          `halted ${read.haltedBecause === null ? 'no' : 'yes'}, ` +
          // A hold's reason is one of two constants (ADR 0044), so it may be
          // said; `haltedBecause` stays yes-or-no for the reason above.
          `held ${read.held ?? 'no'}`,
      );
      // Another delivery holds the document, and this one was asked to file it
      // on a case. Saying "spent nothing" and succeeding would leave that case
      // without the document for good: the other delivery was not asked to put
      // it there, and nothing else will. So this step fails and asks the
      // runtime to try it again after the other read has had time to finish;
      // the retry takes the claim and files the recorded reading on the case
      // with no model call (`answerFromRecord`), or — if that read failed —
      // reads it itself, which is what an upload to this case would have done.
      // A delivery with no case to file on keeps the old answer: the read that
      // is running is the one it asked for.
      if (waitingToFileOn !== undefined) {
        throw attachAwaitsRead(read.documentId, waitingToFileOn, event.data);
      }
      return read;
    });
    console.log(`[recouple] read job: run returned, ${where}`);
    return result;
  };
}

/**
 * Whether this is the last attempt Inngest will make, when it said how many it
 * would. The SDK's own final-attempt test, `maxAttempts - 1 === attempt`.
 */
function isLastAttempt(attempt: number | undefined, maxAttempts: number | undefined): boolean {
  return attempt !== undefined && maxAttempts !== undefined && attempt >= maxAttempts - 1;
}

/**
 * The case an event asks its document to be filed on, if it names one.
 *
 * Read through `parseReadRequested`, which the step has already run on the same
 * payload, so a value here is an id and nothing else.
 */
function attachTargetOf(data: unknown): string | undefined {
  return parseReadRequested(data).attachToCase;
}

/**
 * The failure that sends an attachment round again once the read in front of
 * it has had time to finish.
 *
 * Ids only, the way `asJobFailure` builds its message: this is what the
 * runtime's run history shows, which is not a place for anything off the page.
 * The message does not reach the alert email: if every retry finds the
 * document still claimed the run fails, and `alert-on-failure` sends only the
 * function id, the run id and the error's class name (`parseFailure`, ADR
 * 0052), with a link to this run where the message can be read.
 */
function attachAwaitsRead(documentId: string, caseId: string, data: unknown): RetryAfterError {
  const { orgId } = parseReadRequested(data);
  return new RetryAfterError(
    `document ${documentId} for org ${orgId} is being read by another delivery; ` +
      `filing it on case ${caseId} after that read`,
    ATTACH_WAITS_FOR_READ_MS,
  );
}

/**
 * The two ids a log line names, when they are ids.
 *
 * Read off the raw payload rather than out of `parseReadRequested`, so the
 * first line is written before anything can throw — a malformed payload is
 * exactly the case where knowing that a run was entered is worth something. A
 * value that is not a UUID is printed as `unknown` rather than printed: the
 * payload is the one input here this app did not write, and a log line is not a
 * place to repeat somebody else's text.
 */
function whereFor(data: unknown): string {
  const raw = data === null || typeof data !== 'object' ? {} : (data as Record<string, unknown>);
  const documentId = isUuid(raw.documentId) ? raw.documentId : 'unknown';
  const orgId = isUuid(raw.orgId) ? raw.orgId : 'unknown';
  return `document ${documentId} org ${orgId}`;
}

/**
 * Two limits, and the runtime applies both.
 *
 * A tuple rather than a list because that is what the SDK takes: at most two
 * concurrency options per function.
 */
const READ_CONCURRENCY: [ConcurrencyOption, ConcurrencyOption] = [
  // One tenant's bulk upload queues behind itself rather than in front of
  // everybody else.
  { key: 'event.data.orgId', limit: READS_IN_FLIGHT_PER_ORG },
  // And the fleet-wide ceiling, keyless on purpose: a key makes a separate
  // limit per value of that key, which is exactly what this must not be. This
  // is how many reads this app will run at once however many tenants want one.
  { limit: READS_IN_FLIGHT },
];

/**
 * How the runtime is asked to run this function.
 *
 * Exported so a test can read it: these values decide what a delivery costs and
 * how much of this app's money the runtime may spend at once, and none of them
 * shows up in the behaviour of a stubbed `step.run`.
 *
 * **The `idempotency` key is on `event.data.readKey`, not on the document id.**
 * It was on the document id, and what that cost showed up in production: a run
 * was invoked once, the SDK answered with a step plan, the runtime never called
 * back to execute the step, nothing logged an error, and the document stayed
 * unread. The second event — the recovery — named the same document, so that
 * key's own 24-hour window swallowed it, and a stall was unrecoverable for a
 * day.
 *
 * `readKey` says what the document id could not: which *request to read* this
 * is. An upload sets it to the document id, so a redelivery of that upload's
 * own event is still one read. A deliberate re-drive sets a fresh UUID, so it
 * is a different request and the window has nothing to say about it. The thing
 * the old key refused was the recovery; this one cannot refuse it. An upload
 * that attaches to a case sets it to `attachReadKey(document, case)`, so the
 * key names the document and the case it is to be filed on: the same bytes
 * uploaded to a second case while the first read is running are a second
 * request, not a redelivery of the first (2026-09-26).
 *
 * That second request usually runs beside the first — two reads per tenant at
 * once — and finds the document claimed. It does not report that as done: it
 * fails with `RetryAfterError` and waits `ATTACH_WAITS_FOR_READ_MS` for the
 * first read to finish, so `retries` is also how long an attachment will wait.
 *
 * It is a window, not the guarantee. What actually stops a second read costing
 * money is in the database, under the tenant's claims, and holds for every
 * delivery on both paths: `readDocumentJob` runs its guard and the read while
 * holding that document's advisory lock, so a document already read is answered
 * from what was recorded and a document being read right now is answered
 * immediately rather than read alongside
 * (`PostgresStore.withDocumentRead`, `packages/pipeline/test/jobs.test.ts`).
 */
export const READ_DOCUMENT_CONFIG = {
  id: 'read-document',
  name: 'Read an uploaded document',
  triggers: [{ event: READ_REQUESTED }],
  retries: 3 as const,
  idempotency: 'event.data.readKey',
  concurrency: READ_CONCURRENCY,
};

/** The one function this app serves. */
export function readDocumentFunction(client: Inngest, context: JobContext) {
  return client.createFunction(READ_DOCUMENT_CONFIG, readDocumentSteps(context));
}

/**
 * Which failures are worth trying again, and what may be said about them.
 *
 * **Retriable or not.** Nothing is swallowed: every one of these still fails the
 * run. The question is only whether repeating it could answer differently. A
 * malformed payload, an actor who is not a member, a document that is not this
 * tenant's, a case that is not attachable, a verdict that is not clean and a
 * claim that is already a case are all settled facts — and two of them are
 * settled *after* a model call, so retrying them would spend money three more
 * times to be told the same thing. Everything else — a timeout, a 500 from a
 * vendor, a database that blinked — is left retriable, which is the default.
 *
 * `DocumentNotFoundError` is deliberately in the second group. It costs nothing
 * to ask again, and the one benign cause of it is a delivery that arrived before
 * the row it names was visible. Three tries and then a failure somebody can see
 * is the right answer to a document that really is not there.
 *
 * **A row the database refused on its contents is settled too**, and this is
 * the group's most expensive member. A check constraint gives the same answer
 * every time, and the read reaches one only after OCR, classification and
 * extraction have all been paid for: `correspondence` was in `DOC_TYPES` and
 * not in migration 0004's constraint, the failure arrived as a driver error
 * nothing here recognised, and one dispatch-note JPEG was read and billed four
 * times before the run gave up (ADR 0027). Two branches catch it — the typed
 * `ClassificationRefusedError` a store raises for exactly this, and a bare
 * SQLSTATE 23514 from anywhere else on the read, because there is no check
 * constraint on this path whose verdict a retry could change.
 *
 * **What the message says.** The class name and the ids this job already holds,
 * and never the original message. `DuplicateCaseError` interpolates the claim id
 * — which is text off the page — and an extractor's error can quote the page
 * itself; both would otherwise travel to a third party's run history and sit
 * there for its retention period, which is exactly what the event payload is
 * careful not to do (invariant 4). The cause is dropped for the same reason: a
 * serialised cause chain carries the message we just replaced.
 *
 * The original is not lost. It is logged here, in full, where the platform's own
 * logs are — the same place the read's other failures land, and not a third
 * party's.
 */
export function asJobFailure(
  error: unknown,
  ids: { readonly documentId: string; readonly orgId: string },
): unknown {
  const settled =
    error instanceof InvalidJobPayloadError ||
    error instanceof CaseNotFoundError ||
    // A case merged into another refuses every link, now and in thirty seconds
    // (ADR 0042), and a retry would pay for the page again to hear it.
    error instanceof CaseMergedAwayError ||
    error instanceof DuplicateCaseError ||
    error instanceof UnscannedDocumentError ||
    error instanceof ClassificationRefusedError ||
    // A tenant with no readable classification floor (ADR 0044) has none in
    // thirty seconds either. It is raised before anything is spent, so a retry
    // would cost nothing — but it would say nothing new, three more times.
    error instanceof ClassificationFloorError ||
    isCheckConstraintViolation(error);

  const name = error instanceof Error ? error.name : typeof error;
  const caseId =
    error instanceof DuplicateCaseError
      ? error.existingDeductionId
      : error instanceof CaseNotFoundError || error instanceof CaseMergedAwayError
        ? error.deductionId
        : undefined;

  // A doc type is one of twelve constants, not text off the page, so it may be
  // said — and it is the one thing that makes this failure actionable without
  // opening the platform's logs: it names the value the database would not
  // take, which is the value missing from the constraint.
  const refusedType = error instanceof ClassificationRefusedError ? error.docType : undefined;

  const message =
    `${name} reading document ${ids.documentId} for org ${ids.orgId}` +
    (caseId !== undefined ? ` (case ${caseId})` : '') +
    (refusedType !== undefined ? ` (doc type ${refusedType} refused by the database)` : '');

  console.error(`[recouple] read job failed: ${message}`, error);

  return settled ? new NonRetriableError(message) : new Error(message);
}

/**
 * A Postgres CHECK constraint refused the row: SQLSTATE 23514.
 *
 * The net under `ClassificationRefusedError`, for a violation raised somewhere
 * a store has not translated. Retrying it cannot help — a check constraint is a
 * pure function of the row, and the row will be the same one in thirty seconds
 * — and on this path a retry is another OCR, another classification and another
 * extraction (ADR 0027).
 *
 * Read structurally off the driver's error rather than by matching its message,
 * so nothing here depends on the wording of a sentence that quotes the offending
 * row. Duck-typed rather than `instanceof DatabaseError` because this file must
 * not import `pg`: the class it would compare against is the one bundled with
 * whichever copy of the driver the store resolved, and an `instanceof` across
 * two copies is quietly false.
 */
function isCheckConstraintViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '23514';
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
