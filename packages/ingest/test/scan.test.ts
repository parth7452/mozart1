import { describe, expect, it } from 'vitest';
import {
  NullScanner,
  UnscannedDocumentError,
  assertScannedClean,
  interpretClamdReply,
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
