// A local fixture portal that tries to make the runner write, and signs in the
// way a real one does (ADR 0057 §8, ADR 0062 §5): it checks the password and a
// TOTP code, answers a wrong one with an error, and sends a session that has
// run out back to its sign-in page. It records every request it receives, body
// and all, so a test can prove a refused one never arrived and a credential
// went only where it was bound. Beside it, a UDP sink counts every datagram a
// page (udp.html) gets past the egress proxy, which should be none.
import { createHmac, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** The one account the fixture signs in. Test values, never a real login. */
export const FIXTURE_USERNAME = 'jane.doe@acme.test';
export const FIXTURE_PASSWORD = 'pw-not-real';
/** RFC 6238's own test key, "12345678901234567890", in canonical base32: the account's authenticator setup key. */
export const FIXTURE_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
/** The account id the signed-in pages print, as SAP Business Network prints a test account's ANID. */
export const FIXTURE_ACCOUNT_ID = 'AN0100000001-T';
/** A second account id the deductions page prints, with a space in it, as some portals print a supplier number. */
export const FIXTURE_SUPPLIER_NUMBER = 'SUP 4471';

export type FixtureHit = { method: string; path: string };
/** A request as it arrived: the path with its query, the Host it named, and the body read in full. */
export type FixtureRequest = { method: string; target: string; host: string; body: string };

export type FixturePortal = {
  origin: string;
  /** Every request, method and path, in the order they arrived. */
  hits: FixtureHit[];
  /** Every request, with its query and body, in the order each finished arriving. */
  received: FixtureRequest[];
  close(): Promise<void>;
};

export type FixturePortalOptions = {
  /** Ask for a TOTP code after the password. */
  mfa?: boolean;
  /** The page a right password sends the browser to for its code: `/mfa.html`, whose form posts, by default. */
  mfaPage?: string;
  /** Answer the sign-in POST with a 307 to this URL, which re-sends the body. */
  loginRedirect?: string;
  /**
   * How a wrong password or code is answered: the form again with an error, at
   * the path it was posted to (`render`, the default); a 303 to a page that
   * shows the form and the error (`redirect`), or to the bound path itself,
   * the failure marked in its query (`query`: `/login?error=1`); or the form
   * again with no error at all (`silent`).
   */
  rejectBy?: 'render' | 'redirect' | 'query' | 'silent';
  /** Answer a right password with the signed-in page itself, at the path the form posted to, rather than a redirect. */
  renderAtLogin?: boolean;
  /** Once signed in, send the browser through `/sso?next=…`, a page that forwards it on, before the deductions page. */
  ssoHop?: boolean;
  /** How many protected pages one session may load; the next is sent to sign in, as a portal whose session timed out. Unlimited when absent. */
  sessionPages?: number;
  /** Where a request with no live session is sent: `/login`, a bound sign-in path, by default. */
  signInRedirect?: string;
  /** Send every answer to the sign-in form through a page that forwards the browser this many milliseconds later, as some portals do. */
  interstitialMs?: number;
  /** Where `/hop2`, the second of two redirects from `/hop1`, sends the browser: the deductions page by default. */
  hopTo?: string;
};

/** Pages and files only a signed-in session may fetch. Only the pages count against `sessionPages`. */
const PROTECTED = new Set(['/deductions.html', '/account.html', '/export.pdf', '/export-mine.pdf', '/export-upper.pdf', '/export-encoded.pdf']);

/**
 * Downloads, by path, and the name the portal gives each; all are export.pdf's
 * bytes. The last three name the user, as some portals do: as it was typed, in
 * capitals, and percent-encoded twice, so that the name the browser gives the
 * file, `statement-JANE.DOE%40ACME.TEST.pdf`, keeps one encoding.
 */
const DOWNLOADS: Record<string, string> = {
  '/export.pdf': 'export.pdf',
  '/export-mine.pdf': `statement-${FIXTURE_USERNAME}.pdf`,
  '/export-upper.pdf': `statement-${FIXTURE_USERNAME.toUpperCase()}.pdf`,
  '/export-encoded.pdf': `statement-${encodeURIComponent(encodeURIComponent(FIXTURE_USERNAME.toUpperCase()))}.pdf`,
};

/** The page each rejection shows, by how it is answered. */
const REJECTED = {
  login: { render: 'login-rejected.html', redirect: '/login-rejected.html', query: '/login?error=1', silent: 'login.html' },
  mfa: { render: 'mfa-rejected.html', redirect: '/mfa-rejected.html', query: '/mfa?error=1', silent: 'mfa.html' },
} as const;

export async function startFixturePortal(opts: FixturePortalOptions = {}): Promise<FixturePortal> {
  const hits: FixtureHit[] = [];
  const received: FixtureRequest[] = [];
  /** Session token → protected pages it may still load. */
  const sessions = new Map<string, number>();
  /** Tokens of sign-ins that passed the password and wait for a code. */
  const awaitingCode = new Set<string>();
  const rejectBy = opts.rejectBy ?? 'render';

  const redirect = (res: ServerResponse, status: 302 | 303 | 307, location: string, cookies: string[] = []): void => {
    res.writeHead(status, cookies.length > 0 ? { location, 'set-cookie': cookies } : { location });
    res.end();
  };

  const serve = (res: ServerResponse, name: string, extra: { downloadAs?: string; cookies?: string[] } = {}): void => {
    const file = normalize(join(ROOT, name));
    if (!file.startsWith(ROOT) || file.endsWith('.ts')) { res.writeHead(404); res.end(); return; }
    readFile(file).then((bytes) => {
      const type = file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      const headers: Record<string, string | string[]> = { 'content-type': type };
      if (extra.downloadAs !== undefined) headers['content-disposition'] = `attachment; filename="${extra.downloadAs}"`;
      if (extra.cookies !== undefined) headers['set-cookie'] = extra.cookies;
      res.writeHead(200, headers);
      res.end(bytes);
    }, () => { res.writeHead(404); res.end(); });
  };

  /** Where a redirect after the sign-in form goes: there, or first through the interstitial that forwards to it. */
  const via = (target: string): string =>
    (opts.interstitialMs === undefined ? target : `/processing.html?next=${encodeURIComponent(target)}&after=${opts.interstitialMs}`);

  const reject = (res: ServerResponse, form: keyof typeof REJECTED): void => {
    if (rejectBy === 'redirect' || rejectBy === 'query') redirect(res, 303, form === 'login' ? via(REJECTED[form][rejectBy]) : REJECTED[form][rejectBy]);
    else serve(res, REJECTED[form][rejectBy]);
  };

  const startSession = (): string => {
    const token = randomUUID();
    sessions.set(token, opts.sessionPages ?? Number.POSITIVE_INFINITY);
    return `session=${token}; HttpOnly; Path=/`;
  };

  const handle = (req: IncomingMessage, res: ServerResponse, method: string, url: URL, body: string): void => {
    const path = url.pathname;
    if (method === 'POST' && path === '/login' && opts.loginRedirect) {
      redirect(res, 307, opts.loginRedirect);
      return;
    }
    if (method === 'GET' && path === '/ws.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>ws</title><script>new WebSocket('ws://127.0.0.1:${(server.address() as AddressInfo).port}/leak')</script><p>ws</p>`);
      return;
    }
    // A server that drops the connection without answering.
    if (method === 'GET' && path === '/drop') {
      req.socket.destroy();
      return;
    }
    // Two redirects the browser follows by itself: Playwright routes only the first request of a chain.
    if (method === 'GET' && path === '/hop1') {
      redirect(res, 302, '/hop2');
      return;
    }
    if (method === 'GET' && path === '/hop2') {
      redirect(res, 302, opts.hopTo ?? '/deductions.html');
      return;
    }
    // `/signin` takes a sign-in as `/login` does: a 307 from `/login` re-sends one there.
    if (method === 'POST' && (path === '/login' || path === '/signin')) {
      const form = new URLSearchParams(body);
      if (form.get('username') !== FIXTURE_USERNAME || form.get('password') !== FIXTURE_PASSWORD) { reject(res, 'login'); return; }
      if (opts.mfa) {
        const token = randomUUID();
        awaitingCode.add(token);
        redirect(res, 303, via(opts.mfaPage ?? '/mfa.html'), [`mfa=${token}; HttpOnly; Path=/`]);
      } else if (opts.renderAtLogin) {
        serve(res, 'deductions.html', { cookies: [startSession()] });
      } else {
        redirect(res, 303, via(opts.ssoHop ? `/sso?next=${encodeURIComponent('/deductions.html')}` : '/deductions.html'), [startSession()]);
      }
      return;
    }
    if (method === 'POST' && path === '/mfa') {
      const token = cookie(req, 'mfa');
      if (token === undefined || !awaitingCode.has(token)) { redirect(res, 303, '/login'); return; }
      if (!acceptsCode(new URLSearchParams(body).get('code') ?? '')) { reject(res, 'mfa'); return; }
      awaitingCode.delete(token);
      redirect(res, 303, '/deductions.html', [startSession(), 'mfa=; Max-Age=0; Path=/']);
      return;
    }
    if (method === 'GET' && path === '/logout') {
      const token = cookie(req, 'session');
      if (token !== undefined) sessions.delete(token);
      redirect(res, 302, '/login', ['session=; Max-Age=0; Path=/']);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('written');
      return;
    }
    if (PROTECTED.has(path)) {
      const token = cookie(req, 'session');
      const left = token === undefined ? undefined : sessions.get(token);
      const page = path.endsWith('.html');
      if (left === undefined || (page && left <= 0)) { redirect(res, 302, opts.signInRedirect ?? '/login'); return; }
      if (page) sessions.set(token!, left - 1);
    }
    const downloadAs = DOWNLOADS[path];
    if (downloadAs !== undefined) { serve(res, 'export.pdf', { downloadAs }); return; }
    const failed = url.searchParams.has('error');
    if (path === '/' || path === '/login') { serve(res, failed ? 'login-rejected.html' : 'login.html'); return; }
    if (path === '/mfa') { serve(res, failed ? 'mfa-rejected.html' : 'mfa.html'); return; }
    // `/sso` stands for an identity provider's own page: one that forwards the
    // browser on while it signs in, else the page for a session that ended,
    // which shows no form. Either way a bound path, where a test binds it.
    if (path === '/sso') { serve(res, url.searchParams.has('next') ? 'processing.html' : 'session-ended.html'); return; }
    serve(res, path);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    hits.push({ method, path: url.pathname });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method, target: `${url.pathname}${url.search}`, host: req.headers.host ?? '', body });
      handle(req, res, method, url, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    received,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((e) => (e ? reject(e) : resolve())); }),
  };
}

/** A loopback UDP port that no recipe's allowlist names, counting what reaches it. */
export type UdpSink = {
  port: number;
  /** Datagrams received so far. Throws if the socket failed, so a broken sink never reads as a silent one. */
  datagrams(): number;
  close(): Promise<void>;
};

/** Starts a UDP sink on an ephemeral loopback port. It answers nothing and keeps nothing but the count. */
export async function startUdpSink(): Promise<UdpSink> {
  const socket = createSocket('udp4');
  let received = 0;
  let failed: Error | null = null;
  socket.on('message', () => { received++; });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => { socket.off('error', reject); resolve(); });
  });
  socket.on('error', (e: Error) => { failed = e; });
  return {
    port: socket.address().port,
    datagrams: () => {
      if (failed !== null) throw failed;
      return received;
    },
    close: () => new Promise<void>((resolve) => { socket.close(() => resolve()); }),
  };
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** A code for this step or the one either side of it, as an authenticator server allows for clock drift. */
function acceptsCode(code: string): boolean {
  const now = Date.now();
  return [-1, 0, 1].some((k) => totpAt(FIXTURE_TOTP_SECRET, now + k * 30_000) === code);
}

/**
 * RFC 6238 (SHA-1, 30-second steps, six digits) over RFC 4226, written here
 * apart from src/totp.ts so that the fixture checks the codes a run types
 * rather than agreeing with them.
 */
function totpAt(secretBase32: string, atMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac('sha1', base32Bytes(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function base32Bytes(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
