import { NextResponse, type NextRequest } from 'next/server';
import { signInDenied } from '../../../lib/notices';
import { supabaseForRequest } from '../../../lib/supabase';

/**
 * Where the magic link lands. Exchanges the code for a session and sends the
 * reviewer to the case list; `requireSession` does the rest, because resolving
 * which tenant they belong to is the same work on every request. That includes
 * refusing an identity the database does not know. `requireSession` signs the
 * refused identity out at the provider before it redirects (ADR 0045), so a
 * session made here for somebody with no invitation does not outlive the first
 * page that asks who they are.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const supabase = await supabaseForRequest();

  if (code !== null) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error !== null) {
      return NextResponse.redirect(new URL(signInDenied('link_expired'), url));
    }
  } else if (tokenHash !== null) {
    const { error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash });
    if (error !== null) {
      return NextResponse.redirect(new URL(signInDenied('link_expired'), url));
    }
  } else {
    return NextResponse.redirect(new URL(signInDenied('link_incomplete'), url));
  }

  return NextResponse.redirect(new URL('/', url));
}
