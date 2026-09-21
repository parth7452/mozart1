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
  LedgerPayment,
  LedgerWindow,
} from '@recouple/adapters';
import { QboClient, type QboConnectionConfig } from './client';
import { resolveCreditApplications, toLedgerCredit, toLedgerInvoice, toLedgerPayment } from './map';

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
}
