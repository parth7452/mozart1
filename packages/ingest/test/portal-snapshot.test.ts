import { describe, expect, it } from 'vitest';
import { MAX_EMAIL_BODY_BYTES, PORTAL_SNAPSHOT_MIME, RejectedUploadError, acceptPortalSnapshot, acceptUpload } from '../src/sniff';

const enc = (s: string) => new TextEncoder().encode(s);
const page = '<!doctype html>\n<html><body><h1>Deductions</h1><table><tr><td>DN-1</td><td>$1.00</td></tr></table></body></html>\n';

function code(f: () => unknown): string | undefined {
  try { f(); return undefined; } catch (e) { return e instanceof RejectedUploadError ? e.code : 'other'; }
}

describe('acceptPortalSnapshot', () => {
  it('accepts a serialised page as text/html, hashed over its bytes', () => {
    const a = acceptPortalSnapshot(enc(page));
    expect(a.mimeType).toBe(PORTAL_SNAPSHOT_MIME);
    expect(a.byteSize).toBe(enc(page).length);
    expect(acceptPortalSnapshot(enc(page)).sha256).toBe(a.sha256);
  });
  it('refuses a script or a form in any case', () => {
    expect(code(() => acceptPortalSnapshot(enc(`${page}<SCRIPT>x()</SCRIPT>`)))).toBe('content_does_not_match_type');
    expect(code(() => acceptPortalSnapshot(enc(`${page}< form action="/x">`)))).toBe('content_does_not_match_type');
  });
  it('refuses empty, oversized and non-UTF-8 bytes', () => {
    expect(code(() => acceptPortalSnapshot(new Uint8Array()))).toBe('empty_file');
    expect(code(() => acceptPortalSnapshot(new Uint8Array(MAX_EMAIL_BODY_BYTES + 1).fill(0x61)))).toBe('too_large');
    expect(code(() => acceptPortalSnapshot(new Uint8Array([0x3c, 0xff, 0xfe])))).toBe('content_does_not_match_type');
  });
  it('leaves HTML refused at the upload door', () => {
    expect(code(() => acceptUpload(enc(page), 'page.html', { declaredMimeType: 'text/html' }))).toBe('type_not_allowed');
    expect(code(() => acceptUpload(enc(page), 'page.csv'))).toBe('type_not_allowed');
  });
});
