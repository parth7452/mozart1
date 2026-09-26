import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages are TypeScript source, not built output.
  transpilePackages: ['@recouple/core-domain', '@recouple/pipeline', '@recouple/store-postgres'],
  // `pg` is a server-only dependency with native-ish internals; keeping it
  // external stops the bundler trying to trace it into a client chunk. `sharp`
  // is native libvips, which renders a TIFF for reading and viewing (ADR 0054):
  // it is loaded from node_modules at run time, never bundled.
  serverExternalPackages: ['pg', 'sharp'],
  // The upload route checks `content-length` before it parses, but a server
  // action has no such hook — this is the backstop for one. The platform
  // delivers no body over 4.5 MB anyway (`lib/upload-limits.ts`), so a limit
  // above that promised nothing.
  experimental: { serverActions: { bodySizeLimit: '5mb' } },
};

export default config;
