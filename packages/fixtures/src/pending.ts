/**
 * Shapes the corpus does not cover yet, and has no cassette for.
 *
 * A fixture can land before its numbers do: recording a cassette calls the API
 * and spends money, and a document written on a machine with no key cannot be
 * recorded there. Such a document still belongs in the corpus — it is the
 * document that says which shapes we have never read — so it goes in a suite of
 * its own, `authored_pending`, which the eval gate reports as "not yet
 * recorded, skipped, not failed" rather than scoring as zero or silently
 * leaving out of a recorded suite's average.
 *
 * It is deliberately NOT part of `authoredDocuments()`: that suite's baseline
 * row says eight documents, and a ninth with no cassette would make the
 * `authored` row a count of something else.
 *
 * Record it with `pnpm record:cassettes --suite authored_pending` (this calls
 * the API and spends money), then `pnpm eval --record-baseline`.
 */

import type { FixtureCase, FixtureDocument, TruthExpectation } from './cases';
import { renderTextPdf } from './pdf';

const text = (value: string): TruthExpectation => ({ kind: 'text', value });
const moneyCents = (value: number): TruthExpectation => ({ kind: 'money_cents', value });

function pendingPdf(input: {
  key: string;
  filename: string;
  docType: string;
  pages: readonly (readonly string[])[];
  truth: Record<string, TruthExpectation>;
}): FixtureDocument {
  return {
    key: input.key,
    filename: input.filename,
    mimeType: 'application/pdf',
    docType: input.docType,
    pageText: input.pages.map((lines) => lines.join('\n')),
    bytes: renderTextPdf(input.pages),
    truth: input.truth,
    suite: 'authored_pending',
  };
}

// --- An invoice-level charge: a line with no item on it ----------------------
//
// Every notice in the corpus until now deducted against an item, so every line
// carried a SKU. A great many deductions do not: an allowance, a compliance
// charge, a discount, or — as here — a service premium a customer refuses to
// pay for. The line is still a line and still has to add up; it just names no
// item, because there is no item to name.
//
// This is the shape that took the review page down in production on 2026-09-21
// (case eef4fec8-940c-4f80-8313-4a754661d700): read once, stored, and then
// read *back* as a line with no `sku_upc` key at all.

const premiumNotice = pendingPdf({
  key: 'oakridge-premium-notice',
  filename: 'oakridge-premium-notice.pdf',
  docType: 'deduction_notice',
  pages: [
    [
      'OAKRIDGE MANUFACTURING CO.',
      'Accounts Payable - Short Payment Notice',
      '',
      'Supplier: Northfork Staffing LLC',
      'Vendor Number: NS-4412',
      'Claim Number: SP-4417',
      'Invoice Number: NS-260914',
      'Deduction Date: 09/14/2026',
      'Payment Reference: ACH-771902',
      '',
      'DEDUCTION DETAIL',
      'Charge                               Code              Amount',
      'Weekend shift premium, unauthorised  PREMIUM-NOAUTH  $1,275.00',
      '',
      'PREMIUM-NOAUTH: Premium hours billed without prior written authorisation',
      '',
      'This charge is assessed against the invoice as a whole. No item number,',
      'SKU or part number is cited, and none applies: the charge is for hours',
      'worked, not for goods.',
      '',
      'Total Short Paid: $1,275.00',
      '',
      'Disputes must be received within 30 days of the deduction date.',
      'Dispute Deadline: 10/14/2026',
    ],
  ],
  truth: {
    retailer_name: text('Oakridge'),
    vendor_number: text('NS-4412'),
    claim_id: text('SP-4417'),
    invoice_number: text('NS-260914'),
    'lines[0].deduction_amount': moneyCents(127_500),
    'lines[0].reason_code': text('PREMIUM-NOAUTH'),
    deduction_total: moneyCents(127_500),
  },
});

export const OAKRIDGE_SERVICE_PREMIUM: FixtureCase = {
  key: 'oakridge-service-premium',
  title: 'Oakridge short payment of an unauthorised weekend premium, $1,275, no item cited',
  retailer: 'oakridge_manufacturing',
  documents: [premiumNotice],
  expectedOutcome:
    'The notice deducts a service premium against the invoice as a whole: one line, no SKU, no quantities, nothing to three-way match. Reconciliation has only the arithmetic to check — the line equals the total — and the dispute turns on whether the premium was authorised in writing, which is a document this case does not yet have.',
};

/** Fixtures whose cassettes have not been recorded. Never in a scored suite. */
export function pendingDocuments(): readonly FixtureDocument[] {
  return OAKRIDGE_SERVICE_PREMIUM.documents;
}
