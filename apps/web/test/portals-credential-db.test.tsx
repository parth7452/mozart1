import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import { parseRecipe, portalCredentialContext, type PortalBinding } from '@recouple/portal';
import { closeAllPools, PostgresPortalStore } from '@recouple/store-postgres';
import { resolvePortalNotice } from '../lib/portals';

/**
 * Entering a portal credential, end to end on a real database (ADR 0057 §7):
 * the route as an owner posts it, `PostgresPortalStore` seals it with the
 * app's seal-only cipher to the binding of the version the database holds,
 * and migration 0038's tables keep it.
 *
 * KMS is stood in for by `LocalTokenCipher`, which does real envelope
 * encryption, built exactly as the route builds its cipher — `forKey` with the
 * portal key and `seal_only` — so the one fake here is who holds the root key.
 * What is proved is what the unit tests can only spy on: that no username,
 * password or setup key reaches any column but the ciphertext, any audit
 * payload, any log line or the redirect; that the worker's open-only cipher
 * opens exactly the folded payload under the binding stored beside it; and
 * that a deployment with no portal key stores nothing at all.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const harness = vi.hoisted(() => ({
  orgId: '',
  userId: '',
  role: 'owner',
  /** What `KmsTokenCipher.forKey` was asked for. */
  forKey: [] as { keyId: string; options: unknown }[],
  /** One root key for the app's cipher and the worker's, as KMS would hold one key. */
  rootKey: new Uint8Array(32).map((_, i) => (i * 37 + 11) % 256),
}));

vi.mock('../lib/env', () => ({
  env: {
    get databaseUrl(): string {
      return process.env.TEST_DATABASE_URL as string;
    },
  },
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: harness.userId,
    email: 'portal-owner@example.test',
    org: { orgId: harness.orgId, slug: 'portal-db', name: 'Portal DB', role: harness.role },
    orgs: [],
  }),
}));

vi.mock('@recouple/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/crypto')>();
  const { LocalTokenCipher: Local } = await import('@recouple/crypto/testing');
  return {
    ...actual,
    KmsTokenCipher: {
      forKey: (keyId: string, options: { mode?: 'seal_and_open' | 'seal_only' | 'open_only' }) => {
        harness.forKey.push({ keyId, options });
        return new Local({ rootKey: Buffer.from(harness.rootKey), keyId: 'local-portal-key', ...(options.mode === undefined ? {} : { mode: options.mode }) });
      },
    },
  };
});

const { POST: enterCredential } = await import('../app/settings/portals/credential/route');

const USERNAME = `svc-user-${randomUUID().slice(0, 8)}-DO-NOT-LOG`;
const PASSWORD = `pw-${randomUUID()}-DO-NOT-LOG`;
const TYPED_KEY = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq';
const FOLDED_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SECRETS = [USERNAME, PASSWORD, TYPED_KEY, FOLDED_KEY, 'DO-NOT-LOG'];

function recipeJson(portalKey: string): Record<string, unknown> {
  return {
    portalKey,
    version: 1,
    effectiveFrom: '2026-01-01',
    hostAllowlist: ['service.ariba.example', 'accounts.sap.example'],
    signIn: { origin: 'https://accounts.sap.example', formPaths: ['/sign-in'], mfaPaths: ['/mfa'], acsPaths: [] },
    neverClick: [],
    postAsRead: [],
    caps: { maxPages: 5, maxDownloads: 0, maxRunMs: 120_000 },
    provenance: { draftedBy: { kind: 'person', id: 'founder' }, source: 'walk-through', portalAdr: '0062' },
    steps: [
      { kind: 'open', name: 'start', url: 'https://service.ariba.example/sign-in' },
      { kind: 'sign_in' },
      { kind: 'answer_mfa' },
      { kind: 'sign_out' },
    ],
  };
}

describeDb('entering a portal credential on Postgres (ADR 0057 §7, migration 0038)', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const portalKey = `portal_db_${suffix}`;
  let connectionId = '';
  let versionId = '';

  const logged: string[] = [];
  const locations: string[] = [];

  async function enter(fields: Record<string, string>) {
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.set(name, value);
    const response = await enterCredential(
      new NextRequest('https://app.example.test/settings/portals/credential', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
        body,
      }),
    );
    const location = response.headers.get('location') ?? '';
    locations.push(location);
    const at = new URL(location);
    return resolvePortalNotice(at.searchParams.get('portal') ?? undefined, at.searchParams.getAll('about'))?.text;
  }

  const credentialRows = async () =>
    (
      await admin.query<Record<string, unknown>>(
        `select * from portal_credentials where connection_id = $1 order by seq`,
        [connectionId],
      )
    ).rows;

  beforeAll(async () => {
    harness.orgId = orgId;
    harness.userId = ownerId;
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    await admin.query(`insert into organizations (id, slug, name) values ($1, $2, 'Portal DB')`, [
      orgId,
      `portal-db-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1, $2)`, [
      ownerId,
      `portal-db-owner-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [
      orgId,
      ownerId,
    ]);

    const store = new PostgresPortalStore({ connectionString: connectionString as string }, { orgId, userId: ownerId });
    connectionId = await store.createConnection({
      portalKey,
      label: 'plumbing test',
      accountId: `AN${suffix}-T`,
      params: {},
    });
    versionId = await store.addRecipeVersion({ recipe: parseRecipe(recipeJson(portalKey)) });
    await store.reviewRecipeVersion({ recipeVersionId: versionId, verdict: 'promoted' });
  });

  beforeEach(() => {
    process.env.PORTAL_KMS_KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/portal-test';
    process.env.AWS_REGION = 'us-east-1';
    delete process.env.QBO_TOKEN_KMS_KEY_ID;
    harness.role = 'owner';
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env.PORTAL_KMS_KEY_ID;
    // Nothing is deleted: the portal tables are append-only. The database is a throwaway.
    await closeAllPools();
    await admin.end();
  });

  it('stores nothing on a deployment with no portal key', async () => {
    delete process.env.PORTAL_KMS_KEY_ID;
    const said = await enter({
      connectionId,
      recipeVersionId: versionId,
      username: USERNAME,
      password: PASSWORD,
      totpSecret: TYPED_KEY,
    });
    expect(said).toBe('credentials cannot be sealed on this deployment, so nothing was stored');
    expect(await credentialRows()).toEqual([]);
    expect(harness.forKey).toEqual([]);
  });

  it('seals with the portal key’s seal-only cipher, and only the ciphertext holds the credential', async () => {
    const said = await enter({
      connectionId,
      recipeVersionId: versionId,
      username: USERNAME,
      password: PASSWORD,
      totpSecret: TYPED_KEY,
      label: 'the service user',
    });
    expect(said).toMatch(/^the credential is sealed and stored/);
    expect(harness.forKey).toEqual([
      {
        keyId: 'arn:aws:kms:us-east-1:111122223333:key/portal-test',
        options: { mode: 'seal_only', region: 'us-east-1' },
      },
    ]);

    const rows = await credentialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.created_by).toBe(ownerId);
    expect(row.label).toBe('the service user');
    expect(row.cipher).toBe('local-aes-256-gcm');
    expect(row.key_id).toBe('local-portal-key');
    const stored = JSON.stringify(row);
    for (const secret of SECRETS) expect(stored).not.toContain(secret);

    // The worker's cipher, which may only open, opens it under the binding
    // stored beside it — and finds the setup key folded as the page promised.
    const binding: PortalBinding = {
      signInOrigin: row.sign_in_origin as string,
      signInPaths: row.sign_in_paths as string[],
      hostsHash: row.hosts_hash as string,
    };
    expect(binding.signInOrigin).toBe('https://accounts.sap.example');
    const worker = new LocalTokenCipher({ rootKey: Buffer.from(harness.rootKey), keyId: 'local-portal-key', mode: 'open_only' });
    const opened = await worker.decrypt(
      {
        cipher: row.cipher as string,
        keyId: row.key_id as string,
        wrappedKey: row.wrapped_key as string,
        ciphertext: row.ciphertext as string,
      },
      portalCredentialContext({ orgId, connectionId }, binding),
    );
    expect(JSON.parse(opened)).toEqual({ username: USERNAME, password: PASSWORD, totpSecret: FOLDED_KEY });
  });

  it('writes an audit row of ids only', async () => {
    const { rows } = await admin.query<{ action: string; actor_id: string; payload: Record<string, unknown> }>(
      `select action, actor_id, payload from audit_log where org_id = $1 order by id`,
      [orgId],
    );
    const stored = rows.find((row) => row.action === 'portal_credential.stored');
    expect(stored?.actor_id).toBe(ownerId);
    expect(Object.keys(stored?.payload ?? {}).sort()).toEqual(['credential_id', 'recipe_version_id']);
    expect(stored?.payload.recipe_version_id).toBe(versionId);
    const every = JSON.stringify(rows);
    for (const secret of SECRETS) expect(every).not.toContain(secret);
  });

  it('refuses a label that holds the username, and stores nothing more', async () => {
    const before = (await credentialRows()).length;
    const said = await enter({
      connectionId,
      recipeVersionId: versionId,
      username: USERNAME,
      password: PASSWORD,
      label: `for ${USERNAME.toLowerCase()}`,
    });
    expect(said).toMatch(/may not contain the username, the password or the setup key/);
    expect((await credentialRows()).length).toBe(before);
  });

  it('refuses a member the database says is no owner, even when the page thought so', async () => {
    const analystId = randomUUID();
    await admin.query(`insert into users (id, email) values ($1, $2)`, [
      analystId,
      `portal-db-analyst-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'analyst')`, [
      orgId,
      analystId,
    ]);
    const before = (await credentialRows()).length;
    // The session says owner; the database knows better.
    harness.userId = analystId;
    try {
      const said = await enter({
        connectionId,
        recipeVersionId: versionId,
        username: USERNAME,
        password: PASSWORD,
      });
      expect(said).toMatch(/^only an owner can/);
    } finally {
      harness.userId = ownerId;
    }
    expect((await credentialRows()).length).toBe(before);
  });

  it('replaces a credential with a new row, never an edit', async () => {
    const before = await credentialRows();
    const said = await enter({
      connectionId,
      recipeVersionId: versionId,
      username: USERNAME,
      password: `${PASSWORD}-again`,
    });
    expect(said).toMatch(/^the credential is sealed and stored/);
    const after = await credentialRows();
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('left no credential in any log line or redirect', () => {
    const readable = [logged.join('\n'), locations.join('\n')].join('\n');
    for (const secret of SECRETS) expect(readable).not.toContain(secret);
    expect(logged.join('\n')).toContain(`portal credential stored: credential `);
  });
});
