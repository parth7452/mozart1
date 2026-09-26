import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The web app's views are server-rendered React; the tests render them with
  // react-dom/server, so JSX has to compile in the test transform too.
  esbuild: { jsx: 'automatic' },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.tsx',
      'scripts/test/**/*.test.ts',
    ],
    environment: 'node',
    // The test-database guard (scripts/test-database.ts): refuses, before any
    // test file loads, a run that could reach a database that is not a
    // throwaway. The setup file then ties each worker to the URL it checked.
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // The Postgres integration tests open real connections; give them room.
    testTimeout: 30_000,
  },
});
