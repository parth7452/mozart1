import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { flattenExtraction } from '@recouple/extraction';
import { expectedExtraction, fixtureDocument } from '@recouple/fixtures';
import type { CaseWorkflow, StoredDocument } from '@recouple/pipeline';
import type { CaseSummary, PostgresStore, StoredField } from '@recouple/store-postgres';

/**
 * The review page for a case whose one line names no item.
 *
 * `views.test.tsx` renders `CaseReview` with a reconciliation handed to it;
 * this renders the *page*, which computes one from what the store returns. That
 * is the half a component test cannot see, and it is the half that failed in
 * production on 2026-09-21: case eef4fec8-940c-4f80-8313-4a754661d700, a
 * staffing short-payment notice whose single line has no SKU, answered every
 * request with
 *
 *     TypeError: Cannot read properties of undefined (reading 'value')
 *
 * while the case list rendered it perfectly well. The document the store handed
 * back had no `sku_upc` key at all, because a field with a null value gets no
 * `extraction_results` row and the rebuild created a key per row.
 *
 * The store's rebuild is fixed (`restoreDocument`), and the page is asserted
 * here against the *old*, thinner shape on purpose: whatever a store hands
 * back, looking at a case must never be a 500.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const DOCUMENT_ID = '44444444-4444-4444-4444-444444444444';

const notice = fixtureDocument('oakridge-premium-notice');

/**
 * The document as `PostgresStore.latestExtraction` rebuilt it before this fix:
 * one key per stored row, and no key at all for a field whose value was null.
 * Reproduced here rather than imported, because nothing produces it any more.
 */
function rebuiltFromRowsAlone(document: unknown): unknown {
  const out: Record<string, unknown> = {};
  for (const field of flattenExtraction(document)) {
    const segments = field.fieldPath.split('.');
    let node: Record<string, unknown> = out;
    segments.forEach((segment, index) => {
      const match = /^([^[]+)\[(\d+)\]$/.exec(segment);
      const last = index === segments.length - 1;
      if (match?.[1] !== undefined && match[2] !== undefined) {
        const array = (node[match[1]] as unknown[] | undefined) ?? [];
        node[match[1]] = array;
        const row = (array[Number(match[2])] as Record<string, unknown> | undefined) ?? {};
        array[Number(match[2])] = row;
        node = row;
        return;
      }
      if (last) {
        node[segment] = { value: field.value };
        return;
      }
      const existing = (node[segment] as Record<string, unknown> | undefined) ?? {};
      node[segment] = existing;
      node = existing;
    });
  }
  return out;
}

const summary: CaseSummary = {
  deductionId: CASE_ID,
  state: 'classified',
  claimId: 'SP-4417',
  deductionAmountCents: 127_500,
  disputeDeadline: '2026-10-14',
  retailerNameAsPrinted: 'Oakridge Manufacturing Co.',
  documentCount: 1,
  createdAt: '2026-09-21T09:00:00.000Z',
} as unknown as CaseSummary;

const fields: readonly StoredField[] = flattenExtraction(expectedExtraction(notice)).map(
  (field) => ({
    documentId: DOCUMENT_ID,
    filename: notice.filename,
    mimeType: 'application/pdf',
    docType: 'deduction_notice' as const,
    fieldPath: field.fieldPath,
    value: field.value,
    confidence: field.confidence,
    sourcePage: field.sourcePage,
    sourceQuote: field.sourceQuote,
    sourceBbox: null,
    quoteVerified: true,
    role: 'notice' as const,
    readForCase: true,
  }),
);

const document: StoredDocument = {
  documentId: DOCUMENT_ID,
  orgId: ORG_ID,
  sha256: 'a'.repeat(64),
  filename: notice.filename,
  mimeType: 'application/pdf',
  byteSize: notice.bytes.length,
  bytes: new Uint8Array(),
  requiresSplit: false,
};

const workflow: CaseWorkflow = { deductionId: CASE_ID, state: 'classified' };

const store = {
  async listCases() {
    return [summary];
  },
  async fieldsForCase() {
    return fields;
  },
  async costForCase() {
    return 21_000;
  },
  async getWorkflow() {
    return workflow;
  },
  async possibleDuplicates() {
    return [];
  },
  async mergesFor() {
    return { absorbed: [], confirmedNotMerged: [] };
  },
  async documentsForCase() {
    return [document];
  },
  async latestExtraction() {
    return {
      docType: 'deduction_notice' as const,
      document: rebuiltFromRowsAlone(expectedExtraction(notice)),
      validated: true,
      issues: [],
    };
  },
  async close() {
    return undefined;
  },
} as unknown as PostgresStore;

/** The store the page is handed; a describe below swaps in its own. */
let current: PostgresStore = store;

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'reviewer@example.test',
    org: { orgId: ORG_ID, slug: 'northfork', name: 'Northfork Staffing', role: 'analyst' },
    orgs: [],
  }),
}));

vi.mock('../lib/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workflow')>()),
  workflowStoreFor: () => current,
}));

const CasePage = (await import('../app/cases/[id]/page')).default;

describe('the review page for a deduction taken against the invoice, not an item', () => {
  it('renders, instead of throwing on a line that names no SKU', async () => {
    const html = renderToStaticMarkup(
      await CasePage({
        params: Promise.resolve({ id: CASE_ID }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(html).toContain('SP-4417');
    expect(html).toContain('PREMIUM-NOAUTH');
    // The amount is on the page, which is what a reviewer came to see.
    expect(html).toContain('$1,275.00');
  });
});

/**
 * The page for a case a remittance line opened, as the LOG-001 demo reaches it
 * (docs/DEMO.md §1–3): the recorded readings of the remittance and the carrier
 * invoice, the remittance on the case as its notice with its read owned by no
 * case (ADR 0028), and `reconcileCase` run by the page over them.
 */
describe('the review page for a case a remittance line opened', () => {
  const REMITTANCE_ID = '55555555-5555-5555-5555-555555555555';
  const INVOICE_ID = '66666666-6666-6666-6666-666666666666';
  const cassetteDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'packages', 'fixtures', 'cassettes',
  );
  const recorded = (key: string) =>
    JSON.parse(readFileSync(path.join(cassetteDir, `${key}.json`), 'utf8')) as {
      docType: 'remittance_advice' | 'invoice';
      document: unknown;
    };
  const remittance = recorded('log-001-short-pay-remittance');
  const invoice = recorded('log-001-carrier-invoice');

  const onCase = [
    { id: REMITTANCE_ID, filename: '01_short_pay_remittance.pdf', reading: remittance, role: 'notice', paid: false },
    { id: INVOICE_ID, filename: '02_carrier_invoice.pdf', reading: invoice, role: 'evidence', paid: true },
  ] as const;

  const remittanceSummary = {
    ...summary,
    claimId: 'ACH-91844:INV-AFS-260814',
    deductionAmountCents: 60_000,
    discoveredVia: 'remittance_line',
    invoiceNumber: 'INV-AFS-260814',
    reasonCodeAsPrinted: 'LATE-DEL',
    retailerNameAsPrinted: 'Brookfield Supply Co.',
    documentCount: 2,
  } as unknown as CaseSummary;

  const remittanceStore = {
    ...(store as unknown as Record<string, unknown>),
    async listCases() {
      return [remittanceSummary];
    },
    async fieldsForCase() {
      return onCase.flatMap((d) =>
        flattenExtraction(d.reading.document).map((f) => ({
          documentId: d.id,
          filename: d.filename,
          mimeType: 'application/pdf',
          docType: d.reading.docType,
          fieldPath: f.fieldPath,
          value: f.value,
          confidence: f.confidence,
          sourcePage: f.sourcePage,
          sourceQuote: f.sourceQuote,
          sourceBbox: null,
          quoteVerified: true,
          role: d.role,
          readForCase: d.paid,
        })),
      );
    },
    async getCase() {
      return {
        deductionId: CASE_ID,
        orgId: ORG_ID,
        state: 'classified',
        claimId: 'ACH-91844:INV-AFS-260814',
        deductionAmountCents: 60_000,
        discoveredVia: 'remittance_line',
      };
    },
    async documentsForCase() {
      return onCase.map((d) => ({ ...document, documentId: d.id, filename: d.filename }));
    },
    async latestExtraction(documentId: string) {
      const found = onCase.find((d) => d.id === documentId);
      return found === undefined
        ? undefined
        : { docType: found.reading.docType, document: found.reading.document, validated: true, issues: [] };
    },
  } as unknown as PostgresStore;

  beforeAll(() => {
    current = remittanceStore;
  });
  afterAll(() => {
    current = store;
  });

  it('shows the remittance, embeds it as the original, and shows its line adding up', async () => {
    const html = renderToStaticMarkup(
      await CasePage({
        params: Promise.resolve({ id: CASE_ID }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(html).not.toContain('No document has been read');
    expect(html).toContain(`src="/api/document/${REMITTANCE_ID}"`);
    expect(html).not.toContain(`src="/api/document/${INVOICE_ID}"`);
    // Its fields, with the quote a reviewer clicks.
    expect(html).toContain('lines 1 · deduction amount');
    expect(html).toContain('Deduction: LATE-DEL');
    // The line reconciled against itself, as DEMO.md §3 says it is.
    expect(html).toContain(
      'INV-AFS-260814: $4,800.00 gross less $4,200.00 paid is $600.00 withheld, and the line ' +
        'says $600.00 was deducted',
    );
    expect(html).toContain('>matches<');
    expect(html).toContain('from 2 documents');
    expect(html).toContain('not in that figure');
  });
});
