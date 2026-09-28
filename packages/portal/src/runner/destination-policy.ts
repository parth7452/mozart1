// Where the worker's browser may connect (ADR 0057 §6). A recipe is written
// by a tenant's owner, and the worker is shared across tenants and runs inside
// the operator's network, so an address is held to one rule in two places:
//  - before anything is decrypted, the worker reads the hosts a recipe's own
//    text names (services/portal-read/src/destinations.ts, `isPublicHostname`);
//  - at run time, the egress proxy resolves every name the browser asks for,
//    refuses a connection when any answer is not an address this policy
//    admits, and connects to the answer it checked (egress.ts,
//    `addressAllowed`), so a public name whose DNS answer is private is
//    refused, and an answer that changes between the check and the connection
//    cannot move it.
//
// Public, for a host:
//  - an IPv4 address that is public unicast, not loopback, private, shared
//    (CGNAT), link-local (169.254.169.254 among it), multicast, reserved or
//    documentation;
//  - an IPv6 address in global unicast (2000::/3) that carries no IPv4 address
//    (6to4, Teredo) and is not kept for documentation. That refuses loopback,
//    unique-local fc00::/7 (Fly's private network, fdaa::/16, among it),
//    link-local, multicast, and IPv4-mapped and NAT64 addresses;
//  - a name that a public resolver answers: not `localhost` or its
//    subdomains, Fly's `.internal` or `.flycast`, mDNS's `.local`, or the other
//    suffixes networks keep for themselves, and not a name with no dot, which
//    a resolver completes with its own search domains.
//
// Plain http goes nowhere but loopback, and only under a policy that admits
// loopback: a test's worker, whose fixture portal serves http there. Every
// other connection is https, so that what the browser types is read by the
// portal and nobody on the way.
//
// Pure: Node's own address parsing, and nothing that opens a socket.
import { BlockList, isIP } from 'node:net';

export interface DestinationPolicy {
  /**
   * Whether a loopback address (127.0.0.0/8, ::1) may be a destination, over
   * plain http as well as https. Only a test's worker, whose fixture portal
   * listens on loopback over http, is started with it; the worker's `main.ts`
   * never is. It admits loopback and nothing else.
   */
  readonly allowLoopback: boolean;
}

/** What the worker's `main.ts` runs with: public destinations only, over https. */
export const PUBLIC_DESTINATIONS_ONLY: DestinationPolicy = { allowLoopback: false };

/** IPv4 space that is not public unicast (RFC 6890's special-purpose registry, and multicast). */
const NOT_PUBLIC_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['169.254.0.0', 16], // link-local, and cloud metadata services
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
];

/** Global unicast, and the parts of it that are not a host of their own. */
const GLOBAL_V6: readonly (readonly [string, number])[] = [['2000::', 3]];
const NOT_PUBLIC_WITHIN_GLOBAL_V6: readonly (readonly [string, number])[] = [
  ['2001::', 32], // Teredo: an IPv4 address inside
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: an IPv4 address inside
];

/** Suffixes of names that only a private resolver answers, or that networks keep for themselves. */
const PRIVATE_NAME_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'flycast',
  'home.arpa',
  'localdomain',
  'lan',
  'intranet',
  'private',
  'corp',
  'home',
] as const;

function blockList(family: 'ipv4' | 'ipv6', subnets: readonly (readonly [string, number])[]): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family);
  return list;
}

const notPublicV4 = blockList('ipv4', NOT_PUBLIC_V4);
const loopbackV4 = blockList('ipv4', [['127.0.0.0', 8]]);
const globalV6 = blockList('ipv6', GLOBAL_V6);
const notPublicWithinGlobalV6 = blockList('ipv6', NOT_PUBLIC_WITHIN_GLOBAL_V6);

/**
 * Whether `hostname`, as `URL.hostname` gives it (lower case, IPv4
 * normalised, IPv6 in brackets), is a destination the worker's browser may be
 * sent to under `policy`. A name is judged by its text alone: what it resolves
 * to is `addressAllowed`'s question, asked when the browser connects.
 */
export function isPublicHostname(hostname: string, policy: DestinationPolicy): boolean {
  if (isLoopbackHostname(hostname)) return policy.allowLoopback;
  const bare = unbracketed(hostname);
  switch (isIP(bare)) {
    case 4:
      return !notPublicV4.check(bare, 'ipv4');
    case 6:
      return globalV6.check(bare, 'ipv6') && !notPublicWithinGlobalV6.check(bare, 'ipv6');
    default: {
      const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
      if (!name.includes('.')) return false;
      return !PRIVATE_NAME_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
    }
  }
}

/** Whether `hostname` (as `URL.hostname` gives it, or a bare address) is a loopback address: 127.0.0.0/8 or ::1. A name is not, `localhost` included. */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = unbracketed(hostname);
  switch (isIP(bare)) {
    case 4:
      return loopbackV4.check(bare, 'ipv4');
    case 6:
      return bare === '::1';
    default:
      return false;
  }
}

/**
 * Whether the egress proxy may open a connection to `address`, an IP address
 * (a DNS answer, or a host written as one), for a request over `scheme`:
 *  - loopback only under a policy that admits it, over either scheme;
 *  - otherwise https only, to a public address.
 * A name is never an address: it is resolved first, and each answer asked.
 */
export function addressAllowed(address: string, scheme: 'http' | 'https', policy: DestinationPolicy): boolean {
  const bare = unbracketed(address);
  if (isIP(bare) === 0) return false;
  if (isLoopbackHostname(bare)) return policy.allowLoopback;
  return scheme === 'https' && isPublicHostname(bare, policy);
}

function unbracketed(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
