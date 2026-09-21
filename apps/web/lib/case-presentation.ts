import type { CaseSummary } from '@recouple/store-postgres';
import { deadline, retailer } from './format';

const CLOSED = new Set(['won', 'lost', 'partial', 'written_off']);

/** Counts describe the ledger we have, never estimated recovery or cash received. */
export function caseMetrics(cases: readonly CaseSummary[], today: Date) {
  const open = cases.filter((row) => !CLOSED.has(row.state));
  return {
    totalCents: cases.reduce((sum, row) => sum + row.deductionAmountCents, 0),
    openCount: open.length,
    // The summary carries state, not whether an approval row already exists.
    approvalStageCount: cases.filter((row) => row.state === 'awaiting_approval').length,
    deadlineCount: open.filter((row) => {
      const due = deadline(row.disputeDeadline, today);
      return row.state !== 'submitted' && due !== undefined && due.tone !== 'ok';
    }).length,
  };
}

export function filterCases(cases: readonly CaseSummary[], query: string, state: string) {
  const search = query.trim().toLocaleLowerCase('en-US');
  return cases.filter(
    (row) =>
      (state === 'all' || row.state === state) &&
      [row.claimId ?? '', row.deductionId, retailer(row, '').name].some((value) =>
        value.toLocaleLowerCase('en-US').includes(search),
      ),
  );
}
