import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  NotAMemberError,
  UnknownOrganizationError,
  resolveOperator,
} from '../src/operator';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX = `${ROOT}node_modules/.bin/tsx`;

/**
 * The operator commands, on the login `docs/supabase.md` prescribes (ADR 0034).
 *
 * Every other Postgres test here connects as whatever `DATABASE_URL` names,
 * which in CI is the owner — so a command that reads past RLS on a raw
 * connection passes every one of them and fails in production with "permission
 * denied for schema app". This test makes the production login itself: a fresh
 * role that can log in and may `set role` to `app_rw` or `app_ro` but inherits
 * neither, with no privileges of its own, exactly like `recouple_app`. Then it
 * runs each command's lookup path, and each command, as that login.
 *
 * It also asks the old lookup of that login and expects it to fail. Without
 * that, a harness that quietly connected as the owner would pass this file too.
 */
describeDb('operator commands on the prescribed login', () => {
  const admin = new Pool({ connectionString });
  const suffix = randomUUID().slice(0, 8);
  const loginRole = `rc_link_${suffix}`;
  const password = randomBytes(18).toString('hex');
  let loginUrl: string;

  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const outsiderId = randomUUID();
  const slug = `oplink-${suffix}`;
  const otherSlug = `oplink-other-${suffix}`;
  const analystEmail = `oplink-a-${suffix}@example.test`;
  const readerEmail = `oplink-r-${suffix}@example.test`;
  const outsiderEmail = `oplink-o-${suffix}@example.test`;
  const printedName = `OPLINK STORES ${suffix}, INC.`;

  beforeAll(async () => {
    // Quoted identifiers are not needed: the name is lower-case letters, digits
    // and underscores by construction. The password is hex.
    // Exactly production's `recouple_app`, read from its catalogue on
    // 2026-09-22: NOINHERIT, and each membership `inherit false, set true`. It
    // holds nothing until it says `set role`. A default `grant app_rw to …`
    // would inherit app_rw's privileges outright and hide the bug this is for.
    await admin.query(`create role ${loginRole} login noinherit password '${password}'`);
    await admin.query(`grant app_rw to ${loginRole} with inherit false, set true`);
    await admin.query(`grant app_ro to ${loginRole} with inherit false, set true`);

    const url = new URL(connectionString as string);
    url.username = loginRole;
    url.password = password;
    loginUrl = url.toString();

    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Op Link'), ($3,$4,'Op Link Other')`,
      [orgId, slug, otherOrgId, otherSlug],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId, analystEmail,
      readerId, readerEmail,
      outsiderId, outsiderEmail,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, outsiderId],
    );
    await admin.query(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1,'oplink_retailer','Op Link Retailer'), ($2,'other_only','Other Only')`,
      [orgId, otherOrgId],
    );
    await admin.query(
      `insert into deductions (org_id, deduction_amount_cents, retailer_name_as_printed)
       values ($1, 312000, $2)`,
      [orgId, printedName],
    );
  });

  afterAll(async () => {
    await closeAllPools();
    // The role owns nothing: every row it wrote is in the tenant's tables, owned
    // by the schema owner. Dropping it only needs its memberships gone.
    await admin.query(`drop role if exists ${loginRole}`).catch(() => undefined);
    await admin.end();
  });

  it('is really the restricted login: the old raw lookup is refused on it', async () => {
    const login = new Pool({ connectionString: loginUrl, max: 1 });
    try {
      const who = await login.query<{ current_user: string; super: boolean }>(
        `select current_user, (select rolsuper from pg_roles where rolname = current_user) as super`,
      );
      expect(who.rows[0]).toEqual({ current_user: loginRole, super: false });
      await expect(
        login.query(`select id from organizations where slug = $1`, [slug]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await login.end();
    }
  });

  it('resolves a member through app.member_for_link as app_rw', async () => {
    const config = { connectionString: loginUrl };
    await expect(resolveOperator(config, { slug, email: analystEmail.toUpperCase() })).resolves
      .toEqual({ orgId, userId: analystId, role: 'analyst' });
    await expect(resolveOperator(config, { slug, email: readerEmail })).resolves.toEqual({
      orgId,
      userId: readerId,
      role: 'read_only',
    });
    await expect(resolveOperator(config, { slug: `nope-${suffix}`, email: analystEmail }))
      .rejects.toBeInstanceOf(UnknownOrganizationError);
    // A member of another org is not a member here.
    await expect(resolveOperator(config, { slug, email: outsiderEmail }))
      .rejects.toBeInstanceOf(NotAMemberError);
  });

  it('reads the debtor half of link:retailer through RLS, one tenant only', async () => {
    const store = new PostgresStore(
      { connectionString: loginUrl },
      { orgId, userId: analystId },
    );
    await expect(store.debtorByRetailerKey('oplink_retailer')).resolves.toMatchObject({
      displayName: 'Op Link Retailer',
    });
    await expect(store.debtorByRetailerKey('other_only')).resolves.toBeUndefined();
    await expect(store.retailerKeys()).resolves.toEqual(['oplink_retailer']);
    await expect(store.countUnmatchedCases()).resolves.toBe(1);
  });

  /** Runs one command as the restricted login, from a directory with no `.env`. */
  async function command(script: string, args: string[], env: Record<string, string> = {}) {
    try {
      const { stdout, stderr } = await run(TSX, [`${ROOT}scripts/${script}`, ...args], {
        cwd: tmpdir(),
        env: { ...process.env, ...env, DATABASE_URL: loginUrl, DOTENV_CONFIG_QUIET: 'true' },
        timeout: 60_000,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  it('link:retailer runs end to end, and still refuses read_only and unknown orgs', async () => {
    const dry = await command('link-retailer.ts', [
      '--org', slug, '--as', analystEmail,
      '--retailer', 'oplink_retailer', '--alias', printedName, '--dry-run',
    ]);
    expect(dry.stderr).toBe('');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('would add alias');
    expect(dry.stdout).toContain('1 unmatched case(s) would be re-checked');

    const real = await command('link-retailer.ts', [
      '--org', slug, '--as', analystEmail,
      '--retailer', 'oplink_retailer', '--alias', printedName,
    ]);
    expect(real.stderr).toBe('');
    expect(real.code).toBe(0);
    expect(real.stdout).toContain('1 resolved, 0 blocked, 0 still unmatched');

    const reader = await command('link-retailer.ts', ['--org', slug, '--as', readerEmail, '--backfill-only']);
    expect(reader.code).toBe(1);
    expect(reader.stderr).toContain('is read_only');

    const unknown = await command('link-retailer.ts', [
      '--org', `nope-${suffix}`, '--as', analystEmail, '--backfill-only',
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no organization with slug');

    const outsider = await command('link-retailer.ts', ['--org', slug, '--as', outsiderEmail, '--backfill-only']);
    expect(outsider.code).toBe(1);
    expect(outsider.stderr).toContain(`${outsiderEmail} is not a member of ${slug}`);
  }, 120_000);

  it('link:provenance lists as the restricted login', async () => {
    const listed = await command('link-provenance.ts', ['--org', slug, '--as', analystEmail, '--list']);
    expect(listed.stderr).toBe('');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('0 document(s) record no arrival');

    const reader = await command('link-provenance.ts', ['--org', slug, '--as', readerEmail, '--list']);
    expect(reader.code).toBe(1);
    expect(reader.stderr).toContain('is read_only');
  }, 60_000);

  it('link:qbo dry-runs as the restricted login without touching KMS', async () => {
    const env = {
      QBO_REALM_ID: `realm-${suffix}`,
      QBO_REFRESH_TOKEN: 'not-a-token',
      QBO_TOKEN_KMS_KEY_ID: 'alias/not-a-key',
      QBO_ACCESS_TOKEN: '',
    };
    const dry = await command('link-qbo.ts', ['--org', slug, '--as', analystEmail, '--dry-run'], env);
    expect(dry.stderr).toBe('');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain(`would connect a QuickBooks company to org ${orgId} as member ${analystId}`);

    const reader = await command('link-qbo.ts', ['--org', slug, '--as', readerEmail, '--dry-run'], env);
    expect(reader.code).toBe(1);
    expect(reader.stderr).toContain('is read_only');
  }, 60_000);
});
