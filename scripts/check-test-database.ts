/**
 * `pnpm db:test`'s half of the test-database guard (`scripts/test-database.ts`).
 *
 * Reads `TEST_DATABASE_URL` and `RECOUPLE_TEST_DATABASE` from the environment,
 * else `.env`, refuses anything that is not a throwaway, and prints the URL it
 * checked on stdout for `scripts/db-test.sh` to apply the migrations to. A
 * refusal, or no URL at all, exits 1 with the reason on stderr and prints
 * nothing.
 */
import { fileURLToPath } from 'node:url';
import {
  TestDatabaseRefused,
  loadTestDatabaseVariables,
  refuseRealDatabase,
  testDatabaseUrlBeforeConnecting,
} from './test-database';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

try {
  loadTestDatabaseVariables(`${ROOT}.env`, process.env);
  const url = testDatabaseUrlBeforeConnecting(process.env);
  if (url === undefined) {
    throw new TestDatabaseRefused(
      'set TEST_DATABASE_URL to a scratch Postgres database owned by the connecting role, ' +
        'and RECOUPLE_TEST_DATABASE=1.',
    );
  }
  await refuseRealDatabase(url);
  process.stdout.write(`${url}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
