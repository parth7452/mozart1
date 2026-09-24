'use server';

import { redirect } from 'next/navigation';
import { env } from '../../lib/env';
import { signInDenied, type SignInNoticeKey } from '../../lib/notices';
import { supabaseForRequest } from '../../lib/supabase';

/**
 * Sends a magic link to an address that already has an account, and creates
 * none (ADR 0045).
 *
 * `shouldCreateUser: false` is the whole of closing sign-ups in code. Without
 * it auth-js sends `create_user: true`, and every address typed here became a
 * Supabase Auth user holding a working link. The database still refused them at
 * `app.link_auth_user()`, but they held a session the proxy kept refreshing,
 * and the list of auth users stopped being a list of the people anyone invited.
 * An invitation now creates the auth user, from the dashboard (apps/web/DEPLOY.md).
 *
 * The redirect is the same for every address the provider will not send to,
 * which is what keeps this form from saying who has an account. See
 * `failureToShow` for which failures are still shown, and why so few.
 */
export async function sendSignInLink(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (email === '') redirect(signInDenied('no_address'));

  const supabase = await supabaseForRequest();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${env.siteUrl}/auth/callback`,
      shouldCreateUser: false,
    },
  });

  if (error !== null) {
    const shown = failureToShow(error);
    if (shown !== undefined) redirect(signInDenied(shown.key, shown.reference));
  }
  redirect('/login?sent=1');
}

/** What auth-js hands back on a refused or failed send: an `AuthError`'s fields. */
interface SendError {
  readonly name: string;
  readonly message: string;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
}

/**
 * The provider's two answers for an address it will not send a link to. As
 * the auth server returns them (supabase/auth `internal/api/otp.go` and
 * `signup.go`; listed in auth-js's `src/lib/error-codes.ts`):
 *
 * - `otp_disabled`: `create_user` is false and there is no user with that
 *   address. The stranger's answer.
 * - `signup_disabled`: the project has sign-ups switched off, and the address
 *   has no user or one that has never confirmed. The second case is an invited
 *   person who has not yet followed their invitation.
 */
const REFUSED_ADDRESS = new Set(['otp_disabled', 'signup_disabled']);

/** A failure the form shows: which notice, and the reference it was logged under. */
interface ShownFailure {
  readonly key: SignInNoticeKey;
  readonly reference: string;
}

/**
 * The notice to show for a send that failed, or `undefined` to answer "sent".
 *
 * Before ADR 0045 the provider created an account for any address and then
 * mailed it, so every address reached the mail step. A send error then said
 * nothing about who existed, and showing it cost nothing. Now only an address
 * that already has an account reaches the mailer. Every failure raised there
 * answers "does this address have an account?": the per-address cooldown
 * ("you can only request this after N seconds", after two submissions a few
 * seconds apart), the hourly mail quota, the built-in mailer's refusal of an
 * address outside the Supabase team, and an SMTP failure. So those are answered
 * as sent, and logged.
 *
 * Shown are only the failures the provider raises before it looks at the
 * address: its per-client request limit, and a request that never got an HTTP
 * answer at all. Each is a notice key in our own words (`SIGN_IN_NOTICES`) and
 * a reference, never the provider's message.
 *
 * Nothing is swallowed. Every failure is logged with the same reference, the
 * code, the status and the provider's message. The log is where an operator
 * looks for "I was invited and no mail came". The sent notice tells the person
 * what to do if nothing arrives, and every address gets that notice.
 */
function failureToShow(error: SendError): ShownFailure | undefined {
  const reference = new Date().toISOString();
  const detail = `${error.name} ${error.code ?? '(no code)'}, HTTP ${error.status ?? '(none)'}`;

  if (error.code !== undefined && REFUSED_ADDRESS.has(error.code)) {
    // Expected for every stranger, and not a fault. Logged without the
    // provider's message, which is the same every time and says nothing more.
    console.warn(
      `[sign-in link] ${reference} — no link sent: the provider has no account it ` +
        `will send to at that address (${detail}). Answered as sent (ADR 0045).`,
    );
    return undefined;
  }

  if (error.code === 'over_request_rate_limit') {
    console.error(
      `[sign-in link] ${reference} — not sent: the provider's request limit (${detail}). ` +
        `Shown, because it is reached before the address is looked at. ${error.message}`,
    );
    return { key: 'request_limit', reference };
  }

  if (error.status === 0) {
    console.error(
      `[sign-in link] ${reference} — not sent: the sign-in service could not be reached ` +
        `(${detail}). Shown, because no address was looked at. ${error.message}`,
    );
    return { key: 'unreachable', reference };
  }

  console.error(
    `[sign-in link] ${reference} — NOT SENT (${detail}). Answered as sent, because only ` +
      `an address that has an account reaches the step that failed, and saying so would ` +
      `tell anyone who has one (ADR 0045). ${error.message}`,
  );
  return undefined;
}
