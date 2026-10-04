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

import {
  GENERAL_LEDGER_MAX_WINDOW_DAYS,
  sumCents,
  windowDays,
} from '@recouple/core-domain';
import type {
  AccountingSource,
  AccountingSourceKind,
  GeneralLedger,
  GeneralLedgerAccount,
  GeneralLedgerLine,
  GeneralLedgerOptions,
  LedgerAccount,
  LedgerCredit,
  LedgerInvoice,
  LedgerInvoiceHistories,
  LedgerPayment,
  LedgerWindow,
  TrialBalance,
  TrialBalanceLine,
} from '../accounting';

export interface InMemoryLedger {
  /** Which ledger this stands in for. Defaults to `'qbo'`, the first one built. */
  readonly kind?: AccountingSourceKind;
  readonly invoices?: readonly LedgerInvoice[];
  readonly payments?: readonly LedgerPayment[];
  readonly credits?: readonly LedgerCredit[];
  /** The chart of accounts, returned whole and in this order. */
  readonly accounts?: readonly LedgerAccount[];
  /** The trial balance's rows, whatever day is asked for: this double keeps one. */
  readonly trialBalanceLines?: readonly TrialBalanceLine[];
  /** Every general-ledger posting, in the order a real ledger would print them. */
  readonly ledgerLines?: readonly GeneralLedgerLine[];
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
  private readonly accounts: readonly LedgerAccount[];
  private readonly trialBalanceLines: readonly TrialBalanceLine[];
  private readonly ledgerLines: readonly GeneralLedgerLine[];

  constructor(ledger: InMemoryLedger = {}) {
    this.kind = ledger.kind ?? 'qbo';
    this.invoices = ledger.invoices ?? [];
    this.payments = ledger.payments ?? [];
    this.credits = ledger.credits ?? [];
    this.accounts = ledger.accounts ?? [];
    this.trialBalanceLines = ledger.trialBalanceLines ?? [];
    this.ledgerLines = ledger.ledgerLines ?? [];
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

  async chartOfAccounts(): Promise<readonly LedgerAccount[]> {
    return this.accounts;
  }

  /**
   * The rows it was given, as of whatever day is asked, with the totals a real
   * ledger prints: the sum of each side. It does not make them balance — a
   * test that wants an unbalanced ledger gives it one.
   */
  async trialBalance(asOf: string): Promise<TrialBalance> {
    return {
      sourceKind: this.kind,
      asOf,
      lines: this.trialBalanceLines,
      totalDebitCents: sumCents(this.trialBalanceLines.map((line) => line.debitCents)),
      totalCreditCents: sumCents(this.trialBalanceLines.map((line) => line.creditCents)),
    };
  }

  /**
   * The postings dated inside the window, both ends counted, grouped by
   * account in the order each account first appears — and only the named
   * accounts when `accountIds` is given, none at all when it is empty. A
   * window longer than the port allows is refused, as a real adapter refuses
   * it.
   */
  async generalLedger(
    window: LedgerWindow,
    options: GeneralLedgerOptions = {},
  ): Promise<GeneralLedger> {
    if (windowDays(window) > GENERAL_LEDGER_MAX_WINDOW_DAYS) {
      throw new RangeError(
        `a general ledger is read over at most ${GENERAL_LEDGER_MAX_WINDOW_DAYS} days`,
      );
    }
    const wanted = options.accountIds === undefined ? undefined : new Set(options.accountIds);
    const sections = new Map<string, { account: GeneralLedgerAccount; lines: GeneralLedgerLine[] }>();
    for (const line of this.ledgerLines) {
      if (!withinWindow(line.date, window)) continue;
      if (wanted !== undefined) {
        if (line.accountExternalId === undefined || !wanted.has(line.accountExternalId)) continue;
      }
      const key = line.accountExternalId ?? `name:${line.accountName}`;
      let section = sections.get(key);
      if (section === undefined) {
        const lines: GeneralLedgerLine[] = [];
        section = {
          lines,
          account: {
            ...(line.accountExternalId === undefined
              ? {}
              : { accountExternalId: line.accountExternalId }),
            accountName: line.accountName,
            lines,
          },
        };
        sections.set(key, section);
      }
      section.lines.push(line);
    }
    return {
      sourceKind: this.kind,
      window,
      accounts: [...sections.values()].map((section) => section.account),
    };
  }
}
