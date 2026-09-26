import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TestDatabaseRefused,
  guardTestRun,
  loadTestDatabaseVariables,
  refuseOperatorDatabaseUrl,
  refuseRealDatabase,
  testDatabaseUrlBeforeConnecting,
} from '../test-database';

/**
 * The test-database guard (docs/audits/tests-against-production/). What it
 * refuses without connecting is asked here directly; the catalogue signals
 * (`recouple_app`, `supabase_admin`, applied Supabase migrations) are
 * cluster-wide state this suite's own database must not carry, so the PR that
 * added the guard shows each one refused by hand, and this asks only that a
 * database the guard cannot reach is refused rather than waved through.
 */
const SCRATCH = 'postgres://postgres:postgres@127.0.0.1:5432/recouple_test';

describe('the test-database guard, before it connects', () => {
  it('lets a run with no test database through, and the Postgres tests skip', () => {
    expect(testDatabaseUrlBeforeConnecting({})).toBeUndefined();
    expect(testDatabaseUrlBeforeConnecting({ TEST_DATABASE_URL: '' })).toBeUndefined();
  });

  it('returns a local URL that was opted into', () => {
    expect(
      testDatabaseUrlBeforeConnecting({ TEST_DATABASE_URL: SCRATCH, RECOUPLE_TEST_DATABASE: '1' }),
    ).toBe(SCRATCH);
  });

  it('refuses a URL nobody opted into, with anything but exactly 1', () => {
    for (const optIn of [undefined, '', '0', 'true', 'yes']) {
      expect(() =>
        testDatabaseUrlBeforeConnecting({ TEST_DATABASE_URL: SCRATCH, RECOUPLE_TEST_DATABASE: optIn }),
      ).toThrow(/RECOUPLE_TEST_DATABASE=1/);
    }
  });

  it('refuses the opt-in without a URL, which in CI would skip every integration test', () => {
    expect(() => testDatabaseUrlBeforeConnecting({ RECOUPLE_TEST_DATABASE: '1' })).toThrow(
      /would skip/,
    );
  });

  it('refuses every Supabase host, direct or pooled, however it is written', () => {
    for (const url of [
      'postgres://postgres:x@db.hvheqbgkvwhlqutklwfh.supabase.co:5432/postgres',
      'postgresql://postgres.hvheqbgkvwhlqutklwfh:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      'postgres://postgres:x@DB.ABC.SUPABASE.CO/postgres',
      'postgres://postgres:x@localhost/postgres?host=db.abc.supabase.co',
    ]) {
      expect(() =>
        testDatabaseUrlBeforeConnecting({ TEST_DATABASE_URL: url, RECOUPLE_TEST_DATABASE: '1' }),
      ).toThrow(TestDatabaseRefused);
    }
  });

  it('does not mistake a host that only contains the word for Supabase', () => {
    const url = 'postgres://postgres:x@notsupabase.co.example.test/postgres';
    expect(
      testDatabaseUrlBeforeConnecting({ TEST_DATABASE_URL: url, RECOUPLE_TEST_DATABASE: '1' }),
    ).toBe(url);
  });

  it('refuses something that is not a postgres URL', () => {
    for (const url of ['not a url', 'mysql://root@127.0.0.1/db']) {
      expect(() =>
        testDatabaseUrlBeforeConnecting({ TEST_DATABASE_URL: url, RECOUPLE_TEST_DATABASE: '1' }),
      ).toThrow(/not a postgres:\/\/ URL/);
    }
  });

  it("refuses a test process that holds the operator's DATABASE_URL, whatever it names", () => {
    expect(() => refuseOperatorDatabaseUrl({ DATABASE_URL: SCRATCH })).toThrow(
      /env -u DATABASE_URL pnpm test/,
    );
    expect(() => refuseOperatorDatabaseUrl({})).not.toThrow();
    expect(() => refuseOperatorDatabaseUrl({ DATABASE_URL: '' })).not.toThrow();
  });

  it('names itself, so a failed run says which gate stopped it', () => {
    expect(() => refuseOperatorDatabaseUrl({ DATABASE_URL: SCRATCH })).toThrow(
      /^test-database guard refused: /,
    );
  });
});

describe('what a test run takes from .env', () => {
  function envFile(text: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'rc-guard-')), '.env');
    writeFileSync(path, text);
    return path;
  }

  it("takes the two test variables and nothing else — not the operator's DATABASE_URL, no vendor key", () => {
    const path = envFile(
      [
        'DATABASE_URL=postgres://postgres:x@db.hvheqbgkvwhlqutklwfh.supabase.co:5432/postgres',
        `TEST_DATABASE_URL=${SCRATCH}`,
        'RECOUPLE_TEST_DATABASE=1',
        'ANTHROPIC_API_KEY=sk-live',
      ].join('\n'),
    );
    const environment: NodeJS.ProcessEnv = {};
    loadTestDatabaseVariables(path, environment);
    expect(environment).toEqual({ TEST_DATABASE_URL: SCRATCH, RECOUPLE_TEST_DATABASE: '1' });
  });

  it('never overrides what the environment already says', () => {
    const path = envFile(`TEST_DATABASE_URL=postgres://elsewhere/db\nRECOUPLE_TEST_DATABASE=1\n`);
    const environment: NodeJS.ProcessEnv = { TEST_DATABASE_URL: SCRATCH };
    loadTestDatabaseVariables(path, environment);
    expect(environment).toEqual({ TEST_DATABASE_URL: SCRATCH, RECOUPLE_TEST_DATABASE: '1' });
  });

  it('treats a missing .env as nothing to load', () => {
    const environment: NodeJS.ProcessEnv = {};
    loadTestDatabaseVariables(join(tmpdir(), `rc-guard-missing-${process.pid}`, '.env'), environment);
    expect(environment).toEqual({});
  });
});

describe('the test-database guard, when it connects', () => {
  it('refuses a database it cannot inspect rather than assuming it is a throwaway', async () => {
    await expect(refuseRealDatabase('postgres://postgres:x@127.0.0.1:1/nothing')).rejects.toThrow(
      /could not ask TEST_DATABASE_URL's catalogue/,
    );
  });

  it('refuses the operator variable before it opens any connection', async () => {
    // An unroutable test URL: if the guard connected first, this would be the
    // catalogue refusal instead.
    await expect(
      guardTestRun({
        DATABASE_URL: 'postgres://postgres:x@db.abc.supabase.co/postgres',
        TEST_DATABASE_URL: 'postgres://postgres:x@127.0.0.1:1/nothing',
        RECOUPLE_TEST_DATABASE: '1',
      }),
    ).rejects.toThrow(/DATABASE_URL is set in the test process/);
  });
});
