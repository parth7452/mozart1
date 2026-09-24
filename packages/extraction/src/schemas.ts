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
        qty_invoiced: OptionalField(
          Qty(),
          'Quantity the supplier invoiced, from the column headed with that meaning. Read the column headers and take the value beneath the right one — these tables often put a bare numeric reason code immediately to the left of the quantities, and the first number on the row is frequently not a quantity at all.',
        ),
        qty_received: OptionalField(
          Qty(),
          'Quantity the retailer says it received, from the column headed with that meaning. Check it against the amount: on a shortage line the deduction is usually the gap between the two quantities times the unit cost, so if that does not work out you have probably taken a number from the wrong column.',
        ),
        unit_cost: OptionalField(MoneyText(), 'Unit cost as printed.'),
        deduction_amount: Field(MoneyText(), 'The amount deducted on this line, as printed.'),
        reason_code: Field(
          z.string(),
          'The payer’s own code for why it deducted this line, exactly as printed. A reason code names a kind of reason and recurs across deductions (“31”, “CMP”, “MIS-SHIP”). Where the line also prints a number for the deduction itself — a chargeback, debit memo or deduction number, unique to this deduction — that number is the deduction_reference, not the reason code. If the line prints no code, give the reason as briefly as it is printed, never the deduction’s own number.',
        ),
        deduction_reference: OptionalField(
          z.string(),
          'The payer’s own number for this deducted line when it prints one beside the reason: a chargeback, debit memo or deduction number, exactly as printed. Not the reason code, and not the claim or notice number already captured as claim_id.',
        ),
        reason_description: OptionalField(z.string(), 'The payer’s description of the reason.'),
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
  appointment_at: OptionalField(
    z.string(),
    'The confirmed delivery or pickup appointment date and time, as printed, including any time zone shown (do not reformat).',
  ),
  gate_check_in_at: OptionalField(
    z.string(),
    'When the carrier checked in at the gate, as printed, including any time zone shown. This is the timestamp late-delivery terms are usually measured against — not unloading or departure (do not reformat).',
  ),
  appointment_reference: OptionalField(
    z.string(),
    'The appointment number and any revision, exactly as printed (for example "AP-771 revision 2").',
  ),
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
  counterparty: Field(
    z.string(),
    'The other side of this agreement: the party who buys, pays or deducts, as the document names them — a retailer, a distributor, a shipper, a customer. Not the party who is owed, which is whose side we are on. On a freight rate confirmation between a shipper and a carrier, it is the shipper.',
  ),
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
 * A message that commits the sender to something.
 *
 * An approved reschedule, a written exception, a waiver — these decide disputes
 * far more often than the notice does, because they are where the customer said
 * something in writing that contradicts what they later charged for. Read as
 * commitments rather than prose so deterministic code can act on them.
 */
export const CorrespondenceSchema = z.object({
  message_reference: Field(z.string(), 'Message ID, export or thread reference as printed.'),
  sent_at: Field(z.string(), 'When it was sent, as printed, with any time zone (do not reformat).'),
  sender: Field(z.string(), 'Who sent it, as printed — name and address if both are shown.'),
  sender_organisation: OptionalField(z.string(), 'The organisation the sender belongs to.'),
  recipient: OptionalField(z.string(), 'Who it was sent to, as printed.'),
  subject: OptionalField(z.string(), 'The subject line as printed.'),
  references: z
    .array(
      z.object({
        label: Field(z.string(), 'What this identifier refers to, in the document’s own words.'),
        value: Field(z.string(), 'The identifier exactly as printed.'),
      }),
    )
    .describe('Loads, purchase orders, invoices, appointments or agreements the message names.'),
  commitments: z
    .array(
      z.object({
        commitment_text: Field(
          z.string(),
          'The sentence that commits to something, quoted exactly as printed.',
        ),
        effective_at: OptionalField(
          z.string(),
          'Any date and time this commitment sets, as printed, with any time zone.',
        ),
        supersedes: OptionalField(
          z.string(),
          'What this replaces, named the way the document names it. When the message gives an identifier — a revision, appointment or document number — that identifier is the answer, not a description of what changed: for "replaces revision 1" report "revision 1", never "the original August 12 appointment". Copy the words the document uses, however partial. A page reading "AP-771 revision 2 replaces revision 1" names the new one in full and the old one only as "revision 1" — report "revision 1". A partial reference is the fact on the page: give it rather than completing it, and rather than leaving this empty.',
        ),
        establishes: OptionalField(
          z.string(),
          'What it puts in place, named the way the document names it. When the message gives an identifier, that identifier is the answer, not the effect it has: in "AP-771 revision 2 replaces revision 1" report "AP-771 revision 2", never the new delivery date it results in.',
        ),
        waives_charge: Field(
          z.boolean(),
          'Does the message state that a charge, fee or penalty will not apply? True only when the document says so; do not infer it from a reschedule alone.',
        ),
        attributed_to: OptionalField(
          z.string(),
          'Who the document says caused or requested this, as printed (for example "customer-requested").',
        ),
      }),
    )
    .describe('One entry per thing the message commits to. Empty if it commits to nothing.'),
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
  correspondence: CorrespondenceSchema,
  promo_agreement: AgreementSchema,
  price_agreement: AgreementSchema,
  routing_guide: GenericDocumentSchema,
  other: GenericDocumentSchema,
} as const satisfies Record<DocType, z.ZodType>;

export function schemaFor(docType: DocType): z.ZodType {
  return EXTRACTION_SCHEMAS[docType];
}

export type Correspondence = z.infer<typeof CorrespondenceSchema>;
export type DeductionNotice = z.infer<typeof DeductionNoticeSchema>;
export type RemittanceAdvice = z.infer<typeof RemittanceAdviceSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
export type ShipmentDocument = z.infer<typeof ShipmentDocumentSchema>;
