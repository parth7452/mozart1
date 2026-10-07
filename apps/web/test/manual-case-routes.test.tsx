import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ManualCaseRefusedError, type PostgresStore } from '@recouple/store-postgres';
import { DuplicateCaseError } from '@recouple/pipeline';
import type { ManualEntry } from '@recouple/core-domain';

/**
 * Opening a case by hand (ADR 0070): the two POSTs behind the dialog. Nothing
 * happens cross-site or for a member who may not write; every refusal goes back
 * to the dialog (`#new-case`) with what was typed — never the notes.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const DEBTOR = '33333333-3333-4333-8333-333333333333';
const CASE_ID = '44444444-4444-4444-8444-444444444444';
const EXISTING = '55555555-5555-4555-8555-555555555555';
const NOTES = 'They took it twice, see the call on Tuesday';

const harness = vi.hoisted(() => ({
  role: 'analyst' as string,
  storeCalls: 0,
  closed: 0,
  mayWrite: true,
  opened: [] as unknown[],
  openError: undefined as unknown,
  created: true,
  createError: undefined as unknown,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'reviewer@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
  storeFor: () => {
    harness.storeCalls += 1;
    return {
      async memberMayWrite() {
        return harness.mayWrite;
      },
      async openManualCase(input: { entry: ManualEntry }) {
        harness.opened.push(input.entry);
        if (harness.openError !== undefined) throw harness.openError;
        return { deductionId: CASE_ID, documentId: '66666666-6666-4666-8666-666666666666' };
      },
      async createDebtor({ displayName }: { displayName: string }) {
        if (harness.createError !== undefined) throw harness.createError;
        return { debtorId: DEBTOR, displayName, created: harness.created };
      },
      async close() {
        harness.closed += 1;
      },
    } as unknown as PostgresStore;
  },
}));

const { POST: OPEN } = await import('../app/cases/new/open/route');
const { POST: PAYER } = await import('../app/cases/new/payer/route');

const valid: Record<string, string> = {
  debtorId: DEBTOR,
  deductionReference: 'CB-2026-001',
  amount: '1,250.00',
  deductionDate: '2026-09-30',
  reasonCode: 'PRICE-DIFF',
  invoiceNumbers: 'INV-1\nINV-2',
  notes: NOTES,
};

function post(path: string, fields: Record<string, string>, site = 'same-origin'): NextRequest {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    body,
    headers: { 'sec-fetch-site': site },
  });
}

function where(response: Response): URL {
  expect(response.status).toBe(303);
  return new URL(response.headers.get('location') ?? '');
}

beforeEach(() => {
  harness.role = 'analyst';
  harness.storeCalls = 0;
  harness.closed = 0;
  harness.mayWrite = true;
  harness.opened = [];
  harness.openError = undefined;
  harness.created = true;
  harness.createError = undefined;
});

describe('POST /cases/new/open', () => {
  it('refuses a cross-site request before touching the store', async () => {
    const response = await OPEN(post('/cases/new/open', valid, 'cross-site'));
    expect(response.status).toBe(403);
    expect(harness.storeCalls).toBe(0);
  });

  it('tells a read_only member they cannot open one', async () => {
    harness.role = 'read_only';
    const url = where(await OPEN(post('/cases/new/open', valid)));
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('nc')).toBe('nc_role');
    expect(url.hash).toBe('#new-case');
    expect(harness.storeCalls).toBe(0);
  });

  it('sends an invalid amount back with the field and the typing, never the notes', async () => {
    const response = await OPEN(post('/cases/new/open', { ...valid, amount: '12.5x' }));
    const url = where(response);
    expect(url.searchParams.get('nc')).toBe('nc_invalid');
    expect(url.searchParams.get('field')).toBe('amount');
    expect(url.searchParams.get('deductionReference')).toBe('CB-2026-001');
    expect(url.hash).toBe('#new-case');
    const location = response.headers.get('location') ?? '';
    expect(location).not.toContain('notes');
    expect(decodeURIComponent(location.replace(/\+/g, ' '))).not.toContain(NOTES);
    expect(harness.storeCalls).toBe(0);
  });

  it('opens the case and sends the person to attach evidence', async () => {
    const url = where(await OPEN(post('/cases/new/open', valid)));
    expect(url.pathname).toBe(`/cases/${CASE_ID}`);
    expect(url.searchParams.get('action')).toBe('case_opened_manually');
    expect(url.hash).toBe('#add-evidence');
    const entry = harness.opened[0] as ManualEntry;
    expect(entry.amountCents).toBe(125_000);
    expect(entry.invoiceNumbers).toEqual(['INV-1', 'INV-2']);
    expect(harness.closed).toBe(1);
  });

  it('sends a duplicate to the case that already holds the reference', async () => {
    harness.openError = new DuplicateCaseError('duplicate', EXISTING, 'CB-2026-001');
    const url = where(await OPEN(post('/cases/new/open', valid)));
    expect(url.pathname).toBe(`/cases/${EXISTING}`);
    expect(url.searchParams.get('action')).toBe('case_duplicate_manual');
  });

  it('names an unknown payer', async () => {
    harness.openError = new ManualCaseRefusedError('unknown_debtor', 'debtorId');
    const url = where(await OPEN(post('/cases/new/open', valid)));
    expect(url.searchParams.get('nc')).toBe('nc_unknown_debtor');
    expect(url.searchParams.get('field')).toBe('debtorId');
    expect(url.hash).toBe('#new-case');
  });

  it('answers a fault with nc_failed and closes the store', async () => {
    harness.openError = new Error('connection reset');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const url = where(await OPEN(post('/cases/new/open', valid)));
    expect(url.searchParams.get('nc')).toBe('nc_failed');
    expect(harness.closed).toBe(1);
    expect(errors.mock.calls.flat().join(' ')).not.toContain('CB-2026-001');
    errors.mockRestore();
  });
});

describe('POST /cases/new/payer', () => {
  it('adds a payer and selects it, keeping what was typed', async () => {
    const url = where(
      await PAYER(post('/cases/new/payer', { displayName: 'Sysco Baltimore', amount: '10.00' })),
    );
    expect(url.searchParams.get('nc')).toBe('nc_payer_added');
    expect(url.searchParams.get('debtorId')).toBe(DEBTOR);
    expect(url.searchParams.get('amount')).toBe('10.00');
    expect(url.hash).toBe('#new-case');
  });

  it('selects a payer already on the list', async () => {
    harness.created = false;
    const url = where(await PAYER(post('/cases/new/payer', { displayName: 'sysco baltimore' })));
    expect(url.searchParams.get('nc')).toBe('nc_payer_exists');
    expect(url.searchParams.get('debtorId')).toBe(DEBTOR);
  });

  it('refuses an empty or over-long name without touching the store', async () => {
    for (const displayName of ['   ', 'x'.repeat(201)]) {
      const url = where(await PAYER(post('/cases/new/payer', { displayName })));
      expect(url.searchParams.get('nc')).toBe('nc_payer_invalid');
    }
    expect(harness.storeCalls).toBe(0);
  });
});
