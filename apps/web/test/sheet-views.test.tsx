import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { unzipSync, strFromU8 } from 'fflate';
import { CSV_MIME, parseWorkbook } from '@recouple/ingest';
import type { ResultCell, ServingRefusal, StoredDocument } from '@recouple/pipeline';
import { SheetExtract } from '../components/sheet-extract';
import { buildSheetExtract } from '../lib/sheet-extract';
import { sheetHtml } from '../lib/sheet-html';
import { caseRowCsv, zipEnclosures } from '../lib/enclosures-zip';

/**
 * A spreadsheet on a case (ADR 0056): its case row drawn from its cells, the
 * whole sheet as an escaped table behind the scan gate, the original only as
 * a download, and a packet that carries the row as CSV no spreadsheet program
 * will run.
 */

const DOC = 'dddddddd-1111-4111-8111-111111111111';
const CSV_TEXT = [
  'Reference,Invoice,Amount,Note',
  'CB-1,INV-1,-100.00,<script>alert(1)</script>',
  'CB-2,INV-2,-250.00,=HYPERLINK("x")',
].join('\n');
const wb = parseWorkbook(new TextEncoder().encode(CSV_TEXT), CSV_MIME);

function cell(id: string, row: number, column: number, ref: string): ResultCell {
  return {
    extractionResultId: id,
    sheetName: wb.sheets[0]!.name,
    rowNumber: row,
    columnNumber: column,
    cellRef: ref,
    cellType: 'csv_field',
    numberFormat: null,
    wasFormula: false,
  };
}

describe('the case row of a spreadsheet', () => {
  it('picks the case’s row by its amount and gives each field its verdict', () => {
    const view = buildSheetExtract({
      documentId: DOC,
      wb,
      amountValue: '$250.00',
      fields: [
        { fieldPath: 'lines[0].deduction_amount', sourceQuote: '-100.00', quoteVerified: true, value: '$100.00', extractionResultId: '1' },
        { fieldPath: 'lines[0].deduction_amount', sourceQuote: '-250.00', quoteVerified: false, value: '$250.00', extractionResultId: '2' },
        { fieldPath: 'lines[0].deduction_reference', sourceQuote: 'CB-2', quoteVerified: true, extractionResultId: '3' },
        { fieldPath: 'invoice_number', sourceQuote: 'INV-9', quoteVerified: true, extractionResultId: '4' },
      ],
      cells: [cell('1', 2, 3, 'C2'), cell('2', 3, 3, 'C3'), cell('3', 3, 1, 'A3'), cell('4', 3, 2, 'B3')],
      headerRow: 1,
    });
    expect(view?.rowNumber).toBe(3);
    expect(view?.header).toEqual(['Reference', 'Invoice', 'Amount', 'Note']);
    expect(view?.fields.map((f) => [f.ref, f.verdict])).toEqual([
      ['C3', 'amount_not_in_cell'],
      ['A3', 'match'],
      ['B3', 'not_at_address'],
    ]);
  });

  it('renders the grid escaped, each value’s address and badge, and the mapping line', () => {
    const html = renderToStaticMarkup(
      <SheetExtract
        view={{
          documentId: DOC,
          sheetName: 'Sheet1',
          header: ['Reference', 'Note'],
          rowNumber: 17,
          row: ['CB-1', '<script>alert(1)</script>'],
          fields: [{ fieldPath: 'deduction_reference', ref: 'A17', column: 1, verdict: 'match' }],
          mapping: { version: 2, confirmedBy: 'reviewer', confirmedOn: '2026-09-27' },
        }}
      />,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Sheet1!A17');
    expect(html).toContain('cell matches');
    expect(html).toContain('class="field-cell"');
    expect(html).toContain('Read by mapping v2, confirmed by reviewer on 2026-09-27');
    expect(html).toContain(`/api/document/${DOC}/sheet?row=17`);
    expect(html).not.toContain('<embed');
  });
});

describe('the whole sheet as a table', () => {
  it('escapes every cell, highlights the asked row and marks hidden rows', () => {
    const hidden = { ...wb, sheets: [{ ...wb.sheets[0]!, hiddenRows: [2] }] };
    const html = sheetHtml(hidden, 'a<b>.csv', 3);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a&lt;b&gt;.csv');
    expect(html).toContain('<tr class="highlight"><th>3</th>');
    expect(html).toContain('<tr class="hidden"><th>2 (hidden row)</th>');
  });
});

describe('the packet', () => {
  it('neutralises a formula in the case row’s CSV', () => {
    expect(caseRowCsv(['A', 'B'], ['=HYPERLINK("x")', 'plain'])).toBe(
      '"A","B"\r\n"\'=HYPERLINK(""x"")","plain"\r\n',
    );
  });

  it('encloses the original and its case row side by side', async () => {
    const bytes = new TextEncoder().encode(CSV_TEXT);
    const stream = zipEnclosures(
      [DOC],
      async () => ({ filename: 'list.csv', bytes, extract: caseRowCsv(['A'], ['-1']) }),
      async () => undefined,
    );
    const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
    const files = unzipSync(zipped);
    expect(Object.keys(files).sort()).toEqual(['01-list.csv', '01-list.csv.case-row.csv']);
    expect(strFromU8(files['01-list.csv.case-row.csv']!)).toBe('"A"\r\n"\'-1"\r\n');
  });
});

// --- the routes -------------------------------------------------------------

const served = vi.hoisted(() => ({
  answer: undefined as { document?: unknown; refusal?: ServingRefusal } | undefined,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: '22222222-2222-4222-8222-222222222222',
    email: 'reviewer@example.test',
    org: { orgId: '11111111-1111-4111-8111-111111111111', slug: 'n', name: 'N', role: 'analyst' },
    orgs: [],
  }),
  storeFor: () => ({
    async servableDocument() {
      return served.answer;
    },
    async close() {},
  }),
}));

const { GET: getDocument } = await import('../app/api/document/[id]/route');
const { GET: getSheet } = await import('../app/api/document/[id]/sheet/route');

function storedCsv(): StoredDocument {
  const bytes = new TextEncoder().encode(CSV_TEXT);
  return {
    documentId: DOC,
    orgId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    filename: 'list.csv',
    mimeType: CSV_MIME,
    byteSize: bytes.byteLength,
    bytes,
    requiresSplit: false,
  };
}

const ctx = { params: Promise.resolve({ id: DOC }) };

describe('serving a spreadsheet', () => {
  beforeEach(() => {
    served.answer = { document: storedCsv() };
  });

  it('downloads the original, never inline', async () => {
    const response = await getDocument(new Request(`https://app.example.test/api/document/${DOC}`), ctx);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('shows the sheet as a sandboxed table with the asked row highlighted', async () => {
    const response = await getSheet(new Request(`https://app.example.test/api/document/${DOC}/sheet?row=2`), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    const html = await response.text();
    expect(html).toContain('<tr class="highlight"><th>2</th>');
    expect(html).not.toContain('<script>alert');
  });

  it('refuses a document that did not scan clean, and 404s one this tenant cannot see', async () => {
    served.answer = { refusal: 'infected' };
    expect((await getSheet(new Request('https://app.example.test/x'), ctx)).status).toBe(409);
    served.answer = undefined;
    expect((await getSheet(new Request('https://app.example.test/x'), ctx)).status).toBe(404);
  });
});
