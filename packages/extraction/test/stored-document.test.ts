import { describe, expect, it } from 'vitest';
import { flattenExtraction } from '../src/flatten';
import { reconcileNotice } from '../src/reconcile';
import { restoreDocument } from '../src/restore';
import { DeductionNoticeSchema, type DeductionNotice } from '../src/schemas';
import { MAX_ROWS_PER_GROUP } from '../src/wire';

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
      deduction_reference: absent(),
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

/**
 * The other half of the bargain, and the one the fix for the missing SKU key
 * left open: a field with a *value* but no usable provenance.
 *
 * `flattenExtraction` drops it — no page or no quote means nothing a reviewer
 * can check, so no row — and the rebuild then has no row to put back. On an
 * optional field that is invisible and harmless. On a *required* one the
 * rebuilt document stops satisfying its schema, and `reconcileCase` used to
 * answer a whole case with no lines and a blocking finding, over one unquoted
 * date on a scan.
 */
describe('a required field stored without provenance', () => {
  const noProvenance = (value: string) => ({
    value,
    confidence: 0.9,
    source_page: 0,
    source_quote: '',
  });

  const noticeMissingDate = {
    ...INVOICE_LEVEL_NOTICE,
    deduction_date: noProvenance('09/14/2026'),
  };

  it('is not written to the store at all', () => {
    const fields = flattenExtraction(noticeMissingDate);
    expect(fields.map((field) => field.fieldPath)).not.toContain('deduction_date');
    // Everything else is still there: one unquoted field costs one field.
    expect(fields.map((field) => field.fieldPath)).toContain('deduction_total');
    expect(fields.map((field) => field.fieldPath)).toContain('lines[0].deduction_amount');
  });

  it('comes back absent, and says the document is no longer typed', () => {
    const restored = restoreDocument('deduction_notice', flattenExtraction(noticeMissingDate));

    expect(restored.validated).toBe(false);
    expect(restored.issues).toEqual([
      { path: 'deduction_date.value', problem: 'Invalid input: expected string, received null' },
    ]);
    // Absent, not missing: the key is there with a null value, so nothing that
    // reads a field object throws on it.
    expect((restored.document as Record<string, unknown>).deduction_date).toEqual({
      value: null,
      confidence: 0,
      source_page: 1,
      source_quote: '',
    });
  });

  it('still leaves a document worth reconciling', () => {
    const restored = restoreDocument('deduction_notice', flattenExtraction(noticeMissingDate));
    const result = reconcileNotice({ notice: restored.document as DeductionNotice });

    expect(result.lines).toHaveLength(1);
    expect(result.claimedTotalCents).toBe(127_500);
    expect(result.lineSumCents).toBe(127_500);
    expect(result.internallyConsistent).toBe(true);
  });

  it('takes the line sum with it when the missing field is the money', () => {
    // The distinction `reconcileCase` grades on. A date we could not read
    // leaves the arithmetic intact; an amount we could not read is the
    // arithmetic.
    const noAmount = {
      ...INVOICE_LEVEL_NOTICE,
      lines: [{ ...INVOICE_LEVEL_NOTICE.lines[0], deduction_amount: noProvenance('$1,275.00') }],
    };
    const restored = restoreDocument('deduction_notice', flattenExtraction(noAmount));

    expect(restored.validated).toBe(false);
    expect(restored.issues.map((issue) => issue.path)).toEqual(['lines.0.deduction_amount.value']);

    const result = reconcileNotice({ notice: restored.document as DeductionNotice });
    expect(result.lines[0]?.claimedCents).toBeNull();
    // The total is still on the page; the sum of the lines is not, so the two
    // can no longer be checked against each other.
    expect(result.claimedTotalCents).toBe(127_500);
    expect(result.lineSumCents).toBeNull();
  });
});

describe('a stored row the wire format cannot carry', () => {
  it('reads an empty string as not present, which is what the reader does', () => {
    // The docstring's claim, stated as a test. A row whose `value_json` is ""
    // is not a field with an empty value — there is no such thing on a page —
    // so it is dropped with an issue and the field comes back absent.
    const rows = [
      ...flattenExtraction(INVOICE_LEVEL_NOTICE).filter((f) => f.fieldPath !== 'vendor_number'),
      {
        fieldPath: 'vendor_number',
        value: '',
        confidence: 0.4,
        sourcePage: 1,
        sourceQuote: 'Vendor Number:',
        sourceBbox: null,
        quoteVerified: null,
      },
    ];

    const restored = restoreDocument('deduction_notice', rows);

    expect(restored.issues).toEqual([
      { path: 'vendor_number', problem: 'empty value: treated as not present' },
    ]);
    // Optional, so the document is still typed — the absence is legitimate.
    expect(restored.validated).toBe(true);
    expect((restored.document as Record<string, unknown>).vendor_number).toEqual({
      value: null,
      confidence: 0,
      source_page: 1,
      source_quote: '',
    });
  });

  it('reports a stored object or array instead of guessing at it', () => {
    // `value_json` is jsonb: nothing we write puts an object there, so a row
    // that has one came from somewhere else and is not something to coerce.
    const rows = [
      ...flattenExtraction(INVOICE_LEVEL_NOTICE).filter((f) => f.fieldPath !== 'claim_id'),
      {
        fieldPath: 'claim_id',
        value: { nested: 'SP-4417' },
        confidence: 1,
        sourcePage: 1,
        sourceQuote: 'Claim Number: SP-4417',
        sourceBbox: null,
        quoteVerified: null,
      },
      {
        fieldPath: 'invoice_number',
        value: ['NS-260914'],
        confidence: 1,
        sourcePage: 1,
        sourceQuote: 'Invoice Number: NS-260914',
        sourceBbox: null,
        quoteVerified: null,
      },
    ];

    const restored = restoreDocument('deduction_notice', rows);

    expect(restored.issues.slice(0, 2)).toEqual([
      { path: 'claim_id', problem: 'stored value of type object cannot be read back as a field' },
      {
        path: 'invoice_number',
        problem: 'stored value of type object cannot be read back as a field',
      },
    ]);
    // `claim_id` is required, so the document is no longer typed — and that is
    // said, rather than an object being written into the field.
    expect(restored.validated).toBe(false);
    expect((restored.document as Record<string, unknown>).claim_id).toEqual({
      value: null,
      confidence: 0,
      source_page: 1,
      source_quote: '',
    });
  });
});

describe('the row cap on a repeating group', () => {
  it('drops a row past the cap with an issue instead of filling up to it', () => {
    // The row number decides how much `reassemble` does, and it arrives from a
    // model reading an untrusted document or from a `field_path` in a database.
    // `lines[900000]` is one field and nine hundred thousand rows of filling.
    const rows = [
      ...flattenExtraction(INVOICE_LEVEL_NOTICE),
      {
        fieldPath: `lines[${MAX_ROWS_PER_GROUP}].deduction_amount`,
        value: '$1.00',
        confidence: 1,
        sourcePage: 1,
        sourceQuote: '$1.00',
        sourceBbox: null,
        quoteVerified: null,
      },
      {
        fieldPath: 'lines[900000].deduction_amount',
        value: '$2.00',
        confidence: 1,
        sourcePage: 1,
        sourceQuote: '$2.00',
        sourceBbox: null,
        quoteVerified: null,
      },
    ];

    const started = Date.now();
    const restored = restoreDocument('deduction_notice', rows);

    expect(restored.issues).toEqual([
      {
        path: `lines[${MAX_ROWS_PER_GROUP}].deduction_amount`,
        problem: `row ${MAX_ROWS_PER_GROUP} is past the ${MAX_ROWS_PER_GROUP}-row cap on lines: dropped`,
      },
      {
        path: 'lines[900000].deduction_amount',
        problem: `row 900000 is past the ${MAX_ROWS_PER_GROUP}-row cap on lines: dropped`,
      },
    ]);
    // The real row survives, and the document is still the document.
    expect((restored.document as DeductionNotice).lines).toHaveLength(1);
    expect(restored.validated).toBe(true);
    // Not a timing assertion so much as a bound: filling to 900,000 rows takes
    // seconds and hundreds of megabytes, and this returns immediately.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps every row up to the cap', () => {
    const rows = [
      ...Array.from({ length: MAX_ROWS_PER_GROUP }, (_, row) => ({
        fieldPath: `lines[${row}].deduction_amount`,
        value: '$1.00',
        confidence: 1,
        sourcePage: 1,
        sourceQuote: '$1.00',
        sourceBbox: null,
        quoteVerified: null,
      })),
      ...Array.from({ length: MAX_ROWS_PER_GROUP }, (_, row) => ({
        fieldPath: `lines[${row}].reason_code`,
        value: 'X',
        confidence: 1,
        sourcePage: 1,
        sourceQuote: 'X',
        sourceBbox: null,
        quoteVerified: null,
      })),
      ...flattenExtraction(INVOICE_LEVEL_NOTICE).filter((f) => !f.fieldPath.startsWith('lines[')),
    ];

    const restored = restoreDocument('deduction_notice', rows);

    expect(restored.issues).toEqual([]);
    expect((restored.document as DeductionNotice).lines).toHaveLength(MAX_ROWS_PER_GROUP);
  });
});
