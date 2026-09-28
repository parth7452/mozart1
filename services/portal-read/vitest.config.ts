// The worker's tests, under the repository's own test configuration: the same
// test-database guard runs before any test file loads, and the same setup file
// runs in every test worker. Only `include` is the worker's.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import repository from '../../vitest.config';

export default defineConfig({
  ...repository,
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    ...repository.test,
    include: ['services/portal-read/test/**/*.test.ts'],
  },
});
