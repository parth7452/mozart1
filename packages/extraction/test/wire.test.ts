import { describe, expect, it } from 'vitest';
import { describeFields, renderFieldList, rowIndexOf, templatePath } from '../src/paths';
import { reassemble, type WireField } from '../src/wire';
import { DeductionNoticeSchema, ShipmentDocumentSchema } from '../src/schemas';

const descriptors = describeFields(DeductionNoticeSchema);
const byPath = new Map(descriptors.map((d) => [d.path, d] as const));

const wire = (path: string, value: string, page = 1): WireField => ({
  path,
  value,
  confidence: 0.95,
  source_page: page,
  source_quote: `quote for ${path}`,
});

describe('describing a schema to the model', () => {
  it('finds flat fields and repeating groups, with their types', () => {
    expect(byPath.get('claim_id')).toMatchObject({ valueType: 'string', required: true });
    expect(byPath.get('vendor_number')).toMatchObject({ required: false });
    expect(byPath.get('lines[].sku_upc')).toMatchObject({ repeating: true, group: 'lines' });
    expect(byPath.get('lines[].qty_invoiced')?.valueType).toBe('integer');
    expect(byPath.get('lines[].deduction_amount')?.required).toBe(true);
  });

  it('carries each field’s description through to the model', () => {
    expect(byPath.get('claim_id')?.description).toMatch(/claim, case or dispute number/);
  });

  it('reads booleans out of a shipment schema', () => {
    const shipment = new Map(describeFields(ShipmentDocumentSchema).map((d) => [d.path, d]));
    expect(shipment.get('signature_present')?.valueType).toBe('boolean');
  });

  it('renders a field list that explains the repeating group', () => {
    const rendered = renderFieldList(descriptors);
    expect(rendered).toContain('- claim_id (string):');
    expect(rendered).toContain('(string, optional)');
    expect(rendered).toMatch(/Repeating group "lines"/);
    expect(rendered).toContain('lines[N].sku_upc');
  });

  it('maps a concrete path back to its template', () => {
    expect(templatePath('lines[12].sku_upc')).toBe('lines[].sku_upc');
    expect(templatePath('claim_id')).toBe('claim_id');
    expect(rowIndexOf('lines[12].sku_upc')).toBe(12);
    expect(rowIndexOf('claim_id')).toBeUndefined();
  });
});

const minimalNotice = (): WireField[] => [
  wire('retailer_name', 'Walmart'),
  wire('claim_id', 'APDP-99812'),
  wire('deduction_total', '$3,120.00'),
  wire('deduction_date', '08/14/2026'),
  wire('lines[0].sku_upc', '000-4471-08'),
  wire('lines[0].deduction_amount', '$3,120.00'),
  wire('lines[0].reason_code', '24'),
];

describe('reassembling a document from flat records', () => {
  it('rebuilds the typed object and validates it', () => {
    const result = reassemble(minimalNotice(), descriptors, DeductionNoticeSchema);
    expect(result.validated).toBe(true);
    expect(result.issues).toEqual([]);
    const document = result.document as Record<string, any>;
    expect(document.claim_id.value).toBe('APDP-99812');
    expect(document.claim_id.source_page).toBe(1);
    expect(document.lines).toHaveLength(1);
    expect(document.lines[0].reason_code.value).toBe('24');
  });

  it('states absence explicitly for fields the model left out', () => {
    const document = reassemble(minimalNotice(), descriptors, DeductionNoticeSchema)
      .document as Record<string, any>;
    expect(document.po_number).toEqual({
      value: null,
      confidence: 0,
      source_page: 1,
      source_quote: '',
    });
    expect(document.lines[0].qty_invoiced.value).toBeNull();
  });

  it('keeps money as printed, for our own parser to read', () => {
    const document = reassemble(minimalNotice(), descriptors, DeductionNoticeSchema)
      .document as Record<string, any>;
    expect(document.deduction_total.value).toBe('$3,120.00');
  });

  it('coerces quantities to integers, commas and all', () => {
    const fields = [...minimalNotice(), wire('lines[0].qty_invoiced', '1,200')];
    const document = reassemble(fields, descriptors, DeductionNoticeSchema).document as Record<
      string,
      any
    >;
    expect(document.lines[0].qty_invoiced.value).toBe(1200);
  });

  it('refuses a quantity that is not a whole number instead of rounding one', () => {
    const fields = [...minimalNotice(), wire('lines[0].qty_invoiced', 'about thirty')];
    const result = reassemble(fields, descriptors, DeductionNoticeSchema);
    expect(result.issues.map((i) => i.problem)).toContain('"about thirty" is not a whole number');
    expect((result.document as Record<string, any>).lines[0].qty_invoiced.value).toBeNull();
    // The rest of the document still came through.
    expect(result.validated).toBe(true);
  });

  it('drops a path that is not in this document type, and says so', () => {
    const fields = [...minimalNotice(), wire('invented_field', 'x'), wire('lines[0].nonsense', 'y')];
    const result = reassemble(fields, descriptors, DeductionNoticeSchema);
    expect(result.issues.map((i) => i.path)).toEqual(['invented_field', 'lines[0].nonsense']);
    expect(result.issues[0]?.problem).toMatch(/not a field in this document type/);
    expect((result.document as Record<string, unknown>).invented_field).toBeUndefined();
    expect(result.validated).toBe(true);
  });

  it('treats an empty value as absence rather than as an empty string', () => {
    const fields = [...minimalNotice(), wire('po_number', '   ')];
    const result = reassemble(fields, descriptors, DeductionNoticeSchema);
    expect(result.issues.map((i) => i.problem)).toContain('empty value: treated as not present');
    expect((result.document as Record<string, any>).po_number.value).toBeNull();
  });

  it('fails validation loudly when a required field never arrived', () => {
    const withoutClaim = minimalNotice().filter((f) => f.path !== 'claim_id');
    const result = reassemble(withoutClaim, descriptors, DeductionNoticeSchema);
    expect(result.validated).toBe(false);
    expect(result.issues.some((i) => i.path.includes('claim_id'))).toBe(true);
  });

  it('builds as many rows as the model numbered, filling gaps in each', () => {
    const fields = [
      ...minimalNotice(),
      wire('lines[1].sku_upc', '999-0000-01'),
      wire('lines[1].deduction_amount', '$100.00'),
      wire('lines[1].reason_code', '22'),
      wire('lines[2].sku_upc', '999-0000-02'),
      wire('lines[2].deduction_amount', '$50.00'),
      wire('lines[2].reason_code', '25'),
    ];
    const result = reassemble(fields, descriptors, DeductionNoticeSchema);
    const document = result.document as Record<string, any>;
    expect(document.lines).toHaveLength(3);
    expect(document.lines[2].sku_upc.value).toBe('999-0000-02');
    expect(document.lines[1].unit_cost.value).toBeNull();
    expect(result.validated).toBe(true);
  });

  it('gives a group with no rows an empty array, not a missing key', () => {
    const noLines = minimalNotice().filter((f) => !f.path.startsWith('lines'));
    const result = reassemble(noLines, descriptors, DeductionNoticeSchema);
    expect((result.document as Record<string, unknown>).lines).toEqual([]);
    expect(result.validated).toBe(true);
  });

  it('reads the ways a document says yes and no', () => {
    const shipmentDescriptors = describeFields(ShipmentDocumentSchema);
    const base = [wire('document_number', 'MFL-1'), wire('lines[0].sku_upc', 'A')];
    for (const [text, expected] of [
      ['true', true],
      ['yes', true],
      ['false', false],
      ['no', false],
    ] as const) {
      const result = reassemble(
        [...base, wire('signature_present', text)],
        shipmentDescriptors,
        ShipmentDocumentSchema,
      );
      expect((result.document as Record<string, any>).signature_present.value).toBe(expected);
    }

    const unreadable = reassemble(
      [...base, wire('signature_present', 'probably')],
      shipmentDescriptors,
      ShipmentDocumentSchema,
    );
    expect(unreadable.validated).toBe(false);
    expect(unreadable.issues.map((i) => i.problem)).toContain('"probably" is not true or false');
  });
});
