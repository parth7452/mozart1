/**
 * Credit is not cash, in either shape QuickBooks writes it (ADR 0036).
 *
 * The bug this file exists for: the mapper recognised a credit application only
 * when one Payment line named both the CreditMemo and the Invoice — the shape
 * the hand-written `payment-query.json` assumes. The Intuit sandbox recording
 * holds the other shape. Payment 74 is `TotalAmt: 0` with **two** lines: $100
 * naming Invoice 71, and $100 naming CreditMemo 73. Line by line, that first
 * line is $100 of cash that never arrived, and credit memo 73 is applied to
 * nothing — so invoice 71 ($205, $105 of cash, $100 written off) read as paid
 * in full and the deduction this product exists to find was invisible.
 *
 * Nothing here is a fixture we wrote to suit ourselves: the numbers come from
 * `recorded-payment-query.json`, `recorded-creditmemo-query.json` and
 * `recorded-invoice-query.json`, recorded from a real sandbox.
 */

import { describe, expect, it } from 'vitest';
import { detectShortPays } from '@recouple/core-domain';
import { QboMalformedResponse } from '../src/errors';
import {
  resolveCreditApplications,
  toLedgerCredit,
  toLedgerInvoice,
  toLedgerPayment,
} from '../src/map';
import type { JsonObject } from '../src/reader';
import { fixture } from './helpers';

function recorded(file: string, entity: string): readonly JsonObject[] {
  const body = fixture(file) as { QueryResponse: Record<string, JsonObject[] | undefined> };
  return body.QueryResponse[entity] ?? [];
}

const PAYMENT_ROWS = recorded('recorded-payment-query.json', 'Payment');
const CREDIT_ROWS = recorded('recorded-creditmemo-query.json', 'CreditMemo');
const INVOICE_ROWS = recorded('recorded-invoice-query.json', 'Invoice');

function paymentsFromRecording() {
  return PAYMENT_ROWS.map((row, index) => toLedgerPayment(row, `Payment[${index}]`));
}

function creditsFromRecording() {
  const applications = resolveCreditApplications(PAYMENT_ROWS, (index) => `Payment[${index}]`);
  return CREDIT_ROWS.map((row, index) => toLedgerCredit(row, `CreditMemo[${index}]`, applications));
}

/** A Payment row in the sandbox's own shape: one `Amount` and its links per line. */
function paymentRow(
  id: string,
  totalAmt: number,
  lines: readonly { amount: number; links: readonly (readonly [string, string])[] }[],
): JsonObject {
  return {
    Id: id,
    TxnDate: '2026-08-10',
    TotalAmt: totalAmt,
    CustomerRef: { value: '1', name: 'Amy’s Bird Sanctuary' },
    Line: lines.map((line) => ({
      Amount: line.amount,
      LinkedTxn: line.links.map(([TxnType, TxnId]) => ({ TxnType, TxnId })),
    })),
  } as unknown as JsonObject;
}

describe('the recorded sandbox: a credit memo applied on its own line (ADR 0036)', () => {
  it('counts payment 74 as no cash at all — it carried none', () => {
    const payment = paymentsFromRecording().find((p) => p.externalId === '74');

    expect(payment?.totalCents).toBe(0);
    // The $100 line naming invoice 71 is the credit being applied, not money.
    expect(payment?.appliedTo).toEqual([]);
  });

  it('resolves credit memo 73 to invoice 71, which nothing used to point it at', () => {
    const credit = creditsFromRecording().find((c) => c.externalId === '73');

    expect(credit?.totalCents).toBe(10_000);
    expect(credit?.appliedTo).toEqual([{ invoiceExternalId: '71', amountCents: 10_000 }]);
  });

  it('leaves every cash payment in the recording exactly as it was', () => {
    // Thirteen of the fourteen recorded payments have a single invoice line and
    // no credit memo. If this fix moved any of those, it broke more than it fixed.
    const byId = new Map(paymentsFromRecording().map((p) => [p.externalId, p]));
    expect(byId.get('72')?.appliedTo).toEqual([{ invoiceExternalId: '71', amountCents: 10_500 }]);
    expect(byId.get('101')?.appliedTo).toEqual([{ invoiceExternalId: '67', amountCents: 22_000 }]);
    expect(byId.get('61')?.appliedTo).toEqual([{ invoiceExternalId: '12', amountCents: 69_400 }]);
    for (const payment of byId.values()) {
      const cash = payment.appliedTo.reduce((sum, a) => sum + a.amountCents, 0);
      expect(cash).toBeLessThanOrEqual(payment.totalCents);
    }
  });

  it('makes invoice 71 the written-off deduction it is: $105 cash, $100 credited', () => {
    const invoices = INVOICE_ROWS.map((row, index) => toLedgerInvoice(row, `Invoice[${index}]`));
    const report = detectShortPays(invoices, paymentsFromRecording(), creditsFromRecording());
    const invoice71 = report.candidates.find((c) => c.invoiceExternalId === '71');

    expect(invoice71).toMatchObject({
      invoiceTotalCents: 20_500,
      appliedPaymentsCents: 10_500,
      appliedCreditsCents: 10_000,
      gapCents: 10_000,
      // The ledger already wrote the gap off. Nobody disputed it; that is the
      // point of the product.
      gapStatus: 'credited',
    });
    // And it is not an overapplication: $105 of cash plus $100 of credit is the
    // invoice, exactly.
    expect(report.anomalies.filter((a) => a.invoiceExternalId === '71')).toEqual([]);
  });
});

describe('pairing a credit-memo line to the invoice line it funded', () => {
  it('splits one invoice line between the cash and the credit that settled it', () => {
    // $500 of cash and a $100 credit against one $600 invoice line. With one
    // invoice line the split is arithmetic, not a choice.
    const payment = toLedgerPayment(
      paymentRow('900', 500, [
        { amount: 600, links: [['Invoice', '71']] },
        { amount: 100, links: [['CreditMemo', '73']] },
      ]),
      'Payment[0]',
    );
    expect(payment.appliedTo).toEqual([{ invoiceExternalId: '71', amountCents: 50_000 }]);

    const applications = resolveCreditApplications(
      [paymentRow('900', 500, [
        { amount: 600, links: [['Invoice', '71']] },
        { amount: 100, links: [['CreditMemo', '73']] },
      ])],
      () => 'Payment[0]',
    );
    expect(applications.get('73')).toEqual([{ invoiceExternalId: '71', amountCents: 10_000 }]);
  });

  it('matches a credit line to the one invoice line of its amount when there are several', () => {
    const row = paymentRow('901', 500, [
      { amount: 500, links: [['Invoice', '71']] },
      { amount: 100, links: [['Invoice', '67']] },
      { amount: 100, links: [['CreditMemo', '73']] },
    ]);
    expect(toLedgerPayment(row, 'Payment[0]').appliedTo).toEqual([
      { invoiceExternalId: '71', amountCents: 50_000 },
    ]);
    expect(resolveCreditApplications([row], () => 'Payment[0]').get('73')).toEqual([
      { invoiceExternalId: '67', amountCents: 10_000 },
    ]);
  });

  it('refuses to guess which of two equal invoice lines a credit settled', () => {
    const row = paymentRow('902', 100, [
      { amount: 100, links: [['Invoice', '71']] },
      { amount: 100, links: [['Invoice', '67']] },
      { amount: 100, links: [['CreditMemo', '73']] },
    ]);
    expect(() => toLedgerPayment(row, 'Payment[0]')).toThrow(QboMalformedResponse);
    expect(() => toLedgerPayment(row, 'Payment[0]')).toThrow(
      /which invoice the credit settled cannot be said/,
    );
  });

  it('refuses a credit line that matches no invoice line on this payment', () => {
    const row = paymentRow('903', 500, [
      { amount: 500, links: [['Invoice', '71']] },
      { amount: 300, links: [['Invoice', '67']] },
      { amount: 100, links: [['CreditMemo', '73']] },
    ]);
    // $100 of credit against a $500 and a $300 line: apportioning it is the
    // guess this package refuses on a money field.
    expect(() => toLedgerPayment(row, 'Payment[0]')).toThrow(QboMalformedResponse);
  });

  it('refuses more credit than the invoice line it is said to have settled', () => {
    const row = paymentRow('904', 0, [
      { amount: 100, links: [['Invoice', '71']] },
      { amount: 250, links: [['CreditMemo', '73']] },
    ]);
    expect(() => toLedgerPayment(row, 'Payment[0]')).toThrow(
      /how much of it was cash cannot be said/,
    );
  });

  it('refuses a line naming two credit memos, the way it refuses two invoices', () => {
    const twoCredits = paymentRow('905', 0, [
      {
        amount: 100,
        links: [
          ['Invoice', '71'],
          ['CreditMemo', '73'],
          ['CreditMemo', '74'],
        ],
      },
    ]);
    expect(() => toLedgerPayment(twoCredits, 'Payment[0]')).toThrow(
      /links 2 credit memos to a single amount/,
    );

    const twoInvoices = paymentRow('906', 200, [
      {
        amount: 200,
        links: [
          ['Invoice', '71'],
          ['Invoice', '67'],
        ],
      },
    ]);
    expect(() => toLedgerPayment(twoInvoices, 'Payment[0]')).toThrow(
      /links 2 invoices to a single amount/,
    );
  });

  it('refuses cash applications adding to more than the payment carried', () => {
    // No credit memo anywhere, and the lines still exceed `TotalAmt`: a shape
    // we have read wrongly, said out loud rather than published as cash.
    const row = paymentRow('907', 100, [
      { amount: 100, links: [['Invoice', '71']] },
      { amount: 100, links: [['Invoice', '67']] },
    ]);
    expect(() => toLedgerPayment(row, 'Payment[0]')).toThrow(
      /carried \$100\.00 but \$200\.00 of its lines read as cash applied to invoices/,
    );
  });

  it('still reads the old shape: one line naming both the invoice and the credit', () => {
    const row = paymentRow('908', 0, [
      {
        amount: 1270,
        links: [
          ['Invoice', '145'],
          ['CreditMemo', '501'],
        ],
      },
    ]);
    expect(toLedgerPayment(row, 'Payment[0]').appliedTo).toEqual([]);
    expect(resolveCreditApplications([row], () => 'Payment[0]').get('501')).toEqual([
      { invoiceExternalId: '145', amountCents: 127_000 },
    ]);
  });
});
