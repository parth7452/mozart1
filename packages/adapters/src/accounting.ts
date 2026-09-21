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
  LedgerPayment,
  LedgerWindow,
} from '@recouple/core-domain';

export type {
  AccountingSourceKind,
  LedgerApplication,
  LedgerCredit,
  LedgerInvoice,
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
}
