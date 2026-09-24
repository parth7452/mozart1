import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { NOTICE_ABOUT_PARAM, SIGN_IN_DENIED_PARAM, resolveSignInNotice } from '../lib/notices';

/**
 * The two halves of signing in that ADR 0045 changed: the login form's action,
 * which must create nobody and answer every address alike, and
 * `requireSession`, which must sign out an identity the database refused — and
 * only such an identity.
 *
 * The Supabase client, the session resolver and Next's `redirect` are
 * stubbed. What is asserted is what the provider was asked, where the person
 * was sent, and whether a sign-out happened. A test that called Supabase would
 * be a test that sends mail.
 *
 * Where a person is sent is a notice *key* and its fragments, never a sentence
 * (`SIGN_IN_NOTICES`), and the login page shows nothing for anything else.
 */

const ADDRESS = 'someone@customer.example';
const SITE = 'https://app.example.test';

const { Redirected, harness } = vi.hoisted(() => {
  /** What `redirect()` throws here, so a test can read where it was sent. */
  class Redirected extends Error {
    constructor(readonly location: string) {
      super(`redirect to ${location}`);
    }
  }
  type SendError = { name: string; message: string; status?: number; code?: string };
  return {
    Redirected,
    harness: {
      otpCalls: [] as unknown[],
      otpError: null as SendError | null,
      user: { id: 'auth-user-1', email: 'member@example.test' } as { id: string; email?: string } | null,
      signOuts: [] as unknown[],
      signOutError: null as SendError | null,
      signOutThrows: false,
      resolve: (async () => ({ userId: 'user-1', orgs: [] })) as () => Promise<unknown>,
      /** What the magic link's landing hears back from the provider. */
      exchangeError: null as SendError | null,
      verifyError: null as SendError | null,
    },
  };
});

vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new Redirected(location);
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }),
}));

vi.mock('../lib/env', () => ({
  env: { siteUrl: SITE, databaseUrl: 'postgres://not-used.example/test' },
}));

vi.mock('../lib/supabase', () => ({
  supabaseForRequest: async () => ({
    auth: {
      async signInWithOtp(credentials: unknown) {
        harness.otpCalls.push(credentials);
        return { data: { user: null, session: null }, error: harness.otpError };
      },
      async getUser() {
        return { data: { user: harness.user }, error: null };
      },
      async signOut(options?: unknown) {
        harness.signOuts.push(options);
        if (harness.signOutThrows) throw new TypeError('fetch failed');
        return { error: harness.signOutError };
      },
      async exchangeCodeForSession() {
        return { data: { user: null, session: null }, error: harness.exchangeError };
      },
      async verifyOtp() {
        return { data: { user: null, session: null }, error: harness.verifyError };
      },
    },
  }),
}));

vi.mock('../lib/store', () => ({ tenantStore: () => ({}) }));

vi.mock('@recouple/store-postgres', () => ({
  resolveSession: async () => harness.resolve(),
}));

const { sendSignInLink } = await import('../app/login/actions');
const { requireSession } = await import('../lib/session');
const LoginPage = (await import('../app/login/page')).default;
const { GET: landLink } = await import('../app/auth/callback/route');

/** Where a call was sent. Fails the test if it returned instead. */
async function destination(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (thrown) {
    if (thrown instanceof Redirected) return thrown.location;
    throw thrown;
  }
  throw new Error('expected a redirect, and the call returned');
}

function form(email: string): FormData {
  const data = new FormData();
  data.set('email', email);
  return data;
}

/** What a redirect to the login page says: its key, its fragments, and the words they resolve to. */
function denial(location: string): { key: string | null; about: string[]; text: string | undefined } {
  const at = new URL(location, SITE);
  expect(at.pathname).toBe('/login');
  const key = at.searchParams.get(SIGN_IN_DENIED_PARAM);
  const about = at.searchParams.getAll(NOTICE_ABOUT_PARAM);
  return { key, about, text: resolveSignInNotice(key, about)?.text };
}

/** `Date.prototype.toISOString`'s shape: the reference a failure is logged under. */
const ISO_REFERENCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The login page as the server renders it, for these query parameters. */
async function loginPage(params: Record<string, string | string[]>): Promise<string> {
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

/** A Postgres error as `pg` raises it: a message and a SQLSTATE. */
function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

let logged: string[];

beforeEach(() => {
  harness.otpCalls = [];
  harness.otpError = null;
  harness.user = { id: 'auth-user-1', email: 'member@example.test' };
  harness.signOuts = [];
  harness.signOutError = null;
  harness.signOutThrows = false;
  harness.exchangeError = null;
  harness.verifyError = null;
  harness.resolve = async () => ({
    userId: 'user-1',
    orgs: [{ orgId: 'org-1', slug: 'acme', name: 'Acme', role: 'analyst' }],
  });
  logged = [];
  const record = (...args: unknown[]) => {
    logged.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the login form', () => {
  it('asks for a link that creates nobody, coming back to the callback', async () => {
    expect(await destination(sendSignInLink(form(` ${ADDRESS} `)))).toBe('/login?sent=1');
    expect(harness.otpCalls).toEqual([
      {
        email: ADDRESS,
        options: { emailRedirectTo: `${SITE}/auth/callback`, shouldCreateUser: false },
      },
    ]);
  });

  it('answers an address the provider has no account for exactly as it answers a sent link', async () => {
    const sent = await destination(sendSignInLink(form('member@example.test')));

    // The two refusals the auth server gives an address it will not send to.
    for (const code of ['otp_disabled', 'signup_disabled']) {
      harness.otpError = {
        name: 'AuthApiError',
        message: code === 'otp_disabled' ? 'Signups not allowed for otp' : 'Signups not allowed for this instance',
        status: 422,
        code,
      };
      expect(await destination(sendSignInLink(form(ADDRESS)))).toBe(sent);
    }
    expect(sent).toBe('/login?sent=1');
    // Recorded for the operator, without the address.
    expect(logged.join('\n')).toMatch(/otp_disabled/);
    expect(logged.join('\n')).toMatch(/signup_disabled/);
    expect(logged.join('\n')).not.toContain(ADDRESS);
  });

  it('answers a failure only an existing account can meet as sent, and logs it loudly', async () => {
    // Each of these is reached only by an address that has an account, so
    // showing it would say the account exists (ADR 0045 §1).
    const accountOnly = [
      {
        name: 'AuthApiError',
        message: 'For security purposes, you can only request this after 42 seconds.',
        status: 429,
        code: 'over_email_send_rate_limit',
      },
      { name: 'AuthApiError', message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' },
      { name: 'AuthApiError', message: 'Email address not authorized', status: 400, code: 'email_address_not_authorized' },
      { name: 'AuthRetryableFetchError', message: 'Error sending magic link email', status: 500 },
    ];
    for (const error of accountOnly) {
      harness.otpError = error;
      logged = [];
      expect(await destination(sendSignInLink(form(ADDRESS)))).toBe('/login?sent=1');
      expect(logged.join('\n')).toMatch(/NOT SENT/);
      expect(logged.join('\n')).toContain(error.message);
    }
  });

  it('shows a failure the provider raised before it looked at the address, in its own words', async () => {
    harness.otpError = {
      name: 'AuthApiError',
      message: 'Request rate limit reached',
      status: 429,
      code: 'over_request_rate_limit',
    };
    const limited = denial(await destination(sendSignInLink(form(ADDRESS))));
    expect(limited.key).toBe('request_limit');
    expect(limited.about).toHaveLength(1);
    expect(limited.about[0]).toMatch(ISO_REFERENCE);
    expect(limited.text).toMatch(/too many sign-in requests/);
    expect(limited.text).toContain(`(reference ${limited.about[0]})`);
    expect(limited.text).not.toContain('Request rate limit reached');
    // The reference is the one the log line was written under.
    expect(logged.join('\n')).toContain(`[sign-in link] ${limited.about[0]} — not sent`);

    harness.otpError = { name: 'AuthRetryableFetchError', message: 'fetch failed: ECONNRESET', status: 0 };
    const unreachable = denial(await destination(sendSignInLink(form(ADDRESS))));
    expect(unreachable.key).toBe('unreachable');
    expect(unreachable.about).toHaveLength(1);
    expect(unreachable.about[0]).toMatch(ISO_REFERENCE);
    expect(unreachable.text).toMatch(/could not be reached/);
    expect(unreachable.text).not.toContain('ECONNRESET');
    // The provider's words are in the log, where an operator reads them.
    expect(logged.join('\n')).toContain('ECONNRESET');
    expect(logged.join('\n')).toContain(`[sign-in link] ${unreachable.about[0]} — not sent`);
  });

  it('refuses a blank address without asking the provider', async () => {
    const to = await destination(sendSignInLink(form('   ')));
    expect(to).toBe('/login?denied=no_address');
    expect(denial(to).text).toBe('enter an email address');
    expect(harness.otpCalls).toEqual([]);
  });
});

describe('a session the database refuses', () => {
  it('keeps a member signed in', async () => {
    const session = await requireSession();
    expect(session.userId).toBe('user-1');
    expect(session.org.orgId).toBe('org-1');
    expect(harness.signOuts).toEqual([]);
  });

  it('signs out an identity with no invitation before sending it to the login page', async () => {
    harness.resolve = async () => {
      throw pgError('no invitation for stranger@example.test', '42501');
    };
    const to = await destination(requireSession());
    expect(to).toBe('/login?denied=not_invited');
    expect(denial(to).text).toBe('that address has not been invited to a workspace');
    // The default scope, global: every refresh token this identity holds.
    expect(harness.signOuts).toEqual([undefined]);
  });

  it('signs out an identity that is a member nowhere', async () => {
    harness.resolve = async () => ({ userId: 'user-9', orgs: [] });
    const to = await destination(requireSession());
    expect(to).toBe('/login?denied=no_membership');
    expect(denial(to).text).toBe('no membership for this account');
    expect(harness.signOuts).toEqual([undefined]);
  });

  it('signs nobody out on a fault, however it is worded', async () => {
    const faults = [
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6543'), { code: 'ECONNREFUSED' }),
      pgError('terminating connection due to administrator command', '57P01'),
      pgError('canceling statement due to statement timeout', '57014'),
      // Migration 0033's own refusals are an operator's to fix, not a verdict
      // on the person.
      pgError(
        'link_auth_user is the first-sign-in lookup and takes no claims: it runs before a session is resolved, and a caller carrying one is acting for somebody already',
        '42501',
      ),
      pgError(
        'more than one user answers to member@example.test, differing only in case: an operator must decide which one this sign-in is',
        '21000',
      ),
      // The words without the SQLSTATE are not the refusal.
      new Error('no invitation for member@example.test'),
      new Error('pool timed out while checking for an invitation: no invitation lookup ran'),
    ];
    for (const fault of faults) {
      harness.resolve = async () => {
        throw fault;
      };
      logged = [];
      const said = denial(await destination(requireSession()));
      expect(said.key).toBe('not_completed');
      expect(said.about).toHaveLength(1);
      expect(said.about[0]).toMatch(ISO_REFERENCE);
      expect(said.text).toBe(`sign-in could not be completed (reference ${said.about[0]})`);
      // Logged under the reference the person is shown, with the real message.
      expect(logged.join('\n')).toContain(`[sign-in failed] ${said.about[0]} — `);
      expect(logged.join('\n')).toContain(fault.message);
    }
    expect(harness.signOuts).toEqual([]);
  });

  it('does not sign out an address linked to another identity: that is an operator repair', async () => {
    harness.resolve = async () => {
      throw pgError('account for member@example.test is already linked to another identity', '42501');
    };
    const to = await destination(requireSession());
    expect(to).toBe('/login?denied=linked_elsewhere');
    expect(denial(to).text).toBe('that address is already linked to another sign-in');
    expect(harness.signOuts).toEqual([]);
  });

  it('refuses all the same when the sign-out itself fails, and says so in the log', async () => {
    harness.resolve = async () => ({ userId: 'user-9', orgs: [] });

    harness.signOutError = { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 };
    expect(await destination(requireSession())).toBe('/login?denied=no_membership');

    harness.signOutError = null;
    harness.signOutThrows = true;
    expect(await destination(requireSession())).toBe('/login?denied=no_membership');

    expect(harness.signOuts).toHaveLength(2);
    expect(logged.join('\n')).toMatch(/signing the session out failed \(AuthRetryableFetchError/);
    expect(logged.join('\n')).toMatch(/signing the session out threw/);
  });

  it('asks nothing of the database for a request with no session', async () => {
    harness.user = null;
    harness.resolve = async () => {
      throw new Error('resolveSession must not be reached');
    };
    expect(await destination(requireSession())).toBe('/login');
    expect(harness.signOuts).toEqual([]);
  });
});

describe('where the magic link lands', () => {
  async function land(query: string): Promise<string> {
    const response = await landLink(new NextRequest(`${SITE}/auth/callback${query}`));
    return response.headers.get('location') ?? '';
  }

  it('sends a link the provider will not honour to the login page, by key', async () => {
    harness.exchangeError = { name: 'AuthApiError', message: 'invalid flow state, no valid flow state found', status: 404 };
    expect(await land('?code=spent')).toBe(`${SITE}/login?denied=link_expired`);

    harness.verifyError = { name: 'AuthApiError', message: 'Email link is invalid or has expired', status: 403 };
    expect(await land('?token_hash=spent')).toBe(`${SITE}/login?denied=link_expired`);

    expect(await land('')).toBe(`${SITE}/login?denied=link_incomplete`);
    expect(denial(await land('')).text).toBe('that link is incomplete');
  });

  it('sends a link that worked to the case list', async () => {
    expect(await land('?code=fresh')).toBe(`${SITE}/`);
  });
});

describe('the login page', () => {
  it('shows a sign-in notice by its key, and a reference only in the shape one is written', async () => {
    const html = await loginPage({ denied: 'not_invited' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('that address has not been invited to a workspace');

    const reference = '2026-09-24T17:24:28.123Z';
    expect(await loginPage({ denied: 'not_completed', about: reference })).toContain(
      `sign-in could not be completed (reference ${reference})`,
    );
  });

  it('says nothing for a denied text that is not one of its keys', async () => {
    const forged = 'Your workspace has moved. Sign in at evil.example';
    for (const params of [
      { denied: forged },
      // The sentences it used to carry are not keys either.
      { denied: 'that address has not been invited to a workspace' },
      // Another page's notice is not this page's to say.
      { denied: 'approved' },
      { denied: '__proto__' },
      { denied: 'toString' },
      { denied: ['not_invited', 'no_membership'] },
      // A key with a fragment it does not take, or without one it does, or with
      // one that is not a reference.
      { denied: 'not_invited', about: forged },
      { denied: 'not_completed' },
      { denied: 'not_completed', about: forged },
      { denied: 'request_limit', about: '2026-09-24T17:24:28Z. Sign in at evil.example' },
      { denied: 'unreachable', about: ['2026-09-24T17:24:28.123Z', '2026-09-24T17:24:28.123Z'] },
    ]) {
      const html = await loginPage(params);
      expect(html, JSON.stringify(params)).not.toContain('role="alert"');
      expect(html, JSON.stringify(params)).not.toContain('evil.example');
      expect(html, JSON.stringify(params)).not.toContain('not been invited');
    }
  });

  it('still tells every address the same thing once a link is asked for', async () => {
    const html = await loginPage({ sent: '1' });
    expect(html).toContain('If that address belongs to a workspace, a sign-in link is on its way.');
    expect(html).not.toContain('role="alert"');
  });
});
