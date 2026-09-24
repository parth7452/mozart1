import { describe, expect, it } from 'vitest';
import { CASE_STATES } from '@recouple/core-domain';
import { CASE_SEARCH_QUERY_MAX, type CaseSummary } from '@recouple/store-postgres';
import { caseMetrics, ledgerFilterFrom, ledgerListing } from '../lib/case-presentation';
import { tallyOf } from './case-tally';

const row = (overrides: Partial<CaseSummary> = {}): CaseSummary => ({
  discoveredVia: 'notice',
  deductionId: 'test-claim-id',
  state: 'classified',
  deductionAmountCents: 12345,
  createdAt: '2026-09-01',
  documentCount: 1,
  claimId: 'ABC-123',
  retailerNameAsPrinted: 'Harbor Logistics',
  ...overrides,
});
const today = new Date('2026-09-21T12:00:00Z');

describe('ledger presentation', () => {
  it('excludes completed and filed cases from actionable deadline counts', () => {
    const cases = [
      row({ disputeDeadline: '2026-09-21' }),
      row({ disputeDeadline: '2026-10-05', state: 'awaiting_approval' }),
      row({ disputeDeadline: '2026-10-06' }),
      row({ disputeDeadline: '2026-09-20', state: 'submitted' }),
      ...(['won', 'lost', 'partial', 'written_off'] as const).map((state) =>
        row({ state, disputeDeadline: '2026-09-20' }),
      ),
      row(),
    ];
    expect(caseMetrics(tallyOf(cases, today))).toEqual({
      caseCount: 9,
      totalCents: 111105,
      openCount: 5,
      approvalStageCount: 1,
      deadlineCount: 2,
    });
    expect(caseMetrics([])).toEqual({
      caseCount: 0,
      totalCents: 0,
      openCount: 0,
      approvalStageCount: 0,
      deadlineCount: 0,
    });
  });
  it('counts a case merged into another neither as open nor in the total (ADR 0042)', () => {
    const today = new Date('2026-09-23T00:00:00Z');
    const survivor = row({ deductionId: 'survivor', deductionAmountCents: 42_150 });
    const copy = row({ deductionId: 'copy', deductionAmountCents: 42_150, state: 'merged' });
    // Still a recorded case, as the list shows it; not a deduction of its own.
    expect(caseMetrics(tallyOf([survivor, copy], today))).toMatchObject({
      caseCount: 2,
      totalCents: 42_150,
      openCount: 1,
    });
  });

  // What a search matches is the database's answer now, over every case
  // (`searchCases`, case-search.test.ts in store-postgres, on Postgres): claim,
  // invoice, debtor, printed name and id. What stays here is what reaches it.
  it('passes a search on trimmed, and a state only when it is one', () => {
    expect(ledgerFilterFrom({ q: '  APDP-99812 ', state: 'awaiting_approval' })).toEqual({
      query: 'APDP-99812',
      state: 'awaiting_approval',
    });
    expect(ledgerFilterFrom({})).toEqual({});
    expect(ledgerFilterFrom({ q: '   ', state: '' })).toEqual({});
    // Every state the database has is one a person may filter by.
    for (const state of CASE_STATES) {
      expect(ledgerFilterFrom({ state })).toEqual({ state });
    }
  });

  it('drops what a query string can carry and the store was not written for', () => {
    // Unknown, differently cased, or the old list's own "all": not a state.
    for (const state of ['nope', 'WON', 'all', "won' or 1=1 --"]) {
      expect(ledgerFilterFrom({ q: 'x', state })).toEqual({ query: 'x' });
    }
    // Sent twice, over the store's bound, or carrying a control character.
    expect(ledgerFilterFrom({ q: ['a', 'b'], state: ['won', 'lost'] })).toEqual({});
    expect(ledgerFilterFrom({ q: 'x'.repeat(CASE_SEARCH_QUERY_MAX) })).toEqual({
      query: 'x'.repeat(CASE_SEARCH_QUERY_MAX),
    });
    expect(ledgerFilterFrom({ q: 'x'.repeat(CASE_SEARCH_QUERY_MAX + 1) })).toEqual({});
    expect(ledgerFilterFrom({ q: 'APDP\u0000' })).toEqual({});
    expect(ledgerFilterFrom({ q: 'a\tb' })).toEqual({});
    // Wildcards are text; escaping them is the store's job, not a reason to drop.
    expect(ledgerFilterFrom({ q: '10%_off' })).toEqual({ query: '10%_off' });
  });

  it('says what the table lists: the newest cases, or what a search matched', () => {
    expect(ledgerListing({}, 100, 240, 240)).toBe('the newest 100 listed below');
    expect(ledgerListing({}, 3, 3, 3)).toBe('');
    expect(ledgerListing({ query: 'walmart' }, 3, 3, 240)).toBe('3 cases match “walmart”');
    expect(ledgerListing({ query: 'KS-40112' }, 1, 1, 240)).toBe('1 case matches “KS-40112”');
    expect(ledgerListing({ query: 'walmart', state: 'awaiting_approval' }, 100, 1_204, 5_000)).toBe(
      '1,204 cases match “walmart” in awaiting approval, the newest 100 listed below',
    );
    expect(ledgerListing({ state: 'won' }, 2, 2, 240)).toBe('2 cases in won');
    expect(ledgerListing({ query: 'nothing' }, 0, 0, 240)).toBe('no case matches “nothing”');
    expect(ledgerListing({ state: 'merged' }, 0, 0, 240)).toBe('no case in merged');
  });
});
