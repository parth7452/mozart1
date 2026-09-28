import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenDecryptionError, type PortalCredentialEncryptionContext } from '@recouple/crypto';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import { PortalBindingError, bindingOf, hostsHash, portalCredentialContext, sameBinding } from '../src/binding';
import {
  PORTAL_CREDENTIAL_PURPOSE,
  PORTAL_LIMITS,
  PortalBindingSchema,
  type PortalBinding,
  type PortalCredentialContext,
} from '../src/contracts';
import { parseRecipe, type RecipeVersion } from '../src/recipe';
import { recipeJson } from './recipe-fixture';

/**
 * A credential's binding (ADR 0057 §6-7): computed from a recipe version and
 * nothing else, canonical, and inside the encryption context. The hosts are
 * illustrative: ADR 0062 §3 leaves a real portal's to the founder's
 * walk-through.
 */

const ORIGIN = 'https://portal.example.com';

/** A recipe as parseRecipe returns it, with the sign-in block and allowlist given. */
function recipe(
  signIn: Partial<RecipeVersion['signIn']> = {},
  over: Record<string, unknown> = {},
): RecipeVersion {
  return parseRecipe(
    recipeJson(ORIGIN, {
      hostAllowlist: ['portal.example.com', 'login.example.com'],
      signIn: { origin: ORIGIN, formPaths: ['/login'], mfaPaths: ['/mfa'], acsPaths: ['/saml/acs'], ...signIn },
      ...over,
    }),
  );
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Whatever `run` threw. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

describe('hostsHash', () => {
  it('is SHA-256 of the hosts, lower-cased and sorted, joined by a newline', () => {
    expect(hostsHash(['portal.example.com', 'Login.Example.com'])).toBe(
      sha256('login.example.com\nportal.example.com'),
    );
  });

  it('is pinned: every stored credential was sealed under what it computes', () => {
    // A change to the function would leave every portal credential unable to
    // open. These are its outputs today, written down.
    expect(hostsHash(['portal.example.com'])).toBe(
      'e89bbdbac811e9a8565478640fba9b810bf43c7a6eea042fb5fd0f10ffe15e9a',
    );
    expect(hostsHash(['portal.example.com', 'login.example.com', '127.0.0.1:4000'])).toBe(
      sha256('127.0.0.1:4000\nlogin.example.com\nportal.example.com'),
    );
  });

  it('is lower-case hex, as the contract and the credential row require', () => {
    expect(hostsHash(['portal.example.com'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not change with the order, the case or a host listed twice', () => {
    const one = hostsHash(['portal.example.com', 'login.example.com']);
    expect(hostsHash(['login.example.com', 'portal.example.com'])).toBe(one);
    expect(hostsHash(['PORTAL.example.com', 'login.EXAMPLE.com'])).toBe(one);
    expect(hostsHash(['portal.example.com', 'login.example.com', 'portal.example.com'])).toBe(one);
  });

  it('changes when a host is added, removed or given another port', () => {
    const one = hostsHash(['portal.example.com', 'login.example.com']);
    expect(hostsHash(['portal.example.com', 'login.example.com', 'cdn.example.com'])).not.toBe(one);
    expect(hostsHash(['portal.example.com'])).not.toBe(one);
    expect(hostsHash(['portal.example.com:8443', 'login.example.com'])).not.toBe(one);
  });

  it.each([
    ['no hosts', []],
    ['a wildcard', ['*.example.com']],
    ['a scheme', ['https://portal.example.com']],
    ['a path', ['portal.example.com/login']],
    ['a space', ['portal.example.com ']],
    ['a newline, which would join two hosts into one', ['portal.example.com\nlogin.example.com']],
    ['something that is not a string', [7]],
  ])('refuses an allowlist with %s', (_, allowlist) => {
    expect(() => hostsHash(allowlist as string[])).toThrow(PortalBindingError);
  });

  it('names the rule and never the host', () => {
    const refusal = thrownBy(() => hostsHash(['portal.example.com', 'secret-host.example.com/x']));
    expect(refusal).toBeInstanceOf(PortalBindingError);
    expect((refusal as Error).message).toContain('hostAllowlist.1');
    expect((refusal as Error).message).not.toContain('secret-host');
  });
});

describe('bindingOf', () => {
  it('is the canonical origin, every bound path once and sorted, and the hosts hash', () => {
    const r = recipe({ formPaths: ['/login', '/sso'], mfaPaths: ['/mfa', '/login'], acsPaths: ['/saml/acs'] });

    expect(bindingOf(r)).toEqual({
      signInOrigin: ORIGIN,
      signInPaths: ['/login', '/mfa', '/saml/acs', '/sso'],
      hostsHash: hostsHash(['portal.example.com', 'login.example.com']),
    });
  });

  it('is one the contract accepts', () => {
    expect(PortalBindingSchema.safeParse(bindingOf(recipe())).success).toBe(true);
  });

  it('prints the origin as URL.origin does, whatever the recipe wrote', () => {
    const r = recipe({ origin: 'HTTPS://Portal.Example.com:443/login?next=%2F' });
    expect(bindingOf(r).signInOrigin).toBe(ORIGIN);
  });

  it('is the same for the same recipe with its lists in another order', () => {
    const one = recipe({ formPaths: ['/login', '/sso'], mfaPaths: ['/mfa'], acsPaths: ['/saml/acs'] });
    const two = recipe(
      { formPaths: ['/sso', '/login'], mfaPaths: ['/mfa'], acsPaths: ['/saml/acs'] },
      { hostAllowlist: ['login.example.com', 'portal.example.com'] },
    );
    expect(sameBinding(bindingOf(one), bindingOf(two))).toBe(true);
  });

  it('is kept by a version that changes what the recipe does but not where it signs in', () => {
    // A credential sealed under version 1 still opens for version 2.
    const one = recipe();
    const two = recipe(
      {},
      {
        version: 2,
        effectiveFrom: '2026-10-01',
        neverClick: ['Create Invoice'],
        caps: { maxPages: 3, maxDownloads: 0, maxRunMs: 60_000 },
        steps: [{ kind: 'open', name: 'start', url: `${ORIGIN}/login` }, { kind: 'sign_in' }, { kind: 'answer_mfa' }, { kind: 'sign_out' }],
      },
    );
    expect(bindingOf(two)).toEqual(bindingOf(one));
  });

  it.each([
    ['another sign-in origin', recipe({ origin: 'https://login.example.com' })],
    ['another sign-in path', recipe({ formPaths: ['/login', '/login2'] })],
    ['another MFA path', recipe({ mfaPaths: ['/mfa/verify'] })],
    ['no ACS path', recipe({ acsPaths: [] })],
    ['another host', recipe({}, { hostAllowlist: ['portal.example.com', 'login.example.com', 'cdn.example.com'] })],
  ])('is not kept by a version with %s', (_, changed) => {
    // A new version that would type the credential anywhere else cannot open
    // it until an owner enters it again under the new binding (ADR 0057 §7).
    expect(sameBinding(bindingOf(changed), bindingOf(recipe()))).toBe(false);
  });

  it('refuses a recipe the contract could not bind, by field and rule', () => {
    const ftp = parseRecipe(
      recipeJson('ftp://127.0.0.1:4000', { hostAllowlist: ['127.0.0.1:4000'] }),
    );
    const tooMany = recipe({
      formPaths: Array.from({ length: PORTAL_LIMITS.signInPathsMax + 1 }, (_, i) => `/login/${String(i).padStart(3, '0')}`),
    });
    const tooLong = recipe({ formPaths: [`/${'a'.repeat(PORTAL_LIMITS.pathMax)}`] });

    for (const unbindable of [ftp, tooMany, tooLong]) {
      expect(() => bindingOf(unbindable)).toThrow(PortalBindingError);
    }
    const refusal = thrownBy(() => bindingOf(ftp));
    expect((refusal as PortalBindingError).issues.map((i) => i.path.join('.'))).toEqual(['signInOrigin']);
    expect((refusal as Error).message).not.toContain('127.0.0.1');
  });

  it('refuses an origin that is not a URL at all, by field', () => {
    const r = { ...recipe(), signIn: { ...recipe().signIn, origin: 'not a url' } } as RecipeVersion;
    const refusal = thrownBy(() => bindingOf(r));
    expect(refusal).toBeInstanceOf(PortalBindingError);
    expect((refusal as Error).message).toBe('no portal binding: signIn.origin: a URL');
  });
});

describe('sameBinding', () => {
  const binding = bindingOf(recipe());

  it('holds for a binding and its copy', () => {
    expect(sameBinding(binding, { ...binding, signInPaths: [...binding.signInPaths] })).toBe(true);
  });

  it.each([
    ['origin', { ...binding, signInOrigin: 'https://login.example.com' }],
    ['a path', { ...binding, signInPaths: [...binding.signInPaths, '/zz'] }],
    ['a missing path', { ...binding, signInPaths: binding.signInPaths.slice(1) }],
    ['hosts hash', { ...binding, hostsHash: sha256('another') }],
  ])('fails on another %s', (_, other) => {
    expect(sameBinding(binding, other)).toBe(false);
    expect(sameBinding(other, binding)).toBe(false);
  });

  it('fails on the same paths out of order, so a binding that is not canonical matches nothing', () => {
    expect(sameBinding(binding, { ...binding, signInPaths: [...binding.signInPaths].reverse() })).toBe(false);
  });
});

/** The two declarations of the portal context, in @recouple/portal and @recouple/crypto, are one shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contextsAgree: Same<PortalCredentialContext, PortalCredentialEncryptionContext> = true;

describe('portalCredentialContext', () => {
  const ids = { orgId: '2f3b6b8e-1c4a-4d5a-9a6b-8f0a1b2c3d4e', connectionId: '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f' };
  const payload = JSON.stringify({ username: 'recouple-reader', password: 'portal-password-not-a-real-one' });

  it('is the ids and the binding, under the portal purpose', () => {
    const binding = bindingOf(recipe());
    expect(portalCredentialContext(ids, binding)).toEqual({
      purpose: 'portal_credential',
      ...ids,
      ...binding,
    });
    expect(PORTAL_CREDENTIAL_PURPOSE).toBe('portal_credential');
  });

  it('is the shape @recouple/crypto seals under, field for field', () => {
    // Checked by the compiler: if either declaration gains, loses or retypes a
    // field, `Same` is false and this file does not typecheck.
    expect(contextsAgree).toBe(true);
    const context: PortalCredentialEncryptionContext = portalCredentialContext(ids, bindingOf(recipe()));
    expect(context.purpose).toBe('portal_credential');
  });

  it('refuses a binding that is not canonical, rather than sealing under it', () => {
    const binding: PortalBinding = { ...bindingOf(recipe()), signInPaths: ['/mfa', '/login'] };
    expect(() => portalCredentialContext(ids, binding)).toThrow(PortalBindingError);
  });

  it('seals as the app does and opens as the worker does, for the same recipe', async () => {
    const rootKey = Buffer.alloc(32, 9);
    const app = new LocalTokenCipher({ rootKey, mode: 'seal_only' });
    const worker = new LocalTokenCipher({ rootKey, mode: 'open_only' });

    // The app: the binding of the version the database holds.
    const sealed = await app.encrypt(payload, portalCredentialContext(ids, bindingOf(recipe())));
    // The worker: the binding of the recipe it was handed, the same version.
    expect(await worker.decrypt(sealed, portalCredentialContext(ids, bindingOf(recipe())))).toBe(payload);
    // A later version that only changes its steps still opens it.
    const stepsOnly = recipe({}, { version: 2, steps: [{ kind: 'open', name: 'start', url: `${ORIGIN}/login` }, { kind: 'sign_in' }, { kind: 'sign_out' }] });
    expect(await worker.decrypt(sealed, portalCredentialContext(ids, bindingOf(stepsOnly)))).toBe(payload);
  });

  it.each([
    ['adds a host', recipe({}, { hostAllowlist: ['portal.example.com', 'login.example.com', 'cdn.example.com'] })],
    ['moves the sign-in form', recipe({ formPaths: ['/signin'] })],
    ['signs in at another origin', recipe({ origin: 'https://login.example.com' })],
  ])('does not open for a version that %s', async (_, changed) => {
    const rootKey = Buffer.alloc(32, 9);
    const sealed = await new LocalTokenCipher({ rootKey, mode: 'seal_only' }).encrypt(
      payload,
      portalCredentialContext(ids, bindingOf(recipe())),
    );
    const worker = new LocalTokenCipher({ rootKey, mode: 'open_only' });

    await expect(worker.decrypt(sealed, portalCredentialContext(ids, bindingOf(changed)))).rejects.toThrow(
      TokenDecryptionError,
    );
  });

  it('does not open for another connection with the same recipe', async () => {
    const rootKey = Buffer.alloc(32, 9);
    const binding = bindingOf(recipe());
    const sealed = await new LocalTokenCipher({ rootKey, mode: 'seal_only' }).encrypt(
      payload,
      portalCredentialContext(ids, binding),
    );
    const other = { ...ids, connectionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' };

    await expect(
      new LocalTokenCipher({ rootKey, mode: 'open_only' }).decrypt(sealed, portalCredentialContext(other, binding)),
    ).rejects.toThrow(TokenDecryptionError);
  });
});
