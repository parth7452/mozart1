/**
 * What a posting to the accounting system can be said to have done, and which
 * ledger invoice a person meant (ADR 0069).
 *
 * Two questions, both answered here once so the job, the store and the page
 * cannot disagree: did a failed attempt send anything, and does the text a
 * person typed name exactly one invoice the ledger holds. Pure; no clock, no
 * I/O.
 */

/**
 * What a person may state for an invoice: a ledger id or the number printed
 * on the invoice. One line, 21 characters at most (QuickBooks' own bound on a
 * `DocNumber`), and no character that could leave a quoted literal — it is
 * spliced into a query.
 */
export const STATED_INVOICE = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,20}$/;

/** A ledger's internal id for a row: digits, as `assertQboId` reads one. */
export const LEDGER_INVOICE_ID = /^[0-9]{1,20}$/;

export interface LedgerInvoiceRef {
  /** The ledger's internal id. */
  readonly id: string;
  /** The number the ledger prints on it, when it has one. */
  readonly docNumber: string | undefined;
}

/** What the ledger holds for one stated text, read live. */
export interface LedgerInvoiceMatches {
  /** The invoice whose internal id is the text, when the text is an id and one exists. */
  readonly byId: LedgerInvoiceRef | undefined;
  /** Every invoice whose printed number is exactly the text. */
  readonly byDocNumber: readonly LedgerInvoiceRef[];
}

export const INVOICE_REFUSALS = ['invoice_not_found', 'invoice_ambiguous'] as const;
export type InvoiceRefusal = (typeof INVOICE_REFUSALS)[number];

export type InvoiceResolution =
  | { readonly ok: true; readonly invoice: LedgerInvoiceRef }
  | { readonly ok: false; readonly reason: InvoiceRefusal };

/**
 * The one invoice a stated text names, or why it names none.
 *
 * The case's own ledger invoice — an id the ledger sync recorded, never text
 * off a page — is taken by id when the ledger still has it, whatever else
 * happens to print the same digits. Otherwise the text must name exactly one
 * invoice across both readings: an id and another invoice's printed number
 * that collide are two invoices, and which was meant is not ours to guess.
 */
export function resolveStatedInvoice(
  stated: string,
  found: LedgerInvoiceMatches,
  caseLedgerInvoiceId: string | undefined,
): InvoiceResolution {
  if (found.byId !== undefined && found.byId.id !== stated) {
    throw new RangeError('the invoice read by id is not the one asked for');
  }
  if (caseLedgerInvoiceId !== undefined && stated === caseLedgerInvoiceId && found.byId !== undefined) {
    return { ok: true, invoice: found.byId };
  }
  const distinct = new Map<string, LedgerInvoiceRef>();
  if (found.byId !== undefined) distinct.set(found.byId.id, found.byId);
  for (const invoice of found.byDocNumber) {
    if (!distinct.has(invoice.id)) distinct.set(invoice.id, invoice);
  }
  const [only, ...others] = [...distinct.values()];
  if (only === undefined) return { ok: false, reason: 'invoice_not_found' };
  if (others.length > 0) return { ok: false, reason: 'invoice_ambiguous' };
  return { ok: true, invoice: only };
}

/**
 * Why a posting attempt ended before anything was sent to the ledger. An
 * attempt recorded with one of these made no write request at all.
 */
export const NOTHING_SENT_REASONS = [
  'no_invoice',
  'invoice_not_found',
  'invoice_lookup_failed',
  'build_failed',
  'lines_changed',
] as const;
export type NothingSentReason = (typeof NOTHING_SENT_REASONS)[number];

export function isNothingSentReason(reason: unknown): reason is NothingSentReason {
  return typeof reason === 'string' && (NOTHING_SENT_REASONS as readonly string[]).includes(reason);
}

/**
 * Whether a posting's recorded attempts show that nothing was ever sent: at
 * least one attempt, and every one of them ended before the send. An attempt
 * with any other reason — a send that failed, an unknown outcome, a read-back
 * — or with none recorded may have reached the ledger.
 */
export function nothingWasSent(attemptReasons: readonly (string | undefined)[]): boolean {
  return attemptReasons.length > 0 && attemptReasons.every(isNothingSentReason);
}

/**
 * How long a `pending` posting waits with nothing recorded before the page
 * offers "Check QuickBooks and retry": the job answers in seconds, so a row
 * still pending after this has a run that never recorded anything.
 */
export const STUCK_PENDING_MINUTES = 5;
