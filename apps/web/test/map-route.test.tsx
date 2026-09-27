import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Classifier, Extractor } from '@recouple/extraction';
import { processUpload, type PipelineDeps } from '@recouple/pipeline';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import type { PostgresStore } from '@recouple/store-postgres';

/**
 * Mapping a held spreadsheet's columns (ADR 0056): the route records the
 * person's mapping under their own id and opens the document through it, with
 * no model call, behind the same guards as "Open a case from it".
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const DEBTOR = '33333333-3333-4333-8333-333333333333';

class RouteTestStore extends InMemoryStore {
  closed = 0;
  async close(): Promise<void> {
    this.closed += 1;
  }
}

const harness = vi.hoisted(() => ({ store: undefined as RouteTestStore | undefined, role: 'analyst' }));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'reviewer@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
  storeFor: () => harness.store as unknown as PostgresStore,
}));

vi.mock('../lib/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pipeline')>();
  return { ...actual, mayWrite: (role: string) => role !== 'read_only' };
});

const { POST } = await import('../app/documents/[id]/map/route');

const noModel = {
  name: 'none',
  classify: () => {
    throw new Error('no model may be asked');
  },
  extract: () => {
    throw new Error('no model may be asked');
  },
};

const LIST = ['Reference,Invoice,Amount,Reason,Date', 'CB-1,INV-1,-100.00,SHORT,14/09/2026'].join('\n');

async function heldSheet(store: RouteTestStore): Promise<string> {
  const deps: PipelineDeps = {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier: noModel as unknown as Classifier,
    extractor: noModel as unknown as Extractor,
    now: () => new Date('2026-09-27T12:00:00Z'),
  };
  const result = await processUpload(
    { orgId: ORG_ID, filename: 'list.csv', bytes: new TextEncoder().encode(LIST), source: 'web_upload', uploadedBy: USER_ID },
    deps,
  );
  expect(result.held?.reason).toBe('no_mapping');
  return result.ingest.document.documentId;
}

function mappingForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  const fields: Record<string, string> = {
    shape: 'deduction_list',
    sign: 'deductions_negative',
    date_order: 'dmy',
    debtor: DEBTOR,
    sheet: '0',
    header_row: '1',
    'col:deduction_reference': '1',
    'col:invoice_number': '2',
    'col:deduction_amount': '3',
    'col:reason_code': '4',
    'col:deduction_date': '5',
    // A person-supplied field that is not the store's: ignored.
    confirmedBy: '99999999-9999-4999-8999-999999999999',
    ...overrides,
  };
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

function press(id: string, form: FormData, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  return POST(
    new NextRequest(`https://app.example.test/documents/${id}/map`, { method: 'POST', headers, body: form }),
    { params: Promise.resolve({ id }) },
  );
}

const location = (r: Response) => new URL(r.headers.get('location') ?? 'https://x.test/');

describe('mapping a held spreadsheet', () => {
  beforeEach(() => {
    harness.store = new RouteTestStore();
    harness.store.addMember(ORG_ID, USER_ID, 'analyst');
    harness.role = 'analyst';
  });

  it('records the mapping as the session member and opens the row, with no model call', async () => {
    const store = harness.store as RouteTestStore;
    const id = await heldSheet(store);
    const response = await press(id, mappingForm());

    expect(response.status).toBe(303);
    expect(store.sheetMappings).toHaveLength(1);
    expect(store.sheetMappings[0]?.confirmedBy).toBe(USER_ID);
    expect(store.sheetMappings[0]?.headerFingerprint).toEqual(['Reference', 'Invoice', 'Amount', 'Reason', 'Date']);
    expect(store.sheetMappings[0]?.sourceDocumentId).toBe(id);
    const [caseId] = [...store.cases.keys()];
    expect(location(response).pathname).toBe(`/cases/${caseId}`);
    expect(store.modelCalls).toEqual([]);
    expect(store.closed).toBe(1);
  });

  it('refuses a cross-site request before anything', async () => {
    const store = harness.store as RouteTestStore;
    const id = await heldSheet(store);
    const response = await press(id, mappingForm(), { 'sec-fetch-site': 'cross-site' });
    expect(response.status).toBe(403);
    expect(store.sheetMappings).toHaveLength(0);
  });

  it('refuses a role that may not write', async () => {
    const store = harness.store as RouteTestStore;
    const id = await heldSheet(store);
    harness.role = 'read_only';
    const response = await press(id, mappingForm());
    expect(location(response).searchParams.get('action')).toBe('open_held_role');
    expect(store.sheetMappings).toHaveLength(0);
  });

  it('refuses when the database says the member may not write', async () => {
    const store = harness.store as RouteTestStore;
    const id = await heldSheet(store);
    store.memberMayWrite = async () => false;
    const response = await press(id, mappingForm());
    expect(location(response).searchParams.get('action')).toBe('open_held_role');
    expect(store.sheetMappings).toHaveLength(0);
  });

  it('answers 404 for a document this tenant cannot see', async () => {
    const response = await press('44444444-4444-4444-8444-444444444444', mappingForm());
    expect(response.status).toBe(404);
  });

  it('records nothing when no column carries the amount', async () => {
    const store = harness.store as RouteTestStore;
    const id = await heldSheet(store);
    const form = mappingForm();
    form.delete('col:deduction_amount');
    const response = await press(id, form);
    expect(location(response).searchParams.get('action')).toBe('map_invalid');
    expect(store.sheetMappings).toHaveLength(0);
    expect(store.cases.size).toBe(0);
  });
});
