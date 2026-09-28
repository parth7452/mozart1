/**
 * The `TokenCipher` port: how a credential is sealed before it goes anywhere we
 * can read (ADR 0033, ADR 0057 §7).
 *
 * A token set is sealed with a data key that is used once and then thrown away,
 * and the data key itself is stored only in wrapped form. What is written down
 * is `{cipher, keyId, wrappedKey, ciphertext}` — four values, none of which
 * opens the others without a call to something this process is authorised to
 * ask and the database is not.
 *
 * **The encryption context is part of the ciphertext, not metadata beside it.**
 * It comes in two variants, and a value sealed under one never opens under the
 * other. A QuickBooks token set is bound to `{orgId, realmId}`: a sealed value
 * lifted out of one tenant's row and dropped into another's does not open, and
 * neither does one replayed against a different company of the same tenant. A
 * portal credential is bound to its tenant, its connection and its destination
 * — where it may be typed — so it does not open for another tenant, another
 * connection, or a recipe that would send it somewhere else. That is what makes
 * a row-level compromise of the database not a cross-tenant credential leak,
 * and it is why every method takes the context rather than trusting the row it
 * came from.
 *
 * Nothing in this file reads `process.env`, opens a socket or knows what a
 * QuickBooks token or a portal password looks like. It seals a string.
 */

/**
 * What a sealed value is bound to: a QuickBooks token set's context or a
 * portal credential's, told apart by `purpose`, which a QuickBooks context does
 * not have because every one of its rows was sealed before there was a second
 * kind.
 *
 * Every part is required and none may be blank: an empty context is a context
 * that matches anything, which is the same as no context at all. A `purpose`
 * this file does not know is refused rather than read as QuickBooks.
 */
export type TokenEncryptionContext = QboTokenEncryptionContext | PortalCredentialEncryptionContext;

/**
 * A QuickBooks token set's context (ADR 0033): the tenant and the company.
 *
 * Its two encodings, the KMS map and the AAD, are fixed byte for byte: every
 * `accounting_credentials` row was sealed under them, and
 * `packages/crypto/test/cipher.test.ts` opens values sealed before the portal
 * variant existed to keep it so.
 */
export interface QboTokenEncryptionContext {
  /** Never set. A QuickBooks context is the one without a purpose. */
  readonly purpose?: never;
  readonly orgId: string;
  /** The provider's key for the company — QBO's `realmId`. Names it; proves nothing. */
  readonly realmId: string;
}

/**
 * A portal credential's context (ADR 0057 §7): the tenant, the connection, and
 * the binding — the destination the credential may be typed into.
 *
 * The binding is `@recouple/portal`'s, computed from a recipe version and
 * canonical, so one recipe gives one context wherever it is computed: the
 * sign-in origin as `URL.origin` prints it, every path a sign-in or MFA form
 * may post to, sorted with no duplicates, and the host allowlist's hash as
 * lower-case hex SHA-256. This file checks that shape and recomputes none of
 * it. It describes the portal, not the credential, and none of it is secret:
 * the KMS half appears in CloudTrail in the clear.
 *
 * Field for field `PortalCredentialContext` in `@recouple/portal`, which does
 * not depend on this package; `packages/portal/test/binding.test.ts` holds the
 * two to one shape.
 */
export interface PortalCredentialEncryptionContext {
  readonly purpose: 'portal_credential';
  readonly orgId: string;
  /** The `portal_connections` row the credential belongs to. */
  readonly connectionId: string;
  readonly signInOrigin: string;
  readonly signInPaths: readonly string[];
  readonly hostsHash: string;
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

/**
 * What a cipher may do (ADR 0057 §7).
 *
 * The QuickBooks cipher seals and opens: the sync rotates a token set by
 * opening the old one and sealing the new. A portal credential is sealed by the
 * app and opened only by the worker, whose AWS identities may call
 * `kms:GenerateDataKey` and `kms:Decrypt` under the portal key respectively and
 * never the other. A single-purpose cipher says the same thing in code, so a
 * wiring mistake is refused here, by name, before KMS is asked anything.
 */
export const TOKEN_CIPHER_MODES = ['seal_and_open', 'seal_only', 'open_only'] as const;
export type TokenCipherMode = (typeof TOKEN_CIPHER_MODES)[number];

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

/** The context is missing a part, one of them is blank or malformed, or it names a purpose nobody knows. */
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
 * A single-purpose cipher was asked for the other operation: a seal-only
 * cipher to open, or an open-only one to seal.
 *
 * Thrown before the value, the context or KMS is looked at, so it names the
 * cipher's mode and the operation and nothing else. It is a wiring mistake,
 * not a bad row: the app built the worker's cipher, or the other way round.
 */
export class TokenCipherModeError extends TokenCipherError {
  override name = 'TokenCipherModeError';
  constructor(
    readonly mode: TokenCipherMode,
    readonly operation: 'seal' | 'open',
  ) {
    super(`a ${mode} cipher may not ${operation} a token`);
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

/** The purpose a portal credential's context carries, inside every portal ciphertext. */
const PORTAL_PURPOSE = 'portal_credential';

/**
 * The first part of each variant's AAD. Different, so no portal AAD can equal a
 * QuickBooks one, whatever the values; and versioned, so a later encoding is a
 * new tag rather than a reinterpretation of rows already sealed.
 */
const QBO_AAD_TAG = 'recouple-token-v1';
const PORTAL_AAD_TAG = 'recouple-portal-credential-v1';

/**
 * The context as KMS wants it: a flat map of strings.
 *
 * The key names are snake_case and fixed, because they are stored inside AWS's
 * own ciphertext and changing one would make every existing row undecryptable.
 * A QuickBooks context is `{org_id, realm_id}`, exactly as it always was. A
 * portal context also names its `purpose`, which a key policy can require
 * (`kms:EncryptionContext:purpose`), and carries its sign-in paths as the JSON
 * array of the sorted list: one value, which cannot be read two ways.
 */
export function kmsEncryptionContext(
  context: TokenEncryptionContext,
): Record<string, string> {
  assertContext(context);
  if (context.purpose === PORTAL_PURPOSE) {
    return {
      purpose: context.purpose,
      org_id: context.orgId,
      connection_id: context.connectionId,
      sign_in_origin: context.signInOrigin,
      sign_in_paths: pathsValue(context.signInPaths),
      hosts_hash: context.hostsHash,
    };
  }
  return { org_id: context.orgId, realm_id: context.realmId };
}

/**
 * The context as AES-GCM additional authenticated data.
 *
 * Length-prefixed rather than delimited, so no pair of values can be arranged
 * to produce another pair's encoding — `{org: 'a|realm_id', realm: 'b'}` and
 * `{org: 'a', realm: 'realm_id|b'}` would otherwise be the same string, and a
 * context that two different contexts share is not a context. A portal context
 * is the same scheme under its own tag, its parts in a fixed order, and its
 * paths as the one JSON value the KMS map carries.
 */
export function encryptionContextAad(context: TokenEncryptionContext): Buffer {
  assertContext(context);
  const part = (name: string, value: string): string =>
    `${name}:${Buffer.byteLength(value, 'utf8')}:${value}`;
  if (context.purpose === PORTAL_PURPOSE) {
    return Buffer.from(
      [
        PORTAL_AAD_TAG,
        part('purpose', context.purpose),
        part('org_id', context.orgId),
        part('connection_id', context.connectionId),
        part('sign_in_origin', context.signInOrigin),
        part('sign_in_paths', pathsValue(context.signInPaths)),
        part('hosts_hash', context.hostsHash),
      ].join('|'),
      'utf8',
    );
  }
  return Buffer.from(
    `${QBO_AAD_TAG}|${part('org_id', context.orgId)}|${part('realm_id', context.realmId)}`,
    'utf8',
  );
}

/**
 * The sign-in paths as one string. Copied into a plain array first, so what is
 * encoded is exactly the elements `assertContext` checked, whatever the array
 * it came in carries beside them.
 */
function pathsValue(paths: readonly string[]): string {
  return JSON.stringify([...paths]);
}

function assertContext(context: TokenEncryptionContext): void {
  const purpose: unknown = (context as { readonly purpose?: unknown } | null | undefined)?.purpose;
  if (purpose === undefined) {
    assertQboContext(context as QboTokenEncryptionContext);
    return;
  }
  if (purpose !== PORTAL_PURPOSE) {
    // Never read as QuickBooks: a variant this file does not know, encoded as
    // the one it does, would be interchangeable with it.
    throw new TokenContextError('a token encryption context names a purpose this cipher does not know');
  }
  assertPortalContext(context as PortalCredentialEncryptionContext);
}

function assertQboContext(context: QboTokenEncryptionContext): void {
  if (typeof context?.orgId !== 'string' || context.orgId.trim() === '') {
    throw new TokenContextError('a token encryption context needs an orgId');
  }
  if (typeof context.realmId !== 'string' || context.realmId.trim() === '') {
    throw new TokenContextError('a token encryption context needs a realmId');
  }
}

/** Lower-case hex SHA-256, as `@recouple/portal` prints a hosts hash. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A UTF-16 surrogate with no partner. UTF-8 encodes every one of them as the
 * same replacement character, so two ids differing only there would give one
 * AAD; an id that carries one is refused instead.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Every refusal names the part and the rule and never the value, like every
 * other message here. None of the values is secret, but the rule is the same
 * for all of them.
 */
function assertPortalContext(context: PortalCredentialEncryptionContext): void {
  const id = (value: unknown, what: string): void => {
    if (typeof value !== 'string' || value.trim() === '' || LONE_SURROGATE.test(value)) {
      throw new TokenContextError(`a portal credential context needs ${what}`);
    }
  };
  id(context.orgId, 'an orgId');
  id(context.connectionId, 'a connectionId');

  if (!isCanonicalOrigin(context.signInOrigin)) {
    throw new TokenContextError(
      'a portal credential context needs its sign-in origin as URL.origin prints an http(s) origin',
    );
  }

  const paths: unknown = context.signInPaths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new TokenContextError('a portal credential context needs at least one sign-in path');
  }
  let previous: string | undefined;
  for (const path of paths as unknown[]) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new TokenContextError('every sign-in path in a portal credential context starts with /');
    }
    // Sorted as `Array.prototype.sort()` sorts (UTF-16 code units), strictly,
    // so there are no duplicates either: the binding is canonical, and a
    // context that is not was computed somewhere other than `bindingOf`.
    if (previous !== undefined && !(previous < path)) {
      throw new TokenContextError(
        'the sign-in paths in a portal credential context are sorted, with no duplicates',
      );
    }
    previous = path;
  }

  if (typeof context.hostsHash !== 'string' || !SHA256_HEX.test(context.hostsHash)) {
    throw new TokenContextError(
      'a portal credential context needs its hosts hash as lower-case hex SHA-256',
    );
  }
}

/** Scheme, host and port only, exactly as `URL.origin` prints them, over http(s). */
function isCanonicalOrigin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL at all, which the caller refuses by name.
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
}
