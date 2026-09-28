/**
 * A capture as the contract hands it to the job (ADR 0057 §9): its page path
 * cut to the path alone, with no session token and no username in it, and its
 * filename within the contract's rule. The contract's own schema has the last
 * word on each. The worker holds a capture's bytes as they came, and counts
 * exactly those.
 */
import { describe, expect, it } from 'vitest';
import { captureFilename, capturePagePath, captureSummary, checkableCapture, heldCapture } from '../src/capture';
import { RunCaptureSchema, type RunnerCapture } from '../src/portal';

const USER = 'svc.reader@acme.test';
const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('capturePagePath', () => {
  it.each([
    ['/deductions.html', '/deductions.html'],
    ['/', '/'],
    ['/app;jsessionid=0A1B2C3D/list', '/app/list'],
    ['/;jsessionid=0A1B2C3D', '/'],
    ['/a;x=1;y=2/b;z=3', '/a/b'],
    ['/(S(lit3py55t21z5v55vlm25s55))/claims/list.aspx', '/claims/list.aspx'],
    ['/(X(1)S(lit3py55t21z5v55vlm25s55)F(ticket))/claims', '/claims'],
    ['/app/(F(ticket))/deep/(S(s1))/page', '/app/deep/page'],
    ['/users/svc.reader%40acme.test/home', '/users/[portal-user]/home'],
    ['/users/SVC.READER@ACME.TEST', '/users/[portal-user]'],
    ['blank', '/'],
    ['', '/'],
  ])('%s is %s', (pathname, expected) => {
    expect(capturePagePath(pathname, USER)).toBe(expected);
  });

  it('cuts a path longer than the contract allows', () => {
    expect(capturePagePath(`/${'a'.repeat(5000)}`, USER)).toHaveLength(2048);
  });
});

describe('captureFilename', () => {
  it.each([
    ['statement.pdf', 'statement.pdf'],
    ['a\u0000b\u001fc\u007fd.pdf', 'a_b_c_d.pdf'],
    ['  ', 'fallback.bin'],
    ['\u0007', '_'],
  ])('%j is %j', (name, expected) => {
    expect(captureFilename(name, 'fallback.bin')).toBe(expected);
  });

  it('keeps a long name\'s extension, within 255 UTF-16 units', () => {
    const name = captureFilename(`${'n'.repeat(400)}.xlsx`, 'x');
    expect(name).toHaveLength(255);
    expect(name.endsWith('.xlsx')).toBe(true);
  });

  it('never splits a surrogate pair to fit', () => {
    const name = captureFilename(`${'😀'.repeat(200)}.pdf`, 'x');
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name).toBe(`${'😀'.repeat(125)}.pdf`);
    expect([...name.slice(0, -4)].every((c) => c === '😀')).toBe(true);
  });
});

describe('heldCapture', () => {
  it('holds a capture the contract accepts from the runner\'s worst', () => {
    const worst: RunnerCapture = {
      kind: 'download',
      stepName: 'export',
      filename: `\u0001${'r'.repeat(300)}.csv`,
      bytes: new Uint8Array(0),
      mimeType: 'text/csv',
      pagePath: `/(S(abc))/x;jsessionid=1/${'p'.repeat(3000)}`,
      capturedAt: '2026-09-28T10:00:00.000Z',
      snapshotRuleVersion: null,
    };
    const held = heldCapture(RUN_ID, 0, worst, USER);
    expect(RunCaptureSchema.safeParse(checkableCapture(held)).success).toBe(true);
    // An empty file has a hash and no bytes, and is still a capture.
    expect(held.capture.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(held.bytes.byteLength).toBe(0);
    expect(captureSummary(held)).toEqual({ index: 0, kind: 'download', stepName: 'export', sha256: held.capture.sha256, byteLength: 0 });
  });

  it('holds exactly the bytes of a view into a larger buffer, as a copy, so what it holds is what it counts', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const held = heldCapture(RUN_ID, 0, {
      kind: 'page_snapshot',
      stepName: 'landing',
      filename: 'landing.html',
      bytes: backing.subarray(2, 5),
      mimeType: 'text/html',
      pagePath: '/',
      capturedAt: '2026-09-28T10:00:00.000Z',
      snapshotRuleVersion: 1,
    }, USER);
    expect([...held.bytes]).toEqual([1, 2, 3]);
    expect(held.bytes.buffer.byteLength).toBe(3);
    expect(captureSummary(held).byteLength).toBe(3);
  });

  it('holds a whole buffer\'s bytes as they are, without copying them', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const held = heldCapture(RUN_ID, 0, {
      kind: 'download',
      stepName: 'export',
      filename: 'statement.pdf',
      bytes,
      mimeType: 'application/pdf',
      pagePath: '/',
      capturedAt: '2026-09-28T10:00:00.000Z',
      snapshotRuleVersion: null,
    }, USER);
    expect(held.bytes.buffer).toBe(bytes.buffer);
  });
});
