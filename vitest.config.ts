import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The web app's views are server-rendered React; the tests render them with
  // react-dom/server, so JSX has to compile in the test transform too.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // The Postgres integration tests open real connections; give them room.
    testTimeout: 30_000,
  },
});
