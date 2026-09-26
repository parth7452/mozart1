// Runs in every test worker, before each test file. It takes exactly two
// variables from .env — TEST_DATABASE_URL and RECOUPLE_TEST_DATABASE — and
// never DATABASE_URL, which is the operator scripts' and the app's: on
// 2026-09-25 this file loaded all of .env, a clone's DATABASE_URL named
// production, and the Stop hook ran the integration tests there
// (docs/audits/tests-against-production/). Tests that need a database read
// TEST_DATABASE_URL and skip themselves when it is unset.
//
// vitest.global-setup.ts has already refused anything that is not a throwaway.
// This only makes sure a worker tests against the URL that was checked.
import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import {
  TestDatabaseRefused,
  loadTestDatabaseVariables,
  refuseOperatorDatabaseUrl,
} from './scripts/test-database';

loadTestDatabaseVariables(fileURLToPath(new URL('./.env', import.meta.url)), process.env);
refuseOperatorDatabaseUrl(process.env);
if ((process.env.TEST_DATABASE_URL || null) !== inject('guardedTestDatabaseUrl')) {
  throw new TestDatabaseRefused(
    'this worker\'s TEST_DATABASE_URL is not the one vitest.global-setup.ts checked.',
  );
}
