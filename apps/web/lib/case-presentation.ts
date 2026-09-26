import { CASE_STATES, cents, isClosed, sumCents, type CaseState } from '@recouple/core-domain';
import { CASE_SEARCH_QUERY_MAX, type CaseStateTally } from '@recouple/store-postgres';

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
 *
 * A declined case is decided but not closed: a decline moves no state (ADR
 * 0043), so it still reads `classified`, and the store splits it out with the
 * review queue's own predicate. It is not open work — not in the open cases,
 * the approval stage or the deadlines to watch, exactly as the queue leaves it
 * out — but the deduction was still withheld and is still a recorded case, so
 * it stays in `caseCount` and the total. `declinedCount` is how many the open
 * count left out on that account — declined and otherwise open — so it and
 * `openCount` add up to what the open count would have been.
 */
export function caseMetrics(tally: readonly CaseStateTally[]) {
  const live = tally.filter((row) => !row.declined);
  const open = live.filter((row) => !isClosed(row.state));
  const count = (rows: readonly CaseStateTally[], of = (row: CaseStateTally) => row.cases) =>
    rows.reduce((sum, row) => sum + of(row), 0);
  return {
    caseCount: count(tally),
    totalCents: sumCents(
      tally.filter((row) => row.state !== 'merged').map((row) => cents(row.deductedCents)),
    ),
    openCount: count(open),
    // The tally carries state, not whether an approval row already exists.
    approvalStageCount: count(live.filter((row) => row.state === 'awaiting_approval')),
    // Due soon or overdue, and not yet filed.
    deadlineCount: count(
      open.filter((row) => row.state !== 'submitted'),
      (row) => row.dueSoonOrPast,
    ),
    // Exactly the declined cases the open count leaves out, so the page's
    // "N declined, not counted" is that number and no other: a declined case
    // in a closed state (`isClosed`, merged away included) was never going to be
    // counted as open, and saying it was "not counted" would overstate what
    // the figure set aside.
    declinedCount: count(
      tally.filter((row) => row.declined && !isClosed(row.state)),
    ),
  };
}

/** C0 controls and DEL: nothing a person types into a search box. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * What the ledger was searched for, from the query string, or nothing.
 *
 * The search is the database's (`PostgresStore.searchCases`), over every case
 * the tenant has; this only decides what reaches it. A query string anybody
 * can write, so anything this was not written for is dropped rather than
 * passed through: a state that is not one of `CASE_STATES`, a query sent twice,
 * one longer than the store searches, or one carrying a control character
 * (Postgres refuses a NUL outright). Dropped means unfiltered, which shows the
 * newest cases as the page always has.
 */
export function ledgerFilterFrom(params: {
  q?: string | readonly string[] | undefined;
  state?: string | readonly string[] | undefined;
}): LedgerFilter {
  const query = typeof params.q === 'string' ? params.q.trim() : '';
  const state = typeof params.state === 'string' ? params.state : '';
  return {
    ...(query !== '' && query.length <= CASE_SEARCH_QUERY_MAX && !CONTROL.test(query)
      ? { query }
      : {}),
    ...((CASE_STATES as readonly string[]).includes(state) ? { state: state as CaseState } : {}),
  };
}

/** What the ledger's table was asked for; neither is the newest cases. */
export interface LedgerFilter {
  readonly query?: string;
  readonly state?: CaseState;
}

export function isFiltered(filter: LedgerFilter): boolean {
  return filter.query !== undefined || filter.state !== undefined;
}

/** `awaiting_approval` → `awaiting approval`, as the table's pills read. */
export function stateLabel(state: CaseState): string {
  return state.replace(/_/g, ' ');
}

/**
 * What the ledger's table lists, said after the figures, or nothing when it
 * lists every case.
 *
 * The figures are over every case (`caseMetrics`). Unfiltered, the table is
 * the newest `shown` of `caseCount`. Searched, it is the newest `shown` of the
 * `matching` cases the store counted, and the sentence says what was searched
 * for, so a short table is never read as a short ledger.
 */
export function ledgerListing(
  filter: LedgerFilter,
  shown: number,
  matching: number,
  caseCount: number,
): string {
  const count = (n: number) => n.toLocaleString('en-US');
  if (!isFiltered(filter)) {
    return shown < caseCount ? `the newest ${count(shown)} listed below` : '';
  }
  const text = filter.query === undefined ? '' : ` “${filter.query}”`;
  const where = filter.state === undefined ? '' : ` in ${stateLabel(filter.state)}`;
  if (matching === 0) {
    return filter.query === undefined ? `no case${where}` : `no case matches${text}${where}`;
  }
  const noun = `${count(matching)} case${matching === 1 ? '' : 's'}`;
  const cases =
    filter.query === undefined
      ? `${noun}${where}`
      : `${noun} match${matching === 1 ? 'es' : ''}${text}${where}`;
  return shown < matching ? `${cases}, the newest ${count(shown)} listed below` : cases;
}
