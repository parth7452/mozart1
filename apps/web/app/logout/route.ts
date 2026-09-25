import { NextResponse, type NextRequest } from 'next/server';
import { isCrossSite, refuseCrossSite } from '../../lib/request';
import { supabaseForRequest } from '../../lib/supabase';
import { ORG_COOKIE } from '../../lib/session';

/**
 * Signs the person out, at the provider as well as here, and forgets which
 * workspace they were looking at.
 *
 * Cross-site is refused like every other write: signing somebody out is
 * harmless on its face, but a page elsewhere that can do it can also sign them
 * out mid-review on every visit. `signOut()`'s default scope is global, so
 * every refresh token this identity holds is revoked, not just this browser's.
 *
 * A failed revocation is logged and the person is still sent to the login page
 * with this browser's cookies cleared: they asked to leave, and a 500 would
 * keep them signed in here as well. 303, so the browser follows with a GET.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const supabase = await supabaseForRequest();
  try {
    const { error } = await supabase.auth.signOut();
    if (error !== null) {
      console.error(
        `[sign-out] revoking the session failed (${error.name}, HTTP ${error.status ?? '(none)'}); ` +
          'the cookies here are cleared regardless',
      );
    }
  } catch (cause) {
    console.error('[sign-out] revoking the session threw; the cookies here are cleared regardless', cause);
  }
  const response = NextResponse.redirect(new URL('/login', request.url), { status: 303 });
  response.cookies.delete(ORG_COOKIE);
  return response;
}
