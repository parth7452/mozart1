/**
 * A `TokenCipher` with no cloud behind it.
 *
 * It lives under `@recouple/crypto/testing` and the package index does not
 * re-export it, for the reason `InMemoryQboTokenStore` and `NullScanner` are
 * kept apart: a fixture reachable from a production path is a fixture that will
 * eventually run there, and this one would run there holding a customer's
 * QuickBooks credentials. `packages/crypto/test/cipher.test.ts` asserts the
 * absence; `qboTokenStoreFromEnv` has no branch that could select it.
 *
 * **It does envelope encryption for real.** A fresh data key per operation,
 * wrapped under a root key with the same encryption context as additional
 * authenticated data, and the same AES-256-GCM framing `KmsTokenCipher` uses —
 * the difference is only who holds the wrapping key. So the round trip, the
 * tamper refusal and the wrong-context refusal exercise the same code in both,
 * and a test that passes here is evidence about the real one rather than about
 * a stub that returned its input.
 *
 * The root key is random per instance unless one is supplied. A
 * `LocalTokenCipher` that somehow did reach production would therefore lose
 * every token on restart rather than protect them with a key committed to git —
 * loud, and recoverable by reconnecting, which is the better of the two
 * failures.
 */

import { randomBytes } from 'node:crypto';
import {
  encryptionContextAad,
  kmsEncryptionContext,
  TokenCipherMismatchError,
  TokenDecryptionError,
  causeName,
  type SealedToken,
  type TokenCipher,
  type TokenEncryptionContext,
} from '../cipher';
import { AES_KEY_BYTES, newDataKey, openWithDataKey, sealWithDataKey, zero } from '../aes';

/** The name this implementation writes to `accounting_credentials.cipher`. */
export const LOCAL_CIPHER_NAME = 'local-aes-256-gcm';

export class LocalTokenCipher implements TokenCipher {
  readonly name = LOCAL_CIPHER_NAME;
  private readonly rootKey: Buffer;
  private readonly keyId: string;

  constructor(options: { readonly rootKey?: Buffer; readonly keyId?: string } = {}) {
    const rootKey = options.rootKey ?? randomBytes(AES_KEY_BYTES);
    if (rootKey.length !== AES_KEY_BYTES) {
      throw new Error(`a local root key must be ${AES_KEY_BYTES} bytes`);
    }
    this.rootKey = Buffer.from(rootKey);
    this.keyId = options.keyId ?? 'local-test-key';
  }

  async encrypt(plaintext: string, context: TokenEncryptionContext): Promise<SealedToken> {
    // Called for its validation: an incomplete context must be refused here for
    // the same reason it is refused by the real cipher, so the two agree about
    // what a context is.
    kmsEncryptionContext(context);
    const aad = encryptionContextAad(context);
    const dataKey = newDataKey();
    try {
      return {
        cipher: this.name,
        keyId: this.keyId,
        wrappedKey: sealWithDataKey(this.rootKey, dataKey, aad),
        ciphertext: sealWithDataKey(dataKey, Buffer.from(plaintext, 'utf8'), aad),
      };
    } finally {
      zero(dataKey);
    }
  }

  async decrypt(sealed: SealedToken, context: TokenEncryptionContext): Promise<string> {
    if (sealed.cipher !== this.name) {
      throw new TokenCipherMismatchError(this.name, sealed.cipher);
    }
    kmsEncryptionContext(context);
    const aad = encryptionContextAad(context);

    let dataKey: Buffer;
    try {
      dataKey = openWithDataKey(this.rootKey, sealed.wrappedKey, aad);
    } catch (error) {
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
