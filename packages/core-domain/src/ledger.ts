/**
 * A customer's accounting ledger, as rows (STRATEGY §5.1, §5.4 — Phase 1.5
 * "ERP read").
 *
 * These are domain value objects, not a vendor's wire format: an invoice, a
 * payment and the credit memo that quietly closed the difference between them.
 * They live here, at the base of the dependency graph, because `detectShortPays`
 * next door reads them and because the port that fetches them is one layer out.
 * `packages/adapters/src/accounting.ts` re-exports every name below alongside
 * `AccountingSource`, so an adapter imports the whole contract from one place
 * and never learns that half of it is declared here.
 *
 * Money is integer cents throughout (invariant 3) and dates are ISO
 * `YYYY-MM-DD` strings, which sort in date order — the same discipline
 * `parsePrintedDate` and `parseMoneyToCents` apply to a page.
 */

import type { Cents } from './money';

export type AccountingSourceKind = 'qbo' | 'netsuite' | 'xero';

/** One invoice as the ledger records it. Money is integer cents, never floats. */
export interface LedgerInvoice {
  readonly sourceKind: AccountingSourceKind;
  readonly externalId: string;            // the ledger's own id for this invoice
  readonly invoiceNumber: string;         // as the customer sees it (QBO DocNumber)
  readonly customerExternalId: string;
  readonly customerName: string;          // as the ledger has it, verbatim
  readonly issuedOn: string;              // ISO 8601 date, YYYY-MM-DD
  readonly dueOn?: string;
  readonly totalCents: Cents;
  readonly balanceCents: Cents;           // still open on the invoice
  readonly currency: string;              // ISO 4217, e.g. 'USD'
}

/** One payment received, and which invoices the ledger applied it to. */
export interface LedgerPayment {
  readonly sourceKind: AccountingSourceKind;
  readonly externalId: string;
  readonly customerExternalId: string;
  readonly receivedOn: string;            // YYYY-MM-DD
  readonly totalCents: Cents;
  readonly reference?: string;            // check number, ACH reference, remittance id
  readonly memo?: string;                 // verbatim; may name a deduction reason
  readonly appliedTo: readonly LedgerApplication[];
}

/** A credit memo or write-off the ledger already recorded against a customer. */
export interface LedgerCredit {
  readonly sourceKind: AccountingSourceKind;
  readonly externalId: string;
  readonly customerExternalId: string;
  readonly issuedOn: string;
  readonly totalCents: Cents;
  readonly memo?: string;
  readonly appliedTo: readonly LedgerApplication[];
}

export interface LedgerApplication {
  readonly invoiceExternalId: string;
  readonly amountCents: Cents;
}

/** Inclusive ISO date range. */
export interface LedgerWindow {
  readonly from: string;
  readonly to: string;
}
