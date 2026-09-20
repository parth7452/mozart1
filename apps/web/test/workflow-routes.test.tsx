import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MAX_RATIONALE_LENGTH } from '@recouple/core-domain';
import type { PostgresStore } from '@recouple/store-postgres';
import { FakeWorkflowStore } from './fake-workflow-store';

/**
 * The five Phase 3 routes, and everything that is not their happy path.
 *
 * These handlers are the near side of the approval gate: one of them writes the
 * `decisions` row an approval points at, one writes the approval itself, and
 * one records a dispute a person filed on a portal. None of them can reach the
 * far side on its own — the database refuses a submission with no approval for
 * that exact decision whatever this code believes — but every one of them can
 * *lose* something a reviewer did, and that is what is tested here: which check
 * runs first, what reaches the store, and what the reviewer is told when the
 * answer is no.
 *
 * The store is `FakeWorkflowStore`, which enforces the same rules in a Map. The
 * real one is tested against a real Postgres, where the triggers are; what is
 * tested here is the handler.
 */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
/** The analyst whose session these tests run in, unless a test says otherwise. */
const ANALYST = '22222222-2222-2222-2222-222222222222';
const APPROVER = '44444444-4444-4444-4444-444444444444';
const DOC_A = '55555555-5555-5555-5555-555555555555';
const DOC_B = '66666666-6666-6666-6666-666666666666';

const AMOUNT_CENTS = 312_000;

const harness = vi.hoisted(() => ({
  store: undefined as FakeWorkflowStore | undefined,
  role: 'analyst' as string,
  userId: '22222222-2222-2222-2222-222222222222',
  /** How many times the session was resolved, so ordering can be asserted. */
  sessions: 0,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: harness.userId,
      email: 'reviewer@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
      orgs: [],
    };
  },
  // `workflowStoreFor` is the real one: it hands back the session's store,
  // which is the whole point of the file. Only what it wraps is a stand-in.
  storeFor: () => harness.store as unknown as PostgresStore,
}));

vi.mock('../lib/pipeline', () => ({
  mayWrite: (role: string) => role !== 'read_only' && role !== 'accountant_guest',
}));

const { POST: decide } = await import('../app/cases/[id]/decide/route');
const { POST: assemble, GET: coverSheet } = await import('../app/cases/[id]/packet/route');
const { POST: approve } = await import('../app/cases/[id]/approve/route');
const { POST: submit } = await import('../app/cases/[id]/submit/route');
const { POST: outcome } = await import('../app/cases/[id]/outcome/route');

function post(
  action: string,
  fields: Record<string, string> = {},
  secFetchSite?: string,
): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const headers = new Headers();
  if (secFetchSite !== undefined) headers.set('sec-fetch-site', secFetchSite);
  return new NextRequest(`https://app.example.test/cases/${CASE_ID}/${action}`, {
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

/** What the reviewer is told, carried back on the redirect. */
function said(response: Response): string | null {
  return location(response).searchParams.get('action');
}

function store(): FakeWorkflowStore {
  return harness.store as FakeWorkflowStore;
}

/** A case somebody has decided to dispute. */
async function decided(): Promise<string> {
  store().seedCase({
    deductionId: CASE_ID,
    state: 'classified',
    deductionAmountCents: AMOUNT_CENTS,
    documentIds: [DOC_A, DOC_B],
  });
  const { decisionId } = await store().recordHumanDecision({
    deductionId: CASE_ID,
    preparedBy: ANALYST,
    reason: 'shortage_quantity',
    rationale: 'The signed BOL shows all 30 cases delivered.',
  });
  return decisionId;
}

/** …and a packet assembled for it. */
async function assembled(): Promise<{ decisionId: string; packetId: string; hash: string }> {
  const decisionId = await decided();
  const packet = await store().assemblePacket({
    deductionId: CASE_ID,
    decisionId,
    assembledBy: ANALYST,
  });
  return { decisionId, packetId: packet.packetId, hash: packet.contentHash };
}

/** …and a second person's approval of it. */
async function approved(): Promise<{
  decisionId: string;
  packetId: string;
  hash: string;
  approvalId: string;
}> {
  const ready = await assembled();
  store().setRole(APPROVER, 'approver');
  const { approvalId } = await store().approve({
    decisionId: ready.decisionId,
    packetId: ready.packetId,
    approverId: APPROVER,
  });
  return { ...ready, approvalId };
}

/** Only the calls a handler made, with the ones the fixture made dropped. */
function handlerCalls(from: number): { method: string; input: unknown }[] {
  return store().calls.slice(from);
}

beforeEach(() => {
  harness.role = 'analyst';
  harness.userId = ANALYST;
  harness.sessions = 0;
  harness.store = new FakeWorkflowStore();
});

describe('deciding to dispute', () => {
  it('records the decision as the session’s own, and says nothing was sent', async () => {
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
    });
    const response = await decide(
      post('decide', {
        reason: 'shortage_quantity',
        rationale: '  The signed BOL shows all 30 cases delivered.  ',
      }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe(`/cases/${CASE_ID}`);
    expect(said(response)).toMatch(/Nothing has been sent/);

    // Who decided comes from the session and never from the form: the database
    // refuses a human decision that names anyone but its caller, and the column
    // it refuses on is the one separation of duties reads.
    expect(store().calls[0]).toEqual({
      method: 'recordHumanDecision',
      input: {
        deductionId: CASE_ID,
        preparedBy: ANALYST,
        reason: 'shortage_quantity',
        rationale: 'The signed BOL shows all 30 cases delivered.',
      },
    });
    expect(store().closed).toBe(1);
  });

  it('refuses a cross-site POST with a 403, before the session is resolved', async () => {
    const response = await decide(post('decide', {}, 'cross-site'), params(CASE_ID));
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.sessions).toBe(0);
    expect(store().calls).toHaveLength(0);
  });

  it('sends an id that is not a UUID to the case list, not to Postgres', async () => {
    for (const id of ['------------------------------------', 'not-a-uuid', `${CASE_ID}x`]) {
      const response = await decide(post('decide', { reason: 'shortage_quantity' }), params(id));
      expect(response.status).toBe(303);
      expect(location(response).pathname).toBe('/');
    }
    expect(store().calls).toHaveLength(0);
  });

  it('tells a read_only member why, rather than letting the policy say it', async () => {
    harness.role = 'read_only';
    const response = await decide(
      post('decide', { reason: 'shortage_quantity', rationale: 'x' }),
      params(CASE_ID),
    );
    expect(said(response)).toBe('your role can review cases but not decide them');
    expect(store().calls).toHaveLength(0);
  });

  it('refuses a reason outside the canonical taxonomy', async () => {
    // A retailer's own code maps onto a canonical one through playbook data. A
    // reason that is neither is a row nothing can ever count.
    for (const reason of ['', 'because I said so', 'SHORTAGE_QUANTITY']) {
      const response = await decide(post('decide', { reason, rationale: 'x' }), params(CASE_ID));
      expect(said(response)).toBe('choose the reason this deduction is invalid');
    }
    expect(store().calls).toHaveLength(0);
  });

  it('asks for a rationale rather than recording a decision with none', async () => {
    for (const rationale of ['', '   ']) {
      const response = await decide(
        post('decide', { reason: 'shortage_quantity', rationale }),
        params(CASE_ID),
      );
      expect(said(response)).toMatch(/say in one line why/);
    }
    expect(store().calls).toHaveLength(0);
  });

  it('says what state the case is really in when it is not one to decide from', async () => {
    store().seedCase({
      deductionId: CASE_ID,
      state: 'awaiting_approval',
      deductionAmountCents: AMOUNT_CENTS,
    });
    const response = await decide(
      post('decide', { reason: 'shortage_quantity', rationale: 'x' }),
      params(CASE_ID),
    );
    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/this case is awaiting approval/);
    expect(store().closed).toBe(1);
  });

  it('does not swallow an error it does not recognise', async () => {
    // Fail loud. `decisions` is append-only, so a decision that did not happen
    // is not something a later write repairs.
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
    });
    store().throws = new Error('connection terminated unexpectedly');
    await expect(
      decide(post('decide', { reason: 'shortage_quantity', rationale: 'x' }), params(CASE_ID)),
    ).rejects.toThrow('connection terminated unexpectedly');
    expect(store().closed).toBe(1);
  });
});

describe('assembling the packet', () => {
  it('assembles it and says what is in it and that it went nowhere', async () => {
    const decisionId = await decided();
    const before = store().calls.length;

    const response = await assemble(post('packet', { decisionId }), params(CASE_ID));
    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/packet assembled: 2 documents under [0-9a-f]{12}\./);
    expect(said(response)).toMatch(/a second person approves it/);
    expect(handlerCalls(before)).toEqual([
      { method: 'assemblePacket', input: { deductionId: CASE_ID, decisionId, assembledBy: ANALYST } },
    ]);
  });

  it('refuses a cross-site POST before the session is resolved', async () => {
    const response = await assemble(post('packet', {}, 'cross-site'), params(CASE_ID));
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
  });

  it('will not send a decision id that is not a UUID to Postgres', async () => {
    await decided();
    const before = store().calls.length;
    for (const decisionId of ['', 'not-a-uuid']) {
      const response = await assemble(post('packet', { decisionId }), params(CASE_ID));
      expect(said(response)).toBe('this case has no decision to assemble a packet for');
    }
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('tells a read_only member why', async () => {
    harness.role = 'read_only';
    const response = await assemble(
      post('packet', { decisionId: '77777777-7777-7777-7777-777777777777' }),
      params(CASE_ID),
    );
    expect(said(response)).toBe('your role can review cases but not assemble a packet');
    expect(store().calls).toHaveLength(0);
  });

  it('sends a non-UUID case to the list', async () => {
    const response = await assemble(post('packet', {}), params('not-a-uuid'));
    expect(location(response).pathname).toBe('/');
    expect(store().calls).toHaveLength(0);
  });
});

describe('the cover sheet', () => {
  it('serves the narrative as markdown, to download rather than render', async () => {
    await assembled();
    const response = await coverSheet(new Request('https://app.example.test/'), params(CASE_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('# Dispute cover sheet');
    expect(store().closed).toBe(1);
  });

  it('is a 404 for a case this session cannot see, not a 500', async () => {
    // Nothing is seeded, which is what a case belonging to another tenant looks
    // like through RLS: absent. A 403 would confirm it exists.
    const response = await coverSheet(new Request('https://app.example.test/'), params(CASE_ID));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not found');
  });

  it('is a 404 for a case with no packet yet', async () => {
    await decided();
    const response = await coverSheet(new Request('https://app.example.test/'), params(CASE_ID));
    expect(response.status).toBe(404);
  });

  it('answers a malformed id without resolving a session at all', async () => {
    const response = await coverSheet(
      new Request('https://app.example.test/'),
      params('------------------------------------'),
    );
    expect(response.status).toBe(404);
    expect(harness.sessions).toBe(0);
  });
});

describe('approving a packet', () => {
  it('records the approval as the session’s own and says what it authorises', async () => {
    const ready = await assembled();
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');
    const before = store().calls.length;

    const response = await approve(
      post('approve', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        note: '  Checked the BOL.  ',
      }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/approved/);
    expect(handlerCalls(before)).toEqual([
      {
        method: 'approve',
        input: {
          decisionId: ready.decisionId,
          packetId: ready.packetId,
          approverId: APPROVER,
          note: 'Checked the BOL.',
        },
      },
    ]);
  });

  it('refuses anyone who is not an owner or an approver, before the database has to', async () => {
    // An analyst prepares and assembles; a `read_only` member does neither.
    // Both are refused here for the same reason, and neither reaches the store.
    const ready = await assembled();
    const before = store().calls.length;
    for (const role of ['analyst', 'read_only', 'accountant_guest']) {
      harness.role = role;
      const response = await approve(
        post('approve', { decisionId: ready.decisionId, packetId: ready.packetId }),
        params(CASE_ID),
      );
      expect(said(response), role).toMatch(/owner or approver/);
    }
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('says so when the approver is the person who prepared the decision', async () => {
    // Separation of duties. The button is not rendered for them either, but the
    // refusal has to be legible when it is the database that says no.
    const ready = await assembled();
    harness.role = 'owner';
    store().setRole(ANALYST, 'owner');
    const before = store().calls.length;

    const response = await approve(
      post('approve', { decisionId: ready.decisionId, packetId: ready.packetId }),
      params(CASE_ID),
    );
    expect(said(response)).toBe(
      'you prepared this decision, so you cannot approve it — a second person does that',
    );
    expect(handlerCalls(before)).toHaveLength(1);
    expect(store().closed).toBe(1);
  });

  it('refuses a cross-site POST before the session is resolved', async () => {
    const response = await approve(post('approve', {}, 'cross-site'), params(CASE_ID));
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
  });

  it('sends a non-UUID case to the list, and refuses ids that are not UUIDs', async () => {
    harness.role = 'owner';
    const bad = await approve(post('approve', {}), params('not-a-uuid'));
    expect(location(bad).pathname).toBe('/');

    const missing = await approve(
      post('approve', { decisionId: 'nope', packetId: 'nope' }),
      params(CASE_ID),
    );
    expect(said(missing)).toBe('this case has no assembled packet to approve');
    expect(store().calls).toHaveLength(0);
  });
});

describe('recording the filing', () => {
  it('records it on the manual portal, with the date and the confirmation', async () => {
    const ready = await approved();
    const before = store().calls.length;

    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        approvalId: ready.approvalId,
        confirmationNumber: '  WM-DISPUTE-99812  ',
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/filed/);
    const call = handlerCalls(before)[0];
    expect(call?.method).toBe('recordSubmission');
    expect(call?.input).toEqual({
      decisionId: ready.decisionId,
      packetId: ready.packetId,
      approvalId: ready.approvalId,
      // Fixed in the handler, never read from the form: there is one channel,
      // and a form that could name another would name a way of filing we
      // cannot do.
      channel: 'manual_portal',
      confirmationNumber: 'WM-DISPUTE-99812',
      submittedAt: new Date('2026-09-20T00:00:00Z'),
      actorId: ANALYST,
    });
  });

  it('asks for the confirmation number rather than filing without one', async () => {
    const ready = await approved();
    const before = store().calls.length;
    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        approvalId: ready.approvalId,
        confirmationNumber: '   ',
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(/confirmation number/);
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('refuses a date it would have to guess at', async () => {
    const ready = await approved();
    const before = store().calls.length;
    for (const submittedAt of ['', 'yesterday', '20/09/2026', '2026-02-31', '2026-9-20']) {
      const response = await submit(
        post('submit', {
          decisionId: ready.decisionId,
          packetId: ready.packetId,
          approvalId: ready.approvalId,
          confirmationNumber: 'WM-1',
          submittedAt,
        }),
        params(CASE_ID),
      );
      expect(said(response), submittedAt).toBe('give the date it was filed, as YYYY-MM-DD');
    }
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('refuses a packet that is not the one that was approved', async () => {
    const ready = await approved();
    // A second packet for the same decision: different contents, different
    // hash, and an approval that names the first one.
    const other = store().seedPacket({
      decisionId: ready.decisionId,
      narrative: '# Dispute cover sheet (re-assembled)',
      fileDocumentIds: [DOC_A],
    });
    expect(other.contentHash).not.toBe(ready.hash);

    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: other.packetId,
        approvalId: ready.approvalId,
        confirmationNumber: 'WM-1',
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(/not the one that was approved/);
  });

  it('lets the first filing stand when the form is submitted twice', async () => {
    const ready = await approved();
    const fields = {
      decisionId: ready.decisionId,
      packetId: ready.packetId,
      approvalId: ready.approvalId,
      confirmationNumber: 'WM-1',
      submittedAt: '2026-09-20',
    };
    await submit(post('submit', fields), params(CASE_ID));
    // The case is `submitted` now, so the state check answers first — which is
    // also a refusal a reviewer can read, and not a second dispute.
    const again = await submit(post('submit', fields), params(CASE_ID));
    expect(again.status).toBe(303);
    expect(said(again)).toMatch(/this case is submitted/);
  });

  it('refuses a cross-site POST, a non-UUID case and a read_only member', async () => {
    expect((await submit(post('submit', {}, 'cross-site'), params(CASE_ID))).status).toBe(403);
    expect(harness.sessions).toBe(0);

    expect(location(await submit(post('submit', {}), params('not-a-uuid'))).pathname).toBe('/');

    harness.role = 'read_only';
    const refused = await submit(post('submit', {}), params(CASE_ID));
    expect(said(refused)).toBe('your role can review cases but not record a filing');
    expect(store().calls).toHaveLength(0);
  });
});

describe('recording the outcome', () => {
  async function filed(): Promise<void> {
    const ready = await approved();
    await store().recordSubmission({
      decisionId: ready.decisionId,
      packetId: ready.packetId,
      approvalId: ready.approvalId,
      channel: 'manual_portal',
      confirmationNumber: 'WM-1',
      submittedAt: new Date('2026-09-20T00:00:00Z'),
      actorId: ANALYST,
    });
  }

  it('parses the money a person typed into whole cents', async () => {
    await filed();
    const before = store().calls.length;

    const response = await outcome(
      post('outcome', { outcome: 'partial', recovered: ' $1,800.00 ', note: ' half of it ' }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    expect(said(response)).toBe('recorded: this case is partial');
    expect(handlerCalls(before)).toEqual([
      {
        method: 'recordOutcome',
        input: {
          deductionId: CASE_ID,
          outcome: 'partial',
          recoveredCents: 180_000,
          recordedBy: ANALYST,
          note: 'half of it',
        },
      },
    ]);
  });

  it('refuses an amount it would have to round, and never makes a float of it', async () => {
    // `12.345` is three decimal places on a money path. Rounding it would be
    // inventing somebody's recovery, and `Number(text)` would have taken it.
    await filed();
    const before = store().calls.length;
    // `1 800.00` is not here: `parseMoneyToCents` strips whitespace and reads
    // it as $1,800, which is its rule for money printed on a page and not this
    // route's to second-guess.
    for (const recovered of ['12.345', '1800.5', '1,80.00', 'lots', '1e3', '-0.01x']) {
      const response = await outcome(
        post('outcome', { outcome: 'partial', recovered }),
        params(CASE_ID),
      );
      expect(said(response), recovered).toMatch(/dollars and cents/);
    }
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('reads an empty amount as nothing recovered, which is what lost means', async () => {
    await filed();
    const before = store().calls.length;
    const response = await outcome(post('outcome', { outcome: 'lost', recovered: '' }), params(CASE_ID));
    expect(said(response)).toBe('recorded: this case is lost');
    expect(handlerCalls(before)[0]?.input).toMatchObject({ outcome: 'lost', recoveredCents: 0 });
  });

  it('says why an amount the outcome cannot have produced is refused', async () => {
    await filed();
    const response = await outcome(
      // More than the deduction: not a typo the store should accept quietly.
      post('outcome', { outcome: 'partial', recovered: '9,999.00' }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(/that amount cannot be right: /);
    expect(said(response)).toMatch(/less than the deduction/);
  });

  it('refuses an outcome that is not one of the three', async () => {
    await filed();
    const before = store().calls.length;
    for (const value of ['', 'settled', 'WON']) {
      const response = await outcome(post('outcome', { outcome: value }), params(CASE_ID));
      expect(said(response)).toBe('say what came back: won, partial or lost');
    }
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('says what state the case is in when it was never filed', async () => {
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
    });
    const response = await outcome(
      post('outcome', { outcome: 'won', recovered: '3,120.00' }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(/this case is classified/);
  });

  it('refuses a cross-site POST, a non-UUID case and a read_only member', async () => {
    expect((await outcome(post('outcome', {}, 'cross-site'), params(CASE_ID))).status).toBe(403);
    expect(harness.sessions).toBe(0);

    expect(location(await outcome(post('outcome', {}), params('not-a-uuid'))).pathname).toBe('/');

    harness.role = 'read_only';
    const refused = await outcome(post('outcome', { outcome: 'won' }), params(CASE_ID));
    expect(said(refused)).toBe('your role can review cases but not record an outcome');
    expect(store().calls).toHaveLength(0);
  });
});

/**
 * The refusals the store gained when it landed (ADR 0020, PR #7).
 *
 * Each one is a named `CaseWorkflowError` rather than a message a route could
 * match on, and each is a thing a reviewer will actually meet: a case they
 * cannot see, a case already given up on, a rationale the cover sheet cannot
 * hold, a packet assembled after the approval that named the one before it, a
 * second approval, a filing with nothing authorising it. A refusal that reached
 * a reviewer as a 500 would lose what they typed and tell them nothing.
 */
describe('the store’s named refusals, as a reviewer meets them', () => {
  it('answers 404 for a case this session cannot see, on every action', async () => {
    // Nothing seeded: what another tenant's case looks like through RLS. A
    // redirect back to the case would 404 on the next render anyway, and a 403
    // would confirm the case exists somewhere.
    const posts: [string, (r: NextRequest, p: { params: Promise<{ id: string }> }) => Promise<Response>, Record<string, string>][] = [
      ['decide', decide, { reason: 'shortage_quantity', rationale: 'x' }],
      ['outcome', outcome, { outcome: 'lost' }],
    ];
    for (const [name, handler, fields] of posts) {
      const response = await handler(post(name, fields), params(CASE_ID));
      expect(response.status, name).toBe(404);
      expect(response.headers.get('location'), name).toBeNull();
    }
    // …and the store is still released on the way out.
    expect(store().closed).toBe(posts.length);
  });

  it('refuses to dispute a case that was already declined', async () => {
    // Both at once would count this case as given up on and acted on, which
    // moves the one number the counterfactual log exists to produce.
    store()
      .seedCase({ deductionId: CASE_ID, state: 'classified', deductionAmountCents: AMOUNT_CENTS })
      .seedDecline(CASE_ID, '12121212-1111-2222-3333-444444444444');

    const response = await decide(
      post('decide', { reason: 'shortage_quantity', rationale: 'worth fighting after all' }),
      params(CASE_ID),
    );
    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/the decline stands/);
  });

  it('says how long a rationale may be rather than storing a truncated one', async () => {
    // The route sends what was typed, whole: the cap belongs to the packet
    // narrative, and `decisions` is append-only, so a rationale that only the
    // packet could refuse would wedge the case in `analyst_review`.
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
    });
    const response = await decide(
      post('decide', {
        reason: 'shortage_quantity',
        rationale: 'x'.repeat(MAX_RATIONALE_LENGTH + 1),
      }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(
      new RegExp(`${MAX_RATIONALE_LENGTH + 1} characters and the cover sheet holds ${MAX_RATIONALE_LENGTH}`),
    );
    // Nothing was written, and nothing was silently shortened.
    expect(await store().getWorkflow(CASE_ID)).toMatchObject({ state: 'classified' });
  });

  it('will not assemble a packet for a case with no notice on it', async () => {
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
    });
    const { decisionId } = await store().recordHumanDecision({
      deductionId: CASE_ID,
      preparedBy: ANALYST,
      reason: 'shortage_quantity',
      rationale: 'nothing attached',
    });

    const response = await assemble(post('packet', { decisionId }), params(CASE_ID));
    expect(said(response)).toMatch(/no notice on this case to send/);
  });

  it('refuses a packet assembled after the approval that named the one before it', async () => {
    const ready = await approved();
    // A document attached after approval changes what a packet would contain,
    // and there is one approval per decision — so this packet could never be
    // approved. Said now rather than as a puzzling hash mismatch at filing.
    store().attach(CASE_ID, '13131313-1111-2222-3333-444444444444');

    const response = await assemble(
      post('packet', { decisionId: ready.decisionId }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(
      new RegExp(`already approved as packet ${ready.hash.slice(0, 12)}`),
    );
  });

  it('lets the first approval stand when the button is pressed twice', async () => {
    const ready = await assembled();
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');
    const fields = { decisionId: ready.decisionId, packetId: ready.packetId };

    const first = await approve(post('approve', fields), params(CASE_ID));
    expect(said(first)).toMatch(/approved/);

    const again = await approve(post('approve', fields), params(CASE_ID));
    expect(again.status).toBe(303);
    expect(said(again)).toMatch(/the first approval stands/);
  });

  it('refuses a filing whose approval id names no approval of this decision', async () => {
    // The store asks first so this can be read; `app.require_approval('submit')`
    // asks last and is the one that decides.
    const ready = await assembled();
    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        approvalId: '14141414-1111-2222-3333-444444444444',
        confirmationNumber: 'WM-1',
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(/no approval, so there is nothing to file/);
  });
});
