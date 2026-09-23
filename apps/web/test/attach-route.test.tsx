import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InMemoryStore } from '@recouple/pipeline/testing';
import type { PostgresStore } from '@recouple/store-postgres';
import { NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

/**
 * Attaching a document that was already read to a case, from the case list.
 *
 * The route behind the "Attach" button beside every document that was read and
 * that no case holds — the state a delivery receipt uploaded from the list is
 * left in, because it is evidence and opens nothing. What matters here is what
 * matters on every route that writes: nothing happens for a cross-site request
 * or a member who may not write, every refusal is a sentence rather than a 500,
 * and success lands the reviewer on the case with the document on it.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

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

const { POST } = await import('../app/documents/[id]/attach/route');

/** A case, and a delivery receipt that was read and that no case holds. */
async function seed(store: RouteTestStore): Promise<{ caseId: string; receiptId: string }> {
  store.addMember(ORG_ID, USER_ID, 'analyst');
  const opened = await store.openCase({ orgId: ORG_ID, claimId: 'LOG-202' });
  const receipt = await store.putDocument({
    orgId: ORG_ID,
    sha256: 'a'.repeat(64),
    filename: '08_log-202.jpg',
    mimeType: 'image/jpeg',
    byteSize: 4,
    bytes: new Uint8Array([1, 2, 3, 4]),
    requiresSplit: false,
  });
  await store.recordScan(receipt.documentId, { status: 'clean', scanner: 'test' });
  await store.recordClassification(receipt.documentId, 'pod', 0.98);
  await store.recordExtraction({
    documentId: receipt.documentId,
    docType: 'pod',
    extractor: 'test',
    schemaVersion: 'v1',
    fields: [],
    document: {},
  });
  return { caseId: opened.deductionId, receiptId: receipt.documentId };
}

function press(
  documentId: string,
  caseId: string | undefined,
  headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
): Promise<Response> {
  const body = new FormData();
  if (caseId !== undefined) body.set('caseId', caseId);
  return POST(
    new NextRequest(`https://app.example.test/documents/${documentId}/attach`, {
      method: 'POST',
      headers,
      body,
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
}

/** The notice a redirect carries, resolved the way the page resolves it. */
function said(response: Response): string | undefined {
  const location = new URL(response.headers.get('location') ?? 'https://x.test/');
  return resolveNotice(
    location.searchParams.get('action'),
    location.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
}

describe('attaching a read document to a case', () => {
  beforeEach(() => {
    harness.store = new RouteTestStore();
    harness.role = 'analyst';
    harness.sessions = 0;
  });

  it('files it on the case and sends the reviewer there, without reading anything', async () => {
    const store = harness.store as RouteTestStore;
    const { caseId, receiptId } = await seed(store);
    const modelCalls = store.modelCalls.length;

    const response = await press(receiptId, caseId);

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') as string).pathname).toBe(`/cases/${caseId}`);
    expect(said(response)).toMatch(/attached to this case as evidence/);
    expect(said(response)).toMatch(/not read again/);
    expect(store.links).toContainEqual({ deductionId: caseId, documentId: receiptId, role: 'evidence' });
    expect(store.modelCalls).toHaveLength(modelCalls);
    expect(store.closed).toBe(1);
  });

  it('says so, and writes nothing, when the case already holds it', async () => {
    const store = harness.store as RouteTestStore;
    const { caseId, receiptId } = await seed(store);
    await press(receiptId, caseId);

    const again = await press(receiptId, caseId);

    expect(said(again)).toMatch(/already holds that document/);
    expect(store.events.filter((e) => e.eventType === 'evidence.attached')).toHaveLength(1);
  });

  it('refuses a cross-site request before looking up the session', async () => {
    const store = harness.store as RouteTestStore;
    const { caseId, receiptId } = await seed(store);

    const response = await press(receiptId, caseId, { 'sec-fetch-site': 'cross-site' });

    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
    expect(store.links.some((l) => l.documentId === receiptId)).toBe(false);
  });

  it('refuses a member who may not write, in the app and in the database', async () => {
    const store = harness.store as RouteTestStore;
    const { caseId, receiptId } = await seed(store);

    harness.role = 'read_only';
    expect(said(await press(receiptId, caseId))).toMatch(/not attach them/);

    // The role the session carried says writer; the database no longer does.
    harness.role = 'analyst';
    store.memberships.splice(0, store.memberships.length);
    expect(said(await press(receiptId, caseId))).toMatch(/not attach them/);

    expect(store.links.some((l) => l.documentId === receiptId)).toBe(false);
  });

  it('asks for a case when none was chosen, and refuses one it cannot resolve', async () => {
    const store = harness.store as RouteTestStore;
    const { receiptId } = await seed(store);

    expect(said(await press(receiptId, undefined))).toMatch(/choose the case/);
    expect(said(await press(receiptId, 'not-a-case'))).toMatch(/choose the case/);
    expect(
      said(await press(receiptId, '99999999-9999-9999-9999-999999999999')),
    ).toMatch(/no longer available; nothing was attached/);
  });

  it('refuses a document that was never read rather than reading it', async () => {
    const store = harness.store as RouteTestStore;
    const { caseId } = await seed(store);
    const stored = await store.putDocument({
      orgId: ORG_ID,
      sha256: 'b'.repeat(64),
      filename: 'not-read.pdf',
      mimeType: 'application/pdf',
      byteSize: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
      requiresSplit: false,
    });

    const response = await press(stored.documentId, caseId);

    expect(said(response)).toMatch(/has not been read yet/);
    expect(store.modelCalls).toHaveLength(0);
  });

  it('404s a document this tenant cannot see', async () => {
    const store = harness.store as RouteTestStore;
    const { caseId } = await seed(store);

    const response = await press('33333333-3333-3333-3333-333333333333', caseId);

    expect(response.status).toBe(404);
  });
});
