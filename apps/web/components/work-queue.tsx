import Link from 'next/link';
import {
  DUE_SOON_DAYS,
  QUEUE_BUCKETS,
  rankForReview,
  type NextStep,
  type QueueBucket,
  type RankedCase,
} from '@recouple/core-domain';
import type { ReviewQueueRead, ReviewQueueRow } from '@recouple/store-postgres';
import { deadline, money, retailer, type Deadline } from '../lib/format';

/**
 * What to work on next (ADR 0043): every case a person can act on now, grouped
 * under the bucket that put it there.
 *
 * The order is not this file's. `rankForReview` decides it, and the store's
 * read cuts at the same order, so a case past the limit is a less urgent one
 * rather than whichever the planner reached last. What this file adds is the
 * why, in words, on every row: which bucket the case is in and what it is
 * waiting for, so nobody has to guess why one case sits above another.
 *
 * A pure function of what the store returned, like every view here. Retailer
 * names and claim ids came off somebody else's page and are rendered as text.
 */

export interface QueueViewer {
  readonly userId: string;
  /** Whether this member's role may approve at all (`owner` or `approver`). */
  readonly mayApprove: boolean;
}

export const BUCKET_TITLES: Readonly<Record<QueueBucket, string>> = {
  due_soon: `Due within ${DUE_SOON_DAYS} days`,
  past_deadline: 'Past the deadline',
  no_deadline: 'No deadline printed',
  due_later: 'Due later',
};

/** How each bucket is ordered, said once under its title. */
export const BUCKET_HINTS: Readonly<Record<QueueBucket, string>> = {
  due_soon: 'Soonest deadline first. These can still be filed on time.',
  past_deadline:
    'Most recently passed first. Fight one late, or decline it as past the deadline.',
  no_deadline:
    'Oldest first. Nothing we hold printed a dispute window, so age stands in for one. The payer’s real window may be shorter.',
  due_later: 'Soonest deadline first.',
};

export const NEXT_STEP_LABELS: Readonly<Record<NextStep, string>> = {
  decide: 'Decide: dispute or decline',
  assemble: 'Assemble the packet',
  approve: 'Approve for submission',
  file: 'Record the filing',
  review: 'Review the case',
};

/**
 * An approval that is not this viewer's to give. The database refuses one by
 * whoever prepared the decision, and by any role but `owner` or `approver`, so
 * a row that said "approve" to them would be pointing at a refusal.
 */
export const WAITING_FOR_ANOTHER_APPROVER = 'Waiting for another approver';

export function nextStepLabel(ranked: RankedCase<ReviewQueueRow>, viewer: QueueViewer): string {
  if (
    ranked.nextStep === 'approve' &&
    (!viewer.mayApprove || ranked.case.preparedBy === viewer.userId)
  ) {
    return WAITING_FOR_ANOTHER_APPROVER;
  }
  return NEXT_STEP_LABELS[ranked.nextStep];
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

/**
 * When the case is due, or, with no deadline, how long the money has been
 * missing. The deduction date when one was read, else the day the case opened —
 * and the label says which, because they are not the same claim.
 */
export function whenLabel(
  ranked: RankedCase<ReviewQueueRow>,
  today: Date,
): Deadline | { readonly label: string; readonly tone?: undefined } {
  const due = deadline(ranked.case.disputeDeadline, today);
  if (due !== undefined) return due;
  const since = ranked.daysSinceShortPay;
  if (since === undefined) return { label: 'no deadline' };
  const what = ranked.case.deductionDate !== undefined ? 'deducted' : 'opened';
  if (since < 0) return { label: `no deadline · ${what} ${days(-since)} ahead` };
  if (since === 0) return { label: `no deadline · ${what} today` };
  return { label: `no deadline · ${what} ${days(since)} ago` };
}

export function WorkQueue({
  queue,
  today,
  viewer,
}: {
  queue: ReviewQueueRead;
  today: Date;
  viewer: QueueViewer;
}) {
  const ranked = rankForReview(queue.rows, today);
  const unknownDeadlines = ranked.filter((row) => row.bucket === 'no_deadline').length;
  const waiting = queue.waitingOnRetailer;
  const waitingText = `${waiting.toLocaleString('en-US')} filed, waiting on the retailer`;
  const needText =
    queue.total === 0
      ? 'Nothing needs a person right now'
      : `${queue.total.toLocaleString('en-US')} case${queue.total === 1 ? '' : 's'} need${queue.total === 1 ? 's' : ''} a person`;

  return (
    <section className="card ledger queue" aria-labelledby="work-queue-title">
      <div className="ledger-heading">
        <div>
          <h2 id="work-queue-title">What to work on next</h2>
          <p className="ledger-summary">
            {needText} · {waitingText}
          </p>
          <p className={unknownDeadlines > 0 ? 'queue-unknown has-unknown' : 'queue-unknown'}>
            {unknownDeadlines.toLocaleString('en-US')} deadline
            {unknownDeadlines === 1 ? '' : 's'} unknown in the displayed queue.
            {ranked.length < queue.total ? ' More cases are outside this view.' : null}
          </p>
        </div>
        <span className="ledger-tag">REVIEW QUEUE</span>
      </div>
      {ranked.length === 0 ? (
        <p className="empty">
          {waiting > 0
            ? 'Every open case is filed and waiting on the retailer. '
            : 'No case is open yet. '}
          A case appears here when it opens, most urgent first.
        </p>
      ) : (
        <>
          {/* Column names for the eye. Each row reads on its own — an amount,
              a deadline, a step in words — so a screen reader is not asked to
              match cells to headers, and a phone can stack the row. */}
          <div className="queue-columns" aria-hidden="true">
            <span>Customer / retailer</span>
            <span>Claim</span>
            <span className="money">Deducted</span>
            <span>When</span>
            <span>Next step</span>
          </div>
          {QUEUE_BUCKETS.map((bucket) => {
            const rows = ranked.filter((row) => row.bucket === bucket);
            if (rows.length === 0) return null;
            const headingId = `queue-${bucket}`;
            return (
              <section
                key={bucket}
                className={`queue-bucket bucket-${bucket}`}
                aria-labelledby={headingId}
              >
                <h3 id={headingId}>
                  <span className="queue-bucket-title">{BUCKET_TITLES[bucket]}</span>
                  <span className="queue-bucket-count">
                    {rows.length}
                    <span className="sr-only"> case{rows.length === 1 ? '' : 's'}</span>
                  </span>
                </h3>
                <p className="queue-bucket-hint">{BUCKET_HINTS[bucket]}</p>
                {/* An ordered list, because the order is the point. */}
                <ol className="queue-list">
                  {rows.map((row) => {
                    const who = retailer(row.case, '—');
                    const when = whenLabel(row, today);
                    const step = nextStepLabel(row, viewer);
                    return (
                      <li key={row.case.deductionId} className="queue-row">
                        <span className="queue-who">
                          <Link
                            href={`/cases/${row.case.deductionId}`}
                            className="customer-name queue-case-link"
                            aria-label={who.name === '—'
                              ? `Review case ${row.case.claimId ?? row.case.deductionId.slice(0, 8)}`
                              : undefined}
                          >
                            {who.name}
                          </Link>
                          {who.matched ? null : <span className="unmatched">not matched</span>}
                        </span>
                        <span className="queue-claim">
                          <span className="mono">{row.case.claimId ?? row.case.deductionId.slice(0, 8)}</span>
                          {row.case.invoiceNumber === undefined ? null : (
                            <span className="unmatched">invoice {row.case.invoiceNumber}</span>
                          )}
                        </span>
                        <span className="queue-amount">
                          {money(row.case.deductionAmountCents)}
                        </span>
                        <span className="queue-due">
                          {when.tone === undefined ? (
                            <span className="queue-when">{when.label}</span>
                          ) : (
                            <span className={`pill ${when.tone}`}>{when.label}</span>
                          )}
                        </span>
                        <span className="queue-step">
                          {step === WAITING_FOR_ANOTHER_APPROVER ? (
                            <span className="queue-waiting">{step}</span>
                          ) : (
                            <span className={`pill step-${row.nextStep}`}>{step}</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </>
      )}
      {ranked.length < queue.total ? (
        <p className="queue-more">
          Showing the {ranked.length.toLocaleString('en-US')} most urgent of{' '}
          {queue.total.toLocaleString('en-US')}. The rest move up as these are done.
        </p>
      ) : null}
    </section>
  );
}
