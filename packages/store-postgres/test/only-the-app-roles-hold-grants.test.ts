import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATION_0028 = readFileSync(
  `${ROOT}supabase/migrations/20260922110000_0028_only_the_app_roles_hold_grants.sql`,
  'utf8',
);

/**
 * Migration 0028's lock-out tripwire, exercised rather than admired (ADR 0037 §5).
 *
 * 0028 revokes `authenticated`'s membership in `app_rw`. That is right for
 * `authenticator`, which reaches `app_rw` only that way and must stop, and it
 * would be a production outage for the application's own login if that login
 * had been set up the same way. Production's `recouple_app` holds the app
 * roles directly; this is the check that the migration refuses — and changes
 * nothing — if it ever does not, and that it goes through when it does.
 *
 * `db:test` applies 0028 on every run but can never reach this branch: nothing
 * there is named `recouple_app`. So each case builds the shape inside a
 * transaction, applies the migration's own text to it, and rolls everything
 * back — roles included, since CREATE ROLE is transactional.
 */
describeDb("migration 0028 never locks the application out", () => {
  const admin = new Pool({ connectionString });

  async function inTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await work(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  async function canSet(client: PoolClient, role: string, appRole: string): Promise<boolean> {
    const { rows } = await client.query<{ ok: boolean }>(
      `select pg_has_role($1, $2, 'SET') as ok`,
      [role, appRole],
    );
    return rows[0]?.ok === true;
  }

  async function isMember(client: PoolClient, role: string, appRole: string): Promise<boolean> {
    const { rows } = await client.query<{ ok: boolean }>(
      `select pg_has_role($1, $2, 'MEMBER') as ok`,
      [role, appRole],
    );
    return rows[0]?.ok === true;
  }

  beforeAll(async () => {
    // Loud rather than skipped: without these roles the migration has nothing
    // to revoke and every case below would pass by default.
    const { rows } = await admin.query<{ rolname: string }>(
      `select rolname from pg_roles
        where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'recouple_app')
        order by rolname`,
    );
    const present = rows.map((row) => row.rolname);
    expect(present, 'run pnpm db:test first: it creates Supabase\'s roles').toEqual(
      expect.arrayContaining(['anon', 'authenticated', 'authenticator', 'service_role']),
    );
    expect(
      present.includes('recouple_app'),
      'this cluster already has a recouple_app role; point TEST_DATABASE_URL at a throwaway cluster',
    ).toBe(false);
  });

  afterAll(async () => {
    await admin.end();
  });

  it('refuses, and revokes nothing, when the app login reaches app_rw only through authenticated', async () => {
    await inTransaction(async (client) => {
      await client.query('grant app_rw to authenticated');
      await client.query('create role recouple_app login noinherit');
      await client.query('grant authenticated to recouple_app');
      expect(await canSet(client, 'recouple_app', 'app_rw')).toBe(true);

      await client.query('savepoint before_0028');
      await expect(client.query(MIGRATION_0028)).rejects.toThrow(
        /would lock the application out: recouple_app could set role app_rw/,
      );
      await client.query('rollback to savepoint before_0028');

      // All or nothing: the revokes ran in the same statement as the check
      // that refused them, so the membership the refusal was about is intact.
      expect(await isMember(client, 'authenticated', 'app_rw')).toBe(true);
      expect(await canSet(client, 'recouple_app', 'app_rw')).toBe(true);
    });
  });

  it('says what to do about it, and it is never "grant it to authenticator"', async () => {
    await inTransaction(async (client) => {
      await client.query('grant app_rw to authenticated');
      await client.query('create role recouple_app login noinherit');
      await client.query('grant authenticated to recouple_app');
      const failure = await client.query(MIGRATION_0028).then(
        () => undefined,
        (error: unknown) => error as { hint?: string },
      );
      expect(failure?.hint).toMatch(
        /grant app_rw to recouple_app with inherit false, set true \(docs\/supabase\.md\)/,
      );
      expect(failure?.hint).toMatch(/Never grant an app role to authenticator/);
    });
  });

  it('goes through when the app login holds app_rw directly, and closes the other door', async () => {
    await inTransaction(async (client) => {
      await client.query('grant app_rw to authenticated');
      await client.query('create role recouple_app login noinherit');
      await client.query('grant authenticated to recouple_app');
      await client.query('grant app_rw to recouple_app with inherit false, set true');
      await client.query('grant app_ro to recouple_app with inherit false, set true');
      expect(await canSet(client, 'authenticator', 'app_rw')).toBe(true);

      await client.query(MIGRATION_0028);

      expect(await canSet(client, 'recouple_app', 'app_rw')).toBe(true);
      expect(await canSet(client, 'recouple_app', 'app_ro')).toBe(true);
      expect(await isMember(client, 'authenticated', 'app_rw')).toBe(false);
      // PostgREST's login can no longer become the application, whatever role
      // claim a token minted with the JWT secret carries.
      expect(await canSet(client, 'authenticator', 'app_rw')).toBe(false);
    });
  });
});
