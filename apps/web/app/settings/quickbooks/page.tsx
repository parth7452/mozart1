import { PostgresLedgerSyncStore } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../lib/session';
import { env } from '../../../lib/env';
import { mayConnectLedger, qboConnectFromEnv } from '../../../lib/qbo-connect';
import { LedgerConnectionPage } from '../../../components/ledger-connection';
import { viewerOf } from '../../../lib/viewer';
import { qboPostingFromEnv } from '../../../lib/qbo-posting';
import { postingStoreFor } from '../../../lib/posting';

export const dynamic = 'force-dynamic';

/**
 * Settings → QuickBooks: resolve the member, read, render (ADR 0039 §12).
 *
 * The read goes through RLS like every other: this tenant's connections are
 * the policies' answer, and nothing selected here is a credential.
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
    // is an owner: the switch and the map are theirs alone (ADR 0060 §5).
    const posting =
      qboPostingFromEnv() !== undefined && mayConnectLedger(session.org.role)
        ? await postingStoreFor(session).postingConnections()
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
        posting={posting}
      />
    );
  } finally {
    await store.close();
  }
}
