import { redirect } from 'next/navigation';
import { supabaseForRequest } from '../../lib/supabase';
import { env } from '../../lib/env';
import { Wordmark } from '../../components/workspace-shell';
import { SignInButton } from '../../components/sign-in-button';

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
    <main className="login-page">
      <section className="login-story" aria-label="Mozart Financial">
        <a
          className="brand-link"
          href="https://mozart.financial/"
          aria-label="Mozart Financial home"
        >
          <Wordmark />
        </a>
        <div className="login-story-content">
          <p className="eyebrow">REVENUE, RECONCILED.</p>
          <h2>
            Your revenue.
            <br />
            <span>Orchestrated.</span>
          </h2>
          <p>
            The work behind every recovered dollar,
            <br />
            brought into harmony.
          </p>
          <div className="score-art" aria-hidden="true">
            {[30, 52, 38, 74, 94, 64, 44, 80, 100, 58, 35, 68, 85, 48, 28].map((height, i) => (
              <i key={i} style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
        <div className="login-story-footer">
          <span>EVIDENCE FIRST. ALWAYS.</span>
          <span>01 / MOZART</span>
        </div>
      </section>
      <section className="login-panel">
        <a className="login-back" href="https://mozart.financial/">
          ← Back to Mozart Financial
        </a>
        <div className="login">
          <div className="login-emblem" aria-hidden="true">
            m<span>.</span>
          </div>
          <p className="eyebrow">YOUR DEDUCTIONS WORKSPACE</p>
          <h1>Welcome back.</h1>
          <p className="login-intro" id="sign-in-description">
            Sign in with the address your workspace invited.
          </p>
          <form action={sendLink}>
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              name="email"
              placeholder="you@company.com"
              autoComplete="email"
              aria-describedby="sign-in-description"
              required
            />
            <SignInButton />
          </form>
          {params.sent !== undefined ? (
            <p className="notice sent" role="status">
              If that address belongs to a workspace, a sign-in link is on its way.
            </p>
          ) : null}
          {params.denied !== undefined ? (
            <p className="notice bad" role="alert">
              {params.denied}
            </p>
          ) : null}
          <p className="login-fineprint">
            A secure link, straight to your inbox.
            <br />
            No password to remember.
          </p>
          <div className="login-help">
            New to Mozart?{' '}
            <a href="https://mozart.financial/#contact">
              Get in touch <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
        <p className="login-footer">
          Your team stays in control. Nothing is submitted without approval.
        </p>
      </section>
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
