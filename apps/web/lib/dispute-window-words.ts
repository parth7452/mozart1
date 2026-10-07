import { PAYER_CODE_SOURCE_WORDS, type DisputeWindowRow } from '@recouple/core-domain';

/**
 * Settings → Dispute windows' pure half (ADR 0071): who may add a window, the
 * words a window is shown in, the page's own notices and the prefill a link
 * may ask for. No server imports, so the views and the route share one answer.
 */

export const DISPUTE_WINDOWS_PATH = '/settings/dispute-windows';

/**
 * Adding a window is an owner's or approver's. The database says the same
 * (`payer_dispute_windows`' insert policy); this is the form not shown.
 */
export function mayRecordWindows(role: string): boolean {
  return role === 'owner' || role === 'approver';
}

/** "the payer's own guide". */
export function windowSourceWords(window: Pick<DisputeWindowRow, 'source'>): string {
  return PAYER_CODE_SOURCE_WORDS[window.source];
}

/** The basis the case page's deadline form starts with. */
export function windowBasis(window: Pick<DisputeWindowRow, 'windowDays' | 'source'>): string {
  return `Payer dispute window: ${window.windowDays} days from the deduction date (${windowSourceWords(window)})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `?debtor=` that is a UUID, else nothing; a query string is anybody's typing. */
export function windowPrefillFrom(params: { readonly debtor?: unknown }): { readonly debtorId?: string } {
  return typeof params.debtor === 'string' && UUID.test(params.debtor) ? { debtorId: params.debtor } : {};
}

/** The settings page with the form's payer chosen. */
export function addWindowHref(debtorId: string): string {
  return `${DISPUTE_WINDOWS_PATH}?${new URLSearchParams({ debtor: debtorId }).toString()}#add-window`;
}

/**
 * Every sentence this page says back after a write, and nothing else. A notice
 * travels as a key; an unknown key renders nothing.
 */
export const DISPUTE_WINDOW_NOTICES = {
  windows_recorded: {
    tone: 'good',
    text: 'window added. Cases for that payer opened from now on get their deadline from it.',
  },
  windows_role: { tone: 'bad', text: 'only an owner or approver can add a window; nothing changed' },
  windows_invalid: {
    tone: 'bad',
    text:
      'that window could not be read: it needs a payer, a number of days from 1 to 730, a start date, ' +
      'a source and a confidence. Nothing changed.',
  },
  windows_dates: { tone: 'bad', text: 'the end date is before the start date; nothing changed' },
  windows_already: { tone: 'bad', text: 'that window is already recorded; nothing changed' },
  windows_debtor: { tone: 'bad', text: 'that payer is not one of this workspace’s; nothing changed' },
  windows_failed: { tone: 'bad', text: 'that did not go through, and nothing changed. Try again.' },
} as const satisfies Record<string, { readonly tone: 'good' | 'bad'; readonly text: string }>;

export type DisputeWindowNoticeKey = keyof typeof DISPUTE_WINDOW_NOTICES;

export function resolveDisputeWindowNotice(
  key: unknown,
): { readonly tone: 'good' | 'bad'; readonly text: string } | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(DISPUTE_WINDOW_NOTICES, key)
    ? DISPUTE_WINDOW_NOTICES[key as DisputeWindowNoticeKey]
    : undefined;
}
