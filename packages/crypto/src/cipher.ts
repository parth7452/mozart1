/**
 * The `TokenCipher` port: how a credential is sealed before it goes anywhere we
 * can read (ADR 0033).
 *
 * A token set is sealed with a data key that is used once and then thrown away,
 * and the data key itself is stored only in wrapped form. What is written down
 * is `{cipher, keyId, wrappedKey, ciphertext}` — four values, none of which
 * opens the others without a call to something this process is authorised to
 * ask and the database is not.
 *
 * **The encryption context is part of the ciphertext, not metadata beside it.**
 * `{orgId, realmId}` is authenticated: a sealed value lifted out of one
 * tenant's row and dropped into another's does not open, and neither does one
 * replayed against a different company of the same tenant. That is what makes a
 * row-level compromise of the database not a cross-tenant credential leak, and
 * it is why every method takes the context rather than trusting the row it came
 * from.
 *
 * Nothing in this file reads `process.env`, opens a socket or knows what a
 * QuickBooks token looks like. It seals a string.
 */

/**
 * What a sealed value is bound to.
 *
 * Both halves are required and neither may be blank: an empty context is a
 * context that matches anything, which is the same as no context at all.
 */
export interface TokenEncryptionContext {
  readonly orgId: string;
  /** The provider's key for the company — QBO's `realmId`. Names it; proves nothing. */
  readonly realmId: string;
}

/**
 * A sealed token set, exactly as it is stored.
 *
 * Every field here is safe in a column. `cipher` and `keyId` are names,
 * `wrappedKey` needs a KMS call to open, and `ciphertext` needs the data key
 * inside `wrappedKey`.
 */
export interface SealedToken {
  /** Which cipher sealed it, so an old row says how to open it. */
  readonly cipher: string;
  /** The key that can unwrap `wrappedKey`. A name for key material, never key material. */
  readonly keyId: string;
  /** The data key, encrypted, base64. */
  readonly wrappedKey: string;
  /** The payload under the data key, base64. */
  readonly ciphertext: string;
}

export interface TokenCipher {
  /** The name written to `cipher`. Constant per implementation. */
  readonly name: string;
  encrypt(plaintext: string, context: TokenEncryptionContext): Promise<SealedToken>;
  decrypt(sealed: SealedToken, context: TokenEncryptionContext): Promise<string>;
}

/** Base class, so a caller can catch every sealing failure in one place. */
export class TokenCipherError extends Error {
  constructor(message: string) {
    super(message);
    // Each subclass also names itself with a literal. `new.target.name` is the
    // class's name only until a bundler minifies it, and these names are
    // recorded (a run's `error_class`, an audit row) and read back by the
    // pages that tell a person what to do.
    this.name = new.target.name;
  }
}

/** The context is missing a half, or one of them is blank. */
export class TokenContextError extends TokenCipherError {
  override name = 'TokenContextError';
}

/**
 * The row was sealed by a cipher this one is not.
 *
 * A separate error from a decryption failure because the operator action is
 * different: one is "deploy the build that has that cipher", the other is "the
 * key or the row is wrong".
 */
export class TokenCipherMismatchError extends TokenCipherError {
  override name = 'TokenCipherMismatchError';
  constructor(
    readonly expected: string,
    readonly found: string,
  ) {
    super(`a value sealed with ${found} cannot be opened by ${expected}`);
  }
}

/**
 * It did not open.
 *
 * A wrong key, a wrong context, a tampered ciphertext and a KMS that said no
 * are all this, and deliberately so: telling them apart in a message tells
 * whoever is holding the ciphertext which of their guesses was closest.
 *
 * **It carries ids and never bytes.** Not the ciphertext, not the wrapped key,
 * not what the plaintext would have been, and not the underlying error's
 * message — `reason` is a class name, because a message off this path travels
 * into logs and a third party's run history (ADR 0031 §2, ADR 0033 §3). It is
 * not called `cause`, because `Error.cause` is where a serialised chain would
 * put the message we just replaced.
 */
export class TokenDecryptionError extends TokenCipherError {
  override name = 'TokenDecryptionError';
  constructor(
    readonly cipher: string,
    readonly keyId: string,
    readonly reason: string,
  ) {
    super(`a token sealed with ${cipher} under key ${keyId} did not open (${reason})`);
  }
}

/** The class name of whatever went wrong, which is all an error here may repeat. */
export function causeName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The context as KMS wants it: a flat map of strings.
 *
 * The key names are snake_case and fixed, because they are stored inside AWS's
 * own ciphertext and changing one would make every existing row undecryptable.
 */
export function kmsEncryptionContext(
  context: TokenEncryptionContext,
): Record<string, string> {
  assertContext(context);
  return { org_id: context.orgId, realm_id: context.realmId };
}

/**
 * The context as AES-GCM additional authenticated data.
 *
 * Length-prefixed rather than delimited, so no pair of values can be arranged
 * to produce another pair's encoding — `{org: 'a|realm_id', realm: 'b'}` and
 * `{org: 'a', realm: 'realm_id|b'}` would otherwise be the same string, and a
 * context that two different contexts share is not a context.
 */
export function encryptionContextAad(context: TokenEncryptionContext): Buffer {
  assertContext(context);
  const part = (name: string, value: string): string =>
    `${name}:${Buffer.byteLength(value, 'utf8')}:${value}`;
  return Buffer.from(
    `recouple-token-v1|${part('org_id', context.orgId)}|${part('realm_id', context.realmId)}`,
    'utf8',
  );
}

function assertContext(context: TokenEncryptionContext): void {
  if (typeof context?.orgId !== 'string' || context.orgId.trim() === '') {
    throw new TokenContextError('a token encryption context needs an orgId');
  }
  if (typeof context.realmId !== 'string' || context.realmId.trim() === '') {
    throw new TokenContextError('a token encryption context needs a realmId');
  }
}
