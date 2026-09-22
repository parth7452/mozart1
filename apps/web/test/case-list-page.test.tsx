import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PossibleDuplicatePair, UnreadDocument } from '@recouple/pipeline';
import type { PostgresStore } from '@recouple/store-postgres';
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
        return [];
      },
      async unreadDocuments(olderThanMinutes: number, limit?: number) {
        harness.unreadCalls.push({ olderThanMinutes, ...(limit === undefined ? {} : { limit }) });
        return harness.unread;
      },
      async possibleDuplicates(options?: unknown) {
        harness.duplicateCalls.push(options);
        return harness.duplicates;
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

async function render(): Promise<string> {
  return renderToStaticMarkup(await CaseListPage({ searchParams: Promise.resolve({}) }));
}

describe('the case list page', () => {
  beforeEach(() => {
    harness.role = 'analyst';
    harness.unreadCalls = [];
    harness.unread = [unreadDocument()];
    harness.duplicateCalls = [];
    harness.duplicates = [pair()];
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
    expect(html).not.toContain('Documents waiting to be read');
    expect(html).not.toContain('Possible duplicates');
  });

  it('asks nothing for an accountant guest either', async () => {
    harness.role = 'accountant_guest';
    await render();
    expect(harness.unreadCalls).toEqual([]);
    expect(harness.duplicateCalls).toEqual([]);
  });
});
