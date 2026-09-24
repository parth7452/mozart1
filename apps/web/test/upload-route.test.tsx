import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
  processUpload,
  readDocumentJob,
  type JobDeps,
  type PipelineDeps,
  type StoredDocument,
} from '@recouple/pipeline';
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

/** The same digest `ingestDocument` keys a document on: hex of the bytes. */
async function sha256Of(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
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

  it('files an already-read document on a second case without reading it again', async () => {
    // The inline runner, the same question: the notice opened its case, and
    // the same file uploaded from another case's page is filed there from the
    // recorded reading instead of classified and extracted a second time.
    const store = harness.store as RouteTestStore;
    await POST(uploadRequest(notice.bytes, notice.filename));
    const opened = [...store.cases.values()][0];
    const spent = store.totalCostMicros();
    const other = await store.openCase({ orgId: ORG_ID, claimId: 'OTHER-CLAIM' });

    const response = await POST(uploadRequest(notice.bytes, notice.filename, other.deductionId));

    expect(store.totalCostMicros()).toBe(spent);
    expect(store.extractions).toHaveLength(1);
    expect(store.links.filter((l) => l.deductionId === other.deductionId)).toHaveLength(1);
    expect(store.links.filter((l) => l.deductionId === opened?.deductionId)).toHaveLength(1);
    const to = new URL(response.headers.get('location') as string);
    expect(to.pathname).toBe(`/cases/${other.deductionId}`);
    expect(to.searchParams.get('upload')).toBe('upload_filed_from_record');
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
          // The runtime's idempotency key, and for an upload it is the document
          // id: a redelivery of *this* event is one read. A re-drive is a
          // different request and carries a fresh key, so it is never swallowed
          // by this one's window — which is what keying on the document id
          // directly did, for twenty-four hours (ADR 0021).
          readKey: documentId,
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

  it('queues nothing for bytes it has already read, and sends the reviewer to the case', async () => {
    // The same file uploaded twice — the second press of a button, mostly.
    // The inline runner has always answered this from what was recorded
    // (`processUpload`); the queued one used to announce it anyway, so the job
    // asked the same question a minute later and answered it the same way,
    // while the reviewer was told their document was being read and sent to a
    // list rather than to the case it had already opened.
    const store = harness.store as RouteTestStore;
    const first = await processUpload(
      {
        orgId: ORG_ID,
        filename: notice.filename,
        bytes: notice.bytes,
        source: 'web_upload' as const,
        pageText: notice.pageText,
      },
      stubbedDeps(store),
    );
    const deductionId = first.case?.deductionId as string;
    expect(deductionId).toBeDefined();
    const spent = store.modelCalls.length;
    sent.length = 0;

    const response = await POST(uploadRequest(notice.bytes, notice.filename));

    // No event, no second read, no second document.
    expect(sent).toEqual([]);
    expect(store.modelCalls).toHaveLength(spent);
    expect(store.documents.size).toBe(1);
    expect(store.cases.size).toBe(1);
    // And straight to the case, exactly where the inline path would have sent
    // them.
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') as string).pathname).toBe(
      `/cases/${deductionId}`,
    );
    expect(store.closed).toBe(1);
  });

  it('says so, without queueing, when the document was read and opened no case', async () => {
    // A document that was read and got no case — an invoice, say, or an
    // unauthenticated email's notice (ADR 0016). There is nowhere to send the
    // reviewer, so they are told, and still nothing is queued.
    const store = harness.store as RouteTestStore;
    const stored = await store.putDocument({
      orgId: ORG_ID,
      sha256: await sha256Of(notice.bytes),
      filename: notice.filename,
      mimeType: 'application/pdf',
      byteSize: notice.bytes.byteLength,
      bytes: notice.bytes,
      requiresSplit: false,
    });
    await store.recordScan(stored.documentId, { status: 'clean', scanner: 'test' });
    await store.recordExtraction({
      documentId: stored.documentId,
      docType: 'bol',
      extractor: 'stub',
      schemaVersion: 'v1',
      fields: [],
      document: {},
    });

    const response = await POST(uploadRequest(notice.bytes, notice.filename));

    expect(sent).toEqual([]);
    expect(store.modelCalls).toHaveLength(0);
    expect(new URL(response.headers.get('location') as string).pathname).toBe('/');
    expect(said(response)).toMatch(/already been read/);
  });

  it('files bytes it has already read on a second case from the record, and queues nothing', async () => {
    // The same BOL is evidence for two deductions. Uploaded from the second
    // case's page it dedupes to the document already read, so the recorded
    // reading is filed there in this request — no event, no model call —
    // rather than queued to be paid for a second time.
    const store = harness.store as RouteTestStore;
    const stored = await store.putDocument({
      orgId: ORG_ID,
      sha256: await sha256Of(notice.bytes),
      filename: notice.filename,
      mimeType: 'application/pdf',
      byteSize: notice.bytes.byteLength,
      bytes: notice.bytes,
      requiresSplit: false,
    });
    await store.recordScan(stored.documentId, { status: 'clean', scanner: 'test' });
    await store.recordExtraction({
      documentId: stored.documentId,
      docType: 'bol',
      extractor: 'stub',
      schemaVersion: 'v1',
      fields: [],
      document: {},
    });
    const second = await store.openCase({ orgId: ORG_ID });

    const response = await POST(uploadRequest(notice.bytes, notice.filename, second.deductionId));

    expect(sent).toEqual([]);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.links).toEqual([
      { deductionId: second.deductionId, documentId: stored.documentId, role: 'evidence' },
    ]);
    expect(store.events.map((e) => e.eventType)).toEqual(['evidence.attached']);
    const to = new URL(response.headers.get('location') as string);
    expect(to.pathname).toBe(`/cases/${second.deductionId}`);
    expect(to.searchParams.get('upload')).toBe('upload_filed_from_record');
    expect(said(response)).toMatch(/already been read.*attached to this case.*nothing was charged/);
  });

  it('refuses evidence for a case merged into another before storing or queueing anything', async () => {
    // The database refuses a link to a merged-away case (ADR 0042), and on the
    // queued path it would do so inside the job, after the read was paid for.
    const store = harness.store as RouteTestStore;
    const merged = await store.openCase({ orgId: ORG_ID });
    await store.transitionCase(merged.deductionId, 'merged');
    const documentsBefore = store.documents.size;

    const response = await POST(uploadRequest(notice.bytes, notice.filename, merged.deductionId));

    expect(sent).toEqual([]);
    expect(store.documents.size).toBe(documentsBefore);
    expect(new URL(response.headers.get('location') as string).pathname).toBe(
      `/cases/${merged.deductionId}`,
    );
    expect(said(response)).toMatch(/merged into another.*Nothing was stored/);
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

/**
 * Where a remittance sends the reviewer (ADR 0040).
 *
 * A remittance never sets `result.case` — one advice opens a case per
 * short-paid line (ADR 0028) — so before this the route told a reviewer whose
 * upload had just opened LOG-001's case "read as a remittance advice; attach it
 * to a case", and the case they wanted was one click away on a list they had
 * not been sent to. The pipeline half is `packages/pipeline/test/log-001.test.ts`;
 * this is only where the route goes with what the read returned.
 */
describe('uploading a remittance', () => {
  const caseA = '44444444-4444-4444-4444-444444444444';
  const caseB = '55555555-5555-5555-5555-555555555555';

  function readingAs(remittance: { opened: string[]; mergedInto: string[] }): UploadRunner {
    return {
      name: 'inline',
      async run() {
        return {
          kind: 'read',
          result: {
            ingest: { verdict: { status: 'clean', scanner: 'stub' } },
            classification: { docType: 'remittance_advice', confidence: 0.99 },
            remittance: {
              opened: remittance.opened.map((deductionId) => ({ deductionId })),
              mergedInto: remittance.mergedInto,
              lines: [],
            },
          },
        } as never;
      },
      async reread() {
        throw new Error('not used');
      },
    };
  }

  beforeEach(() => {
    harness.role = 'analyst';
    harness.store = new RouteTestStore();
    harness.deps = stubbedDeps(harness.store);
  });

  it('goes to the case when the remittance opened exactly one', async () => {
    harness.runner = readingAs({ opened: [caseA], mergedInto: [] });
    const response = await POST(uploadRequest(notice.bytes, 'remittance.pdf'));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') as string).pathname).toBe(`/cases/${caseA}`);
  });

  it('goes to the case a line merged into, counted once however many lines named it', async () => {
    harness.runner = readingAs({ opened: [], mergedInto: [caseA, caseA] });
    const response = await POST(uploadRequest(notice.bytes, 'remittance.pdf'));
    expect(new URL(response.headers.get('location') as string).pathname).toBe(`/cases/${caseA}`);
  });

  it('goes to the list, told how many, when it opened several', async () => {
    harness.runner = readingAs({ opened: [caseA], mergedInto: [caseB] });
    const response = await POST(uploadRequest(notice.bytes, 'remittance.pdf'));
    const location = new URL(response.headers.get('location') as string);
    expect(location.pathname).toBe('/');
    expect(said(response)).toMatch(/2 short-paid lines opened or joined cases/);
  });

  it('says what it was read as when no line opened anything', async () => {
    harness.runner = readingAs({ opened: [], mergedInto: [] });
    const response = await POST(uploadRequest(notice.bytes, 'remittance.pdf'));
    expect(new URL(response.headers.get('location') as string).pathname).toBe('/');
    expect(said(response)).toMatch(/read as a remittance advice/);
  });
});

describe('uploading a notice the classifier was not sure enough of (ADR 0044)', () => {
  // The stub classifier answers 0.99. Each test here raises this workspace's
  // floor above that, so the notice is read, recorded and held for a person
  // rather than opening a case on its own.
  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    harness.runner = undefined;
    harness.store = new RouteTestStore();
    harness.store.classificationFloorValue = 0.995;
    harness.deps = stubbedDeps(harness.store);
  });

  it('says it is held and where, instead of sending the reviewer to a case', async () => {
    const store = harness.store as RouteTestStore;

    const response = await POST(uploadRequest(notice.bytes, notice.filename));

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') as string).pathname).toBe('/');
    expect(said(response)).toMatch(/reading was doubtful, so no case was opened/);
    expect(said(response)).toMatch(/Read, not on a case/);
    expect(store.cases.size).toBe(0);
    expect(store.auditLog.map((row) => row.action)).toEqual(['document.held']);
    // A key in the URL, never a sentence and never a word off the page.
    const location = response.headers.get('location') as string;
    expect(location).not.toContain('APDP');
    expect(location).not.toContain('doubtful');
  });

  it('says so again for the same file, and reads nothing', async () => {
    const store = harness.store as RouteTestStore;
    await POST(uploadRequest(notice.bytes, notice.filename));
    const spent = store.modelCalls.length;

    const again = await POST(uploadRequest(notice.bytes, notice.filename));

    expect(said(again)).toMatch(/reading was doubtful/);
    expect(store.modelCalls).toHaveLength(spent);
    expect(store.auditLog).toHaveLength(1);
  });

  it('says so without queueing where the read runs as a job and the first read held it', async () => {
    const store = harness.store as RouteTestStore;
    await POST(uploadRequest(notice.bytes, notice.filename));
    const sent: unknown[] = [];
    harness.runner = new InngestRunner({
      async send(event: unknown) {
        sent.push(event);
        return { ids: ['evt_1'] };
      },
    } as unknown as ConstructorParameters<typeof InngestRunner>[0]);

    const response = await POST(uploadRequest(notice.bytes, notice.filename));

    expect(sent).toEqual([]);
    expect(new URL(response.headers.get('location') as string).pathname).toBe('/');
    expect(said(response)).toMatch(/reading was doubtful/);
    expect(store.cases.size).toBe(0);
  });
});

describe('uploading the same file as a notice that arrived by email (ADR 0047 §7)', () => {
  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    harness.runner = undefined;
    harness.store = new RouteTestStore();
    harness.deps = stubbedDeps(harness.store);
  });

  it('answers from the email’s hold: no second read, no case, and says why', async () => {
    const store = harness.store as RouteTestStore;
    store.addMember(ORG_ID, '22222222-2222-2222-2222-222222222222', 'owner');
    const deps = harness.deps as unknown as JobDeps;
    const emailed = await ingestForJob(deps, {
      orgId: ORG_ID,
      filename: notice.filename,
      bytes: notice.bytes,
      source: 'email_in',
      pageText: notice.pageText,
    });
    const read = await readDocumentJob(deps, {
      documentId: emailed.documentId,
      orgId: ORG_ID,
      actor: { userId: '22222222-2222-2222-2222-222222222222' },
    });
    expect(read.held).toBe('by_email');
    const spent = store.modelCalls.length;

    const response = await POST(uploadRequest(notice.bytes, notice.filename));

    expect(new URL(response.headers.get('location') as string).pathname).toBe('/');
    expect(said(response)).toMatch(/already arrived by email, and no email opens a case on its own/);
    expect(store.modelCalls).toHaveLength(spent);
    expect(store.cases.size).toBe(0);
  });
});
