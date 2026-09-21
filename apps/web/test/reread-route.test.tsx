import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction, type FixtureDocument } from '@recouple/fixtures';
import { ingestForJob, type JobDeps, type StoredDocument } from '@recouple/pipeline';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import type { PostgresStore } from '@recouple/store-postgres';
import { InngestRunner, InlineRunner, type UploadRunner } from '../lib/pipeline';
import { NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

/**
 * Asking for a document that was never read to be read.
 *
 * The failure this recovers from left no trace: the upload was stored, scanned
 * clean and announced to the queue, the read function was invoked once and
 * never came back to run its step, nothing logged an error, and the document
 * sat there while the reviewer was told it was being read. Re-uploading the
 * same file was the advice and it did not work — the function's idempotency key
 * swallowed the second event for a day.
 *
 * So this route matters in the same way the decline route does: it is the only
 * way out of a state the product can otherwise get stuck in, and every refusal
 * on the way has to be something a reviewer can read rather than a 500.
 *
 * The readers are stubbed — `pipelineDepsFor` builds the real Claude ones, and
 * a test that calls a model is a test that costs money — but both runners are
 * the real ones, so what the inline path does and what the queued path sends
 * are both exercised here.
 */

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

const notice = fixtureFor('walmart-apdp-notice.pdf');

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

/** The in-memory store plus the two methods a job's store owes a job. */
class RouteTestStore extends InMemoryStore {
  closed = 0;
  async close(): Promise<void> {
    this.closed += 1;
  }
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
}

const harness = vi.hoisted(() => ({
  store: undefined as RouteTestStore | undefined,
  deps: undefined as JobDeps | undefined,
  role: 'analyst' as string,
  /** How many times the session was resolved, so ordering can be asserted. */
  sessions: 0,
  runner: undefined as UploadRunner | undefined,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: USER_ID,
      email: 'reviewer@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
      orgs: [],
    };
  },
  storeFor: () => harness.store as unknown as PostgresStore,
}));

vi.mock('../lib/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pipeline')>();
  return {
    ...actual,
    mayWrite: (role: string) => role !== 'read_only' && role !== 'accountant_guest',
    pipelineDepsFor: () => harness.deps as JobDeps,
    runnerFromEnv: () => harness.runner ?? new actual.InlineRunner(),
  };
});

const { POST } = await import('../app/documents/[id]/reread/route');

function stubbedDeps(store: RouteTestStore): JobDeps {
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

/** A document stored and scanned clean, and not read: the state this is for. */
async function storedNotice(store: RouteTestStore): Promise<string> {
  const ingested = await ingestForJob(stubbedDeps(store), {
    orgId: ORG_ID,
    filename: notice.filename,
    bytes: notice.bytes,
    source: 'web_upload' as const,
    pageText: notice.pageText,
  });
  return ingested.documentId;
}

function rereadRequest(documentId: string, secFetchSite?: string): NextRequest {
  const headers = new Headers();
  if (secFetchSite !== undefined) headers.set('sec-fetch-site', secFetchSite);
  return new NextRequest(`https://app.example.test/documents/${documentId}/reread`, {
    method: 'POST',
    headers,
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') as string);
}

/** What the reviewer is told: the notice key the redirect carried, resolved. */
function said(response: Response): string | undefined {
  const at = location(response);
  return resolveNotice(
    at.searchParams.get('reread') ?? undefined,
    at.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
}

describe('asking for a stored document to be read again', () => {
  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    const store = new RouteTestStore();
    store.addMember(ORG_ID, USER_ID, 'analyst');
    harness.store = store;
    harness.deps = stubbedDeps(store);
    harness.runner = new InlineRunner();
  });

  it('reads it here and now when there is no queue, and says a case opened', async () => {
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);

    const response = await POST(rereadRequest(documentId), params(documentId));

    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe('/');
    expect(said(response)).toMatch(/has been read/);
    expect(store.cases.size).toBe(1);
    expect(store.modelCalls).toHaveLength(2);
    expect(store.closed).toBe(1);
  });

  it('is safe to press twice: the second time spends nothing', async () => {
    // The guard that replaced the runtime's idempotency key. A document that
    // already has an extraction is answered from what was recorded — no model
    // call, no second case, no second row of anything.
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);

    await POST(rereadRequest(documentId), params(documentId));
    const spent = store.modelCalls.length;
    const cases = store.cases.size;

    const again = await POST(rereadRequest(documentId), params(documentId));

    expect(said(again)).toMatch(/had already been read/);
    expect(store.modelCalls).toHaveLength(spent);
    expect(store.cases.size).toBe(cases);
  });

  it('sends one event and reads nothing where the read runs as a job', async () => {
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    const sent: { name: string; data: Record<string, unknown> }[] = [];
    harness.runner = new InngestRunner({
      async send(event: { name: string; data: Record<string, unknown> }) {
        sent.push(event);
        return { ids: ['evt_1'] };
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0]);

    const response = await POST(rereadRequest(documentId), params(documentId));

    expect(said(response)).toMatch(/queued to be read again/);
    // Ids and the member asking, and not one word of the document (invariant 4).
    expect(sent).toEqual([
      {
        name: 'document/read.requested',
        data: {
          documentId,
          orgId: ORG_ID,
          userId: USER_ID,
          readKey: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
          // This document has never been read, so the read this asks for is the
          // one the upload would have done — case and all.
          allowCaseOpen: true,
        },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain(notice.filename);
    // Nothing was read in the request: that is the job's half.
    expect(store.modelCalls).toHaveLength(0);
    expect(store.cases.size).toBe(0);
  });

  it('tells a second press that the first one is still running, and reads nothing', async () => {
    // Two presses in a row, the second before the first has finished — an
    // impatient reviewer, or two tabs. The second does not get the document's
    // claim, so it does not read it alongside the first: four model calls, two
    // extractions and two cases is what that used to cost.
    //
    // And it is told what is actually true. "Already read" would be a small lie
    // while the first read is still running, in the one place a reviewer is
    // watching for the case to appear.
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);

    let openTheGate = (): void => undefined;
    const firstIsInside = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    const deps = stubbedDeps(store);
    let classifyCalls = 0;
    harness.deps = {
      ...deps,
      classifier: {
        async classify(document: DocumentPayload): Promise<ClassificationResult> {
          classifyCalls += 1;
          if (classifyCalls === 1) await firstIsInside;
          return deps.classifier.classify(document);
        },
      },
    };

    const first = POST(rereadRequest(documentId), params(documentId));
    await new Promise((resolve) => setImmediate(resolve));
    const second = await POST(rereadRequest(documentId), params(documentId));

    expect(location(second).searchParams.get('reread')).toBe('reread_being_read');
    expect(said(second)).toMatch(/already being read right now/);

    openTheGate();
    expect(said(await first)).toMatch(/has been read/);

    expect(classifyCalls).toBe(1);
    expect(store.modelCalls).toHaveLength(2);
    expect(store.extractions).toHaveLength(1);
    expect(store.cases.size).toBe(1);
  });

  it('carries a fresh key every press, so the runtime cannot swallow the second', async () => {
    // The whole reason `readKey` is a field rather than `event.data.documentId`.
    // The production stall was a run invoked and never executed; the recovery
    // was a second event naming the same document; the runtime's idempotency
    // window swallowed it for twenty-four hours. A re-drive is a different
    // request and says so.
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    const sent: { name: string; data: Record<string, unknown> }[] = [];
    harness.runner = new InngestRunner({
      async send(event: { name: string; data: Record<string, unknown> }) {
        sent.push(event);
        return { ids: ['evt_1'] };
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0]);

    await POST(rereadRequest(documentId), params(documentId));
    await POST(rereadRequest(documentId), params(documentId));
    await POST(rereadRequest(documentId), params(documentId));

    const keys = sent.map((event) => event.data.readKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    // And never the document id, which is the key that could not be recovered
    // from.
    expect(keys).not.toContain(documentId);
  });

  it('will not open a case for a document that was read and left without one', async () => {
    // ADR 0016: a notice that arrived on an email whose sender could not be
    // authenticated is read and deliberately left caseless. A button on our own
    // case list must not be how a forged `From:` finally gets its case — so a
    // re-drive of a document that has already been read may not open one, and
    // is answered from what was recorded instead.
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    await store.recordExtraction({
      documentId,
      docType: 'deduction_notice',
      extractor: 'stub',
      schemaVersion: 'v1',
      fields: [],
      document: {},
    });
    expect(store.cases.size).toBe(0);

    const response = await POST(rereadRequest(documentId), params(documentId));

    expect(said(response)).toMatch(/had already been read/);
    expect(store.cases.size).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.extractions).toHaveLength(1);
  });

  it('sends allowCaseOpen false to the job for that same document', async () => {
    // The queued half of the rule above. Inline it is an argument to
    // `readDocumentJob`; queued it has to travel in the event, or the job a
    // minute later would default to yes and open the case this refused.
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    await store.recordExtraction({
      documentId,
      docType: 'deduction_notice',
      extractor: 'stub',
      schemaVersion: 'v1',
      fields: [],
      document: {},
    });
    const sent: { name: string; data: Record<string, unknown> }[] = [];
    harness.runner = new InngestRunner({
      async send(event: { name: string; data: Record<string, unknown> }) {
        sent.push(event);
        return { ids: ['evt_1'] };
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0]);

    await POST(rereadRequest(documentId), params(documentId));

    expect(sent[0]?.data.allowCaseOpen).toBe(false);
  });

  it('says the claim is already a case, rather than failing, when the store refuses one', async () => {
    // The notice arrived twice — as a PDF and then as a scan, which are
    // different bytes and so are not deduplicated by hash. The second read
    // happens and the store refuses the second case (ADR 0019). Not a fault:
    // the document and everything read from it are stored.
    const store = harness.store as RouteTestStore;
    store.debtors.push({ debtorId: 'debtor-walmart', names: ['Walmart'] });

    // The first copy, read, with the case it opened.
    const first = await storedNotice(store);
    await POST(rereadRequest(first), params(first));
    expect(store.cases.size).toBe(1);

    // The same claim on different bytes.
    const rescanned = await ingestForJob(stubbedDeps(store), {
      orgId: ORG_ID,
      filename: notice.filename,
      bytes: new Uint8Array([...notice.bytes, 0x0a]),
      source: 'web_upload' as const,
      pageText: notice.pageText,
    });
    expect(rescanned.documentId).not.toBe(first);

    const response = await POST(rereadRequest(rescanned.documentId), params(rescanned.documentId));

    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe('/');
    expect(location(response).searchParams.get('reread')).toBe('reread_duplicate_case');
    expect(said(response)).toMatch(/already a case/);
    // Deliberately wordless about which claim: that is text off somebody else's
    // page, and this notice arrives at a list with nothing to do with it.
    expect(said(response)).not.toContain('APDP-99812');
    // One case, and the second document's read is recorded rather than lost.
    expect(store.cases.size).toBe(1);
    expect(store.extractions).toHaveLength(2);
    // Closed on the refusal too — once per press, and there were two.
    expect(store.closed).toBe(2);
  });

  it('asks the store for one bit, not for the document’s bytes', async () => {
    // Deciding between "go on" and "404" used to fetch every byte of the
    // document out of object storage and throw all of it away — megabytes on a
    // scanned notice, on every press.
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    const fetched: string[] = [];
    const visible: string[] = [];
    store.getDocument = async (id: string) => {
      fetched.push(id);
      return store.documents.get(id);
    };
    const realVisible = store.documentIsVisible.bind(store);
    store.documentIsVisible = async (id: string) => {
      visible.push(id);
      return realVisible(id);
    };
    harness.runner = new InngestRunner({
      async send() {
        return { ids: ['evt_1'] };
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0]);

    await POST(rereadRequest(documentId), params(documentId));

    expect(visible).toEqual([documentId]);
    // The queued path never reads the document at all, so nothing fetched it.
    expect(fetched).toEqual([]);
  });

  it('says so, rather than 500ing, when the queue will not take the event', async () => {
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    const failure = new Error('connect ECONNREFUSED inngest.example');
    harness.runner = new InngestRunner({
      async send() {
        throw failure;
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0]);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await POST(rereadRequest(documentId), params(documentId));
      expect(response.status).toBe(303);
      expect(said(response)).toMatch(/could not be queued just now/);
      // Nothing is swallowed: the cause is where an operator reads logs.
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(/could not be queued for re-reading/),
        failure,
      );
      expect(store.closed).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('refuses a cross-site POST with a 403, before the session is resolved', async () => {
    // This handler spends money. A cross-site request must not even cause a
    // session lookup, let alone a model call.
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);

    const response = await POST(rereadRequest(documentId, 'cross-site'), params(documentId));

    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.sessions).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
  });

  it('refuses a POST from another subdomain too, and accepts a real navigation', async () => {
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);

    expect((await POST(rereadRequest(documentId, 'same-site'), params(documentId))).status).toBe(
      403,
    );
    expect(harness.sessions).toBe(0);

    for (const site of ['same-origin', 'none', undefined]) {
      const response = await POST(rereadRequest(documentId, site), params(documentId));
      expect(response.status, String(site)).toBe(303);
    }
  });

  it('sends an id that is not a UUID back to the list, not to Postgres', async () => {
    // Thirty-six characters of hex and dashes is not a UUID, and one that is
    // not reaches Postgres as a 22P02 and comes back as a 500.
    const store = harness.store as RouteTestStore;
    for (const id of ['------------------------------------', 'not-a-uuid', `${ORG_ID}x`]) {
      const response = await POST(rereadRequest(id), params(id));
      expect(response.status).toBe(303);
      expect(location(response).pathname).toBe('/');
      expect(location(response).searchParams.get('reread')).toBeNull();
    }
    expect(store.modelCalls).toHaveLength(0);
  });

  it('tells a reader why, before anything is read', async () => {
    harness.role = 'read_only';
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);

    const response = await POST(rereadRequest(documentId), params(documentId));

    expect(response.status).toBe(303);
    expect(said(response)).toBe('your role can review documents but not ask for one to be read');
    expect(store.modelCalls).toHaveLength(0);
  });

  it('asks the database too, not only the session’s idea of the role', async () => {
    // Where there is a queue the job runs elsewhere and minutes later, so this
    // is what stops the button queueing work for somebody who may not write
    // rather than finding out after the event has gone.
    const store = new RouteTestStore(); // no membership at all
    harness.store = store;
    harness.deps = stubbedDeps(store);
    const documentId = await storedNotice(store);

    const response = await POST(rereadRequest(documentId), params(documentId));

    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/not ask for one to be read/);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.closed).toBe(1);
  });

  it('answers 404 for a document this tenant cannot see', async () => {
    // RLS decides, and it decides by the document not being there. A stale
    // button, a mistyped id and another tenant's document are one answer, and
    // it says nothing about which.
    const store = harness.store as RouteTestStore;
    await storedNotice(store);

    const stranger = '99999999-9999-9999-9999-999999999999';
    const response = await POST(rereadRequest(stranger), params(stranger));

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(store.modelCalls).toHaveLength(0);
    expect(store.closed).toBe(1);
  });

  it('says the gate stopped it when the verdict is no longer clean', async () => {
    // Between the list being drawn and the button being pressed. Nothing is
    // read, and the reviewer is told rather than shown a 500 (invariant 4).
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    await store.recordScan(documentId, { status: 'infected', scanner: 'test' });

    const response = await POST(rereadRequest(documentId), params(documentId));

    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/no clean scan verdict/);
    expect(store.modelCalls).toHaveLength(0);
  });

  it('turns a fault into a sentence and a log line, never a silent success', async () => {
    const store = harness.store as RouteTestStore;
    const documentId = await storedNotice(store);
    const boom = new Error('anthropic: 503');
    const deps = stubbedDeps(store);
    harness.deps = {
      ...deps,
      classifier: {
        async classify(): Promise<ClassificationResult> {
          throw boom;
        },
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await POST(rereadRequest(documentId), params(documentId));
      expect(response.status).toBe(303);
      expect(said(response)).toMatch(/failed, and the reason is in this deployment’s logs/);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/reread: reading document/), boom);
      // Nothing was recorded as read.
      expect(store.extractions).toHaveLength(0);
      expect(store.cases.size).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });
});
