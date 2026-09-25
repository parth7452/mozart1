import type { Viewer } from '../components/case-list';
import type { Session } from './session';

/**
 * What the sidebar shows about the person signed in, from the session the
 * database answered.
 *
 * `workspaces` is every tenant `app.my_orgs()` returned, and nothing else: the
 * switcher offers only those, and `/workspace` re-checks the choice against
 * the same answer on its own request. Kept apart from `session.ts` so a test
 * that stands in for the session still renders the real sidebar.
 */
export function viewerOf(session: Session): Viewer {
  return {
    email: session.email,
    orgName: session.org.name,
    role: session.org.role,
    orgId: session.org.orgId,
    workspaces: session.orgs.map((org) => ({ orgId: org.orgId, name: org.name, slug: org.slug })),
  };
}
