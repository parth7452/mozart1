import type { Cents } from '@recouple/core-domain';

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

/**
 * AccountingSource (STRATEGY §5.1, §5.4 — Phase 1.5 "ERP read").
 * Read-only by construction: there is no method that writes. Write-back is
 * Phase 4 and lives behind a different port.
 */
export interface AccountingSource {
  readonly kind: AccountingSourceKind;
  listInvoices(window: LedgerWindow): Promise<readonly LedgerInvoice[]>;
  listPayments(window: LedgerWindow): Promise<readonly LedgerPayment[]>;
  listCredits(window: LedgerWindow): Promise<readonly LedgerCredit[]>;
}
