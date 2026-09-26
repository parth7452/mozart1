/**
 * How a session was signed in, from the access token's `amr` claim (ADR 0051 §6).
 *
 * Supabase Auth writes one entry per way the session was authenticated —
 * `{ method, timestamp }`, most recent first — and keeps them for the life of
 * the session, refreshes included (supabase/auth `internal/models/sessions.go`,
 * `CalculateAALAndAMR`, and `factor.go` for the method names). A password
 * sign-in is `"password"`.
 *
 * This decodes a token and verifies nothing: it is only ever handed the token
 * `getUser()` has just had the provider verify, and the caller checks that its
 * subject is the user the provider answered with.
 */

export interface TokenFacts {
  readonly subject: string;
  readonly methods: readonly string[];
}

/** The method a password sign-in is recorded as. This app never offers one. */
export const PASSWORD_METHOD = 'password';

/**
 * The only ways this app signs anybody in, as the provider records them: a
 * magic link or a sign-up confirmation exchanged by `/auth/callback` with PKCE
 * (`magiclink`, `email/signup`), and a link verified by `token_hash`, which
 * the provider records as `otp` (supabase/auth `internal/api/verify.go`,
 * `token.go`; a refresh adds nothing). An allowlist, not a refusal of
 * `password` alone: a method this app never uses is a session it did not make.
 */
export const EMAIL_LINK_METHODS: readonly string[] = ['otp', 'magiclink', 'email/signup'];

/** Whether every way this session was authenticated is one of the app's own. */
export function signedInByEmailLink(methods: readonly string[]): boolean {
  return methods.length > 0 && methods.every((method) => EMAIL_LINK_METHODS.includes(method));
}

function base64UrlToText(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * The subject and authentication methods a JWT's payload states, or
 * `undefined` for anything that is not a token with both. Never throws.
 */
export function tokenFacts(token: string | undefined): TokenFacts | undefined {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === '') return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlToText(parts[1]));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { sub, amr } = payload as { sub?: unknown; amr?: unknown };
  if (typeof sub !== 'string' || sub === '' || !Array.isArray(amr)) return undefined;

  const methods: string[] = [];
  for (const entry of amr) {
    // The provider writes objects; a custom access-token hook may write bare
    // strings (auth-js types the claim as either).
    const method =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? (entry as { method?: unknown }).method
          : undefined;
    if (typeof method !== 'string') return undefined;
    methods.push(method);
  }
  return { subject: sub, methods };
}
