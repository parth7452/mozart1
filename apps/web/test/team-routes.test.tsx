import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TeamChangeRefusedError, type TeamMember, type TeamRefusal } from '@recouple/store-postgres';
import { resolveNotice } from '../lib/notices';
import { welcomeMessage } from '../lib/team-words';

/**
 * Settings → Team (ADR 0051): the page and its three writes.
 *
 * Owner-only, in Settings → Email's shape — a cross-site POST is refused before
 * the session is resolved, a non-owner before the store is asked, a member the
 * database says may not write before anything changes — and every refusal the
 * database names is its own notice, never a 500 and never the database's
 * sentence. Log lines carry ids only: never an address or a name.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const MEMBER_ID = '33333333-3333-3333-3333-333333333333';
const ADDRESS = 'new.person@example.test';

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  mayWrite: true,
  sessions: 0,
  members: [] as TeamMember[],
  invites: [] as unknown[],
  roleChanges: [] as unknown[],
  removals: [] as string[],
  was: 'analyst' as string,
  fail: undefined as Error | undefined,
  identities: [] as unknown[],
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: USER_ID,
      email: 'owner@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role },
      orgs: [{ orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role }],
    };
  },
  storeFor: () => ({ memberMayWrite: async () => harness.mayWrite }),
}));

vi.mock('../lib/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/team')>();
  return {
    ...actual,
    teamStoreFor: (identity: unknown) => {
      harness.identities.push(identity);
      return {
        members: async () => harness.members,
        invite: async (input: unknown) => {
          if (harness.fail !== undefined) throw harness.fail;
          harness.invites.push(input);
          return { userId: MEMBER_ID, usersRowCreated: true };
        },
        changeRole: async (userId: string, role: string) => {
          if (harness.fail !== undefined) throw harness.fail;
          harness.roleChanges.push([userId, role]);
          return harness.was;
        },
        remove: async (userId: string) => {
          if (harness.fail !== undefined) throw harness.fail;
          harness.removals.push(userId);
          return harness.was;
        },
      };
    },
  };
});

const invite = (await import('../app/settings/team/invite/route')).POST;
const changeRole = (await import('../app/settings/team/role/route')).POST;
const remove = (await import('../app/settings/team/remove/route')).POST;
const TeamSettingsPage = (await import('../app/settings/team/page')).default;

function request(path: string, form: Record<string, string> = {}, site?: string): NextRequest {
  const headers = new Headers();
  if (site !== undefined) headers.set('sec-fetch-site', site);
  const body = new FormData();
  for (const [name, value] of Object.entries(form)) body.set(name, value);
  return new NextRequest(`https://app.example.test${path}`, { method: 'POST', headers, body });
}

function landed(response: Response) {
  const at = new URL(response.headers.get('location') as string);
  return {
    path: at.pathname,
    said: resolveNotice(at.searchParams.get('team') ?? undefined)?.text,
    invited: at.searchParams.get('invited'),
    confirm: at.searchParams.get('confirm'),
  };
}

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    userId: MEMBER_ID,
    email: ADDRESS,
    fullName: 'New Person',
    role: 'analyst',
    memberSince: new Date('2026-09-26T00:00:00Z'),
    hasSignedIn: false,
    holdsLedger: false,
    holdsEmail: false,
    ...overrides,
  };
}

const OWNER = member({ userId: USER_ID, email: 'owner@example.test', fullName: 'Dana Reyes', role: 'owner', hasSignedIn: true });

const logged: string[] = [];

beforeEach(() => {
  harness.role = 'owner';
  harness.mayWrite = true;
  harness.sessions = 0;
  harness.members = [OWNER, member()];
  harness.invites = [];
  harness.roleChanges = [];
  harness.removals = [];
  harness.was = 'analyst';
  harness.fail = undefined;
  harness.identities = [];
  logged.length = 0;
  vi.spyOn(console, 'info').mockImplementation((line: string) => void logged.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void logged.push(line));
});

const WRITES = [
  [invite, '/settings/team/invite', { email: ADDRESS, fullName: 'New Person', role: 'analyst' }],
  [changeRole, '/settings/team/role', { userId: MEMBER_ID, role: 'approver' }],
  [remove, '/settings/team/remove', { userId: MEMBER_ID, confirmed: 'yes' }],
] as const;

describe('every write', () => {
  it('refuses a cross-site POST with a 403, before the session is resolved', async () => {
    for (const [route, path, form] of WRITES) {
      expect((await route(request(path, form, 'cross-site'))).status).toBe(403);
    }
    expect(harness.sessions).toBe(0);
  });

  it('refuses anyone but an owner before the store is asked', async () => {
    for (const role of ['approver', 'analyst', 'read_only', 'accountant_guest']) {
      harness.role = role;
      for (const [route, path, form] of WRITES) {
        expect(landed(await route(request(path, form)))).toMatchObject({
          path: '/settings/team',
          said: 'only an owner can add, re-role or remove people',
        });
      }
    }
    expect(harness.identities).toEqual([]);
  });

  it('asks the database whether this member may write, and changes nothing when it says no', async () => {
    harness.mayWrite = false;
    for (const [route, path, form] of WRITES) {
      expect(landed(await route(request(path, form))).said).toMatch(/only an owner/);
    }
    expect([harness.invites, harness.roleChanges, harness.removals]).toEqual([[], [], []]);
  });

  it('says each refusal the database names, and a fault as a fault, without its message', async () => {
    const expected: Record<TeamRefusal, RegExp> = {
      not_owner: /only an owner/,
      invalid: /enter a work email/,
      address_ambiguous: /different capitals/,
      already_member: /already a member/,
      last_owner: /at least one owner/,
      not_member: /not a member of this workspace/,
      holds_ledger: /Connect QuickBooks/,
      holds_email: /press Adopt/,
      too_few_writers: /fewer than two people who can write/,
    };
    for (const [refusal, words] of Object.entries(expected)) {
      harness.fail = new TeamChangeRefusedError(ORG_ID, 'remove', refusal as TeamRefusal, 'RCT00');
      for (const [route, path, form] of WRITES) {
        expect(landed(await route(request(path, form))).said).toMatch(words);
      }
    }

    harness.fail = Object.assign(new Error(`duplicate key ${ADDRESS}`), { name: 'DatabaseError' });
    for (const [route, path, form] of WRITES) {
      expect(landed(await route(request(path, form))).said).toMatch(/did not go through/);
    }
    expect(logged.join('\n')).not.toContain(ADDRESS);
    expect(logged).toContain(`[recouple] team invite failed: org ${ORG_ID} (DatabaseError)`);
  });
});

describe('adding a person', () => {
  it('invites as the owner, and says they can sign in now', async () => {
    const response = await invite(
      request('/settings/team/invite', { email: ADDRESS, fullName: 'New Person', role: 'approver' }),
    );
    expect(response.status).toBe(303);
    expect(landed(response)).toMatchObject({
      invited: MEMBER_ID,
      said: expect.stringMatching(/They can now sign in at app\.mozart\.financial with this address/),
    });
    expect(harness.invites).toEqual([{ email: ADDRESS, fullName: 'New Person', role: 'approver' }]);
    expect(harness.identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(logged.join('\n')).not.toContain(ADDRESS);
    expect(logged.join('\n')).not.toContain('New Person');
  });

  it('refuses what is not an address, a name or a role before the store is asked', async () => {
    for (const form of [
      { email: '', role: 'analyst' },
      { email: ADDRESS, role: 'superuser' },
      { email: ADDRESS, role: 'analyst', fullName: 'x'.repeat(201) },
      { email: `${'x'.repeat(250)}@example.test`, role: 'analyst' },
    ]) {
      expect(landed(await invite(request('/settings/team/invite', form))).said).toMatch(/enter a work email/);
    }
    expect(harness.invites).toEqual([]);
  });
});

describe('changing a role and removing', () => {
  it('changes a role, and says so plainly when nothing changed', async () => {
    expect(landed(await changeRole(request('/settings/team/role', { userId: MEMBER_ID, role: 'approver' }))).said).toMatch(
      /role changed/,
    );
    harness.was = 'approver';
    expect(landed(await changeRole(request('/settings/team/role', { userId: MEMBER_ID, role: 'approver' }))).said).toMatch(
      /already have that role/,
    );
    expect(landed(await changeRole(request('/settings/team/role', { userId: 'nope', role: 'approver' }))).said).toMatch(
      /not a member/,
    );
  });

  it('asks before removing, and removes only on the second press', async () => {
    const first = landed(await remove(request('/settings/team/remove', { userId: MEMBER_ID })));
    expect(first).toMatchObject({ confirm: MEMBER_ID, said: expect.stringMatching(/Confirm below/) });
    expect(harness.removals).toEqual([]);

    const second = landed(await remove(request('/settings/team/remove', { userId: MEMBER_ID, confirmed: 'yes' })));
    expect(second.said).toMatch(/removed/);
    expect(harness.removals).toEqual([MEMBER_ID]);
  });
});

describe('the page', () => {
  async function page(searchParams: Record<string, string> = {}): Promise<string> {
    const { renderToStaticMarkup } = await import('react-dom/server');
    return renderToStaticMarkup(await TeamSettingsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it('shows every member, whether they have signed in, and the two-person note, to everyone', async () => {
    for (const role of ['owner', 'read_only', 'accountant_guest']) {
      harness.role = role;
      const html = await page();
      expect(html).toContain(ADDRESS);
      expect(html).toContain('has not signed in yet');
      expect(html).toContain('has signed in');
      expect(html).toContain('can never approve it');
    }
  });

  it('gives an owner the three controls, and nobody else', async () => {
    const html = await page();
    for (const action of ['/settings/team/invite', '/settings/team/role', '/settings/team/remove']) {
      expect(html).toContain(`action="${action}"`);
    }
    harness.role = 'analyst';
    const plain = await page();
    for (const action of ['/settings/team/invite', '/settings/team/role', '/settings/team/remove']) {
      expect(plain).not.toContain(`action="${action}"`);
    }
    expect(plain).toContain('Only an owner can add');
  });

  it('shows the welcome message for the person just invited, and a confirmation for a removal', async () => {
    const html = await page({ team: 'team_invited', invited: MEMBER_ID });
    expect(html).toContain('Welcome message for New Person');
    expect(html).toContain('Email me a sign-in link');
    expect(html).toContain('They can now sign in at app.mozart.financial with this address');

    const confirming = await page({ team: 'team_remove_confirm', confirm: MEMBER_ID });
    expect(confirming).toContain('Remove New Person');
    expect(confirming).toContain('name="confirmed" value="yes"');

    // An id not in the list, or not an id, shows neither.
    const stray = await page({ invited: '55555555-5555-5555-5555-555555555555', confirm: 'x' });
    expect(stray).not.toContain('Welcome message');
    expect(stray).not.toContain('Remove them');

    // Nor to someone who is not an owner.
    harness.role = 'approver';
    expect(await page({ invited: MEMBER_ID, confirm: MEMBER_ID })).not.toContain('Welcome message');
  });

  it('warns when the workspace cannot finish a case', async () => {
    harness.members = [OWNER];
    expect(await page()).toContain('Only one person here can write');
    harness.members = [member({ role: 'analyst' }), member({ userId: USER_ID, role: 'analyst' })];
    expect(await page()).toContain('Nobody here can approve');
  });
});

describe('the welcome message', () => {
  it('names the workspace, the role and the address, and says how the first sign-in goes', () => {
    const text = welcomeMessage({ workspace: 'Acme Foods', fullName: 'Dana Reyes', email: ADDRESS, role: 'owner' });
    expect(text).toContain('Subject: Your Acme Foods workspace on Mozart');
    expect(text).toContain('Hi Dana,');
    expect(text).toContain('as an owner');
    expect(text).toContain(`go to https://app.mozart.financial/login, type ${ADDRESS}`);
    expect(text).toContain('asks you to confirm your address');
    expect(text).toContain('within five minutes');
    expect(text).not.toMatch(/Send invitation|dashboard/);

    const viewer = welcomeMessage({ workspace: 'Acme Foods', email: ADDRESS, role: 'read_only' });
    expect(viewer).toContain('Hi,');
    expect(viewer).toContain('as a viewer');
  });
});
