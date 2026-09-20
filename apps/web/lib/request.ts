import { NextResponse } from 'next/server';

/**
 * A UUID, not thirty-six characters that look like one.
 *
 * Every id in this app is a `uuid` column, and Postgres refuses anything else
 * with a 22P02 that surfaces as a 500. A route that checks the shape first can
 * answer instead of failing — and it must check the *real* shape: `------------`
 * and `deadbeef-deadbeef-deadbeef-dead` both pass a lazy `[0-9a-f-]{36}` and
 * neither is a UUID.
 *
 * One pattern, in one place, because the version that drifted was the one on
 * the review page while the decline route right beside it was strict.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Whether a request came from somewhere that is not this app.
 *
 * The session cookie is `SameSite=Lax`, which already stops a cross-site POST
 * carrying it — but that is a property of Supabase's cookie options, set in a
 * different file, and both POST handlers here happen to write to the database.
 * Inheriting a defence is not the same as having one, so the origin is checked
 * where the write is.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be set by page script.
 * Absent means a client that does not send it (curl, an older browser, a server
 * -side fetch), and that is not evidence of a cross-site request — those never
 * carry the cookie either, so a session is what stops them. `none` is a user
 * typing the URL or a bookmark. Anything else — `cross-site`, `same-site` from
 * another subdomain — is refused.
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

/**
 * The refusal for a cross-site write: a 403, and no redirect.
 *
 * Deliberately not a redirect back into the app. A redirect is a reply another
 * site can point a form at and watch succeed; a 403 with no body says nothing
 * about whether the session existed or what the id was.
 */
export function refuseCrossSite(): NextResponse {
  return new NextResponse('cross-site request refused', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
