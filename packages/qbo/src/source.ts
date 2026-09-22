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
  LedgerCredit,
  LedgerInvoice,
  LedgerInvoiceHistories,
  LedgerPayment,
  LedgerWindow,
} from '@recouple/adapters';
import { QboClient, type QboConnectionConfig } from './client';
import { QboMalformedResponse } from './errors';
import {
  linkedTxnIds,
  resolveCreditApplications,
  toLedgerCredit,
  toLedgerInvoice,
  toLedgerPayment,
} from './map';
import { readString } from './reader';

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
