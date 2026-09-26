import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewQueueRead, ReviewQueueRow } from '@recouple/store-postgres';
import {
  BUCKET_HINTS,
  BUCKET_TITLES,
  NEXT_STEP_LABELS,
  WAITING_FOR_ANOTHER_APPROVER,
  WorkQueue,
  type QueueViewer,
} from '../components/work-queue';

/**
 * The review queue as a reviewer reads it (ADR 0043).
 *
 * The order itself is `rankForReview`'s and is property-tested in core-domain;
 * what is asked here is what only the view decides: that each bucket is headed
 * and explained, that every row says what it is waiting for in words, that an
 * approval the viewer may not give says so rather than asking them, and that
 * text off somebody else's page stays text.
 */

const today = new Date('2026-09-23T15:00:00Z');
const PREPARER = 'aaaaaaaa-1111-2222-3333-444444444444';
const APPROVER = 'bbbbbbbb-1111-2222-3333-444444444444';

function day(offset: number): string {
  return new Date(Date.UTC(2026, 8, 23) + offset * 86_400_000).toISOString().slice(0, 10);
}

let next = 0;
/** A queued case. An override of `undefined` drops the key, as the store would. */
function row(overrides: { [K in keyof ReviewQueueRow]?: ReviewQueueRow[K] | undefined } = {}) {
  next += 1;
  const merged: Record<string, unknown> = {
    deductionId: `00000000-0000-0000-0000-${String(next).padStart(12, '0')}`,
    state: 'classified',
    claimId: `CLM-${next}`,
    deductionAmountCents: 10_000,
    createdAt: day(-3),
    debtorName: 'Sysco Baltimore',
    discoveredVia: 'notice',
    hasApproval: false,
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged as unknown as ReviewQueueRow;
}

function read(rows: readonly ReviewQueueRow[], extra: Partial<ReviewQueueRead> = {}): ReviewQueueRead {
  return { rows, total: rows.length, waitingOnRetailer: 0, limit: 500, ...extra };
}

const analyst: QueueViewer = { userId: PREPARER, mayApprove: false };
const approver: QueueViewer = { userId: APPROVER, mayApprove: true };

function render(queue: ReviewQueueRead, viewer: QueueViewer = analyst): string {
  return renderToStaticMarkup(<WorkQueue queue={queue} today={today} viewer={viewer} />);
}

describe('the review queue view', () => {
  it('heads each bucket in the founder’s order, explains it, and counts it', () => {
    const html = render(
      read([
        row({ claimId: 'LATER', disputeDeadline: day(40) }),
        row({ claimId: 'NONE', disputeDeadline: undefined, deductionDate: day(-60) }),
        row({ claimId: 'PAST', disputeDeadline: day(-2) }),
        row({ claimId: 'SOON-B', disputeDeadline: day(9) }),
        row({ claimId: 'SOON-A', disputeDeadline: day(2) }),
      ]),
    );
    const at = (text: string) => {
      const index = html.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    // Buckets in order, each row under its own.
    const order = [
      BUCKET_TITLES.due_soon,
      'SOON-A',
      'SOON-B',
      BUCKET_TITLES.past_deadline,
      'PAST',
      BUCKET_TITLES.no_deadline,
      'NONE',
      BUCKET_TITLES.due_later,
      'LATER',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(BUCKET_TITLES.due_soon).toBe('Due within 14 days');
    for (const hint of Object.values(BUCKET_HINTS)) {
      expect(html).toContain(renderToStaticMarkup(<>{hint}</>));
    }
    expect(html).toContain(
      '<span class="queue-bucket-count">2<span class="sr-only"> cases</span></span>',
    );
    // A ranking, so an ordered list: one per bucket that has anything in it.
    expect(html.match(/<ol class="queue-list">/g)).toHaveLength(4);
    expect(html).toContain('5 cases need a person · 0 filed, waiting on the retailer');
    expect(html).toContain('href="/cases/');
  });

  it('leaves out a bucket with nothing in it rather than heading an empty one', () => {
    const html = render(read([row({ disputeDeadline: day(3) })]));
    expect(html).toContain(BUCKET_TITLES.due_soon);
    expect(html).not.toContain(BUCKET_TITLES.past_deadline);
    expect(html).not.toContain(BUCKET_TITLES.no_deadline);
    expect(html).not.toContain(BUCKET_TITLES.due_later);
    expect(html).toContain('1 case needs a person');
  });

  it('says how long is left, how late it is, or how long the money has been missing', () => {
    const html = render(
      read([
        row({ disputeDeadline: day(3) }),
        row({ disputeDeadline: day(0) }),
        row({ disputeDeadline: day(-2) }),
        row({ disputeDeadline: day(30) }),
        row({ disputeDeadline: undefined, deductionDate: day(-60) }),
        row({ disputeDeadline: undefined, deductionDate: undefined, createdAt: day(-1) }),
      ]),
    );
    expect(html).toContain('<span class="pill due-soon">3d left</span>');
    expect(html).toContain('<span class="pill overdue">due today</span>');
    expect(html).toContain('<span class="pill overdue">2d overdue</span>');
    expect(html).toContain('<span class="pill ok">30d left</span>');
    // With no deadline, the age — and which date it is counted from, because
    // the day the money went missing and the day we opened a case are not the
    // same claim.
    expect(html).toContain('no deadline · deducted 60 days ago');
    expect(html).toContain('no deadline · opened 1 day ago');
  });

  it('says what each case is waiting for, from its state', () => {
    const html = render(
      read([
        row({ state: 'classified', disputeDeadline: day(1) }),
        row({ state: 'analyst_review', disputeDeadline: day(2) }),
        row({ state: 'awaiting_approval', disputeDeadline: day(3), preparedBy: PREPARER }),
        row({
          state: 'awaiting_approval',
          disputeDeadline: day(4),
          hasApproval: true,
          preparedBy: PREPARER,
        }),
        row({ state: 'discovered', disputeDeadline: day(5) }),
      ]),
      approver,
    );
    const steps = [
      NEXT_STEP_LABELS.decide,
      NEXT_STEP_LABELS.assemble,
      NEXT_STEP_LABELS.approve,
      NEXT_STEP_LABELS.file,
      NEXT_STEP_LABELS.review,
    ].map((label) => html.indexOf(label));
    expect(steps.every((index) => index > -1)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(html).not.toContain(WAITING_FOR_ANOTHER_APPROVER);
  });

  it('does not ask the preparer, or a role that cannot approve, to approve', () => {
    const waiting = read([
      row({ state: 'awaiting_approval', disputeDeadline: day(3), preparedBy: PREPARER }),
    ]);

    // The preparer, even with a role that could approve anyone else's.
    const preparer = render(waiting, { userId: PREPARER, mayApprove: true });
    expect(preparer).toContain(WAITING_FOR_ANOTHER_APPROVER);
    expect(preparer).not.toContain(NEXT_STEP_LABELS.approve);

    // An analyst, or a read-only member, who prepared nothing.
    const analystView = render(waiting, { userId: APPROVER, mayApprove: false });
    expect(analystView).toContain(WAITING_FOR_ANOTHER_APPROVER);

    // Somebody else with a role that may approve.
    const approverView = render(waiting, approver);
    expect(approverView).toContain(NEXT_STEP_LABELS.approve);
    expect(approverView).not.toContain(WAITING_FOR_ANOTHER_APPROVER);
  });

  it('renders a retailer name and a claim id off the page as text, never as markup', () => {
    const html = render(
      read([
        row({
          claimId: '<img src=x onerror=alert(1)>',
          debtorName: undefined,
          retailerNameAsPrinted: '<script>alert("pwned")</script> Stores',
          invoiceNumber: '<b>INV-9</b>',
          disputeDeadline: day(3),
        }),
      ]),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>INV-9</b>');
    expect(html).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt; Stores');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Printed but matched to no debtor of this tenant: said, not settled.
    expect(html).toContain('not matched');
  });

  it('says how many it is not showing, rather than cutting silently', () => {
    const rows = [row({ disputeDeadline: day(1) }), row({ disputeDeadline: day(2) })];
    const html = render(read(rows, { total: 612, limit: 2 }));
    expect(html).toContain('Showing the 2 most urgent of 612.');
    expect(html).toContain('612 cases need a person');

    expect(render(read(rows))).not.toContain('Showing the');
  });

  it('scopes unknown deadlines to displayed queue rows, including a truncated zero', () => {
    const rows = [
      row({ disputeDeadline: undefined }),
      row({ disputeDeadline: day(2) }),
    ];
    const html = render(read(rows, { total: 612, limit: 2 }));
    expect(html).toContain('1 deadline unknown in the displayed queue.');
    expect(html).toContain('More cases are outside this view.');

    const noUnknown = render(read([row({ disputeDeadline: day(2) })], { total: 612, limit: 1 }));
    expect(noUnknown).toContain('0 deadlines unknown in the displayed queue.');
    expect(noUnknown).toContain('More cases are outside this view.');
  });

  it('says why it is empty, and counts what is waiting on the retailer', () => {
    const filed = render(read([], { waitingOnRetailer: 3 }));
    expect(filed).toContain('Nothing needs a person right now · 3 filed, waiting on the retailer');
    expect(filed).toContain('Every open case is filed and waiting on the retailer.');
    expect(filed).not.toContain('<table');

    const none = render(read([]));
    expect(none).toContain('No case is open yet.');
  });
});
