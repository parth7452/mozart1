/**
 * The customer pack: three cases, fifteen documents, two industries.
 *
 * Every other suite here is retail CPG. This one is staffing (STF-201,
 * STF-203) and freight (LOG-202), which is the market `docs/STATE-OF-PLAY.md`
 * says we are actually selling into, and the documents are photographs rather
 * than PDFs: twelve simulated camera JPEGs with perspective, paper shadow, desk
 * texture, uneven light, noise, blur and JPEG compression, plus three native
 * PDFs. It is the first corpus where the *deduction* is not a retail chargeback
 * at all — it is an unapproved overtime premium, a late fee against a
 * rescheduled appointment, and a weekend premium nobody authorised in writing.
 *
 *   STF-201  $600 overtime premium withheld; the customer's own shift
 *            supervisor approved the hours in writing, and the rate agreement
 *            says a shift supervisor may. Dispute the lot.
 *   LOG-202  $800 withheld as two charges. The $500 late fee is wrong — the
 *            appointment was moved to 1:00 PM at the customer's request and the
 *            truck checked in at 12:45. The $300 shortage is right: the signed
 *            receipt records two missing cartons at the agreed $150 each.
 *   STF-203  $450 weekend premium withheld. The purchase order requires written
 *            customer approval for it; attendance is confirmed and the approval
 *            does not exist. Ask for it. What comes back is *undetermined* —
 *            not zero, and the fixture keeps it null so nobody rounds a thing we
 *            do not know down to a thing we do.
 *
 * Scored as its own suite, never blended. The mix here is nothing like the
 * others' — a photograph of a staffing invoice is a different measurement from a
 * clean retail PDF, and averaging them would move the headline whenever the
 * corpus mix changed rather than when anything got better or worse.
 *
 * SYNTHETIC. The pack says so itself and every label file carries
 * `"synthetic": true`; `customer/README.md` keeps its caveats verbatim. No
 * recovery described here has happened, and none of these numbers is evidence
 * about production accuracy. What this suite is for is the two things the retail
 * corpora cannot ask: does a reader survive a simulated phone photograph of a
 * real-shaped page, and does the argument hold up when the deduction is about
 * labour hours rather than cartons.
 *
 * ## Document types
 *
 * Twelve of the fifteen map onto an existing `DOC_TYPES` value honestly. Three
 * do not, and take the generic `other` rather than a new type: a new document
 * type is a new extraction path — schema, guidance, cassettes, a classification
 * target — and that belongs in its own PR, not smuggled in with a corpus.
 *
 * | # | the pack calls it | role | `DOC_TYPES` | why |
 * | --- | --- | --- | --- | --- |
 * | 01 | SHORT-PAY REMITTANCE | remittance | `remittance_advice` | payer, ACH reference, one invoice with gross/deduction/net. `RemittanceAdviceSchema` exactly; LOG-001's own short-pay remittance is typed the same way |
 * | 02 | STAFFING INVOICE | evidence | `invoice` | an invoice, billed in hours instead of cases |
 * | 03 | WEEKLY TIME REGISTER | evidence | `other` | no type fits. A time register is hours by worker, with an approval on it — closest to a POD in function (it is what the charge is proven against) and nothing like one in shape |
 * | 04 | OVERTIME APPROVAL | evidence | `correspondence` | the page is headed "Message record" and prints FROM/TO, a subject and an authorisation. `CorrespondenceSchema` is for exactly this: the message where the customer commits to something |
 * | 05 | STAFFING RATE AGREEMENT | context | `price_agreement` | agreed rates and the period they apply to, which is what `AgreementSchema` captures. LOG-001 types its rate confirmation the same way |
 * | 06 | REMITTANCE ADVICE | remittance | `remittance_advice` | as 01 |
 * | 07 | FREIGHT INVOICE | evidence | `invoice` | linehaul plus fuel, totalled |
 * | 08 | DELIVERY RECEIPT | evidence | `pod` | `ShipmentDocumentSchema` fits it field for field: document number, gate check-in, appointment reference, cartons manifested against cartons received, who signed |
 * | 09 | REVISED DELIVERY APPOINTMENT | evidence | `correspondence` | a written commitment that replaces an earlier one — the LOG-001 shape, and the reason `correspondence` exists at all |
 * | 10 | CARRIER RATE CONFIRMATION | context | `price_agreement` | the rates, the late-fee rule and the agreed per-carton value |
 * | 11 | SHORT PAYMENT NOTICE | notice | `deduction_notice` | it is a chargeback notice: a reason code, an amount withheld, a stated dispute window. It prints a payment reference too, but its own framing is the deduction |
 * | 12 | WORKFORCE INVOICE | evidence | `invoice` | as 02 |
 * | 13 | ATTENDANCE SUMMARY | evidence | `other` | as 03 |
 * | 14 | DISPATCH HANDOFF NOTE | context | `other` | deliberately *not* `correspondence`. That type is for a message between the parties that commits its sender; this is the supplier talking to itself, and STF-203 turns on it not being customer approval. Typing it as correspondence would invite the decision layer to read a vendor's own note as a counterparty commitment, which is the exact error this case exists to catch |
 * | 15 | SERVICE ORDER TERMS | context | `price_agreement` | rates and the rule that a premium needs written approval. `po` was the other candidate and is a worse fit: `PurchaseOrderSchema` requires ordered quantities and item identifiers, and this page has neither |
 *
 * What the generic mapping costs, stated plainly: `GenericDocumentSchema` keeps
 * a document as `document_kind` plus free-form `key_facts`, so the fact that
 * wins STF-201 — "Approved August 28, 2026, 6:14 PM Eastern by Lena Ortiz,
 * Shift Supervisor" — is captured as prose rather than as an approver, a
 * timestamp and a role that deterministic code can check. That is the argument
 * for a typed time-register schema, and it is the next PR's argument, not this
 * one's.
 *
 * ## The text layer
 *
 * The labels are the *expected* text layer, not the input. A camera JPEG has no
 * text layer, so `pageText` is empty for all twelve and OCR supplies one when
 * cassettes are recorded, exactly as the `scanned` suite works — handing a model
 * a perfect transcription of a photograph would measure nothing at all. For the
 * three native PDFs the transcription *is* the document's own text layer, so it
 * is `pageText`, and `test/customer.test.ts` decodes each PDF and proves the two
 * agree rather than taking the label's word for it.
 *
 * ## What is deliberately not asserted
 *
 * Fields a careful reader could answer two ways are left out rather than
 * guessed at, the way `corpus.ts` leaves out its price-variance unit cost:
 *
 *   - 11's `claim_id`. The page prints both `SP-203` (the notice) and `CB-203`
 *     (the chargeback) and the schema has one field for the two of them.
 *   - 06's line-level deduction and reason code. One invoice carries two
 *     deductions there ($500 LATE, $300 SHORT); a reader may return two lines or
 *     one line totalling $800, and both are defensible readings of the page.
 *   - 07's and 10's line detail. Linehaul and fuel surcharge have no quantity or
 *     unit price, and `InvoiceSchema` lines want both.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FixtureCase, FixtureDocument, TruthExpectation } from './cases';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'customer');

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const money = (value: number): TruthExpectation => ({ kind: 'money_cents', value });
const int = (value: number): TruthExpectation => ({ kind: 'int', value });
const bool = (value: boolean): TruthExpectation => ({ kind: 'bool', value });

/** What a document does for its case, which is not the same as its type. */
export type CustomerDocumentRole = 'notice' | 'evidence' | 'remittance' | 'context';

/** The pack's own decisions, in its own vocabulary. */
export type CustomerDecision = 'dispute_full' | 'dispute_partial' | 'request_evidence';

interface ManifestEntry {
  readonly document_id: string;
  readonly case_id: string;
  readonly document_type: string;
  readonly file: string;
  readonly rendering: string;
}

interface CaseTruthEntry {
  readonly id: string;
  readonly vendor: string;
  readonly customer: string;
  readonly inv: string;
  readonly gross: number;
  readonly ded: number;
  readonly recover: number | null;
  readonly decision: string;
  readonly basis: string;
}

export interface CustomerFixtureDocument extends FixtureDocument {
  /** `01_stf-201`, as the pack and the label files name it. */
  readonly documentId: string;
  readonly caseId: string;
  readonly role: CustomerDocumentRole;
  /** The pack's own words for the document type, kept so the mapping is data. */
  readonly packDocumentType: string;
  /** How the page was rendered: a camera simulation, or a native PDF. */
  readonly rendering: string;
  /**
   * The label transcription. For a PDF this is also `pageText`; for a JPEG it is
   * what OCR is expected to recover, and is not given to the model.
   */
  readonly labelText: string;
}

/**
 * Case-level ground truth, in `cases.ts`'s shape.
 *
 * `FixtureCase.retailer` is a CPG-era name for "the other party" — here it is a
 * packaging plant, a paper wholesaler and an assembly shop, none of them
 * retailers. The field keeps its name rather than growing a synonym.
 */
export interface CustomerFixtureCase extends FixtureCase {
  /** The case's five documents, narrowed to what this pack knows about them. */
  readonly documents: readonly CustomerFixtureDocument[];
  /** `STF-201`, as the pack names it. */
  readonly caseId: string;
  readonly vendor: string;
  readonly customerName: string;
  readonly invoiceNumber: string;
  readonly grossCents: number;
  readonly deductionCents: number;
  /** What was actually paid. Printed on the case's remittance. */
  readonly paidCents: number;
  /** `null` means undetermined — the pack's word — and never 0. */
  readonly recoverCents: number | null;
  readonly decision: CustomerDecision;
  /** The pack's own statement of why, quoted. */
  readonly basis: string;
  /**
   * The document the three amounts below are printed on.
   *
   * A settlement page, not necessarily a remittance: STF-203's three amounts
   * are printed on a short-payment *notice*, and naming the field after the
   * remittance would have the fixture asserting a document type one of the
   * three cases does not have.
   */
  readonly settlementKey: string;
  /** Gross, deduction and paid exactly as printed, for our parser to read. */
  readonly printed: {
    readonly gross: string;
    readonly deduction: string;
    readonly paid: string;
  };
}

interface DocumentSpec {
  readonly key: string;
  readonly docType: string;
  readonly role: CustomerDocumentRole;
  readonly truth: Readonly<Record<string, TruthExpectation>>;
}

/**
 * Ground truth, read off the label transcriptions by hand and reconciled with
 * `case_ground_truth.json`. Money is asserted as cents and compared after our
 * own parser reads what the model copied; dates and codes are asserted as the
 * page prints them, in the page's own capitalisation, because scoring lowercases
 * both sides and the drift guard does not.
 */
const SPECS: Readonly<Record<string, DocumentSpec>> = {
  // --- STF-201: overtime the customer approved in writing --------------------
  '01_stf-201': {
    key: 'stf-201-short-pay-remittance',
    docType: 'remittance_advice',
    role: 'remittance',
    truth: {
      payer_name: text('Briarfield Packaging Co.'),
      payment_reference: text('BF-918-201'),
      payment_date: text('September 18, 2026'),
      payment_total: money(660_000),
      'lines[0].invoice_number': text('ES-260901'),
      'lines[0].gross_amount': money(720_000),
      'lines[0].deduction_amount': money(60_000),
      'lines[0].net_amount': money(660_000),
      'lines[0].reason_code': text('OT-UNAUTH'),
    },
  },
  '02_stf-201': {
    key: 'stf-201-staffing-invoice',
    docType: 'invoice',
    role: 'evidence',
    truth: {
      invoice_number: text('ES-260901'),
      invoice_date: text('September 1, 2026'),
      po_number: text('BF-201'),
      customer_name: text('Briarfield Packaging Co.'),
      invoice_total: money(720_000),
      // Two billed lines in the order the page prints them. The second is the
      // whole case: 40 hours at $45.00 is $1,800.00, of which the $15.00
      // premium — $600.00 — is what the customer withheld.
      'lines[0].qty': int(180),
      'lines[0].unit_cost': money(3_000),
      'lines[0].extended_amount': money(540_000),
      'lines[1].qty': int(40),
      'lines[1].unit_cost': money(4_500),
      'lines[1].extended_amount': money(180_000),
    },
  },
  '03_stf-201': {
    key: 'stf-201-time-register',
    docType: 'other',
    role: 'evidence',
    // A generic document is `document_kind` plus free-form facts, so the only
    // field worth scoring is what the reader thinks it is holding.
    truth: { document_kind: text('TIME REGISTER') },
  },
  '04_stf-201': {
    key: 'stf-201-overtime-approval',
    docType: 'correspondence',
    role: 'evidence',
    truth: {
      message_reference: text('APR-201'),
      sent_at: text('August 23, 2026, 3:10 PM Eastern'),
      sender: text('Lena Ortiz'),
      recipient: text('Elmbridge Staffing Dispatch'),
      subject: text('AS-201 - approved overtime for August 24-28'),
      // Approving overtime is not waiving a charge. Reading it as one would
      // invent a commitment the customer never made.
      'commitments[0].waives_charge': bool(false),
    },
  },
  '05_stf-201': {
    key: 'stf-201-rate-agreement',
    docType: 'price_agreement',
    role: 'context',
    truth: {
      agreement_type: text('RATE AGREEMENT'),
      counterparty: text('Briarfield Packaging Co.'),
      effective_from: text('August 1'),
      effective_to: text('December 31, 2026'),
    },
  },

  // --- LOG-202: half the deduction is right ---------------------------------
  '06_log-202': {
    key: 'log-202-remittance-advice',
    docType: 'remittance_advice',
    role: 'remittance',
    truth: {
      payer_name: text('Westhaven Paper Supply'),
      payment_reference: text('ACH-WP-202'),
      payment_date: text('September 18, 2026'),
      payment_total: money(480_000),
      'lines[0].invoice_number': text('CF-260902'),
      'lines[0].gross_amount': money(560_000),
      'lines[0].net_amount': money(480_000),
    },
  },
  '07_log-202': {
    key: 'log-202-freight-invoice',
    docType: 'invoice',
    role: 'evidence',
    truth: {
      invoice_number: text('CF-260902'),
      invoice_date: text('September 2, 2026'),
      po_number: text('WP-202'),
      customer_name: text('Westhaven Paper Supply'),
      invoice_total: money(560_000),
    },
  },
  '08_log-202': {
    key: 'log-202-delivery-receipt',
    docType: 'pod',
    role: 'evidence',
    truth: {
      document_number: text('POD-202'),
      ship_date: text('September 1, 2026'),
      po_number: text('WP-202'),
      // 12:45 against a 1:00 PM appointment. The $500 turns on these fifteen
      // minutes, the way LOG-001 turns on eighteen.
      gate_check_in_at: text('12:45 PM Eastern'),
      appointment_reference: text('AP-202 revision 2'),
      total_cartons_shipped: int(80),
      total_cartons_received: int(78),
      signed_by: text('Simon Reed'),
      signature_present: bool(true),
    },
  },
  '09_log-202': {
    key: 'log-202-appointment-revision',
    docType: 'correspondence',
    role: 'evidence',
    truth: {
      message_reference: text('AP-202 revision 2'),
      sent_at: text('August 31, 2026'),
      'commitments[0].effective_at': text('September 1, 2026, 1:00 PM Eastern'),
      'commitments[0].supersedes': text('the original appointment'),
      // A reschedule is not a waiver. The late fee dies on the clock, not on
      // this page saying it does not apply — because it does not say that.
      'commitments[0].waives_charge': bool(false),
    },
  },
  '10_log-202': {
    key: 'log-202-rate-confirmation',
    docType: 'price_agreement',
    role: 'context',
    truth: {
      agreement_type: text('RATE CONFIRMATION'),
      counterparty: text('Westhaven Paper Supply'),
    },
  },

  // --- STF-203: the evidence that does not exist ----------------------------
  '11_stf-203': {
    key: 'stf-203-short-payment-notice',
    docType: 'deduction_notice',
    role: 'notice',
    truth: {
      retailer_name: text('Faircrest Assembly Ltd.'),
      invoice_number: text('OW-260903'),
      po_number: text('FC-203'),
      'lines[0].deduction_amount': money(45_000),
      // The line prints "CB-203 / PREMIUM-NOAUTH": a chargeback number and the
      // reason. The number is this deduction's own; the code is why.
      'lines[0].reason_code': text('PREMIUM-NOAUTH'),
      'lines[0].deduction_reference': text('CB-203'),
      deduction_total: money(45_000),
      deduction_date: text('September 18, 2026'),
      dispute_deadline: text('October 18, 2026'),
    },
  },
  '12_stf-203': {
    key: 'stf-203-workforce-invoice',
    docType: 'invoice',
    role: 'evidence',
    truth: {
      invoice_number: text('OW-260903'),
      invoice_date: text('September 3, 2026'),
      po_number: text('FC-203'),
      customer_name: text('Faircrest Assembly Ltd.'),
      invoice_total: money(495_000),
      'lines[0].qty': int(150),
      'lines[0].unit_cost': money(3_000),
      'lines[0].extended_amount': money(450_000),
      // The premium is charged on 30 of the same 150 hours, not on 30 more.
      'lines[1].qty': int(30),
      'lines[1].unit_cost': money(1_500),
      'lines[1].extended_amount': money(45_000),
    },
  },
  '13_stf-203': {
    key: 'stf-203-attendance-summary',
    docType: 'other',
    role: 'evidence',
    truth: { document_kind: text('ATTENDANCE SUMMARY') },
  },
  '14_stf-203': {
    key: 'stf-203-dispatch-note',
    docType: 'other',
    role: 'context',
    truth: { document_kind: text('DISPATCH HANDOFF NOTE') },
  },
  '15_stf-203': {
    key: 'stf-203-service-order-terms',
    docType: 'price_agreement',
    role: 'context',
    truth: {
      agreement_type: text('SERVICE ORDER TERMS'),
      counterparty: text('Faircrest Assembly Ltd.'),
      effective_from: text('August 20'),
      effective_to: text('September 30, 2026'),
    },
  },
};

/**
 * What the case's settlement page prints, and what was paid, read off that page.
 *
 * Two of the three are remittances; STF-203's is the short-payment notice,
 * which is why this is keyed on the settlement rather than on a remittance.
 *
 * `paidCents` is read from the document rather than computed as gross minus
 * deduction, so that "gross − paid = deduction" stays a claim the test can
 * check against the page instead of an identity that cannot fail.
 */
const SETTLEMENT: Readonly<
  Record<
    string,
    {
      settlementKey: string;
      gross: string;
      deduction: string;
      paid: string;
      paidCents: number;
    }
  >
> = {
  'STF-201': {
    settlementKey: 'stf-201-short-pay-remittance',
    gross: '$7,200.00',
    deduction: '$600.00',
    paid: '$6,600.00',
    paidCents: 660_000,
  },
  'LOG-202': {
    settlementKey: 'log-202-remittance-advice',
    gross: '$5,600.00',
    deduction: '$800.00',
    paid: '$4,800.00',
    paidCents: 480_000,
  },
  'STF-203': {
    settlementKey: 'stf-203-short-payment-notice',
    gross: '$4,950.00',
    deduction: '$450.00',
    paid: '$4,500.00',
    paidCents: 450_000,
  },
};

const CASE_TITLES: Readonly<Record<string, string>> = {
  'STF-201': 'STF-201 — staffing overtime premium, $600 withheld as unapproved',
  'LOG-202': 'LOG-202 — freight: a $500 late fee that is wrong and a $300 shortage that is right',
  'STF-203': 'STF-203 — staffing weekend premium, $450 withheld for want of a written approval',
};

/** The counterparty slug, in the vocabulary `FixtureCase.retailer` expects. */
const CASE_COUNTERPARTY_KEYS: Readonly<Record<string, string>> = {
  'STF-201': 'briarfield_packaging',
  'LOG-202': 'westhaven_paper',
  'STF-203': 'faircrest_assembly',
};

const DECISION_PROSE: Readonly<Record<CustomerDecision, string>> = {
  dispute_full: 'Dispute the whole deduction.',
  dispute_partial: 'Dispute part of the deduction and accept the rest.',
  request_evidence:
    'Ask for the missing approval before deciding: what the case is worth is undetermined, which is not the same as nothing.',
};

function isDecision(value: string): value is CustomerDecision {
  return value === 'dispute_full' || value === 'dispute_partial' || value === 'request_evidence';
}

function mimeTypeOf(file: string): 'application/pdf' | 'image/jpeg' {
  if (file.endsWith('.pdf')) return 'application/pdf';
  if (file.endsWith('.jpg')) return 'image/jpeg';
  throw new Error(`the customer pack has a file this code cannot type: ${file}`);
}

let documentCache: readonly CustomerFixtureDocument[] | undefined;
let caseCache: readonly CustomerFixtureCase[] | undefined;

function build(): readonly CustomerFixtureDocument[] {
  const manifest = JSON.parse(
    readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
  ) as readonly ManifestEntry[];

  return manifest.map((entry) => {
    const spec = SPECS[entry.document_id];
    if (spec === undefined) {
      // A document nobody mapped is a document nobody scores. Fail loudly
      // rather than quietly dropping it out of the suite.
      throw new Error(`customer pack document ${entry.document_id} has no mapping in customer.ts`);
    }
    const mimeType = mimeTypeOf(entry.file);
    const labelText = readFileSync(
      path.join(dir, 'labels', `${entry.document_id}.txt`),
      'utf8',
    ).trimEnd();

    return {
      key: spec.key,
      documentId: entry.document_id,
      caseId: entry.case_id,
      filename: path.basename(entry.file),
      mimeType,
      docType: spec.docType,
      role: spec.role,
      packDocumentType: entry.document_type,
      rendering: entry.rendering,
      labelText,
      // A photograph arrives with no text layer; OCR gives it one at recording
      // time, and the label is what OCR is measured against rather than what is
      // handed to the model. A native PDF's text layer is the label itself.
      pageText: mimeType === 'application/pdf' ? [labelText] : [],
      bytes: new Uint8Array(readFileSync(path.join(dir, entry.file))),
      truth: spec.truth,
      suite: 'customer' as const,
    };
  });
}

export function customerDocuments(): readonly CustomerFixtureDocument[] {
  documentCache ??= build();
  return documentCache;
}

export function customerCases(): readonly CustomerFixtureCase[] {
  if (caseCache !== undefined) return caseCache;

  const truth = JSON.parse(
    readFileSync(path.join(dir, 'case_ground_truth.json'), 'utf8'),
  ) as readonly CaseTruthEntry[];
  const documents = customerDocuments();

  caseCache = truth.map((entry) => {
    if (!isDecision(entry.decision)) {
      throw new Error(`customer case ${entry.id} has a decision this code does not know: ${entry.decision}`);
    }
    const settlement = SETTLEMENT[entry.id];
    const title = CASE_TITLES[entry.id];
    const counterparty = CASE_COUNTERPARTY_KEYS[entry.id];
    if (settlement === undefined || title === undefined || counterparty === undefined) {
      throw new Error(`customer case ${entry.id} has no mapping in customer.ts`);
    }

    return {
      key: entry.id.toLowerCase(),
      caseId: entry.id,
      title,
      retailer: counterparty,
      vendor: entry.vendor,
      customerName: entry.customer,
      invoiceNumber: entry.inv,
      grossCents: entry.gross,
      deductionCents: entry.ded,
      paidCents: settlement.paidCents,
      // Null is the pack's own answer for STF-203 and it is kept as null. A
      // recovery we cannot predict is not a recovery of zero.
      recoverCents: entry.recover,
      decision: entry.decision,
      basis: entry.basis,
      settlementKey: settlement.settlementKey,
      printed: {
        gross: settlement.gross,
        deduction: settlement.deduction,
        paid: settlement.paid,
      },
      documents: documents.filter((d) => d.caseId === entry.id),
      expectedOutcome: `${DECISION_PROSE[entry.decision]} ${entry.basis}`,
    };
  });
  return caseCache;
}

export function customerCase(caseId: string): CustomerFixtureCase {
  const found = customerCases().find((c) => c.caseId === caseId || c.key === caseId);
  if (found === undefined) throw new Error(`no customer fixture case ${caseId}`);
  return found;
}
