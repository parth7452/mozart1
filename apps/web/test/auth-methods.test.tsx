import { describe, expect, it } from 'vitest';
import { EMAIL_LINK_METHODS, signedInByEmailLink, tokenFacts } from '../lib/auth-methods';

/**
 * Reading how a session was signed in (ADR 0051 §6). The reader verifies
 * nothing — it is handed the token `getUser()` just had verified — so what is
 * pinned here is that it never throws, never guesses, and reads both shapes the
 * provider has written `amr` in.
 */

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload: unknown) => `${part({ alg: 'ES256', kid: 'k' })}.${part(payload)}.c2ln`;

describe('tokenFacts', () => {
  it('reads the subject and every method, objects or bare strings, in order', () => {
    expect(
      tokenFacts(token({ sub: 'u1', amr: [{ method: 'magiclink', timestamp: 2 }, { method: 'otp', timestamp: 1 }] })),
    ).toEqual({ subject: 'u1', methods: ['magiclink', 'otp'] });
    expect(tokenFacts(token({ sub: 'u1', amr: ['password'] }))).toEqual({ subject: 'u1', methods: ['password'] });
    expect(tokenFacts(token({ sub: 'u1', amr: [] }))).toEqual({ subject: 'u1', methods: [] });
  });

  it('answers undefined, never a guess, for anything it cannot read whole', () => {
    for (const bad of [
      undefined,
      '',
      'a.b',
      'a..c',
      'a.%%%.c',
      `${part({})}.${Buffer.from('not json').toString('base64url')}.c`,
      token(null),
      token('a string'),
      token({ amr: [{ method: 'otp' }] }),
      token({ sub: '', amr: [{ method: 'otp' }] }),
      token({ sub: 'u1' }),
      token({ sub: 'u1', amr: 'otp' }),
      token({ sub: 'u1', amr: [{ timestamp: 1 }] }),
      token({ sub: 'u1', amr: [{ method: 7 }] }),
      token({ sub: 'u1', amr: [null] }),
    ]) {
      expect(tokenFacts(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('signedInByEmailLink', () => {
  it('accepts only the three ways this app signs anyone in', () => {
    expect([...EMAIL_LINK_METHODS].sort()).toEqual(['email/signup', 'magiclink', 'otp']);
    for (const method of EMAIL_LINK_METHODS) expect(signedInByEmailLink([method])).toBe(true);
    expect(signedInByEmailLink(['magiclink', 'otp'])).toBe(true);
  });

  it('refuses a password, any other method, a mix, and nothing at all', () => {
    for (const methods of [['password'], ['otp', 'password'], ['oauth'], ['token_refresh'], ['invite'], []]) {
      expect(signedInByEmailLink(methods), methods.join(',')).toBe(false);
    }
  });
});
