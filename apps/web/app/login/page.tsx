import { redirect } from 'next/navigation';
import { supabaseForRequest } from '../../lib/supabase';
import { env } from '../../lib/env';

/**
 * A magic link, because a password is one more secret for a finance team to keep
 * and the address is what the invitation was issued against anyway.
 *
 * The form says the same thing whether or not the address is known: an attacker
 * should not be able to use the login page to learn who has an account.
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
    await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${env.siteUrl}/auth/callback` },
    });
    // Deliberately not branching on the result: "no such account" is not ours to
    // disclose here. An address with no invitation is refused after sign-in,
    // where the person asking is at least authenticated.
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
