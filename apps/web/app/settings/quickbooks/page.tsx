import { PostgresLedgerSyncStore } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../lib/session';
import { env } from '../../../lib/env';
import { mayConnectLedger, qboConnectFromEnv } from '../../../lib/qbo-connect';
import { LedgerConnectionPage } from '../../../components/ledger-connection';

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
    const runs = new PostgresLedgerSyncStore({ connectionString: env.databaseUrl }, identity, store);
    return (
      <LedgerConnectionPage
        viewer={{ email: session.email, orgName: session.org.name, role: session.org.role }}
        connections={await runs.ledgerConnectionOverview()}
        mayConnect={mayConnectLedger(session.org.role)}
        deployment={
          configured.kind === 'ready'
            ? { environment: configured.app.environment }
            : { missing: configured.missing }
        }
        notice={qbo}
        today={new Date()}
      />
    );
  } finally {
    await store.close();
  }
}
