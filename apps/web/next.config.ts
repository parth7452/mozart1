import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages are TypeScript source, not built output.
  transpilePackages: ['@recouple/core-domain', '@recouple/pipeline', '@recouple/store-postgres'],
  // `pg` is a server-only dependency with native-ish internals; keeping it
  // external stops the bundler trying to trace it into a client chunk.
  serverExternalPackages: ['pg'],
  // The upload route checks `content-length` before it parses, but a server
  // action has no such hook — this is the backstop for one.
  experimental: { serverActions: { bodySizeLimit: '26mb' } },
};

export default config;
