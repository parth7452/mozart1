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
  CaseNotFoundError,
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
      { documentId, orgId: ORG_ID, userId: USER_ID },
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
      event: { data: { documentId, orgId: ORG_ID, userId: USER_ID } },
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

  it('closes the store even when the read fails', async () => {
    const store = jobStore();
    const { context } = contextOver(store);

    await expect(
      runReadRequested(
        { documentId: '33333333-3333-3333-3333-333333333333', orgId: ORG_ID, userId: USER_ID },
        context,
      ),
    ).rejects.toThrow();
    expect(store.closed).toBe(1);
  });

  it('refuses a payload that does not name a tenant, a document and a member', () => {
    // An id is about to become a tenant claim. A payload missing one must not
    // read as "any tenant", and it must not be retried into existence either.
    expect(() => parseReadRequested({ orgId: ORG_ID, userId: USER_ID })).toThrow(/documentId/);
    expect(() =>
      parseReadRequested({ documentId: ORG_ID, orgId: 'acme', userId: USER_ID }),
    ).toThrow(/orgId/);
    expect(() => parseReadRequested({ documentId: ORG_ID, orgId: ORG_ID })).toThrow(/userId/);
    expect(() => parseReadRequested('a string')).toThrow(/payload/);
    expect(() =>
      parseReadRequested({
        documentId: ORG_ID,
        orgId: ORG_ID,
        userId: USER_ID,
        attachToCase: 'not-a-case',
      }),
    ).toThrow(/attachToCase/);

    expect(
      parseReadRequested({ documentId: ORG_ID, orgId: ORG_ID, userId: USER_ID }),
    ).toEqual({ documentId: ORG_ID, orgId: ORG_ID, userId: USER_ID });
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
        runReadRequested({ documentId, orgId: ORG_ID, userId: stranger }, context),
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
});

describe('how the runtime is asked to run the function', () => {
  it('is these four values, and a change to any of them is a change to cost', () => {
    // None of this shows up in the behaviour of a stubbed `step.run`, and every
    // line of it is the difference between a redelivered event costing nothing
    // and it costing another read.
    expect(READ_DOCUMENT_CONFIG).toEqual({
      id: 'read-document',
      name: 'Read an uploaded document',
      triggers: [{ event: 'document/read.requested' }],
      idempotency: 'event.data.documentId',
      retries: 3,
      concurrency: [
        { key: 'event.data.orgId', limit: 4 },
        // Keyless: the ceiling for the whole app, not one per anything.
        { limit: 16 },
      ],
    });
    expect(READ_DOCUMENT_CONFIG.concurrency[1]).not.toHaveProperty('key');
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
      call({ event: { name: READ_REQUESTED, data: { documentId: ORG_ID, orgId: ORG_ID, userId: USER_ID } }, ctx: {}, steps: {} }),
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
        event: { name: READ_REQUESTED, data: { documentId: ORG_ID, orgId: ORG_ID, userId: USER_ID } },
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
