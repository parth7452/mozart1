import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import workspace from '../../vitest.config';

/**
 * The repository's Vitest config, for a run started in this directory:
 * `pnpm --filter @recouple/store-postgres exec vitest run test/posting`, or
 * this package's `test` script.
 *
 * Without it Vitest finds the root's config from here but reads its include
 * globs against this directory, and finds no test at all. So the root stays
 * the repository's — where the test-database guard and the setup file are,
 * which no run may go without — and only where test files are looked for is
 * this package: a filter then names them as this directory sees them. A run
 * from the repository root never reads this file.
 */
export default defineConfig({
  ...workspace,
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    ...workspace.test,
    dir: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
  },
});
