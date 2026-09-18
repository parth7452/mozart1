/**
 * Typed extraction schemas, one per document type (plan §7).
 *
 * Fields are required-but-nullable rather than optional so the structured-output
 * schema stays closed: the model must say "not present" explicitly instead of
 * dropping a key we would then have to guess about.
 */

import { z } from 'zod';
import { Field, MoneyText, OptionalField } from './field';
import type { DocType } from './ports';

const Qty = () => z.number().int();

export const DeductionNoticeSchema = z.object({
  retailer_name: Field(z.string(), 'The retailer or distributor that took the deduction.'),
  vendor_number: OptionalField(z.string(), 'The supplier’s vendor number with this retailer.'),
  claim_id: Field(z.string(), 'The retailer’s claim, case or dispute number for this deduction.'),
  invoice_number: OptionalField(z.string(), 'The supplier invoice this deduction was taken against.'),
  po_number: OptionalField(z.string(), 'The purchase order number.'),
  store_or_dc: OptionalField(z.string(), 'The store number or distribution centre.'),
  gln: OptionalField(z.string(), 'Global Location Number, if printed.'),
  asn_number: OptionalField(z.string(), 'Advance Ship Notice / 856 number.'),
  lines: z
    .array(
      z.object({
        sku_upc: OptionalField(
          z.string(),
          'The item identifier: SKU, UPC, GTIN or item number. Many deductions are taken against a whole invoice rather than an item (an allowance, a compliance charge, a discount); those have no item identifier.',
        ),
        description: OptionalField(z.string(), 'The item description as printed.'),
        qty_invoiced: OptionalField(Qty(), 'Quantity the supplier invoiced.'),
        qty_received: OptionalField(Qty(), 'Quantity the retailer says it received.'),
        unit_cost: OptionalField(MoneyText(), 'Unit cost as printed.'),
        deduction_amount: Field(MoneyText(), 'The amount deducted on this line, as printed.'),
        reason_code: Field(z.string(), 'The retailer’s own reason code, exactly as printed.'),
        reason_description: OptionalField(z.string(), 'The retailer’s description of the reason.'),
      }),
    )
    .describe('One entry per deducted line. If the notice has a single total with no line detail, return one entry.'),
  deduction_total: Field(MoneyText(), 'The total amount deducted, as printed.'),
  deduction_date: Field(z.string(), 'The date of the deduction, as printed (do not reformat).'),
  dispute_deadline: OptionalField(z.string(), 'Any stated deadline for disputing, as printed.'),
  remittance_or_check: OptionalField(z.string(), 'The remittance, check or payment reference.'),
});

export const RemittanceAdviceSchema = z.object({
  payer_name: Field(z.string(), 'Who sent the payment.'),
  payment_reference: Field(z.string(), 'Check or ACH reference number.'),
  payment_date: Field(z.string(), 'Payment date as printed.'),
  payment_total: Field(MoneyText(), 'Total amount paid, as printed.'),
  lines: z.array(
    z.object({
      invoice_number: Field(z.string(), 'The invoice this line pays or adjusts.'),
      gross_amount: OptionalField(MoneyText(), 'Invoice gross amount as printed.'),
      deduction_amount: OptionalField(MoneyText(), 'Amount short-paid on this invoice, as printed.'),
      net_amount: OptionalField(MoneyText(), 'Net paid on this invoice, as printed.'),
      reason_code: OptionalField(z.string(), 'Short-pay reason code exactly as printed.'),
    }),
  ),
});

export const InvoiceSchema = z.object({
  invoice_number: Field(z.string(), 'The invoice number.'),
  invoice_date: Field(z.string(), 'Invoice date as printed.'),
  po_number: OptionalField(z.string(), 'The purchase order this invoice bills against.'),
  customer_name: Field(z.string(), 'Who was invoiced.'),
  invoice_total: Field(MoneyText(), 'Invoice total as printed.'),
  lines: z.array(
    z.object({
      sku_upc: Field(z.string(), 'Item identifier.'),
      qty: Field(Qty(), 'Quantity invoiced.'),
      unit_cost: Field(MoneyText(), 'Unit price as printed.'),
      extended_amount: OptionalField(MoneyText(), 'Line total as printed.'),
    }),
  ),
});

export const PurchaseOrderSchema = z.object({
  po_number: Field(z.string(), 'The purchase order number.'),
  po_date: Field(z.string(), 'PO date as printed.'),
  buyer_name: Field(z.string(), 'The retailer or buying entity.'),
  ship_to: OptionalField(z.string(), 'Ship-to location, store or DC.'),
  lines: z.array(
    z.object({
      sku_upc: Field(z.string(), 'Item identifier.'),
      qty_ordered: Field(Qty(), 'Quantity ordered.'),
      unit_cost: Field(MoneyText(), 'Agreed unit cost as printed.'),
    }),
  ),
});

/** Bill of lading and proof of delivery share a shape; the signature differs. */
export const ShipmentDocumentSchema = z.object({
  document_number: Field(z.string(), 'The BOL or POD number.'),
  ship_date: OptionalField(z.string(), 'Ship or delivery date as printed.'),
  carrier_name: OptionalField(z.string(), 'The carrier.'),
  po_number: OptionalField(z.string(), 'Referenced purchase order.'),
  ship_from: OptionalField(z.string(), 'Origin.'),
  ship_to: OptionalField(z.string(), 'Destination store or DC.'),
  total_cartons_shipped: OptionalField(Qty(), 'Cartons or cases shipped.'),
  total_cartons_received: OptionalField(Qty(), 'Cartons or cases signed for at delivery.'),
  signed_by: OptionalField(z.string(), 'Name or mark of whoever signed for the delivery.'),
  signature_present: Field(
    z.boolean(),
    'Did the consignee sign for this delivery? True if the document carries a completed signature — a handwritten signature, a stamp, a conformed signature such as "/s/ Name", or an explicit statement that a signature was captured. False if the signature line is blank, or the document says no signature was captured (a carrier-generated report usually says so). This decides whether the document can be used as evidence, so judge what the document records, not how it was typeset.',
  ),
  lines: z.array(
    z.object({
      sku_upc: Field(z.string(), 'Item identifier.'),
      qty_shipped: OptionalField(Qty(), 'Quantity shipped for this item.'),
      qty_received: OptionalField(Qty(), 'Quantity received for this item, if noted.'),
    }),
  ),
});

export const AsnSchema = z.object({
  asn_number: Field(z.string(), 'The ASN / 856 number.'),
  po_number: OptionalField(z.string(), 'Referenced purchase order.'),
  ship_date: OptionalField(z.string(), 'Ship date as printed.'),
  carton_count: OptionalField(Qty(), 'Number of cartons declared.'),
  lines: z.array(
    z.object({
      sku_upc: Field(z.string(), 'Item identifier.'),
      qty_shipped: Field(Qty(), 'Quantity declared shipped.'),
    }),
  ),
});

export const AgreementSchema = z.object({
  agreement_type: Field(z.string(), 'What kind of agreement this is, in the document’s own words.'),
  counterparty: Field(z.string(), 'The retailer or distributor party.'),
  effective_from: OptionalField(z.string(), 'Start date as printed.'),
  effective_to: OptionalField(z.string(), 'End date as printed.'),
  approved_by: OptionalField(z.string(), 'Who approved it (buyer name, signature).'),
  terms: z.array(
    z.object({
      sku_upc: OptionalField(z.string(), 'Item the term applies to, if item-specific.'),
      term_text: Field(z.string(), 'The term as written.'),
      amount: OptionalField(MoneyText(), 'Any amount, rate or allowance as printed.'),
    }),
  ),
});

/**
 * Documents we accept but do not yet have a typed schema for. Captured as facts
 * so the case still shows what was uploaded, rather than dropping the file.
 */
export const GenericDocumentSchema = z.object({
  document_kind: Field(z.string(), 'What this document appears to be, in a few words.'),
  key_facts: z.array(
    z.object({
      label: Field(z.string(), 'What this fact is.'),
      detail: Field(z.string(), 'The fact, as printed.'),
    }),
  ),
});

export const EXTRACTION_SCHEMAS = {
  deduction_notice: DeductionNoticeSchema,
  remittance_advice: RemittanceAdviceSchema,
  invoice: InvoiceSchema,
  po: PurchaseOrderSchema,
  bol: ShipmentDocumentSchema,
  pod: ShipmentDocumentSchema,
  asn: AsnSchema,
  promo_agreement: AgreementSchema,
  price_agreement: AgreementSchema,
  routing_guide: GenericDocumentSchema,
  other: GenericDocumentSchema,
} as const satisfies Record<DocType, z.ZodType>;

export function schemaFor(docType: DocType): z.ZodType {
  return EXTRACTION_SCHEMAS[docType];
}

export type DeductionNotice = z.infer<typeof DeductionNoticeSchema>;
export type RemittanceAdvice = z.infer<typeof RemittanceAdviceSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
export type ShipmentDocument = z.infer<typeof ShipmentDocumentSchema>;
