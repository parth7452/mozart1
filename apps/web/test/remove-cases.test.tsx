import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaseRemovalRefusedError } from '@recouple/pipeline';
import type { PostgresStore, ReviewQueueRead, ReviewQueueRow } from '@recouple/store-postgres';
import { WorkQueue, type QueueViewer } from '../components/work-queue';
import { resolveNotice } from '../lib/notices';

/**
 * Removing a case opened in error (ADR 0072), as the app offers it: the
 * queue's controls only for an owner or approver, the confirmation page, and
 * the POST's order of checks. The removal itself is tested against Postgres
 * in `packages/store-postgres/test/remove-cases.test.ts`.
 */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const A = '33333333-3333-3333-3333-333333333333';
const B = '44444444-4444-4444-4444-444444444444';

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  calls: [] as { ids: readonly string[]; reason?: string }[],
  throws: undefined as unknown,
  mayWrite: true,
  states: {} as Record<string, string>,
}));

const store = {
  async removeCases(ids: readonly string[], reason?: string) {
    harness.calls.push({ ids, ...(reason === undefined ? {} : { reason }) });
    if (harness.throws !== undefined) throw harness.throws;
    return ids.map((deductionId) => ({ deductionId, stateBefore: 'classified' }));
  },
  async memberMayWrite() {
    return harness.mayWrite;
  },
  async caseSummary(id: string) {
    const state = harness.states[id];
    return state === undefined
      ? undefined
      : {
          deductionId: id,
          state,
          claimId: `CLM-${id.slice(0, 4)}`,
          deductionAmountCents: 12_345,
          debtorName: 'Sysco Baltimore',
          discoveredVia: 'notice',
        };
  },
  async close() {},
};

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: '22222222-2222-2222-2222-222222222222',
    email: 'owner@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
  storeFor: () => store as unknown as PostgresStore,
}));

const { POST } = await import('../app/cases/remove/confirm/route');
const { default: RemoveCasesPage } = await import('../app/cases/remove/page');

function post(fields: Record<string, string | string[]>, secFetchSite = 'same-origin'): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) form.append(key, one);
  }
  return new NextRequest('https://app.example.test/cases/remove/confirm', {
    method: 'POST',
    body: form,
    headers: new Headers({ 'sec-fetch-site': secFetchSite }),
  });
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') as string);
}

beforeEach(() => {
  harness.role = 'owner';
  harness.calls = [];
  harness.throws = undefined;
  harness.mayWrite = true;
  harness.states = {};
});

describe('the queue’s close controls', () => {
  const row = {
    deductionId: A,
    state: 'classified',
    claimId: 'CLM-1',
    deductionAmountCents: 10_000,
    createdAt: '2026-09-20',
    debtorName: 'Sysco Baltimore',
    discoveredVia: 'notice',
    hasApproval: false,
  } as unknown as ReviewQueueRow;
  const queue: ReviewQueueRead = { rows: [row], total: 1, waitingOnRetailer: 0, limit: 500 };
  const render = (viewer: QueueViewer) =>
    renderToStaticMarkup(
      <WorkQueue queue={queue} today={new Date('2026-09-23T15:00:00Z')} viewer={viewer} />,
    );

  it('shows a Close case link, a checkbox and Close selected to an owner or approver', () => {
    const html = render({ userId: 'u', mayApprove: true });
    expect(html).toContain(`href="/cases/remove?id=${A}"`);
    expect(html).toContain('Close case');
    const box = html.match(/<input type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(box).toContain('name="id"');
    expect(box).toContain(`value="${A}"`);
    expect(box).toContain('form="bulk-close"');
    expect(html).toContain('aria-label="Select case CLM-1"');
    expect(html).toMatch(/<form id="bulk-close"[^>]*action="\/cases\/remove" method="get"/);
    expect(html).toContain('Close selected');
  });

  it('shows none of them to anyone else', () => {
    const html = render({ userId: 'u', mayApprove: false });
    expect(html).not.toContain('/cases/remove');
    expect(html).not.toContain('Close case');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Close selected');
  });
});

describe('POST /cases/remove/confirm', () => {
  it('refuses a cross-site request before anything else', async () => {
    const response = await POST(post({ id: A }, 'cross-site'));
    expect(response.status).toBe(403);
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses an analyst without touching the store', async () => {
    harness.role = 'analyst';
    const response = await POST(post({ id: A }));
    expect(response.status).toBe(303);
    expect(location(response).searchParams.get('notice')).toBe('remove_role');
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses a member the database says may not write', async () => {
    harness.mayWrite = false;
    const response = await POST(post({ id: A }));
    expect(location(response).searchParams.get('notice')).toBe('remove_role');
    expect(harness.calls).toHaveLength(0);
  });

  it('removes every id at once and says how many on the list', async () => {
    const response = await POST(post({ id: [A, B, A.toUpperCase()], reason: '  test upload  ' }));
    expect(response.status).toBe(303);
    expect(harness.calls).toEqual([{ ids: [A, B], reason: 'test upload' }]);
    const to = location(response);
    expect(to.pathname).toBe('/');
    expect(to.searchParams.get('action')).toBe('cases_removed');
    expect(resolveNotice('cases_removed', to.searchParams.getAll('about'))?.text).toContain(
      'removed 2 case(s)',
    );
  });

  it('sends a refusal back to the confirmation page, with the selection', async () => {
    harness.throws = new CaseRemovalRefusedError(A, 'not_removable_state');
    const response = await POST(post({ id: A }));
    const to = location(response);
    expect(to.pathname).toBe('/cases/remove');
    expect(to.searchParams.getAll('id')).toEqual([A]);
    expect(to.searchParams.get('notice')).toBe('remove_refused');
  });

  it('refuses an id that is not a UUID, and a reason past 500 characters', async () => {
    expect(location(await POST(post({ id: 'nope' }))).searchParams.get('notice')).toBe('remove_none');
    expect(
      location(await POST(post({ id: A, reason: 'x'.repeat(501) }))).searchParams.get('notice'),
    ).toBe('remove_reason_too_long');
    expect(harness.calls).toHaveLength(0);
  });
});

describe('the confirmation page', () => {
  const render = async (params: { id?: string | string[]; notice?: string }) =>
    renderToStaticMarkup(await RemoveCasesPage({ searchParams: Promise.resolve(params) }));

  it('asks about one case, says what removal does, and posts its id', async () => {
    harness.states = { [A]: 'classified' };
    const html = await render({ id: A });
    expect(html).toContain('Delete this case?');
    expect(html).toContain('They will be removed from every list and total.');
    expect(html).toContain('Their record is kept for audit.');
    expect(html).toContain('action="/cases/remove/confirm"');
    expect(html).toContain(`type="hidden" name="id" value="${A}"`);
    expect(html).toContain('Sysco Baltimore');
    expect(html).toContain('>Delete</button>');
  });

  it('leaves a filed case out of the form and says why', async () => {
    harness.states = { [A]: 'classified', [B]: 'submitted' };
    const html = await render({ id: [A, B] });
    expect(html).toContain('Delete this case?');
    expect(html).toContain('already filed with the payer');
    expect(html).not.toContain(`type="hidden" name="id" value="${B}"`);
  });

  it('counts several', async () => {
    harness.states = { [A]: 'classified', [B]: 'decided' };
    expect(await render({ id: [A, B] })).toContain('Delete these 2 cases?');
  });

  it('refuses a selection that is not ids, and an analyst', async () => {
    expect(await render({ id: 'x' })).toContain('does not name a case');
    harness.role = 'analyst';
    harness.states = { [A]: 'classified' };
    const html = await render({ id: A });
    expect(html).toContain('Only an owner or an approver');
    expect(html).not.toContain('/cases/remove/confirm');
  });
});
