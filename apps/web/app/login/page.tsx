import { redirect } from 'next/navigation';
import { supabaseForRequest } from '../../lib/supabase';
import { env } from '../../lib/env';

/**
 * A magic link, because a password is one more secret for a finance team to keep
 * and the address is what the invitation was issued against anyway.
 *
 * The form says the same thing whether or not the address is *invited*: an
 * attacker should not learn who has a workspace by typing addresses into it.
 * That is not the same as hiding whether the mail went out. The provider creates
 * an account for an unknown address either way, so its send errors carry no
 * information about who exists — and swallowing them means a rate-limited or
 * misconfigured mailer looks exactly like success, which is how you end up
 * staring at an empty inbox with no idea why.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; denied?: string }>;
}) {
  const params = await searchParams;

  async function sendLink(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').trim();
    if (email === '') redirect('/login?denied=enter+an+email+address');

    const supabase = await supabaseForRequest();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${env.siteUrl}/auth/callback` },
    });

    if (error !== null) {
      // Whether the address is invited is still not disclosed — that refusal
      // happens after sign-in, where the person asking is authenticated. What is
      // reported here is only whether *we* managed to send anything.
      redirect(`/login?denied=${encodeURIComponent(sendFailure(error))}`);
    }
    redirect('/login?sent=1');
  }

  return (
    <main className="login">
      <h1>Recouple</h1>
      <p>Sign in with the address your workspace invited.</p>
      <form action={sendLink}>
        <input type="email" name="email" placeholder="you@company.com" autoComplete="email" required />
        <button className="primary" type="submit">
          Email me a sign-in link
        </button>
      </form>
      {params.sent !== undefined ? (
        <p className="notice sent">
          If that address belongs to a workspace, a sign-in link is on its way.
        </p>
      ) : null}
      {params.denied !== undefined ? <p className="notice bad">{params.denied}</p> : null}
    </main>
  );
}

/**
 * What to tell someone whose sign-in link was never sent.
 *
 * The rate limit is called out by name because it is the one a small team hits
 * constantly and the only one where "wait" is the right advice: the provider's
 * built-in mailer is a testing convenience, a couple of messages an hour, and it
 * fails silently from the sender's point of view.
 */
function sendFailure(error: { status?: number | undefined; message: string }): string {
  const message = error.message.toLowerCase();
  if (error.status === 429 || message.includes('rate limit') || message.includes('too many')) {
    return (
      'too many sign-in emails have been sent recently — the built-in mail service ' +
      'allows only a couple an hour. Wait, or configure your own SMTP.'
    );
  }
  if (message.includes('redirect')) {
    return 'that sign-in link could not be built: this site’s callback URL is not on the provider’s allow list.';
  }
  return `the sign-in email could not be sent: ${error.message}`;
}
