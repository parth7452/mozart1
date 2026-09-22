/**
 * An in-memory AccountingSource, built from arrays.
 *
 * For tests and local development only. It is exported from
 * `@recouple/adapters/testing`, a separate entry point, so production code
 * cannot reach it by importing the package (CLAUDE.md: no mocks reachable from
 * production paths) — the same split `@recouple/pipeline/testing` uses.
 *
 * It models the one behaviour of a real ledger API that callers depend on and
 * would otherwise only discover against a vendor: the window filters, and it
 * filters *inclusively* on both ends, on `issuedOn` for invoices and credits
 * and on `receivedOn` for payments — and a by-id read ignores dates entirely. Rows come back in the order they were
 * given, so a test that cares about order can pin it.
 *
 * It does no arithmetic and holds no opinion about what the rows mean. That is
 * `detectShortPays`, next door in `core-domain`.
 */

import type {
  AccountingSource,
  AccountingSourceKind,
  LedgerCredit,
  LedgerInvoice,
  LedgerInvoiceHistories,
  LedgerPayment,
  LedgerWindow,
} from '../accounting';

export interface InMemoryLedger {
  /** Which ledger this stands in for. Defaults to `'qbo'`, the first one built. */
  readonly kind?: AccountingSourceKind;
  readonly invoices?: readonly LedgerInvoice[];
  readonly payments?: readonly LedgerPayment[];
  readonly credits?: readonly LedgerCredit[];
}

/**
 * ISO `YYYY-MM-DD` sorts lexicographically in date order, which is the whole
 * reason the port carries dates as ISO strings rather than as `Date`.
 */
function withinWindow(date: string, window: LedgerWindow): boolean {
  return date >= window.from && date <= window.to;
}

export class InMemoryAccountingSource implements AccountingSource {
  readonly kind: AccountingSourceKind;

  private readonly invoices: readonly LedgerInvoice[];
  private readonly payments: readonly LedgerPayment[];
  private readonly credits: readonly LedgerCredit[];

  constructor(ledger: InMemoryLedger = {}) {
    this.kind = ledger.kind ?? 'qbo';
    this.invoices = ledger.invoices ?? [];
    this.payments = ledger.payments ?? [];
    this.credits = ledger.credits ?? [];
  }

  async listInvoices(window: LedgerWindow): Promise<readonly LedgerInvoice[]> {
    return this.invoices.filter((invoice) => withinWindow(invoice.issuedOn, window));
  }

  async listPayments(window: LedgerWindow): Promise<readonly LedgerPayment[]> {
    return this.payments.filter((payment) => withinWindow(payment.receivedOn, window));
  }

  async listCredits(window: LedgerWindow): Promise<readonly LedgerCredit[]> {
    return this.credits.filter((credit) => withinWindow(credit.issuedOn, window));
  }

  /**
   * By id, whatever the date — and every payment and credit with an
   * application to a returned invoice, whatever theirs. Complete by
   * construction, which is the promise the port makes (ADR 0035 §2).
   */
  async getInvoiceHistories(invoiceExternalIds: readonly string[]): Promise<LedgerInvoiceHistories> {
    const asked = new Set(invoiceExternalIds);
    const invoices = this.invoices.filter((invoice) => asked.has(invoice.externalId));
    const found = new Set(invoices.map((invoice) => invoice.externalId));
    const touches = (row: LedgerPayment | LedgerCredit): boolean =>
      row.appliedTo.some((application) => found.has(application.invoiceExternalId));
    return {
      invoices,
      payments: this.payments.filter(touches),
      credits: this.credits.filter(touches),
    };
  }
}
