/**
 * The scan service and its client, talking to each other for real.
 *
 * `services/clamav-scan` reimplements clamd's reply parsing rather than
 * importing ours, so that it can ship with no dependencies (ADR 0018). This is
 * what keeps the two in step: the actual server process, spawned, with a fake
 * clamd behind it, answering a real `HttpScanner`.
 *
 * clamd itself is faked because it needs a 1 GB signature database and a
 * container. Everything between our code and clamd's socket is real: the token
 * check, the size ceiling, INSTREAM framing, the JSON contract, the health
 * probe.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpScanner, assertScannedClean } from '../src/scan';

const SERVER = fileURLToPath(new URL('../../../services/clamav-scan/server.mjs', import.meta.url));
const TOKEN = 'test-token-not-a-secret';
/** Room for a body that has to be chunked, so the framing is exercised. */
const MAX_BYTES = 300_000;
/** A second instance with a tiny ceiling, so the ceiling is exercised too. */
const SMALL_MAX_BYTES = 4096;

/** The EICAR test string, split so this file is not itself a flagged sample. */
const EICAR = ['X5O!P%@AP[4', String.raw`\PZX54(P^)7CC)7}`, '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/**
 * A clamd that speaks just enough INSTREAM to answer. It reassembles the
 * length-prefixed chunks, which is the part of the framing most likely to be
 * wrong, and reports a signature when it sees the EICAR string.
 */
function fakeClamd(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | undefined;
    const payload: Buffer[] = [];

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (command === undefined) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(0, end).toString('ascii');
        buffer = buffer.subarray(end + 1);

        if (command === 'zPING') {
          socket.write(Buffer.from('PONG\0', 'ascii'));
          socket.end();
          return;
        }
      }

      // Length-prefixed chunks until a zero-length one.
      for (;;) {
        if (buffer.length < 4) return;
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const body = Buffer.concat(payload).toString('latin1');
          const reply = body.includes(EICAR)
            ? 'stream: Eicar-Test-Signature FOUND\0'
            : 'stream: OK\0';
          socket.write(Buffer.from(reply, 'ascii'));
          socket.end();
          return;
        }
        if (buffer.length < 4 + size) return;
        payload.push(Buffer.from(buffer.subarray(4, 4 + size)));
        buffer = buffer.subarray(4 + size);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({ server, port: address.port });
    });
  });
}

async function waitForHealth(port: number, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the scan service never became healthy');
}

let clamd: { server: Server; port: number };
const running: ChildProcess[] = [];
let port: number;
let url: string;
let smallUrl: string;

/**
 * Starts a service on an ephemeral port and learns which one it got from the
 * service's own startup line. Picking a port ourselves means picking one
 * something else on the machine already has, which is a test that fails for
 * reasons that have nothing to do with the code.
 */
async function startService(maxBytes: number): Promise<{ port: number; url: string }> {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: '0',
      CLAMD_HOST: '127.0.0.1',
      CLAMD_PORT: String(clamd.port),
      SCAN_TOKEN: TOKEN,
      MAX_BYTES: String(maxBytes),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  running.push(child);

  const chosen = await new Promise<number>((resolve, reject) => {
    const failed = setTimeout(() => reject(new Error('the scan service never said it was listening')), 15_000);
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      const match = /listening on (\d+)/.exec(seen);
      if (match?.[1] !== undefined) {
        clearTimeout(failed);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(failed);
      reject(new Error(`the scan service exited with ${code} before listening`));
    });
  });

  await waitForHealth(chosen);
  return { port: chosen, url: `http://127.0.0.1:${chosen}/scan` };
}

beforeAll(async () => {
  clamd = await fakeClamd();
  ({ port, url } = await startService(MAX_BYTES));
  ({ url: smallUrl } = await startService(SMALL_MAX_BYTES));
}, 30_000);

afterAll(async () => {
  for (const child of running) child.kill();
  await new Promise<void>((resolve) => clamd.server.close(() => resolve()));
});

describe('the scan service', () => {
  it('passes a clean file, and the gate lets it through', async () => {
    const verdict = await new HttpScanner({ url, token: TOKEN }).scan(
      new TextEncoder().encode('a perfectly ordinary deduction notice'),
    );
    expect(verdict.status).toBe('clean');
    expect(() => assertScannedClean(verdict, 'doc-1')).not.toThrow();
  });

  it('names the signature on an infected file, and the gate refuses it', async () => {
    const verdict = await new HttpScanner({ url, token: TOKEN }).scan(
      new TextEncoder().encode(EICAR),
    );
    expect(verdict.status).toBe('infected');
    expect(verdict.detail).toBe('Eicar-Test-Signature');
    expect(() => assertScannedClean(verdict, 'doc-1')).toThrow(/Eicar-Test-Signature/);
  });

  it('reassembles a file large enough to be chunked, and finds what is inside it', async () => {
    // Above the 64 KB chunk size the client writes, so INSTREAM's length-prefix
    // framing is exercised rather than assumed — and the signature sits past the
    // first chunk, where a framing bug would lose it.
    const big = new TextEncoder().encode('A'.repeat(200_000) + EICAR);
    const verdict = await new HttpScanner({ url, token: TOKEN }).scan(big);
    expect(verdict.status).toBe('infected');
    expect(verdict.detail).toBe('Eicar-Test-Signature');
  });

  it('refuses a caller with no token, a wrong token, or a wrong length of token', async () => {
    for (const token of ['', 'wrong', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const verdict = await new HttpScanner({ url, token }).scan(new Uint8Array([1, 2, 3]));
      expect(verdict.status).toBe('error');
      expect(verdict.detail).toMatch(/401/);
      expect(() => assertScannedClean(verdict, 'doc-1')).toThrow();
    }
  });

  it('refuses a file over the ceiling rather than streaming it into clamd', async () => {
    // And answers, rather than dropping the connection: a caller that sees a
    // transport failure cannot tell "too big" from "the scanner is down", and
    // both have to be distinguishable in a log six weeks later.
    const verdict = await new HttpScanner({ url: smallUrl, token: TOKEN }).scan(
      new Uint8Array(SMALL_MAX_BYTES + 1).fill(65),
    );
    expect(verdict.status).toBe('error');
    expect(verdict.detail).toMatch(/413/);
    expect(verdict.detail).toMatch(/larger than/);
  });

  it('refuses an oversize chunked body, which sends no content-length to check', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let sent = 0; sent <= SMALL_MAX_BYTES; sent += 1024) {
        yield new Uint8Array(1024).fill(65);
      }
    }
    const response = await fetch(smallUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: chunks(),
      // Node's fetch requires this for a streaming body; it is not in the DOM
      // RequestInit type, which is why the whole init goes through `unknown`.
      duplex: 'half',
    } as unknown as RequestInit);
    expect(response.status).toBe(413);
  });

  it('answers /health without a token, and says which clamd it reached', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clamd: 'PONG' });
  });

  it('answers anything else with 404 rather than scanning it', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('refuses to start at all without a token', async () => {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, PORT: '0', SCAN_TOKEN: '' },
        stdio: 'ignore',
      });
      child.on('exit', resolve);
    });
    // An unauthenticated clamd relay is worse than no scanner, because the app
    // would believe it had one.
    expect(code).toBe(1);
  });
});
