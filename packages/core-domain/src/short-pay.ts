/**
 * Short-pay detection over a customer's own ledger (STRATEGY §5.1, §5.4 —
 * Phase 1.5 "ERP read"; §6.3 is what consumes the output).
 *
 * A deduction can only reach this system today if the customer already knew
 * about it and sent it to us. The ledger is where the rest of them are: an
 * invoice for $100,000 against which $92,000 arrived is $8,000 of deduction
 * nobody has surfaced yet. This function is the arithmetic that finds those,
 * and nothing more — it is pure, deterministic, does no I/O and reaches no
 * vendor. The rows come in through `AccountingSource`; what happens to a
 * candidate afterwards (triage, identity resolution, opening a case) is not
 * its business.
 *
 * Three rules it keeps, because it sits on a money path:
 *
 * - Every number is integer cents through `money.ts` (invariant 3). There is no
 *   float arithmetic anywhere in this file.
 * - It never throws on bad ledger data and never quietly repairs it. Anything
 *   that does not add up comes back as a `LedgerAnomaly` beside the candidates,
 *   and the rest of the ledger is still examined (CLAUDE.md: fail loud).
 * - It refuses to guess. An invoice whose arithmetic is untrustworthy — a
 *   negative application, a negative total — produces an anomaly and *no*
 *   candidate, rather than a dollar figure somebody might go and dispute.
 *
 * One limit worth naming: `LedgerApplication` carries no currency of its own,
 * so a payment in one currency applied to an invoice in another is invisible
 * here. `currency_mismatch` is raised per invoice against the rest of the
 * window, which is the most this port's shape allows.
 *
 * The ledger row types are imported from `@recouple/adapters`, where the port
 * declares them, and that makes the two packages cyclic at the *type* level —
 * pnpm says so on install. It is deliberate and it is type-only:
 * `verbatimModuleSyntax` erases an `import type` entirely, so nothing is
 * required at runtime and no cycle exists in the built graph. The alternative
 * was a second copy of `LedgerInvoice` living here, free to drift from the one
 * the QBO adapter fills in — which on a money path is the worse of the two.
 */

import type { LedgerCredit, LedgerInvoice, LedgerPayment } from '@recouple/adapters';
import { ZERO, addCents, formatCents, subCents } from './money';
import type { Cents } from './money';

export interface ShortPayCandidate {
  readonly invoiceExternalId: string;
  readonly invoiceNumber: string;
  readonly customerExternalId: string;
  readonly customerName: string;
  readonly invoiceTotalCents: Cents;
  readonly appliedPaymentsCents: Cents;   // sum of payment applications to this invoice
  readonly appliedCreditsCents: Cents;    // sum of credit applications to this invoice
  readonly gapCents: Cents;               // total − payments − credits, always > 0 here
  /** 'open' = the gap is still on the invoice's balance; 'credited' = the ledger already wrote it off with a credit. */
  readonly gapStatus: 'open' | 'credited' | 'mixed';
  readonly paymentReferences: readonly string[];  // every non-empty payment.reference, verbatim, deduped
  readonly paymentMemos: readonly string[];       // every non-empty payment.memo, verbatim, deduped
  readonly creditMemos: readonly string[];
  readonly lastPaymentOn?: string;
}

export interface LedgerAnomaly {
  readonly invoiceExternalId: string;
  readonly kind: 'overapplied' | 'application_to_unknown_invoice' | 'negative_amount' | 'currency_mismatch';
  readonly detail: string;
}

export interface ShortPayReport {
  readonly candidates: readonly ShortPayCandidate[];
  readonly anomalies: readonly LedgerAnomaly[];
  readonly invoicesExamined: number;
}

/**
 * What every document that touched one invoice added up to, and which documents
 * they were. Kept per invoice so a candidate can carry the payment references
 * and memos verbatim — those are the only words a remittance gives us about
 * *why* the money is missing, and a reviewer needs them unedited.
 */
interface InvoiceTally {
  paymentsCents: Cents;
  creditsCents: Cents;
  readonly payments: LedgerPayment[];
  readonly credits: LedgerCredit[];
  /** A negative application reached this invoice: its sums mean nothing now. */
  untrustworthy: boolean;
}

function emptyTally(): InvoiceTally {
  return {
    paymentsCents: ZERO,
    creditsCents: ZERO,
    payments: [],
    credits: [],
    untrustworthy: false,
  };
}

/**
 * The currency the rest of the window is in, so "differs from the others" has
 * an "others" to mean. The most frequent one wins; ties break on the
 * alphabetically first code, which makes the answer independent of the order
 * the ledger happened to return its rows in.
 */
function dominantCurrency(invoices: readonly LedgerInvoice[]): string | undefined {
  const counts = new Map<string, number>();
  for (const invoice of invoices) {
    counts.set(invoice.currency, (counts.get(invoice.currency) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && currency < best)) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

/** Verbatim, in first-seen order, with the blanks and the repeats taken out. */
function dedupeNonEmpty(values: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === undefined || value.trim() === '') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Finds the invoices a customer paid short.
 *
 * A candidate is an invoice that was *paid* — something was applied to it — and
 * still came up short once every payment and credit against it is counted. An
 * invoice nobody has paid at all is unpaid, not short-paid, and is not a
 * deduction; it is excluded on purpose, because dunning AR is a different
 * product.
 *
 * `gapStatus` says where the missing money went, which is the difference
 * between a fight worth having and one already lost:
 *
 * - `'open'` — the gap is still sitting on the invoice's balance. The customer
 *   has not settled it; nobody has written anything off yet.
 * - `'credited'` — the ledger shows the invoice closed (`balanceCents` is zero)
 *   even though the arithmetic says money is missing. Somebody inside the
 *   business already wrote the difference off without disputing it, which is
 *   exactly the money this product exists to go and get back.
 * - `'mixed'` — the balance is neither the whole gap nor zero: part written
 *   off, part still open.
 *
 * Candidates come back sorted by `gapCents` descending, then `invoiceNumber`
 * ascending, then `externalId` ascending — a total order, so the same ledger
 * always produces the same report.
 *
 * `externalId` is the ledger's own key for an invoice, so it is taken to be
 * unique: if two rows carry the same one, the first is the invoice and the rest
 * are ignored for candidacy. `invoicesExamined` counts the rows that came in.
 */
export function detectShortPays(
  invoices: readonly LedgerInvoice[],
  payments: readonly LedgerPayment[],
  credits: readonly LedgerCredit[],
): ShortPayReport {
  const anomalies: LedgerAnomaly[] = [];

  const byExternalId = new Map<string, LedgerInvoice>();
  for (const invoice of invoices) {
    if (!byExternalId.has(invoice.externalId)) byExternalId.set(invoice.externalId, invoice);
  }
  const ledger = [...byExternalId.values()];

  // Pass 1: what the invoices themselves say.
  const currency = dominantCurrency(ledger);
  for (const invoice of ledger) {
    if (invoice.totalCents < 0) {
      anomalies.push({
        invoiceExternalId: invoice.externalId,
        kind: 'negative_amount',
        detail: `invoice ${invoice.invoiceNumber} has a negative total of ${formatCents(invoice.totalCents)}`,
      });
    }
    if (invoice.balanceCents < 0) {
      anomalies.push({
        invoiceExternalId: invoice.externalId,
        kind: 'negative_amount',
        detail: `invoice ${invoice.invoiceNumber} has a negative balance of ${formatCents(invoice.balanceCents)}`,
      });
    }
    if (currency !== undefined && invoice.currency !== currency) {
      anomalies.push({
        invoiceExternalId: invoice.externalId,
        kind: 'currency_mismatch',
        detail: `invoice ${invoice.invoiceNumber} is in ${invoice.currency}; the rest of this window is in ${currency}`,
      });
    }
  }

  // Pass 2: what was applied to them. Payments first, then credits, so the
  // anomaly list reads in a fixed order for a given ledger.
  const tallies = new Map<string, InvoiceTally>();
  const tallyFor = (externalId: string): InvoiceTally => {
    const existing = tallies.get(externalId);
    if (existing !== undefined) return existing;
    const fresh = emptyTally();
    tallies.set(externalId, fresh);
    return fresh;
  };

  for (const payment of payments) {
    for (const application of payment.appliedTo) {
      const id = application.invoiceExternalId;
      const invoice = byExternalId.get(id);
      if (application.amountCents < 0) {
        anomalies.push({
          invoiceExternalId: id,
          kind: 'negative_amount',
          detail: `payment ${payment.externalId} applies ${formatCents(application.amountCents)} to invoice ${id}`,
        });
      }
      if (invoice === undefined) {
        anomalies.push({
          invoiceExternalId: id,
          kind: 'application_to_unknown_invoice',
          detail: `payment ${payment.externalId} applies ${formatCents(application.amountCents)} to invoice ${id}, which is not in this window`,
        });
        continue;
      }
      const tally = tallyFor(id);
      if (application.amountCents < 0) tally.untrustworthy = true;
      tally.paymentsCents = addCents(tally.paymentsCents, application.amountCents);
      // One payment may split across several lines of the same invoice; it is
      // still one payment, and its reference should appear once.
      if (tally.payments[tally.payments.length - 1] !== payment) tally.payments.push(payment);
    }
  }

  for (const credit of credits) {
    for (const application of credit.appliedTo) {
      const id = application.invoiceExternalId;
      const invoice = byExternalId.get(id);
      if (application.amountCents < 0) {
        anomalies.push({
          invoiceExternalId: id,
          kind: 'negative_amount',
          detail: `credit ${credit.externalId} applies ${formatCents(application.amountCents)} to invoice ${id}`,
        });
      }
      if (invoice === undefined) {
        anomalies.push({
          invoiceExternalId: id,
          kind: 'application_to_unknown_invoice',
          detail: `credit ${credit.externalId} applies ${formatCents(application.amountCents)} to invoice ${id}, which is not in this window`,
        });
        continue;
      }
      const tally = tallyFor(id);
      if (application.amountCents < 0) tally.untrustworthy = true;
      tally.creditsCents = addCents(tally.creditsCents, application.amountCents);
      if (tally.credits[tally.credits.length - 1] !== credit) tally.credits.push(credit);
    }
  }

  // Pass 3: the gap.
  const candidates: ShortPayCandidate[] = [];
  for (const invoice of ledger) {
    const tally = tallies.get(invoice.externalId) ?? emptyTally();

    // Already reported as untrustworthy above. Refuse to put a number on it
    // rather than publish one somebody might dispute.
    if (tally.untrustworthy || invoice.totalCents < 0) continue;

    const applied = addCents(tally.paymentsCents, tally.creditsCents);
    if (applied > invoice.totalCents) {
      anomalies.push({
        invoiceExternalId: invoice.externalId,
        kind: 'overapplied',
        detail: `invoice ${invoice.invoiceNumber} totals ${formatCents(invoice.totalCents)} but ${formatCents(applied)} is applied to it`,
      });
      continue;
    }

    // Nothing was paid: unpaid, not short-paid.
    if (tally.paymentsCents <= 0) continue;

    const gapCents = subCents(invoice.totalCents, applied);
    if (gapCents <= 0) continue;

    const gapStatus: ShortPayCandidate['gapStatus'] =
      invoice.balanceCents === gapCents ? 'open' : invoice.balanceCents === 0 ? 'credited' : 'mixed';

    let lastPaymentOn: string | undefined;
    for (const payment of tally.payments) {
      if (lastPaymentOn === undefined || payment.receivedOn > lastPaymentOn) {
        lastPaymentOn = payment.receivedOn;
      }
    }

    candidates.push({
      invoiceExternalId: invoice.externalId,
      invoiceNumber: invoice.invoiceNumber,
      customerExternalId: invoice.customerExternalId,
      customerName: invoice.customerName,
      invoiceTotalCents: invoice.totalCents,
      appliedPaymentsCents: tally.paymentsCents,
      appliedCreditsCents: tally.creditsCents,
      gapCents,
      gapStatus,
      paymentReferences: dedupeNonEmpty(tally.payments.map((p) => p.reference)),
      paymentMemos: dedupeNonEmpty(tally.payments.map((p) => p.memo)),
      creditMemos: dedupeNonEmpty(tally.credits.map((c) => c.memo)),
      ...(lastPaymentOn === undefined ? {} : { lastPaymentOn }),
    });
  }

  candidates.sort((a, b) => {
    if (a.gapCents !== b.gapCents) return b.gapCents - a.gapCents;
    if (a.invoiceNumber !== b.invoiceNumber) return a.invoiceNumber < b.invoiceNumber ? -1 : 1;
    if (a.invoiceExternalId === b.invoiceExternalId) return 0;
    return a.invoiceExternalId < b.invoiceExternalId ? -1 : 1;
  });

  return { candidates, anomalies, invoicesExamined: invoices.length };
}
