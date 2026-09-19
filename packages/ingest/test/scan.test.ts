import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HttpScanner,
  NullScanner,
  UnscannedDocumentError,
  assertScannedClean,
  interpretClamdReply,
  interpretScanServiceReply,
  scannerFromEnv,
  type ScanVerdict,
} from '../src/scan';

describe('the scan gate', () => {
  it('refuses a document with no verdict at all', () => {
    expect(() => assertScannedClean(undefined, 'doc-1')).toThrow(UnscannedDocumentError);
    expect(() => assertScannedClean(undefined, 'doc-1')).toThrow(/no scan verdict/);
  });

  it('refuses an infected document, naming the signature', () => {
    const verdict: ScanVerdict = {
      status: 'infected',
      scanner: 'clamav',
      detail: 'Eicar-Test-Signature',
    };
    expect(() => assertScannedClean(verdict, 'doc-1')).toThrow(/Eicar-Test-Signature/);
  });

  it('refuses a document whose scan errored — an error is not a pass', () => {
    expect(() =>
      assertScannedClean({ status: 'error', scanner: 'clamav', detail: 'timeout' }, 'doc-1'),
    ).toThrow(UnscannedDocumentError);
  });

  it('lets a clean document through', () => {
    expect(() => assertScannedClean({ status: 'clean', scanner: 'clamav' }, 'doc-1')).not.toThrow();
  });
});

describe('fail-closed default', () => {
  it('reports an error rather than declaring an unscanned file clean', async () => {
    const verdict = await new NullScanner().scan();
    expect(verdict.status).toBe('error');
    expect(verdict.status).not.toBe('clean');
    expect(() => assertScannedClean(verdict, 'doc-1')).toThrow();
  });

  it('is what an unconfigured environment gets', () => {
    expect(scannerFromEnv({}).name).toBe('none');
    expect(scannerFromEnv({ CLAMAV_HOST: 'clamd', CLAMAV_PORT: '3310' }).name).toBe('clamav');
  });

  it('prefers the hosted scanner, and treats a half-configured one as none', () => {
    // Deployed: the app reaches a scan service over HTTPS, never raw clamd
    // across a network it does not own (ADR 0018).
    expect(
      scannerFromEnv({ CLAMAV_SCAN_URL: 'https://scan.example/scan', CLAMAV_SCAN_TOKEN: 't' }).name,
    ).toBe('clamav-http');

    // A URL and no token is not "scan without authenticating" — it is a
    // scanner that is not configured, and the gate should say so.
    expect(scannerFromEnv({ CLAMAV_SCAN_URL: 'https://scan.example/scan' }).name).toBe('none');
    expect(
      scannerFromEnv({ CLAMAV_SCAN_URL: 'https://scan.example/scan', CLAMAV_SCAN_TOKEN: '' }).name,
    ).toBe('none');

    // And the hosted one wins when both are set, rather than silently picking
    // the one without TLS.
    expect(
      scannerFromEnv({
        CLAMAV_SCAN_URL: 'https://scan.example/scan',
        CLAMAV_SCAN_TOKEN: 't',
        CLAMAV_HOST: 'clamd',
      }).name,
    ).toBe('clamav-http');
  });
});

describe('reading clamd', () => {
  it('understands the three answers it gives', () => {
    expect(interpretClamdReply('stream: OK\0', 'clamav').status).toBe('clean');

    const infected = interpretClamdReply('stream: Eicar-Test-Signature FOUND\0', 'clamav');
    expect(infected.status).toBe('infected');
    expect(infected.detail).toBe('Eicar-Test-Signature');

    expect(interpretClamdReply('INSTREAM size limit exceeded ERROR', 'clamav').status).toBe('error');
    expect(interpretClamdReply('', 'clamav').status).toBe('error');
  });
});

describe('reading the scan service', () => {
  it('understands the three answers it gives', () => {
    expect(interpretScanServiceReply('{"status":"clean","detail":"stream: OK"}', 's').status).toBe(
      'clean',
    );

    const infected = interpretScanServiceReply(
      '{"status":"infected","detail":"Eicar-Test-Signature"}',
      's',
    );
    expect(infected.status).toBe('infected');
    expect(infected.detail).toBe('Eicar-Test-Signature');

    expect(interpretScanServiceReply('{"status":"error","detail":"clamd is down"}', 's').status).toBe(
      'error',
    );
  });

  it('refuses to read anything else as a pass', () => {
    // Every one of these is a shape a broken deploy, a misrouted request or a
    // captive proxy actually produces. None of them may come back clean.
    for (const body of [
      '',
      'OK',
      '<html>502 Bad Gateway</html>',
      'null',
      '[]',
      '{}',
      '{"status":"CLEAN"}',
      '{"status":true}',
      '{"status":"clean-ish"}',
      '{"result":"clean"}',
    ]) {
      expect(interpretScanServiceReply(body, 's').status, body).toBe('error');
    }
  });
});

describe('the hosted scanner', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bytes with a bearer token and reads the verdict back', async () => {
    const fetchMock = vi.fn(async () => new Response('{"status":"clean"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const verdict = await new HttpScanner({ url: 'https://scan.example/scan', token: 'secret' }).scan(
      bytes,
    );

    expect(verdict.status).toBe('clean');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://scan.example/scan');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  it('sends the bytes of a view, not of the buffer behind it', async () => {
    // `Uint8Array` from a pooled Buffer is a window onto something larger.
    // Scanning the whole pool would scan another request's file.
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = pool.subarray(2, 5);
    const fetchMock = vi.fn(async () => new Response('{"status":"clean"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new HttpScanner({ url: 'https://scan.example/scan', token: 't' }).scan(view);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reports an error rather than a pass when the service refuses or breaks', async () => {
    for (const response of [
      new Response('bad token', { status: 401 }),
      new Response('', { status: 500 }),
      new Response('<html>504</html>', { status: 504 }),
      new Response('{"status":"clean"}', { status: 302 }),
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => response.clone()));
      const verdict = await new HttpScanner({ url: 'https://s/scan', token: 't' }).scan(bytes);
      expect(verdict.status).toBe('error');
      expect(() => assertScannedClean(verdict, 'doc-1')).toThrow(UnscannedDocumentError);
    }
  });

  it('reports an error when the service cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const verdict = await new HttpScanner({ url: 'https://s/scan', token: 't' }).scan(bytes);
    expect(verdict.status).toBe('error');
    expect(verdict.detail).toMatch(/fetch failed/);
  });

  it('reports an error when the service does not answer in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      ),
    );
    const verdict = await new HttpScanner({
      url: 'https://s/scan',
      token: 't',
      timeoutMs: 10,
    }).scan(bytes);
    expect(verdict.status).toBe('error');
    expect(verdict.detail).toMatch(/within 10ms/);
  });
});
