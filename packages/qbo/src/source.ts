/**
 * `QboAccountingSource` — the first implementation of `AccountingSource`
 * (STRATEGY §5.1, §5.4 "ERP read"; ADR 0026).
 *
 * **Read only, and read only by construction.** There is no write method here
 * because there is none on the port. QBO write-back is Phase 4 and arrives as a
 * different port with the database's approval gate between it and QuickBooks —
 * not as a fourth method on this class.
 */

import type {
  AccountingSource,
  GeneralLedger,
  GeneralLedgerOptions,
  LedgerAccount,
  LedgerCredit,
  LedgerInvoice,
  LedgerInvoiceHistories,
  LedgerPayment,
  LedgerWindow,
  ProfitAndLoss,
  TrialBalance,
} from '@recouple/adapters';
import { GENERAL_LEDGER_MAX_WINDOW_DAYS, SIZING_WINDOW_DAYS, windowDays } from '@recouple/core-domain';
import { QBO_IDS_PER_QUERY, QboClient, assertWindowDate, type QboConnectionConfig } from './client';
import { QboInvalidWindow, QboMalformedResponse } from './errors';
import { assertQboId } from './ids';
import {
  linkedTxnIds,
  resolveCreditApplications,
  toLedgerCredit,
  toLedgerInvoice,
  toLedgerPayment,
} from './map';
import { readString } from './reader';
import {
  GENERAL_LEDGER_COLUMNS,
  parseGeneralLedgerReport,
  parseProfitAndLossReport,
  parseTrialBalanceReport,
  toLedgerAccount,
} from './reports';

export type QboAccountingSourceConfig = QboConnectionConfig;

export class QboAccountingSource implements AccountingSource {
  readonly kind = 'qbo' as const;

  private readonly client: QboClient;

  constructor(config: QboAccountingSourceConfig) {
    this.client = new QboClient(config);
  }

  async listInvoices(window: LedgerWindow): Promise<readonly LedgerInvoice[]> {
    const rows = await this.client.queryWindow('Invoice', window);
    return rows.map((row, index) => toLedgerInvoice(row, `Invoice[${index}]`));
  }

  async listPayments(window: LedgerWindow): Promise<readonly LedgerPayment[]> {
    const rows = await this.client.queryWindow('Payment', window);
    return rows.map((row, index) => toLedgerPayment(row, `Payment[${index}]`));
  }

  /**
   * Credit memos, plus the payments needed to say what they were applied to.
   *
   * Two queries, not one, and deliberately: QBO records a credit memo's
   * application to an invoice on the **Payment** that links them, never on the
   * `CreditMemo` itself. A credit applied by a payment outside this window is
   * left with `appliedTo: []` rather than an invented application.
   */
  async listCredits(window: LedgerWindow): Promise<readonly LedgerCredit[]> {
    const creditRows = await this.client.queryWindow('CreditMemo', window);
    const paymentRows = await this.client.queryWindow('Payment', window);
    const applications = resolveCreditApplications(paymentRows, (index) => `Payment[${index}]`);
    return creditRows.map((row, index) => toLedgerCredit(row, `CreditMemo[${index}]`, applications));
  }

  /**
   * The named invoices, whatever their dates, with every payment and credit
   * applied to them, whatever theirs (ADR 0035 §2). Three reads by id:
   *
   * 1. the invoices;
   * 2. every Payment their own `LinkedTxn` names — QBO lists on an invoice each
   *    payment applied to it, the zero-dollar one that applies a credit memo
   *    included;
   * 3. every CreditMemo those payments apply, with its applications resolved
   *    from the same payments, exactly as `listCredits` resolves them.
   *
   * **Complete or loud.** An invoice that names a payment QBO then does not
   * return is a partial history, and a partial tally reads as a short-pay that
   * never happened — so it raises rather than returning what it has. The same
   * for a credit memo a payment applies and QBO does not return.
   */
  async getInvoiceHistories(invoiceExternalIds: readonly string[]): Promise<LedgerInvoiceHistories> {
    if (invoiceExternalIds.length === 0) return { invoices: [], payments: [], credits: [] };

    const invoiceRows = await this.client.queryByIds('Invoice', invoiceExternalIds);
    const invoices = invoiceRows.map((row, index) => toLedgerInvoice(row, `Invoice[${index}]`));

    const expectedPayments = new Map<string, string>();
    invoiceRows.forEach((row, index) => {
      const invoiceId = readString(row, 'Id', `Invoice[${index}]`);
      for (const paymentId of linkedTxnIds(row, 'Payment', `Invoice[${index}]`)) {
        if (!expectedPayments.has(paymentId)) expectedPayments.set(paymentId, invoiceId);
      }
    });

    const paymentRows =
      expectedPayments.size === 0
        ? []
        : await this.client.queryByIds('Payment', [...expectedPayments.keys()]);
    const payments = paymentRows.map((row, index) => toLedgerPayment(row, `Payment[${index}]`));
    assertAllReturned(
      'Payment',
      expectedPayments,
      payments.map((payment) => payment.externalId),
      'invoice',
    );

    const applications = resolveCreditApplications(paymentRows, (index) => `Payment[${index}]`);
    const expectedCredits = new Map<string, string>();
    for (const [creditId, applied] of applications) {
      expectedCredits.set(creditId, applied[0]?.invoiceExternalId ?? '');
    }
    const creditRows =
      expectedCredits.size === 0
        ? []
        : await this.client.queryByIds('CreditMemo', [...expectedCredits.keys()]);
    const credits = creditRows.map((row, index) =>
      toLedgerCredit(row, `CreditMemo[${index}]`, applications),
    );
    assertAllReturned(
      'CreditMemo',
      expectedCredits,
      credits.map((credit) => credit.externalId),
      'invoice',
    );

    return { invoices, payments, credits };
  }

  /**
   * The whole chart of accounts, inactive accounts included, each with its
   * code (ADR 0066 §1): posting setup's own read (`listAccountRows`, ADR 0063
   * §1), so it is bounded the same way — `QboChartTooLarge` past the client's
   * pages, never part of a chart.
   */
  async chartOfAccounts(): Promise<readonly LedgerAccount[]> {
    const rows = await this.client.listAccountRows();
    return rows.map((row, index) => toLedgerAccount(row, `Account[${index}]`));
  }

  /**
   * The trial balance as of one day (ADR 0066 §1).
   *
   * QuickBooks reports a trial balance over a period: balance-sheet accounts
   * at the period's end, income and expense accounts over the period. The
   * period asked for is the calendar year to date (`trialBalancePeriodStart`)
   * — a company on another fiscal year reads its income and expense from 1
   * January, which is why the period QuickBooks reported comes back on the
   * answer (`periodStart`) for a page to print rather than assume.
   */
  async trialBalance(asOf: string): Promise<TrialBalance> {
    const day = assertWindowDate(asOf, 'to');
    const body = await this.client.report('TrialBalance', {
      start_date: trialBalancePeriodStart(day),
      end_date: day,
    });
    return parseTrialBalanceReport(body, { asOf: day });
  }

  /**
   * The general ledger over an inclusive window, by account (ADR 0066 §1).
   *
   * One request: the Reports API does not paginate. So the read is bounded
   * before and after instead — a window past `GENERAL_LEDGER_MAX_WINDOW_DAYS`
   * is `QboInvalidWindow` before anything is asked, and a report QuickBooks
   * cut short, or one past `GENERAL_LEDGER_MAX_LINES`, is `QboReportTooLarge`
   * (`reports.ts`). Never part of a ledger.
   *
   * `accountIds` are proven to be digits and sent as the report's `account`
   * filter; an empty list asks QuickBooks nothing. Past `QBO_IDS_PER_QUERY`
   * ids the whole ledger is read instead, so the URL stays a modest one.
   * Either way only the accounts asked for are returned: QuickBooks prints a
   * parent's section around a sub-account that was asked for, and that parent
   * was not.
   */
  async generalLedger(
    window: LedgerWindow,
    options: GeneralLedgerOptions = {},
  ): Promise<GeneralLedger> {
    const from = assertWindowDate(window.from, 'from');
    const to = assertWindowDate(window.to, 'to');
    if (from > to) throw new QboInvalidWindow(`window runs backwards: from ${from} to ${to}`);
    const asked = { from, to };
    if (windowDays(asked) > GENERAL_LEDGER_MAX_WINDOW_DAYS) {
      throw new QboInvalidWindow(
        `a general ledger is read over at most ${GENERAL_LEDGER_MAX_WINDOW_DAYS} days, ` +
          `and ${from} to ${to} is ${windowDays(asked)}`,
      );
    }

    const wanted =
      options.accountIds === undefined
        ? undefined
        : [...new Set(options.accountIds.map((id) => assertQboId(id)))];
    if (wanted !== undefined && wanted.length === 0) {
      return { sourceKind: 'qbo', window: asked, accounts: [] };
    }

    const body = await this.client.report('GeneralLedger', {
      start_date: from,
      end_date: to,
      columns: GENERAL_LEDGER_COLUMNS.join(','),
      ...(wanted !== undefined && wanted.length <= QBO_IDS_PER_QUERY
        ? { account: wanted.join(',') }
        : {}),
    });
    const ledger = parseGeneralLedgerReport(body, { window: asked });
    if (wanted === undefined) return ledger;
    const keep = new Set(wanted);
    return {
      ...ledger,
      accounts: ledger.accounts.filter(
        (account) => account.accountExternalId !== undefined && keep.has(account.accountExternalId),
      ),
    };
  }

  /**
   * The profit and loss over an inclusive window, one total column (ADR 0073).
   *
   * One request, bounded before it is sent: a window past `SIZING_WINDOW_DAYS`
   * is `QboInvalidWindow` and QuickBooks is asked nothing. The accounting
   * basis is not sent, so QuickBooks answers in the company's own default and
   * says which (`basis`); `summarize_column_by=Total` asks for one money
   * column rather than one a month. What comes back is read whole or refused
   * (`parseProfitAndLossReport`).
   */
  async profitAndLoss(window: LedgerWindow): Promise<ProfitAndLoss> {
    const from = assertWindowDate(window.from, 'from');
    const to = assertWindowDate(window.to, 'to');
    if (from > to) throw new QboInvalidWindow(`window runs backwards: from ${from} to ${to}`);
    const asked = { from, to };
    if (windowDays(asked) > SIZING_WINDOW_DAYS) {
      throw new QboInvalidWindow(
        `a profit and loss is read over at most ${SIZING_WINDOW_DAYS} days, ` +
          `and ${from} to ${to} is ${windowDays(asked)}`,
      );
    }
    const body = await this.client.report('ProfitAndLoss', {
      start_date: from,
      end_date: to,
      summarize_column_by: 'Total',
    });
    return parseProfitAndLossReport(body, { window: asked });
  }
}

/**
 * The first day of the period a trial balance as of `asOf` is asked over: 1
 * January of that year. An assumption, written down as one — a company's
 * fiscal year is its own, and QuickBooks knows it (`CompanyInfo`), which this
 * adapter does not read yet (ADR 0066 §5).
 */
export function trialBalancePeriodStart(asOf: string): string {
  return `${asOf.slice(0, 4)}-01-01`;
}

/**
 * Every id the ledger's own links promised came back. One missing is a partial
 * history — raised, never tallied around (ADR 0035 §2).
 */
function assertAllReturned(
  entity: 'Payment' | 'CreditMemo',
  expected: ReadonlyMap<string, string>,
  returned: readonly string[],
  linkedFrom: string,
): void {
  const got = new Set(returned);
  for (const [id, from] of expected) {
    if (!got.has(id)) {
      throw new QboMalformedResponse(
        `${linkedFrom} ${from} links ${entity} ${id}, which QuickBooks did not return; ` +
          `tallying the invoice without it would report a short-pay that may not exist`,
        `QueryResponse.${entity}`,
      );
    }
  }
}
