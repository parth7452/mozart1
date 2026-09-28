// The worker's configuration, read once, at start, from its environment (ADR
// 0057 §6, ADR 0062 §6). The worker refuses to start rather than come up half
// configured. Without its token it would be an open door, and without the
// portal key it could open nothing, while the app believed it had a worker.
//
// A refusal names the variable and the rule and never the value.
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { chromium } from 'playwright';
import { BROWSER_LAUNCHER } from './browser';
import { PORTAL_ENV, PORTAL_READ_TOKEN_MIN_LENGTH } from './portal';

/**
 * Where the worker's Chromium is, when it is not where `playwright install
 * chromium` put it. The worker sets it to the one it resolved, which is where
 * the launcher (`launch-chromium.sh`) finds it.
 */
export const CHROMIUM_PATH_ENV = 'PORTAL_CHROMIUM_PATH';

/**
 * Variables that turn on logging that would print what the browser types or a
 * request carries: Playwright's `pw:api` channel logs every `fill`, its value
 * included, and `PWDEBUG` opens the inspector. The worker does not start with
 * any of them set.
 */
export const DEBUG_VARIABLES = ['DEBUG', 'PWDEBUG', 'NODE_DEBUG'] as const;

export interface WorkerConfig {
  /** The bearer token every route but `/health` requires. */
  readonly token: string;
  /**
   * The portal key's ARN. It is what KMS names when the app seals a credential,
   * and so what every sealed credential this worker opens must name.
   */
  readonly keyId: string;
  /** The key's region, read from its ARN, so the KMS client asks the region that holds the key. */
  readonly keyRegion: string;
  readonly port: number;
  /** The Chromium every run drives, as an absolute path. */
  readonly executablePath: string;
  /** What the runner is handed as its Chromium: the launcher that starts `executablePath` sandboxed (browser.ts). */
  readonly launcherPath: string;
}

/** The worker will not start: a variable is missing or breaks its rule. */
export class WorkerConfigError extends Error {
  override readonly name = 'WorkerConfigError';
}

/**
 * A KMS key's ARN: `arn:<partition>:kms:<region>:<account>:key/<key id>`, the
 * key id a UUID or a multi-Region key's `mrk-` id. An alias is refused: a
 * sealed credential records the key's ARN, which an alias only resolves to.
 */
const KMS_KEY_ARN =
  /^arn:aws(?:-[a-z]+)*:kms:([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** What an `Authorization` header can carry: printable ASCII, no spaces. */
const TOKEN_CHARACTERS = /^[\x21-\x7e]+$/;

/** What the configuration is read against beside the environment. */
export interface WorkerHost {
  /** The user the process runs as, where the platform has one. The worker does not run as root. */
  readonly uid?: number | undefined;
  /** The browser launcher, when a test names another; `BROWSER_LAUNCHER` otherwise. */
  readonly launcherPath?: string | undefined;
}

/**
 * The configuration in `env`. The worker does not run as root: Chromium's
 * sandbox will not start as root, and nothing the worker does needs it.
 */
export function readWorkerConfig(env: Readonly<Record<string, string | undefined>>, host: WorkerHost = {}): WorkerConfig {
  for (const name of DEBUG_VARIABLES) {
    if ((env[name] ?? '') !== '') {
      throw new WorkerConfigError(`${name} is set, and debug logging could print what the browser types; unset it`);
    }
  }

  const tokenName = PORTAL_ENV.readToken;
  const token = env[tokenName] ?? '';
  if (token === '') {
    throw new WorkerConfigError(`${tokenName} is not set; refusing to start a worker anyone could call`);
  }
  if (token.length < PORTAL_READ_TOKEN_MIN_LENGTH) {
    throw new WorkerConfigError(`${tokenName} is shorter than ${PORTAL_READ_TOKEN_MIN_LENGTH} characters`);
  }
  if (!TOKEN_CHARACTERS.test(token)) {
    throw new WorkerConfigError(`${tokenName} must be printable ASCII with no spaces, as a bearer header carries it`);
  }

  const keyName = PORTAL_ENV.kmsKeyId;
  const keyId = env[keyName] ?? '';
  if (keyId === '') {
    throw new WorkerConfigError(`${keyName} is not set; the worker could open no credential`);
  }
  const arn = KMS_KEY_ARN.exec(keyId);
  if (arn === null) {
    throw new WorkerConfigError(
      `${keyName} must be the portal key's ARN (arn:aws:kms:<region>:<account>:key/<key id>), which is what a sealed credential records; an alias or a bare key id is refused`,
    );
  }

  const rawPort = env.PORT ?? '8080';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65_535) {
    throw new WorkerConfigError('PORT must be a port number');
  }

  const executablePath = env[CHROMIUM_PATH_ENV] || chromium.executablePath();
  if (!isAbsolute(executablePath)) {
    throw new WorkerConfigError(`${CHROMIUM_PATH_ENV} must be an absolute path`);
  }
  if (!isExecutableFile(executablePath)) {
    throw new WorkerConfigError(
      `no Chromium at ${executablePath}: run \`playwright install chromium\`, or name one in ${CHROMIUM_PATH_ENV}`,
    );
  }
  const launcherPath = host.launcherPath ?? BROWSER_LAUNCHER;
  if (!isExecutableFile(launcherPath)) {
    throw new WorkerConfigError(`the browser launcher at ${launcherPath} is missing or not executable; the worker starts Chromium only through it`);
  }

  if (host.uid === 0) {
    throw new WorkerConfigError("the worker does not run as root: Chromium's sandbox will not start as root, and the worker needs no privilege");
  }

  return { token, keyId, keyRegion: arn[1]!, port: Number(rawPort), executablePath, launcherPath };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Missing, unreadable or not executable: the caller refuses to start and names the path.
    return false;
  }
}

/**
 * Where the AWS SDK's provider chain will find the worker's credentials, by
 * the variables it reads first, named and never quoted. Static keys come
 * first in the chain, so when both are set the keys are what it uses.
 */
export function awsCredentialSource(env: Readonly<Record<string, string | undefined>>): 'static_keys' | 'web_identity' | 'provider_chain' {
  if ((env.AWS_ACCESS_KEY_ID ?? '') !== '' && (env.AWS_SECRET_ACCESS_KEY ?? '') !== '') return 'static_keys';
  if ((env.AWS_ROLE_ARN ?? '') !== '' && (env.AWS_WEB_IDENTITY_TOKEN_FILE ?? '') !== '') return 'web_identity';
  return 'provider_chain';
}
