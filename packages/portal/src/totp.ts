// RFC 6238 TOTP (ADR 0057 §8, option 1): the code an authenticator app would
// show, computed by the worker from the setup key sealed with the password.
// Only the code crosses the network, and only into the portal's bound MFA form.
//
// SHA-1, a 30-second step counted from the Unix epoch, six digits: what
// authenticator apps show by default and what RFC 6238's reference
// implementation computes, whose Appendix B vectors are the tests. Nothing
// here reads a clock; the caller says what time it is.
//
// No secret and no code ever goes into an error message. A refusal names the
// rule and nothing else, as the contract's schemas do.
import { createHmac } from 'node:crypto';
import { PORTAL_LIMITS } from './contracts';

/** RFC 6238's X: the step, in seconds, counted from T0 = 0, the Unix epoch. */
export const TOTP_STEP_SECONDS = 30;
/** The digits an authenticator app shows. RFC 4226 allows six to eight. */
export const TOTP_DIGITS = 6;
export type TotpDigits = 6 | 7 | 8;

const STEP_MS = TOTP_STEP_SECONDS * 1000;
/** RFC 4648 §6. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Canonical base32 as the credential is sealed with it (the contract's `totpSecret` rule). */
const CANONICAL_BASE32 = /^[A-Z2-7]+$/;
/** Unpadded lengths modulo 8 that some byte string encodes to; 1, 3 and 6 are a mistyped key. */
const BASE32_WHOLE_REMAINDERS = new Set([0, 2, 4, 5, 7]);
/** What a person may type for a setup key: base32 letters in either case, spaces, hyphens, trailing '='. */
const TYPED_SETUP_KEY = /^[A-Za-z2-7\s-]*=*$/;

/**
 * The secret is not one this can compute a code from: not canonical base32,
 * not a whole encoding, or shorter or longer than the contract allows. An
 * owner fixes it by entering the setup key again; the message says which rule
 * it broke and never the secret.
 */
export class TotpSecretError extends Error {
  override readonly name = 'TotpSecretError';
}

/** The time or the digit count is not one a code can be computed for. A caller's mistake, not the credential's. */
export class TotpInputError extends Error {
  override readonly name = 'TotpInputError';
}

/**
 * The code for `secret` at `atMs`, milliseconds since the Unix epoch as
 * `Date.now()` gives them: RFC 4226's HOTP over the number of whole steps since
 * the epoch (RFC 6238 §4), zero-padded to `digits`.
 *
 * Compute it when it is about to be typed, not before. A code is good until
 * its step ends (`totpStepRemainingMs`), and a portal that refuses a code a
 * moment stale would look, after the form is submitted, like a refused
 * credential. A caller that is near the end of a step can wait for the next
 * one.
 */
export function totpCode(secret: string, atMs: number, digits: TotpDigits = TOTP_DIGITS): string {
  assertDigits(digits);
  const counter = BigInt(wholeMs(atMs)) / BigInt(STEP_MS);
  const key = decodeSecret(secret);
  try {
    return hotp(key, counter, digits);
  } finally {
    // Hygiene, not a guarantee, as `zero()` in @recouple/crypto says of itself:
    // the key's bytes are overwritten once the code is computed.
    key.fill(0);
  }
}

/**
 * How long a code computed at `atMs` stays current: the milliseconds until the
 * next step begins, in (0, 30 000].
 */
export function totpStepRemainingMs(atMs: number): number {
  return STEP_MS - (wholeMs(atMs) % STEP_MS);
}

/**
 * A setup key as an authenticator app shows it, folded into the canonical
 * base32 it is sealed as (Settings → Portals, ADR 0057 §7). Spaces, hyphens
 * and trailing `=` padding go, and lower case is raised. Nothing else is
 * guessed at: a `0`, `1`, `8` or `9`, or any other character, is refused rather
 * than read as the letter it might have been. The result is exactly what
 * `totpCode` and the contract's `totpSecret` rule accept.
 */
export function canonicalTotpSecret(typed: string): string {
  const trimmed = typeof typed === 'string' ? typed.trim() : undefined;
  if (trimmed === undefined || !TYPED_SETUP_KEY.test(trimmed)) {
    throw new TotpSecretError(
      'a TOTP setup key has only the letters A–Z and the digits 2–7, with spaces or hyphens between groups',
    );
  }
  const canonical = trimmed.replace(/=+$/, '').replace(/[\s-]+/g, '').toUpperCase();
  // Decoded for its refusals, and the bytes dropped at once.
  decodeSecret(canonical).fill(0);
  return canonical;
}

/** RFC 4226 §5.3: HMAC-SHA-1 over the 8-byte big-endian counter, dynamically truncated. */
function hotp(key: Buffer, counter: bigint, digits: TotpDigits): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', key).update(message).digest();
  try {
    const offset = mac[mac.length - 1]! & 0x0f;
    const binary =
      ((mac[offset]! & 0x7f) << 24) |
      (mac[offset + 1]! << 16) |
      (mac[offset + 2]! << 8) |
      mac[offset + 3]!;
    return String(binary % 10 ** digits).padStart(digits, '0');
  } finally {
    mac.fill(0);
  }
}

/**
 * Canonical base32 to bytes. The rule is the contract's `totpSecret` rule,
 * limits included, so the worker computes a code from every secret Settings
 * could have sealed and from nothing else. Bits past the last whole byte are
 * dropped, as RFC 4648 decoders do; the contract's rule does not refuse them
 * either.
 */
function decodeSecret(secret: string): Buffer {
  if (
    typeof secret !== 'string' ||
    !CANONICAL_BASE32.test(secret) ||
    !BASE32_WHOLE_REMAINDERS.has(secret.length % 8)
  ) {
    throw new TotpSecretError(
      'a TOTP secret is canonical base32: A–Z and 2–7, no padding or spaces, a whole encoding',
    );
  }
  if (secret.length < PORTAL_LIMITS.totpSecretMin || secret.length > PORTAL_LIMITS.totpSecretMax) {
    throw new TotpSecretError(
      `a TOTP secret is ${PORTAL_LIMITS.totpSecretMin} to ${PORTAL_LIMITS.totpSecretMax} base32 characters`,
    );
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of secret) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  const key = Buffer.from(bytes);
  bytes.fill(0);
  return key;
}

function wholeMs(atMs: number): number {
  if (
    typeof atMs !== 'number' ||
    !Number.isFinite(atMs) ||
    atMs < 0 ||
    atMs > Number.MAX_SAFE_INTEGER
  ) {
    throw new TotpInputError('a TOTP time is milliseconds since the Unix epoch, not before it');
  }
  return Math.floor(atMs);
}

function assertDigits(digits: number): void {
  if (digits !== 6 && digits !== 7 && digits !== 8) {
    throw new TotpInputError('a TOTP code is 6, 7 or 8 digits');
  }
}
