import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KMS_CIPHER_NAME,
  KmsTokenCipher,
  TokenCipherMismatchError,
  TokenContextError,
  TokenDecryptionError,
  encryptionContextAad,
  kmsEncryptionContext,
  type KmsDataKeyProvider,
  type SealedToken,
  type TokenCipher,
  type TokenEncryptionContext,
} from '../src/index';
import { LOCAL_CIPHER_NAME, LocalTokenCipher } from '../src/testing';

/**
 * Sealing a credential (ADR 0033).
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
