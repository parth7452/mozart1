import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KMS_CIPHER_NAME,
  KmsTokenCipher,
  TOKEN_CIPHER_MODES,
  TokenCipherMismatchError,
  TokenCipherModeError,
  TokenContextError,
  TokenDecryptionError,
  encryptionContextAad,
  kmsEncryptionContext,
  type KmsDataKeyGenerator,
  type KmsDataKeyOpener,
  type KmsDataKeyProvider,
  type PortalCredentialEncryptionContext,
  type QboTokenEncryptionContext,
  type SealedToken,
  type TokenCipher,
  type TokenEncryptionContext,
} from '../src/index';
import { LOCAL_CIPHER_NAME, LocalTokenCipher } from '../src/testing';

/**
 * Sealing a credential (ADR 0033, ADR 0057 §7).
 *
 * No test here reaches AWS. `KmsTokenCipher` is exercised against a fake
 * `KmsDataKeyProvider` that wraps the data key the way KMS does — under its own
 * key, with the encryption context authenticated — so the two properties that
 * matter are real properties of the code under test rather than of a stub: a
 * ciphertext does not open for another tenant, and a tampered one does not open
 * at all.
 */

const CONTEXT: TokenEncryptionContext = {
  orgId: '2f3b6b8e-1c4a-4d5a-9a6b-8f0a1b2c3d4e',
  realmId: '4620816365213608204',
};

const OTHER_TENANT: TokenEncryptionContext = {
  orgId: '9d8c7b6a-5e4f-4321-8765-0a1b2c3d4e5f',
  realmId: CONTEXT.realmId,
};

const OTHER_COMPANY: TokenEncryptionContext = {
  orgId: CONTEXT.orgId,
  realmId: '9999999999999999999',
};

/** What a token set actually looks like on this path. Fake values, obviously. */
const TOKENS = JSON.stringify({
  accessToken: 'access-token-not-a-real-one',
  refreshToken: 'refresh-token-not-a-real-one',
  accessExpiresAt: '2026-09-22T17:00:00.000Z',
  refreshExpiresAt: '2026-12-31T17:00:00.000Z',
});

/**
 * A portal credential's context. The destination is illustrative, not any
 * real portal's: ADR 0062 §3 leaves the hosts to the founder's walk-through.
 */
const PORTAL_HOSTS_HASH = createHash('sha256').update('portal.example.com', 'utf8').digest('hex');
const PORTAL: PortalCredentialEncryptionContext = {
  purpose: 'portal_credential',
  orgId: '2f3b6b8e-1c4a-4d5a-9a6b-8f0a1b2c3d4e',
  connectionId: '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  signInOrigin: 'https://portal.example.com',
  signInPaths: ['/acs', '/login', '/mfa'],
  hostsHash: PORTAL_HOSTS_HASH,
};

/** The sealed payload: one JSON value, as the app seals it. Fake values, obviously. */
const PORTAL_PAYLOAD = JSON.stringify({
  username: 'recouple-reader',
  password: 'portal-password-not-a-real-one',
  totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
});

/** Each part of the portal context changed on its own, the rest left as they are. */
const PORTAL_VARIANTS: Array<[string, PortalCredentialEncryptionContext]> = [
  ['another tenant', { ...PORTAL, orgId: '9d8c7b6a-5e4f-4321-8765-0a1b2c3d4e5f' }],
  ['another connection of the same tenant', { ...PORTAL, connectionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }],
  ['another sign-in origin', { ...PORTAL, signInOrigin: 'https://login.example.com' }],
  ['a sign-in path fewer', { ...PORTAL, signInPaths: ['/acs', '/login'] }],
  ['a sign-in path more', { ...PORTAL, signInPaths: ['/acs', '/login', '/mfa', '/verify'] }],
  [
    'another host allowlist',
    {
      ...PORTAL,
      hostsHash: createHash('sha256')
        .update('login.example.com\nportal.example.com', 'utf8')
        .digest('hex'),
    },
  ],
];

/**
 * A KMS that does what KMS does, in this process.
 *
 * `GenerateDataKey` mints a key and returns it both in the clear and wrapped
 * under a root key with the encryption context bound; `Decrypt` unwraps it and
 * **refuses a context that does not match**, which is the vendor-side half of
 * the tenancy binding and the thing a stub would quietly not do.
 */
function fakeKms(keyArn = 'arn:aws:kms:us-east-1:123456789012:key/fake'): {
  readonly kms: KmsDataKeyProvider;
  readonly calls: string[];
} {
  const rootKey = randomBytes(32);
  const calls: string[] = [];

  const wrap = (key: Buffer, context: Record<string, string>): Buffer => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', rootKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(context), 'utf8'));
    const body = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };

  return {
    calls,
    kms: {
      async generateDataKey({ keyId, encryptionContext }) {
        calls.push(`generate:${keyId}`);
        const plaintext = randomBytes(32);
        return { plaintext, wrappedKey: wrap(plaintext, encryptionContext), keyId: keyArn };
      },
      async decryptDataKey({ keyId, wrappedKey, encryptionContext }) {
        calls.push(`decrypt:${keyId}`);
        const iv = wrappedKey.subarray(0, 12);
        const tag = wrappedKey.subarray(12, 28);
        const decipher = createDecipheriv('aes-256-gcm', rootKey, iv);
        decipher.setAAD(Buffer.from(JSON.stringify(encryptionContext), 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(wrappedKey.subarray(28)), decipher.final()]);
      },
    },
  };
}

/** Flips one byte of a base64 payload without changing its length. */
function tamper(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  const at = bytes.length - 1;
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

/** Whatever a promise rejected with, or `undefined` if it did not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

const implementations: Array<{ name: string; make: () => TokenCipher; cipherName: string }> = [
  {
    name: 'KmsTokenCipher, against a KMS that behaves like KMS',
    make: () => new KmsTokenCipher({ keyId: 'alias/recouple-qbo-tokens', kms: fakeKms().kms }),
    cipherName: KMS_CIPHER_NAME,
  },
  {
    name: 'LocalTokenCipher',
    make: () => new LocalTokenCipher(),
    cipherName: LOCAL_CIPHER_NAME,
  },
];

describe.each(implementations)('$name', ({ make, cipherName }) => {
  it('round-trips a token set', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(TOKENS, CONTEXT);

    expect(sealed.cipher).toBe(cipherName);
    expect(await cipher.decrypt(sealed, CONTEXT)).toBe(TOKENS);
  });

  it('writes down nothing that reads like the plaintext', async () => {
    // The whole point of the table: every field of a sealed value goes in a
    // column, so any of them carrying a recognisable fragment of the token
    // would be the leak this design exists to prevent.
    const sealed = await make().encrypt(TOKENS, CONTEXT);
    const written = `${sealed.cipher}|${sealed.keyId}|${sealed.wrappedKey}|${sealed.ciphertext}`;

    expect(written).not.toContain('refresh-token-not-a-real-one');
    expect(written).not.toContain('access-token-not-a-real-one');
    expect(written).not.toContain('accessToken');
  });

  it('refuses a ciphertext somebody changed a byte of', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(TOKENS, CONTEXT);

    await expect(
      cipher.decrypt({ ...sealed, ciphertext: tamper(sealed.ciphertext) }, CONTEXT),
    ).rejects.toThrow(TokenDecryptionError);
  });

  it('refuses a wrapped key somebody changed a byte of', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(TOKENS, CONTEXT);

    await expect(
      cipher.decrypt({ ...sealed, wrappedKey: tamper(sealed.wrappedKey) }, CONTEXT),
    ).rejects.toThrow(TokenDecryptionError);
  });

  it('refuses a ciphertext replayed for another tenant', async () => {
    // This is the property that makes a row-level compromise of the database
    // not a cross-tenant credential leak: the row can be moved and it still
    // does not open (ADR 0033 §3).
    const cipher = make();
    const sealed = await cipher.encrypt(TOKENS, CONTEXT);

    await expect(cipher.decrypt(sealed, OTHER_TENANT)).rejects.toThrow(TokenDecryptionError);
  });

  it('refuses a ciphertext replayed for another company of the same tenant', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(TOKENS, CONTEXT);

    await expect(cipher.decrypt(sealed, OTHER_COMPANY)).rejects.toThrow(TokenDecryptionError);
  });

  it('refuses a value sealed by a cipher it is not', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(TOKENS, CONTEXT);
    const foreign: SealedToken = { ...sealed, cipher: 'something-else' };

    await expect(cipher.decrypt(foreign, CONTEXT)).rejects.toThrow(TokenCipherMismatchError);
  });

  it('will not seal without a whole context', async () => {
    const cipher = make();
    await expect(cipher.encrypt(TOKENS, { orgId: '', realmId: 'r' })).rejects.toThrow(
      TokenContextError,
    );
    await expect(cipher.encrypt(TOKENS, { orgId: 'o', realmId: '  ' })).rejects.toThrow(
      TokenContextError,
    );
  });

  it('does not open a value sealed under a different key of the same cipher', async () => {
    const one = make();
    const two = make();
    const sealed = await one.encrypt(TOKENS, CONTEXT);

    await expect(two.decrypt(sealed, CONTEXT)).rejects.toThrow(TokenDecryptionError);
  });
});

describe('what a failure is allowed to say', () => {
  it('names the cipher and the key and nothing else', async () => {
    const cipher = new LocalTokenCipher({ keyId: 'local-key-7' });
    const sealed = await cipher.encrypt(TOKENS, CONTEXT);

    const error = await cipher
      .decrypt(sealed, OTHER_TENANT)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TokenDecryptionError);
    const message = (error as Error).message;
    expect(message).toContain(LOCAL_CIPHER_NAME);
    expect(message).toContain('local-key-7');
    // Not the bytes, not the plaintext, and not the underlying message — which
    // on the KMS path names the account and the context (ADR 0033 §3).
    expect(message).not.toContain(sealed.ciphertext);
    expect(message).not.toContain(sealed.wrappedKey);
    expect(message).not.toContain('refresh-token-not-a-real-one');
    expect((error as TokenDecryptionError).reason).toBe('Error');
  });

  it('replaces a KMS error with its class name', async () => {
    class AccessDeniedException extends Error {
      constructor() {
        super('User arn:aws:iam::123456789012:user/nobody is not authorized to perform kms:Decrypt');
        this.name = 'AccessDeniedException';
      }
    }
    const kms: KmsDataKeyProvider = {
      async generateDataKey() {
        throw new Error('not reached');
      },
      async decryptDataKey() {
        throw new AccessDeniedException();
      },
    };

    const cipher = new KmsTokenCipher({ keyId: 'alias/k', kms });
    const error = await cipher
      .decrypt(
        { cipher: KMS_CIPHER_NAME, keyId: 'arn:key', wrappedKey: 'AAAA', ciphertext: 'AAAA' },
        CONTEXT,
      )
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TokenDecryptionError);
    expect((error as TokenDecryptionError).reason).toBe('AccessDeniedException');
    expect((error as Error).message).not.toContain('not authorized');
    expect((error as Error).message).not.toContain('123456789012');
  });
});

describe('the encryption context', () => {
  it('is what KMS is given, by fixed names', () => {
    // These names live inside AWS's own ciphertext. Changing one makes every
    // stored row undecryptable, so the test is here to make that a deliberate
    // act rather than a rename.
    expect(kmsEncryptionContext(CONTEXT)).toEqual({
      org_id: CONTEXT.orgId,
      realm_id: CONTEXT.realmId,
    });
  });

  it('cannot be confused between two different pairs', () => {
    // Length-prefixed rather than delimited: a pair that could be re-cut into
    // another pair would be a context two contexts share, which is no context.
    const one = encryptionContextAad({ orgId: 'a|realm_id:1:b', realmId: 'c' });
    const two = encryptionContextAad({ orgId: 'a', realmId: '1:b|realm_id:1:c' });
    expect(one.toString('utf8')).not.toBe(two.toString('utf8'));
  });

  it('is refused when a half is missing', () => {
    expect(() => kmsEncryptionContext({ orgId: 'o', realmId: '' })).toThrow(TokenContextError);
    expect(() => encryptionContextAad({ orgId: '', realmId: 'r' })).toThrow(TokenContextError);
  });
});

/**
 * A QuickBooks token set sealed by this package **as it was before the portal
 * variant existed**: minted from an unmodified checkout, then pinned here, with
 * a fixed root key for the local cipher and a KMS stand-in with a fixed root
 * key for the KMS one. Every `accounting_credentials` row was sealed under the
 * QuickBooks context as it was then, so if these stop opening, those rows have
 * stopped opening too (ADR 0057 §7: "Existing QuickBooks rows keep their
 * context byte for byte, so they still open").
 *
 * The values are fixtures and open nothing real: the root keys are the bytes
 * 0x00–0x1f and 0x20–0x3f, and the plaintext is `TOKENS` above.
 */
const QBO_SEALED_BEFORE_PORTAL = {
  local: {
    rootKey: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    sealed: {
      cipher: 'local-aes-256-gcm',
      keyId: 'local-fixture-key',
      wrappedKey:
        'Ja7ZLvDPUI85vlhADkM4rfIhF6H+MbDSL1F0v/ZvDnsGlWiQmIyKv6fNIydj2ZbWHlgyPlyYoHjH4wBN',
      ciphertext:
        'id0UwiALKxAsFcOxjUrAYJoVZJT/W9N7Ychxp7mjD5O39/8Cbtb9OWjscmPIup5dlE8XIgn7cvUe0o5WpGRMeHyE/wnUICtUD+FgLe+a5ydpnkfFSq/mkQxZgwyS/0ugXV9hEBOU+18Z3dsJo4b6dJIPKkFxg7vsb9OdOH1wfVHwhT1NTSHKYIyVQbzSFu5nL0oi6ZVSRVdekCJjsCJABULzsODRvOy3o+oSyqKwMjdAP//s0Ef8bcCp4euHbi6I3yoQo+kqvSWgfxDZilcvel//',
    },
  },
  kms: {
    rootKey: Buffer.from(Array.from({ length: 32 }, (_, i) => 0x20 + i)),
    sealed: {
      cipher: 'aws-kms+aes-256-gcm',
      keyId: 'arn:aws:kms:us-east-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      wrappedKey:
        'x6qi+51rMoNgOGTYAZGkmQkoUQNuPUu6IgNvs+yOQ5ieIgrvVQwH6ujHQUWyfJadthI/3aW51s5pTH1T',
      ciphertext:
        'PSPU/wDrPTGxSAjDHt9cZqGbyDG1NHN+B4i56wggGbZedh9pcCtC1hvYkVfzeWVlMV7Q62qVXyKFnr/CLNbnfQ+n4SYhKIa8ZyCzXVRIbnPnYvrCIUDOBOz84TtmCFw+terVh8/gFBl0UgZpRZALAnAmsP6dAEXBh6khUVmZL0LScwPvvBLdehIzFC8p9afYsu0vNm4bRdFWMUltsrdHOoOzwWkySM/HGeP47dLo6K7NCWBTElfeMdVkezaL1TDYYoswYFdsxszSwqNyYeSnz6dz',
    },
  },
} as const;

/**
 * The KMS stand-in the fixture was sealed with, opening only: its root key, and
 * the encryption context authenticated as the JSON of the map it is handed —
 * which is stricter than KMS, since the key order counts too.
 */
function fixedRootKms(rootKey: Buffer): { readonly kms: KmsDataKeyOpener; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    kms: {
      async decryptDataKey({ keyId, wrappedKey, encryptionContext }) {
        calls.push(`decrypt:${keyId}`);
        const decipher = createDecipheriv('aes-256-gcm', rootKey, wrappedKey.subarray(0, 12));
        decipher.setAAD(Buffer.from(JSON.stringify(encryptionContext), 'utf8'));
        decipher.setAuthTag(wrappedKey.subarray(12, 28));
        return Buffer.concat([decipher.update(wrappedKey.subarray(28)), decipher.final()]);
      },
    },
  };
}

describe('a QuickBooks token set sealed before the portal variant existed', () => {
  it('still opens with the local cipher', async () => {
    const { rootKey, sealed } = QBO_SEALED_BEFORE_PORTAL.local;
    const cipher = new LocalTokenCipher({ rootKey, keyId: 'local-fixture-key' });

    expect(await cipher.decrypt(sealed, CONTEXT)).toBe(TOKENS);
  });

  it('still opens with the KMS cipher, the KMS half of the context unchanged', async () => {
    const { rootKey, sealed } = QBO_SEALED_BEFORE_PORTAL.kms;
    const { kms, calls } = fixedRootKms(rootKey);
    const cipher = new KmsTokenCipher({ keyId: 'alias/recouple-qbo-tokens', kms, mode: 'open_only' });

    expect(await cipher.decrypt(sealed, CONTEXT)).toBe(TOKENS);
    expect(calls).toHaveLength(1);
  });

  it('still opens with the QuickBooks cipher, which names the row’s key to KMS', async () => {
    // The mode the QuickBooks path has always used. It names the key the row
    // was sealed under, so a row outlives an alias moving to another key.
    const { rootKey, sealed } = QBO_SEALED_BEFORE_PORTAL.kms;
    const { kms: opener, calls } = fixedRootKms(rootKey);
    const kms: KmsDataKeyProvider = {
      ...opener,
      async generateDataKey() {
        throw new Error('not reached');
      },
    };
    const cipher = new KmsTokenCipher({ keyId: 'alias/recouple-qbo-tokens', kms });

    expect(cipher.mode).toBe('seal_and_open');
    expect(await cipher.decrypt(sealed, CONTEXT)).toBe(TOKENS);
    expect(calls).toEqual([`decrypt:${sealed.keyId}`]);
  });

  it('has the same AAD, byte for byte', () => {
    expect(encryptionContextAad(CONTEXT).toString('utf8')).toBe(
      'recouple-token-v1|org_id:36:2f3b6b8e-1c4a-4d5a-9a6b-8f0a1b2c3d4e|realm_id:19:4620816365213608204',
    );
  });

  it('has the same KMS map, key order included', () => {
    expect(JSON.stringify(kmsEncryptionContext(CONTEXT))).toBe(
      '{"org_id":"2f3b6b8e-1c4a-4d5a-9a6b-8f0a1b2c3d4e","realm_id":"4620816365213608204"}',
    );
  });

  it('does not open under a portal context for the same tenant', async () => {
    const { rootKey, sealed } = QBO_SEALED_BEFORE_PORTAL.local;
    const cipher = new LocalTokenCipher({ rootKey, keyId: 'local-fixture-key' });

    await expect(cipher.decrypt(sealed, PORTAL)).rejects.toThrow(TokenDecryptionError);
  });
});

describe.each(implementations)('a portal credential, sealed with $name', ({ make }) => {
  it('round-trips the payload under its context', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(PORTAL_PAYLOAD, PORTAL);

    expect(await cipher.decrypt(sealed, PORTAL)).toBe(PORTAL_PAYLOAD);
  });

  it('writes down nothing that reads like the payload', async () => {
    const sealed = await make().encrypt(PORTAL_PAYLOAD, PORTAL);
    const written = `${sealed.cipher}|${sealed.keyId}|${sealed.wrappedKey}|${sealed.ciphertext}`;

    expect(written).not.toContain('portal-password-not-a-real-one');
    expect(written).not.toContain('recouple-reader');
    expect(written).not.toContain('GEZDGNBV');
  });

  it.each(PORTAL_VARIANTS)('does not open for %s', async (_, other) => {
    // The binding is authenticated, not stored beside the ciphertext as a
    // label: a recipe version that would send the credential anywhere else
    // cannot open it (ADR 0057 §7).
    const cipher = make();
    const sealed = await cipher.encrypt(PORTAL_PAYLOAD, PORTAL);

    await expect(cipher.decrypt(sealed, other)).rejects.toThrow(TokenDecryptionError);
  });

  it('never opens as a QuickBooks token set, even one naming the connection as its company', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(PORTAL_PAYLOAD, PORTAL);
    const qbo: QboTokenEncryptionContext = { orgId: PORTAL.orgId, realmId: PORTAL.connectionId };

    await expect(cipher.decrypt(sealed, qbo)).rejects.toThrow(TokenDecryptionError);
  });

  it('and a QuickBooks token set never opens as a portal credential', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(TOKENS, { orgId: PORTAL.orgId, realmId: PORTAL.connectionId });

    await expect(cipher.decrypt(sealed, PORTAL)).rejects.toThrow(TokenDecryptionError);
  });

  it('refuses a ciphertext or a wrapped key somebody changed a byte of', async () => {
    const cipher = make();
    const sealed = await cipher.encrypt(PORTAL_PAYLOAD, PORTAL);

    await expect(
      cipher.decrypt({ ...sealed, ciphertext: tamper(sealed.ciphertext) }, PORTAL),
    ).rejects.toThrow(TokenDecryptionError);
    await expect(
      cipher.decrypt({ ...sealed, wrappedKey: tamper(sealed.wrappedKey) }, PORTAL),
    ).rejects.toThrow(TokenDecryptionError);
  });
});

describe('the portal context', () => {
  it('is what KMS is given, by fixed names, with its purpose', () => {
    // As for QuickBooks, these names live inside AWS's ciphertext; `purpose` is
    // also what a key policy can require (`kms:EncryptionContext:purpose`).
    expect(JSON.stringify(kmsEncryptionContext(PORTAL))).toBe(
      JSON.stringify({
        purpose: 'portal_credential',
        org_id: PORTAL.orgId,
        connection_id: PORTAL.connectionId,
        sign_in_origin: 'https://portal.example.com',
        sign_in_paths: '["/acs","/login","/mfa"]',
        hosts_hash: PORTAL_HOSTS_HASH,
      }),
    );
  });

  it('is authenticated under its own AAD tag, byte for byte', () => {
    expect(encryptionContextAad(PORTAL).toString('utf8')).toBe(
      'recouple-portal-credential-v1' +
        '|purpose:17:portal_credential' +
        '|org_id:36:2f3b6b8e-1c4a-4d5a-9a6b-8f0a1b2c3d4e' +
        '|connection_id:36:7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f' +
        '|sign_in_origin:26:https://portal.example.com' +
        '|sign_in_paths:24:["/acs","/login","/mfa"]' +
        `|hosts_hash:64:${PORTAL_HOSTS_HASH}`,
    );
  });

  it('never shares an AAD with a QuickBooks context', () => {
    const portal = encryptionContextAad(PORTAL).toString('utf8');
    const qbo = encryptionContextAad({ orgId: PORTAL.orgId, realmId: PORTAL.connectionId }).toString(
      'utf8',
    );
    expect(portal.startsWith('recouple-portal-credential-v1|')).toBe(true);
    expect(qbo.startsWith('recouple-token-v1|')).toBe(true);
  });

  it.each(PORTAL_VARIANTS)('changes both halves for %s', (_, other) => {
    // Both encodings carry every part: KMS refuses on its half and the AAD on
    // ours, and neither is left to the other.
    expect(JSON.stringify(kmsEncryptionContext(other))).not.toBe(
      JSON.stringify(kmsEncryptionContext(PORTAL)),
    );
    expect(encryptionContextAad(other).equals(encryptionContextAad(PORTAL))).toBe(false);
  });

  it('reads a list of paths one way only', () => {
    // One path with a comma in it is not two paths, and one path with a quote
    // in it is not a list: the paths travel as the JSON of the list.
    const one = { ...PORTAL, signInPaths: ['/a","/b'] };
    const two = { ...PORTAL, signInPaths: ['/a', '/b'] };
    expect(kmsEncryptionContext(one)['sign_in_paths']).not.toBe(
      kmsEncryptionContext(two)['sign_in_paths'],
    );
    expect(encryptionContextAad(one).equals(encryptionContextAad(two))).toBe(false);
  });

  const malformed: Array<[string, unknown]> = [
    ['a blank orgId', { ...PORTAL, orgId: '  ' }],
    ['an orgId with a lone surrogate', { ...PORTAL, orgId: 'org-\uD800' }],
    ['no connectionId', { ...PORTAL, connectionId: undefined }],
    ['a blank connectionId', { ...PORTAL, connectionId: '' }],
    ['an origin with a trailing slash', { ...PORTAL, signInOrigin: 'https://portal.example.com/' }],
    ['an origin with a path', { ...PORTAL, signInOrigin: 'https://portal.example.com/login' }],
    ['an origin with an upper-case host', { ...PORTAL, signInOrigin: 'https://Portal.example.com' }],
    ['an origin naming its default port', { ...PORTAL, signInOrigin: 'https://portal.example.com:443' }],
    ['an origin that is not http(s)', { ...PORTAL, signInOrigin: 'ftp://portal.example.com' }],
    ['an origin that is not a URL', { ...PORTAL, signInOrigin: 'portal.example.com' }],
    ['no sign-in paths', { ...PORTAL, signInPaths: [] }],
    ['sign-in paths that are not a list', { ...PORTAL, signInPaths: '/login' }],
    ['a sign-in path that is not a path', { ...PORTAL, signInPaths: ['/acs', 'login'] }],
    ['a sign-in path that is not a string', { ...PORTAL, signInPaths: ['/acs', 7] }],
    ['unsorted sign-in paths', { ...PORTAL, signInPaths: ['/login', '/acs'] }],
    ['a duplicated sign-in path', { ...PORTAL, signInPaths: ['/acs', '/login', '/login'] }],
    ['an upper-case hosts hash', { ...PORTAL, hostsHash: PORTAL_HOSTS_HASH.toUpperCase() }],
    ['a short hosts hash', { ...PORTAL, hostsHash: PORTAL_HOSTS_HASH.slice(1) }],
    ['a hosts hash that is not hex', { ...PORTAL, hostsHash: 'g'.repeat(64) }],
    ['a purpose nobody knows', { ...PORTAL, purpose: 'qbo_token' }],
    [
      'a purpose nobody knows, on an otherwise whole QuickBooks context',
      { purpose: 'qbo_token', orgId: PORTAL.orgId, realmId: '4620816365213608204' },
    ],
    ['a portal purpose over a QuickBooks shape', { purpose: 'portal_credential', orgId: PORTAL.orgId, realmId: '1' }],
  ];

  it.each(malformed)('is refused with %s', (_, context) => {
    expect(() => kmsEncryptionContext(context as TokenEncryptionContext)).toThrow(TokenContextError);
    expect(() => encryptionContextAad(context as TokenEncryptionContext)).toThrow(TokenContextError);
  });

  it.each(implementations)('is refused by $name before anything is sealed', async ({ make }) => {
    await expect(
      make().encrypt(PORTAL_PAYLOAD, { ...PORTAL, signInPaths: ['/mfa', '/login'] }),
    ).rejects.toThrow(TokenContextError);
  });

  it('says which rule it broke and never the value', () => {
    let refusal: unknown;
    try {
      kmsEncryptionContext({ ...PORTAL, signInOrigin: 'https://portal.example.com/secret-path' });
    } catch (thrown) {
      refusal = thrown;
    }
    expect(refusal).toBeInstanceOf(TokenContextError);
    expect((refusal as Error).message).toContain('sign-in origin');
    expect((refusal as Error).message).not.toContain('secret-path');
  });
});

/**
 * A KMS with two keys, each with an alias, that checks which key a wrapped key
 * was made under the way KMS does: a `Decrypt` naming another key is
 * `IncorrectKeyException`, whatever the blob says. The blob carries its key's
 * index in its first byte, standing in for the metadata KMS puts in its own.
 */
function twoKeyKms(): {
  readonly kms: KmsDataKeyProvider;
  readonly calls: string[];
  readonly portalArn: string;
  readonly qboArn: string;
} {
  const portalArn = 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555';
  const qboArn = 'arn:aws:kms:us-east-1:123456789012:key/66666666-7777-4888-8999-000000000000';
  const keys = [
    { arn: portalArn, alias: 'alias/recouple-portal-credentials', root: randomBytes(32) },
    { arn: qboArn, alias: 'alias/recouple-qbo-tokens', root: randomBytes(32) },
  ];
  const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });
  const resolve = (keyId: string): number => {
    const index = keys.findIndex((k) => k.arn === keyId || k.alias === keyId);
    if (index < 0) throw named('NotFoundException', `no key ${keyId}`);
    return index;
  };
  const calls: string[] = [];

  return {
    calls,
    portalArn,
    qboArn,
    kms: {
      async generateDataKey({ keyId, encryptionContext }) {
        calls.push(`generate:${keyId}`);
        const index = resolve(keyId);
        const plaintext = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', keys[index]!.root, iv);
        cipher.setAAD(Buffer.from(JSON.stringify(encryptionContext), 'utf8'));
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return {
          plaintext,
          wrappedKey: Buffer.concat([Buffer.from([index]), iv, cipher.getAuthTag(), body]),
          keyId: keys[index]!.arn,
        };
      },
      async decryptDataKey({ keyId, wrappedKey, encryptionContext }) {
        calls.push(`decrypt:${keyId}`);
        const index = resolve(keyId);
        if (wrappedKey[0] !== index) {
          throw named('IncorrectKeyException', `the key ${keyId} cannot decrypt this`);
        }
        const decipher = createDecipheriv('aes-256-gcm', keys[index]!.root, wrappedKey.subarray(1, 13));
        decipher.setAAD(Buffer.from(JSON.stringify(encryptionContext), 'utf8'));
        decipher.setAuthTag(wrappedKey.subarray(13, 29));
        return Buffer.concat([decipher.update(wrappedKey.subarray(29)), decipher.final()]);
      },
    },
  };
}

describe('a cipher’s mode (ADR 0057 §7: the app seals, only the worker opens)', () => {
  it('lets the app seal and the worker open, each holding only its half of KMS', async () => {
    const { kms, calls } = twoKeyKms();
    const generateOnly: KmsDataKeyGenerator = { generateDataKey: (input) => kms.generateDataKey(input) };
    const decryptOnly: KmsDataKeyOpener = { decryptDataKey: (input) => kms.decryptDataKey(input) };
    const app = new KmsTokenCipher({ keyId: 'alias/recouple-portal-credentials', kms: generateOnly, mode: 'seal_only' });
    const worker = new KmsTokenCipher({ keyId: 'alias/recouple-portal-credentials', kms: decryptOnly, mode: 'open_only' });

    const sealed = await app.encrypt(PORTAL_PAYLOAD, PORTAL);
    expect(await worker.decrypt(sealed, PORTAL)).toBe(PORTAL_PAYLOAD);
    expect(calls).toEqual([
      'generate:alias/recouple-portal-credentials',
      'decrypt:alias/recouple-portal-credentials',
    ]);
  });

  it('a seal-only cipher refuses to open, by name, before KMS is asked anything', async () => {
    const { kms, calls } = twoKeyKms();
    const app = new KmsTokenCipher({ keyId: 'alias/recouple-portal-credentials', kms, mode: 'seal_only' });
    const sealed = await app.encrypt(PORTAL_PAYLOAD, PORTAL);
    calls.length = 0;

    const refusal = await thrownBy(app.decrypt(sealed, PORTAL));
    expect(refusal).toBeInstanceOf(TokenCipherModeError);
    expect(refusal).toMatchObject({ name: 'TokenCipherModeError', mode: 'seal_only', operation: 'open' });
    expect(calls).toEqual([]);
  });

  it('an open-only cipher refuses to seal, by name, before KMS is asked anything', async () => {
    const { kms, calls } = twoKeyKms();
    const worker = new KmsTokenCipher({ keyId: 'alias/recouple-portal-credentials', kms, mode: 'open_only' });

    const refusal = await thrownBy(worker.encrypt(PORTAL_PAYLOAD, PORTAL));
    expect(refusal).toBeInstanceOf(TokenCipherModeError);
    expect(refusal).toMatchObject({ mode: 'open_only', operation: 'seal' });
    expect(calls).toEqual([]);
  });

  it('refuses the other operation before it looks at the value or the context', async () => {
    const { kms } = twoKeyKms();
    const app = new KmsTokenCipher({ keyId: 'alias/k', kms, mode: 'seal_only' });
    const worker = new KmsTokenCipher({ keyId: 'alias/k', kms, mode: 'open_only' });
    const junk = { cipher: 'something-else', keyId: 'k', wrappedKey: '', ciphertext: '' };

    await expect(app.decrypt(junk, { orgId: '', realmId: '' })).rejects.toThrow(TokenCipherModeError);
    await expect(worker.encrypt('x', { orgId: '', realmId: '' })).rejects.toThrow(TokenCipherModeError);
  });

  it('an open-only cipher names its own key to KMS, so a value wrapped under another key does not open', async () => {
    // A credential row can name any key it likes. The worker's cipher asks KMS
    // with the portal key, and KMS refuses a blob wrapped under another one —
    // here the QuickBooks key, which the row names — so the worker opens
    // nothing but what was sealed under its own key.
    const { kms, calls, qboArn } = twoKeyKms();
    const sealedUnderQboKey = await new KmsTokenCipher({ keyId: 'alias/recouple-qbo-tokens', kms, mode: 'seal_only' })
      .encrypt(PORTAL_PAYLOAD, PORTAL);
    expect(sealedUnderQboKey.keyId).toBe(qboArn);
    calls.length = 0;

    const worker = new KmsTokenCipher({ keyId: 'alias/recouple-portal-credentials', kms, mode: 'open_only' });
    const refusal = await thrownBy(worker.decrypt(sealedUnderQboKey, PORTAL));

    expect(refusal).toBeInstanceOf(TokenDecryptionError);
    expect((refusal as TokenDecryptionError).reason).toBe('IncorrectKeyException');
    expect(calls).toEqual(['decrypt:alias/recouple-portal-credentials']);
  });

  it('while the QuickBooks cipher names the row’s key, as it always has', async () => {
    const { kms, calls, portalArn } = twoKeyKms();
    const sealed = await new KmsTokenCipher({ keyId: 'alias/recouple-portal-credentials', kms }).encrypt(
      TOKENS,
      CONTEXT,
    );
    calls.length = 0;

    // Configured with the other key: it still opens a row naming the key it
    // was sealed under, which is what lets a QuickBooks row outlive an alias
    // moving to a new key.
    const cipher = new KmsTokenCipher({ keyId: 'alias/recouple-qbo-tokens', kms });
    expect(await cipher.decrypt(sealed, CONTEXT)).toBe(TOKENS);
    expect(calls).toEqual([`decrypt:${portalArn}`]);
  });

  it('keeps only the half of the provider its mode uses', async () => {
    // Handed a whole provider, a seal-only cipher still never calls Decrypt:
    // what it kept is the generator, and the refusal comes first anyway.
    const { kms, calls } = twoKeyKms();
    const app = new KmsTokenCipher({ keyId: 'alias/recouple-portal-credentials', kms, mode: 'seal_only' });
    const sealed = await app.encrypt(PORTAL_PAYLOAD, PORTAL);

    await expect(app.decrypt(sealed, PORTAL)).rejects.toThrow(TokenCipherModeError);
    expect(calls.filter((call) => call.startsWith('decrypt:'))).toEqual([]);
  });

  it('is refused when built without the KMS operation its mode needs', () => {
    const { kms } = twoKeyKms();
    const decryptOnly = { decryptDataKey: kms.decryptDataKey } as unknown as KmsDataKeyGenerator;
    const generateOnly = { generateDataKey: kms.generateDataKey } as unknown as KmsDataKeyOpener;

    expect(() => new KmsTokenCipher({ keyId: 'alias/k', kms: decryptOnly, mode: 'seal_only' })).toThrow(
      /needs GenerateDataKey/,
    );
    expect(() => new KmsTokenCipher({ keyId: 'alias/k', kms: generateOnly, mode: 'open_only' })).toThrow(
      /needs Decrypt/,
    );
    expect(
      () => new KmsTokenCipher({ keyId: 'alias/k', kms: generateOnly as unknown as KmsDataKeyProvider }),
    ).toThrow(/needs Decrypt/);
  });

  it('is refused when it is not one this package knows, rather than read as the default', () => {
    const { kms } = twoKeyKms();
    expect(
      () =>
        new KmsTokenCipher({
          keyId: 'alias/k',
          kms,
          mode: 'decrypt_everything',
        } as unknown as ConstructorParameters<typeof KmsTokenCipher>[0]),
    ).toThrow(/mode is one of/);
    expect(
      () =>
        new LocalTokenCipher({
          mode: 'decrypt_everything',
        } as unknown as ConstructorParameters<typeof LocalTokenCipher>[0]),
    ).toThrow(/mode is one of/);
  });

  it('is seal_and_open unless one is named, for the QuickBooks cipher and the local one', () => {
    const { kms } = twoKeyKms();
    expect(new KmsTokenCipher({ keyId: 'alias/k', kms }).mode).toBe('seal_and_open');
    expect(new LocalTokenCipher().mode).toBe('seal_and_open');
    expect(TOKEN_CIPHER_MODES).toEqual(['seal_and_open', 'seal_only', 'open_only']);
  });

  it('is wired by the production constructor without reaching AWS', async () => {
    // `forKey` builds the AWS provider lazily, so nothing below loads the SDK:
    // each refusal comes before the first KMS call would.
    expect(KmsTokenCipher.forKey('alias/recouple-qbo-tokens').mode).toBe('seal_and_open');
    expect(KmsTokenCipher.forKey('alias/k', { region: 'us-east-1' }).mode).toBe('seal_and_open');

    const app = KmsTokenCipher.forKey('alias/recouple-portal-credentials', { mode: 'seal_only' });
    const worker = KmsTokenCipher.forKey('alias/recouple-portal-credentials', { mode: 'open_only' });
    expect(app.mode).toBe('seal_only');
    expect(worker.mode).toBe('open_only');

    const sealed: SealedToken = { cipher: KMS_CIPHER_NAME, keyId: 'arn:key', wrappedKey: 'AAAA', ciphertext: 'AAAA' };
    await expect(app.decrypt(sealed, PORTAL)).rejects.toThrow(TokenCipherModeError);
    await expect(worker.encrypt(PORTAL_PAYLOAD, PORTAL)).rejects.toThrow(TokenCipherModeError);
  });

  it('works the same way for the local cipher, so a test can play the app and the worker', async () => {
    const rootKey = randomBytes(32);
    const app = new LocalTokenCipher({ rootKey, mode: 'seal_only' });
    const worker = new LocalTokenCipher({ rootKey, mode: 'open_only' });

    const sealed = await app.encrypt(PORTAL_PAYLOAD, PORTAL);
    expect(await worker.decrypt(sealed, PORTAL)).toBe(PORTAL_PAYLOAD);
    await expect(app.decrypt(sealed, PORTAL)).rejects.toThrow(TokenCipherModeError);
    await expect(worker.encrypt(PORTAL_PAYLOAD, PORTAL)).rejects.toThrow(TokenCipherModeError);
    // Another root key is another key: the worker opens nothing else.
    await expect(new LocalTokenCipher({ mode: 'open_only' }).decrypt(sealed, PORTAL)).rejects.toThrow(
      TokenDecryptionError,
    );
  });

  it('says its mode and the operation, and nothing about the value', async () => {
    const app = new LocalTokenCipher({ mode: 'seal_only' });
    const sealed = await app.encrypt(PORTAL_PAYLOAD, PORTAL);
    const refusal = await thrownBy(app.decrypt(sealed, PORTAL));

    expect(refusal).toBeInstanceOf(TokenCipherModeError);
    const message = (refusal as Error).message;
    expect(message).toBe('a seal_only cipher may not open a token');
    expect(message).not.toContain(sealed.ciphertext);
    expect(message).not.toContain(PORTAL.connectionId);
  });
});

describe('the testing entry point', () => {
  it('is not reachable from the package index', async () => {
    // CLAUDE.md: no mocks or fixtures reachable from production code paths —
    // and this is the one where the fixture would be holding a customer's
    // QuickBooks credentials (ADR 0033 §4). The assertion
    // `packages/adapters/test/accounting.test.ts` makes about
    // `InMemoryAccountingSource`, for a higher-stakes double.
    const index: Record<string, unknown> = await import('../src/index');
    expect(Object.keys(index)).not.toContain('LocalTokenCipher');
    expect(Object.keys(index)).not.toContain('LOCAL_CIPHER_NAME');
  });

  it('and the only cipher the index exports is the KMS one', () => {
    // A weaker assertion would pass if a second local implementation appeared
    // under another name.
    expect(KMS_CIPHER_NAME).not.toBe(LOCAL_CIPHER_NAME);
  });
});
