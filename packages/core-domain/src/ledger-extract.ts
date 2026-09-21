/**
 * A short-paid invoice, rendered as a document (ADR 0028 §1).
 *
 * Every other deduction enters this system as a document, and a great deal
 * rests on that: provenance is derived from the `uploads` row the bytes name
 * (ADR 0024), `declineCase` refuses a case whose notice records no arrival, and
 * the post-audit defence is that every number on a packet traces to something
 * stored. A deduction the ledger found has no page behind it, so this module
 * makes one: a canonical JSON extract of the candidate and the ledger rows that
 * produced it, stored through `recordUpload('erp_sync') → putDocument →
 * linkDocument('notice')` exactly as an email attachment is.
 *
 * It is pure. No clock, no randomness, no I/O — which is what makes the
 * property this file exists for true:
 *
 * **The same ledger state produces byte-identical bytes.** Keys are written in
 * one fixed order, arrays are sorted by the ledger's own external ids, money is
 * integer cents and nothing anywhere records "now". So the second sync of an
 * unchanged invoice hashes to the document we already hold, `findDocumentByHash`
 * recognises it, and a re-sync costs nothing and keeps the first arrival's
 * provenance. A ledger that genuinely changed produces different bytes and a
 * new document, which is right: it is a different statement about the invoice.
 *
 * The content is **untrusted** (invariant 4). Customer names, memos and
 * references are a third party's strings, copied verbatim and never cleaned up;
 * our code did the arithmetic (`detectShortPays`) and no model reads any of
 * this.
 */

import { createHash } from 'node:crypto';
import type { LedgerCredit, LedgerInvoice, LedgerPayment } from './ledger';
import { cents } from './money';
import type { Cents } from './money';
import type { ShortPayCandidate } from './short-pay';

export class LedgerExtractError extends Error {}

/** What the sync hands the store: bytes, and what they are. */
export interface LedgerExtract {
  readonly bytes: Uint8Array;
  readonly mimeType: 'application/json';
  readonly filename: string;
  readonly sha256: string;
}

/**
 * The extract's shape, written out as a type so the key order below is checked
 * rather than remembered. It is a wire format: every field is a string, a
 * number that is integer cents, or an array of these.
 */
interface ExtractBody {
  readonly kind: 'ledger_short_pay_extract';
  readonly version: 1;
  readonly candidate: {
    readonly appliedCreditsCents: number;
    readonly appliedPaymentsCents: number;
    readonly creditMemos: readonly string[];
    readonly customerExternalId: string;
    readonly customerName: string;
    readonly gapCents: number;
    readonly gapStatus: ShortPayCandidate['gapStatus'];
    readonly invoiceExternalId: string;
    readonly invoiceNumber: string;
    readonly invoiceTotalCents: number;
    readonly lastPaymentOn: string | null;
    readonly paymentMemos: readonly string[];
    readonly paymentReferences: readonly string[];
  };
  readonly invoice: {
    readonly balanceCents: number;
    readonly currency: string;
    readonly customerExternalId: string;
    readonly customerName: string;
    readonly dueOn: string | null;
    readonly externalId: string;
    readonly invoiceNumber: string;
    readonly issuedOn: string;
    readonly sourceKind: string;
    readonly totalCents: number;
  };
  readonly payments: readonly {
    readonly appliedCents: number;
    readonly externalId: string;
    readonly memo: string | null;
    readonly receivedOn: string;
    readonly reference: string | null;
    readonly totalCents: number;
  }[];
  readonly credits: readonly {
    readonly appliedCents: number;
    readonly externalId: string;
    readonly issuedOn: string;
    readonly memo: string | null;
    readonly totalCents: number;
  }[];
}

/**
 * A filename safe to put in a column and recognisable in a list.
 *
 * The invoice number is a third party's string, so it is reduced to the
 * characters a filename may hold rather than trusted — and it is reduced, never
 * truncated to a prefix that would read like a different invoice: anything
 * outside `[A-Za-z0-9._-]` becomes `-`. The invoice's external id is what
 * actually identifies the document; this is for a human reading a row.
 */
function extractFilename(candidate: ShortPayCandidate): string {
  const safe = candidate.invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `ledger-extract-${safe === '' ? 'invoice' : safe}.json`;
}

/** Integer cents or a loud refusal — never a float smuggled into a document. */
function exact(value: Cents | number, field: string): number {
  try {
    return cents(value);
  } catch (error) {
    throw new LedgerExtractError(
      `${field} is not integer cents: ${String(value)} (${(error as Error).message})`,
    );
  }
}

/** What one payment or credit put against *this* invoice, in integer cents. */
function appliedTo(
  applications: readonly { readonly invoiceExternalId: string; readonly amountCents: Cents }[],
  invoiceExternalId: string,
  field: string,
): number {
  let total = 0;
  for (const application of applications) {
    if (application.invoiceExternalId !== invoiceExternalId) continue;
    total += exact(application.amountCents, field);
  }
  return exact(total, field);
}

/** `undefined` and `''` are both absence; absence is stated, never omitted. */
function orNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value === '' ? null : value;
}

/**
 * The candidate and the rows behind it, as bytes.
 *
 * Only the payments and credits that were actually applied to this invoice are
 * included, sorted by their external id — an arbitrary order but a *fixed* one,
 * which is the property that matters. `invoice` must be the candidate's own
 * invoice; a mismatch is a caller bug and is refused rather than serialised
 * into a document that says two different things about which invoice it is.
 */
export function buildLedgerExtract(
  candidate: ShortPayCandidate,
  invoice: LedgerInvoice,
  payments: readonly LedgerPayment[],
  credits: readonly LedgerCredit[],
): LedgerExtract {
  if (invoice.externalId !== candidate.invoiceExternalId) {
    throw new LedgerExtractError(
      `invoice ${invoice.externalId} is not candidate invoice ${candidate.invoiceExternalId}`,
    );
  }

  const invoiceId = candidate.invoiceExternalId;

  const appliedPayments = payments
    .filter((payment) => payment.appliedTo.some((a) => a.invoiceExternalId === invoiceId))
    .map((payment) => ({
      appliedCents: appliedTo(payment.appliedTo, invoiceId, `payment ${payment.externalId}`),
      externalId: payment.externalId,
      memo: orNull(payment.memo),
      receivedOn: payment.receivedOn,
      reference: orNull(payment.reference),
      totalCents: exact(payment.totalCents, `payment ${payment.externalId} total`),
    }))
    .sort((a, b) => (a.externalId === b.externalId ? 0 : a.externalId < b.externalId ? -1 : 1));

  const appliedCredits = credits
    .filter((credit) => credit.appliedTo.some((a) => a.invoiceExternalId === invoiceId))
    .map((credit) => ({
      appliedCents: appliedTo(credit.appliedTo, invoiceId, `credit ${credit.externalId}`),
      externalId: credit.externalId,
      issuedOn: credit.issuedOn,
      memo: orNull(credit.memo),
      totalCents: exact(credit.totalCents, `credit ${credit.externalId} total`),
    }))
    .sort((a, b) => (a.externalId === b.externalId ? 0 : a.externalId < b.externalId ? -1 : 1));

  const body: ExtractBody = {
    kind: 'ledger_short_pay_extract',
    version: 1,
    candidate: {
      appliedCreditsCents: exact(candidate.appliedCreditsCents, 'appliedCreditsCents'),
      appliedPaymentsCents: exact(candidate.appliedPaymentsCents, 'appliedPaymentsCents'),
      creditMemos: [...candidate.creditMemos],
      customerExternalId: candidate.customerExternalId,
      customerName: candidate.customerName,
      gapCents: exact(candidate.gapCents, 'gapCents'),
      gapStatus: candidate.gapStatus,
      invoiceExternalId: candidate.invoiceExternalId,
      invoiceNumber: candidate.invoiceNumber,
      invoiceTotalCents: exact(candidate.invoiceTotalCents, 'invoiceTotalCents'),
      lastPaymentOn: candidate.lastPaymentOn ?? null,
      // Verbatim and in the order `detectShortPays` saw them: these are the only
      // words a remittance gives us about *why* the money is missing, and a
      // reviewer needs them unedited.
      paymentMemos: [...candidate.paymentMemos],
      paymentReferences: [...candidate.paymentReferences],
    },
    invoice: {
      balanceCents: exact(invoice.balanceCents, 'invoice balanceCents'),
      currency: invoice.currency,
      customerExternalId: invoice.customerExternalId,
      customerName: invoice.customerName,
      dueOn: invoice.dueOn ?? null,
      externalId: invoice.externalId,
      invoiceNumber: invoice.invoiceNumber,
      issuedOn: invoice.issuedOn,
      sourceKind: invoice.sourceKind,
      totalCents: exact(invoice.totalCents, 'invoice totalCents'),
    },
    payments: appliedPayments,
    credits: appliedCredits,
  };

  // Two spaces, because a reviewer opens this file. `JSON.stringify` over a
  // literal written in one place, in one order, is canonical for the same
  // reason `packetContentHash` says it is.
  const text = JSON.stringify(body, null, 2);
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    mimeType: 'application/json',
    filename: extractFilename(candidate),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
