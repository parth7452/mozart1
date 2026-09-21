import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction, type FixtureDocument } from '@recouple/fixtures';
import type { PipelineDeps, StoredDocument } from '@recouple/pipeline';
import { InngestRunner, type UploadRunner } from '../lib/pipeline';
import { NextRequest } from 'next/server';
import {
  AlwaysCleanScanner,
  AlwaysInfectedScanner,
  InMemoryStore,
} from '@recouple/pipeline/testing';
import type { PostgresStore } from '@recouple/store-postgres';
import { NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

/**
 * What the reviewer is told: the notice key the redirect carried, resolved.
 *
 * A key, never a sentence — the query string is a thing anybody can type, and
 * an app that repeats what it finds there is an app a link can put words into.
 * These went through the URL as prose until this was fixed, including the
 * filename a stranger chose and the claim id printed on their document
 * (`lib/notices.ts`). Resolving here means a key the table does not have fails
 * the assertion rather than passing it with its own name.
 */
function said(response: Response): string | undefined {
  const at = new URL(response.headers.get('location') as string);
  return resolveNotice(
    at.searchParams.get('upload') ?? undefined,
    at.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
}

/**
 * What the upload route does with the failures the pipeline can now hand it.
 *
 * `openCase` refuses a claim that is already a case for that debtor (ADR 0019),
 * and that refusal reaches this handler. It used to fall through the catch and
 * become a 500: a reviewer uploading a scan of a notice they had already sent as
 * a PDF got a server error and no way to tell it apart from a real fault.
 *
 * The readers are stubbed — `pipelineDepsFor` builds the real Claude ones, and a
 * test that calls a model is a test that costs money — but everything below them
 * is the real pipeline: the real store contract, the real `openCase`, the real
 * duplicate error.
 */
function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

const notice = fixtureFor('walmart-apdp-notice.pdf');

const ORG_ID = '11111111-1111-1111-1111-111111111111';

/** The in-memory store plus the one method a request-scoped store owes the route. */
class RouteTestStore extends InMemoryStore {
  closed = 0;
  async close(): Promise<void> {
    this.closed += 1;
  }
  /** And the one a job owes itself: the document it was handed the id of. */
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
}

const harness = vi.hoisted(() => ({
  store: undefined as RouteTestStore | undefined,
  deps: undefined as PipelineDeps | undefined,
  role: 'analyst' as string,
  /** How many times the session was resolved, so ordering can be asserted. */
  sessions: 0,
  /** Left undefined to get the environment's own answer: the inline runner. */
  runner: undefined as UploadRunner | undefined,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: '22222222-2222-2222-2222-222222222222',
      email: 'reviewer@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
      orgs: [],
    };
  },
  storeFor: () => harness.store as unknown as PostgresStore,
}));

/**
 * The real module with two seams: the deps, so no model is called, and the
 * runner, so both of the paths ADR 0021 introduced can be exercised here. The
 * runners themselves are the real `InlineRunner` and `InngestRunner`; which one
 * is used is the test's choice rather than the environment's, so a stray
 * INNGEST_EVENT_KEY in someone's `.env` cannot change what these tests run.
 * Which one an environment *would* choose is asserted in fail-closed.test.tsx.
 */
vi.mock('../lib/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pipeline')>();
  return {
    ...actual,
    mayWrite: (role: string) => role !== 'read_only' && role !== 'accountant_guest',
    pipelineDepsFor: () => harness.deps as PipelineDeps,
    runnerFromEnv: () => harness.runner ?? new actual.InlineRunner(),
  };
});

const { POST } = await import('../app/upload/route');

function stubbedDeps(store: RouteTestStore): PipelineDeps {
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

/** A POST the route can read: one file, no content-length to argue about. */
function uploadRequest(
  bytes: Uint8Array,
  filename: string,
  attachToCase?: string,
  secFetchSite?: string,
): NextRequest {
  const form = new FormData();
  // `as BlobPart`: the same bytes either way — `Uint8Array<ArrayBufferLike>` and
  // the DOM lib's `ArrayBufferView<ArrayBuffer>` disagree on paper, not at run time.
  form.set('file', new File([bytes as BlobPart], filename, { type: 'application/pdf' }));
  if (attachToCase !== undefined) form.set('attachToCase', attachToCase);
  const headers = new Headers();
  if (secFetchSite !== undefined) headers.set('sec-fetch-site', secFetchSite);
  return new NextRequest('https://app.example.test/upload', {
    method: 'POST',
    body: form,
    headers,
  });
}

describe('uploading a notice whose claim is already a case', () => {
  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    harness.runner = undefined;
    harness.store = new RouteTestStore();
    harness.deps = stubbedDeps(harness.store);
  });

  it('sends the reviewer to the case that already holds the claim', async () => {
    const store = harness.store as RouteTestStore;
    // The tenant has said who this retailer is, so the claim resolves a debtor
    // and the unique constraint can see the second case coming.
    store.debtors.push({ debtorId: 'debtor-walmart', names: ['Walmart'] });

    const first = await POST(uploadRequest(notice.bytes, notice.filename));
    expect(first.status).toBe(303);
    const opened = [...store.cases.values()][0];
    expect(first.headers.get('location')).toBe(
      `https://app.example.test/cases/${opened?.deductionId}`,
    );

    // The same notice, scanned: different bytes, so the content hash does not
    // dedupe it and it is read before the store can say the case exists.
    const rescan = new Uint8Array([...notice.bytes, 0x0a]);
    const second = await POST(uploadRequest(rescan, 'walmart-apdp-notice-scan.pdf'));

    // Not a 500, and not a second case either.
    expect(second.status).toBe(303);
    const location = new URL(second.headers.get('location') as string);
    expect(location.pathname).toBe(`/cases/${opened?.deductionId}`);
    expect(location.searchParams.get('upload')).toBe('upload_duplicate_case');
    // The claim id was read off somebody else's page, so it travels as a
    // validated fragment rather than inside a sentence.
    expect(location.searchParams.getAll(NOTICE_ABOUT_PARAM)).toEqual(['APDP-99812']);
    expect(said(second)).toMatch(/claim APDP-99812 is already this case/);
    expect(store.cases.size).toBe(1);

    // And the read that got us here is still on the books: it happened, and it
    // cost money, whether or not it opened anything.
    expect(store.extractions).toHaveLength(2);
    expect(store.totalCostMicros()).toBe(28_000);

    // Both requests closed the store they were handed.
    expect(store.closed).toBe(2);
  });

  it('opens the case and goes to it when the claim is new', async () => {
    const store = harness.store as RouteTestStore;
    const response = await POST(uploadRequest(notice.bytes, notice.filename));
    expect(response.status).toBe(303);
    const opened = [...store.cases.values()][0];
    expect(opened?.claimId).toBe('APDP-99812');
    expect(new URL(response.headers.get('location') as string).pathname).toBe(
      `/cases/${opened?.deductionId}`,
    );
  });

  it('sends a refused attachment back to the case it was being attached to', async () => {
    // The evidence form lives on the case page. A reviewer whose file is
    // refused there must land back on that case — not on the list holding a
    // message telling them to attach it from the case page they just left.
    const caseId = '33333333-3333-3333-3333-333333333333';
    const response = await POST(uploadRequest(new Uint8Array(), 'nothing.pdf', caseId));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') as string);
    expect(location.pathname).toBe(`/cases/${caseId}`);
    expect(said(response)).toBe('choose a file first');
  });

  it('refuses a cross-site POST with a 403, before the session is resolved', async () => {
    // Reading a document costs money and stores bytes. Neither should be
    // reachable from another site's page. `SameSite=Lax` on the session cookie
    // stops it too, but that is a setting in a file this route does not own.
    const store = harness.store as RouteTestStore;
    const response = await POST(uploadRequest(notice.bytes, notice.filename, undefined, 'cross-site'));

    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.sessions).toBe(0);
    expect(store.documents.size).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
  });

  it('lets a same-origin POST through, and one with no such header at all', async () => {
    for (const site of ['same-origin', 'none', undefined]) {
      harness.store = new RouteTestStore();
      harness.deps = stubbedDeps(harness.store);
      const response = await POST(uploadRequest(notice.bytes, notice.filename, undefined, site));
      expect(response.status).toBe(303);
      expect((harness.store as RouteTestStore).cases.size).toBe(1);
    }
  });

  it('refuses a case it cannot resolve instead of opening a second one', async () => {
    // A well-formed case id that is not a case this tenant can see: stale,
    // mistyped, or another tenant's. `getCase` cannot tell those apart, and the
    // pipeline used to read all of them as "no case named" — so a notice
    // attached to a wrong id opened a brand new case and said nothing.
    const store = harness.store as RouteTestStore;
    const stranger = '44444444-4444-4444-4444-444444444444';
    const response = await POST(uploadRequest(notice.bytes, notice.filename, stranger));

    expect(response.status).toBe(303);
    const to = new URL(response.headers.get('location') as string);
    // Back to the list: the case page they came from is not theirs to return to.
    expect(to.pathname).toBe('/');
    expect(said(response)).toMatch(/no longer available; nothing was uploaded/);

    // Nothing read, nothing spent, nothing stored — the refusal is before all
    // of it, and it is not swallowed into a page that looks like it worked.
    expect(store.cases.size).toBe(0);
    expect(store.documents.size).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.totalCostMicros()).toBe(0);
    expect(store.closed).toBe(1);
  });

  it('refuses a reader who may not add documents, before anything is read', async () => {
    harness.role = 'read_only';
    const store = harness.store as RouteTestStore;
    const response = await POST(uploadRequest(notice.bytes, notice.filename));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') as string).pathname).toBe('/');
    expect(store.documents.size).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
  });
});

describe('uploading where the read runs as a job', () => {
  /** Every event the runner sent, in order. */
  let sent: { name: string; data: Record<string, unknown> }[] = [];

  function jobRunner(): UploadRunner {
    sent = [];
    const client = {
      async send(event: { name: string; data: Record<string, unknown> }) {
        sent.push(event);
        return { ids: ['evt_1'] };
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0];
    return new InngestRunner(client);
  }

  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    harness.store = new RouteTestStore();
    harness.deps = stubbedDeps(harness.store);
    harness.runner = jobRunner();
  });

  it('stores the bytes, announces the document by id, and reads nothing', async () => {
    const store = harness.store as RouteTestStore;
    const response = await POST(uploadRequest(notice.bytes, notice.filename));

    // The bytes are in, and scanned. Nothing was read and nothing was spent:
    // that is the job's work now.
    expect(store.documents.size).toBe(1);
    expect(store.scans).toHaveLength(1);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.cases.size).toBe(0);
    expect(store.closed).toBe(1);

    // One event, carrying ids and the member who uploaded it — and no word of
    // what is on the page (invariant 4).
    const documentId = [...store.documents.keys()][0];
    expect(sent).toEqual([
      {
        name: 'document/read.requested',
        data: {
          documentId,
          orgId: ORG_ID,
          userId: '22222222-2222-2222-2222-222222222222',
        },
      },
    ]);
    const payload = JSON.stringify(sent);
    expect(payload).not.toContain('APDP-99812');
    expect(payload).not.toContain('Walmart');

    // And the reviewer is told, rather than sent to a case that does not exist.
    expect(response.status).toBe(303);
    const to = new URL(response.headers.get('location') as string);
    expect(to.pathname).toBe('/');
    expect(said(response)).toMatch(/being read/);
  });

  it('sends no event for a file that did not scan clean', async () => {
    // The gate is the verdict, and it is in front of the queue as well as in
    // front of the reader: an infected file is stored, scanned, and stops.
    const store = harness.store as RouteTestStore;
    harness.deps = { ...stubbedDeps(store), scanner: new AlwaysInfectedScanner() };

    const response = await POST(uploadRequest(notice.bytes, notice.filename));

    expect(sent).toEqual([]);
    expect(store.modelCalls).toHaveLength(0);
    // The gate's own key, so what a reviewer reads is this app's sentence
    // rather than clamd's reply passed through a URL.
    expect(new URL(response.headers.get('location') as string).searchParams.get('upload')).toBe(
      'upload_not_scanned_clean',
    );
    expect(said(response)).toMatch(/did not come back clean from the scanner/);
  });

  it('refuses a case it cannot resolve before storing anything', async () => {
    // Still on the request path, because the reviewer is still standing in
    // front of the case page when they press the button.
    const store = harness.store as RouteTestStore;
    const stranger = '44444444-4444-4444-4444-444444444444';

    const response = await POST(uploadRequest(notice.bytes, notice.filename, stranger));

    expect(store.documents.size).toBe(0);
    expect(sent).toEqual([]);
    const to = new URL(response.headers.get('location') as string);
    expect(to.pathname).toBe('/');
    expect(said(response)).toMatch(/no longer available; nothing was uploaded/);
  });

  it('keeps the document and says so when the queue will not take the event', async () => {
    // Inngest unreachable. The bytes are already stored and scanned by the time
    // `send` fails, so a 500 here would report a failed upload for a document
    // that is safely in the database — and nobody would be expecting it.
    const store = harness.store as RouteTestStore;
    const failure = new Error('connect ECONNREFUSED inngest.example');
    harness.runner = new InngestRunner({
      async send() {
        throw failure;
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0]);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await POST(uploadRequest(notice.bytes, notice.filename));

      expect(response.status).toBe(303);
      expect(said(response)).toMatch(/stored and scanned but could not be queued for reading/);
      // And it points at the list that can recover it, rather than at a second
      // upload. The second upload was the advice until the read function's
      // idempotency key made it a lie: the same event for a document that had
      // stalled was swallowed for twenty-four hours.
      expect(said(response)).toMatch(/Documents waiting to be read/);
      expect(said(response)).not.toMatch(/re-queues it/);

      // The document is in, unread, and the failure went somewhere an operator
      // will see it — with the cause, not just a sentence.
      expect(store.documents.size).toBe(1);
      expect(store.scans).toHaveLength(1);
      expect(store.modelCalls).toHaveLength(0);
      expect(store.cases.size).toBe(0);
      expect(store.closed).toBe(1);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/could not be queued/), failure);
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps a reviewer attaching evidence on the case they were on', async () => {
    const store = harness.store as RouteTestStore;
    const existing = await store.openCase({ orgId: ORG_ID });

    const response = await POST(
      uploadRequest(notice.bytes, notice.filename, existing.deductionId),
    );

    expect(sent[0]?.data.attachToCase).toBe(existing.deductionId);
    const to = new URL(response.headers.get('location') as string);
    expect(to.pathname).toBe(`/cases/${existing.deductionId}`);
    expect(said(response)).toMatch(/being read/);
  });
});
