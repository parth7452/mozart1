import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AlreadyDeclinedError } from '@recouple/store-postgres';
import type { PostgresStore } from '@recouple/store-postgres';

/**
 * What the decline route does with everything that is not the happy path.
 *
 * Declining is the one action in the app that writes to the counterfactual log,
 * and that log is what coverage is computed from: a row too many or too few
 * moves the only number this feature exists to produce. So the refusals matter
 * as much as the write, and every one of them is a redirect a reviewer can read
 * rather than a 500 that loses what they typed.
 *
 * The store is a stand-in — the real `declineCase` is tested against a real
 * Postgres in `packages/store-postgres/test/decline-case.test.ts`, which is
 * where the row lock and the append-only event belong. What is tested here is
 * the handler: order of checks, what reaches the store, and what comes back.
 */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CASE_ID = '33333333-3333-3333-3333-333333333333';

interface DeclineCall {
  deductionId: string;
  reason: string;
  decidedBy: string;
  assumedDiscoveredFrom: string;
  missingEvidence?: readonly string[];
  detail?: string;
}

class RouteTestStore {
  closed = 0;
  readonly calls: DeclineCall[] = [];
  /** What the next `declineCase` should do instead of succeeding. */
  throws: unknown;

  async declineCase(input: DeclineCall): Promise<unknown> {
    this.calls.push(input);
    if (this.throws !== undefined) throw this.throws;
    return { declinedCandidateId: 'dc-1', ...input };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

const harness = vi.hoisted(() => ({
  store: undefined as RouteTestStore | undefined,
  role: 'analyst' as string,
  /** How many times the session was resolved, so ordering can be asserted. */
  sessions: 0,
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

vi.mock('../lib/pipeline', () => ({
  mayWrite: (role: string) => role !== 'read_only' && role !== 'accountant_guest',
}));

const { POST } = await import('../app/cases/[id]/decline/route');

/** A form POST the route can read, from wherever `secFetchSite` says. */
function declineRequest(
  fields: Record<string, string | string[]> = { reason: 'below_economic_floor' },
  secFetchSite?: string,
): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) form.append(key, one);
  }
  const headers = new Headers();
  if (secFetchSite !== undefined) headers.set('sec-fetch-site', secFetchSite);
  return new NextRequest(`https://app.example.test/cases/${CASE_ID}/decline`, {
    method: 'POST',
    body: form,
    headers,
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') as string);
}

describe('declining a case from the web', () => {
  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    harness.store = new RouteTestStore();
  });

  it('records the decline and says so on the case it came from', async () => {
    const store = harness.store as RouteTestStore;
    const response = await POST(
      declineRequest({
        reason: 'evidence_unavailable',
        missing: ['proof_of_delivery', 'not an evidence type'],
        detail: '  the carrier has nothing  ',
      }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    const to = location(response);
    expect(to.pathname).toBe(`/cases/${CASE_ID}`);
    expect(to.searchParams.get('decline')).toMatch(/logged as declined, not discarded/);

    // Who decided comes from the session, never from the form. The evidence
    // list is filtered to what coverage can add up, and the detail is trimmed.
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      deductionId: CASE_ID,
      reason: 'evidence_unavailable',
      decidedBy: 'reviewer@example.test',
      assumedDiscoveredFrom: 'web_upload',
      missingEvidence: ['proof_of_delivery'],
      detail: 'the carrier has nothing',
    });
    expect(store.closed).toBe(1);
  });

  it('refuses a cross-site POST with a 403, before the session is resolved', async () => {
    // The session cookie is SameSite=Lax, which stops this too — but that is a
    // setting in another file, and a write this route makes should not depend
    // on somebody else not changing it. The check is first for a reason: a
    // cross-site request must not even cause a session lookup, let alone a
    // database write.
    const store = harness.store as RouteTestStore;
    const response = await POST(declineRequest(undefined, 'cross-site'), params(CASE_ID));

    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.sessions).toBe(0);
    expect(store.calls).toHaveLength(0);
  });

  it('refuses a POST from another subdomain too', async () => {
    const response = await POST(declineRequest(undefined, 'same-site'), params(CASE_ID));
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
  });

  it('accepts the two headers a real navigation sends', async () => {
    // `same-origin` is the form on the case page. `none` is the user typing the
    // URL or following a bookmark. A client that sends no header at all — curl,
    // an older browser — is not evidence of anything, and carries no cookie.
    for (const site of ['same-origin', 'none', undefined]) {
      harness.store = new RouteTestStore();
      const response = await POST(declineRequest(undefined, site), params(CASE_ID));
      expect(response.status).toBe(303);
      expect((harness.store as RouteTestStore).calls).toHaveLength(1);
    }
  });

  it('sends an id that is not a UUID to the case list, not to Postgres', async () => {
    // Thirty-six characters of hex and dashes is not a UUID. The loose pattern
    // this replaced accepted `------------------------------------`, which
    // reaches Postgres as a 22P02 and comes back to the reviewer as a 500.
    const store = harness.store as RouteTestStore;
    for (const id of ['------------------------------------', 'not-a-uuid', `${CASE_ID}x`]) {
      const response = await POST(declineRequest(), params(id));
      expect(response.status).toBe(303);
      expect(location(response).pathname).toBe('/');
      expect(location(response).searchParams.get('decline')).toBeNull();
    }
    expect(store.calls).toHaveLength(0);
  });

  it('tells a read_only member why, rather than letting the policy say it', async () => {
    // The role check here is a better error message, not the enforcement: the
    // insert policy would refuse it anyway. Nothing reaches the store.
    harness.role = 'read_only';
    const store = harness.store as RouteTestStore;
    const response = await POST(declineRequest(), params(CASE_ID));

    expect(response.status).toBe(303);
    const to = location(response);
    expect(to.pathname).toBe(`/cases/${CASE_ID}`);
    expect(to.searchParams.get('decline')).toBe(
      'your role can review cases but not decide them',
    );
    expect(store.calls).toHaveLength(0);
  });

  it('asks for a reason rather than recording a decline without one', async () => {
    // A decline with no reason is a row nothing can learn from, and the enum
    // would refuse it one round trip later anyway.
    const store = harness.store as RouteTestStore;
    for (const fields of [{}, { reason: '' }, { reason: 'because I said so' }]) {
      const response = await POST(declineRequest(fields), params(CASE_ID));
      expect(response.status).toBe(303);
      const to = location(response);
      expect(to.pathname).toBe(`/cases/${CASE_ID}`);
      expect(to.searchParams.get('decline')).toBe('choose a reason for declining');
    }
    expect(store.calls).toHaveLength(0);
  });

  it('lets the first decline stand when the form is submitted twice', async () => {
    // Not a fault: a form still on screen, submitted again. A second row would
    // count this case's dollars twice in `coverage_by_period`, so the store
    // refuses it — and a 500 here would look like the app was broken.
    const store = harness.store as RouteTestStore;
    store.throws = new AlreadyDeclinedError(CASE_ID, 'dc-1', '2026-09-20T00:00:00Z');

    const response = await POST(declineRequest(), params(CASE_ID));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(to.pathname).toBe(`/cases/${CASE_ID}`);
    expect(to.searchParams.get('decline')).toBe(
      'this case was already declined; the first decline stands',
    );
    expect(store.closed).toBe(1);
  });

  it('does not swallow an error it does not recognise', async () => {
    // Fail loud. A decline that did not happen must not redirect back looking
    // like one that did — this is a money path, and the counterfactual log is
    // append-only, so a missing row is not something a later write repairs.
    const store = harness.store as RouteTestStore;
    store.throws = new Error('connection terminated unexpectedly');

    await expect(POST(declineRequest(), params(CASE_ID))).rejects.toThrow(
      'connection terminated unexpectedly',
    );
    // And the store is still released on the way out.
    expect(store.closed).toBe(1);
  });
});
