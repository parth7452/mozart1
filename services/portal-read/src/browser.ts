// The browser a run drives, and how the worker knows it is sandboxed (ADR 0057
// §6). A portal's pages are untrusted, and the worker's process holds its
// bearer token and the AWS credentials that can decrypt every tenant's portal
// credential. What keeps a page that exploits the renderer from reading either
// is Chromium's own sandbox, so the worker insists on it:
//  - the runner is handed `launch-chromium.sh` as its Chromium, which starts
//    the real one with its sandbox and an environment built from nothing;
//  - before the worker takes a run, it starts the browser once that same way
//    and, on Linux, asks the kernel whether the renderer runs under seccomp in
//    a PID namespace of its own (sandbox.ts). If not, it does not start.
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { errorClassOf } from './log';
import { PUBLIC_DESTINATIONS_ONLY, egressSwitches, startEgress } from './portal';
import { sandboxFaults, settledChromiumTree } from './sandbox';

/**
 * The launcher the runner is handed as its Chromium: `launch-chromium.sh`,
 * beside this module in the source and beside the bundle in the image
 * (build.mjs copies it there).
 */
export const BROWSER_LAUNCHER = fileURLToPath(new URL('./launch-chromium.sh', import.meta.url));

/** How long the check waits for the browser to start. */
const CHECK_LAUNCH_TIMEOUT_MS = 30_000;
/** How long a renderer has to turn its seccomp filter on after the zygote forks it: far longer than it takes. */
const CHECK_SETTLE_MS = 5_000;

/** The browser did not start sandboxed. `rule` says what was found, never a value. */
export class BrowserSandboxError extends Error {
  override readonly name = 'BrowserSandboxError';
  constructor(readonly rule: string) {
    super(`the worker's browser is not sandboxed: ${rule}`);
  }
}

/**
 * Starts the browser once, as every run starts it, before the worker takes a
 * run: through `launcher`, behind an egress proxy that lets nothing out, on a
 * page with nothing on it. On Linux it then asks the kernel about the process
 * tree, and the browser must not have been started with `--no-sandbox`, and
 * every renderer must run under a seccomp filter in a PID namespace of its
 * own. Elsewhere Chromium's sandbox needs nothing the platform could lack, so
 * a browser that started without `--no-sandbox` is sandboxed.
 *
 * Throws `BrowserSandboxError` when any of it fails, which the worker takes as
 * a reason not to start: a browser that renders a portal's pages without its
 * sandbox is one exploit from the worker's secrets.
 */
export async function checkBrowserSandbox(launcher: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  // A proxy that lets nothing out: every destination refused unread, so nothing is decided, reported or sent.
  const egress = await startEgress({
    destinationAllowed: () => false,
    decide: () => ({ allow: false, reason: 'host_not_allowed' }),
    refused: () => undefined,
    destinations: PUBLIC_DESTINATIONS_ONLY,
  });
  try {
    let browser: Browser;
    try {
      browser = await chromium.launch({ executablePath: launcher, headless: true, args: egressSwitches(egress), timeout: CHECK_LAUNCH_TIMEOUT_MS });
    } catch (e) {
      throw new BrowserSandboxError(`Chromium did not start with its sandbox (${errorClassOf(e)})`);
    }
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><title>sandbox check</title>');
      if (platform === 'linux') {
        const tree = await settledChromiumTree(process.pid, { timeoutMs: CHECK_SETTLE_MS });
        if (tree === undefined) throw new BrowserSandboxError('the browser it started was not found under the worker');
        const faults = sandboxFaults(tree);
        if (faults.length > 0) throw new BrowserSandboxError(faults.join('; '));
      }
    } finally {
      await browser.close();
    }
  } finally {
    await egress.close();
  }
}
