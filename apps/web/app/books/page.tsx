import { PostgresBooksStore } from '@recouple/store-postgres';
import { BooksPage } from '../../components/books';
import { booksFor, booksRequestFrom, booksSourcesFromEnv, utcDay } from '../../lib/books';
import { env } from '../../lib/env';
import { postingStoreFor } from '../../lib/posting';
import { requireSession } from '../../lib/session';
import { viewerOf } from '../../lib/viewer';

export const dynamic = 'force-dynamic';

/**
 * Long enough for the reads to fail on their own bounds rather than the
 * platform's, as on Settings → QuickBooks (ADR 0063 §1). Per connection: a
 * token refresh at worst (a lock connection 30 s, the company's lock 15 s,
 * Intuit's token call 10 s), the chart in two pages of `BOOKS_READ_TIMEOUT_MS`
 * each, then the trial balance and the general ledger side by side — 85 s —
 * with the connections themselves side by side.
 */
export const maxDuration = 90;

/**
 * Books: resolve the member, read, render (ADR 0066 §1–§3).
 *
 * Every member sees it, `read_only` included, and it has no action. Our own
 * rows are read through RLS as `app_rw` under the member's claims; the
 * company's books are read from QuickBooks inside this request, as this
 * member, through the connection's sealed token store, and are not kept.
 *
 * A GET that may write one thing, taking nothing from the request to write: a
 * read whose access token has run out refreshes it, and the rotated token is
 * stored as a new sealed row (ADR 0033) — the refresh every QuickBooks read
 * makes. Whether this member's refresh could be stored is asked of the
 * database first (`member_may_write()`); for a member it would refuse, a
 * stale token is never exchanged and the page says so (`withoutRefresh`).
 *
 * The window and the scope come from the address and are validated before
 * anything is asked (`booksRequestFrom`); neither reaches QuickBooks as
 * anything but two proven dates.
 */
export default async function BooksRoute({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string | string[];
    to?: string | string[];
    accounts?: string | string[];
  }>;
}) {
  const session = await requireSession();
  const now = new Date();
  const request = booksRequestFrom(await searchParams, now);
  const asOf = utcDay(now);
  const identity = { orgId: session.org.orgId, userId: session.userId };

  const posting = postingStoreFor(session);
  const connections = await posting.postingConnections();
  const books =
    connections.length === 0
      ? []
      : await booksFor(booksSourcesFromEnv(), identity, connections, {
          request,
          asOf,
          mayRefresh: await posting.memberMayWrite(),
          cases: await new PostgresBooksStore(
            { connectionString: env.databaseUrl },
            identity,
          ).casesInWindow(request.window),
        });

  return <BooksPage viewer={viewerOf(session)} books={books} request={request} asOf={asOf} />;
}
