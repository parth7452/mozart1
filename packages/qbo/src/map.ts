/**
 * QBO shapes into the port's types, and nothing leaves here that still knows
 * the word "QuickBooks" (ADR 0026).
 *
 * `CustomerRef.value`, `DocNumber`, `LinkedTxn` and `TxnDate` stop at this file.
 * What goes upward is `LedgerInvoice`, `LedgerPayment`, `LedgerCredit` and
 * `LedgerApplication`, each stamped `sourceKind: 'qbo'` so a later NetSuite or
 * Xero adapter is additive and identity resolution can tell the sources apart
 * (STRATEGY §5.2).
 */

import type {
  LedgerApplication,
  LedgerCredit,
  LedgerInvoice,
  LedgerPayment,
} from '@recouple/adapters';
import { QboMalformedResponse } from './errors';
import { qboAmountToCents } from './money';
import {
  readArray,
  readIsoDate,
  readObject,
  readOptionalIsoDate,
  readOptionalString,
  readRef,
  readString,
  type JsonObject,
} from './reader';

const SOURCE_KIND = 'qbo' as const;

export function toLedgerInvoice(row: JsonObject, path: string): LedgerInvoice {
  const customer = readRef(row, 'CustomerRef', path);
  const currency = readRef(row, 'CurrencyRef', path);
  const dueOn = readOptionalIsoDate(row, 'DueDate', path);

  return {
    sourceKind: SOURCE_KIND,
    externalId: readString(row, 'Id', path),
    // The port requires a number the customer can see. QBO omits `DocNumber`
    // only when a company turned custom transaction numbers on and left it
    // blank; an invoice with `invoiceNumber: ''` would reconcile against
    // nothing and nobody would notice for a quarter, so this fails loudly
    // instead of inventing one.
    invoiceNumber: readString(row, 'DocNumber', path),
    customerExternalId: readString(customer, 'value', `${path}.CustomerRef`),
    customerName: readString(customer, 'name', `${path}.CustomerRef`),
    issuedOn: readIsoDate(row, 'TxnDate', path),
    ...(dueOn !== undefined ? { dueOn } : {}),
    totalCents: qboAmountToCents(row['TotalAmt'], `${path}.TotalAmt`),
    balanceCents: qboAmountToCents(row['Balance'], `${path}.Balance`),
    currency: readString(currency, 'value', `${path}.CurrencyRef`),
  };
}

export function toLedgerPayment(row: JsonObject, path: string): LedgerPayment {
  const customer = readRef(row, 'CustomerRef', path);
  const reference = readOptionalString(row, 'PaymentRefNum', path);
  const memo = readOptionalString(row, 'PrivateNote', path);

  const appliedTo: LedgerApplication[] = [];
  for (const line of readPaymentLines(row, path)) {
    // A line that names a credit memo is a *credit* being applied, not cash.
    // QBO records "apply this credit memo to that invoice" as a zero-dollar
    // Payment whose line links both — so counting its invoice link here would
    // report the credit as money received. It belongs to the credit memo, and
    // `resolveCreditApplications` below is what picks it up.
    if (line.creditMemoIds.length > 0) continue;
    for (const invoiceExternalId of line.invoiceIds) {
      appliedTo.push({ invoiceExternalId, amountCents: line.amountCents });
    }
  }

  return {
    sourceKind: SOURCE_KIND,
    externalId: readString(row, 'Id', path),
    customerExternalId: readString(customer, 'value', `${path}.CustomerRef`),
    receivedOn: readIsoDate(row, 'TxnDate', path),
    totalCents: qboAmountToCents(row['TotalAmt'], `${path}.TotalAmt`),
    ...(reference !== undefined ? { reference } : {}),
    ...(memo !== undefined ? { memo } : {}),
    appliedTo,
  };
}

export function toLedgerCredit(
  row: JsonObject,
  path: string,
  applications: ReadonlyMap<string, readonly LedgerApplication[]>,
): LedgerCredit {
  const customer = readRef(row, 'CustomerRef', path);
  const memo = readOptionalString(row, 'PrivateNote', path);
  const externalId = readString(row, 'Id', path);

  return {
    sourceKind: SOURCE_KIND,
    externalId,
    customerExternalId: readString(customer, 'value', `${path}.CustomerRef`),
    issuedOn: readIsoDate(row, 'TxnDate', path),
    totalCents: qboAmountToCents(row['TotalAmt'], `${path}.TotalAmt`),
    ...(memo !== undefined ? { memo } : {}),
    // Absent from the map means "no payment in this window applied this credit
    // to an invoice", which is an honest `[]` — not a guess that it went
    // somewhere.
    appliedTo: applications.get(externalId) ?? [],
  };
}

/**
 * Which invoices each credit memo was applied to, read off the Payments.
 *
 * QuickBooks does not record a credit memo's application on the `CreditMemo`.
 * Applying a credit to an invoice creates a **Payment** — usually for
 * `TotalAmt: 0` — with one line that links both transactions: `LinkedTxn`
 * entries of type `CreditMemo` and of type `Invoice`. So the credit's
 * `appliedTo` is reconstructed from those lines, which is why `listCredits`
 * queries Payments over the same window as well.
 *
 * A credit applied by a payment dated outside the window cannot be resolved
 * from this data and gets no entry at all.
 */
export function resolveCreditApplications(
  paymentRows: readonly JsonObject[],
  pathFor: (index: number) => string,
): ReadonlyMap<string, readonly LedgerApplication[]> {
  const byCredit = new Map<string, LedgerApplication[]>();

  paymentRows.forEach((row, index) => {
    for (const line of readPaymentLines(row, pathFor(index))) {
      if (line.creditMemoIds.length === 0 || line.invoiceIds.length === 0) continue;
      for (const creditMemoId of line.creditMemoIds) {
        const applications = byCredit.get(creditMemoId) ?? [];
        for (const invoiceExternalId of line.invoiceIds) {
          applications.push({ invoiceExternalId, amountCents: line.amountCents });
        }
        byCredit.set(creditMemoId, applications);
      }
    }
  });

  return byCredit;
}

/**
 * The ids of every transaction of one type an invoice's own `LinkedTxn` names.
 *
 * For `'Payment'` that is every payment applied to the invoice — including the
 * zero-dollar payment that applies a credit memo to it — which is how
 * `getInvoiceHistories` finds an invoice's whole history rather than the part
 * of it that fell in a window (ADR 0035 §2).
 */
export function linkedTxnIds(row: JsonObject, txnType: string, path: string): readonly string[] {
  const ids: string[] = [];
  readArray(row['LinkedTxn'], `${path}.LinkedTxn`).forEach((rawLink, index) => {
    const linkPath = `${path}.LinkedTxn[${index}]`;
    const link = readObject(rawLink, linkPath);
    if (readString(link, 'TxnType', linkPath) === txnType) {
      ids.push(readString(link, 'TxnId', linkPath));
    }
  });
  return ids;
}

interface PaymentLine {
  readonly amountCents: LedgerApplication['amountCents'];
  readonly invoiceIds: readonly string[];
  readonly creditMemoIds: readonly string[];
}

/**
 * One pass over a Payment's lines, so `toLedgerPayment` and
 * `resolveCreditApplications` read the same structure the same way.
 */
function readPaymentLines(row: JsonObject, path: string): readonly PaymentLine[] {
  return readArray(row['Line'], `${path}.Line`).map((rawLine, index) => {
    const linePath = `${path}.Line[${index}]`;
    const line = readObject(rawLine, linePath);
    const amountCents = qboAmountToCents(line['Amount'], `${linePath}.Amount`);

    const invoiceIds: string[] = [];
    const creditMemoIds: string[] = [];

    readArray(line['LinkedTxn'], `${linePath}.LinkedTxn`).forEach((rawLink, linkIndex) => {
      const linkPath = `${linePath}.LinkedTxn[${linkIndex}]`;
      const link = readObject(rawLink, linkPath);
      const txnType = readString(link, 'TxnType', linkPath);
      if (txnType === 'Invoice') invoiceIds.push(readString(link, 'TxnId', linkPath));
      if (txnType === 'CreditMemo') creditMemoIds.push(readString(link, 'TxnId', linkPath));
      // Deposits, journal entries and the rest are neither, and are ignored.
    });

    // A line carries one `Amount`. Two invoices on one line would leave no way
    // to say how that amount split between them, and splitting it evenly would
    // be exactly the guess this package refuses to make on a money field.
    if (invoiceIds.length > 1) {
      throw new QboMalformedResponse(
        `payment line at ${linePath} links ${invoiceIds.length} invoices to a single amount, ` +
          `so the application cannot be attributed`,
        `${linePath}.LinkedTxn`,
      );
    }

    return { amountCents, invoiceIds, creditMemoIds };
  });
}
