import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  bindingOf,
  parseRecipe,
  PORTAL_FAILED_REASONS,
  PORTAL_NEEDS_ATTENTION_REASONS,
  PORTAL_RUNNER_FAILED_REASONS,
  type PortalBinding,
  type PortalConnectionRecord,
  type PortalCredentialRecord,
  type PortalRecipeVersionRecord,
  type PortalRunEndRecord,
  type PortalRunRecord,
} from '@recouple/portal';
import {
  PORTAL_READ_ERROR_CLASSES,
  PORTAL_READ_POLL,
  PORTAL_WORKER_BUSY_RETRY_MS,
  portalReadPollLimit,
} from '@recouple/pipeline';
import {
  foldSetupKey,
  labelHoldsSecret,
  parseRunParams,
  portalRunsMissingFromEnv,
  portalSealingFromEnv,
  resolvePortalNotice,
  runEndWords,
  runInFlightForMs,
  runWords,
  PORTAL_NOTICES,
} from '../lib/portals';

/**
 * Settings → Portals as a person sees it (ADR 0057 §3, §7, §13; ADR 0062):
 * who is shown what, what a deployment that cannot seal says, a run's outcome
 * in words for every code the contract and the job can record, and the review
 * screen an owner reads before promoting a version.
 *
 * The page and the review screen are rendered through their route modules
 * with a fake store, so what is asserted is what a member would be sent —
 * including what is *not* read on a `read_only` member's behalf.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ANALYST_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const VERSION_2_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '88888888-8888-4888-8888-888888888888';
const PORTAL_KEY = 'sap_business_network';
const ACCOUNT_ID = 'AN01234567890-T';
const LABEL = 'SAP Business Network — plumbing test';
const SEALED = { cipher: 'aws-kms+aes-256-gcm', keyId: 'arn:aws:kms:us-east-1:1:key/p', wrappedKey: 'V1JBUFBFRC1LRVktTUFSSw==', ciphertext: 'Q0lQSEVSVEVYVC1NQVJL' };

function recipeJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    portalKey: PORTAL_KEY,
    version: 1,
    effectiveFrom: '2026-09-27',
    hostAllowlist: ['service.ariba.example', 'accounts.sap.example'],
    signIn: { origin: 'https://accounts.sap.example', formPaths: ['/sign-in'], mfaPaths: ['/mfa'], acsPaths: [] },
    neverClick: ['Create Invoice', 'Publish'],
    postAsRead: [],
    caps: { maxPages: 10, maxDownloads: 0, maxRunMs: 120_000 },
    provenance: { draftedBy: { kind: 'person', id: 'founder' }, source: 'walk-through of 2026-09-28', portalAdr: '0062' },
    steps: [
      { kind: 'open', name: 'open_sign_in', url: 'https://service.ariba.example/sign-in' },
      { kind: 'sign_in' },
      { kind: 'answer_mfa' },
      { kind: 'expect', name: 'expect_anid', selector: '#anid-badge' },
      { kind: 'capture_page', name: 'landing' },
      { kind: 'sign_out' },
    ],
    ...over,
  };
}

function version(over: Partial<PortalRecipeVersionRecord> = {}, recipeOver: Record<string, unknown> = {}): PortalRecipeVersionRecord {
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

const PROMOTED = {
  reviewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  verdict: 'promoted' as const,
  reviewer: USER_ID,
  comparedWithVersionId: null,
  additions: [],
  createdAt: new Date('2026-09-28T09:10:00Z'),
};

function connection(over: Partial<PortalConnectionRecord> = {}): PortalConnectionRecord {
  return {
    connectionId: CONNECTION_ID,
    orgId: ORG_ID,
    portalKey: PORTAL_KEY,
    label: LABEL,
    accountId: ACCOUNT_ID,
    params: {},
    enabled: true,
    createdBy: USER_ID,
    createdAt: new Date('2026-09-28T08:00:00Z'),
    updatedAt: new Date('2026-09-28T08:00:00Z'),
    ...over,
  };
}

function credential(binding: PortalBinding): PortalCredentialRecord {
  return {
    credentialId: '77777777-7777-4777-8777-777777777777',
    connectionId: CONNECTION_ID,
    label: 'from the vault',
    sealed: SEALED,
    binding,
    createdBy: USER_ID,
    createdAt: new Date('2026-09-28T09:30:00Z'),
  };
}

function ended(end: Partial<PortalRunEndRecord> & Pick<PortalRunEndRecord, 'outcome'>): PortalRunEndRecord {
  return {
    atStep: null,
    counts: { pages: 3, captures: 0, newDocuments: 0, deduplicated: 0, refusals: 1 },
    stepLog: [
      { step: 'open_sign_in', passed: true },
      { step: 'sign_in', passed: false },
    ],
    finishedAt: new Date('2026-09-28T10:02:00Z'),
    ...end,
  } as PortalRunEndRecord;
}

function run(end: PortalRunEndRecord | null, over: Partial<PortalRunRecord> = {}): PortalRunRecord {
  return {
    runId: RUN_ID,
    connectionId: CONNECTION_ID,
    recipeVersionId: VERSION_ID,
    dryRun: true,
    requestedBy: USER_ID,
    startedAt: new Date('2026-09-28T10:00:00Z'),
    end,
    ...over,
  };
}

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  calls: [] as string[],
  connections: [] as unknown[],
  versions: [] as unknown[],
  credential: undefined as unknown,
  promoted: undefined as unknown,
  runs: [] as unknown[],
  preview: { comparedWithVersionId: null as string | null, additions: [] as unknown[] },
  members: [] as unknown[],
}));

// The store is a fake, so no database is dialled; the URL is never read from
// the process, which a test must not hold (scripts/test-database.ts).
vi.mock('../lib/env', () => ({ env: { databaseUrl: 'postgres://unused@127.0.0.1:1/unused' } }));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'owner@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
}));

vi.mock('@recouple/store-postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/store-postgres')>();
  class FakePortalStore {
    async listConnections() {
      harness.calls.push('listConnections');
      return harness.connections;
    }
    async listRecipeVersions(portalKey: string) {
      harness.calls.push(`listRecipeVersions ${portalKey}`);
      return harness.versions;
    }
    async latestCredential() {
      harness.calls.push('latestCredential');
      return harness.credential;
    }
    async promotedRecipe() {
      harness.calls.push('promotedRecipe');
      return harness.promoted;
    }
    async listRuns(_id: string, limit: number) {
      harness.calls.push(`listRuns ${limit}`);
      return harness.runs;
    }
    async recipeVersion(id: string) {
      harness.calls.push(`recipeVersion ${id}`);
      return (harness.versions as { recipeVersionId: string }[]).find((v) => v.recipeVersionId === id);
    }
    async reviewPreview(id: string) {
      harness.calls.push(`reviewPreview ${id}`);
      return harness.preview;
    }
  }
  class FakeTeamStore {
    async members() {
      harness.calls.push('members');
      return harness.members;
    }
  }
  return { ...actual, PostgresPortalStore: FakePortalStore, PostgresTeamStore: FakeTeamStore };
});

const PortalsPage = (await import('../app/settings/portals/page')).default;
const VersionPage = (await import('../app/settings/portals/versions/[versionId]/page')).default;

async function page(search: { portal?: string; about?: string | string[] } = {}): Promise<string> {
  return renderToStaticMarkup(await PortalsPage({ searchParams: Promise.resolve(search) }));
}

async function versionPage(versionId: string, search: { portal?: string; about?: string | string[] } = {}): Promise<string> {
  return renderToStaticMarkup(
    await VersionPage({ params: Promise.resolve({ versionId }), searchParams: Promise.resolve(search) }),
  );
}

const saved = { ...process.env };

beforeEach(() => {
  process.env.PORTAL_KMS_KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/portal';
  process.env.PORTAL_READ_URL = 'https://portal-read.example';
  process.env.PORTAL_READ_TOKEN = 't'.repeat(64);
  process.env.INNGEST_EVENT_KEY = 'event-key';
  process.env.INNGEST_SIGNING_KEY = 'signkey-test';
  delete process.env.QBO_TOKEN_KMS_KEY_ID;
  const promoted = version({ review: PROMOTED });
  Object.assign(harness, {
    role: 'owner',
    calls: [],
    connections: [connection()],
    versions: [promoted],
    credential: credential(bindingOf(promoted.recipe)),
    promoted,
    runs: [],
    preview: { comparedWithVersionId: null, additions: [] },
    members: [
      { userId: USER_ID, email: 'owner@example.test', role: 'owner' },
      { userId: ANALYST_ID, email: 'analyst@example.test', role: 'analyst' },
    ],
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('who is shown what', () => {
  it('tells a read_only member how many connections there are, and reads nothing about them', async () => {
    harness.role = 'read_only';
    harness.connections = [connection(), connection({ connectionId: VERSION_2_ID, enabled: false })];
    const html = await page();
    expect(html).toContain('This workspace has 2 portal connections, 1 of them on.');
    expect(html).not.toContain(ACCOUNT_ID);
    expect(html).not.toContain(LABEL);
    expect(html).not.toContain('<form action="/settings/portals');
    expect(harness.calls).toEqual(['listConnections']);
    // A refused POST still says so.
    expect(await page({ portal: 'portal_role' })).toContain('only an owner can add a portal connection');
  });

  it('shows a writer the connection, its versions and runs, and no form', async () => {
    harness.role = 'analyst';
    const html = await page();
    expect(html).toContain(ACCOUNT_ID);
    expect(html).toContain('Recipe versions');
    expect(html).not.toContain('action="/settings/portals/credential"');
    expect(html).not.toContain('action="/settings/portals/connect"');
    expect(html).not.toContain('action="/settings/portals/dry-run"');
    expect(html).toContain('Only an owner can add a portal connection');
  });

  it('shows an owner every form, with nothing typed into any secret field', async () => {
    const html = await page();
    for (const action of ['connect', 'recipe', 'credential', 'switch', 'dry-run']) {
      expect(html, action).toContain(`action="/settings/portals/${action}"`);
    }
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="password"/);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="totpSecret"/);
    expect(html).not.toMatch(/name="(password|totpSecret|username)"[^>]*value=/);
    // The page never holds the sealed columns, only the fact of a credential.
    for (const sealed of Object.values(SEALED)) expect(html).not.toContain(sealed);
    expect(html).toContain('sealed for sign-in at https://accounts.sap.example');
    expect(html).toContain('“from the vault”');
  });

  it('says a deployment that cannot seal, and offers no credential form', async () => {
    delete process.env.PORTAL_KMS_KEY_ID;
    const html = await page();
    expect(html).toContain('Credentials cannot be entered here, so none is stored: PORTAL_KMS_KEY_ID is not set.');
    expect(html).toContain('This deployment cannot seal a credential, so none can be entered here');
    expect(html).not.toContain('action="/settings/portals/credential"');
    expect(html).not.toContain('name="password"');
  });

  it('names what runs lack by variable, never by value', async () => {
    delete process.env.PORTAL_READ_URL;
    process.env.PORTAL_READ_TOKEN = 'short-token-value';
    const html = await page();
    expect(html).toContain('PORTAL_READ_URL, PORTAL_READ_TOKEN (at least 64 characters)');
    expect(html).not.toContain('short-token-value');
    expect(html).not.toContain(process.env.PORTAL_KMS_KEY_ID as string);
  });
});

describe('what the connection card warns', () => {
  it('warns when the credential would not open for the version in effect', async () => {
    harness.credential = credential(
      bindingOf(parseRecipe(recipeJson({ hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'cdn.example'] }))),
    );
    const html = await page();
    expect(html).toContain('The credential was sealed for another sign-in than version 1');
    expect(html).toContain('(the credential was sealed for another sign-in)');
  });

  it('warns when the member runs act as is no longer an owner', async () => {
    harness.connections = [connection({ createdBy: ANALYST_ID })];
    const html = await page();
    expect(html).toContain('Every run acts as analyst@example.test, who is no longer an owner');
  });

  it('says a connection was turned off because the portal refused its credential', async () => {
    harness.connections = [connection({ enabled: false })];
    harness.runs = [run(ended({ outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' }))];
    const html = await page();
    expect(html).toContain('Turned off when the portal refused its credential');
    expect(html).toContain('Turn the connection on to start a dry run.');
    expect(html).toContain('stopped at sign_in');
    expect(html).toContain('<span class="mono">sign_in</span>: did not pass');
  });

  it('holds the dry run while a run is in flight', async () => {
    harness.runs = [run(null, { startedAt: new Date(Date.now() - 30_000) })];
    const html = await page();
    expect(html).toContain('has not finished.');
    expect(html).toContain('<strong>Running</strong>');
    expect(html).not.toContain('>Start a dry run<');
  });

  it('shows a notice only for a known key with fragments of its own shape', async () => {
    expect(await page({ portal: 'portal_turned_off' })).toContain('the connection is off.');
    expect(await page({ portal: 'portal_version_promoted', about: [PORTAL_KEY, '2', '2026-10-01'] })).toContain(
      `version 2 of the ${PORTAL_KEY} recipe is promoted, effective from 2026-10-01`,
    );
    const forged = await page({ portal: 'portal_version_promoted', about: ['<b>x</b>', '2', '2026-10-01'] });
    expect(forged).not.toContain('is promoted');
    expect(await page({ portal: 'your session expired, sign in at evil.test' })).not.toContain('evil.test');
  });
});

describe('a run in words', () => {
  const now = new Date('2026-09-28T10:05:00Z');

  it('has words for every reason the contract admits', () => {
    for (const reason of PORTAL_NEEDS_ATTENTION_REASONS) {
      const words = runEndWords(ended({ outcome: 'needs_attention', reason }), true);
      expect(words.headline, reason).toBe('Needs a person');
      expect(words.sentence.length, reason).toBeGreaterThan(40);
    }
    for (const reason of PORTAL_RUNNER_FAILED_REASONS) {
      const words = runEndWords(ended({ outcome: 'failed', reason }), true);
      expect(words.headline, reason).toBe('Failed');
      expect(words.sentence, reason).not.toContain('error');
    }
    expect(PORTAL_FAILED_REASONS).toContain('error');
  });

  it('says a refused code apart from a refused password', () => {
    const password = runEndWords(ended({ outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' }), true);
    const code = runEndWords(ended({ outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'answer_mfa' }), true);
    expect(password.sentence).toMatch(/refused the credential/);
    expect(code.sentence).toMatch(/refused the authenticator code/);
    expect(runEndWords(ended({ outcome: 'needs_attention', reason: 'session_expired' }), true).sentence).toMatch(
      /never signs in twice/,
    );
  });

  it('has its own words for every class name the job records, and names the class', () => {
    for (const errorClass of Object.values(PORTAL_READ_ERROR_CLASSES)) {
      for (const outcome of ['not_configured', 'refused'] as const) {
        const words = runEndWords(ended({ outcome, errorClass }), true);
        expect(words.sentence, errorClass).toContain(`(${errorClass})`);
        expect(words.sentence, errorClass).not.toMatch(/^Something it needs is missing|^Nothing was signed in to: the connection was off, the member/);
      }
    }
    const unknown = runEndWords(ended({ outcome: 'failed', reason: 'error', errorClass: 'TypeError' }), true);
    expect(unknown.sentence).toBe('The run failed with an error. (TypeError)');
  });

  it('says what a completed read kept, and that a dry run kept nothing', () => {
    expect(runEndWords(ended({ outcome: 'completed' }), true).sentence).toBe(
      'Every step passed. As a dry run, it captured and stored nothing.',
    );
    expect(
      runEndWords(
        ended({ outcome: 'completed', counts: { pages: 4, captures: 2, newDocuments: 1, deduplicated: 1, refusals: 0 } }),
        false,
      ).sentence,
    ).toBe('Every step passed. 2 captured: 1 new document, 1 already held.');
  });

  it('tells a run still going from one that never finished', () => {
    expect(runWords(run(null, { startedAt: new Date('2026-09-28T10:01:00Z') }), now, 120_000).headline).toBe(
      'Running',
    );
    expect(runWords(run(null, { startedAt: new Date('2026-09-28T09:00:00Z') }), now, 120_000).headline).toBe(
      'Did not finish',
    );
    // A cap it cannot see is the worker's ceiling, the longest a run can take.
    expect(runWords(run(null, { startedAt: new Date('2026-09-28T09:40:00Z') }), now, undefined).headline).toBe(
      'Running',
    );
  });

  it('never calls a run over while the portal job may still be waiting on it', async () => {
    const { PORTAL_READ_CONFIG } = await import('../lib/inngest-portal');
    for (const maxRunMs of [1_000, 60_000, 120_000, 600_000, 30 * 60_000, 3_600_000]) {
      const jobWaits =
        PORTAL_READ_POLL.firstWaitMs +
        portalReadPollLimit(maxRunMs) * PORTAL_READ_POLL.waitMs +
        PORTAL_READ_CONFIG.retries * PORTAL_WORKER_BUSY_RETRY_MS;
      expect(runInFlightForMs(maxRunMs), String(maxRunMs)).toBeGreaterThan(jobWaits);
    }
    expect(runInFlightForMs(undefined)).toBeGreaterThanOrEqual(runInFlightForMs(3_600_000));
  });
});

describe('the notice table', () => {
  it('says nothing for an unknown key, an inherited name, or fragments of the wrong shape or number', () => {
    expect(resolvePortalNotice('constructor')).toBeUndefined();
    expect(resolvePortalNotice('toString')).toBeUndefined();
    expect(resolvePortalNotice(undefined)).toBeUndefined();
    expect(resolvePortalNotice('portal_recipe_added')).toBeUndefined();
    expect(resolvePortalNotice('portal_recipe_added', [PORTAL_KEY, '0'])).toBeUndefined();
    expect(resolvePortalNotice('portal_recipe_refused_at', ['steps.0.fields.a b'])).toBeUndefined();
    expect(resolvePortalNotice('portal_turned_on', ['extra'])).toBeUndefined();
    expect(resolvePortalNotice('portal_dry_run_in_flight', ['2026-09-28 10:00'])?.text).toMatch(
      /started at 2026-09-28 10:00 UTC/,
    );
  });

  it('never puts a placeholder in a sentence that takes no fragment', () => {
    for (const [key, notice] of Object.entries(PORTAL_NOTICES)) {
      if (!/\{\d\}/.test(notice.text)) expect(resolvePortalNotice(key)?.text, key).toBe(notice.text);
    }
  });
});

describe('what a person typed', () => {
  it('folds a setup key as an authenticator shows it, and guesses at nothing', () => {
    expect(foldSetupKey('jbsw y3dp ehpk 3pxp')).toBe('JBSWY3DPEHPK3PXP');
    expect(foldSetupKey(' GEZD-GNBV-GY3T-QOJQ== ')).toBe('GEZDGNBVGY3TQOJQ');
    expect(foldSetupKey('GEZD GNBV 0189')).toBeUndefined();
    expect(foldSetupKey('otpauth://totp/x?secret=GEZD')).toBeUndefined();
    expect(foldSetupKey('   ')).toBeUndefined();
  });

  it('reads run parameters one per line, and refuses rather than guesses', () => {
    expect(parseRunParams(undefined)).toEqual({});
    expect(parseRunParams('\n  \n')).toEqual({});
    expect(parseRunParams(' region = EU \r\nsupplier.number=0042')).toEqual({ region: 'EU', 'supplier.number': '0042' });
    expect(parseRunParams('url=https://x.example/?a=b')).toEqual({ url: 'https://x.example/?a=b' });
    for (const bad of ['novalue', 'a=', '=b', '1a=b', '__proto__=b', 'a=1\na=2', `a=${'x'.repeat(257)}`]) {
      expect(parseRunParams(bad), bad).toBeUndefined();
    }
    expect(parseRunParams(Array.from({ length: 33 }, (_, i) => `p${i}=v`).join('\n'))).toBeUndefined();
    const parsed = parseRunParams('constructor=x') as Record<string, string>;
    expect(Object.hasOwn(parsed, 'constructor')).toBe(true);
  });

  it('finds any part of the credential in a label', () => {
    const secret = { username: 'svc-user', password: 'hunter22!', totpSecret: 'GEZDGNBVGY3TQOJQ' };
    expect(labelHoldsSecret('Svc-User on SAP', secret)).toBe(true);
    expect(labelHoldsSecret('pw hunter22!', secret)).toBe(true);
    expect(labelHoldsSecret('gezd gnbv-gy3t qojq', secret)).toBe(true);
    expect(labelHoldsSecret('wrong password, on purpose', secret)).toBe(false);
  });
});

describe('what the deployment says', () => {
  it('builds the portal key’s seal-only cipher, and refuses the QuickBooks key', () => {
    const ready = portalSealingFromEnv({ PORTAL_KMS_KEY_ID: 'arn:portal', AWS_REGION: 'us-east-1' });
    expect(ready.kind).toBe('ready');
    expect(ready.kind === 'ready' ? (ready.cipher as { mode?: string }).mode : undefined).toBe('seal_only');
    expect(portalSealingFromEnv({})).toEqual({ kind: 'not_configured', reason: 'PORTAL_KMS_KEY_ID is not set' });
    expect(portalSealingFromEnv({ PORTAL_KMS_KEY_ID: 'arn:k', QBO_TOKEN_KMS_KEY_ID: 'arn:k' })).toEqual({
      kind: 'not_configured',
      reason: 'PORTAL_KMS_KEY_ID names the same key as QBO_TOKEN_KMS_KEY_ID; a portal credential needs a key of its own',
    });
  });

  it('names what a run lacks, and never a value', () => {
    expect(portalRunsMissingFromEnv({})).toEqual([
      'PORTAL_READ_URL',
      'PORTAL_READ_TOKEN',
      'INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY',
    ]);
    expect(
      portalRunsMissingFromEnv({ PORTAL_READ_URL: 'https://w', PORTAL_READ_TOKEN: 'x'.repeat(64), INNGEST_EVENT_KEY: 'e' }),
    ).toEqual(['INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY (only one is set)']);
  });
});

describe('the review screen', () => {
  it('shows every step with what it was drafted against, the binding, and the promote form', async () => {
    harness.versions = [version()];
    const html = await versionPage(VERSION_ID);
    expect(html).toContain('opens https://service.ariba.example/sign-in');
    expect(html).toContain('expects #anid-badge; the run stops if it is not there');
    expect(html).toContain('types a code made from the sealed setup key');
    expect(html).toContain('https://accounts.sap.example');
    expect(html).toContain(bindingOf(version().recipe).hostsHash);
    expect(html).toContain('walk-through of 2026-09-28');
    expect(html).toContain('ADR 0062');
    expect(html).toContain('action="/settings/portals/review"');
    expect(html).toContain('name="comparedWith" value="none"');
    expect(html).toContain('>Promote version 1<');
    expect(html).toContain('no promoted version: it is this portal’s first, so everything counts');
  });

  it('names the promoted version it is counted against, and offers only rejection for an agent draft that adds', async () => {
    const first = version({ review: PROMOTED });
    const draft = version({ recipeVersionId: VERSION_2_ID, version: 2, agentSessionId: 'session-1' }, {
      version: 2,
      hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'cdn.example'],
      provenance: { draftedBy: { kind: 'agent_session', id: 'session-1' }, source: 'agent session step log', portalAdr: '0062' },
    });
    harness.versions = [draft, first];
    harness.preview = { comparedWithVersionId: VERSION_ID, additions: [{ kind: 'host', host: 'cdn.example' }] };
    const html = await versionPage(VERSION_2_ID);
    expect(html).toContain(`name="comparedWith" value="${VERSION_ID}"`);
    expect(html).toContain('version 1, the promoted version in effect now');
    expect(html).toContain('a host: cdn.example');
    expect(html).toContain('cdn.example (added)');
    expect(html).not.toContain('>Promote version 2<');
    expect(html).toContain('>Reject it<');
  });

  it('shows a reviewed version without a form, and warns of a host reserved never to resolve', async () => {
    harness.versions = [version({ review: PROMOTED }, { hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'placeholder.invalid'] })];
    const html = await versionPage(VERSION_ID);
    expect(html).toContain('Promoted by owner@example.test on 2026-09-28');
    expect(html).not.toContain('action="/settings/portals/review"');
    expect(html).toContain('placeholder.invalid ends in .invalid');
  });

  it('shows no form to a writer who is not an owner, and nothing to a read_only member', async () => {
    harness.versions = [version()];
    harness.role = 'analyst';
    expect(await versionPage(VERSION_ID)).not.toContain('action="/settings/portals/review"');
    harness.role = 'read_only';
    harness.calls = [];
    const hidden = await versionPage(VERSION_ID);
    expect(hidden).toContain('Recipe versions are shown to members who can add documents.');
    expect(hidden).not.toContain('service.ariba.example');
    expect(harness.calls).toEqual([]);
  });

  it('is a 404 for an id that is not one, or a version this tenant cannot see', async () => {
    await expect(versionPage('not-a-uuid')).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    harness.versions = [];
    await expect(versionPage(VERSION_ID)).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
});
