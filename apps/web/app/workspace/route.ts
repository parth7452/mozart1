import { NextResponse, type NextRequest } from 'next/server';
import { isCrossSite, isUuid, refuseCrossSite } from '../../lib/request';
import { ORG_COOKIE, requireSession } from '../../lib/session';

/** A year: the choice is a preference, and the session is what expires. */
const ORG_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Switches the workspace this person is looking at.
 *
 * Only a tenant the database has just said this person belongs to is
 * accepted — `requireSession` asks `app.my_orgs()` on this request — and
 * anything else is refused with nothing set, never trusted. The cookie that
 * results is not a grant: `requireSession` checks it against the same answer
 * on every request after, and every query runs under RLS with the claims that
 * check chose, so a cookie edited by hand falls through to a real membership.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();

  let wanted: unknown;
  try {
    wanted = (await request.formData()).get('org_id');
  } catch {
    return refuse(400, 'no workspace chosen');
  }
  if (!isUuid(wanted)) return refuse(400, 'no workspace chosen');

  const org = session.orgs.find((candidate) => candidate.orgId.toLowerCase() === wanted.toLowerCase());
  if (org === undefined) return refuse(403, 'not one of your workspaces');

  const response = NextResponse.redirect(new URL('/', request.url), { status: 303 });
  response.cookies.set(ORG_COOKIE, org.orgId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ORG_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

function refuse(status: 400 | 403, why: string): NextResponse {
  return new NextResponse(why, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
