import { NextResponse, type NextRequest } from 'next/server';
import { intuitAuthorizeUrl } from '@recouple/qbo';
import { requireSession, storeFor } from '../../../../lib/session';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import { type NoticeKey } from '../../../../lib/notices';
import {
  issueOAuthState,
  mayConnectLedger,
  oauthStateCookie,
  qboConnectFromEnv,
  QBO_SETTINGS_PATH,
  QBO_STATE_COOKIE,
  QBO_STATE_MAX_AGE_SECONDS,
} from '../../../../lib/qbo-connect';

/**
 * Starts a QuickBooks consent: checks, a state cookie, and a redirect to Intuit
 * (ADR 0039 §1, §2).
 *
 * Nothing is written here and nothing is sent to Intuit but a browser. Every
 * refusal happens before the redirect, so a member who may not connect, or a
 * deployment that could not store the tokens, never reaches Intuit's consent
 * page at all.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // A POST from a button on our own page. Another site's page may not start a
  // consent in somebody's name.
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const settings = new URL(QBO_SETTINGS_PATH, request.url);
  const say = (notice: NoticeKey): NextResponse => {
    settings.searchParams.set('qbo', notice);
    return NextResponse.redirect(settings, { status: 303 });
  };

  // The better error message. The enforcement is the database's, at the
  // callback: only an owner's claim is admitted (migration 0030).
  if (!mayConnectLedger(session.org.role)) return say('qbo_role');

  const configured = qboConnectFromEnv();
  if (configured.kind !== 'ready') return say('qbo_not_configured');

  // The state cookie and the session are both host-only, and Intuit sends the
  // owner back to the redirect URI's host. A consent started anywhere else would
  // come back to a host that holds neither, so it is sent there to start again
  // rather than to Intuit (ADR 0039 §1).
  const home = new URL(configured.redirectUri);
  if (new URL(request.url).host !== home.host) {
    const there = new URL(QBO_SETTINGS_PATH, home.origin);
    there.searchParams.set('qbo', 'qbo_wrong_host');
    return NextResponse.redirect(there, { status: 303 });
  }

  const store = storeFor(session);
  try {
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return say('qbo_role');
    }
  } finally {
    await store.close();
  }

  const { state, cookieValue } = issueOAuthState({
    orgId: session.org.orgId,
    userId: session.userId,
    now: new Date(),
  });
  const response = NextResponse.redirect(
    intuitAuthorizeUrl({
      clientId: configured.app.clientId,
      redirectUri: configured.redirectUri,
      state,
    }),
    { status: 303 },
  );
  // The cookie outlives the state by a minute, so a consent that took too long
  // comes back with its cookie and is refused as expired — not as a request
  // that never carried one, which the callback treats as a possible repeat.
  response.cookies.set(QBO_STATE_COOKIE, cookieValue, oauthStateCookie(QBO_STATE_MAX_AGE_SECONDS + 60));
  return response;
}
