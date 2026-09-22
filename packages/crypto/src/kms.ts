/**
 * `KmsTokenCipher` — the production `TokenCipher`: AWS KMS wraps the data key,
 * AES-256-GCM does the bytes (ADR 0033 §3).
 *
 * Two KMS calls and no others. `GenerateDataKey` for a write, `Decrypt` for a
 * read, both carrying the encryption context, which KMS authenticates: a
 * wrapped key generated for one `{org, realm}` will not unwrap for another, so
 * the tenancy binding is enforced by the vendor as well as by our own AAD.
 *
 * **Nothing here reads `process.env`.** The key id is a constructor argument,
 * and AWS credentials come from the SDK's own provider chain — which is what
 * lets a Vercel deployment use static keys and a later EC2 or Lambda host use
 * an instance role with no code change. `packages/qbo` reads no environment at
 * all (ADR 0026) and this package keeps that true of the thing beside it: the
 * one variable this repository reads by name, `QBO_TOKEN_KMS_KEY_ID`, is read
 * in `apps/web/lib/ledger-sync.ts` and in `scripts/link-qbo.ts`.
 */

import {
  encryptionContextAad,
  kmsEncryptionContext,
  TokenCipherMismatchError,
  TokenDecryptionError,
  causeName,
  type SealedToken,
  type TokenCipher,
  type TokenEncryptionContext,
} from './cipher';
import { openWithDataKey, sealWithDataKey, zero } from './aes';

/** The name written to `accounting_credentials.cipher` by this implementation. */
export const KMS_CIPHER_NAME = 'aws-kms+aes-256-gcm';

/** A data key KMS generated: the key itself, its wrapped form, and which key wrapped it. */
export interface GeneratedDataKey {
  readonly plaintext: Buffer;
  readonly wrappedKey: Buffer;
  /** As KMS resolved it — the full ARN, even when an alias was asked for. */
  readonly keyId: string;
}

/**
 * The two KMS operations this package needs, as a port.
 *
 * Narrow on purpose. The AWS SDK's `send(command)` is a generic with a dozen
 * overloads; a test that stubbed it would be stubbing a shape rather than a
 * contract. Two methods that take and return `Buffer`s can be faked in five
 * lines and read at a glance, and the SDK stays behind one adapter.
 */
export interface KmsDataKeyProvider {
  generateDataKey(input: {
    readonly keyId: string;
    readonly encryptionContext: Record<string, string>;
  }): Promise<GeneratedDataKey>;
  decryptDataKey(input: {
    readonly keyId: string;
    readonly wrappedKey: Buffer;
    readonly encryptionContext: Record<string, string>;
  }): Promise<Buffer>;
}

/**
 * The AWS implementation, over `@aws-sdk/client-kms`.
 *
 * The client is built on first use, through a dynamic import, for two reasons:
 * the SDK is large and nothing that does not seal a token should pay to load
 * it, and constructing it eagerly at module scope would make importing this
 * package a thing that can fail in an environment with no AWS configuration at
 * all. `credentials` is deliberately not passed: omitting it is what selects
 * the SDK's own provider chain.
 */
export function awsKmsDataKeyProvider(
  options: { readonly region?: string } = {},
): KmsDataKeyProvider {
  let client: Promise<KmsSdk> | undefined;
  const sdk = async (): Promise<KmsSdk> => {
    client ??= loadKmsSdk(options.region);
    return client;
  };

  return {
    async generateDataKey({ keyId, encryptionContext }) {
      const { client: kms, commands } = await sdk();
      const answer = await kms.send(
        new commands.GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: 'AES_256',
          EncryptionContext: encryptionContext,
        }),
      );
      if (answer.Plaintext === undefined || answer.CiphertextBlob === undefined) {
        // Nothing is swallowed and nothing is guessed: a GenerateDataKey that
        // answered without a key is not a key we make up.
        throw new Error('KMS GenerateDataKey answered without a data key');
      }
      return {
        plaintext: Buffer.from(answer.Plaintext),
        wrappedKey: Buffer.from(answer.CiphertextBlob),
        keyId: answer.KeyId ?? keyId,
      };
    },

    async decryptDataKey({ keyId, wrappedKey, encryptionContext }) {
      const { client: kms, commands } = await sdk();
      const answer = await kms.send(
        new commands.DecryptCommand({
          // Named even though a symmetric decrypt does not require it: it makes
          // KMS refuse a blob that was wrapped under some other key, rather
          // than opening it because the caller happens to be allowed to.
          KeyId: keyId,
          CiphertextBlob: wrappedKey,
          EncryptionContext: encryptionContext,
        }),
      );
      if (answer.Plaintext === undefined) {
        throw new Error('KMS Decrypt answered without a data key');
      }
      return Buffer.from(answer.Plaintext);
    },
  };
}

export class KmsTokenCipher implements TokenCipher {
  readonly name = KMS_CIPHER_NAME;

  constructor(
    private readonly config: {
      /** A key id, an alias (`alias/recouple-qbo-tokens`) or a full ARN. */
      readonly keyId: string;
      readonly kms: KmsDataKeyProvider;
    },
  ) {
    if (config.keyId.trim() === '') {
      throw new Error('a KMS token cipher needs a key id');
    }
  }

  /** The production constructor: this key, AWS's own credential resolution. */
  static forKey(keyId: string, options: { readonly region?: string } = {}): KmsTokenCipher {
    return new KmsTokenCipher({ keyId, kms: awsKmsDataKeyProvider(options) });
  }

  async encrypt(plaintext: string, context: TokenEncryptionContext): Promise<SealedToken> {
    const encryptionContext = kmsEncryptionContext(context);
    const aad = encryptionContextAad(context);
    const key = await this.config.kms.generateDataKey({
      keyId: this.config.keyId,
      encryptionContext,
    });
    try {
      return {
        cipher: this.name,
        // What KMS resolved, not what we asked for: an alias moves, and a row
        // has to name the key that can actually open it.
        keyId: key.keyId,
        wrappedKey: key.wrappedKey.toString('base64'),
        ciphertext: sealWithDataKey(key.plaintext, Buffer.from(plaintext, 'utf8'), aad),
      };
    } finally {
      zero(key.plaintext);
    }
  }

  async decrypt(sealed: SealedToken, context: TokenEncryptionContext): Promise<string> {
    if (sealed.cipher !== this.name) {
      throw new TokenCipherMismatchError(this.name, sealed.cipher);
    }
    const encryptionContext = kmsEncryptionContext(context);
    const aad = encryptionContextAad(context);

    let dataKey: Buffer;
    try {
      dataKey = await this.config.kms.decryptDataKey({
        keyId: sealed.keyId,
        wrappedKey: Buffer.from(sealed.wrappedKey, 'base64'),
        encryptionContext,
      });
    } catch (error) {
      // The class name and nothing else. A KMS error message names the key, the
      // account and sometimes the context, and this error travels into logs.
      throw new TokenDecryptionError(sealed.cipher, sealed.keyId, causeName(error));
    }

    try {
      return openWithDataKey(dataKey, sealed.ciphertext, aad).toString('utf8');
    } catch (error) {
      throw new TokenDecryptionError(sealed.cipher, sealed.keyId, causeName(error));
    } finally {
      zero(dataKey);
    }
  }
}

/**
 * The SDK, loaded once.
 *
 * Typed structurally rather than by importing the SDK's types at module scope:
 * this file names the four properties it uses, so a version bump that adds
 * fields is not a compile error and a reader can see the whole surface.
 */
interface KmsSdk {
  readonly client: {
    send(command: unknown): Promise<{
      Plaintext?: Uint8Array | undefined;
      CiphertextBlob?: Uint8Array | undefined;
      KeyId?: string | undefined;
    }>;
  };
  readonly commands: {
    GenerateDataKeyCommand: new (input: Record<string, unknown>) => unknown;
    DecryptCommand: new (input: Record<string, unknown>) => unknown;
  };
}

async function loadKmsSdk(region: string | undefined): Promise<KmsSdk> {
  const sdk = await import('@aws-sdk/client-kms');
  const client = new sdk.KMSClient(region === undefined ? {} : { region });
  return {
    client: client as unknown as KmsSdk['client'],
    commands: {
      GenerateDataKeyCommand: sdk.GenerateDataKeyCommand as unknown as KmsSdk['commands']['GenerateDataKeyCommand'],
      DecryptCommand: sdk.DecryptCommand as unknown as KmsSdk['commands']['DecryptCommand'],
    },
  };
}
