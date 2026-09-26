import { randomUUID } from 'node:crypto';
import { ClaudeClassifier, ClaudeExtractor, ReductoOcr } from '@recouple/extraction';
import { scannerFromEnv } from '@recouple/ingest';
import {
  answerFromRecord,
  assertCaseAttachable,
  ingestForJob,
  processUpload,
  readDocumentJob,
  type CaseRecord,
  type DocumentHold,
  type IngestInput,
  type JobDeps,
  type PipelineDeps,
  type ProcessedDocument,
  type ReadDocumentJobResult,
} from '@recouple/pipeline';
import type { PostgresStore } from '@recouple/store-postgres';
import { tenantStore } from './store';
import {
  attachReadKey,
  inngestClient,
  inngestKeysFromEnv,
  readRequestedEvent,
  type ReadRequestedData,
} from './inngest';

/**
 * The real pipeline, assembled from configuration.
 *
 * Two of these are deliberately fail-closed rather than fail-soft:
 *
 * - **No scanner configured means `NullScanner`**, which reports an error and
 *   not a clean bill of health. The gate then refuses to read the file. An
 *   environment with no ClamAV cannot ingest, which is the correct answer to
 *   "should we read an unscanned file from a stranger" (invariant 4).
 * - **No Reducto key means no OCR provider at all**, rather than one that
 *   throws on use. A document with a text layer is unaffected; a scan comes back
 *   with its quotes unverifiable and says so, which is a worse answer than
 *   OCR and a much better one than a silent guess (ADR 0009).
 *
 * Which scanner an environment gets is `scannerFromEnv`'s decision, not this
 * file's — a hosted `HttpScanner` when `CLAMAV_SCAN_URL` is set, clamd over TCP
 * when `CLAMAV_HOST` is, `NullScanner` otherwise. Deciding it twice is how the
 * two answers drift (ADR 0018).
 *
 * The store's own type is carried through rather than narrowed to the port, so
 * a caller handing in a store that can do more keeps it — a job needs
 * `getDocument` to read a document it only has the id of (ADR 0021), plus the
 * two questions `JobStore` adds, and `PostgresStore` answers all three.
 */
export function pipelineDepsFor<S extends PipelineDeps['store']>(
  store: S,
): PipelineDeps & { readonly store: S } {
  const scanner = scannerFromEnv();

  const ocr =
    process.env.REDUCTO_API_KEY === undefined || process.env.REDUCTO_API_KEY === ''
      ? undefined
      : new ReductoOcr();

  return {
    store,
    scanner,
    classifier: new ClaudeClassifier(),
    extractor: new ClaudeExtractor(),
    ...(ocr !== undefined ? { ocr } : {}),
    now: () => new Date(),
  };
}

/**
 * A store for a job, scoped to the tenant and member an event named.
 *
 * The same two claims `storeFor` sets for a request (lib/session.ts), set the
 * same way and by the same class: `PostgresStore` as `app_rw`,
 * transaction-locally. A job is not a privileged context — it sees what that
 * member sees, because RLS is what decides, and the service-role key appears
 * nowhere in this app (invariant 6).
 */
export function storeForActor(identity: {
  readonly orgId: string;
  readonly userId: string;
}): PostgresStore {
  return tenantStore(identity);
}

/**
 * What an upload did, in the shapes an upload can now end in (ADR 0021).
 *
 * `read` is the whole pipeline, finished: a case to go to, or a reason it did
 * not get one. `queued` is the bytes stored and scanned clean with the read
 * handed to a job — there is no case id yet, and there will not be one for a
 * minute, so the reviewer is told that rather than sent somewhere that does not
 * exist. `not_queued` is that same document with the queue unreachable: stored,
 * scanned, and waiting for somebody to ask for it again.
 */
export type UploadOutcome =
  | { readonly kind: 'read'; readonly result: ProcessedDocument }
  | { readonly kind: 'queued'; readonly documentId: string }
  | { readonly kind: 'not_queued'; readonly documentId: string }
  | { readonly kind: 'halted'; readonly haltedBecause: string }
  /**
   * These bytes are a document this tenant already has, and it has already been
   * read. Nothing was queued and nothing will be: the case is the one the first
   * read opened, when it opened one.
   *
   * The inline runner says this inside `ProcessedDocument`; the queued one has
   * to say it as its own shape, because it never built a `ProcessedDocument` —
   * it stopped before the read. Both leave the handler with the same two
   * answers: a case to go to, or "already read" and no case.
   */
  | {
      readonly kind: 'already_read';
      readonly documentId: string;
      readonly case?: CaseRecord;
      /**
       * The first read held it for a person (ADR 0044) — the classifier was
       * below the floor, or the reading did not fit — so there is no case, on
       * purpose, and the reviewer is told where it is waiting.
       */
      readonly held?: DocumentHold;
      /**
       * It was uploaded to a case that did not hold it, and the recorded
       * reading was filed there in this request — a link and an
       * `evidence.attached` event, no model call (`answerFromRecord`). `case`
       * is that case.
       */
      readonly filedFromRecord?: true;
    };

/**
 * What asking for a stored document to be read again amounted to.
 *
 * The same three shapes an upload can end in, minus the ones that are about
 * bytes: nothing is accepted, stored or scanned here. The document is already
 * in the database and already has a clean verdict — what is being asked for is
 * the read, and the answer is either that it ran, that it is queued, or that
 * the queue would not take it.
 */
export type RereadOutcome =
  | { readonly kind: 'read'; readonly result: ReadDocumentJobResult }
  | { readonly kind: 'queued' }
  | { readonly kind: 'not_queued' };

export interface UploadRunner {
  readonly name: 'inline' | 'inngest';
  /**
   * Asks for a document that is already stored and scanned to be read.
   *
   * The recovery path for a read that was queued and never ran (ADR 0021). It
   * is the same read either way — `readDocumentJob` here, `readDocumentJob` in
   * the function there — so a re-drive cannot become a second, more permissive
   * way into the pipeline. Pressing it again while the first press is still
   * running does not read the document twice: the two are serialised by that
   * document's lock in the database, and the second is answered rather than
   * run. Pressing it after the first has finished is answered from what was
   * recorded.
   *
   * `JobDeps` rather than `PipelineDeps`, because the inline half genuinely
   * runs the job: it reads from a document id, which is the one thing a request
   * path does not otherwise need to do.
   */
  reread(
    documentId: string,
    deps: JobDeps,
    options: {
      readonly orgId: string;
      readonly actor: { readonly userId: string };
      /**
       * Whether this re-drive may open a case for a notice that has none.
       *
       * The caller decides, because the caller is the one that knows what this
       * document is (`app/documents/[id]/reread/route.ts`). Both runners pass
       * it on unchanged — the inline one to `readDocumentJob`, the queued one
       * into the event — so a re-drive means the same thing wherever it runs.
       */
      readonly allowCaseOpen?: boolean;
    },
  ): Promise<RereadOutcome>;
  run(
    input: IngestInput,
    // `PipelineDeps`, not `JobDeps`: neither runner reads from a document id.
    // The inline one runs `processUpload` and the queued one runs the ingest
    // half and stops, so the request never needs the store a job needs — and
    // the request path cannot accidentally acquire a job's reach.
    deps: PipelineDeps,
    options: {
      readonly actor: { readonly userId: string };
      readonly attachToCase?: string;
    },
  ): Promise<UploadOutcome>;
}

/**
 * The whole pipeline, inside the request. What this app did before ADR 0021 and
 * what it still does wherever Inngest is not configured.
 */
export class InlineRunner implements UploadRunner {
  readonly name = 'inline';

  async run(
    input: IngestInput,
    deps: PipelineDeps,
    options: { attachToCase?: string },
  ): Promise<UploadOutcome> {
    const result = await processUpload(
      input,
      deps,
      options.attachToCase !== undefined ? { attachToCase: options.attachToCase } : {},
    );
    return { kind: 'read', result };
  }

  /**
   * Runs the read here and now, and answers with what it found.
   *
   * No queue to fail, so there is no `not_queued` from this one. A refusal —
   * the gate, a duplicate claim, a document that is not this tenant's — is
   * thrown, because it is the caller who is standing in front of the person
   * waiting for an answer.
   */
  async reread(
    documentId: string,
    deps: JobDeps,
    options: { orgId: string; actor: { userId: string }; allowCaseOpen?: boolean },
  ): Promise<RereadOutcome> {
    const result = await readDocumentJob(deps, {
      documentId,
      orgId: options.orgId,
      actor: options.actor,
      ...(options.allowCaseOpen !== undefined ? { allowCaseOpen: options.allowCaseOpen } : {}),
    });
    return { kind: 'read', result };
  }
}

/**
 * Ingest in the request, read in a job.
 *
 * The order is the point. The case to attach to is resolved first, so a
 * reviewer who named one that is not theirs finds out while they are still
 * looking at it. Then the bytes are hardened, stored and scanned — and a file
 * that did not scan clean stops here, with no event sent, because the gate is
 * the verdict and nothing downstream of it may run (invariant 4). Only a
 * document that got through is announced, by id.
 */
export class InngestRunner implements UploadRunner {
  readonly name = 'inngest';
  private readonly client: ReturnType<typeof inngestClient>;

  constructor(client: ReturnType<typeof inngestClient>) {
    this.client = client;
  }

  async run(
    input: IngestInput,
    deps: PipelineDeps,
    options: { actor: { userId: string }; attachToCase?: string },
  ): Promise<UploadOutcome> {
    await assertCaseAttachable(deps, options.attachToCase);

    const ingested = await ingestForJob(deps, input);
    if (ingested.haltedBecause !== undefined) {
      return { kind: 'halted', haltedBecause: ingested.haltedBecause };
    }

    // The same bytes we already hold, and only then can a read already have
    // happened. The inline runner asks this before it reads (`processUpload`);
    // this one has to ask it before it *queues*, or the job asks it a minute
    // later and the reviewer — who is standing here now, holding a file we have
    // already read and filed — is told their document is being read and sent
    // back to a list instead of to its case.
    //
    // It is also the second press of the same button, which is the ordinary
    // way this happens. Nothing is spent either way: this is a query against
    // `extraction_results`, and no event goes out at all. The same bytes
    // uploaded to a case that does not hold them yet are filed there from the
    // recorded reading, here and now — one transaction, no model call — rather
    // than queued to be read a second time (`answerFromRecord`).
    if (ingested.deduplicated) {
      const already = await answerFromRecord(
        { documentId: ingested.documentId },
        deps,
        options.attachToCase !== undefined ? { attachToCase: options.attachToCase } : {},
      );
      if (already !== undefined) {
        const existing =
          already.filedOn ??
          (already.deductionId === undefined
            ? undefined
            : await deps.store.getCase(already.deductionId));
        return {
          kind: 'already_read',
          documentId: ingested.documentId,
          ...(existing !== undefined ? { case: existing } : {}),
          ...(already.held !== undefined ? { held: already.held } : {}),
          ...(already.filedOn !== undefined ? { filedFromRecord: true as const } : {}),
        };
      }
    }

    const data: ReadRequestedData = {
      documentId: ingested.documentId,
      orgId: ingested.orgId,
      userId: options.actor.userId,
      // The document id, so that two deliveries of *this* upload's event are
      // one read. A re-drive is a different request and carries its own key
      // (`reread`), so it is never swallowed by this one's window.
      //
      // An upload that files on a case keys on the case too. The same bytes
      // uploaded to a second case while the first upload's read is still
      // running reach here with nothing recorded, and keyed on the document
      // alone this event was the first one's as far as the window could tell:
      // dropped, while the reviewer was told it was being read for this case.
      // The job then waits for that read rather than giving up on it
      // (`readDocumentSteps`).
      readKey:
        options.attachToCase !== undefined
          ? attachReadKey(ingested.documentId, options.attachToCase)
          : ingested.documentId,
      ...(options.attachToCase !== undefined ? { attachToCase: options.attachToCase } : {}),
    };

    try {
      await this.client.send(readRequestedEvent(data));
    } catch (cause) {
      // Inngest is unreachable, or refused the event. The bytes are already
      // stored and scanned, so throwing here would hand the reviewer a 500 for
      // a document that is safely in the database — the worst of both: it looks
      // like nothing happened, and the document sits there with nobody
      // expecting it.
      //
      // Nothing is swallowed. The failure is logged with its cause where an
      // operator reads logs, and the reviewer is told the document is stored
      // and not yet read. Re-uploading the same file re-queues it: the bytes
      // dedupe to this same document row (`ingestDocument`) and a fresh event
      // is sent, and because no read was ever recorded for it the job does the
      // read rather than reporting one (`recordedRead`).
      console.error(
        `[recouple] uploads: document ${ingested.documentId} is stored and scanned but ` +
          'could not be queued for reading — the Inngest event was not accepted (ADR 0021)',
        cause,
      );
      return { kind: 'not_queued', documentId: ingested.documentId };
    }

    return { kind: 'queued', documentId: ingested.documentId };
  }

  /**
   * Sends the same `document/read.requested` the upload would have sent.
   *
   * The same event, with the actor taken from the session asking for it rather
   * than from the one who uploaded it — a re-drive is a thing somebody did, and
   * the job checks that they may write in this org before it spends anything.
   * `attachToCase` is deliberately absent: a document that was never read has
   * no case it was going to be attached to, and inventing one here would make a
   * button that files evidence somewhere nobody asked for.
   *
   * The event carries ids and nothing else, exactly as the upload's does
   * (invariant 4). `deps` is unused: no bytes are read here.
   */
  async reread(
    documentId: string,
    _deps: JobDeps,
    options: { orgId: string; actor: { userId: string }; allowCaseOpen?: boolean },
  ): Promise<RereadOutcome> {
    const data: ReadRequestedData = {
      documentId,
      orgId: options.orgId,
      userId: options.actor.userId,
      // A fresh key every press, and that is the point of the field existing.
      // The runtime's idempotency window is keyed on it, so a re-drive is never
      // the same request as the upload that stalled — which is exactly what the
      // old `event.data.documentId` key made it, for twenty-four hours (ADR
      // 0021).
      readKey: randomUUID(),
      ...(options.allowCaseOpen !== undefined ? { allowCaseOpen: options.allowCaseOpen } : {}),
    };

    try {
      await this.client.send(readRequestedEvent(data));
    } catch (cause) {
      // Same reasoning as an upload's failed send, minus the document being new:
      // nothing is lost, nothing is corrupt, and a 500 would say the opposite.
      // Logged in full here, where an operator reads logs.
      console.error(
        `[recouple] reread: document ${documentId} could not be queued for re-reading — ` +
          'the Inngest event was not accepted (ADR 0021)',
        cause,
      );
      return { kind: 'not_queued' };
    }

    return { kind: 'queued' };
  }
}

/**
 * Which of the two an environment runs, decided in one place.
 *
 * `scannerFromEnv`'s shape, for `scannerFromEnv`'s reason (ADR 0018): a
 * decision made twice is a decision that drifts. Both keys gives the job runner;
 * neither gives the inline runner, which is today's behaviour and is safe rather
 * than convenient; one without the other throws out of `inngestKeysFromEnv`,
 * because a half-configured binding is a deployment somebody left half-finished.
 */
export function runnerFromEnv(): UploadRunner {
  const keys = inngestKeysFromEnv();
  const runner =
    keys === undefined ? new InlineRunner() : new InngestRunner(inngestClient(keys));
  announce(runner.name);
  return runner;
}

/**
 * Says which runner this process is using, once.
 *
 * Once per answer, not once per call: the environment does not change under a
 * running process, so this logs at startup and then never again — while a test
 * that changes the environment still gets told what it changed to.
 */
let announced: string | undefined;
function announce(name: UploadRunner['name']): void {
  if (announced === name) return;
  announced = name;
  console.info(
    name === 'inngest'
      ? '[recouple] uploads: bytes are stored and scanned in the request, and the read runs as an Inngest job (ADR 0021)'
      : '[recouple] uploads: the whole read runs inside the request — no INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY here (ADR 0021)',
  );
}

/** Roles that may add a document. `read_only` and `accountant_guest` may not. */
const WRITERS = new Set(['owner', 'approver', 'analyst']);

export function mayWrite(role: string): boolean {
  return WRITERS.has(role);
}
