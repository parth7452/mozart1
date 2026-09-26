import { beforeEach, describe, expect, it, vi } from 'vitest';
import { servingRefusal, type StoredDocument, type UploadSource } from '@recouple/pipeline';

/** A latest verdict's status, as `servingRefusal` takes it. */
type ScanStatus = NonNullable<Parameters<typeof servingRefusal>[0]['scan']>;

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
const NOTICE_ID = '55555555-5555-5555-5555-555555555555';
const INFECTED_ID = '66666666-6666-6666-6666-666666666666';
const UNSCANNED_ID = '44444444-4444-4444-4444-444444444444';
const SCAN_ERROR_ID = '33333333-3333-3333-3333-333333333333';
const EMAILED_UNSCANNED_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ANOTHER_TENANTS_ID = '99999999-9999-9999-9999-999999999999';

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

/**
 * What the tenant can see: the document, its latest scan verdict and the door
 * it came through — the two things `servingRefusal` decides on. Another
 * tenant's document is not in the map at all, as RLS leaves it.
 */
const documents = new Map<
  string,
  { document: StoredDocument; scan: ScanStatus | null; source: UploadSource | null }
>([
  [
    EXTRACT_ID,
    {
      document: stored(
        EXTRACT_ID,
        'application/json',
        'ledger-extract-INV-1001.json',
        '{\n  "kind": "ledger_short_pay_extract",\n  "candidate": { "customerName": "<b>Sysco</b>" }\n}',
      ),
      // Our own code wrote it, and nothing scans it (ADR 0029).
      scan: null,
      source: 'erp_sync',
    },
  ],
  [ZIP_ID, { document: stored(ZIP_ID, 'application/zip', 'claims.zip', 'PK'), scan: 'clean', source: 'web_upload' }],
  [
    NOTICE_ID,
    { document: stored(NOTICE_ID, 'application/pdf', 'notice.pdf', '%PDF-1.7'), scan: 'clean', source: 'web_upload' },
  ],
  [
    INFECTED_ID,
    {
      document: stored(INFECTED_ID, 'application/pdf', 'invoice-EICAR.pdf', 'X5O!P%@AP'),
      scan: 'infected',
      source: 'email_in',
    },
  ],
  [
    UNSCANNED_ID,
    {
      document: stored(UNSCANNED_ID, 'application/pdf', 'never-scanned.pdf', '%PDF-1.7'),
      scan: null,
      source: 'web_upload',
    },
  ],
  [
    SCAN_ERROR_ID,
    {
      document: stored(SCAN_ERROR_ID, 'application/pdf', 'scanner-down.pdf', '%PDF-1.7'),
      scan: 'error',
      source: 'web_upload',
    },
  ],
  [
    EMAILED_UNSCANNED_ID,
    {
      document: stored(EMAILED_UNSCANNED_ID, 'text/plain', 'body.txt', 'Deduction notice'),
      scan: null,
      source: 'email_body',
    },
  ],
]);

/** Every id whose bytes were fetched, so a refusal can be shown to fetch none. */
const fetched: string[] = [];

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: '22222222-2222-2222-2222-222222222222',
    email: 'reviewer@example.test',
    org: { orgId: '11111111-1111-1111-1111-111111111111', slug: 'n', name: 'N', role: 'analyst' },
    orgs: [],
  }),
  storeFor: () => ({
    async documentServing(id: string) {
      const found = documents.get(id);
      if (found === undefined) return undefined;
      return { refusal: servingRefusal({ scan: found.scan, source: found.source }) };
    },
    async getDocument(id: string) {
      fetched.push(id);
      return documents.get(id)?.document;
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
    const response = await get(ANOTHER_TENANTS_ID);
    expect(response.status).toBe(404);
  });
});

/**
 * Only a document that scanned clean is served (`servingRefusal`). The scan
 * gate fails closed for reading; this is the other way bytes leave the store,
 * and a download is not something a sandbox header governs.
 */
describe('the document route and the scan verdict', () => {
  beforeEach(() => {
    fetched.length = 0;
  });

  it('serves a document that scanned clean', async () => {
    const response = await get(NOTICE_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('%PDF-1.7');
    expect(fetched).toEqual([NOTICE_ID]);
  });

  it('refuses an infected document with a 409, never fetching its bytes or naming it', async () => {
    const response = await get(INFECTED_ID);
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toContain('infected');
    expect(body).not.toContain('EICAR');
    expect(body).not.toContain('X5O');
    expect(fetched).toEqual([]);
  });

  it('refuses a document with no verdict, or only a scanner error, from any door a stranger can use', async () => {
    for (const id of [UNSCANNED_ID, SCAN_ERROR_ID, EMAILED_UNSCANNED_ID]) {
      const response = await get(id);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('no clean scan verdict');
    }
    expect(fetched).toEqual([]);
  });

  it('serves a ledger extract nothing scanned, because our own code wrote it', async () => {
    const response = await get(EXTRACT_ID);
    expect(response.status).toBe(200);
    expect(fetched).toEqual([EXTRACT_ID]);
  });

  it('keeps the 404 for another tenant’s document, ahead of any verdict', async () => {
    const response = await get(ANOTHER_TENANTS_ID);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not found');
    expect(fetched).toEqual([]);
  });
});
