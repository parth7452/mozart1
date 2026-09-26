'use server';

import { redirect } from 'next/navigation';
import { addressIsInvited } from '@recouple/store-postgres';
import { env } from '../../lib/env';
import { signInDenied, type SignInNoticeKey } from '../../lib/notices';
import { supabaseForRequest } from '../../lib/supabase';

/**
 * Sends a magic link, and lets the provider create an account only for an
 * address somebody invited (ADR 0045, ADR 0051 §6).
 *
 * `shouldCreateUser` is decided by the database, not by the form: it is `true`
 * only when `app.address_is_invited()` says exactly one `users` row answers to
 * the address and it has a membership — someone an owner added on Settings →
 * Team, or an operator added by SQL. Then the provider creates the account and
 * mails one link, and nobody has to press anything in the Supabase dashboard.
 * For every other address it is `false`, exactly as ADR 0045 made it: auth-js
 * would otherwise send `create_user: true`, and every address typed here would
 * become a Supabase Auth user holding a working link.
 *
 * This is the form's half of the gate and not the whole of it. The anon key is
 * public, so anyone can call the provider's own endpoints without this form;
 * the provider's `before-user-created` hook (`hooks.before_user_created`)
 * asks the database the same question for every account, however it was asked
 * for, and `requireSession` refuses a session signed in with a password (ADR
 * 0051 §6).
 *
 * The redirect is the same for every address the provider will not send to,
 * invited or not, which is what keeps this form from saying who has an account
 * or an invitation. See `failureToShow` for which failures are still shown, and
 * why so few. A fault asking the database is shown, with a reference: it does
 * not depend on the address, so saying so tells nobody anything about one.
 */
export async function sendSignInLink(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (email === '') redirect(signInDenied('no_address'));

  let invited: boolean;
  try {
    invited = await addressIsInvited({ connectionString: env.databaseUrl }, email);
  } catch (cause) {
    const reference = new Date().toISOString();
    console.error(
      `[sign-in link] ${reference} — not sent: asking the database whether the address is ` +
        `invited failed. This is a configuration or connectivity fault, not a refusal. ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    redirect(signInDenied('not_completed', reference));
  }

  const supabase = await supabaseForRequest();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${env.siteUrl}/auth/callback`,
      shouldCreateUser: invited,
    },
  });

  if (error !== null) {
    const shown = failureToShow(error, invited);
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
function failureToShow(error: SendError, invited: boolean): ShownFailure | undefined {
  const reference = new Date().toISOString();
  const detail = `${error.name} ${error.code ?? '(no code)'}, HTTP ${error.status ?? '(none)'}`;

  if (error.code !== undefined && REFUSED_ADDRESS.has(error.code)) {
    if (invited) {
      // The database said this address is invited and the provider still would
      // not make its account: sign-ups are switched off at the provider, or the
      // hook disagrees with the database. Somebody invited is getting no mail,
      // which is an operator's problem — logged as one, answered as sent all
      // the same, so the page says nothing about who is invited.
      console.error(
        `[sign-in link] ${reference} — NOT SENT to an invited address: the provider refused ` +
          `to create its account (${detail}). Check "Allow new users to sign up" and the ` +
          `before-user-created hook (ADR 0051 §6). Answered as sent. ${error.message}`,
      );
      return undefined;
    }
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
