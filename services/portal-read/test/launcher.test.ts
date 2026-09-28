/**
 * The launcher every browser of the worker's starts through
 * (`src/launch-chromium.sh`, ADR 0057 §6), against a stand-in for Chromium
 * that writes down the arguments and the environment it was started with:
 * Playwright's `--no-sandbox` dropped and everything else passed on as it
 * came, any other switch that turns the sandbox off refused, and an
 * environment of PATH, HOME, TMPDIR and the locale, whatever the worker's own
 * holds. main.test.ts shows the same of the real Chromium, through /proc.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_LAUNCHER } from '../src/browser';

const dir = mkdtempSync(join(tmpdir(), 'portal-read-launcher-'));
const REPORT = join(dir, 'report');
/**
 * Writes each argument and each variable of the environment it was started
 * with, one per line, to REPORT. The environment is read from what the kernel
 * kept of its start (`/proc/$$/environ`), because a shell adds variables of
 * its own (PWD) that Chromium, which is not one, would not have.
 */
const FAKE_CHROMIUM = join(dir, 'chrome');
writeFileSync(
  FAKE_CHROMIUM,
  `#!/bin/sh\n{ for arg do printf 'arg %s\\n' "$arg"; done; tr '\\0' '\\n' < /proc/$$/environ | sed 's/^/env /'; } > '${REPORT}'\n`,
);
chmodSync(FAKE_CHROMIUM, 0o755);

/** What the worker's environment might hold when Playwright starts the launcher. */
const WORKER_ENVIRONMENT = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/node',
  TMPDIR: '/tmp/worker',
  LANG: 'C.UTF-8',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_ROLE_ARN: 'arn:aws:iam::111122223333:role/recouple-portal-read',
  AWS_WEB_IDENTITY_TOKEN_FILE: '/.fly/oidc_token',
  PORTAL_READ_TOKEN: 'a'.repeat(64),
  PORTAL_KMS_KEY_ID: 'arn:aws:kms:us-east-1:111122223333:key/0f8fad5b-d9cb-469f-a165-70867728950e',
  PORTAL_CHROMIUM_PATH: FAKE_CHROMIUM,
};

function launch(args: string[], env: Record<string, string> = WORKER_ENVIRONMENT) {
  writeFileSync(REPORT, '');
  const run = spawnSync(BROWSER_LAUNCHER, args, { env, encoding: 'utf8' });
  const lines = readFileSync(REPORT, 'utf8').split('\n').filter((line) => line !== '');
  return {
    status: run.status,
    stderr: run.stderr,
    args: lines.filter((line) => line.startsWith('arg ')).map((line) => line.slice(4)),
    env: Object.fromEntries(lines.filter((line) => line.startsWith('env ')).map((line) => [line.slice(4, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])),
  };
}

// The stand-in reads its environment from /proc, which Linux has; the worker's image is Linux.
describe.skipIf(!existsSync('/proc/self/environ'))('the browser launcher', () => {
  it('drops Playwright\'s --no-sandbox and passes every other argument on as it came', () => {
    const run = launch(['--headless', '--no-sandbox', '--user-data-dir=/tmp/playwright profile', '--proxy-server=http://127.0.0.1:1', '--remote-debugging-pipe', '--no-startup-window']);
    expect(run.status).toBe(0);
    expect(run.args).toEqual(['--headless', '--user-data-dir=/tmp/playwright profile', '--proxy-server=http://127.0.0.1:1', '--remote-debugging-pipe', '--no-startup-window']);
  });

  it('starts Chromium with PATH, HOME, TMPDIR and the locale, and nothing of the worker\'s configuration', () => {
    const run = launch(['--headless', '--no-sandbox']);
    expect(run.env).toEqual({ PATH: WORKER_ENVIRONMENT.PATH, HOME: WORKER_ENVIRONMENT.HOME, TMPDIR: WORKER_ENVIRONMENT.TMPDIR, LANG: 'C.UTF-8' });
  });

  it.each([
    '--disable-seccomp-filter-sandbox',
    '--disable-namespace-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu-sandbox',
    '--single-process',
    '--no-zygote',
    '--no-zygote=1',
  ])('refuses to start Chromium with %s, and says which switch without a value', (switchName) => {
    const run = launch(['--headless', switchName]);
    expect(run.status).toBe(64);
    expect(run.args).toEqual([]);
    expect(run.stderr).toContain(`refusing to start Chromium with ${switchName.split('=')[0]}`);
  });

  it.each([
    ['a relative path', 'chrome'],
    ['no path at all', ''],
    ['a path that is not executable', REPORT],
  ])('refuses %s to Chromium', (_what, path) => {
    const run = launch(['--headless'], { ...WORKER_ENVIRONMENT, PORTAL_CHROMIUM_PATH: path });
    expect(run.status).toBe(64);
    expect(run.args).toEqual([]);
    expect(run.stderr).not.toContain(WORKER_ENVIRONMENT.AWS_SECRET_ACCESS_KEY);
  });
});
