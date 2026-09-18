import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { env } from './lib/env';

/**
 * Refreshes the Supabase session on every request.
 *
 * A server component cannot set cookies, so a token that expires while someone
 * is reading a case would log them out mid-review with nothing to show for it.
 * This runs where cookies can still be written: it asks Supabase who the user is,
 * which rotates the token if it is due, and carries the new cookies out on the
 * response.
 *
 * It authenticates nothing. Every page and route calls `requireSession()` for
 * that, because a redirect here would be one more place that has to agree with
 * the database about who may see what.
 *
 * (Next 16 renamed `middleware` to `proxy`; the runtime is Node, which is what
 * this needs anyway.)
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next({ request });

  const supabase = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(toSet) {
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // The call is the point: it is what rotates an expiring token. The answer is
  // deliberately ignored here.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // Everything but the static assets and the document route, which is already
  // behind `requireSession()` and does not want a token refresh per page image.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/document).*)'],
};
