import { requireSession, storeFor } from '../lib/session';
import { mayWrite } from '../lib/pipeline';
import { aboutFrom, UNREAD_AFTER_MINUTES } from '../lib/notices';
import { CaseList } from '../components/case-list';

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
  }>;
}) {
  const session = await requireSession();
  const { upload, action, reread, about } = await searchParams;
  const store = storeFor(session);
  const mayUpload = mayWrite(session.org.role);
  try {
    return (
      <CaseList
        viewer={{ email: session.email, orgName: session.org.name, role: session.org.role }}
        cases={await store.listCases()}
        today={new Date()}
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
