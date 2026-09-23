import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PostgresStore } from '@recouple/store-postgres';
import { resolveNotice } from '../lib/notices';
import { issueOAuthState, QBO_STATE_COOKIE } from '../lib/qbo-connect';

/**
 * Settings → QuickBooks: the three routes of the consent flow (ADR 0039).
 *
 * What is load-bearing here is the callback: it is the one GET in this app
 * that writes, it is reached cross-site, and its only CSRF defence is the state
 * cookie. So most of what follows is a refusal — and every refusal is asserted
 * to have happened *before* the code was exchanged, because an exchange is the
 * thing a forged redirect would be trying to cause.
 *
 * Intuit, the store's connect and disconnect, and the queue are stubbed: a test
 * that called Intuit would be a test that needs a customer's consent. What is
 * asserted about them is what they were asked, and that nothing a caller can
 * read afterwards — a log line, a redirect, an event — carries the code or a
 * token.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '33333333-3333-3333-3333-333333333333';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CONNECTION_ID = '44444444-4444-4444-4444-444444444444';
const CODE = 'AB11727000000s3cretAuthorizationCodeDoNotLog';
const TOKENS = {
  accessToken: 'access-token-DO-NOT-LOG',
  refreshToken: 'refresh-token-DO-NOT-LOG',
  accessExpiresAt: '2026-09-23T18:00:00.000Z',
  refreshExpiresAt: '2026-12-31T00:00:00.000Z',
};

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  orgs: [] as { orgId: string; slug: string; name: string; role: string }[],
  mayWrite: true,
  sessions: 0,
  exchanged: [] as unknown[],
  verified: [] as unknown[],
  connected: [] as unknown[],
  disconnected: [] as unknown[],
  sent: [] as unknown[],
  exchangeFails: false,
  verifyFails: false,
  connectFails: undefined as Error | undefined,
  sendFails: false,
  inngest: true,
  disconnectResult: undefined as unknown,
  /** What `ledgerConnectionOverview` answers for the repeated-redirect check. */
  overview: [] as unknown[],
  overviewFails: false,
  overviewReads: 0,
  overviewTenants: [] as unknown[],
}));

function fakeStore() {
  return {
    async memberMayWrite() {
      return harness.mayWrite;
    },
    async close() {
      return undefined;
    },
  } as unknown as PostgresStore;
}

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: USER_ID,
      email: 'owner@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
      orgs: harness.orgs,
    };
  },
  storeFor: () => fakeStore(),
}));

vi.mock('../lib/store', () => ({ tenantStore: () => fakeStore() }));

vi.mock('@recouple/qbo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/qbo')>();
  return {
    ...actual,
    exchangeIntuitToken: async (...args: unknown[]) => {
      harness.exchanged.push(args);
      if (harness.exchangeFails) throw new actual.QboAuthError('Intuit refused the code exchange (400): invalid_grant');
      return TOKENS;
    },
    verifyRealmAccess: async (input: unknown) => {
      harness.verified.push(input);
      if (harness.verifyFails) throw new actual.QboAuthError('cannot read company');
    },
    revokeIntuitToken: async () => undefined,
  };
});

vi.mock('@recouple/store-postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/store-postgres')>();
  return {
    ...actual,
    connectQboCompany: async (_config: unknown, tenant: unknown, input: Record<string, unknown>) => {
      harness.connected.push({ tenant, ...input, cipher: input.cipher === undefined ? 'none' : 'cipher' });
      if (harness.connectFails !== undefined) throw harness.connectFails;
      return {
        connection: {
          connectionId: CONNECTION_ID,
          orgId: ORG_ID,
          provider: 'qbo',
          providerAccountId: String(input.realmId),
          enabled: true,
          createdBy: USER_ID,
        },
        outcome: 'connected',
        replacedConnectionIds: [],
        credentialId: 'cred-1',
      };
    },
    PostgresLedgerSyncStore: class {
      constructor(_config: unknown, tenant: unknown) {
        harness.overviewTenants.push(tenant);
      }
      async ledgerConnectionOverview() {
        harness.overviewReads += 1;
        if (harness.overviewFails) throw new Error('database unreachable');
        return harness.overview;
      }
    },
    disconnectLedger: async (_config: unknown, tenant: unknown, input: Record<string, unknown>) => {
      harness.disconnected.push({ tenant, connectionId: input.connectionId, revoke: input.revoke !== undefined });
      return harness.disconnectResult;
    },
  };
});

vi.mock('../lib/inngest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/inngest')>();
  return {
    ...actual,
    inngestKeysFromEnv: () =>
      harness.inngest ? { eventKey: 'event-key', signingKey: 'signkey-test' } : undefined,
    inngestClient: () => ({
      send: async (event: unknown) => {
        if (harness.sendFails) throw new Error('queue unreachable');
        harness.sent.push(event);
      },
    }),
  };
});

const { POST: start } = await import('../app/settings/quickbooks/connect/route');
const { GET: callback } = await import('../app/settings/quickbooks/callback/route');
const { POST: disconnect } = await import('../app/settings/quickbooks/disconnect/route');

const saved = { ...process.env };
const logged: string[] = [];

beforeEach(() => {
  // Read by the routes to hand to the (stubbed) store functions; never dialled.
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.test';
  process.env.QBO_CLIENT_ID = 'client-id';
  process.env.QBO_CLIENT_SECRET = 'client-secret';
  process.env.QBO_ENVIRONMENT = 'sandbox';
  process.env.QBO_TOKEN_KMS_KEY_ID = 'alias/recouple-qbo-tokens';
  process.env.AWS_REGION = 'us-east-1';
  Object.assign(harness, {
    role: 'owner',
    orgs: [{ orgId: ORG_ID, slug: 'acme', name: 'Acme', role: 'owner' }],
    mayWrite: true,
    sessions: 0,
    exchanged: [],
    verified: [],
    connected: [],
    disconnected: [],
    sent: [],
    exchangeFails: false,
    verifyFails: false,
    connectFails: undefined,
    sendFails: false,
    inngest: true,
    disconnectResult: undefined,
    overview: [],
    overviewFails: false,
    overviewReads: 0,
    overviewTenants: [],
  });
  logged.length = 0;
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '));
    });
  }
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** The notice a redirect carries, resolved as the page resolves it. */
function said(response: Response): string | undefined {
  const location = new URL(response.headers.get('location') ?? 'https://x.test/');
  return resolveNotice(location.searchParams.get('qbo'))?.text;
}

function post(path: string, body?: FormData, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}

function back(query: Record<string, string>, cookie?: string, headers: Record<string, string> = {}) {
  const url = new URL('https://app.example.test/settings/quickbooks/callback');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, {
    method: 'GET',
    // A cross-site top-level navigation, which is what Intuit's redirect is.
    headers: {
      'sec-fetch-site': 'cross-site',
      ...(cookie !== undefined ? { cookie: `${QBO_STATE_COOKIE}=${cookie}` } : {}),
      ...headers,
    },
  });
}

/** A state cookie as the start route would have set it, for this member, now. */
function stateFor(orgId = ORG_ID, userId = USER_ID, now = new Date()) {
  return issueOAuthState({ orgId, userId, now });
}

describe('starting a consent', () => {
  it('sends an owner to Intuit with a single-use state in a host-only cookie', async () => {
    const response = await start(post('/settings/quickbooks/connect'));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') as string);
    expect(`${location.origin}${location.pathname}`).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://app.example.test/settings/quickbooks/callback',
    );
    expect(location.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${QBO_STATE_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    // Ten minutes for the state, and a minute more so an expired one still
    // arrives with its cookie and is refused as expired.
    expect(cookie).toMatch(/Max-Age=660/);
    expect(cookie).not.toMatch(/Domain=/i);
    // The state Intuit will send back is the cookie's nonce.
    const value = decodeURIComponent(cookie.split(';')[0]?.split('=')[1] ?? '');
    expect(value.split('.')[0]).toBe(location.searchParams.get('state'));
  });

  it('refuses a cross-site request before looking up the session', async () => {
    const response = await start(post('/settings/quickbooks/connect', undefined, { 'sec-fetch-site': 'cross-site' }));
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
  });

  it('never sends a member who is not an owner to Intuit', async () => {
    harness.role = 'analyst';
    const response = await start(post('/settings/quickbooks/connect'));
    expect(said(response)).toMatch(/only an owner/);
    expect(response.headers.get('set-cookie')).toBeNull();

    harness.role = 'owner';
    harness.mayWrite = false;
    expect(said(await start(post('/settings/quickbooks/connect')))).toMatch(/only an owner/);
  });

  it('sends nothing to Intuit from a deployment that could not store the tokens', async () => {
    delete process.env.QBO_TOKEN_KMS_KEY_ID;
    const response = await start(post('/settings/quickbooks/connect'));
    expect(said(response)).toMatch(/not set up on this deployment/);
    expect(response.headers.get('location')).not.toContain('intuit.com');
  });

  it('sends a consent started on another host to the canonical one to start again', async () => {
    const response = await start(
      new NextRequest('https://mozart1-web.vercel.app/settings/quickbooks/connect', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    );
    const location = new URL(response.headers.get('location') as string);
    expect(location.origin).toBe('https://app.example.test');
    expect(location.pathname).toBe('/settings/quickbooks');
    expect(said(response)).toMatch(/connects from this address only/);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('coming back from Intuit', () => {
  it('connects: exchange, verify, connect as the cookie’s org and the session’s member, then queue a sync', async () => {
    const { state, cookieValue } = stateFor();
    const response = await callback(back({ code: CODE, state, realmId: '9341457960434078' }, cookieValue));

    expect(said(response)).toMatch(/connected, and a first sync is on its way/);
    expect(harness.exchanged).toHaveLength(1);
    expect(harness.exchanged[0]).toEqual([
      { clientId: 'client-id', clientSecret: 'client-secret', environment: 'sandbox', baseUrl: expect.any(String) },
      {
        grantType: 'authorization_code',
        code: CODE,
        redirectUri: 'https://app.example.test/settings/quickbooks/callback',
      },
      'authorization code',
    ]);
    expect(harness.verified).toEqual([
      {
        baseUrl: 'https://sandbox-quickbooks.api.intuit.com',
        realmId: '9341457960434078',
        accessToken: TOKENS.accessToken,
      },
    ]);
    expect(harness.connected).toEqual([
      expect.objectContaining({
        tenant: { orgId: ORG_ID, userId: USER_ID },
        realmId: '9341457960434078',
        tokens: TOKENS,
        via: 'web_consent',
        environment: 'sandbox',
      }),
    ]);
    expect(harness.sent).toEqual([
      {
        name: 'ledger/sync.requested',
        data: {
          connectionId: CONNECTION_ID,
          orgId: ORG_ID,
          userId: USER_ID,
          syncKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      },
    ]);
    // Single use: the cookie is cleared on the way out.
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('accepts the cross-site redirect it exists for — the state is its CSRF defence', async () => {
    const { state, cookieValue } = stateFor();
    const response = await callback(
      back({ code: CODE, state, realmId: '9341' }, cookieValue, { 'sec-fetch-site': 'cross-site' }),
    );
    expect(response.status).toBe(303);
    expect(harness.connected).toHaveLength(1);
  });

  it('exchanges nothing without a matching, fresh state from this member', async () => {
    const { state, cookieValue } = stateFor();
    const stale = stateFor(ORG_ID, USER_ID, new Date(Date.now() - 11 * 60_000));
    const someoneElse = stateFor(ORG_ID, '99999999-9999-9999-9999-999999999999');

    const attempts = [
      back({ code: CODE, state, realmId: '9341' }), // no cookie at all
      back({ code: CODE, realmId: '9341' }, cookieValue), // no state
      back({ code: CODE, state: `${state.slice(0, -1)}x`, realmId: '9341' }, cookieValue), // wrong nonce
      back({ code: CODE, state: stale.state, realmId: '9341' }, stale.cookieValue), // over ten minutes
      back({ code: CODE, state: someoneElse.state, realmId: '9341' }, someoneElse.cookieValue), // another member
      back({ code: CODE, state, realmId: '9341' }, 'not.a.cookie'), // malformed
    ];
    for (const request of attempts) {
      const response = await callback(request);
      expect(said(response)).toMatch(/could not be matched to this session/);
      expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    }
    expect(harness.exchanged).toEqual([]);
    expect(harness.connected).toEqual([]);
  });

  it('says a redirect that arrives again after connecting is connected, and exchanges nothing', async () => {
    // The first arrival connected and spent the cookie; the second has none.
    harness.overview = [
      {
        connectionId: CONNECTION_ID,
        providerAccountId: '9341457960434078',
        enabled: true,
        createdBy: USER_ID,
        latestCredential: { storedAt: new Date(Date.now() - 5_000).toISOString(), refreshExpiresAt: '2027-01-02T00:00:00.000Z' },
      },
    ];
    const { state } = stateFor();
    const response = await callback(
      back({ code: CODE, state, realmId: '9341457960434078' }, undefined, { 'sec-fetch-mode': 'navigate' }),
    );

    expect(said(response)).toMatch(/QuickBooks is connected\. The sign-in came back here a second time/);
    expect(harness.exchanged).toEqual([]);
    expect(harness.connected).toEqual([]);
    const line = logged.join('\n');
    expect(line).toMatch(/state refused \(no_cookie\) for member [0-9a-f-]+, said qbo_already_connected;/);
    expect(line).toMatch(/sec-fetch-site=cross-site sec-fetch-mode=navigate/);
    expect(harness.overviewReads).toBe(1);
    // Read as the signed-in member, in the org the session selected.
    expect(harness.overviewTenants).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(line).toMatch(/code=yes state=yes/);
    expect(line).not.toContain(CODE);
    expect(line).not.toContain(state);
  });

  it('still refuses as before when the repeat is not explained by a fresh connection', async () => {
    const { state, cookieValue } = stateFor();
    const fresh = new Date(Date.now() - 5_000).toISOString();
    const stale = new Date(Date.now() - 3 * 60_000).toISOString();
    const row = (overrides: Record<string, unknown>) => ({
      connectionId: CONNECTION_ID,
      providerAccountId: '9341457960434078',
      enabled: true,
      createdBy: USER_ID,
      latestCredential: { storedAt: fresh, refreshExpiresAt: '2027-01-02T00:00:00.000Z' },
      ...overrides,
    });

    // [name, overview, cookie, realm, reads expected]
    const cases: Array<[string, unknown[], string | undefined, string, number]> = [
      ['no connection', [], undefined, '9341457960434078', 1],
      ['another company', [row({ providerAccountId: '1234' })], undefined, '9341457960434078', 1],
      ['turned off', [row({ enabled: false })], undefined, '9341457960434078', 1],
      ['another member’s connection', [row({ createdBy: '99999999-9999-9999-9999-999999999999' })], undefined, '9341457960434078', 1],
      ['an older sign-in', [row({ latestCredential: { storedAt: stale, refreshExpiresAt: '2027-01-02T00:00:00.000Z' } })], undefined, '9341457960434078', 1],
      // Never read at all for these: a realm that is not digits, and a cookie
      // that is present but wrong — that is not a repeat, it is refused plainly.
      ['a realm that is not digits', [row({})], undefined, '../admin', 0],
      ['a mismatched cookie', [row({})], cookieValue, '9341457960434078', 0],
    ];
    for (const [name, overview, cookie, realmId, reads] of cases) {
      harness.overview = overview;
      harness.overviewReads = 0;
      const wrongState = cookie === undefined ? state : `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
      const response = await callback(back({ code: CODE, state: wrongState, realmId }, cookie));
      expect(said(response), name).toMatch(/could not be matched to this session/);
      expect(harness.overviewReads, name).toBe(reads);
    }
    expect(harness.exchanged).toEqual([]);

    // An expired cookie still arrives (it outlives the state by a minute) and
    // is refused as expired, never read as a repeat.
    harness.overview = [row({})];
    harness.overviewReads = 0;
    const old = stateFor(ORG_ID, USER_ID, new Date(Date.now() - 10.5 * 60_000));
    expect(said(await callback(back({ code: CODE, state: old.state, realmId: '9341457960434078' }, old.cookieValue)))).toMatch(
      /could not be matched to this session/,
    );
    expect(harness.overviewReads).toBe(0);
    expect(logged.join('\n')).toMatch(/state refused \(expired\)/);

    // And a read that fails says the old thing, logged by class name.
    harness.overview = [row({})];
    harness.overviewFails = true;
    harness.overviewReads = 0;
    const failed = await callback(back({ code: CODE, state, realmId: '9341457960434078' }));
    expect(said(failed)).toMatch(/could not be matched to this session/);
    expect(logged.join('\n')).toMatch(/reading the connection for a repeated redirect failed \(Error\)/);
  });

  it('says connected when its code was spent by an earlier arrival still carrying the cookie', async () => {
    // Both arrivals carried the cookie; the first exchanged the code, so
    // Intuit refuses the second. The first has connected this member's company.
    harness.exchangeFails = true;
    harness.overview = [
      {
        connectionId: CONNECTION_ID,
        providerAccountId: '9341457960434078',
        enabled: true,
        createdBy: USER_ID,
        latestCredential: { storedAt: new Date().toISOString(), refreshExpiresAt: '2027-01-02T00:00:00.000Z' },
      },
    ];
    const { state, cookieValue } = stateFor();
    const response = await callback(back({ code: CODE, state, realmId: '9341457960434078' }, cookieValue));

    expect(said(response)).toMatch(/QuickBooks is connected\. The sign-in came back here a second time/);
    expect(harness.connected).toEqual([]);
    expect(harness.overviewTenants).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(logged.join('\n')).toMatch(/code already spent by an earlier arrival .* said qbo_already_connected/);
    expect(logged.join('\n')).not.toContain(CODE);
  });

  it('still says the exchange failed when nothing connected the company, after asking for a few seconds', async () => {
    harness.exchangeFails = true;
    harness.overview = [];
    const { state, cookieValue } = stateFor();
    const response = await callback(back({ code: CODE, state, realmId: '9341457960434078' }, cookieValue));
    expect(said(response)).toMatch(/did not complete the sign-in/);
    // Asked once a second for five seconds, then once more.
    expect(harness.overviewReads).toBe(6);
  }, 15_000);

  it('logs a connect by ids and outcome, and nothing Intuit sent', async () => {
    const { state, cookieValue } = stateFor();
    await callback(back({ code: CODE, state, realmId: '9341457960434078' }, cookieValue));
    const line = logged.join('\n');
    expect(line).toContain(
      `QuickBooks connect: connected company 9341457960434078 as connection ${CONNECTION_ID} for org ${ORG_ID}, member ${USER_ID}; sec-fetch-site=cross-site`,
    );
    for (const secret of [CODE, state, TOKENS.accessToken, TOKENS.refreshToken]) {
      expect(line).not.toContain(secret);
    }
  });

  it('says the owner cancelled, and never repeats what Intuit said about it', async () => {
    const { state, cookieValue } = stateFor();
    const response = await callback(
      back(
        { error: 'access_denied', error_description: 'your session expired, sign in at evil.test', state },
        cookieValue,
      ),
    );
    expect(said(response)).toMatch(/cancelled at Intuit/);
    expect(response.headers.get('location')).not.toContain('evil.test');
    expect(logged.join('\n')).not.toContain('evil.test');
    expect(harness.exchanged).toEqual([]);
  });

  it('refuses an org the member does not belong to, and a member no longer an owner there', async () => {
    const elsewhere = stateFor(OTHER_ORG);
    expect(
      said(await callback(back({ code: CODE, state: elsewhere.state, realmId: '9341' }, elsewhere.cookieValue))),
    ).toMatch(/only an owner/);

    // Demoted between pressing Connect and coming back.
    harness.orgs = [{ orgId: ORG_ID, slug: 'acme', name: 'Acme', role: 'analyst' }];
    const { state, cookieValue } = stateFor();
    expect(said(await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue)))).toMatch(/only an owner/);
    expect(harness.exchanged).toEqual([]);
  });

  it('exchanges nothing on a deployment that could not store the tokens', async () => {
    delete process.env.QBO_TOKEN_KMS_KEY_ID;
    const { state, cookieValue } = stateFor();
    const response = await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue));
    expect(said(response)).toMatch(/not set up on this deployment/);
    expect(harness.exchanged).toEqual([]);
  });

  it('refuses a company id that is not digits before exchanging anything', async () => {
    const { state, cookieValue } = stateFor();
    const response = await callback(back({ code: CODE, state, realmId: '../admin' }, cookieValue));
    expect(said(response)).toMatch(/did not complete the sign-in/);
    expect(harness.exchanged).toEqual([]);
  });

  it('stores nothing when the exchange or the company check fails', async () => {
    harness.exchangeFails = true;
    let { state, cookieValue } = stateFor();
    expect(said(await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue)))).toMatch(
      /did not complete the sign-in/,
    );

    harness.exchangeFails = false;
    harness.verifyFails = true;
    ({ state, cookieValue } = stateFor());
    expect(said(await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue)))).toMatch(
      /could not read the QuickBooks company/,
    );
    expect(harness.connected).toEqual([]);
  }, 15_000);

  it('says so when another workspace holds the company', async () => {
    const { AccountConnectedElsewhereError } = await import('@recouple/store-postgres');
    harness.connectFails = new AccountConnectedElsewhereError('qbo', '9341');
    const { state, cookieValue } = stateFor();
    const response = await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue));
    expect(said(response)).toMatch(/already connected in another workspace/);
    expect(harness.sent).toEqual([]);
  });

  it('is connected either way when the first sync cannot be queued, and says which', async () => {
    harness.sendFails = true;
    let { state, cookieValue } = stateFor();
    expect(said(await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue)))).toMatch(
      /daily sync at 07:00 UTC will pick it up/,
    );

    harness.sendFails = false;
    harness.inngest = false;
    ({ state, cookieValue } = stateFor());
    expect(said(await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue)))).toMatch(
      /no scheduler/,
    );
  });

  it('puts the code and the tokens in no log line, no redirect and no event', async () => {
    harness.sendFails = true; // the path that logs the most
    const { state, cookieValue } = stateFor();
    const response = await callback(back({ code: CODE, state, realmId: '9341' }, cookieValue));

    harness.exchangeFails = true;
    const second = stateFor();
    const failed = await callback(back({ code: CODE, state: second.state, realmId: '9341' }, second.cookieValue));

    const everything = [
      logged.join('\n'),
      response.headers.get('location') ?? '',
      failed.headers.get('location') ?? '',
      JSON.stringify(harness.sent),
    ].join('\n');
    for (const secret of [CODE, TOKENS.accessToken, TOKENS.refreshToken]) {
      expect(everything).not.toContain(secret);
    }
  }, 15_000);
});

describe('disconnecting', () => {
  function form(connectionId: string): FormData {
    const body = new FormData();
    body.set('connectionId', connectionId);
    return body;
  }

  it('turns it off and revokes, and says Intuit confirmed', async () => {
    harness.disconnectResult = { disabled: true, revoke: 'confirmed', connection: {} };
    const response = await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID)));
    expect(said(response)).toMatch(/Intuit confirmed our access is revoked/);
    expect(harness.disconnected).toEqual([
      { tenant: { orgId: ORG_ID, userId: USER_ID }, connectionId: CONNECTION_ID, revoke: true },
    ]);
  });

  it('tells the owner what to do when Intuit did not confirm', async () => {
    harness.disconnectResult = { disabled: true, revoke: 'failed', revokeErrorClass: 'QboRequestFailed', connection: {} };
    expect(said(await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID))))).toMatch(
      /Settings → Apps/,
    );
  });

  it('still turns it off on a deployment that cannot reach Intuit, and says the revoke did not happen', async () => {
    delete process.env.QBO_CLIENT_SECRET;
    harness.disconnectResult = { disabled: true, revoke: 'not_attempted', connection: {} };
    const response = await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID)));
    expect(harness.disconnected[0]).toMatchObject({ revoke: false });
    expect(said(response)).toMatch(/did not confirm the revoke/);
  });

  it('refuses cross-site, a non-owner, a malformed id, and another tenant’s connection', async () => {
    expect(
      (await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID), { 'sec-fetch-site': 'cross-site' }))).status,
    ).toBe(403);

    harness.role = 'approver';
    expect(said(await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID))))).toMatch(/only an owner/);
    harness.role = 'owner';

    expect(said(await disconnect(post('/settings/quickbooks/disconnect', form('nope'))))).toMatch(/not a connection/);

    harness.disconnectResult = undefined;
    expect(said(await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID))))).toMatch(/not a connection/);
    expect(harness.disconnected).toHaveLength(1);
  });

  it('still says it is off when only the revoke’s audit row failed, and logs that loudly', async () => {
    harness.disconnectResult = {
      disabled: true,
      revoke: 'confirmed',
      revokeAuditErrorClass: 'error 42501',
      connection: {},
    };
    const response = await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID)));
    expect(said(response)).toMatch(/Intuit confirmed our access is revoked/);
    expect(logged.join('\n')).toMatch(/revoke's audit row was not written \(error 42501\)/);
  });

  it('says a second press changed nothing', async () => {
    harness.disconnectResult = { disabled: false, revoke: 'not_attempted', connection: {} };
    expect(said(await disconnect(post('/settings/quickbooks/disconnect', form(CONNECTION_ID))))).toMatch(
      /already off/,
    );
  });
});
