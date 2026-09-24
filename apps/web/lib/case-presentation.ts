import { cents, isClosed, sumCents } from '@recouple/core-domain';
import type { CaseStateTally, CaseSummary } from '@recouple/store-postgres';
import { retailer } from './format';

/**
 * Counts describe the ledger we have, never estimated recovery or cash received.
 *
 * Over every case the tenant has, from the store's tally by state — not over
 * the list, which holds the newest hundred and undercounted past that. The
 * store counts; what a state means is decided here, with `isClosed`.
 *
 * A case merged into another is not a deduction of its own (ADR 0042): it is
 * neither open nor in the total, which would otherwise count one deduction's
 * dollars twice on the page a reviewer reads first. It is still a recorded
 * case, so `caseCount` has it, as the list does.
 */
export function caseMetrics(tally: readonly CaseStateTally[]) {
  const open = tally.filter((row) => !isClosed(row.state));
  const count = (rows: readonly CaseStateTally[], of = (row: CaseStateTally) => row.cases) =>
    rows.reduce((sum, row) => sum + of(row), 0);
  return {
    caseCount: count(tally),
    totalCents: sumCents(
      tally.filter((row) => row.state !== 'merged').map((row) => cents(row.deductedCents)),
    ),
    openCount: count(open),
    // The tally carries state, not whether an approval row already exists.
    approvalStageCount: count(tally.filter((row) => row.state === 'awaiting_approval')),
    // Due soon or overdue, and not yet filed.
    deadlineCount: count(
      open.filter((row) => row.state !== 'submitted'),
      (row) => row.dueSoonOrPast,
    ),
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
