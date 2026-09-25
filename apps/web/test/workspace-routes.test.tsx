import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * `/workspace` and `/logout`, the two POSTs the sidebar makes (pilot E4).
 *
 * The session and the Supabase client are stand-ins. What is asserted is the
 * order of the checks — cross-site before anything is resolved or revoked —
 * that `/workspace` sets the cookie only for a workspace the session's own
 * `orgs` names, with the attributes that keep script and other sites off it,
 * and that `/logout` revokes at the provider and forgets the workspace.
 * `requireSession`'s own check of the cookie is `workspace-cookie.test.tsx`'s.
 */
const SITE = 'https://app.example.test';
const ACME = '11111111-1111-1111-1111-111111111111';
const BETA = '44444444-4444-4444-4444-444444444444';
const STRANGER = '99999999-9999-9999-9999-999999999999';

const { Redirected, harness } = vi.hoisted(() => {
  class Redirected extends Error {
    constructor(readonly location: string) {
      super(`redirect to ${location}`);
    }
  }
  return {
    Redirected,
    harness: {
      sessions: 0,
      signedIn: true,
      signOuts: 0,
      signOutError: null as { name: string; status?: number } | null,
      signOutThrows: false,
    },
  };
});

vi.mock('../lib/session', () => ({
  ORG_COOKIE: 'recouple_org',
  requireSession: async () => {
    harness.sessions += 1;
    if (!harness.signedIn) throw new Redirected('/login');
    const orgs = [
      { orgId: ACME, slug: 'acme', name: 'Acme', role: 'owner' },
      { orgId: BETA, slug: 'beta', name: 'Beta', role: 'analyst' },
    ];
    return { userId: 'user-1', email: 'analyst@example.test', org: orgs[0], orgs };
  },
}));

vi.mock('../lib/supabase', () => ({
  supabaseForRequest: async () => ({
    auth: {
      async signOut() {
        harness.signOuts += 1;
        if (harness.signOutThrows) throw new TypeError('fetch failed');
        return { error: harness.signOutError };
      },
    },
  }),
}));

const { POST: switchWorkspace } = await import('../app/workspace/route');
const { POST: logout } = await import('../app/logout/route');

function post(path: string, fields: Record<string, string> = {}, site: string | null = 'same-origin'): NextRequest {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (site !== null) headers['sec-fetch-site'] = site;
  return new NextRequest(`${SITE}${path}`, { method: 'POST', body, headers });
}

beforeEach(() => {
  harness.sessions = 0;
  harness.signedIn = true;
  harness.signOuts = 0;
  harness.signOutError = null;
  harness.signOutThrows = false;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /workspace', () => {
  it('switches to another of the member’s own workspaces', async () => {
    const response = await switchWorkspace(post('/workspace', { org_id: BETA }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SITE}/`);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`recouple_org=${BETA}`);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
  });

  it('stores the id as the database answered it, whatever case the form sent', async () => {
    const response = await switchWorkspace(post('/workspace', { org_id: BETA.toUpperCase() }));
    expect(response.status).toBe(303);
    expect(response.cookies.get('recouple_org')?.value).toBe(BETA);
  });

  it('refuses a workspace the member does not belong to, and sets nothing', async () => {
    const response = await switchWorkspace(post('/workspace', { org_id: STRANGER }));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
  });

  it.each([
    ['no id', {}],
    ['an id that is not a UUID', { org_id: 'acme' }],
    ['an empty id', { org_id: '' }],
  ])('refuses %s, and sets nothing', async (_label, fields) => {
    const response = await switchWorkspace(post('/workspace', fields));
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a cross-site request before resolving the session', async () => {
    const response = await switchWorkspace(post('/workspace', { org_id: BETA }, 'cross-site'));
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a same-site request from another subdomain', async () => {
    const response = await switchWorkspace(post('/workspace', { org_id: BETA }, 'same-site'));
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
  });

  it('sends someone with no session to sign in, and sets nothing', async () => {
    harness.signedIn = false;
    await expect(switchWorkspace(post('/workspace', { org_id: BETA }))).rejects.toThrow(Redirected);
  });
});

describe('POST /logout', () => {
  it('signs out at the provider, forgets the workspace and sends the person to the login page', async () => {
    const response = await logout(post('/logout'));
    expect(harness.signOuts).toBe(1);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SITE}/login`);
    expect(response.headers.get('set-cookie') ?? '').toMatch(/recouple_org=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
  });

  it('refuses a cross-site request and revokes nothing', async () => {
    const response = await logout(post('/logout', {}, 'cross-site'));
    expect(response.status).toBe(403);
    expect(harness.signOuts).toBe(0);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('still clears this browser when the provider refuses the revocation, and says so in the log', async () => {
    harness.signOutError = { name: 'AuthApiError', status: 500 };
    const response = await logout(post('/logout'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SITE}/login`);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('AuthApiError'));
  });

  it('still clears this browser when the revocation throws, and says so in the log', async () => {
    harness.signOutThrows = true;
    const response = await logout(post('/logout'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SITE}/login`);
    expect(console.error).toHaveBeenCalled();
  });
});
