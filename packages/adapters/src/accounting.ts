/**
 * AccountingSource (STRATEGY §5.1, §5.4 — Phase 1.5 "ERP read").
 *
 * The seam through which a customer's own ledger enters the system. Today a
 * deduction can only arrive if the customer already knew about it and uploaded
 * or emailed it, which caps coverage at what they surface; the ledger is where
 * the rest of it shows up, as an invoice that was paid short (STRATEGY §2, §5).
 *
 * Interfaces only, in the manner of `evidence.ts` and `submission.ts`: QBO is
 * the first implementation and NetSuite and Xero follow behind the same port.
 * The arithmetic over what comes back is not here — it is `detectShortPays` in
 * `core-domain`, where it is pure, deterministic and testable without a vendor.
 *
 * The row types are declared in `core-domain`'s `ledger.ts`, because
 * `core-domain` is the base of the dependency graph and must not import from a
 * package above it. They are re-exported here under the same names, so this
 * module is the whole contract an adapter needs and where a given type is
 * written down is nobody else's problem.
 */

import type {
  AccountingSourceKind,
  LedgerCredit,
  LedgerInvoice,
  LedgerInvoiceHistories,
  LedgerPayment,
  LedgerWindow,
} from '@recouple/core-domain';

export type {
  AccountingSourceKind,
  LedgerApplication,
  LedgerCredit,
  LedgerInvoice,
  LedgerInvoiceHistories,
  LedgerPayment,
  LedgerWindow,
} from '@recouple/core-domain';

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
  /**
   * The named invoices whatever their dates, and every payment and credit the
   * ledger has applied to any of them whatever *their* dates (ADR 0035 §2).
   *
   * One method returning the whole history, rather than by-id primitives a
   * caller composes, because only the adapter knows how its ledger links an
   * application to an invoice — QBO records a credit's on a Payment — and the
   * promise that matters is that the history is **complete**: a tally over part
   * of an invoice's applications reads as a short-pay that never happened. An
   * adapter that cannot return all of an invoice's applications throws rather
   * than returning some. An id the ledger does not have is absent from
   * `invoices`, not an error.
   */
  getInvoiceHistories(invoiceExternalIds: readonly string[]): Promise<LedgerInvoiceHistories>;
}
