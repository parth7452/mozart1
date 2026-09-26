import type { NextRequest, NextResponse } from 'next/server';
import { isMembershipRole } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../../lib/session';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import {
  className,
  mayManageTeam,
  teamRedirect,
  teamRefusalNotice,
  teamStoreFor,
} from '../../../../lib/team';

/** The same limits `app.invite_member` holds; checked here only to answer sooner. */
const EMAIL_MAX = 254;
const NAME_MAX = 200;

/**
 * Adds a person to this workspace (ADR 0051): a `users` row, reused when one
 * already answers to the address ignoring capitals, and a membership. Creates
 * no sign-in here: the sign-in form lets the provider create their account the
 * first time they ask for a link, because the database now says the address is
 * invited (§6). The notice is the same whether or not they have signed in
 * before, so adding an address tells an owner nothing about it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  if (!mayManageTeam(session.org.role)) return teamRedirect(request, 'team_role');

  const form = await request.formData();
  const email = form.get('email');
  const fullName = form.get('fullName') ?? '';
  const role = form.get('role');
  if (
    typeof email !== 'string' ||
    email.trim() === '' ||
    email.length > EMAIL_MAX ||
    typeof fullName !== 'string' ||
    fullName.length > NAME_MAX ||
    !isMembershipRole(role)
  ) {
    return teamRedirect(request, 'team_invalid');
  }

  const identity = { orgId: session.org.orgId, userId: session.userId };
  try {
    if (!(await storeFor(session).memberMayWrite(identity))) return teamRedirect(request, 'team_role');
    const invited = await teamStoreFor(identity).invite({ email, fullName, role });
    console.info(
      `[recouple] team member invited: user ${invited.userId} as ${role} org ${identity.orgId} ` +
        `by ${identity.userId} (users row ${invited.usersRowCreated ? 'created' : 'reused'})`,
    );
    return teamRedirect(request, 'team_invited', { param: 'invited', userId: invited.userId });
  } catch (error) {
    const refused = teamRefusalNotice(error);
    if (refused !== undefined) return teamRedirect(request, refused);
    console.error(`[recouple] team invite failed: org ${identity.orgId} (${className(error)})`);
    return teamRedirect(request, 'team_failed');
  }
}
