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
import { formatCents, subCents, sumCents, type Cents } from '@recouple/core-domain';
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

/**
 * A Payment, with only the cash on it counted as cash (ADR 0036).
 *
 * `appliedTo` is what this payment *paid*, which is not the same as what its
 * lines point at: QuickBooks settles an invoice with a credit memo by writing
 * an invoice line beside a credit-memo line on the same Payment, and counting
 * that invoice line here would report a write-off as money received.
 * `readPaymentApplications` is what separates the two.
 */
export function toLedgerPayment(row: JsonObject, path: string): LedgerPayment {
  const customer = readRef(row, 'CustomerRef', path);
  const reference = readOptionalString(row, 'PaymentRefNum', path);
  const memo = readOptionalString(row, 'PrivateNote', path);
  const { totalCents, cash } = readPaymentApplications(row, path);

  return {
    sourceKind: SOURCE_KIND,
    externalId: readString(row, 'Id', path),
    customerExternalId: readString(customer, 'value', `${path}.CustomerRef`),
    receivedOn: readIsoDate(row, 'TxnDate', path),
    totalCents,
    ...(reference !== undefined ? { reference } : {}),
    ...(memo !== undefined ? { memo } : {}),
    appliedTo: cash,
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
 * `TotalAmt: 0` — that links both transactions, in one of the two line shapes
 * `readPaymentApplications` reads. So the credit's `appliedTo` is reconstructed
 * from those lines, which is why `listCredits` queries Payments over the same
 * window as well.
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
    for (const [creditMemoId, applied] of readPaymentApplications(row, pathFor(index)).credits) {
      const applications = byCredit.get(creditMemoId) ?? [];
      applications.push(...applied);
      byCredit.set(creditMemoId, applications);
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
  /** Where in the response it is, so a refusal names the line it refused. */
  readonly path: string;
  readonly amountCents: Cents;
  /** At most one of each: a line linking two of either is refused below. */
  readonly invoiceId: string | undefined;
  readonly creditMemoId: string | undefined;
}

/** A Payment split into the cash it carried and the credits it applied. */
interface PaymentApplications {
  readonly totalCents: Cents;
  readonly cash: readonly LedgerApplication[];
  readonly credits: ReadonlyMap<string, readonly LedgerApplication[]>;
}

/**
 * One Payment, read once, into cash applications and credit applications
 * (ADR 0036).
 *
 * **A payment's cash is bounded by what the payment carried.** QuickBooks
 * records "this invoice was settled with a credit memo" on the *Payment*, in
 * either of two line shapes, and the second one is the one that reads as cash
 * if nobody separates it out:
 *
 * - *Both on one line.* One line whose `LinkedTxn` names an Invoice and a
 *   CreditMemo. That line is the credit's application, and never cash.
 * - *A line each.* An invoice line for the amount settled, beside a
 *   credit-memo line for the amount of credit funding it — the shape the
 *   Intuit sandbox recording actually holds (payment 74: `TotalAmt: 0`, a $100
 *   line naming Invoice 71, a $100 line naming CreditMemo 73). Read line by
 *   line, that invoice line is $100 of cash that never arrived, and the credit
 *   memo is applied to nothing.
 *
 * Pairing an invoice line to the credit lines that funded it is done in
 * integer cents and only where the answer is forced, never by apportioning:
 *
 * - No credit-memo line: every invoice line is cash, as before.
 * - One invoice line: the split is arithmetic, not a choice. That invoice
 *   takes each credit line's amount as a credit application, and the cash is
 *   the invoice line less the credit funding it.
 * - Several invoice lines: each credit line must match exactly one unclaimed
 *   invoice line of the same amount. Anything else — no match, two matches, a
 *   credit line with no invoice line at all — is ambiguous, and an ambiguous
 *   money attribution is `QboMalformedResponse`, not a guess.
 *
 * The bound is then asserted rather than assumed: cash applications summing to
 * more than `TotalAmt` means a shape this function has read wrongly, and it
 * says so instead of publishing the number.
 */
function readPaymentApplications(row: JsonObject, path: string): PaymentApplications {
  const totalCents = qboAmountToCents(row['TotalAmt'], `${path}.TotalAmt`);
  const lines = readPaymentLines(row, path);

  const credits = new Map<string, LedgerApplication[]>();
  const applyCredit = (creditMemoId: string, application: LedgerApplication): void => {
    const applications = credits.get(creditMemoId) ?? [];
    applications.push(application);
    credits.set(creditMemoId, applications);
  };

  const invoiceLines: { readonly line: PaymentLine; readonly invoiceId: string }[] = [];
  const creditLines: { readonly line: PaymentLine; readonly creditMemoId: string }[] = [];

  for (const line of lines) {
    const { invoiceId, creditMemoId } = line;
    if (invoiceId !== undefined && creditMemoId !== undefined) {
      // Both on one line: unambiguous on its face.
      applyCredit(creditMemoId, { invoiceExternalId: invoiceId, amountCents: line.amountCents });
      continue;
    }
    if (invoiceId !== undefined) invoiceLines.push({ line, invoiceId });
    else if (creditMemoId !== undefined) creditLines.push({ line, creditMemoId });
    // A line naming neither — a Deposit, a discount — is not an application.
  }

  const cash: LedgerApplication[] = [];
  const [only] = invoiceLines;

  if (creditLines.length === 0) {
    for (const { line, invoiceId } of invoiceLines) {
      cash.push({ invoiceExternalId: invoiceId, amountCents: line.amountCents });
    }
  } else if (only !== undefined && invoiceLines.length === 1) {
    const fundedCents = sumCents(creditLines.map(({ line }) => line.amountCents));
    for (const { line, creditMemoId } of creditLines) {
      applyCredit(creditMemoId, {
        invoiceExternalId: only.invoiceId,
        amountCents: line.amountCents,
      });
    }
    const cashCents = subCents(only.line.amountCents, fundedCents);
    if (cashCents < 0) {
      throw new QboMalformedResponse(
        `payment at ${path} applies ${formatCents(fundedCents)} of credit memos to a line of ` +
          `${formatCents(only.line.amountCents)}, so how much of it was cash cannot be said`,
        `${path}.Line`,
      );
    }
    if (cashCents > 0) {
      cash.push({ invoiceExternalId: only.invoiceId, amountCents: cashCents });
    }
  } else {
    const claimed = new Set<number>();
    for (const { line, creditMemoId } of creditLines) {
      const matches = invoiceLines
        .map((candidate, index) => ({ ...candidate, index }))
        .filter(
          (candidate) =>
            !claimed.has(candidate.index) && candidate.line.amountCents === line.amountCents,
        );
      const [match] = matches;
      if (match === undefined || matches.length > 1) {
        throw new QboMalformedResponse(
          `credit memo line at ${line.path} applies ${formatCents(line.amountCents)}, and ` +
            `${matches.length} of this payment's unclaimed invoice lines are for that amount — ` +
            `so which invoice the credit settled cannot be said`,
          `${line.path}.LinkedTxn`,
        );
      }
      claimed.add(match.index);
      applyCredit(creditMemoId, {
        invoiceExternalId: match.invoiceId,
        amountCents: line.amountCents,
      });
    }
    invoiceLines.forEach(({ line, invoiceId }, index) => {
      if (claimed.has(index)) return;
      cash.push({ invoiceExternalId: invoiceId, amountCents: line.amountCents });
    });
  }

  const cashCents = sumCents(cash.map((application) => application.amountCents));
  if (cashCents > totalCents) {
    throw new QboMalformedResponse(
      `payment at ${path} carried ${formatCents(totalCents)} but ${formatCents(cashCents)} of ` +
        `its lines read as cash applied to invoices`,
      `${path}.Line`,
    );
  }

  return { totalCents, cash, credits };
}

/**
 * One pass over a Payment's lines, each reduced to an amount and at most one
 * invoice and one credit memo.
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
    // be exactly the guess this package refuses to make on a money field. Two
    // credit memos are the same question wearing the other hat: crediting each
    // of them the whole amount doubles the credit.
    refuseTwo('invoices', invoiceIds, linePath);
    refuseTwo('credit memos', creditMemoIds, linePath);

    return {
      path: linePath,
      amountCents,
      invoiceId: invoiceIds[0],
      creditMemoId: creditMemoIds[0],
    };
  });
}

function refuseTwo(what: string, ids: readonly string[], linePath: string): void {
  if (ids.length > 1) {
    throw new QboMalformedResponse(
      `payment line at ${linePath} links ${ids.length} ${what} to a single amount, ` +
        `so the application cannot be attributed`,
      `${linePath}.LinkedTxn`,
    );
  }
}
