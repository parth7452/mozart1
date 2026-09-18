import { requireSession, storeFor } from '../lib/session';
import { CaseList } from '../components/case-list';

export const dynamic = 'force-dynamic';

/**
 * The case list route: resolve the reviewer, read, render.
 *
 * The read goes through RLS, so "this tenant's cases" is the database's answer
 * rather than a filter this page remembered to apply.
 */
export default async function CaseListPage() {
  const session = await requireSession();
  const store = storeFor(session);
  try {
    return (
      <CaseList
        viewer={{ email: session.email, orgName: session.org.name, role: session.org.role }}
        cases={await store.listCases()}
        today={new Date()}
      />
    );
  } finally {
    await store.close();
  }
}
