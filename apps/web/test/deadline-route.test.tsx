import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  DeadlineAlreadySetError,
  DeadlineBasisRequiredError,
  DeadlineBasisTooLongError,
  DeadlineOutOfRangeError,
  WrongCaseStateError,
  WrongRoleError,
} from '@recouple/pipeline';
import type { PostgresStore } from '@recouple/store-postgres';
import { NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

/**
 * The deadline a person enters (pilot E6).
 *
 * What is tested is the route: the order of the checks, that who set it is the
 * session and never the form, that a case this tenant cannot see is a 404, and
 * that every named refusal says so while anything unnamed fails loud. The
 * store's half — the column only where null, the event in the same
 * transaction — is `packages/store-postgres/test/dispute-deadline.test.ts`.
 */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const BASIS = 'Sysco vendor agreement: 60 days from deduction date';

class RouteTestStore {
  closed = 0;
  mayWrite = true;
  readonly asked: unknown[] = [];
  readonly sets: unknown[] = [];
  throws: unknown;

  async memberMayWrite(actor: { orgId: string; userId: string }): Promise<boolean> {
    this.asked.push(actor);
    return this.mayWrite;
  }

  async setDisputeDeadline(input: {
    deductionId: string;
    deadline: string;
    basis: string;
    setBy: string;
  }): Promise<{ eventId: string }> {
    this.sets.push(input);
    if (this.throws !== undefined) throw this.throws;
    return { eventId: '1' };
  }

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

vi.mock('../lib/pipeline', () => ({
  mayWrite: (role: string) => role !== 'read_only' && role !== 'accountant_guest',
}));

const { POST } = await import('../app/cases/[id]/deadline/route');

function post(
  fields: Record<string, string> = { deadline: '2026-11-25', basis: BASIS },
  secFetchSite?: string,
): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const headers = new Headers();
  if (secFetchSite !== undefined) headers.set('sec-fetch-site', secFetchSite);
  return new NextRequest(`https://app.example.test/cases/${CASE_ID}/deadline`, {
    method: 'POST',
    body: form,
    headers,
  });
}

function params(id: string = CASE_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function said(response: Response): string | undefined {
  const at = new URL(response.headers.get('location') as string);
  return resolveNotice(
    at.searchParams.get('action') ?? undefined,
    at.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
}

beforeEach(() => {
  harness.role = 'analyst';
  harness.sessions = 0;
  harness.store = new RouteTestStore();
});

describe('entering a dispute deadline from the case page', () => {
  it('records it as the session’s own user, whatever the form says, and says so', async () => {
    const store = harness.store as RouteTestStore;

    const response = await POST(
      post({ deadline: '2026-11-25', basis: BASIS, setBy: '44444444-4444-4444-4444-444444444444' }),
      params(),
    );

    expect(response.status).toBe(303);
    expect(store.sets).toEqual([
      { deductionId: CASE_ID, deadline: '2026-11-25', basis: BASIS, setBy: USER_ID },
    ]);
    expect(new URL(response.headers.get('location') as string).pathname).toBe(`/cases/${CASE_ID}`);
    expect(said(response)).toBe('recorded: this case is due 2026-11-25, with the basis you gave');
    expect(store.closed).toBe(1);
  });

  it('refuses a cross-site post before it resolves the session', async () => {
    const response = await POST(post(undefined, 'cross-site'), params());
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
    expect((harness.store as RouteTestStore).sets).toEqual([]);
  });

  it('tells a read-only member no and asks the store nothing; asks the database too', async () => {
    harness.role = 'read_only';
    const store = harness.store as RouteTestStore;
    expect(said(await POST(post(), params()))).toMatch(/not set a deadline/);
    expect(store.asked).toEqual([]);

    harness.role = 'analyst';
    store.mayWrite = false;
    expect(said(await POST(post(), params()))).toMatch(/not set a deadline/);
    expect(store.asked).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(store.sets).toEqual([]);
  });

  it('refuses a path that is not a UUID, and a missing date, without reaching the store', async () => {
    const store = harness.store as RouteTestStore;
    const bad = await POST(post(), params('------------------------------------'));
    expect(new URL(bad.headers.get('location') as string).pathname).toBe('/');
    expect(said(await POST(post({ basis: BASIS }), params()))).toMatch(/choose the date/);
    expect(said(await POST(post({ deadline: '', basis: BASIS }), params()))).toMatch(
      /choose the date/,
    );
    expect(said(await POST(post({ deadline: '2026-11-25' }), params()))).toMatch(
      /say what the date is based on/,
    );
    expect(store.sets).toEqual([]);
  });

  it('turns every named refusal into its own notice', async () => {
    const store = harness.store as RouteTestStore;
    const cases: [unknown, RegExp][] = [
      [new DeadlineAlreadySetError(CASE_ID, '2026-10-13'), /already has a deadline.*Nothing was changed/],
      [new DeadlineOutOfRangeError(CASE_ID, '2020-01-01', 'in_the_past'), /has passed/],
      [new DeadlineOutOfRangeError(CASE_ID, '2206-01-01', 'too_far_out'), /check the year/],
      [new DeadlineOutOfRangeError(CASE_ID, '2026-02-30', 'not_a_date'), /choose the date/],
      [new DeadlineBasisRequiredError(CASE_ID), /say what the date is based on/],
      [new DeadlineBasisTooLongError(CASE_ID, 281, 280), /281 characters/],
      [new WrongCaseStateError(CASE_ID, 'set a deadline', 'written_off', []), /written off/],
      [new WrongRoleError(USER_ID, 'set a deadline', ['owner']), /not set a deadline/],
    ];
    for (const [thrown, expected] of cases) {
      store.throws = thrown;
      expect(said(await POST(post(), params())), String(thrown)).toMatch(expected);
    }
  });

  it('404s a case this tenant cannot see, and fails loud on the unknown', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new CaseNotVisibleError(CASE_ID);
    expect((await POST(post(), params())).status).toBe(404);
    store.throws = new Error('the database blinked');
    await expect(POST(post(), params())).rejects.toThrow('the database blinked');
    expect(store.closed).toBe(2);
  });
});
