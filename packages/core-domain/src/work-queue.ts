/**
 * What to work on next: the review queue (ADR 0043).
 *
 * A pure, total ordering over the cases a person can act on now. It uses no
 * model, no clock of its own (`today` is a parameter) and no I/O, and every row
 * says why it is where it is: a bucket and a next step, each from a closed set,
 * so the page can put it in words rather than leave a reviewer to guess why one
 * case sits above another.
 *
 * The four buckets, in order, are the founder's choice (2026-09-23): cases that
 * can still be filed on time first, the ones whose deadline has passed next, as
 * a group of their own, then the cases no document gave a deadline — ledger
 * short-pays, most remittance lines — oldest short-pay first, and last the
 * cases due later. Each bucket has one stated ordering and it is tested as
 * stated; every bucket then breaks ties on the larger amount and finally the id,
 * so the order never depends on the order the rows arrived in.
 */

import { isClosed, type CaseState } from './state-machine';

/**
 * How near a deadline has to be before it is "due soon". One number, used by
 * the queue and by the case list's deadline label, so the two cannot disagree.
 */
export const DUE_SOON_DAYS = 14;

export const QUEUE_BUCKETS = ['due_soon', 'past_deadline', 'no_deadline', 'due_later'] as const;
export type QueueBucket = (typeof QUEUE_BUCKETS)[number];

/**
 * What the case is waiting for. Read off the state and whether an approval
 * exists — the same facts the case page's actions are shown on.
 */
export const NEXT_STEPS = ['decide', 'assemble', 'approve', 'file', 'review'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

/** What the ordering needs to know about a case. Dates are `YYYY-MM-DD`. */
export interface QueueCase {
  readonly deductionId: string;
  readonly state: CaseState;
  /** Integer cents. */
  readonly deductionAmountCents: number;
  readonly disputeDeadline?: string;
  /** When the money went missing — the notice's date, or the ledger's last payment. */
  readonly deductionDate?: string;
  /** When the case was opened: ISO-8601, or at least its first ten characters. */
  readonly createdAt: string;
  /** Whether the decision awaiting approval has been approved. */
  readonly hasApproval: boolean;
}

export interface RankedCase<T extends QueueCase> {
  readonly case: T;
  readonly bucket: QueueBucket;
  readonly nextStep: NextStep;
  /** Days to the deadline, negative once it has passed. Absent without one. */
  readonly daysToDeadline?: number;
  /** Days since the short-pay, else since the case opened. Absent when neither reads. */
  readonly daysSinceShortPay?: number;
}

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` (or ISO-8601) date as UTC midnight, or undefined. Never throws. */
function utcDay(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  const at = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(at) ? undefined : at;
}

function todayUtc(today: Date): number {
  const at = utcDay(Number.isNaN(today.getTime()) ? undefined : today.toISOString());
  if (at === undefined) throw new RangeError('rankForReview needs a real date for today');
  return at;
}

/**
 * Whether a case is a person's to act on now: not closed (finished or merged
 * away), and not filed and waiting on the retailer. A declined case is left out
 * by the store, because a decline moves no state.
 */
export function isQueued(state: CaseState): boolean {
  return !isClosed(state) && state !== 'submitted';
}

/** What the case is waiting for, as the case page offers it. */
export function nextStepFor(state: CaseState, hasApproval: boolean): NextStep {
  switch (state) {
    case 'classified':
      return 'decide';
    case 'analyst_review':
      return 'assemble';
    case 'awaiting_approval':
      return hasApproval ? 'file' : 'approve';
    default:
      return 'review';
  }
}

/** Which bucket a deadline puts a case in, today being `today`. */
export function queueBucket(daysToDeadline: number | undefined): QueueBucket {
  if (daysToDeadline === undefined) return 'no_deadline';
  if (daysToDeadline < 0) return 'past_deadline';
  if (daysToDeadline <= DUE_SOON_DAYS) return 'due_soon';
  return 'due_later';
}

interface Keyed<T extends QueueCase> extends RankedCase<T> {
  readonly bucketIndex: number;
  /** The bucket's own ordering key, ascending. */
  readonly key: number;
}

/**
 * The queue, in order. Rows that are not a person's to act on now are left out;
 * the rest are ranked by bucket, then by the bucket's ordering, then by the
 * larger amount, then by id.
 */
export function rankForReview<T extends QueueCase>(
  rows: readonly T[],
  today: Date,
): readonly RankedCase<T>[] {
  const now = todayUtc(today);
  const keyed: Keyed<T>[] = [];
  for (const row of rows) {
    if (!isQueued(row.state)) continue;
    const due = utcDay(row.disputeDeadline);
    const daysToDeadline = due === undefined ? undefined : Math.round((due - now) / DAY_MS);
    const shortPaid = utcDay(row.deductionDate) ?? utcDay(row.createdAt);
    const daysSinceShortPay =
      shortPaid === undefined ? undefined : Math.round((now - shortPaid) / DAY_MS);
    const bucket = queueBucket(daysToDeadline);
    const key =
      bucket === 'past_deadline'
        ? // Most recently passed first: the smallest number of days overdue.
          -(daysToDeadline as number)
        : bucket === 'no_deadline'
          ? // Oldest short-pay first; one with no readable date goes last.
            shortPaid ?? Number.POSITIVE_INFINITY
          : // Soonest deadline first.
            (daysToDeadline as number);
    keyed.push({
      case: row,
      bucket,
      nextStep: nextStepFor(row.state, row.hasApproval),
      ...(daysToDeadline !== undefined ? { daysToDeadline } : {}),
      ...(daysSinceShortPay !== undefined ? { daysSinceShortPay } : {}),
      bucketIndex: QUEUE_BUCKETS.indexOf(bucket),
      key,
    });
  }

  keyed.sort((a, b) => {
    if (a.bucketIndex !== b.bucketIndex) return a.bucketIndex - b.bucketIndex;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.case.deductionAmountCents !== b.case.deductionAmountCents) {
      return b.case.deductionAmountCents - a.case.deductionAmountCents;
    }
    if (a.case.deductionId === b.case.deductionId) return 0;
    return a.case.deductionId < b.case.deductionId ? -1 : 1;
  });

  return keyed.map(({ bucketIndex: _bucketIndex, key: _key, ...ranked }) => ranked);
}
