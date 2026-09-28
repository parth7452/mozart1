// Builds what the worker's image runs (ADR 0057 §6). The output directory
// holds:
//  - portal-read.mjs: `src/main.ts` and everything it imports, the runner,
//    the crypto package and the AWS SDK among them, bundled into one ES
//    module;
//  - launch-chromium.sh, beside it: the launcher the worker hands the runner
//    as its Chromium, which starts the real one with its sandbox and an
//    environment built from nothing. The bundle finds it beside itself, as
//    `src/browser.ts` finds it beside itself in the source;
//  - node_modules/playwright and node_modules/playwright-core, copied as
//    installed. They are left out of the bundle because Playwright finds its
//    own files and its browsers at run time, which a bundle would move.
// Nothing else goes in: no TypeScript, no tsx, no other package's source and
// no development dependency.
//
// Run from the repository root, after `pnpm install`:
//   node services/portal-read/build.mjs <output directory>
import { chmodSync, copyFileSync, cpSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(process.argv[2] ?? 'dist');
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// esbuild is tsx's own dependency, pinned by the lockfile. It is resolved from where tsx is installed rather than added as a dependency of its own.
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(out, 'portal-read.mjs'),
  tsconfig: join(here, 'tsconfig.json'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['playwright', 'playwright-core'],
  // Some of the AWS SDK's dependencies are CommonJS and call require(), which an ES module does not have.
  banner: { js: "import { createRequire as __portalReadRequire } from 'node:module'; const require = __portalReadRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

// The launcher, executable, where the bundle's `import.meta.url` resolves it.
const launcher = join(out, 'launch-chromium.sh');
copyFileSync(join(here, 'src/launch-chromium.sh'), launcher);
chmodSync(launcher, 0o755);

// Playwright as installed, links followed: the versions the lockfile pins, and so the Chromium revision
// `playwright install` fetches for them.
const playwright = dirname(realpathSync(require.resolve('playwright/package.json')));
const core = dirname(realpathSync(createRequire(join(playwright, 'package.json')).resolve('playwright-core/package.json')));
for (const [from, name] of [[playwright, 'playwright'], [core, 'playwright-core']]) {
  cpSync(from, join(out, 'node_modules', name), {
    recursive: true,
    dereference: true,
    // The package's own files only. A nested node_modules holds pnpm's links and bin shims, which name the build machine's paths; playwright-core is copied beside playwright instead.
    filter: (source) => !relative(from, source).split(sep).includes('node_modules'),
  });
}

process.stdout.write(`built ${join(out, 'portal-read.mjs')}\n`);
