import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InboundAddressRefusedError, type InboundAddressRow } from '@recouple/store-postgres';
import { resolveNotice } from '../lib/notices';

/**
 * Settings → Email's three writes (ADR 0047 §4): issue, adopt, retire.
 *
 * Owner-only, in the upload route's shape — a cross-site POST is refused before
 * the session is resolved, a non-owner is refused before the store is asked,
 * and the database's own refusal is said as a role refusal rather than a 500.
 * Retiring an address that had mail in the last fourteen days asks first. Log
 * lines carry ids only: never an address or its token (§13).
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_OWNER = '33333333-3333-3333-3333-333333333333';
const ADDRESS_ID = '44444444-4444-4444-4444-444444444444';
const TOKEN = '0123456789abcdef0123456789abcdef';

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  sessions: 0,
  addresses: [] as InboundAddressRow[],
  issued: 0,
  adopted: [] as string[],
  retired: [] as string[],
  fail: undefined as Error | undefined,
  identities: [] as unknown[],
  filedAsked: 0,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: USER_ID,
      email: 'owner@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
      orgs: [],
    };
  },
}));

vi.mock('../lib/inbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/inbound')>();
  return {
    ...actual,
    inboundStoreFor: (identity: unknown) => {
      harness.identities.push(identity);
      return {
        addresses: async () => harness.addresses,
        issueAddress: async () => {
          if (harness.fail !== undefined) throw harness.fail;
          harness.issued += 1;
          return { addressId: ADDRESS_ID, token: TOKEN };
        },
        adoptAddress: async (id: string) => {
          if (harness.fail !== undefined) throw harness.fail;
          harness.adopted.push(id);
        },
        retireAddress: async (id: string) => {
          if (harness.fail !== undefined) throw harness.fail;
          harness.retired.push(id);
        },
        emailsThatFiledNothing: async () => {
          harness.filedAsked += 1;
          return [];
        },
      };
    },
  };
});

const issue = (await import('../app/settings/email/issue/route')).POST;
const adopt = (await import('../app/settings/email/adopt/route')).POST;
const retire = (await import('../app/settings/email/retire/route')).POST;
const EmailSettingsPage = (await import('../app/settings/email/page')).default;

function request(path: string, form: Record<string, string> = {}, site?: string): NextRequest {
  const headers = new Headers();
  if (site !== undefined) headers.set('sec-fetch-site', site);
  const body = new FormData();
  for (const [name, value] of Object.entries(form)) body.set(name, value);
  return new NextRequest(`https://app.example.test${path}`, { method: 'POST', headers, body });
}

function landed(response: Response): { path: string; said: string | undefined; confirm: string | null } {
  const at = new URL(response.headers.get('location') as string);
  return {
    path: at.pathname,
    said: resolveNotice(at.searchParams.get('email') ?? undefined)?.text,
    confirm: at.searchParams.get('confirm'),
  };
}

function address(overrides: Partial<InboundAddressRow> = {}): InboundAddressRow {
  return {
    addressId: ADDRESS_ID,
    token: TOKEN,
    createdBy: OTHER_OWNER,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    actingMember: OTHER_OWNER,
    actingMemberEmail: 'first-owner@example.test',
    actingMemberMayWrite: true,
    refusedSinceRetired: 0,
    ...overrides,
  };
}

const logged: string[] = [];

beforeEach(() => {
  harness.role = 'owner';
  harness.sessions = 0;
  harness.addresses = [address()];
  harness.issued = 0;
  harness.adopted = [];
  harness.retired = [];
  harness.fail = undefined;
  harness.identities = [];
  harness.filedAsked = 0;
  logged.length = 0;
  vi.spyOn(console, 'info').mockImplementation((line: string) => void logged.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void logged.push(line));
});

describe('every write', () => {
  it('refuses a cross-site POST with a 403, before the session is resolved', async () => {
    for (const [route, path] of [
      [issue, '/settings/email/issue'],
      [adopt, '/settings/email/adopt'],
      [retire, '/settings/email/retire'],
    ] as const) {
      const response = await route(request(path, { addressId: ADDRESS_ID }, 'cross-site'));
      expect(response.status).toBe(403);
    }
    expect(harness.sessions).toBe(0);
  });

  it('refuses anyone but an owner before the store is asked', async () => {
    for (const role of ['approver', 'analyst', 'read_only']) {
      harness.role = role;
      for (const [route, path] of [
        [issue, '/settings/email/issue'],
        [adopt, '/settings/email/adopt'],
        [retire, '/settings/email/retire'],
      ] as const) {
        const response = await route(request(path, { addressId: ADDRESS_ID }));
        expect(landed(response)).toMatchObject({
          path: '/settings/email',
          said: 'only an owner can issue, adopt or retire an address',
        });
      }
    }
    expect(harness.identities).toEqual([]);
  });
});

describe('issuing an address', () => {
  it('issues one as the owner, and logs ids but never the token', async () => {
    const response = await issue(request('/settings/email/issue'));
    expect(response.status).toBe(303);
    expect(landed(response).said).toMatch(/a new address is issued/);
    expect(harness.issued).toBe(1);
    expect(harness.identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(logged).toEqual([
      `[recouple] inbound address issued: address ${ADDRESS_ID} org ${ORG_ID} by ${USER_ID}`,
    ]);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('says a refusal by the database is the role’s, and a fault is a fault', async () => {
    harness.fail = new InboundAddressRefusedError(ORG_ID, 'issue', '42501');
    expect(landed(await issue(request('/settings/email/issue'))).said).toMatch(/only an owner/);

    harness.fail = Object.assign(new Error(`connection to ${TOKEN} refused`), { name: 'DatabaseError' });
    expect(landed(await issue(request('/settings/email/issue'))).said).toMatch(/did not go through/);
    expect(logged).toEqual([`[recouple] inbound address issue failed: org ${ORG_ID} (DatabaseError)`]);
  });
});

describe('adopting an address', () => {
  it('makes the owner the member it acts as', async () => {
    const response = await adopt(request('/settings/email/adopt', { addressId: ADDRESS_ID }));
    expect(landed(response).said).toMatch(/now acts as you/);
    expect(harness.adopted).toEqual([ADDRESS_ID]);
  });

  it('writes nothing when it already acts as them', async () => {
    harness.addresses = [address({ actingMember: USER_ID })];
    const response = await adopt(request('/settings/email/adopt', { addressId: ADDRESS_ID }));
    expect(landed(response).said).toMatch(/already acts as you/);
    expect(harness.adopted).toEqual([]);
  });

  it('refuses an id that is not a live address of this workspace', async () => {
    for (const addressId of ['not-a-uuid', '55555555-5555-5555-5555-555555555555']) {
      const response = await adopt(request('/settings/email/adopt', { addressId }));
      expect(landed(response).said).toMatch(/not a live address/);
    }
    harness.addresses = [address({ retiredAt: new Date('2026-09-20T00:00:00Z'), retiredBy: OTHER_OWNER })];
    expect(landed(await adopt(request('/settings/email/adopt', { addressId: ADDRESS_ID }))).said).toMatch(
      /not a live address/,
    );
    expect(harness.adopted).toEqual([]);
  });
});

describe('retiring an address', () => {
  it('retires an address with no recent mail at once', async () => {
    harness.addresses = [address({ lastReceivedAt: new Date(Date.now() - 30 * 86_400_000) })];
    const response = await retire(request('/settings/email/retire', { addressId: ADDRESS_ID }));
    expect(landed(response).said).toMatch(/that address is retired/);
    expect(harness.retired).toEqual([ADDRESS_ID]);
  });

  it('asks first when it had mail in the last fourteen days, and retires on the confirmation', async () => {
    harness.addresses = [address({ lastReceivedAt: new Date(Date.now() - 2 * 86_400_000) })];
    const first = await retire(request('/settings/email/retire', { addressId: ADDRESS_ID }));
    expect(landed(first)).toMatchObject({
      path: '/settings/email',
      said: expect.stringMatching(/received mail in the last 14 days, so nothing was retired yet/),
      confirm: ADDRESS_ID,
    });
    expect(harness.retired).toEqual([]);

    const confirmed = await retire(
      request('/settings/email/retire', { addressId: ADDRESS_ID, confirmed: 'yes' }),
    );
    expect(landed(confirmed).said).toMatch(/that address is retired/);
    expect(harness.retired).toEqual([ADDRESS_ID]);
  });

  it('says an address already retired was, whether it was already or a second press raced', async () => {
    harness.addresses = [address({ retiredAt: new Date('2026-09-20T00:00:00Z'), retiredBy: OTHER_OWNER })];
    expect(landed(await retire(request('/settings/email/retire', { addressId: ADDRESS_ID }))).said).toMatch(
      /already retired/,
    );

    harness.addresses = [address()];
    harness.fail = new InboundAddressRefusedError(ORG_ID, 'retire', '23505');
    expect(landed(await retire(request('/settings/email/retire', { addressId: ADDRESS_ID }))).said).toMatch(
      /already retired/,
    );
  });

  it('refuses an unknown address, and logs a fault by class name and ids', async () => {
    const unknown = await retire(
      request('/settings/email/retire', { addressId: '55555555-5555-5555-5555-555555555555' }),
    );
    expect(landed(unknown).said).toMatch(/not a live address/);

    harness.fail = Object.assign(new Error('boom'), { name: 'DatabaseError' });
    expect(landed(await retire(request('/settings/email/retire', { addressId: ADDRESS_ID }))).said).toMatch(
      /did not go through/,
    );
    expect(logged).toEqual([
      `[recouple] inbound address retire failed: address ${ADDRESS_ID} org ${ORG_ID} (DatabaseError)`,
    ]);
  });
});

describe('the page', () => {
  async function render(searchParams: { email?: string; confirm?: string } = {}) {
    const { renderToStaticMarkup } = await import('react-dom/server');
    return renderToStaticMarkup(await EmailSettingsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it('reads as the member signed in, and asks what filed nothing for a writer', async () => {
    const html = await render();
    expect(harness.identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(harness.filedAsked).toBe(1);
    expect(html).toContain(TOKEN);
  });

  it('asks nothing about mail for a read_only member, and shows no address', async () => {
    harness.role = 'read_only';
    const html = await render();
    expect(harness.filedAsked).toBe(0);
    expect(html).not.toContain(TOKEN);
    expect(html).toContain('This workspace has 1 live address.');
  });

  it('ignores a confirm that is not an id', async () => {
    harness.addresses = [address({ lastReceivedAt: new Date() })];
    expect(await render({ confirm: `${ADDRESS_ID}<script>` })).not.toContain('Retire an address still in use?');
    expect(await render({ confirm: ADDRESS_ID })).toContain('Retire an address still in use?');
  });
});
