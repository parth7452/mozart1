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
import {
  CaseMergedAwayError,
  DuplicateCaseError,
  processUpload,
  type PipelineDeps,
} from '@recouple/pipeline';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import type { PostgresStore } from '@recouple/store-postgres';
import { NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

/**
 * Opening a case from a document a read held for a person (ADR 0044).
 *
 * The route behind "Open a case from it" on a held notice or remittance. What
 * matters here is what matters on every route that writes — nothing happens
 * for a cross-site request or a member who may not write, and every refusal is
 * a sentence rather than a 500 — plus the two things this one promises: it
 * reads nothing, and the case it opens says who confirmed the doubted reading.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

const notice = fixtureFor('walmart-apdp-notice.pdf');

class RouteTestStore extends InMemoryStore {
  closed = 0;
  async close(): Promise<void> {
    this.closed += 1;
  }
}

const harness = vi.hoisted(() => ({
  store: undefined as RouteTestStore | undefined,
  role: 'analyst' as string,
  sessions: 0,
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
  };
});

const { POST } = await import('../app/documents/[id]/open-case/route');

/**
 * Deps whose classifier reads the notice at `confidence`, and whose extractor
 * returns `document` as the reading. Counted, so a test can say the route read
 * nothing.
 */
function readerDeps(
  store: RouteTestStore,
  confidence: number,
  reading: { document: unknown; validated?: boolean } = { document: expectedExtraction(notice) },
): PipelineDeps & { calls: { classify: number; extract: number } } {
  const calls = { classify: 0, extract: 0 };
  return {
    calls,
    store,
    scanner: new AlwaysCleanScanner(),
    classifier: {
      async classify(document: DocumentPayload): Promise<ClassificationResult> {
        calls.classify += 1;
        return {
          docType: 'deduction_notice',
          confidence,
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
        calls.extract += 1;
        return buildExtractionResult({
          docType,
          extractor: 'stub',
          document: reading.document,
          pageText: document.pageText,
          ...(reading.validated !== undefined ? { validated: reading.validated } : {}),
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

/** A notice uploaded, read at `confidence` and — below the 0.95 floor — held. */
async function heldNotice(
  store: RouteTestStore,
  confidence = 0.9,
  reading?: { document: unknown; validated?: boolean },
) {
  const deps = readerDeps(store, confidence, reading);
  const read = await processUpload(
    {
      orgId: ORG_ID,
      filename: notice.filename,
      bytes: notice.bytes,
      source: 'web_upload',
      uploadedBy: USER_ID,
      pageText: notice.pageText,
    },
    deps,
  );
  return { documentId: read.ingest.document.documentId, held: read.held, calls: deps.calls };
}

function press(
  documentId: string,
  headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
): Promise<Response> {
  return POST(
    new NextRequest(`https://app.example.test/documents/${documentId}/open-case`, {
      method: 'POST',
      headers,
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') ?? 'https://x.test/');
}

/** The notice a redirect carries, resolved the way the page resolves it. */
function said(response: Response): string | undefined {
  const at = location(response);
  return resolveNotice(at.searchParams.get('action'), at.searchParams.getAll(NOTICE_ABOUT_PARAM))
    ?.text;
}

describe('opening a case from a held document', () => {
  beforeEach(() => {
    harness.store = new RouteTestStore();
    harness.store.addMember(ORG_ID, USER_ID, 'analyst');
    harness.role = 'analyst';
    harness.sessions = 0;
  });

  it('opens the case from the recorded reading and sends the reviewer to it, reading nothing', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId, held, calls } = await heldNotice(store);
    expect(held?.reason).toBe('below_floor');
    const spent = store.modelCalls.length;

    const response = await press(documentId);

    expect(response.status).toBe(303);
    const [caseId] = [...store.cases.keys()];
    expect(location(response).pathname).toBe(`/cases/${caseId}`);
    expect(said(response)).toMatch(/opened from the held reading/);
    expect(said(response)).toMatch(/Nothing was read again/);
    expect(store.cases.size).toBe(1);
    expect(store.modelCalls).toHaveLength(spent);
    expect(calls).toEqual({ classify: 1, extract: 1 });
    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload).toMatchObject({
      held: { confidence: 0.9, floor: 0.95, reason: 'below_floor' },
      confirmed_by: USER_ID,
    });
    expect(store.auditLog.map((row) => [row.action, row.actorId])).toEqual([
      ['document.held', undefined],
      ['document.hold_released', USER_ID],
    ]);
    expect(store.closed).toBe(1);
    // Keys in the URL, never a sentence or a word off the page.
    expect(response.headers.get('location')).not.toContain('APDP');
  });

  it('sends a second press to the case the first one opened, and opens nothing more', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId } = await heldNotice(store);
    await press(documentId);
    const [caseId] = [...store.cases.keys()];

    const again = await press(documentId);

    expect(location(again).pathname).toBe(`/cases/${caseId}`);
    expect(said(again)).toMatch(/already on this case/);
    expect(store.cases.size).toBe(1);
  });

  it('refuses a cross-site request before looking up the session', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId } = await heldNotice(store);

    const response = await press(documentId, { 'sec-fetch-site': 'cross-site' });

    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
    expect(store.cases.size).toBe(0);
  });

  it('refuses a member who may not write, in the app and in the database', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId } = await heldNotice(store);

    harness.role = 'read_only';
    expect(said(await press(documentId))).toMatch(/not open a case from one/);

    // The role the session carried says writer; the database no longer does.
    harness.role = 'analyst';
    store.memberships.splice(0, store.memberships.length);
    expect(said(await press(documentId))).toMatch(/not open a case from one/);

    expect(store.cases.size).toBe(0);
  });

  it('refuses a document that is not held, and changes nothing', async () => {
    const store = harness.store as RouteTestStore;
    // Read at 0.99: over the floor, so it opened its own case and holds nothing.
    const { documentId } = await heldNotice(store, 0.99);
    const [caseId] = [...store.cases.keys()];
    expect(caseId).toBeDefined();

    // On a case already, which is the first thing asked.
    const onCase = await press(documentId);
    expect(location(onCase).pathname).toBe(`/cases/${caseId}`);

    // And a read document on no case with no hold is refused by name.
    const evidence = await store.putDocument({
      orgId: ORG_ID,
      sha256: 'c'.repeat(64),
      filename: 'receipt.pdf',
      mimeType: 'application/pdf',
      byteSize: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
      requiresSplit: false,
    });
    await store.recordClassification(evidence.documentId, 'pod', 0.97);
    await store.recordExtraction({
      documentId: evidence.documentId,
      docType: 'pod',
      extractor: 'test',
      schemaVersion: 'v1',
      fields: [],
      document: {},
    });
    const response = await press(evidence.documentId);
    expect(said(response)).toMatch(/not held for review/);
    expect(store.cases.size).toBe(1);
  });

  it('opens a case from a notice whose reading does not fit, with the missing field empty', async () => {
    // A real notice one field short: held as a misfit, and a person may still
    // open its case — the way it would have opened on its own before ADR 0044.
    const store = harness.store as RouteTestStore;
    const reading = {
      ...(expectedExtraction(notice) as Record<string, unknown>),
      deduction_date: { value: null, confidence: 0, source_page: 1, source_quote: '' },
    };
    const { documentId, held } = await heldNotice(store, 0.99, { document: reading, validated: false });
    expect(held).toMatchObject({ reason: 'type_did_not_fit', fields: ['deduction_date'] });

    const response = await press(documentId);

    const [caseId] = [...store.cases.keys()];
    expect(location(response).pathname).toBe(`/cases/${caseId}`);
    expect(said(response)).toMatch(/opened from the held reading/);
    expect(store.cases.get(caseId as string)?.deductionDate).toBeUndefined();
    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload).toMatchObject({
      held: { reason: 'type_did_not_fit', fields: ['deduction_date'] },
      fields_missing_on_open: ['deduction_date'],
      confirmed_by: USER_ID,
    });
  });

  it('refuses a remittance with no lines, and says to attach it instead', async () => {
    const store = harness.store as RouteTestStore;
    const deps = readerDeps(store, 0.99, {
      document: {
        payer_name: { value: 'Acme Foods', confidence: 0.9, source_page: 1, source_quote: 'Acme Foods' },
        payment_reference: { value: 'PAY-1', confidence: 0.9, source_page: 1, source_quote: 'PAY-1' },
        payment_date: { value: '2026-09-01', confidence: 0.9, source_page: 1, source_quote: '2026-09-01' },
        payment_total: { value: '$99.00', confidence: 0.9, source_page: 1, source_quote: '$99.00' },
        lines: [],
      },
    });
    deps.classifier.classify = async (document: DocumentPayload) => ({
      docType: 'remittance_advice',
      confidence: 0.99,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'stub',
        documentId: document.documentId,
        costMicros: 1,
        latencyMs: 1,
        outcome: 'ok',
      },
    });
    const read = await processUpload(
      {
        orgId: ORG_ID,
        filename: notice.filename,
        bytes: notice.bytes,
        source: 'web_upload',
        uploadedBy: USER_ID,
        pageText: notice.pageText,
      },
      deps,
    );
    expect(read.held).toMatchObject({ reason: 'type_did_not_fit', fields: ['lines'] });

    const response = await press(read.ingest.document.documentId);

    expect(location(response).pathname).toBe('/');
    expect(said(response)).toMatch(/a remittance with no lines/);
    expect(said(response)).toMatch(/Attach it to a case as evidence instead/);
    expect(store.cases.size).toBe(0);
    expect(await store.documentHold(read.ingest.document.documentId)).toBeDefined();
  });

  it('says so while another request is reading or opening the same document', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId } = await heldNotice(store);

    const lease = await store.withDocumentRead(documentId, () => press(documentId));

    expect(lease.held).toBe(true);
    if (!lease.held) return;
    expect(said(lease.result)).toMatch(/being read or opened by another request/);
    expect(store.cases.size).toBe(0);
  });

  it('sends the reviewer to the case that already holds the claim, and leaves the hold standing', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId } = await heldNotice(store);
    const existing = await store.openCase({ orgId: ORG_ID, claimId: 'EXISTING' });
    store.openCase = async () => {
      throw new DuplicateCaseError('claim is already a case', existing.deductionId, 'APDP-99812');
    };

    const response = await press(documentId);

    expect(location(response).pathname).toBe(`/cases/${existing.deductionId}`);
    expect(said(response)).toMatch(/already this case, so no second case was opened/);
    expect(response.headers.get('location')).not.toContain('APDP');
    expect(await store.documentHold(documentId)).toBeDefined();
  });

  it('names a case merged into another rather than failing (ADR 0042)', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId } = await heldNotice(store);
    store.linkDocument = async (deductionId: string) => {
      throw new CaseMergedAwayError(deductionId, 'deduction_documents');
    };

    const response = await press(documentId);

    expect(said(response)).toMatch(/merged into another/);
  });

  it('goes to the list when a held remittance’s lines open none', async () => {
    const store = harness.store as RouteTestStore;
    // Any fixture's bytes will do for the file: the stub reader says what it is.
    const remittance = fixtureFor('walmart-po.pdf');
    // A remittance read below the floor whose one line is under this tenant's
    // tolerance: releasing the hold opens nothing, and says so.
    const deps = readerDeps(store, 0.9, {
      document: {
        payer_name: { value: 'Acme Foods', confidence: 0.9, source_page: 1, source_quote: 'Acme Foods' },
        payment_reference: { value: 'PAY-1', confidence: 0.9, source_page: 1, source_quote: 'PAY-1' },
        payment_date: { value: '2026-09-01', confidence: 0.9, source_page: 1, source_quote: '2026-09-01' },
        payment_total: { value: '$99.00', confidence: 0.9, source_page: 1, source_quote: '$99.00' },
        lines: [
          {
            invoice_number: { value: 'INV-9', confidence: 0.9, source_page: 1, source_quote: 'INV-9' },
            gross_amount: { value: '$100.00', confidence: 0.9, source_page: 1, source_quote: '$100.00' },
            deduction_amount: { value: '$1.00', confidence: 0.9, source_page: 1, source_quote: '$1.00' },
            net_amount: { value: '$99.00', confidence: 0.9, source_page: 1, source_quote: '$99.00' },
            reason_code: { value: null, confidence: 0, source_page: 1, source_quote: '' },
          },
        ],
      },
    });
    deps.classifier.classify = async (document: DocumentPayload) => ({
      docType: 'remittance_advice',
      confidence: 0.9,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'stub',
        documentId: document.documentId,
        costMicros: 1,
        latencyMs: 1,
        outcome: 'ok',
      },
    });
    const read = await processUpload(
      {
        orgId: ORG_ID,
        filename: remittance.filename,
        bytes: remittance.bytes,
        source: 'web_upload',
        uploadedBy: USER_ID,
        pageText: remittance.pageText,
      },
      deps,
    );
    expect(read.held?.docType).toBe('remittance_advice');

    const response = await press(read.ingest.document.documentId);

    expect(location(response).pathname).toBe('/');
    expect(said(response)).toMatch(/no line on that remittance was short-paid over/);
    expect(store.cases.size).toBe(0);
    expect(await store.documentHold(read.ingest.document.documentId)).toBeUndefined();
  });

  it('404s a document this tenant cannot see', async () => {
    const response = await press('33333333-3333-3333-3333-333333333333');
    expect(response.status).toBe(404);
  });

  it('turns a fault into a sentence and a log line, never a silent success', async () => {
    const store = harness.store as RouteTestStore;
    const { documentId } = await heldNotice(store);
    const boom = new Error('database blinked');
    store.transitionCase = async () => {
      throw boom;
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await press(documentId);
      expect(said(response)).toMatch(/failed, and the reason is in this deployment’s logs/);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/open held: opening a case/), boom);
      // The hold stands: the release comes after the case, and there was none.
      expect(await store.documentHold(documentId)).toBeDefined();
    } finally {
      logged.mockRestore();
    }
  });
});
