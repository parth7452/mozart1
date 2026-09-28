import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  bindingOf,
  parseRecipe,
  type PortalBinding,
  type PortalConnectionRecord,
  type PortalCredentialRecord,
  type PortalRecipeVersionRecord,
  type PortalRunRecord,
} from '@recouple/portal';
import {
  PortalAccountConnectedElsewhereError,
  PortalAgentDraftAdditionsError,
  PortalCredentialReplacementRequiredError,
  PortalInputError,
  PortalOwnerRequiredError,
  PortalRecipeAlreadyReviewedError,
  PortalRecipeProvenanceError,
  PortalRecipeVersionExistsError,
} from '@recouple/store-postgres';
import { PORTAL_READ_REQUESTED, resolvePortalNotice } from '../lib/portals';

/**
 * Settings → Portals' six writes (ADR 0057 §3, §7, §13; ADR 0062): add a
 * connection, upload a recipe version, review it, enter a credential, turn a
 * connection on or off, start a dry run.
 *
 * Owner-only, in Settings → Email's shape: a cross-site POST is refused with a
 * 403 before the session is resolved, a non-owner before any store is built,
 * and a member the database says may not write before anything is written.
 * The store is a fake that records what each route asked of it; the recipe
 * checks are the real `parseRecipe` and `bindingOf`. The credential's three
 * secrets are marked, and every log line, redirect and event is swept for
 * them: the one place they may go is the payload handed to the store to seal.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CREATOR_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_VERSION_ID = '66666666-6666-4666-8666-666666666666';
const CREDENTIAL_ID = '77777777-7777-4777-8777-777777777777';
const RUN_ID = '88888888-8888-4888-8888-888888888888';
const PORTAL_KEY = 'sap_business_network';

const USERNAME = 'svc-user-DO-NOT-LOG@example.test';
const PASSWORD = 'pw-Horse-Staple-DO-NOT-LOG';
const TYPED_KEY = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq';
const FOLDED_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SECRETS = [USERNAME, PASSWORD, TYPED_KEY, FOLDED_KEY, 'DO-NOT-LOG'];

function recipeJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    portalKey: PORTAL_KEY,
    version: 1,
    effectiveFrom: '2026-09-27',
    hostAllowlist: ['service.ariba.example', 'accounts.sap.example'],
    signIn: {
      origin: 'https://accounts.sap.example',
      formPaths: ['/sign-in'],
      mfaPaths: ['/mfa'],
      acsPaths: [],
    },
    neverClick: ['Create Invoice'],
    postAsRead: [],
    caps: { maxPages: 10, maxDownloads: 0, maxRunMs: 120_000 },
    provenance: {
      draftedBy: { kind: 'person', id: 'founder' },
      source: 'walk-through 2026-09-28',
      portalAdr: '0062',
    },
    steps: [
      { kind: 'open', name: 'open_sign_in', url: 'https://service.ariba.example/sign-in' },
      { kind: 'sign_in' },
      { kind: 'answer_mfa' },
      { kind: 'expect', name: 'expect_anid', selector: '#anid' },
      { kind: 'capture_page', name: 'landing' },
      { kind: 'sign_out' },
    ],
    ...over,
  };
}

function version(
  over: Partial<PortalRecipeVersionRecord> = {},
  recipeOver: Record<string, unknown> = {},
): PortalRecipeVersionRecord {
  const recipe = parseRecipe(recipeJson(recipeOver));
  return {
    recipeVersionId: VERSION_ID,
    orgId: ORG_ID,
    portalKey: recipe.portalKey,
    version: recipe.version,
    effectiveFrom: recipe.effectiveFrom,
    recipe,
    createdBy: USER_ID,
    agentSessionId: null,
    createdAt: new Date('2026-09-28T09:00:00Z'),
    review: null,
    ...over,
  };
}

function connection(over: Partial<PortalConnectionRecord> = {}): PortalConnectionRecord {
  return {
    connectionId: CONNECTION_ID,
    orgId: ORG_ID,
    portalKey: PORTAL_KEY,
    label: 'SAP Business Network — plumbing test',
    accountId: 'AN01234567890-T',
    params: {},
    enabled: true,
    createdBy: CREATOR_ID,
    createdAt: new Date('2026-09-28T08:00:00Z'),
    updatedAt: new Date('2026-09-28T08:00:00Z'),
    ...over,
  };
}

function credential(binding: PortalBinding): PortalCredentialRecord {
  return {
    credentialId: CREDENTIAL_ID,
    connectionId: CONNECTION_ID,
    label: null,
    sealed: { cipher: 'aws-kms+aes-256-gcm', keyId: 'arn:aws:kms:k', wrappedKey: 'd3JhcHBlZA==', ciphertext: 'c2VhbGVk' },
    binding,
    createdBy: USER_ID,
    createdAt: new Date('2026-09-28T09:30:00Z'),
  };
}

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  sessions: 0,
  /** Every store built: whose claims, and what cipher it was handed. */
  built: [] as { tenant: unknown; cipher: unknown }[],
  mayWrite: true,
  connection: undefined as unknown,
  versions: new Map<string, unknown>(),
  credential: undefined as unknown,
  runs: [] as unknown[],
  preview: { comparedWithVersionId: null as string | null, additions: [] as unknown[] },
  /** Every store method called with a write or a read that matters, in order. */
  calls: [] as { method: string; input: unknown }[],
  /** A method name, and what it throws. */
  failures: new Map<string, unknown>(),
  disableOutcome: 'disabled' as unknown,
  enableOutcome: 'enabled' as unknown,
  inngest: true,
  inngestHalf: false,
  sendFails: false,
  sent: [] as unknown[],
}));

// The store is a fake, so no database is dialled; the URL is never read from
// the process, which a test must not hold (scripts/test-database.ts).
vi.mock('../lib/env', () => ({ env: { databaseUrl: 'postgres://unused@127.0.0.1:1/unused' } }));

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

vi.mock('@recouple/store-postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/store-postgres')>();
  const portal = await import('@recouple/portal');
  const call = async (method: string, input: unknown): Promise<void> => {
    harness.calls.push({ method, input });
    const failure = harness.failures.get(method);
    if (failure !== undefined) throw failure;
  };
  class FakePortalStore {
    constructor(_config: unknown, tenant: unknown, options: { cipher?: unknown } = {}) {
      harness.built.push({ tenant, cipher: options.cipher });
    }
    async memberMayWrite(actor: unknown) {
      await call('memberMayWrite', actor);
      return harness.mayWrite;
    }
    async createConnection(input: unknown) {
      await call('createConnection', input);
      return '99999999-9999-4999-8999-999999999999';
    }
    async connection(id: string) {
      await call('connection', id);
      const found = harness.connection as { connectionId: string } | undefined;
      return found?.connectionId === id ? found : undefined;
    }
    async addRecipeVersion(input: { recipe: unknown }) {
      await call('addRecipeVersion', input);
      portal.parseRecipe(input.recipe);
      return VERSION_ID;
    }
    async recipeVersion(id: string) {
      await call('recipeVersion', id);
      return harness.versions.get(id);
    }
    async reviewPreview(id: string) {
      await call('reviewPreview', id);
      return harness.versions.has(id) ? harness.preview : undefined;
    }
    async reviewRecipeVersion(input: unknown) {
      await call('reviewRecipeVersion', input);
      return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    }
    async sealAndStoreCredential(input: unknown) {
      await call('sealAndStoreCredential', input);
      return CREDENTIAL_ID;
    }
    async latestCredential(id: string) {
      await call('latestCredential', id);
      return harness.credential;
    }
    async listRuns(id: string, limit: number) {
      await call('listRuns', { id, limit });
      return harness.runs.slice(0, limit);
    }
    async disableConnection(input: unknown) {
      await call('disableConnection', input);
      return harness.disableOutcome;
    }
    async enableConnection(id: string) {
      await call('enableConnection', id);
      return harness.enableOutcome;
    }
  }
  return { ...actual, PostgresPortalStore: FakePortalStore };
});

vi.mock('../lib/inngest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/inngest')>();
  return {
    ...actual,
    inngestKeysFromEnv: () => {
      if (harness.inngestHalf) throw new Error('INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY go together');
      return harness.inngest ? { eventKey: 'event-key', signingKey: 'signkey-test' } : undefined;
    },
    inngestClient: () => ({
      send: async (event: unknown) => {
        if (harness.sendFails) throw Object.assign(new Error('queue unreachable'), { name: 'FetchError' });
        harness.sent.push(event);
      },
    }),
  };
});

const connect = (await import('../app/settings/portals/connect/route')).POST;
const uploadRecipe = (await import('../app/settings/portals/recipe/route')).POST;
const review = (await import('../app/settings/portals/review/route')).POST;
const enterCredential = (await import('../app/settings/portals/credential/route')).POST;
const turn = (await import('../app/settings/portals/switch/route')).POST;
const dryRun = (await import('../app/settings/portals/dry-run/route')).POST;

const ROUTES = [
  ['/settings/portals/connect', connect],
  ['/settings/portals/recipe', uploadRecipe],
  ['/settings/portals/review', review],
  ['/settings/portals/credential', enterCredential],
  ['/settings/portals/switch', turn],
  ['/settings/portals/dry-run', dryRun],
] as const;

function post(path: string, fields: Record<string, string | File> = {}, site = 'same-origin'): NextRequest {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    headers: { 'sec-fetch-site': site },
    body,
  });
}

function landed(response: Response): { status: number; path: string; said: string | undefined; location: string } {
  const location = response.headers.get('location') ?? '';
  const at = new URL(location || 'https://app.example.test/');
  return {
    status: response.status,
    path: at.pathname,
    said: resolvePortalNotice(at.searchParams.get('portal') ?? undefined, at.searchParams.getAll('about'))?.text,
    location,
  };
}

const saved = { ...process.env };
const logged: string[] = [];
const locations: string[] = [];

beforeEach(() => {
  process.env.PORTAL_KMS_KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/portal';
  process.env.QBO_TOKEN_KMS_KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/qbo';
  process.env.AWS_REGION = 'us-east-1';
  Object.assign(harness, {
    role: 'owner',
    sessions: 0,
    built: [],
    mayWrite: true,
    connection: connection(),
    versions: new Map([[VERSION_ID, version()]]),
    credential: credential(bindingOf(version().recipe)),
    runs: [],
    preview: { comparedWithVersionId: null, additions: [] },
    calls: [],
    failures: new Map(),
    disableOutcome: 'disabled',
    enableOutcome: 'enabled',
    inngest: true,
    inngestHalf: false,
    sendFails: false,
    sent: [],
  });
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '));
    });
  }
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** Every secret-shaped value, everywhere a caller could read one afterwards. */
function sweep(): void {
  const readable = [logged.join('\n'), locations.join('\n'), JSON.stringify(harness.sent)].join('\n');
  for (const secret of SECRETS) expect(readable).not.toContain(secret);
}

async function send(route: (request: NextRequest) => Promise<Response>, request: NextRequest) {
  const response = await route(request);
  locations.push(response.headers.get('location') ?? '');
  return landed(response);
}

const methods = () => harness.calls.map((c) => c.method);

describe('every route', () => {
  it('refuses a cross-site POST with a 403, before the session is resolved', async () => {
    for (const [path, route] of ROUTES) {
      const response = await route(post(path, { connectionId: CONNECTION_ID }, 'cross-site'));
      expect(response.status, path).toBe(403);
      expect(response.headers.get('location'), path).toBeNull();
    }
    expect(harness.sessions).toBe(0);
    expect(harness.built).toEqual([]);
  });

  it('refuses anyone but an owner before any store is built', async () => {
    for (const role of ['approver', 'analyst', 'read_only', 'accountant_guest']) {
      harness.role = role;
      for (const [path, route] of ROUTES) {
        const at = await send(
          route,
          post(path, {
            connectionId: CONNECTION_ID,
            recipeVersionId: VERSION_ID,
            username: USERNAME,
            password: PASSWORD,
            totpSecret: TYPED_KEY,
          }),
        );
        expect(at, `${role} ${path}`).toMatchObject({
          status: 303,
          said: expect.stringMatching(/^only an owner can/),
        });
      }
    }
    expect(harness.built).toEqual([]);
    expect(harness.calls).toEqual([]);
    sweep();
  });

  it('asks the database whether the owner may still write, and writes nothing when not', async () => {
    harness.mayWrite = false;
    const fields = {
      portalKey: PORTAL_KEY,
      label: 'Ariba',
      accountId: 'AN01',
      recipe: new File([JSON.stringify(recipeJson())], 'recipe.json', { type: 'application/json' }),
      recipeVersionId: VERSION_ID,
      verdict: 'promoted',
      comparedWith: 'none',
      connectionId: CONNECTION_ID,
      username: USERNAME,
      password: PASSWORD,
      turn: 'off',
    };
    for (const [path, route] of ROUTES) {
      harness.calls = [];
      const at = await send(route, post(path, fields));
      expect(at.said, path).toMatch(/^only an owner can/);
      expect(methods(), path).toEqual(['memberMayWrite']);
      expect(harness.calls[0]?.input, path).toEqual({ orgId: ORG_ID, userId: USER_ID });
    }
    expect(harness.sent).toEqual([]);
    sweep();
  });
});

describe('adding a connection', () => {
  it('adds one as the owner, with its parameters, and logs ids and the portal key only', async () => {
    const at = await send(
      connect,
      post('/settings/portals/connect', {
        portalKey: ` ${PORTAL_KEY} `,
        label: 'SAP — plumbing test',
        accountId: 'AN01234567890-T',
        params: 'region = EU\n\nsupplier.number=0042 ',
      }),
    );
    expect(at).toMatchObject({ path: '/settings/portals', said: expect.stringMatching(/^the connection is added/) });
    expect(harness.built).toEqual([{ tenant: { orgId: ORG_ID, userId: USER_ID }, cipher: undefined }]);
    expect(harness.calls.find((c) => c.method === 'createConnection')?.input).toEqual({
      portalKey: PORTAL_KEY,
      label: 'SAP — plumbing test',
      accountId: 'AN01234567890-T',
      params: { region: 'EU', 'supplier.number': '0042' },
    });
    const line = logged.join('\n');
    expect(line).toContain(`portal connection added: connection 99999999-9999-4999-8999-999999999999 portal ${PORTAL_KEY}`);
    expect(line).not.toContain('AN01234567890-T');
    expect(line).not.toContain('plumbing test');
  });

  it('refuses a malformed key, label, account id or parameter before the store is asked', async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ portalKey: 'SAP Business Network', label: 'L', accountId: 'AN01' }, /^a portal key is/],
      [{ portalKey: PORTAL_KEY, label: '', accountId: 'AN01' }, /^a label is/],
      [{ portalKey: PORTAL_KEY, label: 'L', accountId: '' }, /^an account id is/],
      [{ portalKey: PORTAL_KEY, label: 'L', accountId: 'AN01', params: 'no equals sign' }, /^run parameters are/],
      [{ portalKey: PORTAL_KEY, label: 'L', accountId: 'AN01', params: '__proto__=x' }, /^run parameters are/],
      [{ portalKey: PORTAL_KEY, label: 'L', accountId: 'AN01', params: 'a=1\na=2' }, /^run parameters are/],
    ];
    for (const [fields, said] of cases) {
      expect((await send(connect, post('/settings/portals/connect', fields))).said).toMatch(said);
    }
    expect(harness.built).toEqual([]);
  });

  it('says the store’s refusals in words, and a fault as a fault', async () => {
    const fields = { portalKey: PORTAL_KEY, label: 'L', accountId: 'AN01' };
    harness.failures.set('createConnection', new PortalAccountConnectedElsewhereError(PORTAL_KEY));
    expect((await send(connect, post('/settings/portals/connect', fields))).said).toMatch(/connected in another workspace/);
    harness.failures.set('createConnection', new PortalInputError([{ field: 'label', rule: 'no leading or trailing whitespace' }]));
    expect((await send(connect, post('/settings/portals/connect', fields))).said).toMatch(/^a label is/);
    harness.failures.set('createConnection', new PortalOwnerRequiredError(ORG_ID, USER_ID));
    expect((await send(connect, post('/settings/portals/connect', fields))).said).toMatch(/^only an owner/);
    harness.failures.set('createConnection', Object.assign(new Error('connection refused AN01'), { name: 'DatabaseError' }));
    expect((await send(connect, post('/settings/portals/connect', fields))).said).toMatch(/did not go through/);
    expect(logged.join('\n')).toContain(`portal connection add failed: portal ${PORTAL_KEY} org ${ORG_ID} (DatabaseError)`);
    expect(logged.join('\n')).not.toContain('AN01');
  });
});

describe('uploading a recipe version', () => {
  const file = (text: string, name = 'recipe.json') => new File([text], name, { type: 'application/json' });

  it('stores what parseRecipe accepts and opens it for review', async () => {
    const at = await send(
      uploadRecipe,
      post('/settings/portals/recipe', { portalKey: PORTAL_KEY, recipe: file(JSON.stringify(recipeJson())) }),
    );
    expect(at).toMatchObject({
      path: `/settings/portals/versions/${VERSION_ID}`,
      said: `version 1 of the ${PORTAL_KEY} recipe is stored. Review it below: only a dry run runs a version nobody has promoted.`,
    });
    expect(harness.calls.find((c) => c.method === 'addRecipeVersion')?.input).toEqual({ recipe: recipeJson() });
  });

  it('refuses what is not a recipe file before the store is asked', async () => {
    expect((await send(uploadRecipe, post('/settings/portals/recipe', {}))).said).toMatch(/^choose a recipe file/);
    expect((await send(uploadRecipe, post('/settings/portals/recipe', { recipe: file('') }))).said).toMatch(/^choose a recipe file/);
    expect((await send(uploadRecipe, post('/settings/portals/recipe', { recipe: file('{"portalKey": ') }))).said).toMatch(/not JSON/);
    expect((await send(uploadRecipe, post('/settings/portals/recipe', { recipe: file('x'.repeat(128 * 1024 + 1)) }))).said).toMatch(/over 128 KB/);
    expect(
      (await send(
        uploadRecipe,
        post('/settings/portals/recipe', { portalKey: 'unfi', recipe: file(JSON.stringify(recipeJson())) }),
      )).said,
    ).toMatch(/for another portal/);
    expect(harness.built).toEqual([]);
  });

  it('names where parseRecipe refused it, and never what the recipe said there', async () => {
    const bad = recipeJson({ signIn: { origin: 'https://elsewhere.example', formPaths: ['/sign-in'], mfaPaths: [], acsPaths: [] } });
    const at = await send(uploadRecipe, post('/settings/portals/recipe', { recipe: file(JSON.stringify(bad)) }));
    expect(at.said).toBe('that recipe was refused at signIn.origin, so nothing was stored');
    expect(logged.join('\n')).toContain('(RecipeRefusedError at signIn.origin)');
    expect(logged.join('\n')).not.toContain('elsewhere.example');

    // A refusal at the root, which has no path to name, is said without one.
    const weird = { ...recipeJson(), 'an <odd> key': 1 };
    expect((await send(uploadRecipe, post('/settings/portals/recipe', { recipe: file(JSON.stringify(weird)) }))).said).toBe(
      'that recipe is not one this app can run, so nothing was stored',
    );
    expect(logged.join('\n')).not.toContain('<odd>');
  });

  it('says a version number already taken, an agent’s draft, and a fault', async () => {
    const upload = () => send(uploadRecipe, post('/settings/portals/recipe', { recipe: file(JSON.stringify(recipeJson())) }));
    harness.failures.set('addRecipeVersion', new PortalRecipeVersionExistsError(PORTAL_KEY, 1));
    expect((await upload()).said).toBe(
      `version 1 of the ${PORTAL_KEY} recipe already exists here. A changed portal is a new version number; nothing was stored.`,
    );
    harness.failures.set('addRecipeVersion', new PortalRecipeProvenanceError('its recipe says an agent session drafted it'));
    expect((await upload()).said).toMatch(/agent session drafted it/);
    harness.failures.set('addRecipeVersion', new Error('boom'));
    expect((await upload()).said).toMatch(/did not go through/);
  });
});

describe('reviewing a version', () => {
  const promote = (over: Record<string, string> = {}) =>
    send(
      review,
      post('/settings/portals/review', {
        recipeVersionId: VERSION_ID,
        verdict: 'promoted',
        comparedWith: 'none',
        ...over,
      }),
    );

  it('promotes it when the preview is still what the owner read, and says from when', async () => {
    const at = await promote();
    expect(at).toMatchObject({
      path: '/settings/portals',
      said: `version 1 of the ${PORTAL_KEY} recipe is promoted, effective from 2026-09-27`,
    });
    expect(harness.calls.find((c) => c.method === 'reviewRecipeVersion')?.input).toEqual({
      recipeVersionId: VERSION_ID,
      verdict: 'promoted',
    });
  });

  it('rejects one', async () => {
    expect((await promote({ verdict: 'rejected' })).said).toBe(
      `version 1 of the ${PORTAL_KEY} recipe is rejected, and is never promoted`,
    );
  });

  it('records nothing when another version was promoted since the review was opened', async () => {
    harness.preview = { comparedWithVersionId: OTHER_VERSION_ID, additions: [] };
    const at = await promote({ comparedWith: 'none' });
    expect(at).toMatchObject({ path: `/settings/portals/versions/${VERSION_ID}`, said: expect.stringMatching(/changed after this review was opened/) });
    expect(methods()).not.toContain('reviewRecipeVersion');

    expect((await promote({ comparedWith: OTHER_VERSION_ID })).said).toMatch(/is promoted/);
  });

  it('refuses a second review, an agent draft that adds, an unknown version and a made-up verdict', async () => {
    harness.versions.set(VERSION_ID, version({ review: { reviewId: 'r', verdict: 'rejected', reviewer: USER_ID, comparedWithVersionId: null, additions: [], createdAt: new Date() } }));
    expect((await promote()).said).toMatch(/already has its review/);

    harness.versions.set(VERSION_ID, version());
    harness.failures.set('reviewRecipeVersion', new PortalRecipeAlreadyReviewedError(VERSION_ID));
    expect((await promote()).said).toMatch(/already has its review/);
    harness.failures.set('reviewRecipeVersion', new PortalAgentDraftAdditionsError(VERSION_ID, 2));
    expect((await promote()).said).toMatch(/rejected but never promoted/);

    harness.failures.clear();
    expect((await promote({ recipeVersionId: OTHER_VERSION_ID })).said).toMatch(/not a recipe version/);
    expect((await promote({ recipeVersionId: 'not-a-uuid' })).said).toMatch(/not a recipe version/);
    expect((await promote({ verdict: 'approved' })).said).toMatch(/choose to promote or to reject/);
  });
});

describe('entering a credential', () => {
  const enter = (over: Record<string, string> = {}) =>
    send(
      enterCredential,
      post('/settings/portals/credential', {
        connectionId: CONNECTION_ID,
        recipeVersionId: VERSION_ID,
        username: USERNAME,
        password: PASSWORD,
        totpSecret: TYPED_KEY,
        label: 'service user, from the vault',
        ...over,
      }),
    );

  it('stores nothing, and builds no store, on a deployment without the portal key', async () => {
    delete process.env.PORTAL_KMS_KEY_ID;
    expect((await enter()).said).toBe('credentials cannot be sealed on this deployment, so nothing was stored');
    expect(harness.built).toEqual([]);

    // The QuickBooks key is not the portal key, whatever the variable says.
    process.env.PORTAL_KMS_KEY_ID = process.env.QBO_TOKEN_KMS_KEY_ID;
    expect((await enter()).said).toBe('credentials cannot be sealed on this deployment, so nothing was stored');
    expect(harness.built).toEqual([]);
    sweep();
  });

  it('seals with the portal key’s seal-only cipher, the setup key folded, as the owner', async () => {
    const at = await enter();
    expect(at.said).toMatch(/^the credential is sealed and stored\. This app cannot open it/);
    expect(harness.built).toHaveLength(1);
    const built = harness.built[0] as { tenant: unknown; cipher: { mode: string; name: string } };
    expect(built.tenant).toEqual({ orgId: ORG_ID, userId: USER_ID });
    expect(built.cipher.mode).toBe('seal_only');
    expect(built.cipher.name).toBe('aws-kms+aes-256-gcm');
    expect(harness.calls.find((c) => c.method === 'sealAndStoreCredential')?.input).toEqual({
      connectionId: CONNECTION_ID,
      recipeVersionId: VERSION_ID,
      label: 'service user, from the vault',
      payload: { username: USERNAME, password: PASSWORD, totpSecret: FOLDED_KEY },
    });
    expect(logged.join('\n')).toContain(
      `portal credential stored: credential ${CREDENTIAL_ID} connection ${CONNECTION_ID} version ${VERSION_ID}`,
    );
    sweep();
  });

  it('leaves the setup key out when none is entered, and says when the connection is off', async () => {
    harness.connection = connection({ enabled: false });
    const at = await enter({ totpSecret: '   ', label: '' });
    expect(at.said).toMatch(/The connection is off: turn it on before a run/);
    expect(harness.calls.find((c) => c.method === 'sealAndStoreCredential')?.input).toEqual({
      connectionId: CONNECTION_ID,
      recipeVersionId: VERSION_ID,
      payload: { username: USERNAME, password: PASSWORD },
    });
    sweep();
  });

  it('refuses a label holding any part of the credential, before anything is sealed', async () => {
    for (const label of [`for ${USERNAME.toUpperCase()}`, `pw ${PASSWORD}`, 'key GEZD-GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ']) {
      expect((await enter({ label })).said).toMatch(/may not contain the username, the password or the setup key/);
    }
    expect(harness.built).toEqual([]);
    sweep();
  });

  it('refuses what is not a credential before the store is built', async () => {
    expect((await enter({ username: '' })).said).toMatch(/^a username is 3 to 320 characters/);
    expect((await enter({ password: '' })).said).toMatch(/^enter the password/);
    expect((await enter({ totpSecret: 'GEZD GNBV 0189' })).said).toMatch(/^that setup key is not a whole base32 key/);
    expect((await enter({ connectionId: 'nope' })).said).toMatch(/not a portal connection/);
    expect((await enter({ recipeVersionId: 'nope' })).said).toMatch(/choose a recipe version/);
    expect(harness.built).toEqual([]);
    sweep();
  });

  it('says the store’s refusals by field, and never repeats a value the store was given', async () => {
    harness.failures.set('sealAndStoreCredential', new PortalInputError([{ field: 'payload.totpSecret', rule: 'custom' }]));
    expect((await enter()).said).toMatch(/^that setup key is not a whole base32 key/);
    harness.failures.set('sealAndStoreCredential', new PortalInputError([{ field: 'payload.username', rule: 'custom' }]));
    expect((await enter()).said).toMatch(/^a username is/);
    expect(logged.join('\n')).toContain('(PortalInputError payload.username)');

    // A fault whose message carries a secret is logged by its class alone.
    harness.failures.set(
      'sealAndStoreCredential',
      Object.assign(new Error(`could not store ${USERNAME} / ${PASSWORD}`), { name: 'DatabaseError' }),
    );
    expect((await enter()).said).toMatch(/did not go through/);
    expect(logged.join('\n')).toContain(`org ${ORG_ID} (DatabaseError)`);

    const { TokenCipherModeError } = await import('@recouple/crypto');
    harness.failures.set('sealAndStoreCredential', new TokenCipherModeError('open_only', 'seal'));
    expect((await enter()).said).toMatch(/could not be sealed, so nothing was stored/);
    sweep();
  });

  it('refuses a connection this tenant cannot see', async () => {
    harness.connection = undefined;
    expect((await enter()).said).toMatch(/not a portal connection/);
    expect(methods()).not.toContain('sealAndStoreCredential');
    sweep();
  });
});

describe('turning a connection off and on', () => {
  const flip = (to: string) => send(turn, post('/settings/portals/switch', { connectionId: CONNECTION_ID, turn: to }));

  it('turns it off for the owner’s reason, and on again', async () => {
    expect((await flip('off')).said).toMatch(/^the connection is off/);
    expect(harness.calls.find((c) => c.method === 'disableConnection')?.input).toEqual({
      connectionId: CONNECTION_ID,
      reason: 'turned_off',
    });
    expect((await flip('on')).said).toMatch(/^the connection is on/);
    expect(harness.calls.find((c) => c.method === 'enableConnection')?.input).toBe(CONNECTION_ID);
  });

  it('says when nothing changed, and when the credential must be entered first', async () => {
    harness.disableOutcome = 'already_off';
    expect((await flip('off')).said).toMatch(/already off/);
    harness.enableOutcome = 'already_on';
    expect((await flip('on')).said).toMatch(/already on/);
    harness.failures.set('enableConnection', new PortalCredentialReplacementRequiredError(CONNECTION_ID, 'credential_rejected'));
    expect((await flip('on')).said).toMatch(/the portal refused this connection’s credential/);
    harness.enableOutcome = undefined;
    harness.failures.clear();
    expect((await flip('on')).said).toMatch(/not a portal connection/);
    expect((await flip('sideways')).said).toMatch(/not a portal connection/);
  });
});

describe('starting a dry run', () => {
  const start = (over: Record<string, string> = {}) =>
    send(dryRun, post('/settings/portals/dry-run', { connectionId: CONNECTION_ID, recipeVersionId: VERSION_ID, ...over }));

  it('queues one event of ids, acting as the connection’s creator and not whoever pressed', async () => {
    const at = await start();
    expect(at.said).toMatch(/^the dry run is queued/);
    expect(harness.sent).toEqual([
      {
        name: 'portal/read.requested',
        data: {
          connectionId: CONNECTION_ID,
          orgId: ORG_ID,
          userId: CREATOR_ID,
          dryRun: true,
          recipeVersionId: VERSION_ID,
          runKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        },
      },
    ]);
    const line = logged.join('\n');
    expect(line).toContain(`portal dry run queued: connection ${CONNECTION_ID} version ${VERSION_ID} org ${ORG_ID}`);
    expect(line).toContain(`by ${USER_ID} acting as ${CREATOR_ID}`);
  });

  it('sends what the portal job’s own parser reads back unchanged', async () => {
    await start();
    const { parsePortalReadRequested } = await import('../lib/inngest-portal');
    const event = harness.sent[0] as { name: string; data: unknown };
    expect(event.name).toBe(PORTAL_READ_REQUESTED);
    expect(parsePortalReadRequested(event.data)).toEqual(event.data);
  });

  it('gives each press its own key', async () => {
    await start();
    await start();
    const keys = (harness.sent as { data: { runKey: string } }[]).map((event) => event.data.runKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('starts nothing that could only fail', async () => {
    harness.connection = connection({ enabled: false });
    expect((await start()).said).toMatch(/^the connection is off: turn it on before a dry run/);

    harness.connection = connection();
    harness.versions.set(VERSION_ID, version({ review: { reviewId: 'r', verdict: 'rejected', reviewer: USER_ID, comparedWithVersionId: null, additions: [], createdAt: new Date() } }));
    expect((await start()).said).toMatch(/that version was rejected/);

    harness.versions.set(VERSION_ID, version({ portalKey: 'unfi' }));
    expect((await start()).said).toMatch(/not a recipe version/);

    harness.versions.set(VERSION_ID, version());
    harness.credential = undefined;
    expect((await start()).said).toMatch(/^enter a credential before a dry run/);

    // Sealed for another sign-in: the worker would refuse it before opening it.
    harness.credential = credential(
      bindingOf(parseRecipe(recipeJson({ hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'cdn.example'] }))),
    );
    expect((await start()).said).toMatch(/sealed for another sign-in than that version’s/);

    expect(harness.sent).toEqual([]);
  });

  it('waits for a run of the connection still in flight, and says since when', async () => {
    const running: PortalRunRecord = {
      runId: RUN_ID,
      connectionId: CONNECTION_ID,
      recipeVersionId: VERSION_ID,
      dryRun: true,
      requestedBy: CREATOR_ID,
      startedAt: new Date(Date.now() - 60_000),
      end: null,
    };
    harness.runs = [running];
    const at = await start();
    expect(at.said).toMatch(/^a run of this connection started at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC and has not finished/);
    expect(harness.sent).toEqual([]);

    // One that never finished, long ago, no longer holds the next.
    harness.runs = [{ ...running, startedAt: new Date(Date.now() - 60 * 60_000) }];
    expect((await start()).said).toMatch(/^the dry run is queued/);
  });

  it('says a deployment with no queue, half a queue, or a queue that refused', async () => {
    harness.inngest = false;
    expect((await start()).said).toBe('this deployment has no job queue, so nothing was started');
    harness.inngest = true;
    harness.inngestHalf = true;
    expect((await start()).said).toMatch(/could not be queued/);
    harness.inngestHalf = false;
    harness.sendFails = true;
    expect((await start()).said).toMatch(/could not be queued/);
    expect(logged.join('\n')).toContain('(FetchError)');
    expect(harness.sent).toEqual([]);
  });
});

describe('the notice travels as a key', () => {
  it('never carries a sentence or a value in the redirect', async () => {
    await send(
      enterCredential,
      post('/settings/portals/credential', {
        connectionId: CONNECTION_ID,
        recipeVersionId: VERSION_ID,
        username: USERNAME,
        password: PASSWORD,
        totpSecret: TYPED_KEY,
      }),
    );
    const last = new URL(locations.at(-1) as string);
    expect([...last.searchParams.keys()]).toEqual(['portal']);
    expect(last.searchParams.get('portal')).toBe('portal_credential_stored');
    sweep();
  });
});
