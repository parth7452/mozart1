import type { CaseState } from '@recouple/core-domain';
import type { CaseStateTally, CaseSummary } from '@recouple/store-postgres';
import { deadline } from '../lib/format';

/**
 * What `PostgresStore.caseTally` answers for a tenant whose every case is in
 * `cases`: per state and whether a decline names them, how many, what they add
 * up to, and how many have a deadline the list's label does not call ok.
 *
 * For views rendered from a hand-made list, so their figures and their rows
 * describe one tenant. The SQL is held to the same edges — due today, due in
 * `DUE_SOON_DAYS`, a day past that — by `case-tally.test.ts` in store-postgres.
 */
export function tallyOf(cases: readonly CaseSummary[], today: Date): readonly CaseStateTally[] {
  const groups = new Map<
    string,
    { state: CaseState; declined: boolean; cases: number; deductedCents: number; dueSoonOrPast: number }
  >();
  for (const row of cases) {
    const declined = row.declined === true;
    const key = `${row.state}:${String(declined)}`;
    const tally = groups.get(key) ?? {
      state: row.state,
      declined,
      cases: 0,
      deductedCents: 0,
      dueSoonOrPast: 0,
    };
    tally.cases += 1;
    tally.deductedCents += row.deductionAmountCents;
    const due = deadline(row.disputeDeadline, today);
    if (due !== undefined && due.tone !== 'ok') tally.dueSoonOrPast += 1;
    groups.set(key, tally);
  }
  return [...groups.values()];
}
