// Where a recipe may send the worker's browser (ADR 0057 §6). A recipe is
// written by a tenant's owner, and the worker is shared across tenants and runs
// inside the operator's network. So before anything is decrypted, every place a
// recipe's own text can send the browser is read here, and a recipe that names
// one it may not go to is refused, whoever wrote it:
//
//  1. Its hosts. Each host on its allowlist, and its sign-in origin's, must be
//     a public destination (below).
//  2. Its step URLs: every `open` step's `url` and every `search` step's
//     `recordedAction`, inside a `for_each` too. Each must pass the guard's own
//     rule for a GET (`decideRequest`): http or https, to a host on the
//     allowlist. At run time the guard decides every request the runner's route
//     handler or its egress proxy sees. A navigation the runner starts itself,
//     to a URL that is not http(s) (`data:`, `about:`, `chrome:`,
//     `javascript:`), reaches neither, and a recipe that opened one would have
//     a page its own text wrote, or the browser's, captured as the portal's.
//     So the rule is asked here, of the recipe's text. A step URL carries no
//     user name or password either: a credential is sealed, never written in a
//     recipe.
//  3. Its scheme. The sign-in origin and every step URL are https. Plain http
//     is admitted to loopback alone, and only for a test's worker, whose
//     fixture portal serves it.
//
// Public, for a host, is destination-policy.ts's rule (`isPublicHostname`),
// the one the egress proxy holds every connection to at run time.
//
// A host is read as the browser reads it, through the WHATWG URL parser, so
// `2130706433`, `0x7f.1` and `127.1` are all 127.0.0.1 here as they are there.
//
// This is the recipe's own text, read before anything is decrypted. It is not
// what keeps the browser off the operator's network at run time, because a
// name is not an address and a recipe's text is not everything a page can
// send the browser to (a link, a redirect, a page's own request). That is the
// egress proxy's (packages/portal/src/runner/egress.ts): every request the
// browser sends goes through it, the ones the runner's route handler allowed
// included, and it resolves each name, refuses the connection when any answer
// is not public under the policy this worker runs with, and connects to the
// answer it checked; it refuses plain http to anything but loopback, and
// loopback to anything but a test's worker. This check refuses early, and
// whoever wrote the recipe, a recipe that could only fail there.
import {
  PUBLIC_DESTINATIONS_ONLY,
  decideRequest,
  isLoopbackHostname,
  isPublicHostname,
  type DestinationPolicy,
  type RecipeStep,
  type RecipeVersion,
} from './portal';

export { PUBLIC_DESTINATIONS_ONLY, isPublicHostname, type DestinationPolicy };

/** Why a recipe may not run on this worker, read from its own text before anything is decrypted. */
export type DestinationRefusal =
  /** A host on its allowlist, or its sign-in origin's host, is not a public destination. */
  | 'host_not_public'
  /** A step's URL is one the guard would not let the browser load (not http(s), or to a host off the allowlist), or carries a user name or password. */
  | 'step_url_not_allowed'
  /** Its sign-in origin, or a step's URL, is not https, and is not plain http to a test's loopback fixture. */
  | 'not_https';

/**
 * The first of the three rules above that `recipe` breaks, in their order, or
 * null when nothing its text names would send the browser anywhere it may not
 * go under `policy`. A code and nothing else, because a recipe's hosts and URLs
 * are its own text and are never logged.
 */
export function destinationRefusal(recipe: RecipeVersion, policy: DestinationPolicy): DestinationRefusal | null {
  if (namesNonPublicHost(recipe, policy)) return 'host_not_public';
  const urls = stepUrls(recipe.steps);
  if (!urls.every((url) => stepUrlAllowed(recipe, url))) return 'step_url_not_allowed';
  if (![recipe.signIn.origin, ...urls].every((url) => isSecure(url, policy))) return 'not_https';
  return null;
}

/**
 * Whether a recipe names a host that is not a public destination: any host on
 * its allowlist, or its sign-in origin's host (which the recipe schema
 * requires to be on the allowlist, and which is asked again here rather than
 * relied on). A host the URL parser reads nothing from counts as one: no
 * browser could be sent there, and nothing about it is public. The allowlist
 * is where the guard lets the browser's requests go; the URLs the recipe's
 * steps name are asked of separately (`destinationRefusal`).
 */
export function namesNonPublicHost(recipe: Pick<RecipeVersion, 'hostAllowlist' | 'signIn'>, policy: DestinationPolicy): boolean {
  const hostnames = [...recipe.hostAllowlist.map((host) => hostnameOf(`http://${host}`)), hostnameOf(recipe.signIn.origin)];
  return hostnames.some((hostname) => hostname === null || !isPublicHostname(hostname, policy));
}

/**
 * Every URL a recipe's steps name, `for_each` bodies included: an `open`
 * step's `url` and a `search` step's `recordedAction`. The other kinds act on
 * what the page shows, or on the bound forms, and name no URL. Every kind is
 * listed, so a kind added later does not compile here until someone has said
 * what it names.
 */
export function stepUrls(steps: readonly RecipeStep[]): string[] {
  return steps.flatMap(urlsOf);
}

function urlsOf(step: RecipeStep): string[] {
  switch (step.kind) {
    case 'open':
      return [step.url];
    case 'search':
      return [step.recordedAction];
    case 'for_each':
      return stepUrls(step.steps);
    case 'sign_in':
    case 'answer_mfa':
    case 'sign_out':
    case 'dismiss':
    case 'follow':
    case 'wait_for':
    case 'expect':
    case 'capture_page':
    case 'download':
    case 'next_page':
      return [];
  }
}

/** The guard's own rule for a GET (`decideRequest`: http or https, to a host on the allowlist), with no user name or password. */
function stepUrlAllowed(recipe: RecipeVersion, url: string): boolean {
  const parsed = parsedUrl(url);
  if (parsed === null || parsed.username !== '' || parsed.password !== '') return false;
  return decideRequest(recipe, { method: 'GET', url, body: null, activeStep: null }).allow;
}

/** https, or plain http to a loopback address under a policy that admits loopback. */
function isSecure(url: string, policy: DestinationPolicy): boolean {
  const parsed = parsedUrl(url);
  if (parsed === null) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && policy.allowLoopback && isLoopbackHostname(parsed.hostname);
}

/** The hostname the URL parser reads from `url`, or null when it reads none. */
function hostnameOf(url: string): string | null {
  const hostname = parsedUrl(url)?.hostname ?? '';
  return hostname === '' ? null : hostname;
}

function parsedUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    // Not a URL: nothing the browser could be sent to, and the caller refuses it.
    return null;
  }
}
