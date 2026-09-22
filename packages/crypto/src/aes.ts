/**
 * The local half of envelope encryption: AES-256-GCM over a data key, framed.
 *
 * Shared by `KmsTokenCipher` and by the local cipher under `./testing`, on
 * purpose (ADR 0033 §4): the round trip, the tamper refusal and the
 * wrong-context refusal are then the *same code* in both, so a test that passes
 * with the local cipher is evidence about the real one rather than about a stub.
 *
 * GCM rather than CBC because a tampered ciphertext has to be refused by the
 * cipher, at the tag, rather than noticed afterwards by something finding the
 * JSON malformed. A credential store that decrypts attacker-chosen bytes into
 * *something* and then parses it is a credential store with a decryption
 * oracle in it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const AES_ALGORITHM = 'aes-256-gcm';
export const AES_KEY_BYTES = 32;
export const AES_IV_BYTES = 12;
export const AES_TAG_BYTES = 16;

/**
 * `iv || tag || ciphertext`, base64.
 *
 * One string rather than three columns because the three are meaningless apart
 * and a row that carried two of them would be a row nobody could open. The
 * lengths are fixed by the algorithm, so the frame needs no header.
 */
export function sealWithDataKey(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  assertKey(key);
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/**
 * The inverse. Throws — a bare `Error` — on a wrong key, a wrong context, a
 * tampered byte or a frame that is too short to be one.
 *
 * It throws rather than returning a verdict because every caller here turns it
 * into a `TokenDecryptionError` that says nothing about which of those it was.
 */
export function openWithDataKey(key: Buffer, sealed: string, aad: Buffer): Buffer {
  assertKey(key);
  const framed = Buffer.from(sealed, 'base64');
  if (framed.length < AES_IV_BYTES + AES_TAG_BYTES) {
    throw new Error('sealed value is too short to carry an iv and a tag');
  }
  const iv = framed.subarray(0, AES_IV_BYTES);
  const tag = framed.subarray(AES_IV_BYTES, AES_IV_BYTES + AES_TAG_BYTES);
  const body = framed.subarray(AES_IV_BYTES + AES_TAG_BYTES);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** A fresh 256-bit data key. Used once, then zeroed by its caller. */
export function newDataKey(): Buffer {
  return randomBytes(AES_KEY_BYTES);
}

/**
 * Overwrite a key buffer once it has been used.
 *
 * Hygiene, not a guarantee, and said out loud as hygiene: V8 copies buffers and
 * a garbage collector moves them, so this narrows the window rather than
 * closing it. It costs nothing and it means a heap dump taken a second later is
 * less likely to hold a usable key.
 */
export function zero(key: Buffer): void {
  key.fill(0);
}

function assertKey(key: Buffer): void {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`a data key must be ${AES_KEY_BYTES} bytes; this one is ${key.length}`);
  }
}
