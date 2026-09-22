import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { QboAccountingSource, INTUIT_TOKEN_URL, type QboTokens } from '@recouple/qbo';
import { TokenDecryptionError } from '@recouple/crypto';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import {
  CredentialUnreadableError,
  PostgresQboTokenStore,
  QboRealmMismatchError,
} from '../src/credentials';
import { PostgresLedgerSyncStore } from '../src/connections';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The QuickBooks token store, against a real database (ADR 0033, migration
 * 0025).
 *
 * `supabase/tests/21` asks the schema its questions in SQL. This asks the ones
 * only the driver and the cipher together can answer: does a token set written
 * through `save` come back out of `load` byte for byte, is a rotation visibly a
 * second row with the first still there, is another tenant's connection
 * invisible rather than merely forbidden — and, the one this whole design
 * exists for, **does the rotated refresh token land in the database before the
 * next API call goes out** (ADR 0026).
 *
 * The cipher is `LocalTokenCipher`, from `@recouple/crypto/testing`, so nothing
 * here calls AWS. It does the same envelope encryption `KmsTokenCipher` does
 * over the same AES-GCM framing; what differs is who holds the wrapping key
 * (ADR 0033 §4).
 */
describeDb('the QuickBooks token store on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);

  const connectionId = randomUUID();
  const emptyConnectionId = randomUUID();
  const otherConnectionId = randomUUID();

  const realmId = `realm-${suffix}`;
  const otherRealmId = `realm-other-${suffix}`;

  const config = { connectionString: connectionString as string };
  const cipher = new LocalTokenCipher({ keyId: 'local-test-key' });

  let store: PostgresQboTokenStore;
  let empty: PostgresQboTokenStore;
  let otherTenantsConnection: PostgresQboTokenStore;

  function tokens(overrides: Partial<QboTokens> = {}): QboTokens {
    return {
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      accessExpiresAt: '2026-09-22T18:00:00.000Z',
      refreshExpiresAt: '2026-12-31T00:00:00.000Z',
      ...overrides,
    };
  }

  /**
   * Every stored row for a connection, newest first, straight off the table.
   *
   * The ordering column is not aliased `seq`: Postgres resolves `order by` to
   * an output alias first, so `seq::text as seq` would sort the identity column
   * as text and put row 9 after row 10. It cost this test one confusing
   * failure, which is cheap compared with the same mistake in `load`.
   */
  async function rows(id: string): Promise<
    Array<{ id: string; cipher: string; key_id: string; ciphertext: string; seq_text: string }>
  > {
    const { rows: found } = await admin.query<{
      id: string;
      cipher: string;
      key_id: string;
      ciphertext: string;
      seq_text: string;
    }>(
      `select id, cipher, key_id, ciphertext, seq::text as seq_text
         from accounting_credentials where connection_id = $1 order by seq desc`,
      [id],
    );
    return found;
  }

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Sealed'), ($3,$4,'Sealed Other')`,
      [orgId, `seal-${suffix}`, otherOrgId, `seal-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `seal-a-${suffix}@example.test`,
      otherAnalystId,
      `seal-o-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, analystId, otherOrgId, otherAnalystId],
    );
    await admin.query(
      `insert into accounting_connections (id, org_id, provider, provider_account_id, created_by)
       values ($1,$2,'qbo',$3,$4), ($5,$2,'qbo',$6,$4), ($7,$8,'qbo',$9,$10)`,
      [
        connectionId, orgId, realmId, analystId,
        emptyConnectionId, `realm-empty-${suffix}`,
        otherConnectionId, otherOrgId, otherRealmId, otherAnalystId,
      ],
    );

    const tenant = { orgId, userId: analystId };
    store = new PostgresQboTokenStore(config, tenant, { connectionId, realmId }, cipher);
    empty = new PostgresQboTokenStore(
      config,
      tenant,
      { connectionId: emptyConnectionId, realmId: `realm-empty-${suffix}` },
      cipher,
    );
    // Org A's claims, pointed at org B's connection. RLS is what must refuse
    // it, not a filter this file remembered to write.
    otherTenantsConnection = new PostgresQboTokenStore(
      config,
      tenant,
      { connectionId: otherConnectionId, realmId: otherRealmId },
      cipher,
    );
  });

  afterAll(async () => {
    // Nothing is deleted, deliberately and not out of laziness:
    // `accounting_credentials` is append-only and the trigger refuses the owner
    // too, which is the property suite 21 asserts. The database `pnpm db:test`
    // points at is a throwaway, and every id here is fresh per run.
    await closeAllPools();
    await admin.end();
  });

  it('answers undefined for a connection nothing was ever stored for', async () => {
    // Not an empty token set and not a throw: `QboClient` turns this into
    // `QboAuthError` — "the connection has not been authorised" — which is a
    // different fact from "the ledger is empty" (ADR 0026).
    expect(await empty.load(`realm-empty-${suffix}`)).toBeUndefined();
  });

  it('round-trips a token set through the database', async () => {
    const written = tokens();
    await store.save(realmId, written);

    expect(await store.load(realmId)).toEqual(written);
  });

  it('writes ciphertext and nothing that reads like a token', async () => {
    // The assertion the whole migration exists for. Read straight off the
    // table, as the owner, bypassing RLS and this package's own code — which is
    // exactly the position somebody holding a database dump is in.
    const { rows: raw } = await admin.query<Record<string, unknown>>(
      `select * from accounting_credentials where connection_id = $1 order by seq desc limit 1`,
      [connectionId],
    );
    const row = raw[0];
    expect(row).toBeDefined();

    const everything = JSON.stringify(row);
    expect(everything).not.toContain('access-token-1');
    expect(everything).not.toContain('refresh-token-1');
    expect(everything).not.toContain('accessToken');
    expect(row?.cipher).toBe('local-aes-256-gcm');
    expect(row?.key_id).toBe('local-test-key');
  });

  it('makes a rotation a second row and leaves the first one there', async () => {
    const before = await rows(connectionId);
    const rotated = tokens({ accessToken: 'access-token-2', refreshToken: 'refresh-token-2' });
    await store.save(realmId, rotated);

    const after = await rows(connectionId);
    expect(after).toHaveLength(before.length + 1);
    // The earlier row is still present, unchanged: an append is not an
    // overwrite, which is the property that makes a crash here a retry rather
    // than a stranded customer (ADR 0033 §2).
    expect(after.map((r) => r.id)).toEqual(expect.arrayContaining(before.map((r) => r.id)));
    expect(after[0]?.id).not.toBe(before[0]?.id);

    // And the latest is what `load` answers with.
    expect(await store.load(realmId)).toEqual(rotated);
  });

  it('refuses a load or a save for a company this store is not for', async () => {
    // The port's signature takes a realm; this store answers for exactly one,
    // and a caller that built the store from one connection and the adapter
    // from another finds out by name rather than by reading somebody else's
    // tokens (ADR 0033 §5).
    await expect(store.load('9999999999')).rejects.toThrow(QboRealmMismatchError);
    await expect(store.save('9999999999', tokens())).rejects.toThrow(QboRealmMismatchError);

    // Nothing was written by the refused save.
    const after = await rows(connectionId);
    expect(after.every((r) => r.cipher === 'local-aes-256-gcm')).toBe(true);
  });

  it('cannot write a credential against another tenant’s connection', async () => {
    // Org A's claims, org B's connection. The insert names org A, the
    // connection is org B's, and `accounting_credentials_same_org` refuses it —
    // and RLS would refuse naming org B instead.
    await expect(otherTenantsConnection.save(otherRealmId, tokens())).rejects.toThrow();

    const { rows: leaked } = await admin.query(
      `select 1 from accounting_credentials where connection_id = $1`,
      [otherConnectionId],
    );
    expect(leaked).toHaveLength(0);
  });

  it('cannot read another tenant’s credential, which is simply not there', async () => {
    // Seeded as the owner so there is genuinely something to fail to see.
    const sealed = await cipher.encrypt(JSON.stringify(tokens()), {
      orgId: otherOrgId,
      realmId: otherRealmId,
    });
    await admin.query(
      `insert into accounting_credentials
         (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
          refresh_expires_at, created_by)
       values ($1,$2,$3,$4,$5,$6, now() + interval '90 days', $7)`,
      [
        otherOrgId,
        otherConnectionId,
        sealed.cipher,
        sealed.keyId,
        sealed.wrappedKey,
        sealed.ciphertext,
        otherAnalystId,
      ],
    );

    expect(await otherTenantsConnection.load(otherRealmId)).toBeUndefined();
  });

  it('refuses an update or a delete to app_rw, whatever this code asks', async () => {
    // The grants, exercised through the same role and pool the store uses. The
    // SQL suite proves the trigger; this proves the store's own connection is
    // not somehow a privileged one.
    const pooled = new Pool({ connectionString });
    try {
      const client = await pooled.connect();
      try {
        await client.query('begin');
        await client.query('set local role app_rw');
        await client.query('select set_config($1,$2,true)', [
          'request.jwt.claims',
          JSON.stringify({ org_id: orgId, sub: analystId }),
        ]);
        await expect(
          client.query(`update accounting_credentials set ciphertext = 'eA==' where org_id = $1`, [
            orgId,
          ]),
        ).rejects.toThrow(/permission denied/);
        await client.query('rollback');

        await client.query('begin');
        await client.query('set local role app_rw');
        await expect(
          client.query(`delete from accounting_credentials where org_id = $1`, [orgId]),
        ).rejects.toThrow(/permission denied/);
        await client.query('rollback');
      } finally {
        client.release();
      }
    } finally {
      await pooled.end();
    }
  });

  it('reports a row it cannot open as unreadable, not as no connection at all', async () => {
    // A key that was revoked, a region misconfigured, a row from another
    // deployment. Answering `undefined` here would send somebody to ask the
    // customer for consent they have already given (credentials.ts).
    const wrongKey = new PostgresQboTokenStore(
      config,
      { orgId, userId: analystId },
      { connectionId, realmId },
      new LocalTokenCipher({ keyId: 'local-test-key' }),
    );

    const error = await wrongKey
      .load(realmId)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CredentialUnreadableError);
    expect((error as CredentialUnreadableError).reason).toBe(TokenDecryptionError.name);
    // Ids only: not the ciphertext, not the wrapped key, not the plaintext.
    const latest = (await rows(connectionId))[0];
    expect((error as Error).message).not.toContain(latest?.ciphertext ?? 'nothing');
    expect((error as Error).message).not.toContain('refresh-token');
  });

  it('registers a connection through the same role, and finds it again', async () => {
    // `pnpm link:qbo`'s first half. `created_by` is the store's own member and
    // not a parameter: the connection names the person a scheduled sync will
    // act as (ADR 0031 §3).
    const tenant = { orgId, userId: analystId };
    const runs = new PostgresLedgerSyncStore(config, tenant, new PostgresStore(config, tenant));
    const account = `realm-new-${suffix}`;

    expect(await runs.connectionForAccount('qbo', account)).toBeUndefined();
    const made = await runs.createConnection({ provider: 'qbo', providerAccountId: account });

    expect(made.orgId).toBe(orgId);
    expect(made.createdBy).toBe(analystId);
    expect(made.enabled).toBe(true);
    expect((await runs.connectionForAccount('qbo', account))?.connectionId).toBe(made.connectionId);
  });
});

/**
 * The ordering ADR 0026 §"Tokens" is about, through a real database.
 *
 * The unit test in `packages/qbo` proves the adapter awaits `save` before it
 * uses the rotated access token. That one can pass with a store that keeps a
 * Map. This proves the rotated refresh token is **committed to Postgres**
 * before the next request leaves — observed by counting rows from *inside* the
 * fetch handler, which is the only place that ordering is visible.
 */
describeDb('a rotation lands in the database before the next API call', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const userId = randomUUID();
  const connectionId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const realmId = `realm-rot-${suffix}`;
  const config = { connectionString: connectionString as string };
  const now = new Date('2026-09-22T16:00:00.000Z');

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Rotation')`, [
      orgId,
      `rot-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1,$2)`, [
      userId,
      `rot-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`, [
      orgId,
      userId,
    ]);
    await admin.query(
      `insert into accounting_connections (id, org_id, provider, provider_account_id, created_by)
       values ($1,$2,'qbo',$3,$4)`,
      [connectionId, orgId, realmId, userId],
    );
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('persists the rotated refresh token before the ledger request goes out', async () => {
    const cipher = new LocalTokenCipher({ keyId: 'local-rotation-key' });
    const store = new PostgresQboTokenStore(
      config,
      { orgId, userId },
      { connectionId, realmId },
      cipher,
    );

    // One minute from expiry: inside the five-minute skew, so the next call
    // must refresh first (ADR 0026).
    await store.save(realmId, {
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      accessExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      refreshExpiresAt: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
    });

    const countRows = async (): Promise<number> => {
      const { rows } = await admin.query<{ n: string }>(
        `select count(*) as n from accounting_credentials where connection_id = $1`,
        [connectionId],
      );
      return Number(rows[0]?.n ?? 0);
    };

    expect(await countRows()).toBe(1);

    const order: string[] = [];
    let rowsWhenQueried = -1;

    const source = new QboAccountingSource({
      realmId,
      baseUrl: 'https://sandbox-quickbooks.api.intuit.com',
      clientId: 'client',
      clientSecret: 'secret',
      tokenStore: store,
      now: () => now,
      fetchImpl: async (input: string) => {
        if (input === INTUIT_TOKEN_URL) {
          order.push('refresh');
          return new Response(
            JSON.stringify({
              access_token: 'access-token-2',
              refresh_token: 'refresh-token-2',
              expires_in: 3600,
              x_refresh_token_expires_in: 8_726_400,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        order.push('query');
        // Inside the request. By now the rotation has to be a committed row,
        // because Intuit killed `refresh-token-1` the moment it issued
        // `refresh-token-2`.
        rowsWhenQueried = await countRows();
        return new Response(JSON.stringify({ QueryResponse: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(await source.listInvoices({ from: '2026-08-20', to: '2026-09-22' })).toEqual([]);

    expect(order).toEqual(['refresh', 'query']);
    expect(rowsWhenQueried).toBe(2);

    // And what is now current is the rotated pair, read back through the store.
    expect(await store.load(realmId)).toEqual({
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
      accessExpiresAt: new Date(now.getTime() + 3600 * 1000).toISOString(),
      refreshExpiresAt: new Date(now.getTime() + 8_726_400 * 1000).toISOString(),
    });
  });
});
