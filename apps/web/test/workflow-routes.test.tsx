import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MAX_RATIONALE_LENGTH } from '@recouple/core-domain';
import {
  ConfirmationNumberRequiredError,
  InvalidRecoveryAmountError,
  PacketNotBuildableError,
} from '@recouple/pipeline';
import {
  ApprovalNamesNoPacketError,
  ApprovedPacketMissingError,
} from '@recouple/store-postgres';
import type { PostgresStore } from '@recouple/store-postgres';
import {
  CONFIRMATION_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  NOTICE_ABOUT_PARAM,
  resolveNotice,
} from '../lib/notices';
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

/** The notice key the redirect carried — never a sentence (`lib/notices.ts`). */
function key(response: Response): string | null {
  return location(response).searchParams.get('action');
}

/**
 * What the reviewer is actually told: the key, resolved.
 *
 * Through `resolveNotice` rather than read straight off the URL, so these
 * assertions are about the words a person sees *and* about the key reaching
 * them — a key that is not in the table, or a fragment that is not the shape
 * the key declares, resolves to nothing and every one of these fails.
 */
function said(response: Response): string | undefined {
  const at = location(response);
  return resolveNotice(
    at.searchParams.get('action') ?? undefined,
    at.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
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

    // A key, and not the sentence: what travels in the query string is
    // something this app can say and nothing else.
    expect(key(response)).toBe('decided');

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
    // The count and the hash are the only things in it that are not ours to
    // say, and each arrives as a fragment the table validates.
    expect(key(response)).toBe('packet_assembled');
    expect(location(response).searchParams.getAll(NOTICE_ABOUT_PARAM)).toEqual([
      '2',
      expect.stringMatching(/^[0-9a-f]{12}$/) as unknown as string,
    ]);
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
  it('serves the letter as plain text, to download rather than render', async () => {
    await assembled();
    const response = await coverSheet(new Request('https://app.example.test/'), params(CASE_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="dispute-letter-${CASE_ID.slice(0, 8)}.txt"`,
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // The narrative quotes text read off somebody else's document, so nothing
    // the browser might render it as may fetch, script or frame anything.
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    // A packet is what a person is about to authorise. A shared cache must not
    // hold it, and a stale copy of it is worse than none.
    expect(response.headers.get('cache-control')).toBe('private, no-store');
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
    // The approve call, and nothing after it: the store answers with the case
    // it approved, so the handler knows where the write landed without reading
    // a case back to find out.
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
      .seedDecline(CASE_ID, '12121212-1111-2222-3333-444444444444', {
        reason: 'below_economic_floor',
        estimatedRecoverableCents: AMOUNT_CENTS,
        missingEvidence: [],
        decidedBy: 'reviewer@example.test',
        decidedByVersion: 'human/v1',
        decidedAt: new Date('2026-09-20T09:30:00Z'),
      });

    const response = await decide(
      post('decide', { reason: 'shortage_quantity', rationale: 'worth fighting after all' }),
      params(CASE_ID),
    );
    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/the decline stands/);
    // And the case still reads as declined, with no decision beside it.
    const after = await store().getWorkflow(CASE_ID);
    expect(after?.decline?.declinedCandidateId).toBe('12121212-1111-2222-3333-444444444444');
    expect(after?.decision).toBeUndefined();
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

  it('assembles again while the packet waits, so evidence added after it gets in', async () => {
    const ready = await assembled();
    store().attach(CASE_ID, '13131313-1111-2222-3333-444444444444');

    const response = await assemble(
      post('packet', { decisionId: ready.decisionId }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(/packet assembled: 3 documents under [0-9a-f]{12}\./);
    const shown = await store().getWorkflow(CASE_ID);
    expect(shown?.state).toBe('awaiting_approval');
    expect(shown?.packet?.fileDocumentIds).toHaveLength(3);
    expect(shown?.packet?.contentHash).not.toBe(ready.hash);
  });

  it('refuses approving the packet a page showed before it was assembled again', async () => {
    const ready = await assembled();
    store().attach(CASE_ID, '13131313-1111-2222-3333-444444444444');
    const again = await store().assemblePacket({
      deductionId: CASE_ID,
      decisionId: ready.decisionId,
      assembledBy: ANALYST,
    });

    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');
    const stale = await approve(
      post('approve', { decisionId: ready.decisionId, packetId: ready.packetId }),
      params(CASE_ID),
    );
    expect(key(stale)).toBe('approve_superseded');
    expect(said(stale)).toMatch(
      new RegExp(`nothing was approved; check packet ${again.contentHash.slice(0, 12)} below`),
    );
    expect((await store().getWorkflow(CASE_ID))?.approval).toBeUndefined();

    const fresh = await approve(
      post('approve', { decisionId: ready.decisionId, packetId: again.packetId }),
      params(CASE_ID),
    );
    expect(key(fresh)).toBe('approved');
    expect((await store().getWorkflow(CASE_ID))?.approval?.packetHash).toBe(again.contentHash);
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


/**
 * The fixes PR #8's review asked for, and the refusals nothing was driving.
 *
 * Every one of these is a way a reviewer's work is lost quietly: a reference
 * cut to a length this app invented, a note cut the same way, a year nobody
 * typed, a filing recorded against a case they were not looking at. None of
 * them is a fault the store can catch — the store is handed something that is
 * already wrong by then.
 */
describe('what is refused rather than quietly shortened', () => {
  it('refuses a confirmation number longer than a confirmation, and names the length', async () => {
    // Sliced at 120 before this: a reference cut to fit chases nothing in the
    // retailer's portal, and it looks exactly like one that does.
    const ready = await approved();
    const before = store().calls.length;
    const long = 'WM-'.padEnd(CONFIRMATION_MAX_LENGTH + 1, 'X');

    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        approvalId: ready.approvalId,
        confirmationNumber: long,
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    expect(key(response)).toBe('submit_confirmation_too_long');
    expect(said(response)).toContain(String(CONFIRMATION_MAX_LENGTH));
    expect(said(response)).toContain(String(long.length));
    // Nothing was filed, and nothing was shortened into the record.
    expect(handlerCalls(before)).toHaveLength(0);
    expect(store().closed).toBe(0);
  });

  it('takes a confirmation number exactly as long as the limit', async () => {
    const ready = await approved();
    const before = store().calls.length;
    const exact = 'W'.repeat(CONFIRMATION_MAX_LENGTH);

    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        approvalId: ready.approvalId,
        confirmationNumber: exact,
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );

    expect(said(response)).toMatch(/filed/);
    expect(handlerCalls(before)[0]?.input).toMatchObject({ confirmationNumber: exact });
  });

  it('refuses an approval note longer than the field, and names the length', async () => {
    const ready = await assembled();
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');
    const before = store().calls.length;
    const long = 'n'.repeat(NOTE_MAX_LENGTH + 1);

    const response = await approve(
      post('approve', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        note: long,
      }),
      params(CASE_ID),
    );

    expect(key(response)).toBe('approve_note_too_long');
    expect(said(response)).toContain(String(NOTE_MAX_LENGTH));
    expect(said(response)).toContain(String(long.length));
    // Approving is a record of who authorised money moving. Half a sentence in
    // that record is worse than being asked to shorten it.
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('refuses an outcome note longer than the field, and names the length', async () => {
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
    const before = store().calls.length;
    const long = 'n'.repeat(NOTE_MAX_LENGTH + 1);

    const response = await outcome(
      post('outcome', { outcome: 'lost', note: long }),
      params(CASE_ID),
    );

    expect(key(response)).toBe('outcome_note_too_long');
    expect(said(response)).toContain(String(NOTE_MAX_LENGTH));
    expect(handlerCalls(before)).toHaveLength(0);
  });

  it('takes a note exactly as long as the field, on both', async () => {
    const ready = await assembled();
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');
    const exact = 'n'.repeat(NOTE_MAX_LENGTH);
    const before = store().calls.length;

    const response = await approve(
      post('approve', { decisionId: ready.decisionId, packetId: ready.packetId, note: exact }),
      params(CASE_ID),
    );
    expect(said(response)).toMatch(/approved/);
    expect(handlerCalls(before)[0]?.input).toMatchObject({ note: exact });
  });

  it('refuses a filing date outside the years a dispute could be filed in', async () => {
    // Four digits is not a year. `0001-01-01` and `9999-12-31` both parse and
    // neither is a day anybody filed on — and `submitted_at` is what a
    // follow-up and a deadline are counted from. The same window
    // `parsePrintedDate` holds a date read off a page to (ADR 0019).
    const ready = await approved();
    const before = store().calls.length;
    for (const submittedAt of ['0001-01-01', '1999-12-31', '2101-01-01', '9999-12-31']) {
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

    // …and the edges of the window are inside it.
    for (const submittedAt of ['2000-01-01', '2100-12-31']) {
      const at = store().calls.length;
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
      // The first one files it; the second meets the state check. Neither is
      // the date refusal, which is the point.
      expect(said(response), submittedAt).not.toBe('give the date it was filed, as YYYY-MM-DD');
      expect(handlerCalls(at).length, submittedAt).toBeGreaterThan(0);
    }
  });

  it('refuses a negative recovered amount in the store’s own words', async () => {
    // `-5` parses: `parseMoneyToCents` reads it as -500 cents, which is money
    // and not a typo this route can catch. The store is what knows a recovery
    // cannot be negative, and it says so by name.
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
    const before = store().calls.length;

    const response = await outcome(
      post('outcome', { outcome: 'partial', recovered: '-5' }),
      params(CASE_ID),
    );

    expect(handlerCalls(before)[0]?.input).toMatchObject({ recoveredCents: -500 });
    expect(key(response)).toBe('outcome_amount_refused');
    expect(said(response)).toBe('that amount cannot be right: a recovery cannot be negative');
  });

  it('says so without repeating a refusal it cannot show', async () => {
    // A reason that is not a sentence this app will repeat — a URL, markup,
    // something very long — is not passed through a query string and read back
    // out. The notice still says the amount was refused.
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
    store().throws = new InvalidRecoveryAmountError(
      CASE_ID,
      'partial',
      1,
      'see https://evil.test for why',
    );

    const response = await outcome(
      post('outcome', { outcome: 'partial', recovered: '0.01' }),
      params(CASE_ID),
    );
    expect(key(response)).toBe('outcome_amount_refused_unsaid');
    expect(said(response)).toMatch(/check it against the deduction/);
    expect(location(response).searchParams.getAll(NOTICE_ABOUT_PARAM)).toEqual([]);
  });
});

/**
 * The refusals that had no route test at all, driven through the store.
 *
 * Each is a named `CaseWorkflowError` the handler translates. A translation
 * nothing exercises is a translation that can be deleted without a failing
 * test, which is the same as not having one.
 */
describe('the refusals nothing was driving', () => {
  it('says why a packet could not be built, in the store’s own words', async () => {
    const decisionId = await decided();
    store().throws = new PacketNotBuildableError(
      CASE_ID,
      decisionId,
      'a packet with no documents is not a packet',
    );

    const response = await assemble(post('packet', { decisionId }), params(CASE_ID));
    expect(response.status).toBe(303);
    expect(key(response)).toBe('packet_not_buildable');
    expect(said(response)).toBe(
      'the packet could not be built: a packet with no documents is not a packet',
    );
    expect(store().closed).toBe(1);
  });

  it('says a packet could not be built without repeating a reason it cannot show', async () => {
    const decisionId = await decided();
    store().throws = new PacketNotBuildableError(CASE_ID, decisionId, 'see <b>this</b> instead');

    const response = await assemble(post('packet', { decisionId }), params(CASE_ID));
    expect(key(response)).toBe('packet_not_buildable_unsaid');
    expect(said(response)).toMatch(/nothing was assembled/);
  });

  it('asks again for a confirmation the store refused as missing', async () => {
    // The route asks first, so this is the store answering about something the
    // route thought it had. It is still a thing to fix rather than a 500.
    const ready = await approved();
    store().throws = new ConfirmationNumberRequiredError(ready.decisionId);

    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        approvalId: ready.approvalId,
        confirmationNumber: 'WM-1',
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );
    expect(response.status).toBe(303);
    expect(said(response)).toBe('record the confirmation number the portal gave back');
  });

  it('says an approval that named no packet authorises nothing in particular', async () => {
    // `approvals_packet_is_a_real_packet` is `MATCH SIMPLE`, so a null hash is
    // valid to the database — it has to be, for `writeoff` and `writeback`. A
    // `submit` approval with none authorises nothing, and the store refuses it.
    const ready = await approved();
    store().throws = new ApprovalNamesNoPacketError(ready.approvalId);

    const response = await submit(
      post('submit', {
        decisionId: ready.decisionId,
        packetId: ready.packetId,
        approvalId: ready.approvalId,
        confirmationNumber: 'WM-1',
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );
    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/names no packet/);
    expect(said(response)).toMatch(/approved again/);
  });

  it('says to assemble again when an approval names a hash nothing was assembled under', async () => {
    const ready = await assembled();
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');
    store().throws = new ApprovedPacketMissingError(ready.decisionId);

    const response = await approve(
      post('approve', { decisionId: ready.decisionId, packetId: ready.packetId }),
      params(CASE_ID),
    );
    expect(response.status).toBe(303);
    expect(said(response)).toMatch(/no packet with that hash was assembled/);
  });
});

/**
 * Where a reviewer is sent when the write did not land on the case they were
 * looking at.
 *
 * The ids travel on a form, and the store acts on the *decision's* case rather
 * than on the id in the URL. A stale tab, two cases open at once, or a forged
 * post can therefore approve or file one case while the browser is pointed at
 * another — and the old handlers redirected to the URL's case with a notice
 * saying it had happened there. The case would show nothing, under a sentence
 * saying a dispute had been filed.
 *
 * Which case it *did* land on is now the store's own answer: `approve` and
 * `recordSubmission` return the deduction they acted on, so the handler
 * compares it with the path and sends the reviewer to the case that changed.
 * The mechanism it replaces was a second `getWorkflow` on the path's case,
 * which could say "not here" but never "here instead" — and asked the database
 * again for something the write already knew.
 */
describe('a write that landed on another case', () => {
  const OTHER_CASE = '99999999-9999-9999-9999-999999999999';

  /** A second case of this same tenant, decided, packeted and approved. */
  async function otherCaseReady(): Promise<{
    decisionId: string;
    packetId: string;
    approvalId: string;
  }> {
    store().seedCase({
      deductionId: OTHER_CASE,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
      documentIds: [DOC_A],
    });
    const { decisionId } = await store().recordHumanDecision({
      deductionId: OTHER_CASE,
      preparedBy: ANALYST,
      reason: 'shortage_quantity',
      rationale: 'the other case',
    });
    const packet = await store().assemblePacket({
      deductionId: OTHER_CASE,
      decisionId,
      assembledBy: ANALYST,
    });
    return { decisionId, packetId: packet.packetId, approvalId: '' };
  }

  it('sends an approver to the case the approval landed on', async () => {
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
      documentIds: [DOC_A],
    });
    const other = await otherCaseReady();
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');

    const response = await approve(
      post('approve', { decisionId: other.decisionId, packetId: other.packetId }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    // The case the store approved, not the path's and not the list.
    expect(location(response).pathname).toBe(`/cases/${OTHER_CASE}`);
    expect(key(response)).toBe('approve_other_case');
    expect(said(response)).toMatch(/different case than the one you were looking at/);
    // And the handler learned where it landed from the write rather than by
    // reading a case back afterwards.
    expect(store().calls.filter((call) => call.method === 'getWorkflow')).toHaveLength(0);
    // The approval itself is real and stands: it was given against the packet
    // the form named, and `approvals` is append-only.
    expect((await store().getWorkflow(OTHER_CASE))?.approval).toBeDefined();
    expect((await store().getWorkflow(CASE_ID))?.approval).toBeUndefined();
  });

  it('does not call an upper-case link a different case', async () => {
    // The path id and the store's answer meet as strings: Postgres prints a
    // uuid in lower case and `isUuid` accepts either, so a reviewer who got to
    // the page through an upper-case link would otherwise be told their own
    // approval had landed somewhere else — and sent to the same case to read
    // about it.
    const ready = await assembled();
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');

    const shouted = CASE_ID.toUpperCase();
    const response = await approve(
      post('approve', { decisionId: ready.decisionId, packetId: ready.packetId }),
      params(shouted),
    );

    expect(key(response)).toBe('approved');
    expect(location(response).pathname).toBe(`/cases/${shouted}`);
  });

  it('sends a filer to the case the filing landed on', async () => {
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
      documentIds: [DOC_A],
    });
    const other = await otherCaseReady();
    store().setRole(APPROVER, 'approver');
    const { approvalId } = await store().approve({
      decisionId: other.decisionId,
      packetId: other.packetId,
      approverId: APPROVER,
    });

    const response = await submit(
      post('submit', {
        decisionId: other.decisionId,
        packetId: other.packetId,
        approvalId,
        confirmationNumber: 'WM-1',
        submittedAt: '2026-09-20',
      }),
      params(CASE_ID),
    );

    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe(`/cases/${OTHER_CASE}`);
    expect(key(response)).toBe('submit_other_case');
    expect(said(response)).toMatch(/different case than the one you were looking at/);
    expect(store().calls.filter((call) => call.method === 'getWorkflow')).toHaveLength(0);
    expect((await store().getWorkflow(OTHER_CASE))?.submission).toBeDefined();
    expect((await store().getWorkflow(CASE_ID))?.submission).toBeUndefined();
  });
});


/**
 * Where the double has to agree with the real store, because a route is tested
 * against it and shipped against the other.
 *
 * `FakeWorkflowStore` enforces rules, not storage: which state, which role,
 * which packet. A rule it gets wrong is a rule these route tests prove about
 * software nobody runs — and the two that were wrong were both of that kind.
 * The real store's answers are in `packages/store-postgres/src/workflow.ts` and
 * are tested against a real Postgres in that package.
 */
describe('the store double, where it has to agree with the real one', () => {
  it('lets any writer decide and assemble, as `WRITER_ROLES` does', async () => {
    // The real store passes `WRITER_ROLES` — owner, approver, analyst — to
    // `lockCase` for both `decide` and `assemble`: a `decisions` row is not an
    // outbound act, and an approver who prepares one is stopped from approving
    // it by separation of duties rather than from writing it (ADR 0020 §5). A
    // double that refused an approver here would prove a rule that does not
    // exist.
    for (const role of ['owner', 'approver', 'analyst']) {
      harness.store = new FakeWorkflowStore();
      harness.userId = APPROVER;
      harness.role = role;
      store().setRole(APPROVER, role);
      store().seedCase({
        deductionId: CASE_ID,
        state: 'classified',
        deductionAmountCents: AMOUNT_CENTS,
        documentIds: [DOC_A],
      });

      const decided = await decide(
        post('decide', { reason: 'shortage_quantity', rationale: 'theirs to prepare' }),
        params(CASE_ID),
      );
      expect(said(decided), role).toMatch(/Nothing has been sent/);

      const workflow = await store().getWorkflow(CASE_ID);
      const assembledIt = await assemble(
        post('packet', { decisionId: workflow?.decision?.decisionId ?? '' }),
        params(CASE_ID),
      );
      expect(said(assembledIt), role).toMatch(/packet assembled/);
    }
  });

  it('still refuses an approver’s approval of their own decision', async () => {
    // The other half of the same rule, and the reason widening the first one
    // gives nothing away: preparing is a write, approving is the gate.
    harness.userId = APPROVER;
    harness.role = 'approver';
    store().setRole(APPROVER, 'approver');
    store().seedCase({
      deductionId: CASE_ID,
      state: 'classified',
      deductionAmountCents: AMOUNT_CENTS,
      documentIds: [DOC_A],
    });
    const { decisionId } = await store().recordHumanDecision({
      deductionId: CASE_ID,
      preparedBy: APPROVER,
      reason: 'shortage_quantity',
      rationale: 'prepared by the approver',
    });
    const packet = await store().assemblePacket({
      deductionId: CASE_ID,
      decisionId,
      assembledBy: APPROVER,
    });

    const response = await approve(
      post('approve', { decisionId, packetId: packet.packetId }),
      params(CASE_ID),
    );
    expect(said(response)).toBe(
      'you prepared this decision, so you cannot approve it — a second person does that',
    );
  });

  it('reads back the packet the approval named, not the first one assembled', async () => {
    // `unique (decision_id, content_hash)` means re-assembling different
    // contents is a *second* row, and the approval names exactly one of them.
    // The real `getWorkflow` reads the approval first and fetches that packet;
    // taking the first match instead showed a reviewer a packet nobody
    // approved, which is the one thing the approve card must get right.
    const ready = await assembled();
    store().setRole(APPROVER, 'approver');
    const second = store().seedPacket({
      decisionId: ready.decisionId,
      narrative: '# Dispute cover sheet (re-assembled)',
      fileDocumentIds: [DOC_A],
    });
    expect(second.contentHash).not.toBe(ready.hash);

    // With no approval, the latest is what a reviewer is looking at.
    expect((await store().getWorkflow(CASE_ID))?.packet?.packetId).toBe(second.packetId);

    // With one, it is the packet that approval named. `approve` now refuses
    // any packet but the latest (`PacketSupersededError`), so an approval of an
    // earlier one exists only in data recorded before that rule — seeded here,
    // because the page still has to show what those approvals named.
    store().seedApproval({
      decisionId: ready.decisionId,
      packetHash: ready.hash,
      approverId: APPROVER,
    });
    const after = await store().getWorkflow(CASE_ID);
    expect(after?.packet?.packetId).toBe(ready.packetId);
    expect(after?.packet?.contentHash).toBe(after?.approval?.packetHash);
  });
});
