import { PostgresLedgerSyncStore } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../lib/session';
import { env } from '../../../lib/env';
import { mayConnectLedger, qboConnectFromEnv } from '../../../lib/qbo-connect';
import { LedgerConnectionPage } from '../../../components/ledger-connection';
import { viewerOf } from '../../../lib/viewer';
import { qboPostingFromEnv } from '../../../lib/qbo-posting';
import { postingStoreFor } from '../../../lib/posting';
import { postingSettingsFor } from '../../../lib/posting-setup';

export const dynamic = 'force-dynamic';

/**
 * Long enough for the chart read to fail on its own bounds rather than the
 * platform's. Each of its requests waits `CHART_READ_TIMEOUT_MS`, a chart
 * read in `CHART_MAX_PAGES` pages at most, and a token refresh waits at most
 * for a lock connection (30 s), the company's lock (15 s) and Intuit's token
 * call (10 s): 75 s at worst, the reads of several connections side by side.
 * The platform's default without this — 10 s on Hobby, 15 s on Pro (ADR 0021)
 * — would cut the page off first, Connect and Disconnect with it, which is
 * what the read's own bound is for (ADR 0063 §1).
 */
export const maxDuration = 90;

/**
 * Settings → QuickBooks: resolve the member, read, render (ADR 0039 §12).
 *
 * The read goes through RLS like every other: this tenant's connections are
 * the policies' answer, and nothing selected here is a credential.
 *
 * A GET that may write, for an owner on a deployment that posts: reading a
 * company's chart may refresh its token, which stores the rotated credential
 * as a new row (ADR 0033) — the refresh any QuickBooks read makes, taking
 * nothing from the request. The callback is still the one GET that writes what
 * a request brought (ADR 0039, ADR 0063 §1).
 */
export default async function QuickBooksSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ qbo?: string }>;
}) {
  const session = await requireSession();
  const { qbo } = await searchParams;
  const configured = qboConnectFromEnv();
  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = storeFor(session);
  try {
    // Hidden unless the deployment posts at all (`QBO_POSTING`) and the member
    // is an owner: the switch and the map are theirs alone (ADR 0060 §5). Each
    // enabled connection's chart of accounts is read live, read-only, on every
    // owner's view, with a map saved or without: for the card to propose from
    // and the map's dropdowns to list (ADR 0063 §1, §4). A read that fails
    // costs its card, never this page (`postingSettingsFor`). The read signs in
    // to QuickBooks as the viewer and may refresh the company's token, so
    // nobody but an owner causes one (`qbo-settings-page.test.tsx`).
    const poster = qboPostingFromEnv();
    const posting =
      poster !== undefined && mayConnectLedger(session.org.role)
        ? await postingSettingsFor(poster, identity, await postingStoreFor(session).postingConnections())
        : undefined;
    const runs = new PostgresLedgerSyncStore({ connectionString: env.databaseUrl }, identity, store);
    return (
      <LedgerConnectionPage
        viewer={viewerOf(session)}
        connections={await runs.ledgerConnectionOverview()}
        mayConnect={mayConnectLedger(session.org.role)}
        deployment={
          configured.kind === 'ready'
            ? { environment: configured.app.environment }
            : { missing: configured.missing }
        }
        notice={qbo}
        today={new Date()}
        posts={poster !== undefined}
        posting={posting}
      />
    );
  } finally {
    await store.close();
  }
}
