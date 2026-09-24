import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PossibleDuplicatePair,
  UnattachedDocument,
  UnreadDocument,
} from '@recouple/pipeline';
import type {
  AttachTargets,
  CaseSearch,
  CaseSearchResult,
  CaseStateTally,
  CaseSummary,
  PostgresStore,
  ReviewQueueRead,
  ReviewQueueRow,
} from '@recouple/store-postgres';
import { UNREAD_AFTER_MINUTES } from '../lib/notices';

/**
 * The case list as a page, rather than as a component.
 *
 * `views.test.tsx` renders `CaseList` with whatever props it likes; this asks
 * the question a component test cannot — which queries the page actually
 * *makes*, for whom, and with what. The one that matters is `unreadDocuments`:
 * it is a query per page view, and it is shown only to a member who can do
 * something about the answer. A page that asked for it and then threw the
 * result away would be paying for a list nobody is allowed to see.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const harness = vi.hoisted(() => ({
  role: 'analyst' as string,
  /** Every `unreadDocuments` call, with the arguments it was given. */
  unreadCalls: [] as { olderThanMinutes: number; limit?: number }[],
  unread: [] as UnreadDocument[],
  /** Every `possibleDuplicates` call, for the same question about cost. */
  duplicateCalls: [] as unknown[],
  duplicates: [] as PossibleDuplicatePair[],
  /** Every `unattachedDocuments` call, for the same question about cost. */
  unattachedCalls: [] as unknown[],
  unattached: [] as UnattachedDocument[],
  /** Every `reviewQueue` call: asked for every member, with one `today`. */
  queueCalls: [] as ({ today?: Date; limit?: number } | undefined)[],
  queue: { rows: [], total: 0, waitingOnRetailer: 0, limit: 500 } as ReviewQueueRead,
  /** Every `caseTally` call: the figures, over every case, with the queue's today. */
  tallyCalls: [] as ({ today?: Date } | undefined)[],
  tally: [] as CaseStateTally[],
  /** Every `searchCases` call: the ledger's rows, for whatever was searched. */
  searchCalls: [] as (CaseSearch | undefined)[],
  search: { rows: [], total: 0, limit: 100 } as CaseSearchResult,
  /** Every `listCases` call: the newest hundred, which nothing on this page reads now. */
  listCalls: 0,
  /** Every `attachTargets` call: the attach control's cases, most urgent first. */
  attachCalls: [] as ({ today?: Date; limit?: number } | undefined)[],
  attachTargets: { rows: [], total: 0, limit: 500 } as AttachTargets,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'reviewer@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
  storeFor: () =>
    ({
      async listCases() {
        harness.listCalls += 1;
        return [];
      },
      async attachTargets(options?: { today?: Date; limit?: number }) {
        harness.attachCalls.push(options);
        return harness.attachTargets;
      },
      async searchCases(search?: CaseSearch) {
        harness.searchCalls.push(search);
        return harness.search;
      },
      async unreadDocuments(olderThanMinutes: number, limit?: number) {
        harness.unreadCalls.push({ olderThanMinutes, ...(limit === undefined ? {} : { limit }) });
        return harness.unread;
      },
      async possibleDuplicates(options?: unknown) {
        harness.duplicateCalls.push(options);
        return harness.duplicates;
      },
      async unattachedDocuments(limit?: number) {
        harness.unattachedCalls.push(limit);
        return harness.unattached;
      },
      async reviewQueue(options?: { today?: Date; limit?: number }) {
        harness.queueCalls.push(options);
        return harness.queue;
      },
      async caseTally(options?: { today?: Date }) {
        harness.tallyCalls.push(options);
        return harness.tally;
      },
      async close() {
        return undefined;
      },
    }) as unknown as PostgresStore,
}));

const CaseListPage = (await import('../app/page')).default;

/** One side of a pair, as the store hands it back. */
function side(deductionId: string, claimId: string): PossibleDuplicatePair['older'] {
  return {
    deductionId,
    state: 'discovered',
    claimId,
    retailer: 'Walmart (APDP)',
    retailerMatched: true,
    deductionAmountCents: 42_150,
    deductionDate: '2026-07-02',
    openedAt: '2026-09-20T09:00:00.000Z',
  };
}

function pair(): PossibleDuplicatePair {
  return {
    noticedAt: '2026-09-21T09:00:00.000Z',
    basis: ['invoice_number', 'amount_cents', 'deduction_date'],
    older: side('aaaaaaaa-1111-2222-3333-444444444444', 'APDP-99812'),
    newer: side('bbbbbbbb-1111-2222-3333-444444444444', 'APDP-99813'),
  };
}

function unreadDocument(): UnreadDocument {
  return {
    documentId: 'dddddddd-1111-2222-3333-444444444444',
    filename: 'walmart-apdp-notice.pdf',
    createdAt: '2026-09-21T09:00:00.000Z',
    ageMinutes: 42,
    onCase: false,
  };
}

/** A case waiting on an approval, prepared by `preparedBy`. */
function awaitingApproval(preparedBy: string): ReviewQueueRow {
  return {
    deductionId: 'ffffffff-1111-2222-3333-444444444444',
    state: 'awaiting_approval',
    claimId: 'KS-40112',
    deductionAmountCents: 88_450,
    disputeDeadline: '2099-01-01',
    createdAt: '2026-09-20',
    discoveredVia: 'notice',
    hasApproval: false,
    preparedBy,
  };
}

type SearchParams = Awaited<Parameters<typeof CaseListPage>[0]['searchParams']>;

async function render(searchParams: SearchParams = {}): Promise<string> {
  return renderToStaticMarkup(await CaseListPage({ searchParams: Promise.resolve(searchParams) }));
}

/** A case as the store lists it. */
function listed(deductionId: string, claimId: string): CaseSummary {
  return {
    deductionId,
    state: 'classified',
    claimId,
    deductionAmountCents: 42_150,
    discoveredVia: 'notice',
    documentCount: 1,
    createdAt: '2025-09-01T09:00:00.000Z',
  };
}

describe('the case list page', () => {
  beforeEach(() => {
    harness.role = 'analyst';
    harness.unreadCalls = [];
    harness.unread = [unreadDocument()];
    harness.duplicateCalls = [];
    harness.duplicates = [pair()];
    harness.queueCalls = [];
    harness.queue = {
      rows: [awaitingApproval(USER_ID)],
      total: 1,
      waitingOnRetailer: 2,
      limit: 500,
    };
    harness.tallyCalls = [];
    harness.tally = [];
    harness.searchCalls = [];
    harness.search = { rows: [], total: 0, limit: 100 };
    harness.listCalls = 0;
    harness.attachCalls = [];
    harness.attachTargets = { rows: [], total: 0, limit: 500 };
    harness.unattachedCalls = [];
    harness.unattached = [
      {
        documentId: 'eeeeeeee-1111-2222-3333-444444444444',
        filename: '08_log-202.jpg',
        createdAt: '2026-09-23T15:56:16.000Z',
        docType: 'pod',
        // Required since ADR 0044: the classification's own confidence.
        confidence: 0.98,
      },
    ];
  });

  it('lists what was read and is on no case, with what it was read as', async () => {
    // The production gap: a delivery receipt uploaded here was read, opened
    // nothing because it is evidence, and appeared nowhere.
    const html = await render();

    expect(harness.unattachedCalls).toEqual([undefined]);
    expect(html).toContain('Read, not on a case');
    expect(html).toContain('08_log-202.jpg');
    expect(html).toContain('proof of delivery');
  });

  it('asks for the stuck documents once, at the threshold the notice explains', async () => {
    const html = await render();

    expect(harness.unreadCalls).toEqual([{ olderThanMinutes: UNREAD_AFTER_MINUTES }]);
    expect(html).toContain('Documents waiting to be read');
    expect(html).toContain('walmart-apdp-notice.pdf');
  });

  it('shows the pairs identity resolution would not merge, and says nothing was merged', async () => {
    const html = await render();

    expect(harness.duplicateCalls).toEqual([undefined]);
    expect(html).toContain('Possible duplicates');
    expect(html).toContain('APDP-99812');
    expect(html).toContain('APDP-99813');
    // The two answers, as a POST to the case in the pair, and no claim that
    // pressing either one joins the cases together.
    expect(html).toContain('/cases/aaaaaaaa-1111-2222-3333-444444444444/duplicate');
    expect(html).toContain('Same deduction');
    expect(html).toContain('Different deductions');
    expect(html).toContain('neither was merged');
  });

  it('draws no duplicates section when there is nothing to answer', async () => {
    harness.duplicates = [];
    const html = await render();
    expect(html).not.toContain('Possible duplicates');
  });

  it('asks nothing at all for a member who could not act on the answer', async () => {
    // A `read_only` member cannot ask for a read, so the section is not shown
    // to them — and this is the half a component test cannot see: the query is
    // not made either. Paying for a list nobody may see, on every page view, is
    // the shape of cost that never shows up in a screenshot.
    harness.role = 'read_only';

    const html = await render();

    expect(harness.unreadCalls).toEqual([]);
    expect(harness.duplicateCalls).toEqual([]);
    expect(harness.unattachedCalls).toEqual([]);
    expect(html).not.toContain('Documents waiting to be read');
    expect(html).not.toContain('Possible duplicates');
    expect(html).not.toContain('Read, not on a case');
  });

  it('shows every member what to work on next, read with one today', async () => {
    // Every role, `read_only` included: the queue is a reading of cases the
    // member can already see and offers no action of its own, so unlike the
    // lists above it costs nothing that nobody may use.
    for (const role of ['analyst', 'read_only', 'accountant_guest']) {
      harness.role = role;
      harness.queueCalls = [];
      const html = await render();

      expect(harness.queueCalls).toHaveLength(1);
      const today = harness.queueCalls[0]?.today;
      expect(today).toBeInstanceOf(Date);
      expect(Number.isNaN(today?.getTime())).toBe(false);
      expect(html).toContain('What to work on next');
      expect(html).toContain('KS-40112');
      expect(html).toContain('1 case needs a person · 2 filed, waiting on the retailer');
    }
  });

  it('counts every case in its figures, asked once with the queue’s today', async () => {
    // The list is the newest hundred; the figures are not. A tenant whose list
    // came back empty here still has the tally's 240 cases, and every member
    // sees them, `read_only` included, as they see the list.
    harness.tally = [
      { state: 'classified', cases: 200, deductedCents: 2_000_000, dueSoonOrPast: 9 },
      { state: 'lost', cases: 40, deductedCents: 400_000, dueSoonOrPast: 0 },
    ];
    for (const role of ['analyst', 'read_only']) {
      harness.role = role;
      harness.tallyCalls = [];
      harness.queueCalls = [];
      const html = await render();

      expect(harness.tallyCalls).toHaveLength(1);
      expect(harness.tallyCalls[0]?.today).toBeInstanceOf(Date);
      expect(harness.tallyCalls[0]?.today).toBe(harness.queueCalls[0]?.today);
      expect(html).toContain('Across 240 recorded cases');
      expect(html).toContain('$24,000.00');
    }
  });

  it('lists the newest cases when nothing was searched', async () => {
    harness.search = {
      rows: [listed('aaaaaaaa-0000-0000-0000-000000000001', 'APDP-99812')],
      total: 240,
      limit: 100,
    };
    harness.tally = [{ state: 'classified', cases: 240, deductedCents: 0, dueSoonOrPast: 0 }];
    const html = await render();

    expect(harness.searchCalls).toEqual([{}]);
    expect(harness.listCalls).toBe(0);
    expect(html).toContain('APDP-99812');
    expect(html).toContain('the newest 1 listed below');
    expect(html).toContain('1 of 240 cases');
  });

  it('passes the search to the store, trimmed, so it reaches every case', async () => {
    // A year-old case behind the newest hundred, found by its invoice.
    harness.search = {
      rows: [listed('aaaaaaaa-0000-0000-0000-000000000009', 'OLD-4471')],
      total: 1,
      limit: 100,
    };
    harness.tally = [{ state: 'analyst_review', cases: 240, deductedCents: 0, dueSoonOrPast: 0 }];
    for (const role of ['analyst', 'read_only']) {
      harness.role = role;
      harness.searchCalls = [];
      const html = await render({ q: '  INV-8812 ', state: 'analyst_review' });

      expect(harness.searchCalls).toEqual([{ query: 'INV-8812', state: 'analyst_review' }]);
      expect(html).toContain('OLD-4471');
      expect(html).toContain('1 case matches “INV-8812” in analyst review');
      expect(html).toContain('value="INV-8812"');
    }
  });

  it('ignores a state it does not know, and a query it cannot search, rather than passing them on', async () => {
    await render({ q: 'walmart', state: 'nope' });
    await render({ q: ['a', 'b'], state: 'won' });
    await render({ q: 'APDP\u0000', state: ['won', 'lost'] });
    await render({ q: '', state: '' });

    expect(harness.searchCalls).toEqual([{ query: 'walmart' }, { state: 'won' }, {}, {}]);
  });

  it('offers the attach control every open case, most urgent first, whatever was searched', async () => {
    // A year-old case the queue puts first, and the newest hundred would drop.
    harness.search = {
      rows: [listed('aaaaaaaa-0000-0000-0000-000000000001', 'KS-40112')],
      total: 1,
      limit: 100,
    };
    harness.attachTargets = {
      rows: [
        listed('aaaaaaaa-0000-0000-0000-000000000009', 'OLD-4471'),
        listed('aaaaaaaa-0000-0000-0000-000000000001', 'KS-40112'),
      ],
      total: 640,
      limit: 500,
    };
    for (const params of [{}, { q: 'KS-40112' }]) {
      harness.attachCalls = [];
      harness.queueCalls = [];
      const html = await render(params);

      expect(harness.attachCalls).toHaveLength(1);
      expect(harness.attachCalls[0]?.today).toBe(harness.queueCalls[0]?.today);
      expect(harness.listCalls).toBe(0);
      const attach = html.slice(html.indexOf('Read, not on a case'));
      expect(attach.indexOf('OLD-4471')).toBeGreaterThan(-1);
      expect(attach.indexOf('OLD-4471')).toBeLessThan(attach.indexOf('KS-40112'));
      expect(attach).toContain('Each list offers the 2 most urgent of 640 open cases.');
    }

    // A member who cannot attach is not shown the control, so nothing is read for it.
    for (const role of ['read_only', 'accountant_guest']) {
      harness.role = role;
      harness.attachCalls = [];
      await render({ q: 'KS-40112' });
      expect(harness.attachCalls).toEqual([]);
    }
  });

  it('does not ask the member who prepared a decision to approve it', async () => {
    harness.role = 'approver';
    const own = await render();
    expect(own).toContain('Waiting for another approver');
    expect(own).not.toContain('Approve for submission');

    harness.queue = { ...harness.queue, rows: [awaitingApproval('somebody-else')] };
    const theirs = await render();
    expect(theirs).toContain('Approve for submission');
    expect(theirs).not.toContain('Waiting for another approver');
  });

  it('asks nothing for an accountant guest either', async () => {
    harness.role = 'accountant_guest';
    await render();
    expect(harness.unreadCalls).toEqual([]);
    expect(harness.duplicateCalls).toEqual([]);
    expect(harness.unattachedCalls).toEqual([]);
  });
});
