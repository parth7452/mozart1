/**
 * The test-database guard: the one answer to "may a test run write here?".
 *
 * On 2026-09-25 at 22:46 UTC the Postgres integration tests ran against
 * production as its owner, because a clone's `.env` named production in
 * `DATABASE_URL`, `vitest.setup.ts` loaded `.env`, and the Stop hook runs
 * `pnpm test` after every Claude Code turn. The tests skipped only when the
 * variable was unset; nothing asked whether it was a throwaway. Their fixtures
 * are append-only, so what they wrote is there for good
 * (`docs/audits/tests-against-production/`).
 *
 * So the tests no longer read the operator's variable at all. They read
 * `TEST_DATABASE_URL`, and before any test file loads (`vitest.global-setup.ts`)
 * and before `pnpm db:test` applies a migration (`check-test-database.ts`), this
 * refuses — throws, and the run fails — unless every one of these holds:
 *
 * - `RECOUPLE_TEST_DATABASE=1`, an explicit statement that the URL is a
 *   throwaway. A URL without it is refused, not skipped, and so is the flag
 *   without a URL, because in CI that combination means the integration tests
 *   would quietly skip.
 * - The host is not Supabase's (`*.supabase.co`, `*.supabase.com`, which covers
 *   the pooler). Decided from the URL, before anything connects.
 * - The database, asked read-only, has no `recouple_app` login (production's
 *   and the preview project's), no `supabase_admin` role (every Supabase
 *   cluster) and no applied migration in `supabase_migrations.schema_migrations`.
 *   `pnpm db:test`'s scratch database has none of the three.
 *
 * And, for a Vitest run only, `DATABASE_URL` must not be in the test process at
 * all: it is the variable the operator scripts and the app read, product code
 * under test reads it too, and a run that holds it can reach whatever it names.
 * The setup files never load it from `.env`; this refuses one exported by the
 * shell.
 *
 * There is no override. A database that trips a signal is not one a test run
 * should write to, and the fix is to point `TEST_DATABASE_URL` elsewhere.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';

/** The only variables a test run takes from `.env`. */
export const TEST_DATABASE_VARIABLES = ['TEST_DATABASE_URL', 'RECOUPLE_TEST_DATABASE'] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export class TestDatabaseRefused extends Error {
  override readonly name = 'TestDatabaseRefused';

  constructor(reason: string) {
    super(`test-database guard refused: ${reason}`);
  }
}

/**
 * Copies `TEST_DATABASE_URL` and `RECOUPLE_TEST_DATABASE` from `.env` into
 * `environment` where it does not already hold them, and nothing else — not
 * `DATABASE_URL`, and no vendor key a test could reach a live service with.
 * A missing `.env` is not an error; an unreadable one is.
 */
export function loadTestDatabaseVariables(envFile: string, environment: NodeJS.ProcessEnv): void {
  let text: string;
  try {
    text = readFileSync(envFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const parsed = parse(text);
  for (const name of TEST_DATABASE_VARIABLES) {
    const value = parsed[name];
    if (value !== undefined && value !== '' && environment[name] === undefined) {
      environment[name] = value;
    }
  }
}

const SUPABASE_HOST = /(^|\.)supabase\.(co|com)$/i;

/** The hosts a connection string names: its authority, and any `host=` parameter. */
function hostsOf(url: URL): string[] {
  const hosts = [url.hostname];
  for (const value of url.searchParams.getAll('host')) {
    hosts.push(...value.split(','));
  }
  return hosts.map((host) => host.trim().replace(/^\[|\]$/g, '')).filter((host) => host !== '');
}

/**
 * The checks that need no connection, for `TEST_DATABASE_URL`. Returns the URL
 * to test against, `undefined` when there is none (the Postgres tests skip), or
 * throws `TestDatabaseRefused`.
 */
export function testDatabaseUrlBeforeConnecting(environment: Environment): string | undefined {
  const url = environment.TEST_DATABASE_URL === '' ? undefined : environment.TEST_DATABASE_URL;
  const optedIn = environment.RECOUPLE_TEST_DATABASE;

  if (url === undefined) {
    if (optedIn === undefined || optedIn === '') return undefined;
    throw new TestDatabaseRefused(
      'RECOUPLE_TEST_DATABASE is set but TEST_DATABASE_URL is not, so every Postgres ' +
        'integration test would skip. Set TEST_DATABASE_URL to the scratch database ' +
        '`pnpm db:test` prepares, or unset RECOUPLE_TEST_DATABASE.',
    );
  }
  if (optedIn !== '1') {
    throw new TestDatabaseRefused(
      'TEST_DATABASE_URL is set without RECOUPLE_TEST_DATABASE=1. The integration tests ' +
        'write rows to append-only tables that can never be removed; set ' +
        'RECOUPLE_TEST_DATABASE=1 only once TEST_DATABASE_URL names a throwaway database.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TestDatabaseRefused('TEST_DATABASE_URL is not a postgres:// URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new TestDatabaseRefused('TEST_DATABASE_URL is not a postgres:// URL.');
  }
  const supabase = hostsOf(parsed).find((host) => SUPABASE_HOST.test(host));
  if (supabase !== undefined) {
    throw new TestDatabaseRefused(
      `TEST_DATABASE_URL names a Supabase host (${supabase}). Supabase projects are never ` +
        'a test database: point it at a local scratch Postgres, as `pnpm db:test` expects.',
    );
  }
  return url;
}

/**
 * `DATABASE_URL` is the operator scripts' and the app's variable. A Vitest run
 * refuses to hold it, whatever it names, because product code under test reads
 * it and would connect wherever it points.
 */
export function refuseOperatorDatabaseUrl(environment: Environment): void {
  const operator = environment.DATABASE_URL;
  if (operator === undefined || operator === '') return;
  throw new TestDatabaseRefused(
    'DATABASE_URL is set in the test process. It is the operator scripts\' and the app\'s ' +
      'database, and a test run must not be able to reach it: the integration tests read ' +
      'TEST_DATABASE_URL. Run `env -u DATABASE_URL pnpm test`.',
  );
}

interface Catalogue {
  recouple_app: boolean;
  supabase_admin: boolean;
  schema_migrations: boolean;
}

/**
 * Asks the database, read-only, whether it is somebody's real one. One
 * connection, one read-only transaction, nothing written.
 */
export async function refuseRealDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  let catalogue: Catalogue;
  try {
    await client.connect();
    await client.query('begin read only');
    const roles = await client.query<{ recouple_app: boolean; supabase_admin: boolean; migrations_table: boolean }>(
      `select exists (select 1 from pg_roles where rolname = 'recouple_app') as recouple_app,
              exists (select 1 from pg_roles where rolname = 'supabase_admin') as supabase_admin,
              to_regclass('supabase_migrations.schema_migrations') is not null as migrations_table`,
    );
    const row = roles.rows[0];
    if (row === undefined) throw new Error('the catalogue query returned no row');
    let applied = false;
    if (row.migrations_table) {
      const migrations = await client.query<{ applied: boolean }>(
        'select exists (select 1 from supabase_migrations.schema_migrations) as applied',
      );
      applied = migrations.rows[0]?.applied === true;
    }
    await client.query('rollback');
    catalogue = {
      recouple_app: row.recouple_app,
      supabase_admin: row.supabase_admin,
      schema_migrations: applied,
    };
  } catch (error) {
    throw new TestDatabaseRefused(
      `could not ask TEST_DATABASE_URL's catalogue whether it is a throwaway ` +
        `(${error instanceof Error ? error.message : String(error)}). A database the guard ` +
        'cannot inspect is not one the tests may write to.',
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  const found = [
    catalogue.recouple_app && 'a recouple_app login (production and the preview project have one)',
    catalogue.supabase_admin && 'a supabase_admin role (every Supabase cluster has one)',
    catalogue.schema_migrations && 'applied migrations in supabase_migrations.schema_migrations',
  ].filter((signal): signal is string => typeof signal === 'string');
  if (found.length > 0) {
    throw new TestDatabaseRefused(
      `TEST_DATABASE_URL's database has ${found.join('; ')}. \`pnpm db:test\`'s scratch ` +
        'database has none of these, so this is not one. Nothing was written.',
    );
  }
}

/**
 * The whole guard for a Vitest run: the operator's variable is absent, and the
 * test database, if there is one, is a throwaway. Returns the URL it checked.
 */
export async function guardTestRun(environment: Environment): Promise<string | undefined> {
  refuseOperatorDatabaseUrl(environment);
  const url = testDatabaseUrlBeforeConnecting(environment);
  if (url !== undefined) await refuseRealDatabase(url);
  return url;
}
