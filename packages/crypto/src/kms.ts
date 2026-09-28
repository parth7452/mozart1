/**
 * `KmsTokenCipher` — the production `TokenCipher`: AWS KMS wraps the data key,
 * AES-256-GCM does the bytes (ADR 0033 §3).
 *
 * Two KMS calls and no others. `GenerateDataKey` for a write, `Decrypt` for a
 * read, both carrying the encryption context, which KMS authenticates: a
 * wrapped key generated for one context will not unwrap for another, so the
 * tenancy binding is enforced by the vendor as well as by our own AAD.
 *
 * **A cipher has a mode** (ADR 0057 §7). The QuickBooks cipher seals and opens,
 * as it always has. A portal credential is sealed by the app and opened only
 * by the worker, whose AWS identities may call `GenerateDataKey` and `Decrypt`
 * under the portal key respectively, and never the other. Each builds a
 * single-purpose cipher to match: a `seal_only` cipher holds no way to call
 * `Decrypt` and an `open_only` one none to call `GenerateDataKey`, and asking
 * either for the other operation is a `TokenCipherModeError` before KMS hears
 * of it. IAM is the rule; this is the same rule in code, so a wiring mistake is
 * a named refusal rather than an AccessDenied from AWS.
 *
 * An open-only cipher also names **its own key** to `Decrypt`, where the
 * QuickBooks cipher names the row's. KMS then refuses a wrapped key made under
 * any other key (`IncorrectKeyException`), whatever the row claims, so the
 * worker opens only what was sealed under the portal key. The QuickBooks cipher
 * keeps naming the row's key, so a row sealed before an alias moved still
 * opens.
 *
 * **Nothing here reads `process.env`.** The key id is a constructor argument,
 * and AWS credentials come from the SDK's own provider chain — which is what
 * lets a Vercel deployment use static keys and a later EC2 or Lambda host use
 * an instance role with no code change. `packages/qbo` reads no environment at
 * all (ADR 0026) and this package keeps that true of the thing beside it: the
 * variables naming a key (`QBO_TOKEN_KMS_KEY_ID`, and the portal's
 * `PORTAL_KMS_KEY_ID`) are read by the app, the scripts and the worker, never
 * here.
 */

import {
  encryptionContextAad,
  kmsEncryptionContext,
  TOKEN_CIPHER_MODES,
  TokenCipherMismatchError,
  TokenCipherModeError,
  TokenDecryptionError,
  causeName,
  type SealedToken,
  type TokenCipher,
  type TokenCipherMode,
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

/** `GenerateDataKey`: all a cipher that seals needs of KMS. */
export interface KmsDataKeyGenerator {
  generateDataKey(input: {
    readonly keyId: string;
    readonly encryptionContext: Record<string, string>;
  }): Promise<GeneratedDataKey>;
}

/** `Decrypt`: all a cipher that opens needs of KMS. */
export interface KmsDataKeyOpener {
  decryptDataKey(input: {
    readonly keyId: string;
    readonly wrappedKey: Buffer;
    readonly encryptionContext: Record<string, string>;
  }): Promise<Buffer>;
}

/**
 * The two KMS operations this package needs, as a port.
 *
 * Narrow on purpose. The AWS SDK's `send(command)` is a generic with a dozen
 * overloads; a test that stubbed it would be stubbing a shape rather than a
 * contract. Two methods that take and return `Buffer`s can be faked in five
 * lines and read at a glance, and the SDK stays behind one adapter. Each half
 * is its own interface, so a single-purpose cipher can be handed only the half
 * it may use.
 */
export interface KmsDataKeyProvider extends KmsDataKeyGenerator, KmsDataKeyOpener {}

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

/**
 * How a `KmsTokenCipher` is built: its key, its mode, and the KMS operations
 * that mode uses. Both for the default, `seal_and_open`; `GenerateDataKey`
 * alone for `seal_only`; `Decrypt` alone for `open_only`. A full provider may
 * be given to either single mode, and the cipher keeps only its half.
 */
export type KmsTokenCipherConfig =
  | {
      /** A key id, an alias (`alias/recouple-qbo-tokens`) or a full ARN. */
      readonly keyId: string;
      readonly kms: KmsDataKeyProvider;
      readonly mode?: 'seal_and_open';
    }
  | {
      readonly keyId: string;
      readonly kms: KmsDataKeyGenerator;
      readonly mode: 'seal_only';
    }
  | {
      readonly keyId: string;
      readonly kms: KmsDataKeyOpener;
      readonly mode: 'open_only';
    };

export class KmsTokenCipher implements TokenCipher {
  readonly name = KMS_CIPHER_NAME;
  readonly mode: TokenCipherMode;
  private readonly keyId: string;
  /** `GenerateDataKey`, held only by a cipher that may seal. */
  private readonly generate: KmsDataKeyGenerator['generateDataKey'] | undefined;
  /** `Decrypt`, held only by a cipher that may open. */
  private readonly unwrap: KmsDataKeyOpener['decryptDataKey'] | undefined;

  constructor(config: KmsTokenCipherConfig) {
    if (typeof config.keyId !== 'string' || config.keyId.trim() === '') {
      throw new Error('a KMS token cipher needs a key id');
    }
    this.keyId = config.keyId;
    // Checked at run time as well as by the type: a mode is configuration, and
    // one this class does not know must not fall through to the default.
    switch (config.mode) {
      case undefined:
      case 'seal_and_open':
        this.mode = 'seal_and_open';
        this.generate = generatorOf(config.kms);
        this.unwrap = openerOf(config.kms);
        break;
      case 'seal_only':
        this.mode = 'seal_only';
        this.generate = generatorOf(config.kms);
        this.unwrap = undefined;
        break;
      case 'open_only':
        this.mode = 'open_only';
        this.generate = undefined;
        this.unwrap = openerOf(config.kms);
        break;
      default:
        throw unknownMode();
    }
  }

  /**
   * The production constructor: this key, AWS's own credential resolution, and
   * a mode — `seal_and_open` unless one is named, which is the QuickBooks
   * cipher; `seal_only` for the app's portal cipher and `open_only` for the
   * worker's (ADR 0057 §7).
   */
  static forKey(
    keyId: string,
    options: { readonly region?: string; readonly mode?: TokenCipherMode } = {},
  ): KmsTokenCipher {
    const kms = awsKmsDataKeyProvider(options);
    const mode = options.mode ?? 'seal_and_open';
    switch (mode) {
      case 'seal_and_open':
        return new KmsTokenCipher({ keyId, kms });
      case 'seal_only':
        return new KmsTokenCipher({ keyId, kms, mode });
      case 'open_only':
        return new KmsTokenCipher({ keyId, kms, mode });
      default:
        throw unknownMode();
    }
  }

  async encrypt(plaintext: string, context: TokenEncryptionContext): Promise<SealedToken> {
    if (this.generate === undefined) {
      throw new TokenCipherModeError(this.mode, 'seal');
    }
    const encryptionContext = kmsEncryptionContext(context);
    const aad = encryptionContextAad(context);
    const key = await this.generate({ keyId: this.keyId, encryptionContext });
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
    if (this.unwrap === undefined) {
      throw new TokenCipherModeError(this.mode, 'open');
    }
    if (sealed.cipher !== this.name) {
      throw new TokenCipherMismatchError(this.name, sealed.cipher);
    }
    const encryptionContext = kmsEncryptionContext(context);
    const aad = encryptionContextAad(context);

    let dataKey: Buffer;
    try {
      dataKey = await this.unwrap({
        // The row's key for a cipher that also seals (the QuickBooks one, whose
        // rows outlive an alias moving); this cipher's own key for one that
        // only opens, so KMS refuses anything wrapped under another key.
        keyId: this.mode === 'open_only' ? this.keyId : sealed.keyId,
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
 * `GenerateDataKey` alone, bound to the provider it came from. Checked here,
 * so a cipher missing the operation its mode needs fails when it is built, not
 * on the first credential.
 */
function generatorOf(kms: KmsDataKeyGenerator): KmsDataKeyGenerator['generateDataKey'] {
  if (typeof kms?.generateDataKey !== 'function') {
    throw new Error('a KMS token cipher that seals needs GenerateDataKey');
  }
  return (input) => kms.generateDataKey(input);
}

/** `Decrypt` alone, bound to the provider it came from. */
function openerOf(kms: KmsDataKeyOpener): KmsDataKeyOpener['decryptDataKey'] {
  if (typeof kms?.decryptDataKey !== 'function') {
    throw new Error('a KMS token cipher that opens needs Decrypt');
  }
  return (input) => kms.decryptDataKey(input);
}

function unknownMode(): Error {
  return new Error(`a KMS token cipher's mode is one of ${TOKEN_CIPHER_MODES.join(', ')}`);
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
