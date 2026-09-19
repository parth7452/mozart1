/**
 * The configuration the app cannot run without, read once and loudly.
 *
 * A missing value fails at the first request rather than producing a page that
 * silently shows nothing, which is the failure mode that wastes an afternoon.
 * `siteUrl` is the one that used to break that rule, and it cost exactly that —
 * see the comment on it.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. See docs/supabase.md — the web app needs the ` +
        `Supabase project URL and publishable key for auth, and a DATABASE_URL ` +
        `whose role may "set role app_rw".`,
    );
  }
  return value;
}

export const env = {
  get supabaseUrl(): string {
    return required('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabasePublishableKey(): string {
    return required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  },
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  /**
   * The origin a magic link comes back to.
   *
   * This used to be `NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'`, and the
   * fallback was the bug: on a deployment with the variable unset, the app
   * cheerfully asked the auth provider to send people to localhost. The provider
   * refuses a redirect that is not on its allow list and quietly substitutes its
   * own Site URL, so the link lands on the home page, the callback never runs,
   * no session is created, and the person is bounced back to the login form with
   * nothing anywhere saying why. Every layer behaved reasonably; the only
   * evidence was an absence — no request for /auth/callback, ever.
   *
   * So the fallback is gone, and on Vercel the value is derived rather than
   * configured: the platform already knows the deployment's own hostname, and a
   * value the app can work out is a value nobody can typo. A trailing slash is
   * stripped because `${siteUrl}/auth/callback` would otherwise build a
   * double-slashed URL that does not match an allow list entry.
   */
  get siteUrl(): string {
    const configured = process.env.NEXT_PUBLIC_SITE_URL;
    if (configured !== undefined && configured !== '') {
      return configured.replace(/\/+$/, '');
    }

    // Vercel sets these itself. The production hostname is preferred: VERCEL_URL
    // is the per-deployment URL, which changes on every push and would send a
    // reviewer's magic link to a deployment nobody is looking at.
    const vercelHost =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
    if (vercelHost !== undefined && vercelHost !== '') {
      return `https://${vercelHost.replace(/\/+$/, '')}`;
    }

    // Local development, where localhost is the honest answer rather than a
    // guess standing in for missing configuration.
    if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';

    throw new Error(
      'NEXT_PUBLIC_SITE_URL is not set and no platform hostname was found. ' +
        'Magic links need the origin they should come back to; guessing one sends ' +
        'people somewhere that cannot sign them in. Set it to this deployment\'s ' +
        'own URL, with no trailing slash.',
    );
  },
};
