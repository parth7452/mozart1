import { requireSession } from '../../../lib/session';
import { isUuid } from '../../../lib/request';
import { mayManageTeam } from '../../../lib/team-words';
import { teamStoreFor } from '../../../lib/team';
import { viewerOf } from '../../../lib/viewer';
import { TeamPage } from '../../../components/team';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team: resolve the member, read, render (ADR 0051).
 *
 * The list is this tenant's through RLS, as the member signed in, and every
 * member sees it. The ids in the query string only pick a row out of that list
 * — one not in it shows nothing.
 */
export default async function TeamSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string; invited?: string; confirm?: string }>;
}) {
  const session = await requireSession();
  const { team, invited, confirm } = await searchParams;
  const identity = { orgId: session.org.orgId, userId: session.userId };

  return (
    <TeamPage
      viewer={viewerOf(session)}
      viewerUserId={session.userId}
      members={await teamStoreFor(identity).members()}
      mayManage={mayManageTeam(session.org.role)}
      notice={team}
      invited={isUuid(invited) ? invited : undefined}
      confirmRemove={isUuid(confirm) ? confirm : undefined}
    />
  );
}
