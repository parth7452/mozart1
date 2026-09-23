import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction, type FixtureDocument } from '@recouple/fixtures';
import {
  CaseMergedAwayError,
  CaseNotFoundError,
  ClassificationRefusedError,
  DocumentNotFoundError,
  DuplicateCaseError,
  InvalidJobPayloadError,
  ingestForJob,
  type JobDeps,
  type StoredDocument,
} from '@recouple/pipeline';
import { UnscannedDocumentError } from '@recouple/ingest';
import { NonRetriableError } from 'inngest';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import {
  INNGEST_PLAN_CONCURRENCY_LIMIT,
  READS_IN_FLIGHT,
  READS_IN_FLIGHT_PER_ORG,
  READ_DOCUMENT_CONFIG,
  READ_REQUESTED,
  asJobFailure,
  parseReadRequested,
  readDocumentSteps,
  runReadRequested,
  type JobContext,
  type JobStoreHandle,
} from '../lib/inngest';
import { storeForActor } from '../lib/pipeline';

/**
 * The Inngest side of the upload: the function that runs the read, and the
 * endpoint Inngest calls to run it (ADR 0021).
 *
 * Two questions, and they are the two that would matter if this were wrong.
 * Does the job read as the member the event names — through RLS, as `app_rw`,
 * never as the service role (invariant 6)? And does the endpoint refuse a
 * request that Inngest did not sign, given that it fronts a function which
 * takes a tenant id from its payload?
 */

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

const notice = fixtureFor('walmart-apdp-notice.pdf');

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

/** The in-memory store, plus the two methods a job's store owes the job. */
class JobStoreForTest extends InMemoryStore implements JobStoreHandle {
  closed = 0;
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

/**
 * A store with the member the events below name already in it. A job checks
 * that membership before it reads anything, so a store without one refuses
 * every job — which the refusal test at the bottom asserts on purpose.
 */
function jobStore(): JobStoreForTest {
  const store = new JobStoreForTest();
  store.addMember(ORG_ID, USER_ID, 'analyst');
  return store;
}

function depsFor(store: JobStoreForTest): JobDeps {
  return {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier: {
      async classify(document: DocumentPayload): Promise<ClassificationResult> {
        return {
          docType: 'deduction_notice',
          confidence: 0.99,
          call: {
            purpose: 'classify',
            provider: 'anthropic',
            modelVersion: 'stub',
            documentId: document.documentId,
            costMicros: 1_300,
            latencyMs: 1,
            outcome: 'ok',
          },
        };
      },
    },
    extractor: {
      name: 'stub',
      async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
        return buildExtractionResult({
          docType,
          extractor: 'stub',
          document: expectedExtraction(notice),
          pageText: document.pageText,
          call: {
            purpose: 'extract',
            provider: 'anthropic',
            modelVersion: 'stub',
            documentId: document.documentId,
            costMicros: 12_700,
            latencyMs: 1,
            outcome: 'ok',
          },
        });
      },
    },
    now: () => new Date(0),
  };
}

/**
 * A context that records the identity it was asked to build a store for, and
 * hands back an in-memory one — so what the payload turns into is visible.
 */
function contextOver(store: JobStoreForTest): {
  context: JobContext;
  identities: { orgId: string; userId: string }[];
} {
  const identities: { orgId: string; userId: string }[] = [];
  return {
    identities,
    context: {
      storeFor: (identity) => {
        identities.push({ ...identity });
        return store;
      },
      depsFor: () => depsFor(store),
    },
  };
}

async function storedNotice(store: JobStoreForTest): Promise<string> {
  const ingested = await ingestForJob(depsFor(store), {
    orgId: ORG_ID,
    filename: notice.filename,
    bytes: notice.bytes,
    source: 'web_upload' as const,
    pageText: notice.pageText,
  });
  return ingested.documentId;
}

describe('the read job', () => {
  it('builds its store from the identity in the event, and closes it', async () => {
    const store = jobStore();
    const documentId = await storedNotice(store);
    const { context, identities } = contextOver(store);

    const result = await runReadRequested(
      { documentId, orgId: ORG_ID, userId: USER_ID, readKey: documentId },
      context,
    );

    // The tenant and the member come from the payload and nowhere else. That is
    // what makes the job's reads the same reads a request would make.
    expect(identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(store.closed).toBe(1);

    expect(result.documentId).toBe(documentId);
    expect(result.docType).toBe('deduction_notice');
    expect(result.deductionId).toBe([...store.cases.keys()][0]);
    expect([...store.cases.values()][0]?.claimId).toBe('APDP-99812');
  });

  it('runs through the step the runtime hands it', async () => {
    // The handler's whole body is one step, so a stubbed `step.run` is enough
    // to invoke exactly what Inngest invokes.
    const store = jobStore();
    const documentId = await storedNotice(store);
    const { context } = contextOver(store);
    const steps: string[] = [];

    const result = await readDocumentSteps(context)({
      event: { data: { documentId, orgId: ORG_ID, userId: USER_ID, readKey: documentId } },
      step: {
        run: async (id, work) => {
          steps.push(id);
          return work();
        },
      },
    });

    expect(steps).toEqual(['read-document']);
    expect(result.deductionId).toBe([...store.cases.keys()][0]);
  });

  it('logs both the run and the step, so a stall between them is visible', async () => {
    // The production failure this is for: invoked once, answered with a step
    // plan, and then never called back to run the step. Nothing threw, nothing
    // was logged, and the document stayed unread while the reviewer was told it
    // was being read. A run line with no step line under it is that, and it can
    // be seen now.
    const store = jobStore();
    const documentId = await storedNotice(store);
    const { context } = contextOver(store);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    try {
      await readDocumentSteps(context)({
        event: { data: { documentId, orgId: ORG_ID, userId: USER_ID, readKey: documentId } },
        step: { run: async (_id, work) => work() },
      });

      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('run entered');
      expect(lines[1]).toContain('step read-document entered');
      expect(lines[2]).toContain('finished the read');
      expect(lines[3]).toContain('run returned');
      // Every line names the two ids an operator would search on.
      for (const line of lines) {
        expect(line).toContain(`document ${documentId}`);
        expect(line).toContain(`org ${ORG_ID}`);
      }
      // And not one word of the document: not the filename somebody else chose,
      // not the claim id printed on the page (invariant 4).
      const all = lines.join('\n');
      expect(all).not.toContain(notice.filename);
      expect(all).not.toContain('APDP-99812');

      // The step memoised — a retry of a run whose step already ran — logs the
      // run and not the step, which is the opposite shape and also readable.
      lines.length = 0;
      await readDocumentSteps(context)({
        event: { data: { documentId, orgId: ORG_ID, userId: USER_ID, readKey: documentId } },
        step: {
          run: async () => ({
            documentId,
            docType: 'deduction_notice',
            deductionId: null,
            haltedBecause: null,
            alreadyRead: true,
            beingRead: false,
            remittanceCases: [],
            // Required since ADR 0044; no hold on this document.
            held: null,
          }),
        },
      });
      expect(lines.map((line) => line.includes('step read-document'))).toEqual([false, false]);
    } finally {
      log.mockRestore();
    }
  });

  it('says a held read’s reason in its step line, and nothing off the page (ADR 0044)', async () => {
    // The stub answers 0.99; a floor above that holds the notice for a person.
    const store = jobStore();
    store.classificationFloorValue = 0.995;
    const documentId = await storedNotice(store);
    const { context } = contextOver(store);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    try {
      const result = await readDocumentSteps(context)({
        event: { data: { documentId, orgId: ORG_ID, userId: USER_ID, readKey: documentId } },
        step: { run: async (_id, work) => work() },
      });

      expect(result).toMatchObject({
        held: 'below_floor',
        haltedBecause: 'held_for_review',
        deductionId: null,
        alreadyRead: false,
      });
      const step = lines.find((line) => line.includes('finished the read'));
      expect(step).toContain('held below_floor');
      expect(step).toContain('halted yes');
      const all = lines.join('\n');
      expect(all).not.toContain(notice.filename);
      expect(all).not.toContain('APDP-99812');
      expect(store.cases.size).toBe(0);
    } finally {
      log.mockRestore();
      info.mockRestore();
    }
  });

  it('names a malformed payload’s ids as unknown rather than repeating them', async () => {
    // The first line is written before the payload is parsed, on purpose: a
    // malformed event is exactly when knowing a run was entered is worth
    // something. What is not an id is not printed — the payload is the one
    // input here this app did not write.
    const store = jobStore();
    const { context } = contextOver(store);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        readDocumentSteps(context)({
          event: { data: { documentId: '<script>alert(1)</script>', orgId: ORG_ID } },
          step: { run: async (_id, work) => work() },
        }),
      ).rejects.toThrow();

      expect(lines[0]).toBe(
        `[recouple] read job: run entered, document unknown org ${ORG_ID}`,
      );
      expect(lines.join('\n')).not.toContain('script');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('closes the store even when the read fails', async () => {
    const store = jobStore();
    const { context } = contextOver(store);

    await expect(
      runReadRequested(
        {
          documentId: '33333333-3333-3333-3333-333333333333',
          orgId: ORG_ID,
          userId: USER_ID,
          readKey: '33333333-3333-3333-3333-333333333333',
        },
        context,
      ),
    ).rejects.toThrow();
    expect(store.closed).toBe(1);
  });

  it('refuses a payload that does not name a tenant, a document and a member', () => {
    // An id is about to become a tenant claim. A payload missing one must not
    // read as "any tenant", and it must not be retried into existence either.
    const whole = { documentId: ORG_ID, orgId: ORG_ID, userId: USER_ID, readKey: USER_ID };
    expect(() => parseReadRequested({ ...whole, documentId: undefined })).toThrow(/documentId/);
    expect(() => parseReadRequested({ ...whole, orgId: 'acme' })).toThrow(/orgId/);
    expect(() => parseReadRequested({ ...whole, userId: undefined })).toThrow(/userId/);
    expect(() => parseReadRequested('a string')).toThrow(/payload/);
    expect(() => parseReadRequested({ ...whole, attachToCase: 'not-a-case' })).toThrow(
      /attachToCase/,
    );

    // The runtime's idempotency window is keyed on `readKey`, so an event with
    // none is an event this app did not send — and letting it through would be
    // letting it through silently, in the one place where a second delivery is
    // a second document's worth of model calls.
    expect(() => parseReadRequested({ ...whole, readKey: undefined })).toThrow(/readKey/);
    expect(() => parseReadRequested({ ...whole, readKey: 'not-a-key' })).toThrow(/readKey/);

    // `allowCaseOpen` decides whether a read may open a case (ADR 0016). A
    // truthy string is not a yes.
    expect(() => parseReadRequested({ ...whole, allowCaseOpen: 'true' })).toThrow(
      /allowCaseOpen/,
    );

    expect(parseReadRequested(whole)).toEqual(whole);
    expect(parseReadRequested({ ...whole, allowCaseOpen: false })).toEqual({
      ...whole,
      allowCaseOpen: false,
    });
  });

  it('refuses an event naming somebody who is not a member of that org', async () => {
    // A signed event says Inngest sent it, not that the user in it belongs to
    // the org in it — and `tenant_read` checks only the org claim. So a payload
    // pairing a victim's org with any user id would otherwise be read and paid
    // for. Refused, and not retried: a membership does not appear on a retry.
    const store = jobStore();
    const documentId = await storedNotice(store);
    const { context } = contextOver(store);
    const stranger = '44444444-4444-4444-4444-444444444444';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        runReadRequested({ documentId, orgId: ORG_ID, userId: stranger, readKey: documentId }, context),
      ).rejects.toBeInstanceOf(NonRetriableError);
    } finally {
      logged.mockRestore();
    }

    expect(store.modelCalls).toEqual([]);
    expect(store.extractions).toEqual([]);
    expect(store.cases.size).toBe(0);
    expect(store.closed).toBe(1);
  });
});

describe('what a failed read says to Inngest', () => {
  const ids = { documentId: ORG_ID, orgId: ORG_ID };
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it('says the class and the ids, and never what the document said', () => {
    // `DuplicateCaseError` interpolates the claim id, which is text off the
    // page. The run history it would land in belongs to a third party and keeps
    // it for its retention period — the same thing the event payload is careful
    // not to do (invariant 4).
    const duplicate = new DuplicateCaseError(
      'claim APDP-99812 is already open for this debtor as case ' +
        '55555555-5555-5555-5555-555555555555',
      '55555555-5555-5555-5555-555555555555',
      'APDP-99812',
    );

    const wrapped = asJobFailure(duplicate, ids) as Error;

    expect(wrapped.message).not.toContain('APDP-99812');
    expect(wrapped.message).toContain('DuplicateCaseError');
    expect(wrapped.message).toContain(ids.documentId);
    expect(wrapped.message).toContain('55555555-5555-5555-5555-555555555555');
    // And the message it replaced is not smuggled along as a cause either.
    expect((wrapped as { cause?: unknown }).cause).toBeUndefined();

    // Not swallowed: the original, in full, goes to the platform's own log.
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/read job failed/), duplicate);
  });

  it('marks the settled failures non-retriable and leaves the rest alone', () => {
    // Retrying any of these would spend money three more times to be told the
    // same thing — two of them are only settled *after* a model call.
    const settled = [
      new DuplicateCaseError('claim X is already case Y', ORG_ID, 'X'),
      new CaseNotFoundError(ORG_ID),
      // A link to a case merged into another is refused every time (ADR 0042).
      new CaseMergedAwayError(ORG_ID, 'deduction_documents'),
      new UnscannedDocumentError('no clean verdict for this document'),
      new InvalidJobPayloadError('a read job needs documentId; this one has none'),
    ];
    for (const error of settled) {
      expect(asJobFailure(error, ids)).toBeInstanceOf(NonRetriableError);
    }

    // And the one that is worth asking again: the benign cause is a delivery
    // that arrived before the row it names was visible.
    const notFound = asJobFailure(new DocumentNotFoundError(ORG_ID), ids);
    expect(notFound).toBeInstanceOf(Error);
    expect(notFound).not.toBeInstanceOf(NonRetriableError);
    expect((notFound as Error).message).toContain('DocumentNotFoundError');
  });

  it('does not retry a row the database refused on its contents', () => {
    // The expensive member of that group, and the one this was found on: the
    // refusal arrives *after* OCR, classification and extraction have all been
    // paid for, so each retry is another three model calls to be told the same
    // thing. A check constraint is a pure function of the row (ADR 0027).
    const refused = new ClassificationRefusedError(
      '77777777-7777-7777-7777-777777777777',
      'correspondence',
    );
    const wrapped = asJobFailure(refused, ids);
    expect(wrapped).toBeInstanceOf(NonRetriableError);
    // It names the value the database would not take, which is the whole
    // diagnosis: a doc type is one of twelve constants, not text off the page.
    expect((wrapped as Error).message).toContain('ClassificationRefusedError');
    expect((wrapped as Error).message).toContain('correspondence');
  });

  it('does not retry a bare check-constraint violation either', () => {
    // The net under the typed error, for a 23514 raised somewhere no store has
    // translated. Read structurally off the driver's error — `code` — rather
    // than by matching a message that quotes the offending row.
    const driverError = Object.assign(
      new Error(
        'new row for relation "document_classifications" violates check constraint ' +
          '"document_classifications_doc_type_check"',
      ),
      {
        code: '23514',
        // What a driver actually attaches, and every bit of it is off the page.
        detail: 'Failing row contains (…, dispatch-note.jpg, correspondence, …).',
      },
    );

    const wrapped = asJobFailure(driverError, ids);
    expect(wrapped).toBeInstanceOf(NonRetriableError);

    // And the driver's own message goes nowhere near the queue: the run history
    // belongs to a third party and keeps what it is given (invariant 4).
    const message = (wrapped as Error).message;
    expect(message).not.toContain('Failing row contains');
    expect(message).not.toContain('dispatch-note.jpg');
    expect(message).not.toContain('violates check constraint');
    expect(message).toContain(ids.documentId);
    expect((wrapped as { cause?: unknown }).cause).toBeUndefined();

    // Not swallowed. The original, in full, is on the local log.
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/read job failed/), driverError);

    // A code that is not 23514 is not this: a unique violation on a read is a
    // redelivery that raced, and asking again is the right answer to it.
    const unique = asJobFailure(Object.assign(new Error('duplicate key'), { code: '23505' }), ids);
    expect(unique).not.toBeInstanceOf(NonRetriableError);
  });
});

describe('how the runtime is asked to run the function', () => {
  it('is these values, and a change to any of them is a change to cost', () => {
    // None of this shows up in the behaviour of a stubbed `step.run`, and every
    // line of it is the difference between a redelivered event costing nothing
    // and it costing another read.
    expect(READ_DOCUMENT_CONFIG).toEqual({
      id: 'read-document',
      name: 'Read an uploaded document',
      triggers: [{ event: 'document/read.requested' }],
      retries: 3,
      idempotency: 'event.data.readKey',
      concurrency: [
        { key: 'event.data.orgId', limit: 2 },
        // Keyless: the ceiling for the whole app, not one per anything.
        { limit: 5 },
      ],
    });
    expect(READ_DOCUMENT_CONFIG.concurrency[1]).not.toHaveProperty('key');
    // The keyless ceiling is the one the Inngest plan caps: a limit above the
    // plan's 5 is refused at sync time and nothing deploys at all. The per-org
    // limit stays under it so a second tenant can still make progress while one
    // tenant's bulk upload is in flight.
    expect(READS_IN_FLIGHT).toBeLessThanOrEqual(INNGEST_PLAN_CONCURRENCY_LIMIT);
    expect(READS_IN_FLIGHT_PER_ORG).toBeLessThan(READS_IN_FLIGHT);
  });

  it('keys its idempotency window on the request, not on the document', () => {
    // It used to be `event.data.documentId`. A run that was invoked and then
    // never came back to execute its step left the document unread, and that
    // key swallowed the next 24 hours of events naming it — including the one
    // sent to recover it. `readKey` says which *request to read* an event is:
    // an upload sets it to the document id, so its own redelivery is one read,
    // and a re-drive sets a fresh UUID, so the window has nothing to say about
    // it. The key is a window and not the guarantee — the guarantee is the
    // per-document lock `readDocumentJob` holds across its guard and its read.
    expect(READ_DOCUMENT_CONFIG.idempotency).toBe('event.data.readKey');
    expect(READ_DOCUMENT_CONFIG.idempotency).not.toContain('documentId');
  });
});

describe('the store a job reads through', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is app_rw with the event’s claims, and reads no service-role key', () => {
    // `process.env` is replaced by a proxy that records every lookup, so this
    // asserts on what the code reads rather than on what it says in a comment.
    const read: string[] = [];
    const environment: Record<string, string | undefined> = {
      ...saved,
      DATABASE_URL: 'postgres://app@127.0.0.1:5432/recouple',
    };
    process.env = new Proxy(environment, {
      get(target, key) {
        if (typeof key === 'string') read.push(key);
        return target[key as string];
      },
    }) as NodeJS.ProcessEnv;

    const store = storeForActor({ orgId: ORG_ID, userId: USER_ID });

    // The claims the store will set, transaction-locally, on every query.
    expect((store as unknown as { tenant: unknown }).tenant).toEqual({
      orgId: ORG_ID,
      userId: USER_ID,
    });
    expect(read).toContain('DATABASE_URL');
    expect(read.filter((key) => /SERVICE_ROLE/i.test(key))).toEqual([]);
  });
});

describe('the endpoint Inngest calls', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env = { ...saved };
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  async function freshRoute(): Promise<typeof import('../app/api/inngest/route')> {
    vi.resetModules();
    return import('../app/api/inngest/route');
  }

  function call(body: unknown): NextRequest {
    return new NextRequest('https://app.example.test/api/inngest?fnId=recouple-read-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('refuses a POST that Inngest did not sign', async () => {
    process.env.INNGEST_EVENT_KEY = 'test-event-key';
    process.env.INNGEST_SIGNING_KEY =
      'signkey-test-0000000000000000000000000000000000000000000000000000000000000000';
    delete process.env.INNGEST_DEV;

    const { POST } = await freshRoute();
    const response = await POST(
      call({ event: { name: READ_REQUESTED, data: { documentId: ORG_ID, orgId: ORG_ID, userId: USER_ID, readKey: ORG_ID } }, ctx: {}, steps: {} }),
      undefined,
    );

    // The signature is this endpoint's whole authentication: it fronts a
    // function that takes a tenant id from the body it is given.
    expect(response.status).toBe(401);
  });

  it('serves nothing at all where the read runs inline', async () => {
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_SIGNING_KEY;

    const { POST, GET } = await freshRoute();
    expect((await POST(call({}), undefined)).status).toBe(503);
    expect(
      (
        await GET(new NextRequest('https://app.example.test/api/inngest'), undefined)
      ).status,
    ).toBe(503);
  });

  it('refuses to serve a half-configured binding rather than guessing', async () => {
    process.env.INNGEST_EVENT_KEY = 'test-event-key';
    delete process.env.INNGEST_SIGNING_KEY;

    const { POST } = await freshRoute();
    await expect(POST(call({}), undefined)).rejects.toThrow(/INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY/);
  });

  it('serves nothing in a production build with INNGEST_DEV set', async () => {
    // Dev mode does not verify Inngest's signature, and that signature is this
    // endpoint's only authentication. Keys and all, it must not serve: anybody
    // who could reach the URL could hand the function a payload naming any org
    // and any member.
    process.env.INNGEST_EVENT_KEY = 'test-event-key';
    process.env.INNGEST_SIGNING_KEY =
      'signkey-test-0000000000000000000000000000000000000000000000000000000000000000';
    process.env.INNGEST_DEV = '1';
    // Replaced wholesale: `NODE_ENV` is a read-only property on the typed
    // environment, and what this test is about is the pair of them.
    process.env = { ...process.env, NODE_ENV: 'production' };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { POST, GET, PUT } = await freshRoute();
      const signed = call({
        event: { name: READ_REQUESTED, data: { documentId: ORG_ID, orgId: ORG_ID, userId: USER_ID, readKey: ORG_ID } },
        ctx: {},
        steps: {},
      });

      for (const response of [
        await POST(signed, undefined),
        await GET(new NextRequest('https://app.example.test/api/inngest'), undefined),
        await PUT(new NextRequest('https://app.example.test/api/inngest', { method: 'PUT' }), undefined),
      ]) {
        expect(response.status).toBe(503);
        expect(await response.text()).toMatch(/INNGEST_DEV is set in a production build/);
      }

      // And it says so where an operator reads logs: Inngest sees a failed sync,
      // not an explanation.
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(/refuses to serve: INNGEST_DEV is set/),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('serves normally in development with INNGEST_DEV set', async () => {
    // The same variable on a laptop is what it is for. Only the pairing with a
    // production build is refused.
    process.env.INNGEST_EVENT_KEY = 'test-event-key';
    process.env.INNGEST_SIGNING_KEY =
      'signkey-test-0000000000000000000000000000000000000000000000000000000000000000';
    process.env.INNGEST_DEV = '1';
    process.env = { ...process.env, NODE_ENV: 'development' };

    const { GET } = await freshRoute();
    const response = await GET(new NextRequest('https://app.example.test/api/inngest'), undefined);
    expect(response.status).not.toBe(503);
  });
});
