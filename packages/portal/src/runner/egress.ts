// The browser's only way out (ADR 0057 §1 and §6, "Egress"), and the guard
// for everything that goes through it. The runner launches Chromium with this
// in-process proxy as the proxy for every URL, loopback included, and the
// route handler hands every request it allows back to the browser, so every
// request the browser sends reaches the network through here or not at all:
// what the route handler saw first, and what Playwright never routes. That is
// a redirect hop, a request whose frame is gone (a beacon or a keepalive fetch
// sent as a page unloads, a popup that closed itself), a WebSocket from a
// worker or a `WebSocketStream`, a download, and the browser's own background
// traffic. Nothing goes around it by UDP: not WebRTC, and not WebTransport
// (egressSwitches).
//
// It decides method and target, as the route handler does:
//  - A destination is first held to the guard's host rule (`destinationAllowed`):
//    a CONNECT to a host off the allowlist is answered 403, and a plain
//    request to one has its connection closed, unread and uncounted, since
//    most of it is the browser's own traffic and the page's is counted where
//    the runner sees it.
//  - Inside a tunnel to an allowed host the proxy answers the TLS handshake
//    itself, with a certificate made for this run that the browser is told to
//    accept and nothing else is (certificate.ts), so that it reads each
//    request there as it reads a plain one.
//  - Every request it reads, its body included, is put to the guard (`decide`)
//    with the step running when it arrives. An upgrade, a WebSocket among
//    them, is refused, whoever asked. A refusal is answered 403 and reported
//    (`refused`), so the runner counts it, and a refused navigation ends the
//    run.
//  - What the guard allows is sent on by the proxy's own connection, and only
//    to an address `destinations` admits: a name is resolved, the connection
//    is refused when any answer is not admitted, and it is opened to the
//    answer that was checked, so a public name whose DNS answer is private
//    reaches nothing, and an answer that changes in between cannot move it.
//    Plain http goes to loopback alone, under a policy that admits it (a
//    test's worker); every other connection is https, and the portal's
//    certificate is checked against the system's roots.
//
// Nothing is kept: no request, header, body or URL is logged or stored here.
// A refusal reported carries a method, a URL and a reason, for the runner to
// count and never to list.
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type AddressInfo, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import type { GuardDecision } from '../guard';
import { egressCertificate } from './certificate';
import { addressAllowed, type DestinationPolicy } from './destination-policy';

/** A request the proxy read, as the guard is asked about it. */
export interface EgressRequest {
  /** Upper case. `WEBSOCKET` for a WebSocket's upgrade, which is refused whoever asks. */
  readonly method: string;
  /** The tunnel's scheme (https once the browser spoke TLS in it) and authority with the request's own path and query, or a plain request's own URL. */
  readonly url: string;
  /** What it carried, as text; null for no body. */
  readonly body: string | null;
  /**
   * Whether the browser sent it as a navigation: `Sec-Fetch-Mode: navigate`,
   * or `Upgrade-Insecure-Requests: 1`, which Chromium puts on every
   * navigation, to any origin. A page's script can add the second to a fetch,
   * which can only make the run stop.
   */
  readonly navigation: boolean;
}

/** Why the proxy refused a request it read: the guard's reason, or one of its own. */
export type EgressRefusal =
  | Exclude<GuardDecision, { allow: true }>['reason']
  /** Its destination is, or resolved to, an address `destinations` does not admit, or it is plain http to one that is not loopback. */
  | 'address_not_allowed'
  /** A body larger than the proxy reads to decide on (`MAX_BODY_BYTES`). */
  | 'body_too_large';

/** A name's DNS answers, every one of them: `dns.lookup`'s, unless a test answers for it. */
export type Resolver = (hostname: string) => Promise<readonly { readonly address: string; readonly family: number }[]>;

export interface EgressOptions {
  /**
   * Whether the browser may reach this destination at all: asked as
   * `https://host:port/` for a CONNECT, and as its own URL for a plain
   * request. The guard's host rule. A destination refused here is refused
   * unread and uncounted.
   */
  readonly destinationAllowed: (url: URL) => boolean;
  /** The guard, for every request read from an allowed destination, with the step running when it arrived. */
  readonly decide: (request: EgressRequest) => GuardDecision;
  /** Told of every request refused after it was read. Never throws. */
  readonly refused: (request: EgressRequest, reason: EgressRefusal) => void;
  /** Which addresses a connection may be opened to. */
  readonly destinations: DestinationPolicy;
  /** How a name is resolved: `dns.lookup`, every answer, unless a test answers for it. */
  readonly resolve?: Resolver | undefined;
}

export interface Egress {
  /** The proxy's address, for Chromium's `--proxy-server`. */
  readonly server: string;
  /** SHA-256 of the public key the proxy answers TLS with, base64: the one key the browser is told to accept. */
  readonly spkiSha256: string;
  /** Stops listening and cuts every connection still open, tunnels and upstream connections included. */
  close(): Promise<void>;
}

/**
 * The Chromium switches that make the proxy the browser's only way out:
 *  - every URL goes to it, and `<-loopback>` takes away the bypass Chromium
 *    otherwise gives localhost and 127.0.0.1, so a request to the worker's
 *    own loopback is decided too;
 *  - the proxy's own key is the one certificate the browser accepts that no
 *    root vouches for, so it reads what the browser says in a tunnel. Chromium
 *    honours the list only beside `--user-data-dir`, which Playwright always
 *    passes;
 *  - WebRTC may not send UDP around it: no STUN, TURN or peer datagram, only
 *    TCP through the proxy, to a host the proxy decides.
 * WebTransport, which is HTTP/3 over UDP, Chromium does not open through a
 * proxy at all, so the first switch closes it too.
 *
 * Chromium ignores a switch it does not know, without a word, and the WebRTC
 * policy has two spellings: the browser reads `--webrtc-ip-handling-policy`
 * and not `--force-webrtc-ip-handling-policy`, and its headless shell the
 * other way round (both as of Chromium 141). With only the second, a page's
 * STUN requests went out by UDP beside the proxy. Both are passed, so either
 * build the worker drives is held. The runner's tests send WebRTC and
 * WebTransport at a UDP port off the allowlist from each build installed, and
 * count what arrives, beside a control in which the same page, behind the
 * proxy alone, does reach it: a build that renames the switch again fails
 * there, not in production. They also load an https page through the proxy in
 * each build, so a build that stopped honouring the key list fails there too.
 *
 * Passed as switches and not as Playwright's `proxy` option: Playwright's own
 * requests (none, since the route handler only continues or aborts) would
 * otherwise go through it too, and it would have to accept this key as well.
 */
export function egressSwitches(egress: Egress): string[] {
  return [
    `--proxy-server=${egress.server}`,
    '--proxy-bypass-list=<-loopback>',
    `--ignore-certificate-errors-spki-list=${egress.spkiSha256}`,
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}

/** A CONNECT's target as Chromium sends one: a host name, an IPv4 address or a bracketed IPv6 address, and a port. */
const CONNECT_TARGET = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}$/;

/** Headers for one connection only (RFC 9110 §7.6.1), and the proxy's own. Never forwarded. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * The largest body the proxy reads to decide on. A sign-in or MFA form, a
 * SAML assertion posted back, a search and a POST-as-read query are all far
 * smaller; a larger body is refused rather than sent undecided.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** A TLS record's first byte when it opens a handshake (RFC 8446 §5.1): how a tunnel that speaks TLS is told from one that speaks plain HTTP. */
const TLS_HANDSHAKE = 0x16;

/** The answer to a request the proxy refuses after reading it. */
const REFUSED = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

/** A name resolved to an address the policy does not admit. Named by its class alone, and never shown to the page. */
class EgressAddressRefusedError extends Error {
  override readonly name = 'EgressAddressRefusedError';
  constructor() {
    super('a destination resolved to an address the policy does not admit');
  }
}

/** What a tunnel carries: the scheme the browser speaks in it, and the authority it was opened to. */
type Tunnel = { readonly scheme: 'http' | 'https'; readonly authority: string };

/**
 * Starts the proxy on an ephemeral loopback port, with a certificate made for
 * it. Every request it reads is put to `decide`, and what is allowed is sent
 * on to an address `destinations` admits.
 */
export async function startEgress(options: EgressOptions): Promise<Egress> {
  const resolve = options.resolve ?? systemResolver;
  const certificate = egressCertificate();
  const secureContext = createSecureContext({ key: certificate.key, cert: certificate.cert });
  const sockets = new Set<Socket>();
  // Once per socket: an upstream connection kept alive is handed to request after request.
  const track = (s: Socket): Socket => {
    if (sockets.has(s)) return s;
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
    return s;
  };
  /** The tunnel each connection handed to `inner` carries. */
  const tunnels = new WeakMap<Socket, Tunnel>();
  // Upstream connections are kept alive per scheme, each opened through the
  // checked lookup and so to an address that was admitted when it opened.
  const agents = { http: new HttpAgent({ keepAlive: true }), https: new HttpsAgent({ keepAlive: true }) };

  const refuse = (res: ServerResponse, request: EgressRequest, reason: EgressRefusal): void => {
    options.refused(request, reason);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(403, { 'content-length': '0', 'cache-control': 'no-store', connection: 'close' });
    res.end();
  };

  /** One request, read to its end, decided, and sent on or refused. */
  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const read = await readBody(req);
    const request: EgressRequest = {
      method,
      url: url.href,
      body: read === 'too_large' || read === null ? null : read.toString('utf8'),
      navigation: isNavigation(req.headers),
    };
    if (read === 'too_large') {
      refuse(res, request, 'body_too_large');
      return;
    }
    // A browser sends no body with a GET or a HEAD: one that came with a body is not the read the guard would let through.
    if ((method === 'GET' || method === 'HEAD') && read !== null) {
      refuse(res, request, 'non_get_not_allowed');
      return;
    }
    const decision = options.decide(request);
    if (!decision.allow) {
      refuse(res, request, decision.reason);
      return;
    }
    const scheme = url.protocol === 'https:' ? 'https' : 'http';
    const host = hostOf(url);
    // Plain http goes to loopback alone, under a policy that admits it: without one, no name is even looked up.
    if (scheme === 'http' && !options.destinations.allowLoopback) {
      refuse(res, request, 'address_not_allowed');
      return;
    }
    // An address as written is checked here; a name, by the lookup the connection opens through.
    if (isIP(host) !== 0 && !addressAllowed(host, scheme, options.destinations)) {
      refuse(res, request, 'address_not_allowed');
      return;
    }
    const upstream = (scheme === 'https' ? httpsRequest : httpRequest)({
      host,
      port: url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port),
      method,
      path: `${url.pathname}${url.search}`,
      headers: upstreamHeaders(req, url, read),
      agent: agents[scheme],
      lookup: checkedLookup(scheme, options.destinations, resolve),
      ...(scheme === 'https' && isIP(host) === 0 ? { servername: host } : {}),
    });
    upstream.on('socket', (s: Socket) => { track(s); });
    upstream.on('response', (answer: IncomingMessage) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, endToEnd(answer.rawHeaders, answer.headers));
      answer.pipe(res);
      answer.on('error', () => res.destroy());
    });
    // A name that resolved to an address the policy does not admit is a
    // refusal, reported. Anything else (the portal could not be reached, cut
    // the connection, or its certificate did not verify) is the network
    // error the browser would have seen. Each end's error cuts the other, and
    // none is left unhandled, which would end the worker's process.
    upstream.on('error', (e: Error) => {
      if (e instanceof EgressAddressRefusedError) refuse(res, request, 'address_not_allowed');
      else res.destroy();
    });
    res.on('error', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.end(read ?? undefined);
  };

  const handled = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    handle(req, res, url).catch(() => {
      // A connection gone mid-request, or a fault here: the request fails in the browser as a network error would.
      res.destroy();
    });
  };

  // Plain http, in absolute form: the browser asking its proxy for a URL.
  const outer = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      req.socket.destroy(); // an origin-form request: not a browser speaking to its proxy
      return;
    }
    if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || !options.destinationAllowed(url)) {
      req.socket.destroy();
      return;
    }
    handled(req, res, url);
  });
  outer.on('connection', (s: Socket) => {
    track(s);
    // A browser that goes away mid-request resets its socket; the request it carried is then over.
    s.on('error', () => s.destroy());
  });
  outer.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => { tunnel(req, client, head); });
  // Chromium sends a WebSocket through a proxy as a CONNECT; an upgrade in absolute form is nothing a browser sends.
  outer.on('upgrade', (_req: IncomingMessage, client: Socket) => { client.destroy(); });
  outer.on('clientError', (_e: Error, s: Socket) => { s.destroy(); });

  // What the browser says inside a tunnel, read as the outer server reads a
  // plain request: never listening, handed each tunnel's connection by `tunnel`.
  const inner = createServer((req, res) => {
    const carried = tunnels.get(req.socket);
    const url = carried === undefined ? null : inTunnel(carried.scheme, carried.authority, req.url);
    // In a tunnel a browser sends origin-form requests to the host it opened the tunnel to, and nothing else.
    if (url === null) {
      req.socket.destroy();
      return;
    }
    handled(req, res, url);
  });
  inner.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const carried = tunnels.get(socket);
    const websocket = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    const scheme = carried === undefined ? null : websocket ? (carried.scheme === 'https' ? 'wss' : 'ws') : carried.scheme;
    const url = carried === undefined || scheme === null ? null : inTunnel(scheme, carried.authority, req.url);
    if (url !== null) {
      options.refused({ method: websocket ? 'WEBSOCKET' : (req.method ?? 'GET').toUpperCase(), url: url.href, body: null, navigation: false }, 'scheme_not_allowed');
    }
    socket.end(REFUSED);
  });
  inner.on('clientError', (_e: Error, s: Socket) => { s.destroy(); });

  /** A CONNECT: refused, or answered and read, TLS or plain, by `inner`. */
  const tunnel = (req: IncomingMessage, client: Socket, head: Buffer): void => {
    const target = req.url ?? '';
    let url: URL | null = null;
    /** The authority as a plain request in the tunnel names it: http's default port is 80, not 443. */
    let plain = '';
    if (CONNECT_TARGET.test(target)) {
      try {
        url = new URL(`https://${target}/`);
        plain = new URL(`http://${target}/`).host;
      } catch {
        url = null;
      }
    }
    if (url === null || !options.destinationAllowed(url)) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const opened = url;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) client.unshift(head);
    // The first bytes say what the browser speaks in the tunnel: a TLS handshake, or plain HTTP (a ws:// WebSocket).
    const begin = (): void => {
      const first = client.read() as Buffer | null;
      if (first === null) {
        client.once('readable', begin);
        return;
      }
      client.unshift(first);
      if (first[0] === TLS_HANDSHAKE) {
        // HTTP/1.1 only, so every request is one the proxy reads, and a WebSocket can only be an upgrade.
        const tls = new TLSSocket(client, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
        track(tls);
        tls.on('error', () => tls.destroy());
        tls.on('close', () => client.destroy());
        tunnels.set(tls, { scheme: 'https', authority: opened.host });
        inner.emit('connection', tls);
      } else {
        tunnels.set(client, { scheme: 'http', authority: plain });
        inner.emit('connection', client);
      }
    };
    begin();
  };

  await new Promise<void>((resolveListen, reject) => {
    outer.once('error', reject);
    outer.listen(0, '127.0.0.1', () => { outer.off('error', reject); resolveListen(); });
  });
  const { port } = outer.address() as AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    spkiSha256: certificate.spkiSha256,
    close: () => new Promise<void>((resolveClose, reject) => {
      outer.close((e) => (e ? reject(e) : resolveClose()));
      for (const s of sockets) s.destroy();
      agents.http.destroy();
      agents.https.destroy();
    }),
  };
}

/**
 * A request inside a tunnel as a URL: the tunnel's scheme and authority, and
 * the request's own path and query. Null for anything but an origin-form
 * target, which is not what a browser sends in a tunnel, and for one no URL
 * can be made of, so that nothing a page sends can throw here.
 */
function inTunnel(scheme: string, authority: string, target: string | undefined): URL | null {
  if (target === undefined || !target.startsWith('/')) return null;
  try {
    return new URL(`${scheme}://${authority}${target}`);
  } catch {
    return null; // not a request a browser sends; the caller cuts the connection
  }
}

/** Every answer `dns.lookup` has for a name, in the order the system gives them. */
const systemResolver: Resolver = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The lookup an upstream connection opens through: the name resolved, the
 * connection refused (`EgressAddressRefusedError`) when any answer is not
 * admitted for `scheme`, and otherwise given exactly the answers checked, so
 * the connection is opened to one of them and to nothing resolved later.
 */
function checkedLookup(scheme: 'http' | 'https', policy: DestinationPolicy, resolve: Resolver) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    resolve(hostname).then(
      (answers) => {
        if (answers.length === 0 || !answers.every((a) => addressAllowed(a.address, scheme, policy))) {
          callback(new EgressAddressRefusedError(), '');
          return;
        }
        const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const usable = answers.filter((a) => family === undefined || family === 0 || a.family === family).map((a) => ({ address: a.address, family: a.family }));
        if (usable.length === 0) {
          callback(new EgressAddressRefusedError(), '');
          return;
        }
        if (options.all === true) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      },
      (e: unknown) => {
        // The name did not resolve: the network error the browser would have seen.
        callback(e instanceof Error ? e : new Error('the name did not resolve'), '');
      },
    );
  };
}

/** A request's whole body, or null when it has none, or `too_large` past `MAX_BODY_BYTES`. */
function readBody(req: IncomingMessage): Promise<Buffer | null | 'too_large'> {
  const declared = req.headers['content-length'];
  if (req.headers['transfer-encoding'] === undefined && (declared === undefined || declared === '0')) {
    req.resume();
    return Promise.resolve(null);
  }
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    req.resume();
    return Promise.resolve('too_large');
  }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(over ? 'too_large' : length === 0 ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Whether the browser sent a request as a navigation (EgressRequest.navigation). */
function isNavigation(headers: IncomingHttpHeaders): boolean {
  return headers['sec-fetch-mode'] === 'navigate' || headers['upgrade-insecure-requests'] === '1';
}

/**
 * The headers a request is sent on with: the browser's end-to-end headers,
 * with `Host` written from the destination as it was decided, so a request
 * reaches the host the guard allowed and no other on the same address, and a
 * length for the body as it was read.
 */
function upstreamHeaders(req: IncomingMessage, url: URL, body: Buffer | null): string[] {
  const out: string[] = ['Host', url.host];
  const kept = endToEnd(req.rawHeaders, req.headers);
  for (let i = 0; i + 1 < kept.length; i += 2) {
    const lower = kept[i]!.toLowerCase();
    if (lower === 'host' || lower === 'content-length') continue;
    out.push(kept[i]!, kept[i + 1]!);
  }
  if (body !== null) out.push('Content-Length', String(body.length));
  else if (req.method !== 'GET' && req.method !== 'HEAD') out.push('Content-Length', '0');
  return out;
}

/** A URL's host as a socket takes it: an IPv6 address without its brackets. */
function hostOf(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

/** A message's headers, as raw pairs, without the hop-by-hop ones and any a `Connection` header names. */
function endToEnd(raw: readonly string[], parsed: IncomingHttpHeaders): string[] {
  const named = new Set(String(parsed.connection ?? '').split(',').map((n) => n.trim().toLowerCase()).filter((n) => n !== ''));
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    out.push(name, raw[i + 1]!);
  }
  return out;
}
