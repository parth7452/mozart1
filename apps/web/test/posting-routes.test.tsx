import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { cents } from '@recouple/core-domain';
import { SettlementApprovalRefusedError, type CasePosting } from '@recouple/store-postgres';

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
  qboPostingFromEnv: () => (harness.posting ? { clientFor: () => undefined, accountTypesFor: () => undefined } : undefined),
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
});

describe('every posting POST refuses cross-site', () => {
  it.each([
    ['approve', () => approve(post('/cases/x/approve', {}, 'cross-site'), params)],
    ['settle', () => settle(post('/cases/x/settle', {}, 'cross-site'), params)],
    ['retry', () => retry(post('/cases/x/retry-writeback', {}, 'cross-site'), params)],
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
  };

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
});
