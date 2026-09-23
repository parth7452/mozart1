import type { LedgerSyncAnomalyKind, LedgerSyncOutcome } from '@recouple/store-postgres';

/**
 * The words the coverage page uses for what the database records (ADR 0030,
 * ADR 0031, ADR 0035). Lookup tables over closed sets, typed as `Record`s so a
 * fifth anomaly kind or outcome fails to compile here rather than rendering as
 * a raw string on a customer's screen.
 */

/** How a deduction reached us, in the customer's words. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  web_upload: 'Uploaded in the app',
  email_in: 'Emailed in',
  email_body: 'Emailed in (message text)',
  erp_sync: 'Found in your ledger',
  portal_fetch: 'Read from a payer portal',
  edi_812: 'EDI 812',
  unknown: 'Arrival not recorded',
};

/** A channel's label; an unrecognised one verbatim rather than hidden. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * `unknown` is not a channel but the absence of one (ADR 0030 §3): its dollars
 * are counted and explained, and it never gets a rate of its own.
 */
export function isChannel(source: string): boolean {
  return source !== 'unknown';
}

export interface AnomalyGuide {
  readonly title: string;
  readonly meaning: string;
  readonly whatToDo: string;
}

/**
 * What each anomaly means and what a person does about it in QuickBooks. No
 * case is opened for an invoice the sync cannot make add up, so every one of
 * these is a short-pay the product is not looking at yet.
 */
export const ANOMALY_GUIDE: Readonly<Record<LedgerSyncAnomalyKind, AnomalyGuide>> = {
  application_to_unknown_invoice: {
    title: 'Applied to an invoice QuickBooks did not return',
    meaning: 'A payment or credit is applied to an invoice the sync could not read.',
    whatToDo:
      'Open that payment or credit in QuickBooks and check the invoice still exists and was not voided or deleted.',
  },
  overapplied: {
    title: 'More applied than the invoice is for',
    meaning: 'Payments and credits applied to this invoice add up to more than its total.',
    whatToDo: 'Look for a payment or credit applied to this invoice twice.',
  },
  negative_amount: {
    title: 'A negative amount',
    meaning: 'An invoice, its balance or an application to it is negative.',
    whatToDo:
      'Usually a refund or a correction entered as a negative number. Check the entry in QuickBooks.',
  },
  currency_mismatch: {
    title: 'A different currency',
    meaning: 'This invoice is in a different currency from the rest of the ledger.',
    whatToDo: 'Short-pays in another currency are not analysed. Review it by hand.',
  },
};

export type Tone = 'ok' | 'due-soon' | 'overdue';

/** How a sync run ended, in plain words, with the pill tone the case list uses. */
export const OUTCOME_LABELS: Readonly<Record<LedgerSyncOutcome, { label: string; tone: Tone }>> = {
  completed: { label: 'Completed', tone: 'ok' },
  not_configured: { label: 'Not read', tone: 'due-soon' },
  refused: { label: 'Refused', tone: 'due-soon' },
  failed: { label: 'Failed', tone: 'overdue' },
};

/**
 * What a run's error class means for the person reading, by the class's
 * literal name (the errors carry literal names so a minified build records the
 * same ones). The class name itself is shown as well, for whoever investigates.
 */
export function errorClassGuide(errorClass: string | undefined, outcome: LedgerSyncOutcome): string {
  if (outcome === 'completed') return '';
  if (outcome === 'not_configured') {
    return 'This deployment could not reach QuickBooks — something it needs is not set up. The run row does not record which.';
  }
  if (outcome === 'refused') {
    return 'The member this connection syncs as can no longer write in this workspace. Reconnect as a current owner.';
  }
  switch (errorClass) {
    case 'QboAuthError':
      return 'QuickBooks refused the connection. Reconnect it from Settings → QuickBooks.';
    case 'QboRateLimited':
      return 'QuickBooks asked us to slow down. The next daily run tries again.';
    case 'QboRequestFailed':
      return 'QuickBooks could not answer. The next daily run tries again; if it keeps failing, an engineer should look.';
    case 'CredentialUnreadableError':
    case 'TokenDecryptionError':
    case 'TokenCipherMismatchError':
    case 'TokenContextError':
      return 'The stored QuickBooks sign-in could not be opened. An engineer should check the encryption key setup — do not reconnect first.';
    case 'LedgerAccountBusyError':
      return 'Another change to this QuickBooks connection was in progress. The next daily run tries again.';
    default:
      return 'An engineer should look at the logs for this run.';
  }
}

/**
 * The daily fan-out runs at 07:00 UTC (`LEDGER_SYNC_SCHEDULE`, pinned by a
 * test beside this constant). A connection with no run for more than a day and
 * two hours has missed one.
 */
export const SYNC_OVERDUE_AFTER_HOURS = 26;

export function syncOverdue(lastRunStartedAt: string | undefined, now: Date): boolean {
  if (lastRunStartedAt === undefined) return false;
  const started = Date.parse(lastRunStartedAt);
  if (Number.isNaN(started)) return false;
  return now.getTime() - started > SYNC_OVERDUE_AFTER_HOURS * 3_600_000;
}

/**
 * Runs recorded before ADR 0035 (deployed with migration 0027, 2026-09-22 20:20
 * UTC) filtered every entity by its own date and counted `invoices examined`
 * differently; a run from before then is marked so its numbers are not read
 * against a later run's.
 */
export const WINDOW_ANCHORED_ON_PAYMENTS_SINCE = '2026-09-22T20:20:04Z';

export function countedBeforePaymentWindow(startedAt: string): boolean {
  return Date.parse(startedAt) < Date.parse(WINDOW_ANCHORED_ON_PAYMENTS_SINCE);
}
