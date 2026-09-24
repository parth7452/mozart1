import { describe, expect, it, vi } from 'vitest';
import type { StoredDocument } from '@recouple/pipeline';

/**
 * `/api/document/[id]`: what a browser is let render in place.
 *
 * A ledger extract is the one "page" a deduction found in the ledger has (ADR
 * 0029), and it is JSON. Served as a download it could not be embedded as the
 * case's original document — an embed of a download starts it on opening the
 * case — so JSON is shown in place now, under the same sandbox and nosniff as
 * an email body. Anything outside the list still downloads.
 */

const EXTRACT_ID = '77777777-7777-7777-7777-777777777777';
const ZIP_ID = '88888888-8888-8888-8888-888888888888';

function stored(documentId: string, mimeType: string, filename: string, text: string): StoredDocument {
  const bytes = new TextEncoder().encode(text);
  return {
    documentId,
    orgId: '11111111-1111-1111-1111-111111111111',
    sha256: 'a'.repeat(64),
    filename,
    mimeType,
    byteSize: bytes.byteLength,
    bytes,
    requiresSplit: false,
  };
}

const documents = new Map([
  [
    EXTRACT_ID,
    stored(
      EXTRACT_ID,
      'application/json',
      'ledger-extract-INV-1001.json',
      '{\n  "kind": "ledger_short_pay_extract",\n  "candidate": { "customerName": "<b>Sysco</b>" }\n}',
    ),
  ],
  [ZIP_ID, stored(ZIP_ID, 'application/zip', 'claims.zip', 'PK')],
]);

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: '22222222-2222-2222-2222-222222222222',
    email: 'reviewer@example.test',
    org: { orgId: '11111111-1111-1111-1111-111111111111', slug: 'n', name: 'N', role: 'analyst' },
    orgs: [],
  }),
  storeFor: () => ({
    async getDocument(id: string) {
      return documents.get(id);
    },
    async close() {
      return undefined;
    },
  }),
}));

const { GET } = await import('../app/api/document/[id]/route');

function get(id: string) {
  return GET(new Request(`https://app.example.test/api/document/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('the document route', () => {
  it('shows a ledger extract in place, as JSON, sandboxed and never sniffed', async () => {
    const response = await get(EXTRACT_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-disposition')).toBe(
      'inline; filename="ledger-extract-INV-1001.json"',
    );
    // A third party's strings, markup included, are shown as the characters
    // they are: nothing is executed, and nothing is sniffed into HTML.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain('"customerName": "<b>Sysco</b>"');
  });

  it('still downloads anything it is not willing to show', async () => {
    const response = await get(ZIP_ID);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="claims.zip"');
  });

  it('answers a document it cannot see with a 404', async () => {
    const response = await get('99999999-9999-9999-9999-999999999999');
    expect(response.status).toBe(404);
  });
});
