/**
 * Malware scanning, and the gate that makes it matter.
 *
 * The plan puts a ClamAV scan before any model call. Ordering the calls
 * correctly is not enough — the gate reads the document's recorded verdict and
 * refuses to produce model input without a clean one (ADR 0007).
 *
 * Fail closed: no scanner configured means no verdict, which means no
 * extraction. `NullScanner` therefore reports `error`, never `clean`.
 */

import { connect } from 'node:net';

export type ScanStatus = 'clean' | 'infected' | 'error';

export interface ScanVerdict {
  readonly status: ScanStatus;
  readonly scanner: string;
  readonly detail?: string;
}

export interface MalwareScanner {
  readonly name: string;
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

export class UnscannedDocumentError extends Error {}

/**
 * The gate. Every path that turns bytes into model input goes through this.
 */
export function assertScannedClean(
  verdict: ScanVerdict | undefined,
  documentId: string,
): asserts verdict is ScanVerdict {
  if (verdict === undefined) {
    throw new UnscannedDocumentError(
      `document ${documentId} has no scan verdict: it cannot be read by a model`,
    );
  }
  if (verdict.status !== 'clean') {
    throw new UnscannedDocumentError(
      `document ${documentId} is not clean (${verdict.status} per ${verdict.scanner}${
        verdict.detail !== undefined ? `: ${verdict.detail}` : ''
      })`,
    );
  }
}

/**
 * The scanner used when none is configured. It reports an error rather than a
 * clean bill of health, so an unconfigured environment fails closed instead of
 * silently reading unscanned files.
 */
export class NullScanner implements MalwareScanner {
  readonly name = 'none';
  async scan(): Promise<ScanVerdict> {
    return {
      status: 'error',
      scanner: this.name,
      detail: 'no malware scanner is configured; refusing to declare this file clean',
    };
  }
}

export interface ClamAvConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
  /** clamd's StreamMaxLength; chunks are sent below it. */
  readonly chunkBytes?: number;
}

/**
 * clamd over TCP, using the INSTREAM command: `zINSTREAM\0`, then length-prefixed
 * chunks, then a zero-length chunk. A reply ending in `OK` is clean; `FOUND`
 * names the signature; anything else is an error, which the gate treats as
 * "not clean".
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';

  constructor(private readonly config: ClamAvConfig) {}

  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const chunkBytes = this.config.chunkBytes ?? 64 * 1024;

    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: this.config.host, port: this.config.port });
        const chunks: Buffer[] = [];
        socket.setTimeout(timeoutMs);

        socket.on('connect', () => {
          socket.write(Buffer.from('zINSTREAM\0', 'ascii'));
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            const slice = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(slice.length, 0);
            socket.write(header);
            socket.write(Buffer.from(slice));
          }
          const terminator = Buffer.alloc(4);
          terminator.writeUInt32BE(0, 0);
          socket.write(terminator);
        });
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('ascii').trim()));
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error(`clamd did not answer within ${timeoutMs}ms`));
        });
        socket.on('error', reject);
      });

      return interpretClamdReply(reply, this.name);
    } catch (error) {
      return {
        status: 'error',
        scanner: this.name,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function interpretClamdReply(reply: string, scanner: string): ScanVerdict {
  const text = reply.replace(/\0+$/, '').trim();
  if (text.endsWith('OK')) return { status: 'clean', scanner, detail: text };
  if (text.includes('FOUND')) {
    return {
      status: 'infected',
      scanner,
      detail: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''),
    };
  }
  return { status: 'error', scanner, detail: text === '' ? 'empty reply from clamd' : text };
}

export interface HttpScannerConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

/**
 * A scan service over HTTPS.
 *
 * clamd has no authentication of any kind, so it is never the thing we talk to
 * across a network we do not own. `services/clamav-scan` runs clamd bound to
 * loopback and puts a token-checked HTTP endpoint in front of it; this is the
 * client for that endpoint (ADR 0018).
 *
 * Fail closed, deliberately and in every direction: `clean` is returned only
 * for a 2xx carrying JSON that says exactly `"clean"`. A non-2xx, a body that
 * is not JSON, a status word we do not recognise, a timeout and a DNS failure
 * are all `error`, and the gate treats every one of them as "do not read this".
 */
export class HttpScanner implements MalwareScanner {
  readonly name = 'clamav-http';

  constructor(private readonly config: HttpScannerConfig) {}

  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    const timeoutMs = this.config.timeoutMs ?? 60_000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/octet-stream',
        },
        // A fresh copy: `fetch` wants an ArrayBuffer it owns, and `bytes` may be
        // a view onto a larger buffer.
        body: bytes.slice().buffer as ArrayBuffer,
        signal: abort.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        return {
          status: 'error',
          scanner: this.name,
          detail: `scan service answered ${response.status}: ${summarise(text)}`,
        };
      }
      return interpretScanServiceReply(text, this.name);
    } catch (error) {
      const detail =
        error instanceof Error && error.name === 'AbortError'
          ? `scan service did not answer within ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      return { status: 'error', scanner: this.name, detail };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keeps a failing service's response body out of the logs at full length. */
function summarise(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * Reads the scan service's JSON. Anything that is not an explicit, recognised
 * verdict is an error — including a body that parses but says something else,
 * which is the shape a misrouted request or a helpful proxy takes.
 */
export function interpretScanServiceReply(body: string, scanner: string): ScanVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      status: 'error',
      scanner,
      detail: `scan service did not answer with JSON: ${summarise(body)}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'error', scanner, detail: `unexpected scan reply: ${summarise(body)}` };
  }

  const { status, detail } = parsed as { status?: unknown; detail?: unknown };
  const said = typeof detail === 'string' ? detail : undefined;

  if (status === 'clean') return { status: 'clean', scanner, ...(said !== undefined && { detail: said }) };
  if (status === 'infected') {
    return { status: 'infected', scanner, detail: said ?? 'signature not named' };
  }
  if (status === 'error') {
    return { status: 'error', scanner, detail: said ?? 'scan service reported an error' };
  }
  return { status: 'error', scanner, detail: `unrecognised scan status ${JSON.stringify(status)}` };
}

/**
 * Builds the scanner an environment is configured for, or the fail-closed one.
 *
 * This is the only place the choice is made — `pipelineDepsFor` calls it rather
 * than repeating it, so there is one answer to "what scans in production"
 * (ADR 0018).
 *
 * A half-configured scanner counts as none. A URL with no token would otherwise
 * become an unauthenticated call to a service that is going to reject it, which
 * is a slower way of not scanning.
 */
export function scannerFromEnv(env: NodeJS.ProcessEnv = process.env): MalwareScanner {
  const url = env.CLAMAV_SCAN_URL;
  const token = env.CLAMAV_SCAN_TOKEN;
  if (url !== undefined && url !== '') {
    if (token === undefined || token === '') return new NullScanner();
    return new HttpScanner({ url, token });
  }

  const host = env.CLAMAV_HOST;
  const port = Number(env.CLAMAV_PORT ?? '3310');
  if (host === undefined || host === '' || !Number.isFinite(port)) return new NullScanner();
  return new ClamAvScanner({ host, port });
}
