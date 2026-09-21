import { describe, expect, it } from 'vitest';
import { flattenExtraction } from '../src/flatten';
import { reconcileNotice } from '../src/reconcile';
import { restoreDocument } from '../src/restore';
import { DeductionNoticeSchema, type DeductionNotice } from '../src/schemas';

/**
 * A deduction taken against an invoice, not an item.
 *
 * An allowance, a compliance charge, a discount, an unauthorised service
 * premium: the line names no SKU because there is no SKU to name. It is still a
 * line, it still carries an amount and a reason, and it still has to add up.
 *
 * This is the shape that took the review page down in production on 2026-09-21
 * (case eef4fec8-940c-4f80-8313-4a754661d700): read once without trouble, and
 * then thrown on the *second* read, the one that comes back out of the store.
 */
const INVOICE_LEVEL_NOTICE = {
  retailer_name: f('Oakridge Manufacturing Co.', 'OAKRIDGE MANUFACTURING CO.'),
  vendor_number: f('NS-4412', 'Vendor Number: NS-4412'),
  claim_id: f('SP-4417', 'Claim Number: SP-4417'),
  invoice_number: f('NS-260914', 'Invoice Number: NS-260914'),
  po_number: absent(),
  store_or_dc: absent(),
  gln: absent(),
  asn_number: absent(),
  lines: [
    {
      sku_upc: absent(),
      description: f('Weekend shift premium, unauthorised', 'Weekend shift premium, unauthorised'),
      qty_invoiced: absent(),
      qty_received: absent(),
      unit_cost: absent(),
      deduction_amount: f('$1,275.00', '$1,275.00'),
      reason_code: f('PREMIUM-NOAUTH', 'PREMIUM-NOAUTH'),
      reason_description: absent(),
    },
  ],
  deduction_total: f('$1,275.00', 'Total Short Paid: $1,275.00'),
  deduction_date: f('09/14/2026', 'Deduction Date: 09/14/2026'),
  dispute_deadline: f('10/14/2026', 'Dispute Deadline: 10/14/2026'),
  remittance_or_check: absent(),
};

function f<T>(value: T, quote: string) {
  return { value, confidence: 0.98, source_page: 1, source_quote: quote };
}

function absent() {
  return { value: null, confidence: 0, source_page: 1, source_quote: '' };
}

/**
 * The document as a store that keeps only the rows it was given would hand it
 * back: `flattenExtraction` writes no row for a field whose value is null, so a
 * rebuild that creates a key per row produces an object with no `sku_upc` key
 * at all — not a `sku_upc` whose value is null.
 *
 * Reconciliation must survive being handed that. It is not the shape the store
 * is supposed to produce any more (`restoreDocument` fills absent fields back
 * in), but a reader that reaches straight through a field object is one schema
 * change away from a 500 on a page a person is trying to read.
 */
function keysOnlyForRowsThatExist(document: unknown): unknown {
  if (Array.isArray(document)) return document.map(keysOnlyForRowsThatExist);
  if (document === null || typeof document !== 'object') return document;
  const entries = Object.entries(document as Record<string, unknown>);
  const isField = entries.some(([key]) => key === 'source_quote');
  if (isField) return document;
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).value === null
    ) {
      continue;
    }
    out[key] = keysOnlyForRowsThatExist(value);
  }
  return out;
}

describe('a notice line with no SKU', () => {
  it('is written to the store as a line with no sku row at all', () => {
    const fields = flattenExtraction(INVOICE_LEVEL_NOTICE);
    expect(fields.map((field) => field.fieldPath)).not.toContain('lines[0].sku_upc');
    expect(fields.map((field) => field.fieldPath)).toContain('lines[0].deduction_amount');
  });

  it('comes back out of the store as the document that went in', () => {
    // The round trip a case page makes on every view: the reader's document is
    // flattened to field rows, the rows are all the store keeps, and the
    // document is rebuilt from them. What comes back has to be what went in —
    // the absent SKU stated as absent, not dropped — and it has to satisfy the
    // schema rather than be cast to it.
    const restored = restoreDocument('deduction_notice', flattenExtraction(INVOICE_LEVEL_NOTICE));

    expect(restored.issues).toEqual([]);
    expect(restored.validated).toBe(true);
    expect(restored.document).toEqual(INVOICE_LEVEL_NOTICE);

    const parsed = DeductionNoticeSchema.safeParse(restored.document);
    expect(parsed.success).toBe(true);

    const result = reconcileNotice({ notice: restored.document as DeductionNotice });
    expect(result.lines[0]?.sku).toBe('line 1');
    expect(result.lines[0]?.reasonCode).toBe('PREMIUM-NOAUTH');
    expect(result.claimedTotalCents).toBe(127_500);
    expect(result.lineSumCents).toBe(127_500);
    expect(result.internallyConsistent).toBe(true);
  });

  it('refuses a stored path that is not a field of this document type', () => {
    // The rebuild walks paths that came out of a database as object keys, and
    // the guard against one that climbs the prototype chain is that it is not a
    // field of any document type: `reassemble` drops it with an issue instead
    // of writing it. Stated as a test, because the explicit segment blocklist
    // the store used to carry went with the rebuild it belonged to.
    const rows = [
      ...flattenExtraction(INVOICE_LEVEL_NOTICE),
      {
        fieldPath: '__proto__.polluted',
        value: 'yes',
        confidence: 1,
        sourcePage: 1,
        sourceQuote: 'nowhere',
        sourceBbox: null,
        quoteVerified: null,
      },
    ];

    const restored = restoreDocument('deduction_notice', rows);

    expect(restored.issues).toEqual([
      { path: '__proto__.polluted', problem: 'not a field in this document type' },
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(restored.document).toEqual(INVOICE_LEVEL_NOTICE);
  });

  it('is still reconciled when the document comes back with the key missing', () => {
    const thin = keysOnlyForRowsThatExist(INVOICE_LEVEL_NOTICE) as DeductionNotice;
    expect((thin.lines[0] as Record<string, unknown>).sku_upc).toBeUndefined();

    const result = reconcileNotice({ notice: thin });

    // The line is named by its position, because the document gives no other
    // name for it — and it is *there*, rather than the page being a 500.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.sku).toBe('line 1');
    expect(result.lines[0]?.claimedCents).toBe(127_500);
    expect(result.claimedTotalCents).toBe(127_500);
    expect(result.findings.filter((finding) => finding.severity === 'blocking')).toEqual([]);
  });
});
