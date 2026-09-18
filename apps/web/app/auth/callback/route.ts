import { NextResponse, type NextRequest } from 'next/server';
import { supabaseForRequest } from '../../../lib/supabase';

/**
 * Where the magic link lands. Exchanges the code for a session and sends the
 * reviewer to the case list; `requireSession` does the rest, because resolving
 * which tenant they belong to is the same work on every request.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const supabase = await supabaseForRequest();

  if (code !== null) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error !== null) {
      return NextResponse.redirect(new URL('/login?denied=that+link+has+expired', url));
    }
  } else if (tokenHash !== null) {
    const { error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash });
    if (error !== null) {
      return NextResponse.redirect(new URL('/login?denied=that+link+has+expired', url));
    }
  } else {
    return NextResponse.redirect(new URL('/login?denied=that+link+is+incomplete', url));
  }

  return NextResponse.redirect(new URL('/', url));
}
