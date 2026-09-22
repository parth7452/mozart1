import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  DuplicateVerdictAlreadyRecordedError,
  NoSuchDuplicatePairError,
  WrongRoleError,
  type DuplicateVerdict,
  type DuplicateVerdictRecord,
} from '@recouple/pipeline';
import type { PostgresStore } from '@recouple/store-postgres';
import { NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

/**
 * Answering a pair identity resolution refused to merge.
 *
 * The handler writes to two money-bearing cases at once, which makes it the
 * only route here that does — so what is tested is the order of the checks,
 * what reaches the store, and what a reviewer is told when the answer is no.
 * Two things in particular, because getting either wrong is how a verdict
 * becomes somebody else's: `recordedBy` is the session and never the form, and
 * a case this tenant cannot see is a 404 rather than a write.
 *
 * The store is a stand-in. The real `recordDuplicateVerdict` is tested against a
 * real Postgres in `packages/store-postgres/test/duplicate-review.test.ts`,
 * where the row locks, RLS and the append-only events are.
 */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ID = '44444444-4444-4444-4444-444444444444';

interface VerdictCall {
  deductionId: string;
  otherDeductionId: string;
  verdict: DuplicateVerdict;
  recordedBy: string;
}

class RouteTestStore {
  closed = 0;
  readonly calls: VerdictCall[] = [];
  /** What the database answers when the route asks whether this member writes. */
  mayWrite = true;
  /** Every `memberMayWrite` question, so ordering can be asserted. */
  readonly asked: unknown[] = [];
  /** What the next `recordDuplicateVerdict` should do instead of succeeding. */
  throws: unknown;

  async memberMayWrite(actor: { orgId: string; userId: string }): Promise<boolean> {
    this.asked.push(actor);
    return this.mayWrite;
  }

  async recordDuplicateVerdict(input: VerdictCall): Promise<DuplicateVerdictRecord> {
    this.calls.push(input);
    if (this.throws !== undefined) throw this.throws;
    return {
      verdict: input.verdict,
      deductionId: input.deductionId,
      otherDeductionId: input.otherDeductionId,
      survivingDeductionId: input.otherDeductionId,
      basis: ['invoice_number', 'amount_cents', 'deduction_date'],
      recordedBy: input.recordedBy,
      recordedAt: '2026-09-22T09:00:00.000Z',
    };
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
      userId: USER_ID,
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

const { POST } = await import('../app/cases/[id]/duplicate/route');

function post(
  fields: Record<string, string> = { other: OTHER_ID, verdict: 'same', from: 'case' },
  secFetchSite?: string,
): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const headers = new Headers();
  if (secFetchSite !== undefined) headers.set('sec-fetch-site', secFetchSite);
  return new NextRequest(`https://app.example.test/cases/${CASE_ID}/duplicate`, {
    method: 'POST',
    body: form,
    headers,
  });
}

function params(id: string = CASE_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') as string);
}

/** What the reviewer is told: the notice key the redirect carried, resolved. */
function said(response: Response): string | undefined {
  const at = location(response);
  return resolveNotice(
    at.searchParams.get('action') ?? undefined,
    at.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
}

describe('answering a possible duplicate', () => {
  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    harness.store = new RouteTestStore();
  });

  it('records "same deduction" as the session’s own user, and says nothing was merged', async () => {
    const store = harness.store as RouteTestStore;

    const response = await POST(post(), params());

    expect(response.status).toBe(303);
    expect(store.calls).toEqual([
      {
        deductionId: CASE_ID,
        otherDeductionId: OTHER_ID,
        verdict: 'same',
        recordedBy: USER_ID,
      },
    ]);
    expect(location(response).pathname).toBe(`/cases/${CASE_ID}`);
    expect(said(response)).toMatch(/one deduction/);
    // The sentence a reviewer reads must not claim the cases were joined: this
    // records a conclusion and moves nothing (ADR 0032 §5).
    expect(said(response)).toMatch(/nothing was merged/i);
    expect(store.closed).toBe(1);
  });

  it('records "different deductions" too, and leaves both cases open', async () => {
    const store = harness.store as RouteTestStore;

    const response = await POST(post({ other: OTHER_ID, verdict: 'different' }), params());

    expect(store.calls[0]?.verdict).toBe('different');
    expect(said(response)).toMatch(/two different deductions/);
  });

  it('sends an answer given on the case list back to the list', async () => {
    const response = await POST(
      post({ other: OTHER_ID, verdict: 'same', from: 'list' }),
      params(),
    );

    expect(location(response).pathname).toBe('/');
    expect(said(response)).toMatch(/one deduction/);
  });

  it('refuses a cross-site post before it even resolves the session', async () => {
    const store = harness.store as RouteTestStore;

    const response = await POST(post(undefined, 'cross-site'), params());

    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it('ignores a recordedBy somebody put in the form', async () => {
    // The verdict names the session's user, always. A handler that took this
    // from the form would let one reviewer's answer be recorded as another's on
    // a page a person is held to.
    const store = harness.store as RouteTestStore;
    const someoneElse = '99999999-9999-9999-9999-999999999999';

    await POST(post({ other: OTHER_ID, verdict: 'same', recordedBy: someoneElse }), params());

    expect(store.calls[0]?.recordedBy).toBe(USER_ID);
  });

  it('tells a read-only member their role cannot answer, and asks the store nothing', async () => {
    harness.role = 'read_only';
    const store = harness.store as RouteTestStore;

    const response = await POST(post(), params());

    expect(said(response)).toMatch(/your role can review cases but not say/);
    expect(store.asked).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it('asks the database as well, and writes nothing when it says no', async () => {
    // The role on the session is what this app believes; `member_may_write()`
    // is what the database knows, and a membership can have changed since the
    // page was drawn.
    const store = harness.store as RouteTestStore;
    store.mayWrite = false;

    const response = await POST(post(), params());

    expect(store.asked).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(store.calls).toEqual([]);
    expect(said(response)).toMatch(/your role can review cases but not say/);
    expect(store.closed).toBe(1);
  });

  it('answers a store that refuses the role by name the same way', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new WrongRoleError(USER_ID, 'answering a possible duplicate', ['owner']);

    const response = await POST(post(), params());

    expect(said(response)).toMatch(/your role can review cases but not say/);
  });

  it('sends a case id that is not a UUID back to the list rather than to a 500', async () => {
    const store = harness.store as RouteTestStore;

    const response = await POST(post(), params('------------------------------------'));

    expect(location(response).pathname).toBe('/');
    expect(store.calls).toEqual([]);
  });

  it('refuses a form whose other half is missing or not a UUID', async () => {
    const store = harness.store as RouteTestStore;

    for (const other of ['', 'not-a-uuid', '------------------------------------']) {
      const response = await POST(post({ other, verdict: 'same' }), params());
      expect(said(response)).toMatch(/nothing names those two cases/);
    }
    const missing = await POST(post({ verdict: 'same' }), params());
    expect(said(missing)).toMatch(/nothing names those two cases/);
    expect(store.calls).toEqual([]);
  });

  it('asks for an answer when the form carried none', async () => {
    const store = harness.store as RouteTestStore;

    const response = await POST(post({ other: OTHER_ID, verdict: 'maybe' }), params());

    expect(said(response)).toMatch(/say whether these are the same deduction/);
    expect(store.calls).toEqual([]);
  });

  it('404s a case this tenant cannot see, rather than saying it exists', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new CaseNotVisibleError(CASE_ID);

    const response = await POST(post(), params());

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(store.closed).toBe(1);
  });

  it('says the page is out of date when nothing names the two as a pair', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new NoSuchDuplicatePairError(CASE_ID, OTHER_ID);

    const response = await POST(post(), params());

    expect(said(response)).toMatch(/nothing names those two cases/);
    expect(said(response)).toMatch(/Nothing was recorded/);
  });

  it('says the first answer stands when the pair was already answered', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new DuplicateVerdictAlreadyRecordedError(
      CASE_ID,
      OTHER_ID,
      'same',
      '2026-09-22T09:00:00.000Z',
    );

    const response = await POST(post(), params());

    expect(said(response)).toMatch(/already answered/);
  });

  it('fails loud on anything it does not recognise, and still closes the store', async () => {
    // An answer that did not happen must not redirect back looking like one
    // that did: the events are append-only, so a missing pair of rows is not
    // something a later write repairs.
    const store = harness.store as RouteTestStore;
    store.throws = new Error('the database blinked');

    await expect(POST(post(), params())).rejects.toThrow('the database blinked');
    expect(store.closed).toBe(1);
  });
});
