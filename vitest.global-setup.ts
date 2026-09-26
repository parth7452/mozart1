// Runs once, in Vitest's main process, before any test file is loaded. A
// refusal here aborts the whole run before a single test statement is sent
// (scripts/test-database.ts says what is refused and why).
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { guardTestRun, loadTestDatabaseVariables } from './scripts/test-database';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The TEST_DATABASE_URL the guard checked, or null when there is none. */
    guardedTestDatabaseUrl: string | null;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  loadTestDatabaseVariables(fileURLToPath(new URL('./.env', import.meta.url)), process.env);
  const url = await guardTestRun(process.env);
  project.provide('guardedTestDatabaseUrl', url ?? null);
}
