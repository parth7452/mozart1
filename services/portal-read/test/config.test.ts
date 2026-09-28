/**
 * What the worker reads from its environment at start (ADR 0057 §6), and what
 * it refuses to start as. main.test.ts spawns the entry point for the rest;
 * running as root is tested here because a test process that is not root
 * cannot start one that is.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkerConfigError, awsCredentialSource, readWorkerConfig } from '../src/config';
import { CHROMIUM, HAS_CHROMIUM, KEY_ARN, TOKEN } from './harness';

const complete = { PORTAL_READ_TOKEN: TOKEN, PORTAL_KMS_KEY_ID: KEY_ARN, PORTAL_CHROMIUM_PATH: CHROMIUM, PORT: '8080' };

describe.skipIf(!HAS_CHROMIUM)('readWorkerConfig', () => {
  it('reads everything the worker needs, with the launcher it hands the runner', () => {
    const config = readWorkerConfig(complete, { uid: 1000 });
    expect(config).toMatchObject({ token: TOKEN, keyId: KEY_ARN, keyRegion: 'us-east-1', port: 8080, executablePath: CHROMIUM });
    expect(config.launcherPath).toMatch(/launch-chromium\.sh$/);
  });

  it('refuses to run as root, where Chromium\'s sandbox will not start', () => {
    expect(() => readWorkerConfig(complete, { uid: 0 })).toThrow(WorkerConfigError);
    expect(() => readWorkerConfig(complete, { uid: 0 })).toThrow(/does not run as root/);
  });

  it('refuses a launcher it cannot execute, since it starts Chromium through nothing else', () => {
    const notExecutable = join(mkdtempSync(join(tmpdir(), 'portal-read-config-')), 'launch-chromium.sh');
    writeFileSync(notExecutable, '#!/bin/sh\n');
    chmodSync(notExecutable, 0o644);
    expect(() => readWorkerConfig(complete, { uid: 1000, launcherPath: notExecutable })).toThrow(/launcher .* is missing or not executable/);
    expect(() => readWorkerConfig(complete, { uid: 1000, launcherPath: join(tmpdir(), 'no-such-launcher.sh') })).toThrow(WorkerConfigError);
  });

  it('never names the token in a refusal', () => {
    try {
      readWorkerConfig({ ...complete, PORTAL_READ_TOKEN: `${TOKEN} x` }, { uid: 1000 });
    } catch (e) {
      expect(String(e)).not.toContain(TOKEN);
      return;
    }
    throw new Error('a token with a space was taken');
  });
});

describe('awsCredentialSource', () => {
  it.each([
    [{ AWS_ROLE_ARN: 'arn:aws:iam::111122223333:role/r', AWS_WEB_IDENTITY_TOKEN_FILE: '/.fly/oidc_token' }, 'web_identity'],
    [{ AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', AWS_SECRET_ACCESS_KEY: 'x' }, 'static_keys'],
    // The SDK takes static keys first when both are there.
    [{ AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', AWS_SECRET_ACCESS_KEY: 'x', AWS_ROLE_ARN: 'arn:aws:iam::111122223333:role/r', AWS_WEB_IDENTITY_TOKEN_FILE: '/t' }, 'static_keys'],
    [{ AWS_ROLE_ARN: 'arn:aws:iam::111122223333:role/r' }, 'provider_chain'],
    [{}, 'provider_chain'],
  ])('%j is %s', (env, source) => {
    expect(awsCredentialSource(env)).toBe(source);
  });
});
