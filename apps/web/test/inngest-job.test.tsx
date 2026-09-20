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
  ingestForJob,
  type JobDeps,
  type StoredDocument,
} from '@recouple/pipeline';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import {
  READ_REQUESTED,
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
    const store = new JobStoreForTest();
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
    const store = new JobStoreForTest();
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
    const store = new JobStoreForTest();
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
});
