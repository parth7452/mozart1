import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  TokenDecryptionError,
  type SealedToken,
  type TokenCipher,
  type TokenEncryptionContext,
} from '@recouple/crypto';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import {
  PORTAL_AUDIT_ACTIONS,
  PortalBindingError,
  RecipeRefusedError,
  bindingOf,
  parseRecipe,
  portalCredentialContext,
  type PortalCredentialPayload,
  type RecipeVersion,
} from '@recouple/portal';
import {
  PortalAccountAlreadyConnectedError,
  PortalAccountConnectedElsewhereError,
  PortalActorMismatchError,
  PortalAgentDraftAdditionsError,
  PortalConnectionNotFoundError,
  PortalCredentialLabelError,
  PortalCredentialNotFoundError,
  PortalCredentialReplacementRequiredError,
  PortalInputError,
  PortalOwnerRequiredError,
  PortalRecipeAlreadyReviewedError,
  PortalRecipeProvenanceError,
  PortalRecipeVersionExistsError,
  PortalRecipeVersionNotFoundError,
  PortalRecipeVersionPortalMismatchError,
  PortalRunRecordRefusedError,
  PortalSealingNotConfiguredError,
  PortalStoreError,
  PortalWriteRefusedError,
  PortalWriterRequiredError,
  PostgresPortalStore,
  listPortalConnectionsToRead,
  recipeAdditions,
} from '../src/portal';
import { closeAllPools } from '../src/store';

/**
 * `PostgresPortalStore` against a real database carrying migration 0038 (ADR
 * 0057 §6, §7, §13, §15; ADR 0062).
 *
 * Suite 34 asks the schema its questions in SQL. This asks the ones only the
 * store's whole path answers: that a credential is sealed to the binding of
 * the version the database holds, before anything is written, and opens for
 * the worker under exactly that binding; that a KMS failure writes nothing;
 * that every refusal is named and costs nothing; that the run rows go through
 * their definer functions, replay without a second row and survive a member
 * who may no longer write; that a refused credential turns a connection off
 * and a credential entered at the same moment is never undone; that a refused
 * or removed credential holds a connection off until a newer one is stored,
 * even when it meets a connection already off and whatever is written after
 * it; and that no
 * username, password or TOTP secret reaches an error, a log line, an audit
 * payload or any column but the ciphertext.
 */

const ORIGIN = 'https://service.ariba.example';

function recipeJson(
  portalKey: string,
  version: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    portalKey,
    version,
    effectiveFrom: '2026-01-01',
    hostAllowlist: ['service.ariba.example', 'accounts.sap.example'],
    signIn: {
      origin: ORIGIN,
      formPaths: ['/sign-in'],
      mfaPaths: ['/mfa'],
      acsPaths: ['/saml2/acs'],
    },
    neverClick: ['create invoice'],
    postAsRead: [
      {
        step: 'landing',
        path: '/api/graphql',
        bodyDiscriminator: { field: 'operationName', equals: 'Dashboard' },
      },
    ],
    caps: { maxPages: 5, maxDownloads: 0, maxRunMs: 120_000 },
    provenance: {
      draftedBy: { kind: 'person', id: 'founder' },
      source: 'walk-through 2026-09-27',
      portalAdr: '0062',
    },
    steps: [
      { kind: 'open', name: 'start', url: `${ORIGIN}/sign-in` },
      { kind: 'sign_in' },
      { kind: 'answer_mfa' },
      { kind: 'expect', name: 'anid', text: 'AN01' },
      { kind: 'capture_page', name: 'landing' },
      { kind: 'sign_out' },
    ],
    ...over,
  };
}

function recipe(
  portalKey: string,
  version: number,
  over: Record<string, unknown> = {},
): RecipeVersion {
  return parseRecipe(recipeJson(portalKey, version, over));
}

const AGENT_DRAFT = {
  provenance: {
    draftedBy: { kind: 'agent_session', id: 'session-1' },
    source: 'agent session step log',
    portalAdr: '0062',
  },
};

describe('what a recipe version adds (ADR 0057 §3)', () => {
  const key = 'additions_portal';

  it('counts every host and POST-as-read entry of a portal’s first version, hosts once, lower-case', () => {
    const first = recipe(key, 1, {
      hostAllowlist: ['service.ariba.example', 'ACCOUNTS.sap.example', 'accounts.sap.example'],
    });
    expect(recipeAdditions(first, undefined)).toEqual([
      { kind: 'host', host: 'service.ariba.example' },
      { kind: 'host', host: 'accounts.sap.example' },
      {
        kind: 'post_as_read',
        step: 'landing',
        path: '/api/graphql',
        bodyDiscriminator: { field: 'operationName', equals: 'Dashboard' },
      },
    ]);
  });

  it('counts nothing a promoted version already has, whatever the order or case of its hosts', () => {
    const promoted = recipe(key, 1);
    const same = recipe(key, 2, {
      hostAllowlist: ['Accounts.SAP.example', 'service.ariba.example'],
    });
    expect(recipeAdditions(same, promoted)).toEqual([]);
  });

  it('counts a new host, and a POST-as-read entry that differs only in its body discriminator', () => {
    const promoted = recipe(key, 1);
    const next = recipe(key, 2, {
      hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'cdn.ariba.example'],
      postAsRead: [
        {
          step: 'landing',
          path: '/api/graphql',
          bodyDiscriminator: { field: 'operationName', equals: 'Dashboard' },
        },
        {
          step: 'landing',
          path: '/api/graphql',
          bodyDiscriminator: { field: 'operationName', equals: 'Invoices' },
        },
        { step: 'landing', path: '/api/search' },
      ],
    });
    expect(recipeAdditions(next, promoted)).toEqual([
      { kind: 'host', host: 'cdn.ariba.example' },
      {
        kind: 'post_as_read',
        step: 'landing',
        path: '/api/graphql',
        bodyDiscriminator: { field: 'operationName', equals: 'Invoices' },
      },
      { kind: 'post_as_read', step: 'landing', path: '/api/search', bodyDiscriminator: null },
    ]);
  });

  it('counts a floor-listed dismiss, inside for_each too, unless the promoted one carries it exactly', () => {
    // parseRecipe refuses a floor-listed dismiss today, so these are built by
    // hand: the count must not depend on that refusal staying where it is.
    const base = recipe(key, 1);
    const cookie = {
      kind: 'dismiss',
      name: 'cookies',
      selector: '#cookie',
      label: 'Accept',
      containerText: 'We use cookies.',
    } as const;
    const close = {
      kind: 'dismiss',
      name: 'banner',
      selector: '#banner',
      label: 'Close',
      containerText: 'News',
    } as const;
    const withCookie = (containerText: string): RecipeVersion => ({
      ...base,
      steps: [
        ...base.steps,
        {
          kind: 'for_each',
          name: 'rows',
          rowSelector: 'tr',
          maxRows: 3,
          steps: [{ ...cookie, containerText }, close],
        },
      ],
    });

    expect(recipeAdditions(withCookie('We use cookies.'), base)).toEqual([
      { kind: 'dismiss', step: 'cookies', label: 'Accept' },
    ]);
    expect(recipeAdditions(withCookie('We use cookies.'), withCookie('We use cookies.'))).toEqual(
      [],
    );
    expect(
      recipeAdditions(withCookie('We use cookies and trackers.'), withCookie('We use cookies.')),
    ).toEqual([{ kind: 'dismiss', step: 'cookies', label: 'Accept' }]);
  });
});

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('the portal store on Postgres (ADR 0057, migration 0038)', () => {
  const admin = new Pool({ connectionString });
  const config = { connectionString: connectionString as string };

  const orgA = randomUUID();
  const orgB = randomUUID();
  const ownerA = randomUUID();
  const ownerA2 = randomUUID();
  const analystA = randomUUID();
  const readerA = randomUUID();
  const ownerB = randomUUID();
  const suffix = orgA.slice(0, 8);

  // Every secret-shaped value carries a marker, so a leak is a substring search.
  const USERNAME = `portal-user-${suffix}-DO-NOT-LOG`;
  const PASSWORD = `pw-${suffix}-DO-NOT-LOG`;
  const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXQ';
  const SECRETS = [USERNAME, PASSWORD, TOTP, 'DO-NOT-LOG'];
  const payload: PortalCredentialPayload = {
    username: USERNAME,
    password: PASSWORD,
    totpSecret: TOTP,
  };

  // The app's cipher seals and cannot open; the worker's opens and cannot seal.
  const rootKey = randomBytes(32);
  const appCipher = new LocalTokenCipher({ rootKey, keyId: 'local-portal-key', mode: 'seal_only' });
  const workerCipher = new LocalTokenCipher({
    rootKey,
    keyId: 'local-portal-key',
    mode: 'open_only',
  });

  /** A cipher that counts, and refuses to open: the app never opens a portal credential. */
  class WatchedCipher implements TokenCipher {
    readonly name = 'watched';
    encrypts = 0;
    decrypts = 0;
    constructor(private readonly failure?: Error) {}
    async encrypt(plaintext: string, context: TokenEncryptionContext): Promise<SealedToken> {
      this.encrypts += 1;
      if (this.failure !== undefined) throw this.failure;
      return appCipher.encrypt(plaintext, context);
    }
    async decrypt(): Promise<string> {
      this.decrypts += 1;
      throw new Error('the app never opens a portal credential');
    }
  }

  const store = (orgId: string, userId: string, cipher?: TokenCipher) =>
    new PostgresPortalStore(config, { orgId, userId }, cipher === undefined ? {} : { cipher });
  const a = (cipher?: TokenCipher) => store(orgA, ownerA, cipher);

  let keys = 0;
  /** A portal key of its own per test, so version numbers and promotions never meet. */
  const portalKey = (name: string): string => `${name}_${suffix}_${(keys += 1)}`;
  let accounts = 0;
  const base = String(Date.now());
  const accountId = (): string => `AN-${base}-${(accounts += 1)}`;

  const caught: unknown[] = [];
  /** Awaits a call that must be refused, and keeps the error for the leak sweep. */
  async function refusal(work: Promise<unknown>): Promise<unknown> {
    try {
      await work;
    } catch (error) {
      caught.push(error);
      return error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  const logged: unknown[][] = [];

  async function connect(
    key: string,
    as = ownerA,
    orgId = orgA,
    account = accountId(),
  ): Promise<string> {
    return store(orgId, as).createConnection({
      portalKey: key,
      label: 'Ariba test account',
      accountId: account,
      params: {},
    });
  }

  async function addVersion(
    key: string,
    version: number,
    over: Record<string, unknown> = {},
    options: {
      readonly as?: string;
      readonly orgId?: string;
      readonly agentSessionId?: string;
    } = {},
  ): Promise<string> {
    return store(options.orgId ?? orgA, options.as ?? ownerA).addRecipeVersion({
      recipe: recipe(key, version, over),
      ...(options.agentSessionId !== undefined ? { agentSessionId: options.agentSessionId } : {}),
    });
  }

  async function promote(recipeVersionId: string, orgId = orgA, as = ownerA): Promise<string> {
    return store(orgId, as).reviewRecipeVersion({ recipeVersionId, verdict: 'promoted' });
  }

  /** A connection with a promoted version of its own portal, ready for a credential or a run. */
  async function readyConnection(
    name: string,
  ): Promise<{ key: string; connectionId: string; versionId: string }> {
    const key = portalKey(name);
    const connectionId = await connect(key);
    const versionId = await addVersion(key, 1);
    await promote(versionId);
    return { key, connectionId, versionId };
  }

  async function auditFor(subjectId: string) {
    const { rows } = await admin.query<{
      action: string;
      actor_id: string;
      subject_table: string;
      payload: Record<string, unknown>;
    }>(
      `select action, actor_id, subject_table, payload from audit_log where subject_id = $1 order by id`,
      [subjectId],
    );
    return rows;
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(sql, params);
    return rows[0]?.n ?? -1;
  }

  async function enabled(connectionId: string): Promise<boolean | undefined> {
    const { rows } = await admin.query<{ enabled: boolean }>(
      `select enabled from portal_connections where id = $1`,
      [connectionId],
    );
    return rows[0]?.enabled;
  }

  beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[method].bind(console);
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
        original(...args);
      });
    }

    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Portal A'), ($3,$4,'Portal B')`,
      [orgA, `portal-a-${suffix}`, orgB, `portal-b-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgA, orgB]);
    await admin.query(
      `insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6), ($7,$8), ($9,$10)`,
      [
        ownerA,
        `portal-owner-a-${suffix}@example.test`,
        ownerA2,
        `portal-owner-a2-${suffix}@example.test`,
        analystA,
        `portal-analyst-a-${suffix}@example.test`,
        readerA,
        `portal-reader-a-${suffix}@example.test`,
        ownerB,
        `portal-owner-b-${suffix}@example.test`,
      ],
    );
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'owner'), ($1,$3,'owner'), ($1,$4,'analyst'), ($1,$5,'read_only'), ($6,$7,'owner')`,
      [orgA, ownerA, ownerA2, analystA, readerA, orgB, ownerB],
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // Nothing is deleted: the portal tables are append-only and their triggers
    // refuse the owner too. The database is a throwaway.
    await closeAllPools();
    await admin.end();
  });

  // -------------------------------------------------------------------------
  // Who may
  // -------------------------------------------------------------------------

  it('answers whether its own member may write, and refuses to answer for anyone else', async () => {
    expect(await store(orgA, ownerA).memberMayWrite({ orgId: orgA, userId: ownerA })).toBe(true);
    expect(await store(orgA, analystA).memberMayWrite({ orgId: orgA, userId: analystA })).toBe(
      true,
    );
    expect(await store(orgA, readerA).memberMayWrite({ orgId: orgA, userId: readerA })).toBe(false);
    expect(
      await refusal(store(orgA, ownerA).memberMayWrite({ orgId: orgA, userId: analystA })),
    ).toBeInstanceOf(PortalActorMismatchError);
  });

  it('answers whether its own member is an owner, which a run’s disable will need', async () => {
    expect(await store(orgA, ownerA).memberIsOwner({ orgId: orgA, userId: ownerA })).toBe(true);
    expect(await store(orgA, analystA).memberIsOwner({ orgId: orgA, userId: analystA })).toBe(
      false,
    );
    expect(await store(orgA, readerA).memberIsOwner({ orgId: orgA, userId: readerA })).toBe(false);
    expect(
      await refusal(store(orgA, ownerA).memberIsOwner({ orgId: orgB, userId: ownerA })),
    ).toBeInstanceOf(PortalActorMismatchError);
  });

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  it('connects an account as an owner: enabled, acting as them, audited in ids and codes', async () => {
    const key = portalKey('connect');
    const account = accountId();
    const first = await store(orgA, ownerA).createConnection({
      portalKey: key,
      label: 'Ariba (test account)',
      accountId: account,
      params: { region: 'us', 'supplier.number': '42' },
    });
    const second = await connect(key);

    expect(await a().connection(first)).toMatchObject({
      connectionId: first,
      orgId: orgA,
      portalKey: key,
      label: 'Ariba (test account)',
      accountId: account,
      params: { region: 'us', 'supplier.number': '42' },
      enabled: true,
      createdBy: ownerA,
    });
    const listed = (await a().listConnections()).map((c) => c.connectionId);
    expect(listed.indexOf(second)).toBeLessThan(listed.indexOf(first));
    expect(await auditFor(first)).toEqual([
      {
        action: PORTAL_AUDIT_ACTIONS.connectionCreated,
        actor_id: ownerA,
        subject_table: 'portal_connections',
        payload: { portal_key: key },
      },
    ]);
  });

  it('refuses a member who is not an owner, by name, and writes nothing', async () => {
    const key = portalKey('not_owner');
    for (const member of [analystA, readerA]) {
      expect(await refusal(connect(key, member))).toBeInstanceOf(PortalOwnerRequiredError);
    }
    expect(
      await count(`select count(*)::int as n from portal_connections where portal_key = $1`, [key]),
    ).toBe(0);
  });

  it('holds one enabled connection per account: here by name, elsewhere without saying where', async () => {
    const key = portalKey('one_per_account');
    const account = `AN0123-4567-${base}`;
    const held = await connect(key, ownerA, orgA, account);

    const here = await refusal(connect(key, ownerA, orgA, ` an 0123 4567 ${base}`.trim()));
    expect(here).toBeInstanceOf(PortalAccountAlreadyConnectedError);
    expect((here as PortalAccountAlreadyConnectedError).connectionId).toBe(held);

    const elsewhere = await refusal(connect(key, ownerB, orgB, `an01234567${base}`));
    expect(elsewhere).toBeInstanceOf(PortalAccountConnectedElsewhereError);
    expect((elsewhere as Error).message).not.toContain(held);
    expect((elsewhere as Error).message).not.toContain(orgA);

    // Turned off, the account is free for another workspace.
    expect(await a().disableConnection({ connectionId: held, reason: 'turned_off' })).toBe(
      'disabled',
    );
    const moved = await connect(key, ownerB, orgB, `an01234567${base}`);
    expect(await store(orgB, ownerB).connection(moved)).toMatchObject({
      enabled: true,
      createdBy: ownerB,
    });

    // And turning the first back on is refused while the other holds it.
    expect(await refusal(a().enableConnection(held))).toBeInstanceOf(
      PortalAccountConnectedElsewhereError,
    );
    expect(await enabled(held)).toBe(false);
  });

  it('refuses a connection the contract refuses by field and rule, never by value', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ label: ' Leading-space-label' }, 'label'],
      [{ portalKey: 'SAP-Network' }, 'portalKey'],
      [{ accountId: '--- / ---' }, 'accountId'],
      [
        { params: JSON.parse('{"__proto__": "polluted-value"}') as Record<string, string> },
        'params',
      ],
      [{ params: { '1st': 'x' } }, 'params.1st'],
    ];
    for (const [over, field] of cases) {
      const error = await refusal(
        a().createConnection({
          portalKey: portalKey('input'),
          label: 'A label',
          accountId: accountId(),
          params: {},
          ...over,
        } as never),
      );
      expect(error).toBeInstanceOf(PortalInputError);
      expect((error as PortalInputError).issues.some((i) => i.field.startsWith(field))).toBe(true);
      expect((error as Error).message).not.toMatch(
        /Leading-space-label|SAP-Network|polluted-value/,
      );
    }
    expect(await refusal(a().connection('not-a-uuid'))).toBeInstanceOf(PortalInputError);
  });

  it('does not find another tenant’s connection: RLS, not a filter', async () => {
    const connectionId = await connect(portalKey('rls'));
    const b = store(orgB, ownerB);
    expect(await b.connection(connectionId)).toBeUndefined();
    expect((await b.listConnections()).map((c) => c.connectionId)).not.toContain(connectionId);
    expect(await b.disableConnection({ connectionId, reason: 'turned_off' })).toBeUndefined();
    expect(await b.enableConnection(connectionId)).toBeUndefined();
    expect(await b.latestCredential(connectionId)).toBeUndefined();
    expect(await b.listRuns(connectionId)).toEqual([]);
    expect(await b.promotedRecipe(connectionId)).toBeUndefined();
    expect(await enabled(connectionId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Recipe versions and reviews
  // -------------------------------------------------------------------------

  it('stores a writer’s version as the recipe itself, read back through parseRecipe', async () => {
    const key = portalKey('version');
    const id = await addVersion(key, 1, {}, { as: analystA });
    const record = await a().recipeVersion(id);
    expect(record).toMatchObject({
      recipeVersionId: id,
      orgId: orgA,
      portalKey: key,
      version: 1,
      effectiveFrom: '2026-01-01',
      createdBy: analystA,
      agentSessionId: null,
      review: null,
    });
    expect(record?.recipe).toEqual(recipe(key, 1));
    expect(await auditFor(id)).toEqual([
      {
        action: PORTAL_AUDIT_ACTIONS.recipeVersionAdded,
        actor_id: analystA,
        subject_table: 'portal_recipe_versions',
        payload: { portal_key: key, version: 1, drafted_by: 'person' },
      },
    ]);
    expect(await store(orgB, ownerB).recipeVersion(id)).toBeUndefined();
  });

  it('refuses a version by name: read_only, unparseable, unbindable, bad key, number taken', async () => {
    const key = portalKey('version_refusals');
    expect(await refusal(addVersion(key, 1, {}, { as: readerA }))).toBeInstanceOf(
      PortalWriterRequiredError,
    );
    expect(
      await refusal(
        a().addRecipeVersion({ recipe: { ...recipe(key, 1), steps: [] } as RecipeVersion }),
      ),
    ).toBeInstanceOf(RecipeRefusedError);
    const tooManyPaths = Array.from(
      { length: 65 },
      (_, i) => `/sign-in/${String(i).padStart(2, '0')}`,
    );
    expect(
      await refusal(
        addVersion(key, 1, {
          signIn: { origin: ORIGIN, formPaths: tooManyPaths, mfaPaths: [], acsPaths: [] },
        }),
      ),
    ).toBeInstanceOf(PortalBindingError);
    expect(await refusal(addVersion('Not_A_Key', 1))).toBeInstanceOf(PortalInputError);
    // A date zod takes and Postgres does not: the driver's message quotes the
    // value, so the refusal keeps the SQLSTATE and nothing it said.
    const yearZero = await refusal(addVersion(key, 1, { effectiveFrom: '0000-01-01' }));
    expect(yearZero).toBeInstanceOf(PortalWriteRefusedError);
    expect(yearZero).toMatchObject({ table: 'portal_recipe_versions', refusal: undefined });
    expect((yearZero as PortalWriteRefusedError).sqlState).toMatch(/^22/);
    expect((yearZero as Error).message).not.toContain('0000-01-01');
    expect(
      await count(`select count(*)::int as n from portal_recipe_versions where portal_key = $1`, [
        key,
      ]),
    ).toBe(0);

    await addVersion(key, 1);
    const taken = await refusal(addVersion(key, 1, { effectiveFrom: '2026-02-01' }));
    expect(taken).toBeInstanceOf(PortalRecipeVersionExistsError);
    expect(taken).toMatchObject({ portalKey: key, version: 1 });
  });

  it('takes an agent draft only from an owner, under the session its recipe names', async () => {
    const key = portalKey('agent_draft');
    expect(
      await refusal(addVersion(key, 1, AGENT_DRAFT, { as: analystA, agentSessionId: 'session-1' })),
    ).toBeInstanceOf(PortalOwnerRequiredError);
    expect(await refusal(addVersion(key, 1, AGENT_DRAFT))).toBeInstanceOf(
      PortalRecipeProvenanceError,
    );
    expect(
      await refusal(addVersion(key, 1, AGENT_DRAFT, { agentSessionId: 'session-2' })),
    ).toBeInstanceOf(PortalRecipeProvenanceError);
    expect(await refusal(addVersion(key, 1, {}, { agentSessionId: 'session-1' }))).toBeInstanceOf(
      PortalRecipeProvenanceError,
    );

    const id = await addVersion(key, 1, AGENT_DRAFT, { agentSessionId: 'session-1' });
    expect(await a().recipeVersion(id)).toMatchObject({
      agentSessionId: 'session-1',
      createdBy: ownerA,
    });
  });

  it('promotes a portal’s first version as an owner, naming everything it adds, once', async () => {
    const key = portalKey('first_review');
    const id = await addVersion(key, 1);
    expect(await refusal(promote(id, orgA, analystA))).toBeInstanceOf(PortalOwnerRequiredError);

    const reviewId = await promote(id);
    const record = await a().recipeVersion(id);
    expect(record?.review).toMatchObject({
      reviewId,
      verdict: 'promoted',
      reviewer: ownerA,
      comparedWithVersionId: null,
      additions: recipeAdditions(recipe(key, 1), undefined),
    });
    expect(record?.review?.additions).toHaveLength(3);
    expect((await auditFor(id)).at(-1)).toEqual({
      action: PORTAL_AUDIT_ACTIONS.recipeVersionReviewed,
      actor_id: ownerA,
      subject_table: 'portal_recipe_versions',
      payload: {
        review_id: reviewId,
        verdict: 'promoted',
        compared_with_version_id: null,
        addition_count: 3,
      },
    });

    expect(
      await refusal(a().reviewRecipeVersion({ recipeVersionId: id, verdict: 'rejected' })),
    ).toBeInstanceOf(PortalRecipeAlreadyReviewedError);
    expect(await refusal(promote(id, orgB, ownerB))).toBeInstanceOf(
      PortalRecipeVersionNotFoundError,
    );
  });

  it('never promotes an agent draft that adds a host; rejects it; promotes one that adds nothing', async () => {
    const key = portalKey('agent_review');
    const first = await addVersion(key, 1);
    await promote(first);

    const extraHost = {
      ...AGENT_DRAFT,
      hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'cdn.ariba.example'],
    };
    const adds = await addVersion(key, 2, extraHost, { agentSessionId: 'session-1' });
    expect(await a().reviewPreview(adds)).toEqual({
      comparedWithVersionId: first,
      additions: [{ kind: 'host', host: 'cdn.ariba.example' }],
    });
    const refused = await refusal(promote(adds));
    expect(refused).toBeInstanceOf(PortalAgentDraftAdditionsError);
    expect(refused).toMatchObject({ recipeVersionId: adds, additionCount: 1 });
    expect(
      await count(
        `select count(*)::int as n from portal_recipe_reviews where recipe_version_id = $1`,
        [adds],
      ),
    ).toBe(0);

    await a().reviewRecipeVersion({ recipeVersionId: adds, verdict: 'rejected' });
    expect((await a().recipeVersion(adds))?.review).toMatchObject({
      verdict: 'rejected',
      comparedWithVersionId: first,
      additions: [{ kind: 'host', host: 'cdn.ariba.example' }],
    });

    const nothingNew = await addVersion(key, 3, AGENT_DRAFT, { agentSessionId: 'session-1' });
    await promote(nothingNew);
    expect((await a().recipeVersion(nothingNew))?.review).toMatchObject({
      verdict: 'promoted',
      comparedWithVersionId: first,
      additions: [],
    });

    // A person's version may add a host, counted against the promoted version
    // now in effect: the highest version of the latest effective date.
    const person = await addVersion(key, 4, {
      hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'cdn.ariba.example'],
    });
    await promote(person);
    expect((await a().recipeVersion(person))?.review).toMatchObject({
      comparedWithVersionId: nothingNew,
      additions: [{ kind: 'host', host: 'cdn.ariba.example' }],
    });
  });

  it('finds the promoted version in effect: latest date, highest version, not future or rejected', async () => {
    const key = portalKey('promoted');
    const connectionId = await connect(key);
    const promoted = async (): Promise<number | undefined> =>
      (await a().promotedRecipe(connectionId))?.version;

    expect(await promoted()).toBeUndefined();
    const v1 = await addVersion(key, 1);
    expect(await promoted()).toBeUndefined();
    await promote(v1);
    expect(await promoted()).toBe(1);

    await promote(await addVersion(key, 2, { effectiveFrom: '2026-06-01' }));
    expect(await promoted()).toBe(2);
    await promote(await addVersion(key, 3, { effectiveFrom: '2026-06-01' }));
    expect(await promoted()).toBe(3);
    await promote(await addVersion(key, 4, { effectiveFrom: '2999-01-01' }));
    expect(await promoted()).toBe(3);
    const rejected = await addVersion(key, 5, { effectiveFrom: '2026-07-01' });
    await a().reviewRecipeVersion({ recipeVersionId: rejected, verdict: 'rejected' });
    await addVersion(key, 6, { effectiveFrom: '2026-08-01' });
    expect(await promoted()).toBe(3);

    const record = await a().promotedRecipe(connectionId);
    expect(record?.review?.verdict).toBe('promoted');
    expect(record?.recipe).toEqual(recipe(key, 3, { effectiveFrom: '2026-06-01' }));

    const listed = await a().listRecipeVersions(key);
    expect(listed.map((v) => [v.version, v.review?.verdict ?? null])).toEqual([
      [6, null],
      [5, 'rejected'],
      [4, 'promoted'],
      [3, 'promoted'],
      [2, 'promoted'],
      [1, 'promoted'],
    ]);
    expect(await store(orgB, ownerB).listRecipeVersions(key)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  it('seals to the stored version’s binding before writing; only the worker’s cipher opens it', async () => {
    const { key, connectionId, versionId } = await readyConnection('seal');
    const cipher = new WatchedCipher();
    const credentialId = await a(cipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      label: 'Ariba dedicated user',
      payload,
    });
    expect(cipher.encrypts).toBe(1);
    expect(cipher.decrypts).toBe(0);

    const binding = bindingOf(recipe(key, 1));
    const record = await a().latestCredential(connectionId);
    expect(record).toMatchObject({
      credentialId,
      connectionId,
      label: 'Ariba dedicated user',
      binding,
      createdBy: ownerA,
      sealed: { cipher: 'local-aes-256-gcm', keyId: 'local-portal-key' },
    });

    // The worker's half: it opens only under this tenant, connection and binding.
    const sealed = record!.sealed;
    const context = portalCredentialContext({ orgId: orgA, connectionId }, record!.binding);
    expect(JSON.parse(await workerCipher.decrypt(sealed, context))).toEqual(payload);
    const elsewhere = bindingOf(
      recipe(key, 9, {
        hostAllowlist: ['service.ariba.example', 'accounts.sap.example', 'evil.example'],
      }),
    );
    for (const wrong of [
      portalCredentialContext({ orgId: orgA, connectionId }, elsewhere),
      portalCredentialContext({ orgId: orgA, connectionId: randomUUID() }, binding),
      portalCredentialContext({ orgId: orgB, connectionId }, binding),
    ]) {
      expect(await refusal(workerCipher.decrypt(sealed, wrong))).toBeInstanceOf(
        TokenDecryptionError,
      );
    }

    const { rows } = await admin.query<{ row: string }>(
      `select row_to_json(c)::text as row from portal_credentials c where id = $1`,
      [credentialId],
    );
    expect(rows[0]?.row).toContain(binding.hostsHash);
    for (const secret of SECRETS) expect(rows[0]?.row).not.toContain(secret);

    expect((await auditFor(connectionId)).at(-1)).toEqual({
      action: PORTAL_AUDIT_ACTIONS.credentialStored,
      actor_id: ownerA,
      subject_table: 'portal_connections',
      payload: { credential_id: credentialId, recipe_version_id: versionId },
    });

    // A newer credential is the current one: the latest by seq.
    const newer = await a(appCipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload,
    });
    expect((await a().latestCredential(connectionId))?.credentialId).toBe(newer);
  });

  it('seals to an unpromoted version an owner names, for a dry run', async () => {
    const { key, connectionId } = await readyConnection('seal_dry_run');
    const draft = await addVersion(key, 2, {
      signIn: { origin: ORIGIN, formPaths: ['/login'], mfaPaths: [], acsPaths: [] },
    });
    await a(appCipher).sealAndStoreCredential({ connectionId, recipeVersionId: draft, payload });
    expect((await a().latestCredential(connectionId))?.binding.signInPaths).toEqual(['/login']);
  });

  it('writes nothing when sealing fails, and passes the cipher’s own refusal on', async () => {
    const { connectionId, versionId } = await readyConnection('seal_fails');
    const kmsSaidNo = Object.assign(new Error('KMS refused GenerateDataKey'), {
      name: 'AccessDeniedException',
    });
    const cipher = new WatchedCipher(kmsSaidNo);
    const auditBefore = (await auditFor(connectionId)).length;

    expect(
      await refusal(
        a(cipher).sealAndStoreCredential({ connectionId, recipeVersionId: versionId, payload }),
      ),
    ).toBe(kmsSaidNo);
    expect(cipher.encrypts).toBe(1);
    expect(
      await count(`select count(*)::int as n from portal_credentials where connection_id = $1`, [
        connectionId,
      ]),
    ).toBe(0);
    expect(await auditFor(connectionId)).toHaveLength(auditBefore);
  });

  it('refuses before sealing: a non-owner, another portal, another tenant, no cipher', async () => {
    const { connectionId, versionId } = await readyConnection('seal_refusals');
    const other = await readyConnection('seal_other_portal');
    const inB = await store(orgB, ownerB).addRecipeVersion({
      recipe: recipe(portalKey('in_b'), 1),
    });
    const cipher = new WatchedCipher();

    const cases: Array<[() => Promise<unknown>, new (...args: never[]) => Error]> = [
      [
        () =>
          store(orgA, analystA, cipher).sealAndStoreCredential({
            connectionId,
            recipeVersionId: versionId,
            payload,
          }),
        PortalOwnerRequiredError,
      ],
      [
        () =>
          a(cipher).sealAndStoreCredential({
            connectionId,
            recipeVersionId: other.versionId,
            payload,
          }),
        PortalRecipeVersionPortalMismatchError,
      ],
      [
        () => a(cipher).sealAndStoreCredential({ connectionId, recipeVersionId: inB, payload }),
        PortalRecipeVersionNotFoundError,
      ],
      [
        () =>
          store(orgB, ownerB, cipher).sealAndStoreCredential({
            connectionId,
            recipeVersionId: versionId,
            payload,
          }),
        PortalConnectionNotFoundError,
      ],
      [
        () => a().sealAndStoreCredential({ connectionId, recipeVersionId: versionId, payload }),
        PortalSealingNotConfiguredError,
      ],
    ];
    for (const [work, refusedAs] of cases) expect(await refusal(work())).toBeInstanceOf(refusedAs);
    expect(cipher.encrypts).toBe(0);
    expect(
      await count(`select count(*)::int as n from portal_credentials where connection_id = $1`, [
        connectionId,
      ]),
    ).toBe(0);
  });

  it('refuses a label holding the username, and a bad payload, without repeating either', async () => {
    const { connectionId, versionId } = await readyConnection('seal_input');
    const cipher = new WatchedCipher();
    const labelled = await refusal(
      a(cipher).sealAndStoreCredential({
        connectionId,
        recipeVersionId: versionId,
        label: `Ariba ${USERNAME.toUpperCase()}`,
        payload,
      }),
    );
    expect(labelled).toBeInstanceOf(PortalCredentialLabelError);

    const bad = await refusal(
      a(cipher).sealAndStoreCredential({
        connectionId,
        recipeVersionId: versionId,
        payload: { username: USERNAME, password: '', totpSecret: 'not-base32-DO-NOT-LOG' },
      }),
    );
    expect(bad).toBeInstanceOf(PortalInputError);
    expect([...new Set((bad as PortalInputError).issues.map((i) => i.field))].sort()).toEqual([
      'payload.password',
      'payload.totpSecret',
    ]);

    const extra = await refusal(
      a(cipher).sealAndStoreCredential({
        connectionId,
        recipeVersionId: versionId,
        payload: { ...payload, cookie: 'session=DO-NOT-LOG' } as PortalCredentialPayload,
      }),
    );
    expect(extra).toBeInstanceOf(PortalInputError);
    expect(cipher.encrypts).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  const counts = (
    over: Partial<
      Record<'pages' | 'captures' | 'newDocuments' | 'deduplicated' | 'refusals', number>
    > = {},
  ) => ({
    pages: 3,
    captures: 0,
    newDocuments: 0,
    deduplicated: 0,
    refusals: 0,
    ...over,
  });
  const steps = [
    { step: 'start', passed: true },
    { step: 'sign_in', passed: true },
    { step: 'answer_mfa', passed: false },
  ];

  it('starts a dry run of an unpromoted version once, however often the step replays', async () => {
    const { key, connectionId } = await readyConnection('dry_run');
    const draft = await addVersion(key, 2);
    const runId = randomUUID();
    const start = {
      runId,
      orgId: orgA,
      connectionId,
      recipeVersionId: draft,
      dryRun: true,
      requestedBy: ownerA,
    };

    expect(await a().recordRunStart(start)).toBe(runId);
    expect(await a().recordRunStart(start)).toBe(runId);
    expect(
      await count(`select count(*)::int as n from portal_read_starts where id = $1`, [runId]),
    ).toBe(1);

    const differs = await refusal(a().recordRunStart({ ...start, recipeVersionId: null }));
    expect(differs).toBeInstanceOf(PortalRunRecordRefusedError);
    expect(differs).toMatchObject({ record: 'start', runId, sqlState: '23505' });
  });

  it('refuses a read of an unpromoted version, and a start by anyone but the connection’s member', async () => {
    const { key, connectionId } = await readyConnection('start_refusals');
    const draft = await addVersion(key, 2);

    const unpromoted = await refusal(
      a().recordRunStart({
        runId: randomUUID(),
        orgId: orgA,
        connectionId,
        recipeVersionId: draft,
        dryRun: false,
        requestedBy: ownerA,
      }),
    );
    expect(unpromoted).toMatchObject({ sqlState: '23001' });
    expect((unpromoted as Error).message).toContain('is not promoted');

    const otherOwner = await refusal(
      store(orgA, ownerA2).recordRunStart({
        runId: randomUUID(),
        orgId: orgA,
        connectionId,
        recipeVersionId: null,
        dryRun: true,
        requestedBy: ownerA2,
      }),
    );
    expect(otherOwner).toMatchObject({ sqlState: '42501' });

    expect(
      await refusal(
        a().recordRunStart({
          runId: randomUUID(),
          orgId: orgA,
          connectionId,
          recipeVersionId: null,
          dryRun: true,
          requestedBy: ownerA2,
        }),
      ),
    ).toBeInstanceOf(PortalActorMismatchError);
    expect(
      await refusal(
        a().recordRunStart({
          runId: randomUUID(),
          orgId: orgB,
          connectionId,
          recipeVersionId: null,
          dryRun: true,
          requestedBy: ownerA,
        }),
      ),
    ).toBeInstanceOf(PortalActorMismatchError);
    expect(
      await refusal(
        a().recordRunStart({
          runId: 'C0FFEE00-0000-4000-8000-000000000000',
          orgId: orgA,
          connectionId,
          recipeVersionId: null,
          dryRun: true,
          requestedBy: ownerA,
        }),
      ),
    ).toBeInstanceOf(PortalInputError);
  });

  it('records every outcome shape once, and lists runs newest first with their outcomes', async () => {
    const { connectionId, versionId } = await readyConnection('outcomes');
    const started: string[] = [];
    const start = async (recipeVersionId: string | null = versionId): Promise<string> => {
      const runId = randomUUID();
      await a().recordRunStart({
        runId,
        orgId: orgA,
        connectionId,
        recipeVersionId,
        dryRun: false,
        requestedBy: ownerA,
      });
      started.push(runId);
      return runId;
    };

    const completed = await start();
    const end = {
      runId: completed,
      orgId: orgA,
      atStep: null,
      counts: counts({ captures: 1, newDocuments: 1 }),
      stepLog: steps,
    };
    const outcomeId = await a().recordRunEnd({ ...end, outcome: 'completed' });
    expect(await a().recordRunEnd({ ...end, outcome: 'completed' })).toBe(outcomeId);
    expect(
      await refusal(
        a().recordRunEnd({ ...end, outcome: 'completed', counts: counts({ pages: 4 }) }),
      ),
    ).toMatchObject({
      record: 'outcome',
      sqlState: '23505',
    });

    const rejected = await start();
    await a().recordRunEnd({
      runId: rejected,
      orgId: orgA,
      atStep: 'sign_in',
      counts: counts(),
      stepLog: steps,
      outcome: 'needs_attention',
      reason: 'credential_rejected',
    });
    const errored = await start();
    await a().recordRunEnd({
      runId: errored,
      orgId: orgA,
      atStep: 'landing',
      counts: counts(),
      stepLog: [],
      outcome: 'failed',
      reason: 'error',
      errorClass: 'TimeoutError',
    });
    const guarded = await start();
    await a().recordRunEnd({
      runId: guarded,
      orgId: orgA,
      atStep: 'start',
      counts: counts({ refusals: 2 }),
      stepLog: [],
      outcome: 'failed',
      reason: 'guard_refused',
    });
    const unconfigured = await start(null);
    await a().recordRunEnd({
      runId: unconfigured,
      orgId: orgA,
      atStep: null,
      counts: counts({ pages: 0 }),
      stepLog: [],
      outcome: 'not_configured',
      errorClass: 'PortalCredentialMissing',
    });
    const unfinished = await start();

    const runs = await a().listRuns(connectionId);
    expect(runs.map((r) => r.runId).sort()).toEqual([...started].sort());
    const byId = new Map(runs.map((r) => [r.runId, r]));
    expect(byId.get(completed)).toMatchObject({
      recipeVersionId: versionId,
      dryRun: false,
      requestedBy: ownerA,
      end: {
        outcome: 'completed',
        atStep: null,
        counts: counts({ captures: 1, newDocuments: 1 }),
        stepLog: steps,
      },
    });
    expect(byId.get(rejected)?.end).toMatchObject({
      outcome: 'needs_attention',
      reason: 'credential_rejected',
      atStep: 'sign_in',
    });
    expect(byId.get(errored)?.end).toMatchObject({
      outcome: 'failed',
      reason: 'error',
      errorClass: 'TimeoutError',
    });
    expect(byId.get(guarded)?.end).toMatchObject({
      outcome: 'failed',
      reason: 'guard_refused',
      counts: counts({ refusals: 2 }),
    });
    expect(byId.get(guarded)?.end).not.toHaveProperty('errorClass');
    expect(byId.get(unconfigured)).toMatchObject({
      recipeVersionId: null,
      end: { outcome: 'not_configured', errorClass: 'PortalCredentialMissing' },
    });
    expect(byId.get(unfinished)?.end).toBeNull();

    expect(await a().listRuns(connectionId, 2)).toHaveLength(2);
    expect(await refusal(a().listRuns(connectionId, 0))).toBeInstanceOf(PortalInputError);
    expect(await refusal(a().listRuns(connectionId, 101))).toBeInstanceOf(PortalInputError);
  });

  it('refuses an outcome PortalRunEnd has no shape for; keeps a step log to names and passes', async () => {
    const { connectionId, versionId } = await readyConnection('outcome_input');
    const runId = randomUUID();
    await a().recordRunStart({
      runId,
      orgId: orgA,
      connectionId,
      recipeVersionId: versionId,
      dryRun: false,
      requestedBy: ownerA,
    });
    const end = { runId, orgId: orgA, atStep: null, counts: counts(), stepLog: steps };

    const shapes: unknown[] = [
      { ...end, outcome: 'completed', errorClass: 'Whatever' },
      { ...end, outcome: 'completed', reason: 'challenge' },
      { ...end, outcome: 'needs_attention', reason: 'guard_refused' },
      { ...end, outcome: 'needs_attention', reason: 'challenge', errorClass: 'Whatever' },
      { ...end, outcome: 'failed', reason: 'error' },
      { ...end, outcome: 'failed', reason: 'error', errorClass: 'not a class name' },
      { ...end, outcome: 'refused' },
      { ...end, outcome: 'paused' },
      { ...end, outcome: 'completed', counts: counts({ pages: -1 }) },
      { ...end, outcome: 'completed', counts: counts({ pages: 1.5 }) },
      { ...end, outcome: 'completed', atStep: 'bad\u0007step' },
      {
        ...end,
        outcome: 'completed',
        stepLog: [
          { step: 'start', passed: true },
          { step: 'start', passed: false },
        ],
      },
      { ...end, outcome: 'completed', stepLog: [{ step: 'start', passed: 'yes' }] },
    ];
    for (const shape of shapes) {
      expect(await refusal(a().recordRunEnd(shape as never))).toBeInstanceOf(PortalInputError);
    }
    expect(
      await count(`select count(*)::int as n from portal_read_runs where run_id = $1`, [runId]),
    ).toBe(0);

    await a().recordRunEnd({
      ...end,
      outcome: 'completed',
      stepLog: [{ step: 'start', passed: true, value: 'page text DO-NOT-LOG' } as never],
    });
    const { rows } = await admin.query<{ step_log: unknown }>(
      `select step_log from portal_read_runs where run_id = $1`,
      [runId],
    );
    expect(rows[0]?.step_log).toEqual([{ step: 'start', passed: true }]);
  });

  it('lets the database refuse a dry run that counted a capture', async () => {
    const { connectionId, versionId } = await readyConnection('dry_run_counts');
    const runId = randomUUID();
    await a().recordRunStart({
      runId,
      orgId: orgA,
      connectionId,
      recipeVersionId: versionId,
      dryRun: true,
      requestedBy: ownerA,
    });
    const refused = await refusal(
      a().recordRunEnd({
        runId,
        orgId: orgA,
        atStep: null,
        counts: counts({ captures: 1 }),
        stepLog: [],
        outcome: 'completed',
      }),
    );
    expect(refused).toMatchObject({ record: 'outcome', sqlState: '23514' });
    expect((refused as Error).message).toContain('a dry run captures nothing');
  });

  it('records the start and the refusal of a run whose member may no longer write', async () => {
    const key = portalKey('demoted');
    const connectionId = await connect(key, ownerA2);
    await admin.query(
      `update memberships set role = 'read_only' where org_id = $1 and user_id = $2`,
      [orgA, ownerA2],
    );
    try {
      const demoted = store(orgA, ownerA2);
      expect(await demoted.memberMayWrite({ orgId: orgA, userId: ownerA2 })).toBe(false);
      const runId = randomUUID();
      expect(
        await demoted.recordRunStart({
          runId,
          orgId: orgA,
          connectionId,
          recipeVersionId: null,
          dryRun: false,
          requestedBy: ownerA2,
        }),
      ).toBe(runId);
      await demoted.recordRunEnd({
        runId,
        orgId: orgA,
        atStep: null,
        counts: counts({ pages: 0 }),
        stepLog: [],
        outcome: 'refused',
        errorClass: 'MemberMayNotWrite',
      });
      expect((await demoted.listRuns(connectionId))[0]?.end).toMatchObject({
        outcome: 'refused',
        errorClass: 'MemberMayNotWrite',
      });
    } finally {
      await admin.query(
        `update memberships set role = 'owner' where org_id = $1 and user_id = $2`,
        [orgA, ownerA2],
      );
    }
  });

  // -------------------------------------------------------------------------
  // Captures
  // -------------------------------------------------------------------------

  async function documentFor(bytes: Buffer): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into documents (org_id, sha256, byte_size, mime_type, storage_ref, filename)
       values ($1, $2, $3, 'text/html', $4, 'landing.html') returning id`,
      [orgA, createHash('sha256').update(bytes).digest(), bytes.length, `doc/${randomUUID()}`],
    );
    return rows[0]!.id;
  }

  it('records a stored capture and a refused one, and a replayed capture writes nothing', async () => {
    const { connectionId, versionId } = await readyConnection('captures');
    const runId = randomUUID();
    await a().recordRunStart({
      runId,
      orgId: orgA,
      connectionId,
      recipeVersionId: versionId,
      dryRun: false,
      requestedBy: ownerA,
    });
    const bytes = randomBytes(64);
    const documentId = await documentFor(bytes);
    const stored = {
      runId,
      orgId: orgA,
      recipeVersionId: versionId,
      kind: 'page_snapshot' as const,
      stepName: 'landing',
      pagePath: '/dashboard/home',
      snapshotRuleVersion: 1,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capturedAt: new Date('2026-09-28T10:00:00.123Z'),
      documentId,
    };
    const id = await a().recordCapture(stored);
    expect(await a().recordCapture(stored)).toBe(id);
    expect(
      await count(`select count(*)::int as n from portal_captures where run_id = $1`, [runId]),
    ).toBe(1);

    const refusedId = await a().recordCapture({
      runId,
      orgId: orgA,
      recipeVersionId: versionId,
      kind: 'download',
      stepName: 'export',
      pagePath: '/exports',
      snapshotRuleVersion: null,
      sha256: createHash('sha256').update('refused bytes').digest('hex'),
      capturedAt: new Date(),
      refusal: 'active_content_pdf',
    });
    const { rows } = await admin.query<{ document_id: string | null; refusal: string | null }>(
      `select document_id, refusal from portal_captures where id = $1`,
      [refusedId],
    );
    expect(rows[0]).toEqual({ document_id: null, refusal: 'active_content_pdf' });
  });

  it('lets the database refuse a dry run’s capture, another version’s, or another document’s bytes', async () => {
    const { key, connectionId, versionId } = await readyConnection('capture_refusals');
    const other = await addVersion(key, 2);
    const run = randomUUID();
    const dry = randomUUID();
    await a().recordRunStart({
      runId: run,
      orgId: orgA,
      connectionId,
      recipeVersionId: versionId,
      dryRun: false,
      requestedBy: ownerA,
    });
    await a().recordRunStart({
      runId: dry,
      orgId: orgA,
      connectionId,
      recipeVersionId: versionId,
      dryRun: true,
      requestedBy: ownerA,
    });
    const bytes = randomBytes(64);
    const documentId = await documentFor(bytes);
    const capture = {
      runId: run,
      orgId: orgA,
      recipeVersionId: versionId,
      kind: 'page_snapshot' as const,
      stepName: 'landing',
      pagePath: '/dashboard',
      snapshotRuleVersion: 1,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capturedAt: new Date(),
      documentId,
    };
    for (const wrong of [
      { ...capture, runId: dry },
      { ...capture, recipeVersionId: other },
      { ...capture, sha256: createHash('sha256').update('other bytes').digest('hex') },
    ]) {
      const refused = await refusal(a().recordCapture(wrong));
      expect(refused).toMatchObject({ record: 'capture', sqlState: '23514' });
      expect((refused as Error).message).toContain('portal capture blocked');
    }
    expect(
      await count(`select count(*)::int as n from portal_captures where run_id = any($1::uuid[])`, [
        [run, dry],
      ]),
    ).toBe(0);
  });

  it('refuses a capture the contract refuses before the database, never repeating the path', async () => {
    const capture = {
      runId: randomUUID(),
      orgId: orgA,
      recipeVersionId: randomUUID(),
      kind: 'page_snapshot' as const,
      stepName: 'landing',
      pagePath: '/dashboard',
      snapshotRuleVersion: 1,
      sha256: 'a'.repeat(64),
      capturedAt: new Date(),
      documentId: randomUUID(),
    };
    const shapes: unknown[] = [
      { ...capture, pagePath: '/landing?session=DO-NOT-LOG' },
      { ...capture, pagePath: '/landing;jsessionid=DO-NOT-LOG' },
      { ...capture, pagePath: '/(S(DO-NOT-LOG))/landing' },
      { ...capture, pagePath: 'landing' },
      { ...capture, snapshotRuleVersion: null },
      { ...capture, kind: 'download' },
      { ...capture, refusal: 'active_content_pdf' },
      { ...capture, documentId: undefined },
      { ...capture, documentId: undefined, refusal: 'not_a_door_code' },
      { ...capture, sha256: 'A'.repeat(64) },
      { ...capture, capturedAt: new Date(Number.NaN) },
    ];
    for (const shape of shapes) {
      const refused = await refusal(a().recordCapture(shape as never));
      expect(refused).toBeInstanceOf(PortalInputError);
      expect((refused as Error).message).not.toContain('DO-NOT-LOG');
    }
    expect(await refusal(a().recordCapture({ ...capture, orgId: orgB }))).toBeInstanceOf(
      PortalActorMismatchError,
    );
  });

  /** What a new capture writes, counted by the admin: arrivals, documents, bytes, pages and rows. */
  async function newCaptureTrail(sha256: string, runId: string) {
    const hash = Buffer.from(sha256, 'hex');
    return {
      documents: await count(`select count(*)::int as n from documents where org_id = $1 and sha256 = $2`, [orgA, hash]),
      uploads: await count(
        `select count(*)::int as n from uploads u join documents d on d.upload_id = u.id
          where d.org_id = $1 and d.sha256 = $2`,
        [orgA, hash],
      ),
      blobs: await count(
        `select count(*)::int as n from document_blobs b join documents d on d.id = b.document_id
          where d.org_id = $1 and d.sha256 = $2`,
        [orgA, hash],
      ),
      captures: await count(`select count(*)::int as n from portal_captures where run_id = $1`, [runId]),
    };
  }

  function newDocument(bytes: Buffer) {
    return {
      orgId: orgA,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      filename: 'landing.html',
      mimeType: 'text/html',
      byteSize: bytes.length,
      bytes: new Uint8Array(bytes),
      pageText: ['landing page'],
      requiresSplit: false,
    };
  }

  it('writes a new capture’s arrival, document and row in one transaction', async () => {
    const { connectionId, versionId } = await readyConnection('new_capture');
    const runId = randomUUID();
    await a().recordRunStart({ runId, orgId: orgA, connectionId, recipeVersionId: versionId, dryRun: false, requestedBy: ownerA });
    const document = newDocument(randomBytes(64));
    const capture = {
      runId,
      orgId: orgA,
      recipeVersionId: versionId,
      kind: 'page_snapshot' as const,
      stepName: 'landing',
      pagePath: '/dashboard/home',
      snapshotRuleVersion: 1,
      sha256: document.sha256,
      capturedAt: new Date('2026-09-28T10:00:00.123Z'),
    };
    const { document: stored, captureId } = await a().recordNewCapture({ capture, document });

    expect(await newCaptureTrail(document.sha256, runId)).toEqual({ documents: 1, uploads: 1, blobs: 1, captures: 1 });
    const { rows } = await admin.query<{ source: string; created_by: string | null; document_id: string; pages: number }>(
      `select u.source, u.created_by, c.document_id,
              (select count(*)::int from document_pages p where p.document_id = d.id) as pages
         from portal_captures c
         join documents d on d.id = c.document_id
         join uploads u on u.id = d.upload_id
        where c.id = $1`,
      [captureId],
    );
    expect(rows[0]).toEqual({ source: 'portal_fetch', created_by: null, document_id: stored.documentId, pages: 1 });
    expect(stored).toMatchObject({ orgId: orgA, sha256: document.sha256, uploadId: expect.any(String) });
    // A replay of the step finds the bytes and replays the row, writing nothing.
    expect(await a().recordCapture({ ...capture, documentId: stored.documentId })).toBe(captureId);
    expect(await newCaptureTrail(document.sha256, runId)).toEqual({ documents: 1, uploads: 1, blobs: 1, captures: 1 });
  });

  it('leaves no orphan upload or document when the capture row is refused', async () => {
    const { key, connectionId, versionId } = await readyConnection('new_capture_refused');
    const other = await addVersion(key, 2);
    const run = randomUUID();
    const dry = randomUUID();
    const ended = randomUUID();
    for (const [runId, dryRun] of [[run, false], [dry, true], [ended, false]] as const) {
      await a().recordRunStart({ runId, orgId: orgA, connectionId, recipeVersionId: versionId, dryRun, requestedBy: ownerA });
    }
    await a().recordRunEnd({
      runId: ended,
      orgId: orgA,
      atStep: null,
      counts: counts({ pages: 1 }),
      stepLog: [],
      outcome: 'completed',
    });
    const base = {
      runId: run,
      orgId: orgA,
      recipeVersionId: versionId,
      kind: 'page_snapshot' as const,
      stepName: 'landing',
      pagePath: '/dashboard',
      snapshotRuleVersion: 1,
      capturedAt: new Date(),
    };
    const cases: [string, (sha: string) => Promise<unknown>][] = [
      ['a dry run', (sha) => a().recordNewCapture({ capture: { ...base, runId: dry, sha256: sha }, document: newDocument(bytesBySha.get(sha)!) })],
      ['another version', (sha) => a().recordNewCapture({ capture: { ...base, recipeVersionId: other, sha256: sha }, document: newDocument(bytesBySha.get(sha)!) })],
      ['a run that ended', (sha) => a().recordNewCapture({ capture: { ...base, runId: ended, sha256: sha }, document: newDocument(bytesBySha.get(sha)!) })],
      ['another owner than the run’s member', (sha) => store(orgA, ownerA2).recordNewCapture({ capture: { ...base, sha256: sha }, document: newDocument(bytesBySha.get(sha)!) })],
      ['a writer', (sha) => store(orgA, analystA).recordNewCapture({ capture: { ...base, sha256: sha }, document: newDocument(bytesBySha.get(sha)!) })],
    ];
    const bytesBySha = new Map<string, Buffer>();
    for (const [label, attempt] of cases) {
      const bytes = randomBytes(64);
      const sha = createHash('sha256').update(bytes).digest('hex');
      bytesBySha.set(sha, bytes);
      const refused = await refusal(attempt(sha));
      expect(refused, label).toMatchObject({ record: 'capture' });
      for (const runId of [run, dry, ended]) {
        expect(await newCaptureTrail(sha, runId), label).toEqual({ documents: 0, uploads: 0, blobs: 0, captures: 0 });
      }
    }
    expect(
      await count(
        `select count(*)::int as n from uploads u
          where u.org_id = $1 and u.source = 'portal_fetch'
            and not exists (select 1 from documents d where d.upload_id = u.id)`,
        [orgA],
      ),
    ).toBe(0);

    // Refused before the database: a capture whose hash is not the document's.
    const doc = newDocument(randomBytes(64));
    expect(
      await refusal(a().recordNewCapture({ capture: { ...base, sha256: 'a'.repeat(64) }, document: doc })),
    ).toBeInstanceOf(PortalInputError);
    expect(
      await refusal(a().recordNewCapture({ capture: { ...base, sha256: doc.sha256 }, document: { ...doc, orgId: orgB } })),
    ).toBeInstanceOf(PortalActorMismatchError);
    expect(await newCaptureTrail(doc.sha256, run)).toEqual({ documents: 0, uploads: 0, blobs: 0, captures: 0 });
  });

  // -------------------------------------------------------------------------
  // Turning a connection off and on (ADR 0057 §7, §8)
  // -------------------------------------------------------------------------

  async function withCredential(
    name: string,
  ): Promise<{ key: string; connectionId: string; versionId: string; credentialId: string }> {
    const { key, connectionId, versionId } = await readyConnection(name);
    const credentialId = await a(appCipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload,
    });
    return { key, connectionId, versionId, credentialId };
  }

  it('turns off for a refused credential, once, and stays off until a newer one is stored', async () => {
    const { connectionId, versionId, credentialId } = await withCredential('rejected');
    expect(
      await a().disableConnection({ connectionId, reason: 'credential_rejected', credentialId }),
    ).toBe('disabled');
    expect(await enabled(connectionId)).toBe(false);
    expect((await auditFor(connectionId)).at(-1)).toEqual({
      action: PORTAL_AUDIT_ACTIONS.connectionDisabled,
      actor_id: ownerA,
      subject_table: 'portal_connections',
      payload: { reason: 'credential_rejected', credential_id: credentialId },
    });
    // A replay of the job's finish step: off already, for this very credential,
    // so there is nothing new to record.
    const disabledAudit = (await auditFor(connectionId)).length;
    expect(
      await a().disableConnection({ connectionId, reason: 'credential_rejected', credentialId }),
    ).toBe('already_off');
    expect(await auditFor(connectionId)).toHaveLength(disabledAudit);

    const replacement = await refusal(a().enableConnection(connectionId));
    expect(replacement).toBeInstanceOf(PortalCredentialReplacementRequiredError);
    expect(replacement).toMatchObject({ disabledFor: 'credential_rejected' });
    // The database holds it too, for a writer that goes around the store
    // (migration 0039, ADR 0064): an owner's own UPDATE is refused.
    expect(await rawEnableAs(ownerA, connectionId)).toMatchObject({
      code: '23514',
      message: expect.stringContaining('portal connection enable blocked'),
    });
    expect(await enabled(connectionId)).toBe(false);

    const newer = await a(appCipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload,
    });
    expect(await enabled(connectionId)).toBe(false);
    expect(await a().enableConnection(connectionId)).toBe('enabled');
    expect((await auditFor(connectionId)).at(-1)).toMatchObject({
      action: PORTAL_AUDIT_ACTIONS.connectionEnabled,
      payload: { credential_id: newer },
    });
    expect(await a().enableConnection(connectionId)).toBe('already_on');

    // The refused credential is no longer the latest: a late rejection of it
    // undoes nothing.
    const auditBefore = (await auditFor(connectionId)).length;
    expect(
      await a().disableConnection({ connectionId, reason: 'credential_rejected', credentialId }),
    ).toBe('newer_credential');
    expect(await enabled(connectionId)).toBe(true);
    expect(await auditFor(connectionId)).toHaveLength(auditBefore);
  });

  it('stays off after credential_removed until another is stored; turned_off turns back on', async () => {
    const { connectionId, versionId, credentialId } = await withCredential('removed');
    expect(await a().disableConnection({ connectionId, reason: 'credential_removed' })).toBe(
      'disabled',
    );
    expect((await auditFor(connectionId)).at(-1)?.payload).toEqual({
      reason: 'credential_removed',
      credential_id: credentialId,
    });
    expect(await refusal(a().enableConnection(connectionId))).toBeInstanceOf(
      PortalCredentialReplacementRequiredError,
    );
    await a(appCipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload,
    });
    expect(await a().enableConnection(connectionId)).toBe('enabled');

    expect(await a().disableConnection({ connectionId, reason: 'turned_off' })).toBe('disabled');
    expect((await auditFor(connectionId)).at(-1)?.payload).toEqual({ reason: 'turned_off' });
    expect(await a().enableConnection(connectionId)).toBe('enabled');
  });

  it('records a refusal that meets a connection already off, and holds it off until a newer credential', async () => {
    // An owner turns the connection off while a run is in flight (a job does
    // not hold the connection for the length of a run), and the run then ends
    // credential_rejected: the refusal still has to hold the connection off.
    const { connectionId, versionId, credentialId } = await withCredential('rejected_while_off');
    expect(await a().disableConnection({ connectionId, reason: 'turned_off' })).toBe('disabled');
    expect(
      await a().disableConnection({ connectionId, reason: 'credential_rejected', credentialId }),
    ).toBe('already_off');
    expect(await enabled(connectionId)).toBe(false);
    expect((await auditFor(connectionId)).at(-1)).toEqual({
      action: PORTAL_AUDIT_ACTIONS.connectionDisabled,
      actor_id: ownerA,
      subject_table: 'portal_connections',
      payload: { reason: 'credential_rejected', credential_id: credentialId, already_off: true },
    });

    // The finish step replayed: the same hold is recorded, so nothing is written.
    const recorded = (await auditFor(connectionId)).length;
    expect(
      await a().disableConnection({ connectionId, reason: 'credential_rejected', credentialId }),
    ).toBe('already_off');
    expect(await auditFor(connectionId)).toHaveLength(recorded);

    const replacement = await refusal(a().enableConnection(connectionId));
    expect(replacement).toBeInstanceOf(PortalCredentialReplacementRequiredError);
    expect(replacement).toMatchObject({ connectionId, disabledFor: 'credential_rejected' });
    expect(await enabled(connectionId)).toBe(false);
    expect(await auditFor(connectionId)).toHaveLength(recorded);

    const newer = await a(appCipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload,
    });
    expect(await a().enableConnection(connectionId)).toBe('enabled');
    expect((await auditFor(connectionId)).at(-1)).toMatchObject({
      action: PORTAL_AUDIT_ACTIONS.connectionEnabled,
      payload: { credential_id: newer },
    });
  });

  it('records a removal that meets a connection already off, and holds it off until a newer credential', async () => {
    const { connectionId, versionId, credentialId } = await withCredential('removed_while_off');
    expect(await a().disableConnection({ connectionId, reason: 'turned_off' })).toBe('disabled');
    expect(await a().disableConnection({ connectionId, reason: 'credential_removed' })).toBe(
      'already_off',
    );
    expect((await auditFor(connectionId)).at(-1)?.payload).toEqual({
      reason: 'credential_removed',
      credential_id: credentialId,
      already_off: true,
    });
    const recorded = (await auditFor(connectionId)).length;
    expect(await a().disableConnection({ connectionId, reason: 'credential_removed' })).toBe(
      'already_off',
    );
    expect(await auditFor(connectionId)).toHaveLength(recorded);

    const refused = await refusal(a().enableConnection(connectionId));
    expect(refused).toBeInstanceOf(PortalCredentialReplacementRequiredError);
    expect(refused).toMatchObject({ connectionId, disabledFor: 'credential_removed' });
    expect(await enabled(connectionId)).toBe(false);
    // The removed credential's row stays, append-only, and is still the latest:
    // what holds the connection off is the removal naming it, until a newer one.
    expect((await a().latestCredential(connectionId))?.credentialId).toBe(credentialId);

    await a(appCipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload,
    });
    expect(await a().enableConnection(connectionId)).toBe('enabled');
  });

  /** `update portal_connections set enabled = true`, as `app_rw` with a member's claims; the error, or `undefined`. */
  async function rawEnableAs(userId: string, connectionId: string): Promise<unknown> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgA, sub: userId }),
      ]);
      await client.query(`update portal_connections set enabled = true where id = $1`, [connectionId]);
      await client.query('rollback');
      return undefined;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      return error;
    } finally {
      client.release();
    }
  }

  /** Writes a disable row for `connectionId` as a member could, as `app_rw` with their claims. */
  async function disabledRowAs(
    userId: string,
    connectionId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgA, sub: userId }),
      ]);
      await client.query(
        `insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
         values ($1, $2, $3, 'portal_connections', $4, $5::jsonb)`,
        [
          orgA,
          userId,
          PORTAL_AUDIT_ACTIONS.connectionDisabled,
          connectionId,
          JSON.stringify(payload),
        ],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it('lifts no hold with a later turn-off, whether or not that turn-off writes a row', async () => {
    const { connectionId, credentialId } = await withCredential('rejected_then_off');
    expect(
      await a().disableConnection({ connectionId, reason: 'credential_rejected', credentialId }),
    ).toBe('disabled');

    // Pressing Turn off on a connection already off changes nothing and writes nothing.
    const recorded = (await auditFor(connectionId)).length;
    expect(await a().disableConnection({ connectionId, reason: 'turned_off' })).toBe('already_off');
    expect(await auditFor(connectionId)).toHaveLength(recorded);
    expect(await refusal(a().enableConnection(connectionId))).toMatchObject({
      disabledFor: 'credential_rejected',
    });

    // And a later disable row, however it came to be written (here one a
    // writer adds as themselves, which the database accepts), does not hide
    // the refusal: every hold naming the current credential counts, not only
    // the latest disable, so a row can add a hold and never lift one.
    await disabledRowAs(analystA, connectionId, { reason: 'turned_off' });
    expect((await auditFor(connectionId)).at(-1)).toMatchObject({
      action: PORTAL_AUDIT_ACTIONS.connectionDisabled,
      actor_id: analystA,
      payload: { reason: 'turned_off' },
    });
    const refused = await refusal(a().enableConnection(connectionId));
    expect(refused).toBeInstanceOf(PortalCredentialReplacementRequiredError);
    expect(refused).toMatchObject({ connectionId, disabledFor: 'credential_rejected' });
    expect(await enabled(connectionId)).toBe(false);
  });

  it('holds a connection whose removal named no credential off until one is stored', async () => {
    const { connectionId, versionId } = await readyConnection('removed_none');
    expect(await a().disableConnection({ connectionId, reason: 'credential_removed' })).toBe(
      'disabled',
    );
    expect((await auditFor(connectionId)).at(-1)?.payload).toEqual({
      reason: 'credential_removed',
    });
    expect(await refusal(a().enableConnection(connectionId))).toMatchObject({
      disabledFor: 'credential_removed',
    });
    await a(appCipher).sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload,
    });
    expect(await a().enableConnection(connectionId)).toBe('enabled');
  });

  it('refuses a non-owner, a credential not the connection’s, or one named where none belongs', async () => {
    const { connectionId, credentialId } = await withCredential('disable_refusals');
    const other = await withCredential('disable_other');
    expect(
      await refusal(
        store(orgA, analystA).disableConnection({ connectionId, reason: 'turned_off' }),
      ),
    ).toBeInstanceOf(PortalOwnerRequiredError);
    expect(await refusal(store(orgA, analystA).enableConnection(connectionId))).toBeInstanceOf(
      PortalOwnerRequiredError,
    );
    expect(
      await refusal(
        a().disableConnection({
          connectionId,
          reason: 'credential_rejected',
          credentialId: other.credentialId,
        }),
      ),
    ).toBeInstanceOf(PortalCredentialNotFoundError);
    expect(
      await refusal(
        a().disableConnection({ connectionId, reason: 'turned_off', credentialId } as never),
      ),
    ).toBeInstanceOf(PortalInputError);
    expect(
      await refusal(
        a().disableConnection({ connectionId, reason: 'credential_rejected' } as never),
      ),
    ).toBeInstanceOf(PortalInputError);
    expect(await enabled(connectionId)).toBe(true);
  });

  it('never undoes a credential stored while a refused one is being turned off', async () => {
    const { key, connectionId, credentialId } = await withCredential('race');
    const binding = bindingOf(recipe(key, 1));
    const sealed = await appCipher.encrypt(
      JSON.stringify(payload),
      portalCredentialContext({ orgId: orgA, connectionId }, binding),
    );

    // An owner's credential insert, in flight: its foreign key holds the
    // connection row FOR KEY SHARE until it commits.
    const inFlight = await admin.connect();
    try {
      await inFlight.query('begin');
      await inFlight.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ org_id: orgA, sub: ownerA }),
      ]);
      await inFlight.query(
        `insert into portal_credentials
           (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
            sign_in_origin, sign_in_paths, hosts_hash, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)`,
        [
          orgA,
          connectionId,
          sealed.cipher,
          sealed.keyId,
          sealed.wrappedKey,
          sealed.ciphertext,
          binding.signInOrigin,
          [...binding.signInPaths],
          binding.hostsHash,
          ownerA,
        ],
      );

      let settled = false;
      const disabling = a()
        .disableConnection({ connectionId, reason: 'credential_rejected', credentialId })
        .finally(() => {
          settled = true;
        });

      // The disable waits on the row lock, rather than reading a latest
      // credential the insert is about to change.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await count(
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and query ilike '%from portal_connections%for update%'`,
          [],
        );
        if (waiting > 0) break;
        if (Date.now() > deadline) {
          throw new Error('the disable never waited on the connection row');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(settled).toBe(false);

      await inFlight.query('commit');
      expect(await disabling).toBe('newer_credential');
    } finally {
      await inFlight.query('rollback').catch(() => undefined);
      inFlight.release();
    }
    expect(await enabled(connectionId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The fan-out
  // -------------------------------------------------------------------------

  it('lists enabled connections across tenants for the fan-out, whatever claims the store holds', async () => {
    const key = portalKey('fan_out');
    const inA = await connect(key);
    const inB = await connect(key, ownerB, orgB);
    const off = await connect(key);
    await a().disableConnection({ connectionId: off, reason: 'turned_off' });

    for (const listed of [
      await listPortalConnectionsToRead(config),
      await a().connectionsToRead(),
    ]) {
      const mine = listed.filter((c) => c.portalKey === key);
      expect(mine).toEqual(
        expect.arrayContaining([
          { connectionId: inA, orgId: orgA, portalKey: key, createdBy: ownerA },
          { connectionId: inB, orgId: orgB, portalKey: key, createdBy: ownerB },
        ]),
      );
      expect(mine.map((c) => c.connectionId)).not.toContain(off);
      expect(mine).toHaveLength(2);
    }
  });

  // -------------------------------------------------------------------------
  // Nothing credential-shaped anywhere else (ADR 0057 §7)
  // -------------------------------------------------------------------------

  it('put no credential in an error, a log line, an audit payload or a clear column', async () => {
    expect(caught.length).toBeGreaterThan(20);
    expect(caught.filter((error) => error instanceof PortalStoreError).length).toBeGreaterThan(20);
    for (const error of caught) {
      const stack = error instanceof Error ? (error.stack ?? '') : '';
      const text = `${String(error)} ${JSON.stringify(error)} ${stack}`;
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    const lines = JSON.stringify(logged);
    for (const secret of SECRETS) expect(lines).not.toContain(secret);

    const { rows } = await admin.query<{ text: string }>(
      `select coalesce(string_agg(t, ' '), '') as text from (
         select payload::text as t from audit_log where org_id in ($1, $2)
         union all select row_to_json(c)::text from portal_credentials c where org_id in ($1, $2)
         union all select row_to_json(c)::text from portal_connections c where org_id in ($1, $2)
         union all select row_to_json(r)::text from portal_read_runs r where org_id in ($1, $2)
         union all select row_to_json(p)::text from portal_captures p where org_id in ($1, $2)
       ) rows`,
      [orgA, orgB],
    );
    expect(rows[0]?.text.length).toBeGreaterThan(0);
    for (const secret of SECRETS) expect(rows[0]?.text).not.toContain(secret);
  });
});
