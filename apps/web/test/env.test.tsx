import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../lib/env';

/**
 * Where a magic link comes back to.
 *
 * This is the value that, when wrong, produces no error anywhere: the auth
 * provider silently substitutes its own Site URL for a redirect it does not
 * recognise, the callback route is never reached, and the only evidence is an
 * absence. So the rules it follows are asserted rather than assumed.
 */
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function clear() {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
}

/** `NODE_ENV` is typed read-only, and these tests are about what it changes. */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe('the origin a magic link returns to', () => {
  it('uses the configured value when there is one', () => {
    clear();
    process.env.NEXT_PUBLIC_SITE_URL = 'https://recouple.example';
    expect(env.siteUrl).toBe('https://recouple.example');
  });

  it('strips a trailing slash, because the callback path is appended to it', () => {
    clear();
    process.env.NEXT_PUBLIC_SITE_URL = 'https://recouple.example/';
    // `${siteUrl}/auth/callback` with a trailing slash builds a double-slashed
    // URL, which does not match an allow list entry and so is silently replaced.
    expect(env.siteUrl).toBe('https://recouple.example');
    expect(`${env.siteUrl}/auth/callback`).toBe('https://recouple.example/auth/callback');
  });

  it('derives the origin from the platform when nothing is configured', () => {
    clear();
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'recouple.vercel.app';
    expect(env.siteUrl).toBe('https://recouple.vercel.app');
  });

  it('prefers the production hostname over the per-deployment one', () => {
    clear();
    // VERCEL_URL changes on every push, so a link built from it would return to
    // a deployment nobody is looking at.
    process.env.VERCEL_URL = 'recouple-a1b2c3-team.vercel.app';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'recouple.vercel.app';
    expect(env.siteUrl).toBe('https://recouple.vercel.app');
  });

  it('falls back to localhost only outside production', () => {
    clear();
    setNodeEnv('development');
    expect(env.siteUrl).toBe('http://localhost:3000');
  });

  it('refuses to guess in production, rather than sending people to localhost', () => {
    clear();
    setNodeEnv('production');
    // The old behaviour returned localhost here, and every layer downstream
    // behaved reasonably about it, which is why it took hours to find.
    expect(() => env.siteUrl).toThrow(/NEXT_PUBLIC_SITE_URL is not set/);
  });
});
