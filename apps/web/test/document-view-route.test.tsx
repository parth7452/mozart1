import { describe, expect, it, vi } from 'vitest';
import type { ScanVerdict } from '@recouple/ingest';
import type { StoredDocument } from '@recouple/pipeline';
import { realTiff } from '../../../packages/ingest/test/tiff-builders';

/**
 * `/api/document/[id]/view`: a TIFF shown as its rendition (ADR 0054 §4).
 *
 * The same tenant read as `/api/document/[id]` — another tenant's document is
 * a 404 — the same sandbox and nosniff, and one more rule: nothing is decoded
 * unless the latest scan verdict is `clean`. No exception for a document with
 * no verdict, whatever its source.
 */

const ORG = '11111111-1111-1111-1111-111111111111';
const CLEAN_TIFF = '77777777-7777-7777-7777-777777777777';
const INFECTED_TIFF = '88888888-8888-8888-8888-888888888888';
const UNSCANNED_TIFF = '99999999-9999-9999-9999-999999999999';
const ERROR_TIFF = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BROKEN_TIFF = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PDF = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ELSEWHERE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const tiff = await realTiff([{ width: 64, height: 40, colour: 'white' }]);
// A page chain with no pixels behind it: passes the door, will not decode.
const broken = new Uint8Array([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00,
  0x00, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00,
  0x01, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

function stored(documentId: string, mimeType: string, filename: string, bytes: Uint8Array): StoredDocument {
  return {
    documentId,
    orgId: ORG,
    sha256: 'a'.repeat(64),
    filename,
    mimeType,
    byteSize: bytes.byteLength,
    bytes,
    requiresSplit: false,
  };
}

const documents = new Map<string, StoredDocument>([
  [CLEAN_TIFF, stored(CLEAN_TIFF, 'image/tiff', 'FAX 0926.tif', tiff)],
  [INFECTED_TIFF, stored(INFECTED_TIFF, 'image/tiff', 'bad.tif', tiff)],
  [UNSCANNED_TIFF, stored(UNSCANNED_TIFF, 'image/tiff', 'new.tif', tiff)],
  [ERROR_TIFF, stored(ERROR_TIFF, 'image/tiff', 'outage.tif', tiff)],
  [BROKEN_TIFF, stored(BROKEN_TIFF, 'image/tiff', 'broken.tif', broken)],
  [PDF, stored(PDF, 'application/pdf', 'notice.pdf', new TextEncoder().encode('%PDF-1.4'))],
]);

const verdicts = new Map<string, ScanVerdict>([
  [CLEAN_TIFF, { status: 'clean', scanner: 'clamav' }],
  [INFECTED_TIFF, { status: 'infected', scanner: 'clamav', detail: 'Eicar-Signature' }],
  [ERROR_TIFF, { status: 'error', scanner: 'clamav' }],
  [BROKEN_TIFF, { status: 'clean', scanner: 'clamav' }],
  [PDF, { status: 'clean', scanner: 'clamav' }],
]);

const fetched: string[] = [];

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: '22222222-2222-2222-2222-222222222222',
    email: 'reviewer@example.test',
    org: { orgId: ORG, slug: 'n', name: 'N', role: 'analyst' },
    orgs: [],
  }),
  storeFor: () => ({
    async documentIsVisible(id: string) {
      return documents.has(id);
    },
    async latestScan(id: string) {
      return verdicts.get(id);
    },
    async getDocument(id: string) {
      fetched.push(id);
      return documents.get(id);
    },
    async close() {
      return undefined;
    },
  }),
}));

const { GET } = await import('../app/api/document/[id]/view/route');

function get(id: string) {
  return GET(new Request(`https://app.example.test/api/document/${id}/view`), {
    params: Promise.resolve({ id }),
  });
}

describe('the rendition route', () => {
  it('shows a clean TIFF as a PNG in place, sandboxed and never sniffed', async () => {
    const response = await get(CLEAN_TIFF);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="FAX 0926.png"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
    // A PNG, read off its own header: the signature, then IHDR's width and height.
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([64, 40]);
  });

  it('decodes nothing without a clean verdict, and never fetches the bytes', async () => {
    fetched.length = 0;
    for (const [id, sentence] of [
      [INFECTED_TIFF, /found this document infected/],
      [UNSCANNED_TIFF, /no clean scan verdict/],
      [ERROR_TIFF, /no clean scan verdict/],
    ] as const) {
      const response = await get(id);
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const text = await response.text();
      expect(text).toMatch(sentence);
      // Nothing the scanner said, and no filename.
      expect(text).not.toContain('Eicar');
      expect(text).not.toContain('.tif');
    }
    expect(fetched).toEqual([]);
  });

  it('answers a document this tenant cannot see with a 404, not a word about its scan', async () => {
    expect((await get(ELSEWHERE)).status).toBe(404);
    expect((await get('not-an-id')).status).toBe(404);
  });

  it('has nothing to show for a type the original route already shows', async () => {
    expect((await get(PDF)).status).toBe(404);
  });

  it('says a TIFF that will not decode cannot be drawn, and points at the original', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await get(BROKEN_TIFF);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/original still downloads/);
    // Ids and a class name in the log, never the filename.
    expect(error.mock.calls.flat().join(' ')).toContain(BROKEN_TIFF);
    expect(error.mock.calls.flat().join(' ')).not.toContain('broken.tif');
    error.mockRestore();
  });
});
