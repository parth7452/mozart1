/**
 * The configuration the app cannot run without, read once and loudly.
 *
 * A missing value fails at the first request rather than producing a page that
 * silently shows nothing, which is the failure mode that wastes an afternoon.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. See recouple/docs/supabase.md — the web app needs the ` +
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
  /** Where the magic link comes back to. */
  get siteUrl(): string {
    return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  },
};
