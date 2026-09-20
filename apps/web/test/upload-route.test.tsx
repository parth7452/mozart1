import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction, type FixtureDocument } from '@recouple/fixtures';
import type { PipelineDeps } from '@recouple/pipeline';
import { NextRequest } from 'next/server';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import type { PostgresStore } from '@recouple/store-postgres';

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
}

const harness = vi.hoisted(() => ({
  store: undefined as RouteTestStore | undefined,
  deps: undefined as PipelineDeps | undefined,
  role: 'analyst' as string,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: '22222222-2222-2222-2222-222222222222',
    email: 'reviewer@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
  storeFor: () => harness.store as unknown as PostgresStore,
}));

vi.mock('../lib/pipeline', () => ({
  mayWrite: (role: string) => role !== 'read_only' && role !== 'accountant_guest',
  pipelineDepsFor: () => harness.deps as PipelineDeps,
}));

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
function uploadRequest(bytes: Uint8Array, filename: string): NextRequest {
  const form = new FormData();
  // `as BlobPart`: the same bytes either way — `Uint8Array<ArrayBufferLike>` and
  // the DOM lib's `ArrayBufferView<ArrayBuffer>` disagree on paper, not at run time.
  form.set('file', new File([bytes as BlobPart], filename, { type: 'application/pdf' }));
  return new NextRequest('https://app.example.test/upload', { method: 'POST', body: form });
}

describe('uploading a notice whose claim is already a case', () => {
  beforeEach(() => {
    harness.role = 'analyst';
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
    expect(location.searchParams.get('upload')).toMatch(/APDP-99812 is already this case/);
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
