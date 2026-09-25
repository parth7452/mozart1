import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `requireSession` is the real guard on `recouple_org`: whatever `/workspace`
 * set, or a person typed into their cookie jar, picks only between the
 * workspaces the database answered for this identity on this request.
 */
const ACME = { orgId: '11111111-1111-1111-1111-111111111111', slug: 'acme', name: 'Acme', role: 'owner' };
const BETA = { orgId: '44444444-4444-4444-4444-444444444444', slug: 'beta', name: 'Beta', role: 'analyst' };

const harness = vi.hoisted(() => ({ cookie: undefined as string | undefined }));

vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new Error(`redirect to ${location}`);
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'recouple_org' && harness.cookie !== undefined ? { name, value: harness.cookie } : undefined,
  }),
}));
vi.mock('../lib/env', () => ({ env: { databaseUrl: 'postgres://not-used.example/test' } }));
vi.mock('../lib/supabase', () => ({
  supabaseForRequest: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'auth-1', email: 'analyst@example.test' } }, error: null }) },
  }),
}));
vi.mock('../lib/store', () => ({ tenantStore: () => ({}) }));
vi.mock('@recouple/store-postgres', () => ({
  resolveSession: async () => ({ userId: 'user-1', orgs: [ACME, BETA] }),
}));

const { requireSession } = await import('../lib/session');

beforeEach(() => {
  harness.cookie = undefined;
});

describe('requireSession and the workspace cookie', () => {
  it('lands on the first workspace with no cookie', async () => {
    expect((await requireSession()).org.orgId).toBe(ACME.orgId);
  });

  it('honours a cookie naming one of the member’s workspaces', async () => {
    harness.cookie = BETA.orgId;
    const session = await requireSession();
    expect(session.org.orgId).toBe(BETA.orgId);
    expect(session.orgs.map((org) => org.orgId)).toEqual([ACME.orgId, BETA.orgId]);
  });

  it('ignores a cookie naming a workspace the member is not in', async () => {
    harness.cookie = '99999999-9999-9999-9999-999999999999';
    expect((await requireSession()).org.orgId).toBe(ACME.orgId);
  });
});
