import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { cents } from '@recouple/core-domain';
import {
  SettlementApprovalRefusedError,
  SettlementVoidRefusedError,
  type CasePosting,
  type LedgerHoldsNothing,
  type VoidRefusal,
} from '@recouple/store-postgres';

/**
 * ADR 0060's web half: the settings switch and map, moment 1's one button,
 * moment 2's settlement, and "Check QuickBooks and retry". The store, the
 * queue and the deployment's answer are stand-ins; no test here reaches a
 * database, Inngest or QuickBooks.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const DECISION_ID = '55555555-5555-4555-8555-555555555555';
const PACKET_ID = '66666666-6666-4666-8666-666666666666';
const WRITEBACK_ID = '77777777-7777-4777-8777-777777777777';

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  posting: true,
  calls: [] as Array<[string, ...unknown[]]>,
  queued: [] as unknown[],
  casePosting: undefined as unknown,
  approveSettlementError: undefined as Error | undefined,
  mayWrite: true,
  /** What QuickBooks holds under a posting's reference: rows, or a failure. */
  ledger: 'empty' as 'empty' | 'holds' | 'throws' | 'no_client',
  referencesAsked: [] as Array<[string, string]>,
  voidRefusal: undefined as string | undefined,
}));

function ready(overrides: Partial<CasePosting> = {}): CasePosting {
  return {
    connection: { connectionId: CONNECTION_ID, postingEnabled: true, hasMap: true },
    ledgerInvoiceId: '71',
    writebacks: [],
    settlement: undefined,
    ...overrides,
  };
}

const postingStore = {
  async postingForCase(id: string) {
    harness.calls.push(['postingForCase', id]);
    return harness.casePosting;
  },
  async setPostingEnabled(connectionId: string, enabled: boolean) {
    harness.calls.push(['setPostingEnabled', connectionId, enabled]);
  },
  async approveSettlement(decisionId: string) {
    harness.calls.push(['approveSettlement', decisionId]);
    if (harness.approveSettlementError !== undefined) throw harness.approveSettlementError;
    return { deductionId: CASE_ID, writeoffCents: cents(0) };
  },
  async insertWriteoff(input: unknown) {
    harness.calls.push(['insertWriteoff', input]);
    return { writeoffId: 'x' };
  },
  async memberMayWrite() {
    return harness.mayWrite;
  },
  async postingConnections() {
    return [{ connectionId: CONNECTION_ID, realmId: '9130' }];
  },
  async voidSettlementPosting(input: { decisionId: string; ledgerHoldsNothing: LedgerHoldsNothing }) {
    if (harness.voidRefusal !== undefined) {
      throw new SettlementVoidRefusedError(input.decisionId, harness.voidRefusal as VoidRefusal);
    }
    const nothing = await input.ledgerHoldsNothing([
      { writebackId: WRITEBACK_ID, method: 'journal_entry' },
    ]);
    if (!nothing) throw new SettlementVoidRefusedError(input.decisionId, 'in_ledger');
    harness.calls.push(['voidSettlementPosting', input.decisionId]);
    return { deductionId: CASE_ID, writebackIds: [WRITEBACK_ID] };
  },
  async requeueWriteback(writebackId: string) {
    harness.calls.push(['requeueWriteback', writebackId]);
    return { deductionId: CASE_ID, connectionId: CONNECTION_ID };
  },
};

const workflowStore = {
  async approve(input: unknown) {
    harness.calls.push(['approve', input]);
    return { approvalId: 'a', deductionId: CASE_ID };
  },
  async close() {
    return undefined;
  },
};

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'someone@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
  storeFor: () => workflowStore,
}));

vi.mock('../lib/pipeline', () => ({
  mayWrite: (role: string) => role !== 'read_only',
}));

vi.mock('../lib/qbo-posting', () => ({
  qboPostingFromEnv: () =>
    harness.posting
      ? {
          accountTypesFor: () => undefined,
          clientFor: () =>
            harness.ledger === 'no_client'
              ? undefined
              : {
                  findByReference: async (entity: string, reference: string) => {
                    harness.referencesAsked.push([entity, reference]);
                    if (harness.ledger === 'throws') throw new Error('Intuit said: Acme Foods, token abc123');
                    return harness.ledger === 'holds' ? [{ Id: '301' }] : [];
                  },
                },
        }
      : undefined,
}));

vi.mock('../lib/posting', () => ({
  postingStoreFor: () => postingStore,
  queueWriteback: async (_session: unknown, input: unknown) => {
    harness.queued.push(input);
    return true;
  },
  queueDecisionPostings: async (_session: unknown, _store: unknown, input: unknown) => {
    harness.calls.push(['queueDecisionPostings', input]);
    return true;
  },
}));

const { POST: approve } = await import('../app/cases/[id]/approve/route');
const { POST: settle } = await import('../app/cases/[id]/settle/route');
const { POST: retry } = await import('../app/cases/[id]/retry-writeback/route');
const { POST: voidPosting } = await import('../app/cases/[id]/void-posting/route');
const { POST: toggle } = await import('../app/settings/quickbooks/posting/route');
const { POST: saveMap } = await import('../app/settings/quickbooks/account-map/route');
const { CaseActions } = await import('../components/case-actions');
const { CasePostingCard } = await import('../components/case-posting');

function post(path: string, fields: Record<string, string>, site = 'same-origin'): NextRequest {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    body,
    headers: { 'sec-fetch-site': site },
  });
}
const params = { params: Promise.resolve({ id: CASE_ID }) };
const notice = (response: Response, key = 'action'): string | null =>
  new URL(response.headers.get('location') ?? 'https://x').searchParams.get(key);

beforeEach(() => {
  harness.role = 'owner';
  harness.posting = true;
  harness.calls = [];
  harness.queued = [];
  harness.casePosting = ready();
  harness.approveSettlementError = undefined;
  harness.mayWrite = true;
  harness.ledger = 'empty';
  harness.referencesAsked = [];
  harness.voidRefusal = undefined;
});

describe('every posting POST refuses cross-site', () => {
  it.each([
    ['approve', () => approve(post('/cases/x/approve', {}, 'cross-site'), params)],
    ['settle', () => settle(post('/cases/x/settle', {}, 'cross-site'), params)],
    ['retry', () => retry(post('/cases/x/retry-writeback', {}, 'cross-site'), params)],
    ['void', () => voidPosting(post('/cases/x/void-posting', {}, 'cross-site'), params)],
    ['switch', () => toggle(post('/settings/quickbooks/posting', {}, 'cross-site'))],
    ['map', () => saveMap(post('/settings/quickbooks/account-map', {}, 'cross-site'))],
  ])('%s', async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(403);
    expect(harness.calls).toEqual([]);
  });
});

describe('without QBO_POSTING nothing posts', () => {
  beforeEach(() => {
    harness.posting = false;
  });

  it('the switch, the map, settle and retry refuse before touching the store', async () => {
    expect(notice(await toggle(post('/settings/quickbooks/posting', { connectionId: CONNECTION_ID, enabled: 'on' })), 'qbo')).toBe('posting_off');
    expect(notice(await saveMap(post('/settings/quickbooks/account-map', { connectionId: CONNECTION_ID })), 'qbo')).toBe('posting_off');
    expect(notice(await settle(post('/', { intent: 'approve', decisionId: DECISION_ID }), params))).toBe('posting_off');
    expect(notice(await retry(post('/', { writebackId: WRITEBACK_ID }), params))).toBe('posting_off');
    expect(harness.calls).toEqual([]);
    expect(harness.queued).toEqual([]);
  });

  it('an approve that asks for a posting approves nothing', async () => {
    const response = await approve(
      post('/', { decisionId: DECISION_ID, packetId: PACKET_ID, postWriteback: '1' }),
      params,
    );
    expect(notice(response)).toBe('posting_off');
    expect(harness.calls).toEqual([]);
  });
});

describe('the switch', () => {
  it('is an owner\'s', async () => {
    harness.role = 'approver';
    const response = await toggle(post('/', { connectionId: CONNECTION_ID, enabled: 'on' }));
    expect(notice(response, 'qbo')).toBe('posting_role');
    expect(harness.calls).toEqual([]);
  });

  it('turns posting on for the named connection', async () => {
    const response = await toggle(post('/', { connectionId: CONNECTION_ID, enabled: 'on' }));
    expect(notice(response, 'qbo')).toBe('posting_enabled');
    expect(harness.calls).toEqual([['setPostingEnabled', CONNECTION_ID, true]]);
  });
});

describe('moment 1: one button, both approvals', () => {
  it('writes the writeback approval with the submit one and queues the found posting', async () => {
    const response = await approve(
      post('/', { decisionId: DECISION_ID, packetId: PACKET_ID, postWriteback: '1' }),
      params,
    );
    expect(notice(response)).toBe('approved_and_posting');
    expect(harness.calls).toEqual([
      ['postingForCase', CASE_ID],
      ['approve', { decisionId: DECISION_ID, packetId: PACKET_ID, approverId: USER_ID, alsoWriteback: true }],
      ['queueDecisionPostings', { decisionId: DECISION_ID, connectionId: CONNECTION_ID, withPayment: true }],
    ]);
  });

  it('refuses the posting half when the switch is off, and approves nothing', async () => {
    harness.casePosting = ready({ connection: { connectionId: CONNECTION_ID, postingEnabled: false, hasMap: true } });
    const response = await approve(
      post('/', { decisionId: DECISION_ID, packetId: PACKET_ID, postWriteback: '1' }),
      params,
    );
    expect(notice(response)).toBe('posting_off');
    expect(harness.calls.map(([name]) => name)).toEqual(['postingForCase']);
  });

  it('an approve without the flag writes the submit approval alone', async () => {
    await approve(post('/', { decisionId: DECISION_ID, packetId: PACKET_ID }), params);
    expect(harness.calls).toEqual([
      ['approve', { decisionId: DECISION_ID, packetId: PACKET_ID, approverId: USER_ID }],
    ]);
  });

  it('the card says both when posting is live', () => {
    const html = renderToStaticMarkup(
      <CaseActions
        deductionId={CASE_ID}
        state="awaiting_approval"
        workflow={{ packet: { decisionId: DECISION_ID, packetId: PACKET_ID, contentHash: 'ab'.repeat(32), fileDocumentIds: [] }, decision: { preparedBy: 'someone-else' } } as never}
        mayAct
        mayApprove
        viewerUserId={USER_ID}
        filenames={new Map()}
        unservable={new Map()}
        postsFound
      />,
    );
    expect(html).toContain('Approve for submission and post the deduction to QuickBooks');
    expect(html).toContain('name="postWriteback"');
  });
});

describe('moment 2: a settlement, approved by a second person', () => {
  it('names the preparer\'s refusal', async () => {
    harness.casePosting = ready({
      settlement: { decisionId: DECISION_ID, preparedBy: USER_ID, outcome: 'lost', recoveredCents: cents(0), invoiceId: '71', approved: false },
    });
    harness.approveSettlementError = new SettlementApprovalRefusedError(DECISION_ID, 'preparer');
    const response = await settle(post('/', { intent: 'approve', decisionId: DECISION_ID }), params);
    expect(notice(response)).toBe('settle_is_preparer');
    expect(harness.calls.map(([name]) => name)).toEqual(['postingForCase', 'approveSettlement']);
  });

  it('queues the settlement entry once approved', async () => {
    harness.casePosting = ready({
      settlement: { decisionId: DECISION_ID, preparedBy: 'other', outcome: 'declined', recoveredCents: cents(0), invoiceId: '71', approved: false },
    });
    const response = await settle(post('/', { intent: 'approve', decisionId: DECISION_ID }), params);
    expect(notice(response)).toBe('settle_approved');
    expect(harness.calls.at(-1)).toEqual([
      'queueDecisionPostings',
      { decisionId: DECISION_ID, connectionId: CONNECTION_ID, withPayment: true },
    ]);
  });

  it('an analyst may prepare and may not approve', async () => {
    harness.role = 'analyst';
    const response = await settle(post('/', { intent: 'approve', decisionId: DECISION_ID }), params);
    expect(notice(response)).toBe('settle_role');
  });
});

describe('Check QuickBooks and retry', () => {
  const row = {
    writebackId: WRITEBACK_ID,
    decisionId: DECISION_ID,
    connectionId: CONNECTION_ID,
    method: 'journal_entry' as const,
    qboTxnId: undefined,
    amountCents: cents(50_000),
    attempts: 0,
    lastReason: undefined,
    nothingSent: false,
    stale: false,
    voided: false,
  };
  const card = (posting: CasePosting, mayApprove = true): string =>
    renderToStaticMarkup(
      <CasePostingCard deductionId={CASE_ID} posting={posting} mayAct mayApprove={mayApprove} viewerUserId={USER_ID} />,
    );
  const approvedSettlement = {
    decisionId: DECISION_ID,
    preparedBy: '99999999-9999-4999-8999-999999999999',
    outcome: 'lost' as const,
    recoveredCents: cents(0),
    invoiceId: '120324',
    approved: true,
  };
  /** Production's row once the job has run again: failed before anything was sent. */
  const neverSent = { ...row, status: 'failed' as const, attempts: 1, lastReason: 'invoice_not_found', nothingSent: true };

  it('puts a failed row back and queues it to read back first', async () => {
    harness.casePosting = ready({ writebacks: [{ ...row, status: 'failed' }] });
    const response = await retry(post('/', { writebackId: WRITEBACK_ID }), params);
    expect(notice(response)).toBe('writeback_retried');
    expect(harness.calls.at(-1)).toEqual(['requeueWriteback', WRITEBACK_ID]);
    expect(harness.queued).toEqual([{ writebackId: WRITEBACK_ID, connectionId: CONNECTION_ID, retry: true }]);
  });

  it('never resends a succeeded row', async () => {
    harness.casePosting = ready({ writebacks: [{ ...row, status: 'succeeded', qboTxnId: '301' }] });
    const response = await retry(post('/', { writebackId: WRITEBACK_ID }), params);
    expect(notice(response)).toBe('writeback_not_retryable');
    expect(harness.queued).toEqual([]);
  });

  it('the card offers the retry only on a failed row', () => {
    const html = renderToStaticMarkup(
      <CasePostingCard
        deductionId={CASE_ID}
        posting={ready({ writebacks: [{ ...row, status: 'failed' }] })}
        mayAct
        mayApprove
        viewerUserId={USER_ID}
      />,
    );
    expect(html).toContain('Check QuickBooks and retry');
  });

  it('says nothing was sent, and why, in fixed wording — apart from an unknown outcome', () => {
    const notSent = card(ready({ writebacks: [neverSent] }));
    expect(notSent).toContain('not sent — nothing reached QuickBooks');
    expect(notSent).toContain('QuickBooks has no invoice with the id this settlement names.');
    expect(notSent).not.toContain('outcome unknown');

    const unknown = card(
      ready({ writebacks: [{ ...row, status: 'failed', attempts: 1, lastReason: 'unknown_outcome' }] }),
    );
    expect(unknown).toContain('outcome unknown — it may have reached QuickBooks');
    expect(unknown).not.toContain('nothing reached QuickBooks');

    // A reason this build does not know is never printed as it came.
    const odd = card(ready({ writebacks: [{ ...row, status: 'failed', attempts: 1, lastReason: 'Acme <b>Foods</b>' }] }));
    expect(odd).not.toContain('Acme');
  });

  it('offers the retry on a journal entry that has waited with nothing recorded, and not on a fresh one', () => {
    // Production's row as it stands: pending, no attempt ever recorded.
    const stuck = card(ready({ writebacks: [{ ...row, status: 'pending', stale: true }] }));
    expect(stuck).toContain('waiting — no result recorded');
    expect(stuck).toContain('Check QuickBooks and retry');
    expect(card(ready({ writebacks: [{ ...row, status: 'pending' }] }))).not.toContain('<button');
  });

  it('queues a stuck pending row to read QuickBooks back first, without touching the row', async () => {
    harness.casePosting = ready({ writebacks: [{ ...row, status: 'pending', stale: true }] });
    const response = await retry(post('/', { writebackId: WRITEBACK_ID }), params);
    expect(notice(response)).toBe('writeback_retried');
    expect(harness.calls.map(([name]) => name)).not.toContain('requeueWriteback');
    expect(harness.queued).toEqual([{ writebackId: WRITEBACK_ID, connectionId: CONNECTION_ID, retry: true }]);
  });

  it('never queues a voided row', async () => {
    harness.casePosting = ready({ writebacks: [{ ...neverSent, voided: true }] });
    const response = await retry(post('/', { writebackId: WRITEBACK_ID }), params);
    expect(notice(response)).toBe('writeback_voided');
    expect(harness.queued).toEqual([]);
    const html = card(ready({ writebacks: [{ ...neverSent, voided: true }], settlement: { ...approvedSettlement, voided: true } }));
    expect(html).toContain('voided — never sent');
    expect(html).not.toContain('<button');
  });

  describe('Void this posting (ADR 0069 §3)', () => {
    const voidIt = () => voidPosting(post('/', { decisionId: DECISION_ID }), params);
    beforeEach(() => {
      harness.casePosting = ready({ writebacks: [neverSent], settlement: approvedSettlement });
    });

    it('the card offers it only where nothing was sent, and only to someone who may approve', () => {
      const posting = ready({ writebacks: [neverSent], settlement: approvedSettlement });
      expect(card(posting)).toContain('Void this posting and settle the case again');
      expect(card(posting, false)).not.toContain('Void this posting and settle the case again');
      expect(card(posting, false)).toContain('An owner or an approver can void it');
      const unknown = ready({
        writebacks: [{ ...row, status: 'failed', attempts: 1, lastReason: 'unknown_outcome' }],
        settlement: approvedSettlement,
      });
      expect(card(unknown)).not.toContain('Void this posting');
      const stuck = ready({ writebacks: [{ ...row, status: 'pending', stale: true }], settlement: approvedSettlement });
      expect(card(stuck)).not.toContain('Void this posting');
    });

    it('reads QuickBooks by the row\u2019s reference, then voids', async () => {
      const response = await voidIt();
      expect(notice(response)).toBe('posting_voided');
      expect(harness.referencesAsked).toHaveLength(1);
      expect(harness.referencesAsked[0]?.[0]).toBe('JournalEntry');
      expect(harness.referencesAsked[0]?.[1]).toMatch(/^RC[0-9a-f]{19}$/);
      expect(harness.calls.at(-1)).toEqual(['voidSettlementPosting', DECISION_ID]);
    });

    it('is an owner\u2019s or an approver\u2019s, whom the database still lets write', async () => {
      harness.role = 'analyst';
      expect(notice(await voidIt())).toBe('posting_void_role');
      harness.role = 'approver';
      harness.mayWrite = false;
      expect(notice(await voidIt())).toBe('posting_void_role');
      expect(harness.referencesAsked).toEqual([]);
      expect(harness.calls.map(([name]) => name)).not.toContain('voidSettlementPosting');
    });

    it('voids nothing when QuickBooks holds the entry, cannot be read, or has no client', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      harness.ledger = 'holds';
      expect(notice(await voidIt())).toBe('posting_void_in_ledger');
      harness.ledger = 'throws';
      const unreadable = await voidIt();
      expect(notice(unreadable)).toBe('posting_void_unreadable');
      harness.ledger = 'no_client';
      expect(notice(await voidIt())).toBe('posting_void_unreadable');
      expect(JSON.stringify(logged.mock.calls) + (unreadable.headers.get('location') ?? '')).not.toMatch(/Acme|abc123/);
      expect(harness.calls.map(([name]) => name)).not.toContain('voidSettlementPosting');
      logged.mockRestore();
    });

    it.each([
      ['maybe_sent', 'posting_void_maybe_sent'],
      ['posted', 'posting_void_maybe_sent'],
      ['not_failed', 'posting_void_refused'],
      ['already_voided', 'posting_void_refused'],
    ])('answers the store\u2019s refusal %s as %s', async (reason, expected) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      harness.voidRefusal = reason;
      expect(notice(await voidIt())).toBe(expected);
      logged.mockRestore();
    });

    it('refuses a decision that is not this case\u2019s, and a deployment that does not post', async () => {
      expect(
        notice(await voidPosting(post('/', { decisionId: '00000000-0000-4000-8000-000000000000' }), params)),
      ).toBe('posting_void_refused');
      harness.posting = false;
      expect(notice(await voidIt())).toBe('posting_off');
    });
  });
});
