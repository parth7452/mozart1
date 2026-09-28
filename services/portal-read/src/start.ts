// Starting the worker, as its entry point does: the environment read and
// checked, the cipher checked to be open-only, the browser checked to be
// sandboxed, and the server listening. The entry point chooses the cipher and
// nothing else: `main.ts` the KMS one, a test the local one. Everything the
// two share is here, so a test of the one starts the other.
//
// What goes to standard output is `log.ts`'s JSON lines. A refusal to start,
// and a crash, go to standard error as one line naming the rule broken or the
// error's class, never a value or a message.
import type { TokenCipher, TokenCipherMode } from '@recouple/crypto';
import { BrowserSandboxError, checkBrowserSandbox } from './browser';
import { CHROMIUM_PATH_ENV, WorkerConfigError, awsCredentialSource, readWorkerConfig, type WorkerConfig } from './config';
import { PUBLIC_DESTINATIONS_ONLY, type DestinationPolicy } from './destinations';
import { errorClassOf, jsonLines } from './log';
import { PORTAL_ENV, type Resolver } from './portal';
import { createWorker } from './server';

/** A cipher that says what it may do. The worker's must be open-only. */
export type WorkerCipher = TokenCipher & { readonly mode: TokenCipherMode };

export interface StartOptions {
  /** Where a recipe may send the browser. `main.ts` never passes this: public destinations only. */
  readonly destinations?: DestinationPolicy | undefined;
  /** How the egress proxy resolves a name. `main.ts` never passes this: `dns.lookup`. */
  readonly resolve?: Resolver | undefined;
}

export async function startWorker(cipherFor: (config: WorkerConfig) => WorkerCipher, options: StartOptions = {}): Promise<void> {
  const log = jsonLines(process.stdout);
  const fatal = jsonLines(process.stderr);

  // Node's own report of an uncaught error prints its message and stack, which
  // could quote a page or a URL. This one names the class and stops.
  const crash = (e: unknown): never => {
    fatal('crashed', { errorClass: errorClassOf(e) });
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  const refuse = (reason: string): never => {
    fatal('refused_to_start', { reason });
    process.exit(1);
  };

  let config: WorkerConfig;
  try {
    config = readWorkerConfig(process.env, { uid: process.getuid?.() });
  } catch (e) {
    if (!(e instanceof WorkerConfigError)) throw e;
    return refuse(e.message);
  }

  // Nothing the worker starts from here on needs the token or the key's name,
  // so they leave its environment: no child it starts is given them. That is
  // all this does. The kernel keeps the environment the process started with,
  // and /proc/<pid>/environ shows it to any process of the same user, the AWS
  // credentials beside these. What keeps a portal's page from reading any of
  // it is the browser's sandbox, checked below, and the environment built
  // from nothing that the browser's launcher gives it (launch-chromium.sh).
  delete process.env[PORTAL_ENV.readToken];
  delete process.env[PORTAL_ENV.kmsKeyId];
  // The Chromium the launcher starts: the one just resolved and checked. A path, not a secret.
  process.env[CHROMIUM_PATH_ENV] = config.executablePath;

  const cipher = cipherFor(config);
  if (cipher.mode !== 'open_only') {
    // The worker opens credentials and never seals one (ADR 0057 §7): a cipher that could is a wiring mistake.
    return refuse(`the worker's cipher must be open_only, not ${cipher.mode}`);
  }

  // The browser, once, as every run will start it: sandboxed, or the worker does not start.
  try {
    await checkBrowserSandbox(config.launcherPath);
  } catch (e) {
    return refuse(e instanceof BrowserSandboxError ? e.rule : `the browser could not be checked (${errorClassOf(e)})`);
  }

  const worker = createWorker({
    token: config.token,
    keyId: config.keyId,
    cipher,
    executablePath: config.launcherPath,
    destinations: options.destinations ?? PUBLIC_DESTINATIONS_ONLY,
    resolve: options.resolve,
    log,
    onStuck: () => {
      // A run's browser would not close. A clean process is the only sure way to be rid of it.
      fatal('stopping', { reason: 'a run did not end' });
      process.exit(1);
    },
  });

  const stop = (signal: NodeJS.Signals): void => {
    // A run in flight is lost; the job finds no result and records the run failed.
    log('stopping', { signal, runInFlight: worker.runs.active() });
    worker.stop();
    worker.server.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  worker.server.on('error', (e) => refuse(`the server could not listen (${errorClassOf(e)})`));
  await new Promise<void>((resolve) => {
    worker.server.listen(config.port, () => resolve());
  });
  // The bound port, not the one asked for: PORT=0 takes an ephemeral one, and a test learns which from this line.
  const address = worker.server.address();
  log('listening', {
    port: typeof address === 'object' && address !== null ? address.port : config.port,
    browserSandbox: 'checked',
    // Which of the SDK's sources holds the worker's AWS credentials: short-lived web identity is the one to see here (README).
    awsCredentials: awsCredentialSource(process.env),
    loopbackAllowed: (options.destinations ?? PUBLIC_DESTINATIONS_ONLY).allowLoopback,
  });
}
