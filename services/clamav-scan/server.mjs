/**
 * A token-checked HTTP front door for clamd.
 *
 * clamd has no authentication, so it is bound to loopback inside this container
 * and never routable. This process is the only thing that talks to it, and the
 * only thing exposed (ADR 0018).
 *
 * It answers exactly one question — is this file clean — and answers it in JSON:
 *
 *   POST /scan   Authorization: Bearer <token>   body: the raw bytes
 *   -> 200 {"status":"clean"|"infected"|"error","scanner":"clamav","detail":"…"}
 *
 * Deliberately dependency-free: the client is the thing that must not drift, and
 * a service with no `node_modules` is a service with no supply chain.
 */

import { createServer } from 'node:http';
import { connect } from 'node:net';

const PORT = Number(process.env.PORT ?? 8080);
const CLAMD_HOST = process.env.CLAMD_HOST ?? '127.0.0.1';
const CLAMD_PORT = Number(process.env.CLAMD_PORT ?? 3310);
const TOKEN = process.env.SCAN_TOKEN ?? '';
/** The same ceiling the upload route enforces. A limit only the caller applies is not one. */
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 25 * 1024 * 1024);

if (TOKEN === '') {
  // Refuse to start rather than come up unauthenticated. An open clamd relay is
  // worse than no scanner, because the app would believe it had one.
  console.error('SCAN_TOKEN is not set; refusing to start an unauthenticated scan service');
  process.exit(1);
}

/** Constant-time compare, so a wrong token cannot be found a byte at a time. */
function tokenMatches(presented) {
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  let differences = 0;
  for (let i = 0; i < a.length; i += 1) differences |= a[i] ^ b[i];
  return differences === 0;
}

/**
 * Reads the body, or gives up at the ceiling.
 *
 * Over the limit it stops *buffering* but keeps draining, and leaves the socket
 * alone. Destroying the request here would tear down the connection before the
 * 413 reached the caller, who would then see a transport failure instead of an
 * answer — the socket is closed after the response has flushed, not before.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let oversize = false;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        oversize = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () =>
      resolve(oversize ? { oversize: true, total } : { oversize: false, bytes: Buffer.concat(chunks) }),
    );
    request.on('error', reject);
  });
}

/** clamd INSTREAM: `zINSTREAM\0`, length-prefixed chunks, then a zero-length chunk. */
function instream(bytes, timeoutMs = 120_000) {
  const CHUNK = 64 * 1024;
  return new Promise((resolve, reject) => {
    const socket = connect({ host: CLAMD_HOST, port: CLAMD_PORT });
    const chunks = [];
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.write(Buffer.from('zINSTREAM\0', 'ascii'));
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.length, 0);
        socket.write(header);
        socket.write(slice);
      }
      const terminator = Buffer.alloc(4);
      terminator.writeUInt32BE(0, 0);
      socket.write(terminator);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('ascii').trim()));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`clamd did not answer within ${timeoutMs}ms`));
    });
    socket.on('error', reject);
  });
}

/**
 * The same three answers `interpretClamdReply` reads on the client side. Kept in
 * step by the contract test, not by a shared import — this service has no
 * dependencies on purpose (ADR 0018).
 */
function interpretClamdReply(reply) {
  const text = reply.replace(/\0+$/, '').trim();
  if (text.endsWith('OK')) return { status: 'clean', scanner: 'clamav', detail: text };
  if (text.includes('FOUND')) {
    return {
      status: 'infected',
      scanner: 'clamav',
      detail: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''),
    };
  }
  return { status: 'error', scanner: 'clamav', detail: text === '' ? 'empty reply from clamd' : text };
}

function send(response, code, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** 413, then close — after the answer is on the wire, never before. */
function refuseTooLarge(request, response, detail) {
  response.setHeader('connection', 'close');
  response.on('finish', () => request.destroy());
  send(response, 413, { status: 'error', scanner: 'clamav', detail });
}

const server = createServer(async (request, response) => {
  // Liveness, before auth: the platform's health check has no token, and this
  // says only whether clamd is answering.
  if (request.method === 'GET' && request.url === '/health') {
    try {
      const socket = connect({ host: CLAMD_HOST, port: CLAMD_PORT });
      const pong = await new Promise((resolve, reject) => {
        socket.setTimeout(5_000);
        socket.on('connect', () => socket.write(Buffer.from('zPING\0', 'ascii')));
        socket.on('data', (chunk) => {
          resolve(chunk.toString('ascii').trim().replace(/\0+$/, ''));
          socket.end();
        });
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('clamd did not answer PING'));
        });
        socket.on('error', reject);
      });
      return send(response, pong === 'PONG' ? 200 : 503, { clamd: pong });
    } catch (error) {
      return send(response, 503, { clamd: 'unreachable', detail: String(error.message ?? error) });
    }
  }

  if (request.method !== 'POST' || request.url !== '/scan') {
    return send(response, 404, { status: 'error', scanner: 'clamav', detail: 'POST /scan' });
  }

  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!tokenMatches(presented)) {
    return send(response, 401, { status: 'error', scanner: 'clamav', detail: 'bad token' });
  }

  // The client's own claim, checked before a byte is read. A chunked request
  // sends no content-length at all, which is what the streaming guard is for.
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return refuseTooLarge(request, response, `body is larger than ${MAX_BYTES} bytes`);
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return send(response, 400, {
      status: 'error',
      scanner: 'clamav',
      detail: String(error.message ?? error),
    });
  }

  if (body.oversize) {
    return refuseTooLarge(request, response, `body is larger than ${MAX_BYTES} bytes`);
  }

  const bytes = body.bytes;
  if (bytes.length === 0) {
    return send(response, 400, { status: 'error', scanner: 'clamav', detail: 'empty body' });
  }

  try {
    const reply = await instream(bytes);
    // 200 with a verdict inside. An infected file is a successful scan — the
    // caller's gate decides what to do about it, and an HTTP error code here
    // would be indistinguishable from the service being broken.
    return send(response, 200, interpretClamdReply(reply));
  } catch (error) {
    return send(response, 200, {
      status: 'error',
      scanner: 'clamav',
      detail: String(error.message ?? error),
    });
  }
});

server.headersTimeout = 30_000;
server.requestTimeout = 180_000;
server.listen(PORT, () => console.log(`scan service listening on ${PORT}`));
