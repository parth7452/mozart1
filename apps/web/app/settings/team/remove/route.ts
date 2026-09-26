import type { NextRequest, NextResponse } from 'next/server';
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
 * Removes a member from this workspace (ADR 0051): the membership, never the
 * `users` row, which their past work names. Always asks first — the page shows
 * a confirmation, and only a second press carrying `confirmed=yes` removes.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  if (!mayManageTeam(session.org.role)) return teamRedirect(request, 'team_role');

  const form = await request.formData();
  const userId = form.get('userId');
  if (!isUuid(userId)) return teamRedirect(request, 'team_not_member');
  if (form.get('confirmed') !== 'yes') {
    return teamRedirect(request, 'team_remove_confirm', { param: 'confirm', userId });
  }

  const identity = { orgId: session.org.orgId, userId: session.userId };
  try {
    if (!(await storeFor(session).memberMayWrite(identity))) return teamRedirect(request, 'team_role');
    const was = await teamStoreFor(identity).remove(userId);
    console.info(
      `[recouple] team member removed: user ${userId} (was ${was}) org ${identity.orgId} ` +
        `by ${identity.userId}`,
    );
    return teamRedirect(request, 'team_removed');
  } catch (error) {
    const refused = teamRefusalNotice(error);
    if (refused !== undefined) return teamRedirect(request, refused);
    console.error(
      `[recouple] team removal failed: user ${userId} org ${identity.orgId} (${className(error)})`,
    );
    return teamRedirect(request, 'team_failed');
  }
}
