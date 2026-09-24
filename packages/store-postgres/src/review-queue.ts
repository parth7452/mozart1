import type { PoolClient } from 'pg';
import {
  CASE_STATES,
  DUE_SOON_DAYS,
  isQueued,
  type CaseState,
  type QueueCase,
} from '@recouple/core-domain';
import type { DiscoveredVia } from '@recouple/pipeline';
import { exactCents } from './workflow';

/**
 * The cases a person can act on now, for the review queue (ADR 0043).
 *
 * `rankForReview` in `core-domain` decides the order; this read decides which
 * rows it sees. Two things it is careful about:
 *
 *  1. **Which cases are queued is one rule.** A case is queued when
 *     `isQueued(state)` says so — not closed, not filed — and no decline names
 *     it (a decline moves no state, ADR 0038 §1). The states the SQL leaves out
 *     are computed from `isQueued`, so the read and the pure function cannot
 *     disagree about a state.
 *  2. **A limit keeps the most urgent rows.** The SQL sorts by the same four
 *     buckets and the same keys `rankForReview` uses, with the same
 *     `DUE_SOON_DAYS` and the same `today` passed in, so cutting at the limit
 *     drops the least urgent cases rather than whichever the planner reached
 *     last. `review-queue.test.ts` holds the two to the same answer. Past the
 *     limit, `total` says how many there are, so the page can say what it is
 *     not showing.
 *
 * Dates are read as `YYYY-MM-DD` text, and the day a case opened is its UTC
 * day, so the ordering does not depend on the server's time zone. Money is read
 * as text and converted once through `exactCents` (invariant 3).
 */

export const REVIEW_QUEUE_LIMIT = 500;
export const REVIEW_QUEUE_MAX = 2_000;

export class ReviewQueueReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewQueueReadError';
  }
}

/** A queued case, as much of it as the queue shows and the ordering needs. */
export interface ReviewQueueRow extends QueueCase {
  readonly claimId?: string;
  readonly debtorName?: string;
  readonly retailerNameAsPrinted?: string;
  readonly discoveredVia: DiscoveredVia;
  readonly invoiceNumber?: string;
  /** `YYYY-MM-DD`, the UTC day the case opened. */
  readonly createdAt: string;
  /** Who prepared the latest decision, so an approve row can say whose move it is. */
  readonly preparedBy?: string;
}

export interface ReviewQueueRead {
  readonly rows: readonly ReviewQueueRow[];
  /** Every queued case, however many `rows` holds. */
  readonly total: number;
  /** Filed and waiting on the retailer: not queued, but counted. */
  readonly waitingOnRetailer: number;
  readonly limit: number;
}

/** The states the queue leaves out, from the one rule that says so. */
export const NOT_QUEUED: readonly CaseState[] = CASE_STATES.filter((state) => !isQueued(state));

/*
 * The queue's rule and order as SQL, shared with the attach control's read
 * (`PostgresStore.attachTargets`), which lists the queued cases first and in
 * this order. Every read that uses them binds `$1` to `NOT_QUEUED`, `$2` to
 * today's UTC day and `$3` to `DUE_SOON_DAYS`, and names the case `d`.
 */

/** A case the queue holds: not closed, not filed, and no decline names it. */
export const QUEUED_SQL = `(d.state <> all ($1::text[])
          and not exists (select 1 from declined_candidates k where k.deduction_id = d.id))`;

/** `queueBucket`'s four, in its order: 0 due soon, 1 past, 2 none printed, 3 due later. */
export const URGENCY_BUCKET_SQL = `case
                when d.dispute_deadline is null then 2
                when d.dispute_deadline < $2::date then 1
                when d.dispute_deadline <= $2::date + $3::int then 0
                else 3
              end`;

/**
 * `rankForReview`'s order, over a relation `q` that carries the columns of
 * `deductions` plus `bucket` (`URGENCY_BUCKET_SQL`) and `created_on`, the UTC
 * day the case opened.
 */
export const URGENCY_ORDER_SQL = `q.bucket,
               -- due soon and due later: soonest deadline first
               case when q.bucket in (0, 3) then q.dispute_deadline end asc,
               -- past the deadline: most recently passed first
               case when q.bucket = 1 then q.dispute_deadline end desc,
               -- no deadline: oldest short-pay first
               case when q.bucket = 2 then coalesce(q.deduction_date, q.created_on) end asc,
               q.deduction_amount_cents desc,
               q.id asc`;

interface QueueDbRow {
  id: string;
  state: CaseState;
  claim_id: string | null;
  amount: string;
  deduction_date: string | null;
  dispute_deadline: string | null;
  created_on: string;
  debtor_name: string | null;
  retailer_name_as_printed: string | null;
  discovered_via: DiscoveredVia;
  invoice_number: string | null;
  has_approval: boolean;
  prepared_by: string | null;
  total: string;
}

export async function readReviewQueue(
  client: PoolClient,
  today: Date,
  limit: number,
): Promise<ReviewQueueRead> {
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_QUEUE_MAX) {
    throw new ReviewQueueReadError(
      `a review queue holds 1 to ${REVIEW_QUEUE_MAX} cases, not ${String(limit)}`,
    );
  }
  if (Number.isNaN(today.getTime())) {
    throw new ReviewQueueReadError('the review queue needs a real date for today');
  }
  const todayIso = today.toISOString().slice(0, 10);

  const { rows } = await client.query<QueueDbRow>(
    `with queued as (
       select d.*,
              ${URGENCY_BUCKET_SQL} as bucket,
              (d.created_at at time zone 'UTC')::date as created_on
         from deductions d
        where ${QUEUED_SQL}
     )
     select q.id::text as id, q.state, q.claim_id,
            q.deduction_amount_cents::text as amount,
            to_char(q.deduction_date, 'YYYY-MM-DD') as deduction_date,
            to_char(q.dispute_deadline, 'YYYY-MM-DD') as dispute_deadline,
            to_char(q.created_on, 'YYYY-MM-DD') as created_on,
            b.display_name as debtor_name,
            q.retailer_name_as_printed, q.discovered_via,
            (select i.identifier from deduction_identifiers i
              where i.deduction_id = q.id and i.identifier_kind = 'invoice_number'
              order by i.first_seen_at asc, i.id asc limit 1) as invoice_number,
            exists (select 1 from approvals a join decisions c on c.id = a.decision_id
                     where c.deduction_id = q.id) as has_approval,
            (select c.prepared_by::text from decisions c where c.deduction_id = q.id
              order by c.created_at desc, c.id desc limit 1) as prepared_by,
            count(*) over ()::text as total
       from queued q
       left join debtors b on b.id = q.debtor_id
      order by ${URGENCY_ORDER_SQL}
      limit $4`,
    [[...NOT_QUEUED], todayIso, DUE_SOON_DAYS, limit],
  );

  const { rows: waiting } = await client.query<{ n: string }>(
    `select count(*)::text as n from deductions where state = 'submitted'`,
  );

  return {
    rows: rows.map((row) => ({
      deductionId: row.id,
      state: row.state,
      deductionAmountCents: exactCents(row.amount, 'deduction_amount_cents'),
      ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
      ...(row.deduction_date !== null ? { deductionDate: row.deduction_date } : {}),
      ...(row.dispute_deadline !== null ? { disputeDeadline: row.dispute_deadline } : {}),
      createdAt: row.created_on,
      ...(row.debtor_name !== null ? { debtorName: row.debtor_name } : {}),
      ...(row.retailer_name_as_printed !== null
        ? { retailerNameAsPrinted: row.retailer_name_as_printed }
        : {}),
      discoveredVia: row.discovered_via,
      ...(row.invoice_number !== null ? { invoiceNumber: row.invoice_number } : {}),
      hasApproval: row.has_approval,
      ...(row.prepared_by !== null ? { preparedBy: row.prepared_by } : {}),
    })),
    total: rows.length === 0 ? 0 : exactCents(rows[0]?.total ?? '0', 'total'),
    waitingOnRetailer: exactCents(waiting[0]?.n ?? '0', 'waiting'),
    limit,
  };
}
