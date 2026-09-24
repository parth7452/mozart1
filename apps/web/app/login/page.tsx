import { Wordmark } from '../../components/workspace-shell';
import { SignInButton } from '../../components/sign-in-button';
import { sendSignInLink } from './actions';

/**
 * A magic link, because a password is one more secret for a finance team to keep
 * and the address is what the invitation was issued against anyway.
 *
 * The form says the same thing for every address, invited or not: an attacker
 * should not learn who has a workspace by typing addresses into it. Since ADR
 * 0045 that takes deliberate work. The provider no longer creates an account
 * for an unknown address, so an unknown address comes back refused, and only an
 * address that has an account reaches the mailer. A refusal, and every failure
 * only an existing account can meet (a cooldown, the mail quota, the mailer
 * itself), would each say "this one exists" if shown. `sendSignInLink` answers
 * all of them as sent and logs them. It shows only what the provider refuses
 * before it looks at the address. The empty-inbox failure the previous version
 * of this page guarded against is still visible, in the log where an operator
 * looks, and the sent notice tells the person what to do. It is just no longer
 * told to whoever is typing addresses in.
 *
 * Whether an address is *invited* is still answered only after sign-in, to the
 * person who holds that mailbox (`requireSession`).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; denied?: string }>;
}) {
  const params = await searchParams;

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
          <form action={sendSignInLink}>
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
              Nothing within a few minutes? Sign-in emails are rate-limited: wait and
              try again, or ask whoever invited you.
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

