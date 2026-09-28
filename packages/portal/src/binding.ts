// Where a portal credential may be typed (ADR 0057 §6-7): the binding, computed
// from a recipe version and from nothing else.
//
// The app seals a credential under the binding of the version the database
// holds; the worker computes the binding of the recipe it is handed and refuses
// a run whose binding differs from the credential's, before `kms:Decrypt`. Both
// call `bindingOf`, so the two can disagree only when the recipes do. The
// binding is also inside the encryption context (`portalCredentialContext`),
// so a binding altered in the row does not decrypt either.
//
// Every value here describes the portal and not the credential: an origin, some
// paths and a hash. A refusal names the field and the rule and never the value,
// as the contract's schemas do.
import { createHash } from 'node:crypto';
import {
  PORTAL_CREDENTIAL_PURPOSE,
  PortalBindingSchema,
  type PortalBinding,
  type PortalCredentialContext,
} from './contracts';
import type { RecipeVersion } from './recipe';

/**
 * A host as `RecipeVersionSchema` admits one: exact `host[:port]`, no
 * wildcard, scheme, path or whitespace. So no host contains the `\n` the hash
 * joins them with, and no two lists join to the same text.
 */
const HOST = /^[a-z0-9.-]+(:\d+)?$/i;

/** A recipe, or a binding, that gives no binding the contract accepts. */
export class PortalBindingError extends Error {
  override readonly name = 'PortalBindingError';
  constructor(readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]) {
    super(`no portal binding: ${issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`);
  }
}

/**
 * The host allowlist's hash: SHA-256, as lower-case hex, of the hosts
 * lower-cased, without duplicates, sorted as `Array.prototype.sort()` sorts,
 * and joined by `\n`.
 *
 * A function of the set of hosts and nothing else: the order a recipe lists
 * them in, a host's case, and a host listed twice change nothing about where
 * the browser may go, so they change nothing here either, and a new version
 * that only reorders its allowlist still opens the credential. A host added,
 * removed or given another port is another destination and another hash.
 *
 * This is the one computation of it (ADR 0057 §7). Every stored credential's
 * `hosts_hash` was made by it and is authenticated inside its ciphertext, so a
 * change to it strands them all: `binding.test.ts` pins its output.
 */
export function hostsHash(allowlist: readonly string[]): string {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new PortalBindingError([{ path: ['hostAllowlist'], message: 'at least one host' }]);
  }
  allowlist.forEach((host: unknown, i) => {
    if (typeof host !== 'string' || !HOST.test(host)) {
      throw new PortalBindingError([{ path: ['hostAllowlist', i], message: 'exact host[:port], no wildcards' }]);
    }
  });
  const hosts = [...new Set(allowlist.map((host) => host.toLowerCase()))].sort();
  return createHash('sha256').update(hosts.join('\n'), 'utf8').digest('hex');
}

/**
 * A recipe version's binding, canonical so one recipe gives one binding
 * wherever it is computed (the contract's `PortalBinding`):
 *  - `signInOrigin`: `new URL(recipe.signIn.origin).origin`;
 *  - `signInPaths`: `formPaths`, `mfaPaths` and `acsPaths` together, without
 *    duplicates, in `Array.prototype.sort()` order;
 *  - `hostsHash`: `hostsHash(recipe.hostAllowlist)`.
 *
 * Checked against `PortalBindingSchema` before it is returned, so a recipe the
 * contract could not bind (an origin that is not http(s), more sign-in paths
 * than it allows) is a `PortalBindingError` here, before anything is sealed or
 * compared, rather than a binding nothing will ever match.
 */
export function bindingOf(recipe: RecipeVersion): PortalBinding {
  const parsed = PortalBindingSchema.safeParse({
    signInOrigin: originOf(recipe.signIn.origin),
    signInPaths: [
      ...new Set([...recipe.signIn.formPaths, ...recipe.signIn.mfaPaths, ...recipe.signIn.acsPaths]),
    ].sort(),
    hostsHash: hostsHash(recipe.hostAllowlist),
  });
  if (!parsed.success) {
    throw new PortalBindingError(parsed.error.issues);
  }
  return parsed.data;
}

/**
 * Whether two bindings name the same destination: the same origin, the same
 * paths in the same order, and the same hosts hash. The order counts, so a
 * binding that is not canonical matches nothing, and the worker refuses the
 * run rather than decrypting for it.
 */
export function sameBinding(a: PortalBinding, b: PortalBinding): boolean {
  return (
    a.signInOrigin === b.signInOrigin &&
    a.hostsHash === b.hostsHash &&
    a.signInPaths.length === b.signInPaths.length &&
    a.signInPaths.every((path, i) => path === b.signInPaths[i])
  );
}

/**
 * The encryption context a credential is sealed and opened under (ADR 0057
 * §7): the portal variant of `TokenEncryptionContext` in @recouple/crypto,
 * built in one place so the app that seals and the worker that opens cannot
 * build it two ways. The binding must be canonical, and is checked; the ids
 * are checked by the cipher, which refuses a blank one.
 */
export function portalCredentialContext(
  ids: { readonly orgId: string; readonly connectionId: string },
  binding: PortalBinding,
): PortalCredentialContext {
  const parsed = PortalBindingSchema.safeParse({
    signInOrigin: binding.signInOrigin,
    signInPaths: binding.signInPaths,
    hostsHash: binding.hostsHash,
  });
  if (!parsed.success) {
    throw new PortalBindingError(parsed.error.issues);
  }
  return {
    purpose: PORTAL_CREDENTIAL_PURPOSE,
    orgId: ids.orgId,
    connectionId: ids.connectionId,
    signInOrigin: parsed.data.signInOrigin,
    signInPaths: [...parsed.data.signInPaths],
    hostsHash: parsed.data.hostsHash,
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // The parser's message quotes the input; the refusal names the field.
    throw new PortalBindingError([{ path: ['signIn', 'origin'], message: 'a URL' }]);
  }
}
