import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  AlreadyDeclinedError,
  CaseNotDeclinableError,
  ProvenanceUnknownError,
} from '@recouple/store-postgres';
import type { PostgresStore } from '@recouple/store-postgres';
import { DECLINE_DETAIL_MAX_LENGTH, NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

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

/**
 * What the route hands the store — and, as of provenance at ingest, what it
 * does not: there is no `discoveredFrom` here. The channel a deduction arrived
 * through is derived by the store from the case's own notice, so a route that
 * could state it would be a route that could get it wrong.
 */
interface DeclineCall {
  deductionId: string;
  reason: string;
  decidedBy: string;
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

/**
 * What the reviewer is told: the notice key the redirect carried, resolved.
 *
 * A key, never a sentence — the query string is a thing anybody can type, and
 * an app that repeats what it finds there is an app a link can put words into
 * (`lib/notices.ts`). Going through `resolveNotice` means a key that is not in
 * the table fails these assertions rather than passing them with its own name.
 */
function said(response: Response): string | undefined {
  const at = new URL(response.headers.get('location') as string);
  return resolveNotice(
    at.searchParams.get('decline') ?? undefined,
    at.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
}

describe('declining a case from the web', () => {
  /** What the route logged, so "it is in the logs" can be asserted rather than hoped. */
  let logged: unknown[][] = [];

  beforeEach(() => {
    harness.role = 'analyst';
    harness.sessions = 0;
    harness.store = new RouteTestStore();
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(to.searchParams.get('decline')).toBe('declined');
    expect(said(response)).toMatch(/logged as declined, not discarded/);

    // Who decided comes from the session, never from the form. The evidence
    // list is filtered to what coverage can add up, and the detail is trimmed.
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      deductionId: CASE_ID,
      reason: 'evidence_unavailable',
      decidedBy: 'reviewer@example.test',
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
    expect(said(response)).toBe('your role can review cases but not decide them');
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
      expect(said(response)).toBe('choose a reason for declining');
    }
    expect(store.calls).toHaveLength(0);
  });

  it('refuses a note longer than the field holds, rather than cutting it', async () => {
    // It used to `.slice(0, 2000)`: a reviewer who explained a decline at
    // length was recorded as having said the first 2000 characters of it, with
    // nothing anywhere saying the rest had been dropped. `declined_candidates`
    // is append-only and a decline is explained once, so half an explanation is
    // not a smaller version of the record — it is a different one.
    const store = harness.store as RouteTestStore;
    const tooLong = 'x'.repeat(DECLINE_DETAIL_MAX_LENGTH + 1);

    const response = await POST(
      declineRequest({ reason: 'below_economic_floor', detail: tooLong }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    const to = location(response);
    expect(to.pathname).toBe(`/cases/${CASE_ID}`);
    expect(to.searchParams.get('decline')).toBe('decline_detail_too_long');
    // The length it actually was, carried as a validated fragment, and the
    // limit from the one place that holds it.
    expect(to.searchParams.getAll(NOTICE_ABOUT_PARAM)).toEqual([
      String(DECLINE_DETAIL_MAX_LENGTH + 1),
    ]);
    expect(said(response)).toBe(
      `that note is ${DECLINE_DETAIL_MAX_LENGTH + 1} characters and this field holds ` +
        `${DECLINE_DETAIL_MAX_LENGTH} — shorten it, because a decline is only ever ` +
        'explained once and half an explanation is not one',
    );
    // Nothing was written: the reviewer edits and sends it again.
    expect(store.calls).toHaveLength(0);
  });

  it('measures the note after trimming, and records exactly what fits', async () => {
    // The stored value is the trimmed one, so the length that is checked is the
    // length that would be stored — a note that is only over the limit because
    // of the whitespace around it is not over the limit.
    const store = harness.store as RouteTestStore;
    const exact = 'y'.repeat(DECLINE_DETAIL_MAX_LENGTH);

    const response = await POST(
      declineRequest({ reason: 'below_economic_floor', detail: `  ${exact}  ` }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    expect(location(response).searchParams.get('decline')).toBe('declined');
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]?.detail).toBe(exact);
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
    expect(said(response)).toBe('this case was already declined; the first decline stands');
    expect(store.closed).toBe(1);
  });

  // Fought or declined, never both. The page offers the card only on a
  // classified case nobody decided; a crafted POST on a case awaiting approval
  // or already filed reaches the store, which refuses it before writing
  // anything (`decline-case.test.ts` counts the rows on Postgres). The route's
  // part is to say so, in the state's own words, rather than 500.
  it.each([
    ['awaiting_approval', 'awaiting approval'],
    ['submitted', 'submitted'],
  ] as const)('says a %s case was not declined, and why', async (state, words) => {
    const store = harness.store as RouteTestStore;
    store.throws = new CaseNotDeclinableError(CASE_ID, state);

    const response = await POST(declineRequest(), params(CASE_ID));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(to.pathname).toBe(`/cases/${CASE_ID}`);
    expect(to.searchParams.get('decline')).toBe('decline_wrong_state');
    expect(said(response)).toBe(
      `this case was not declined: it is ${words}, and a case is declined before anybody ` +
        'decides to fight it. The case is untouched.',
    );
    // Not the success sentence, and not a fault for the logs.
    expect(said(response)).not.toMatch(/logged as declined/);
    expect(logged).toHaveLength(0);
    expect(store.calls).toHaveLength(1);
    expect(store.closed).toBe(1);
  });

  it('says a case with a decision was not declined, whatever its state', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new CaseNotDeclinableError(
      CASE_ID,
      'classified',
      '55555555-5555-5555-5555-555555555555',
    );

    const response = await POST(declineRequest(), params(CASE_ID));
    expect(response.status).toBe(303);
    expect(location(response).searchParams.get('decline')).toBe('decline_decided');
    expect(said(response)).toMatch(/a decision to dispute it is already recorded/);
    expect(said(response)).toMatch(/The case is untouched/);
    expect(store.closed).toBe(1);
  });

  it('tells the reviewer plainly when the case does not say how it reached us', async () => {
    // The store refuses rather than attributing the decline to a guessed
    // channel, and the route says so rather than 500ing. Nothing was written:
    // the case is untouched, and the reviewer is told that in words instead of
    // being shown a success for a row that does not exist.
    const store = harness.store as RouteTestStore;
    store.throws = new ProvenanceUnknownError(
      CASE_ID,
      'its notice document 44444444-4444-4444-4444-444444444444 records no arrival',
      '44444444-4444-4444-4444-444444444444',
    );

    const response = await POST(declineRequest(), params(CASE_ID));
    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe(`/cases/${CASE_ID}`);
    expect(said(response)).toMatch(/was not declined/);
    // And it says which of the two refusals this is, because they ask
    // different things of the reader. This one is the notice whose arrival was
    // never recorded: nothing on this page can set `upload_id`, so the sentence
    // does not offer the reviewer a button — it says an operator can record it
    // (ADR 0024) and the case can be declined afterwards.
    expect(said(response)).toMatch(/predates provenance recording/);
    expect(said(response)).toMatch(/recorded by an operator/);
    // Not the sentence for the other fault, which would send them to attach a
    // notice that is already attached.
    expect(said(response)).not.toMatch(/Attach the notice/);
    // And it is in the logs, because this one is somebody's to fix.
    expect(logged).toHaveLength(1);
    expect(store.closed).toBe(1);
  });

  it('says to attach the notice when that is the fault, and not the other thing', async () => {
    // The same refusal from the store, for the other reason: no notice document
    // at all. `noticeDocumentId` is undefined, and that is how the route knows.
    // This one a reviewer can act on, so the sentence tells them to — and it
    // must not be the "predates provenance recording" sentence, which would
    // have them waiting on a migration for a case that only needs its notice.
    const store = harness.store as RouteTestStore;
    store.throws = new ProvenanceUnknownError(
      CASE_ID,
      'it has no notice document, so nothing on it says which channel found this deduction',
    );

    const response = await POST(declineRequest(), params(CASE_ID));
    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe(`/cases/${CASE_ID}`);
    expect(said(response)).toMatch(/no notice document on it/);
    expect(said(response)).toMatch(/Attach the notice/);
    expect(said(response)).not.toMatch(/predates provenance recording/);
    expect(logged).toHaveLength(1);
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
