// A local fixture portal that tries to make the runner write. It records
// every request it receives, so a test can prove a refused one never arrived.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const ROOT = dirname(fileURLToPath(import.meta.url));

export type FixturePortal = { origin: string; hits: Array<{ method: string; path: string }>; close(): Promise<void> };

export async function startFixturePortal(opts: { mfa?: boolean; loginRedirect?: string } = {}): Promise<FixturePortal> {
  const hits: Array<{ method: string; path: string }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const method = req.method ?? 'GET';
    hits.push({ method, path });
    req.resume();
    req.on('end', () => {
      if (method === 'POST' && path === '/login' && opts.loginRedirect) {
        res.writeHead(307, { location: opts.loginRedirect });
        res.end();
        return;
      }
      if (method === 'GET' && path === '/ws.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>ws</title><script>new WebSocket('ws://127.0.0.1:${(server.address() as AddressInfo).port}/leak')</script><p>ws</p>`);
        return;
      }
      if (method === 'POST' && path === '/login') {
        res.writeHead(303, { location: opts.mfa ? '/mfa.html' : '/deductions.html', 'set-cookie': 'session=1; HttpOnly; Path=/' });
        res.end();
        return;
      }
      if (method === 'POST' && path === '/mfa') {
        res.writeHead(303, { location: '/deductions.html' });
        res.end();
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('written');
        return;
      }
      const file = normalize(join(ROOT, path === '/' ? 'login.html' : path));
      if (!file.startsWith(ROOT) || file.endsWith('.ts')) { res.writeHead(404); res.end(); return; }
      readFile(file).then((bytes) => {
        const type = file.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
        const headers: Record<string, string> = { 'content-type': type };
        if (file.endsWith('.pdf')) headers['content-disposition'] = 'attachment; filename="export.pdf"';
        res.writeHead(200, headers);
        res.end(bytes);
      }, () => { res.writeHead(404); res.end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((e) => (e ? reject(e) : resolve())); }),
  };
}
