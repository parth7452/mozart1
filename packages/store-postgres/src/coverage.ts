import type { PoolClient } from 'pg';

/**
 * The coverage page's read (ADR 0030, ADR 0038): what we found and what we
 * filed, per channel, per month — and the two things that inflate it, said
 * out loud rather than hidden.
 *
 * **Per channel, never blended** (ADR 0030 §2). A rate over every channel
 * moves whenever the *mix* moves, so a tenant switching on a ledger sync would
 * read as the product improving. So the totals this returns carry dollars and
 * no rate: `coverage_by_period_totals` has two blended rate columns and this
 * never selects them, which means no caller holding a `CoverageReport` can
 * render one by accident.
 *
 * **Every division is the database's** (invariant 3). Cents arrive as text and
 * are converted once, checked; a rate is the view's `round(…, 4)` or, for the
 * trailing figure, the same expression over the window's sums. Nothing here
 * adds, subtracts or divides cents in TypeScript.
 *
 * **Months are UTC.** The view buckets with `date_trunc` on `timestamptz`, which
 * follows the session's time zone; the read pins it to UTC for its own
 * transaction so a pooled connection with another setting cannot move a
 * deduction into a neighbouring month.
 */

/** A read that came back in a shape it should never have. Ids and column names only. */
export class CoverageReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageReadError';
  }
}

/** How many months a report covers, counting the current one. */
export const COVERAGE_MONTHS_DEFAULT = 12;
export const COVERAGE_MONTHS_MAX = 36;

/** How many counted-twice cases are listed by id. The totals are never capped. */
export const COUNTED_TWICE_LISTED = 50;

/** One (month, channel) of `coverage_by_period_by_source`. */
export interface CoverageMonthRow {
  /** The month's first day, `YYYY-MM-DD`, in UTC. */
  readonly period: string;
  readonly discoveredFrom: string;
  readonly openedCount: number;
  readonly openedCents: number;
  readonly filedCount: number;
  readonly filedCents: number;
  /** Every decline decided in the month — case or no case (ADR 0038 §2). */
  readonly declinedCount: number;
  readonly declinedCents: number;
  /** Each deduction once: opened, plus declines that never became a case. */
  readonly discoveredCents: number;
  /** The view's rate, not clamped. Absent when nothing was discovered. */
  readonly coverageOfDiscovered?: number;
}

/** One channel over the whole window: the page's headline figure. */
export interface CoverageTrailingRow {
  readonly discoveredFrom: string;
  readonly openedCount: number;
  readonly filedCount: number;
  readonly filedCents: number;
  readonly discoveredCents: number;
  /** `round(sum(filed) / sum(discovered), 4)` in the database; absent over nothing. */
  readonly coverageOfDiscovered?: number;
}

/** One month over every channel: dollars only, deliberately no rate. */
export interface CoverageTotalsRow {
  readonly period: string;
  readonly openedCents: number;
  readonly filedCents: number;
  readonly declinedCents: number;
  readonly discoveredCents: number;
}

/**
 * Cases confirmed as duplicates, which still count twice until merging exists
 * (ADR 0032 §6): the half that does not survive — the newer one — with its
 * dollars, per channel, over the report's window.
 */
export interface CountedTwice {
  /** Distinct newer halves: a case in two confirmed pairs counts once. */
  readonly cases: number;
  readonly cents: number;
  readonly byChannel: readonly {
    readonly discoveredFrom: string;
    readonly cases: number;
    readonly cents: number;
  }[];
  /** The first `COUNTED_TWICE_LISTED`, newest first, for links. */
  readonly listed: readonly {
    readonly deductionId: string;
    readonly claimId?: string;
    readonly amountCents: number;
  }[];
}

export interface CoverageReport {
  readonly months: number;
  /** The first month in the window, `YYYY-MM-DD`. */
  readonly fromMonth: string;
  /** The current month, `YYYY-MM-DD` — still moving. */
  readonly currentMonth: string;
  /** Newest month first, then channel. */
  readonly bySource: readonly CoverageMonthRow[];
  /** One row per channel seen in the window, channel order. */
  readonly trailing: readonly CoverageTrailingRow[];
  /** Newest month first. */
  readonly totals: readonly CoverageTotalsRow[];
  readonly countedTwice: CountedTwice;
}

export function assertCoverageMonths(months: number): void {
  if (!Number.isInteger(months) || months < 1 || months > COVERAGE_MONTHS_MAX) {
    throw new CoverageReadError(
      `a coverage report covers 1 to ${COVERAGE_MONTHS_MAX} whole months, not ${String(months)}`,
    );
  }
}

/**
 * The whole report, in the caller's transaction — which must be a tenant
 * transaction (`PostgresStore.withTenant`): every view and table here is RLS
 * `tenant_read`, so what it returns is this tenant's and nothing else.
 */
export async function readCoverageReport(
  client: PoolClient,
  months: number,
): Promise<CoverageReport> {
  assertCoverageMonths(months);
  await client.query(`set local timezone = 'UTC'`);

  const window = await client.query<{ from_month: string; current_month: string }>(
    `select to_char(date_trunc('month', now()) - make_interval(months => $1 - 1), 'YYYY-MM-DD') as from_month,
            to_char(date_trunc('month', now()), 'YYYY-MM-DD') as current_month`,
    [months],
  );
  const fromMonth = one(window.rows).from_month;
  const currentMonth = one(window.rows).current_month;

  const bySource = await client.query<MonthDbRow>(
    `select to_char(period, 'YYYY-MM-DD')   as period,
            discovered_from,
            opened_count::text             as opened_count,
            opened_cents::text             as opened_cents,
            filed_count::text              as filed_count,
            filed_cents::text              as filed_cents,
            declined_count::text           as declined_count,
            declined_cents::text           as declined_cents,
            discovered_cents::text         as discovered_cents,
            coverage_of_discovered::text   as coverage_of_discovered
       from coverage_by_period_by_source
      where period >= $1::date
      order by period desc, discovered_from asc`,
    [fromMonth],
  );

  const trailing = await client.query<{
    discovered_from: string;
    opened_count: string;
    filed_count: string;
    filed_cents: string;
    discovered_cents: string;
    coverage_of_discovered: string | null;
  }>(
    `select discovered_from,
            sum(opened_count)::text      as opened_count,
            sum(filed_count)::text       as filed_count,
            sum(filed_cents)::text       as filed_cents,
            sum(discovered_cents)::text  as discovered_cents,
            case when sum(discovered_cents) = 0 then null
                 else round(sum(filed_cents)::numeric / sum(discovered_cents), 4)
            end::text                    as coverage_of_discovered
       from coverage_by_period_by_source
      where period >= $1::date
      group by discovered_from
      order by discovered_from asc`,
    [fromMonth],
  );

  // Dollars only. `coverage_of_seen` and `coverage_of_discovered` on this view
  // are blended across channels and are never selected (ADR 0030 §2).
  const totals = await client.query<{
    period: string;
    opened_cents: string;
    filed_cents: string;
    declined_cents: string;
    discovered_cents: string;
  }>(
    `select to_char(period, 'YYYY-MM-DD') as period,
            opened_cents::text          as opened_cents,
            filed_cents::text           as filed_cents,
            declined_cents::text        as declined_cents,
            discovered_cents::text      as discovered_cents
       from coverage_by_period_totals
      where period >= $1::date
      order by period desc`,
    [fromMonth],
  );

  const countedTwice = await readCountedTwice(client, fromMonth);

  return {
    months,
    fromMonth,
    currentMonth,
    bySource: bySource.rows.map((row) => ({
      period: row.period,
      discoveredFrom: row.discovered_from,
      openedCount: exactOrThrow(row.opened_count, 'opened_count'),
      openedCents: exactOrThrow(row.opened_cents, 'opened_cents'),
      filedCount: exactOrThrow(row.filed_count, 'filed_count'),
      filedCents: exactOrThrow(row.filed_cents, 'filed_cents'),
      declinedCount: exactOrThrow(row.declined_count, 'declined_count'),
      declinedCents: exactOrThrow(row.declined_cents, 'declined_cents'),
      discoveredCents: exactOrThrow(row.discovered_cents, 'discovered_cents'),
      ...rate(row.coverage_of_discovered),
    })),
    trailing: trailing.rows.map((row) => ({
      discoveredFrom: row.discovered_from,
      openedCount: exactOrThrow(row.opened_count, 'opened_count'),
      filedCount: exactOrThrow(row.filed_count, 'filed_count'),
      filedCents: exactOrThrow(row.filed_cents, 'filed_cents'),
      discoveredCents: exactOrThrow(row.discovered_cents, 'discovered_cents'),
      ...rate(row.coverage_of_discovered),
    })),
    totals: totals.rows.map((row) => ({
      period: row.period,
      openedCents: exactOrThrow(row.opened_cents, 'opened_cents'),
      filedCents: exactOrThrow(row.filed_cents, 'filed_cents'),
      declinedCents: exactOrThrow(row.declined_cents, 'declined_cents'),
      discoveredCents: exactOrThrow(row.discovered_cents, 'discovered_cents'),
    })),
    countedTwice,
  };
}

/**
 * The newer half of every confirmed pair that is still counted twice, once
 * each, opened inside the window.
 *
 * Counted twice means "same deduction" stands on the pair (ADR 0032; a verdict
 * withdrawn by an undone merge does not, ADR 0042 §5) and neither half is
 * merged away — a merged pair is counted once by the view itself (ADR 0042 §8).
 * What is left is the confirmed pairs that could not be merged, each of which
 * says why on its case page. The newer half is the one whose dollars are shown
 * as the excess. Its channel is derived exactly as the view derives it — the
 * case's own earliest notice, else `unknown` — so the banner can say which
 * channel's rate is affected. Counted and summed in SQL, uncapped; only the
 * list of links is.
 */
async function readCountedTwice(client: PoolClient, fromMonth: string): Promise<CountedTwice> {
  const { rows: listed } = await client.query<{
    deduction_id: string;
    claim_id: string | null;
    amount_cents: string;
  }>(
    `${NEWER_HALVES}
     select id::text as deduction_id, claim_id, deduction_amount_cents::text as amount_cents
       from halves
      order by created_at desc, id desc
      limit ${COUNTED_TWICE_LISTED}`,
    [fromMonth],
  );

  const { rows: sums } = await client.query<{
    discovered_from: string | null;
    is_total: number;
    cases: string;
    cents: string;
  }>(
    `${NEWER_HALVES}
     select discovered_from,
            grouping(discovered_from)                       as is_total,
            count(*)::text                                  as cases,
            coalesce(sum(deduction_amount_cents), 0)::text  as cents
       from halves
      group by rollup (discovered_from)
      order by grouping(discovered_from), discovered_from`,
    [fromMonth],
  );

  const total = sums.find((row) => row.is_total === 1);
  return {
    cases: total === undefined ? 0 : exactOrThrow(total.cases, 'cases'),
    cents: total === undefined ? 0 : exactOrThrow(total.cents, 'cents'),
    byChannel: sums
      .filter((row) => row.is_total === 0)
      .map((row) => ({
        discoveredFrom: row.discovered_from ?? 'unknown',
        cases: exactOrThrow(row.cases, 'cases'),
        cents: exactOrThrow(row.cents, 'cents'),
      })),
    listed: listed.map((row) => ({
      deductionId: row.deduction_id,
      ...(row.claim_id === null ? {} : { claimId: row.claim_id }),
      amountCents: exactOrThrow(row.amount_cents, 'deduction_amount_cents'),
    })),
  };
}

/**
 * The newer half of each confirmed pair, once, opened in the window, with its
 * channel derived exactly as `coverage_by_period_by_source` derives it (the
 * case's own earliest notice, else `unknown`, ADR 0030 §3). `$1` is the first
 * month of the window.
 */
const NEWER_HALVES = `
  with standing as (
    select v.event_id
      from duplicate_pair_verdicts v
     where v.verdict = 'same'
       and not exists (
         select 1 from deduction_merges_current c
          where c.merged_deduction_id::text in (v.low_id, v.high_id))
  ),
  newer as (
    select distinct (e.payload->>'newer_deduction_id')::uuid as deduction_id
      from standing s
      join deduction_events e on e.id = s.event_id
     where e.payload ? 'newer_deduction_id'
  ),
  halves as (
    select d.id, d.claim_id, d.deduction_amount_cents, d.created_at,
           coalesce(notice.observed_from, notice.asserted_from, 'unknown') as discovered_from
      from newer n
      join deductions d on d.id = n.deduction_id
      left join lateral (
        select u.source  as observed_from,
               au.source as asserted_from
          from deduction_documents dd
          join documents doc on doc.id = dd.document_id
          left join uploads u on u.id = doc.upload_id
          left join document_arrivals da on da.document_id = doc.id
          left join uploads au on au.id = da.upload_id
         where dd.deduction_id = d.id and dd.role = 'notice'
         order by doc.created_at asc, doc.id asc
         limit 1
      ) notice on true
     where date_trunc('month', d.created_at) >= $1::date
  )`;

interface MonthDbRow {
  period: string;
  discovered_from: string;
  opened_count: string;
  opened_cents: string;
  filed_count: string;
  filed_cents: string;
  declined_count: string;
  declined_cents: string;
  discovered_cents: string;
  coverage_of_discovered: string | null;
}

function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new CoverageReadError('the window query returned no row');
  return row;
}

/**
 * The database's ratio, parsed and never computed: the division happened over
 * bigint cents in SQL, and recomputing it here from two columns is exactly the
 * float arithmetic invariant 3 keeps off a money path.
 */
function rate(text: string | null): { coverageOfDiscovered?: number } {
  if (text === null) return {};
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new CoverageReadError(`coverage_of_discovered is not a number: ${JSON.stringify(text)}`);
  }
  return { coverageOfDiscovered: value };
}

/** A bigint column as a safe integer, or a loud refusal. */
function exactOrThrow(text: string, column: string): number {
  if (!/^-?\d+$/.test(text)) {
    throw new CoverageReadError(`${column} is not an integer: ${JSON.stringify(text)}`);
  }
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new CoverageReadError(`${column} is outside the safe integer range: ${text}`);
  }
  return Number(value);
}
