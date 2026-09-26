import type { NextRequest, NextResponse } from 'next/server';
import { isMembershipRole } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import {
  className,
  mayManageTeam,
  teamRedirect,
  teamRefusalNotice,
  teamStoreFor,
} from '../../../../lib/team';

/**
 * Changes a member's role (ADR 0051). The database refuses leaving the
 * workspace with no owner, with fewer than two writers, or demoting whoever a
 * QuickBooks connection or an email address acts as; each is its own notice.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  if (!mayManageTeam(session.org.role)) return teamRedirect(request, 'team_role');

  const form = await request.formData();
  const userId = form.get('userId');
  const role = form.get('role');
  if (!isUuid(userId)) return teamRedirect(request, 'team_not_member');
  if (!isMembershipRole(role)) return teamRedirect(request, 'team_invalid');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  try {
    if (!(await storeFor(session).memberMayWrite(identity))) return teamRedirect(request, 'team_role');
    const was = await teamStoreFor(identity).changeRole(userId, role);
    if (was === role) return teamRedirect(request, 'team_role_unchanged');
    console.info(
      `[recouple] team role changed: user ${userId} ${was} -> ${role} org ${identity.orgId} ` +
        `by ${identity.userId}`,
    );
    return teamRedirect(request, 'team_role_changed');
  } catch (error) {
    const refused = teamRefusalNotice(error);
    if (refused !== undefined) return teamRedirect(request, refused);
    console.error(
      `[recouple] team role change failed: user ${userId} org ${identity.orgId} (${className(error)})`,
    );
    return teamRedirect(request, 'team_failed');
  }
}
