import { requireSession, storeFor } from '../../lib/session';
import { qboEnvironmentFromEnv } from '../../lib/qbo-connect';
import { CoveragePage } from '../../components/coverage-report';

export const dynamic = 'force-dynamic';

/**
 * Coverage: resolve the member, read, render (ADR 0030, ADR 0035).
 *
 * Every member sees it, `read_only` included: both reads are SELECTs under RLS
 * and the page has no action on it. A read that fails is thrown, not rendered
 * as an empty page — "nothing found" and "could not read" are different facts.
 */
export default async function CoverageRoute() {
  const session = await requireSession();
  const store = storeFor(session);
  try {
    const coverage = await store.coverageReport();
    const ledger = await store.ledgerSyncHealth();
    return (
      <CoveragePage
        viewer={{ email: session.email, orgName: session.org.name, role: session.org.role }}
        coverage={coverage}
        ledger={ledger}
        environment={qboEnvironmentFromEnv()}
        now={new Date()}
      />
    );
  } finally {
    await store.close();
  }
}
