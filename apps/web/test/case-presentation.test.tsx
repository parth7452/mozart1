import { describe, expect, it } from 'vitest';
import type { CaseSummary } from '@recouple/store-postgres';
import { caseMetrics, filterCases } from '../lib/case-presentation';

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
    expect(caseMetrics(cases, today)).toEqual({
      totalCents: 111105,
      openCount: 5,
      approvalStageCount: 1,
      deadlineCount: 2,
    });
    expect(caseMetrics([], today)).toEqual({
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
    expect(caseMetrics([survivor, copy], today)).toMatchObject({ totalCents: 42_150, openCount: 1 });
  });

  it('searches the displayed customer, including unmatched printed names, with the state filter', () => {
    const printed = row();
    const matched = row({ deductionId: 'second', debtorName: 'Acme Staffing', state: 'submitted' });
    const cases = [printed, matched];
    expect(filterCases(cases, '  HARBOR  ', 'all')).toEqual([printed]);
    expect(filterCases(cases, 'acme', 'submitted')).toEqual([matched]);
    expect(filterCases(cases, 'acme', 'classified')).toEqual([]);
    expect(filterCases(cases, 'abc-123', 'all')).toEqual(cases);
    expect(filterCases(cases, 'test-claim-id', 'all')).toEqual([printed]);
    expect(filterCases(cases, '', 'all')).toEqual(cases);
  });
});
