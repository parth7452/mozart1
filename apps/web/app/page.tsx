import { requireSession, storeFor } from '../lib/session';
import { mayWrite } from '../lib/pipeline';
import { mayApprove } from '../lib/workflow';
import { aboutFrom, UNREAD_AFTER_MINUTES } from '../lib/notices';
import { CaseList } from '../components/case-list';
import { ledgerFilterFrom } from '../lib/case-presentation';

export const dynamic = 'force-dynamic';

/**
 * The case list route: resolve the reviewer, read, render.
 *
 * The read goes through RLS, so "this tenant's cases" is the database's answer
 * rather than a filter this page remembered to apply.
 */
export default async function CaseListPage({
  searchParams,
}: {
  // A notice key and its validated fragments, never a sentence
  // (`lib/notices.ts`). `action` is here as well as `upload` because a filing
  // or an approval that landed on a case other than the one it was posted to
  // sends the reviewer here rather than to a case where nothing happened.
  searchParams: Promise<{
    upload?: string;
    action?: string;
    reread?: string;
    about?: string | string[];
    // The ledger's search, from its GET form. Validated before it reaches the
    // store: an unknown state or an unusable query is dropped, not passed on.
    q?: string | string[];
    state?: string | string[];
  }>;
}) {
  const session = await requireSession();
  const { upload, action, reread, about, q, state } = await searchParams;
  const store = storeFor(session);
  const mayUpload = mayWrite(session.org.role);
  const filter = ledgerFilterFrom({ q, state });
  // One "today" for the read and the render: the SQL cuts the queue at its
  // limit by the same buckets `rankForReview` draws, and a render on the far
  // side of midnight from the read could put a case in a different one.
  const today = new Date();
  try {
    // Over every case the tenant has, not the newest hundred: an older case is
    // found by its claim, invoice or customer, and `matching` says how many
    // answered when the table cannot list them all.
    const ledger = await store.searchCases(filter);
    return (
      <CaseList
        viewer={{ email: session.email, orgName: session.org.name, role: session.org.role }}
        cases={ledger.rows}
        ledger={{ filter, matching: ledger.total }}
        // Every open case, in the queue's order and with its today, whatever
        // the ledger was searched for. Asked only for a member who could attach
        // a document, for the reason the unattached documents are.
        attachTo={mayUpload ? await store.attachTargets({ today }) : undefined}
        // The figures are over every case, not the newest hundred in `cases`:
        // the same RLS, counted by state, and the queue's today for deadlines.
        tally={await store.caseTally({ today })}
        // Every member, `read_only` included: the queue is a reading of cases
        // they can already see, and it offers no action of its own.
        queue={{
          read: await store.reviewQueue({ today }),
          viewer: { userId: session.userId, mayApprove: mayApprove(session.org.role) },
        }}
        today={today}
        mayUpload={mayUpload}
        // Only for a member who can do something about one. The read itself is
        // RLS-scoped like every other read here, so what comes back is this
        // tenant's documents because the policies say so.
        unread={mayUpload ? await store.unreadDocuments(UNREAD_AFTER_MINUTES) : undefined}
        // Read and on no case: evidence uploaded here opens nothing of its own,
        // and until this list it appeared nowhere. Asked only for a member who
        // could attach one, for the reason the unread documents are.
        unattached={mayUpload ? await store.unattachedDocuments() : undefined}
        // The pairs identity resolution refused to merge and nobody has
        // answered (ADR 0032). Asked only for a member who could answer one,
        // for the reason the unread documents are: a list of things you may not
        // act on is a query paid for on every page view and shown to nobody who
        // can do anything about it.
        duplicates={mayUpload ? await store.possibleDuplicates() : undefined}
        notice={upload ?? action ?? reread}
        noticeAbout={aboutFrom(about)}
      />
    );
  } finally {
    await store.close();
  }
}
