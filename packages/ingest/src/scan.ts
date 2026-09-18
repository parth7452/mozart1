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

/** Builds the scanner an environment is configured for, or the fail-closed one. */
export function scannerFromEnv(env: NodeJS.ProcessEnv = process.env): MalwareScanner {
  const host = env.CLAMAV_HOST;
  const port = Number(env.CLAMAV_PORT ?? '3310');
  if (host === undefined || host === '' || !Number.isFinite(port)) return new NullScanner();
  return new ClamAvScanner({ host, port });
}
