/**
 * What a ledger sync tallies: the invoices a window's payments and credits name,
 * each against every application the ledger has for it (ADR 0035 §1, §3).
 *
 * A short-pay happens when a payment lands, and a payment lands after its
 * invoice by the terms of trade — so the window is anchored on payment and
 * credit dates, and the invoices are fetched by id whatever their age. This
 * file is the join between those two reads. It is pure, does no arithmetic and
 * reaches no vendor; `detectShortPays` does the arithmetic over what it
 * returns, unchanged.
 *
 * Two rules, and each one prevents a wrong number:
 *
 * - **One copy of each payment and credit.** The in-window activity and the
 *   invoice histories overlap by construction — a payment inside the window is
 *   also in the history of the invoice it pays. Counted twice, every short-pay
 *   reads as an overpayment.
 * - **Applications are trimmed to the invoices that were asked for.** A history
 *   payment that also paid some other invoice is that invoice's business; left
 *   in, it raises an `application_to_unknown_invoice` about an invoice nobody
 *   asked about. Every in-window application names a requested invoice by
 *   construction, so the trim never touches one — an in-window payment applied
 *   to an invoice the ledger did not return is still reported as an anomaly.
 */

import type {
  LedgerApplication,
  LedgerCredit,
  LedgerInvoice,
  LedgerInvoiceHistories,
  LedgerPayment,
} from './ledger';

/** The payments and credits dated inside a window: what changed in it. */
export interface LedgerActivity {
  readonly payments: readonly LedgerPayment[];
  readonly credits: readonly LedgerCredit[];
}

/** What `detectShortPays` is given: the three lists it has always taken. */
export interface SettlementLedger {
  readonly invoices: readonly LedgerInvoice[];
  readonly payments: readonly LedgerPayment[];
  readonly credits: readonly LedgerCredit[];
}

/**
 * Every invoice the window's activity names, deduplicated and sorted, so the
 * same activity always asks the ledger the same question.
 */
export function invoicesNamedBy(activity: LedgerActivity): readonly string[] {
  const ids = new Set<string>();
  for (const row of [...activity.payments, ...activity.credits]) {
    for (const application of row.appliedTo) {
      if (application.invoiceExternalId.trim() !== '') ids.add(application.invoiceExternalId);
    }
  }
  return [...ids].sort();
}

/**
 * The window's activity and the requested invoices' histories, as one ledger to
 * tally.
 *
 * Invoices are the histories' invoices that were requested, first copy of each
 * id. Payments and credits are the histories' first, then any in-window row not
 * already present — the history's copy is preferred because it was assembled
 * for exactly these invoices — each with its applications trimmed to the
 * requested set. Order is the histories' order, then the activity's, which
 * `detectShortPays` then sorts into a total order of its own.
 */
export function settlementLedger(
  activity: LedgerActivity,
  histories: LedgerInvoiceHistories,
): SettlementLedger {
  const requested = new Set(invoicesNamedBy(activity));

  const invoices: LedgerInvoice[] = [];
  const seenInvoices = new Set<string>();
  for (const invoice of histories.invoices) {
    if (!requested.has(invoice.externalId) || seenInvoices.has(invoice.externalId)) continue;
    seenInvoices.add(invoice.externalId);
    invoices.push(invoice);
  }

  return {
    invoices,
    payments: mergeTrimmed(histories.payments, activity.payments, requested),
    credits: mergeTrimmed(histories.credits, activity.credits, requested),
  };
}

function mergeTrimmed<T extends { readonly externalId: string; readonly appliedTo: readonly LedgerApplication[] }>(
  preferred: readonly T[],
  rest: readonly T[],
  requested: ReadonlySet<string>,
): readonly T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of [...preferred, ...rest]) {
    if (seen.has(row.externalId)) continue;
    seen.add(row.externalId);
    const appliedTo = row.appliedTo.filter((a) => requested.has(a.invoiceExternalId));
    out.push(appliedTo.length === row.appliedTo.length ? row : { ...row, appliedTo });
  }
  return out;
}
