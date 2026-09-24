import { DUE_SOON_DAYS } from '@recouple/core-domain';
import type { DocType } from '@recouple/extraction';

/** Money is integer cents everywhere; it becomes a string only to be read. */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export interface Deadline {
  readonly label: string;
  readonly tone: 'ok' | 'due-soon' | 'overdue';
}

/**
 * How long is left to dispute, which is the only thing on the list that decides
 * what to look at first. A missed deadline is a deduction that can no longer be
 * recovered at all, so it is not shown as a date the reader has to subtract.
 */
export function deadline(iso: string | undefined, today: Date): Deadline | undefined {
  if (iso === undefined) return undefined;
  const due = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return undefined;
  const midnight = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((due.getTime() - midnight.getTime()) / 86_400_000);
  if (days < 0) return { label: `${-days}d overdue`, tone: 'overdue' };
  if (days === 0) return { label: 'due today', tone: 'overdue' };
  // The review queue's own threshold (ADR 0043), so the label and the queue
  // cannot disagree about what "due soon" means.
  if (days <= DUE_SOON_DAYS) return { label: `${days}d left`, tone: 'due-soon' };
  return { label: `${days}d left`, tone: 'ok' };
}

/** `lines[0].qty_received` → `lines 1 · qty received`. */
export function fieldLabel(path: string): string {
  return path
    .split('.')
    .map((segment) => {
      const match = /^([^[]+)\[(\d+)\]$/.exec(segment);
      const [, name, index] = match ?? [];
      const base = (name ?? segment).replace(/_/g, ' ');
      return index === undefined ? base : `${base} ${Number(index) + 1}`;
    })
    .join(' · ');
}

export function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export interface Retailer {
  readonly name: string;
  /**
   * False when the name is only what the notice printed and no debtor of this
   * tenant answers to it. The view says so rather than showing the name as
   * though it were settled — an unmatched retailer has no playbook, no portal
   * and no routing, so the difference is one a reviewer acts on.
   */
  readonly matched: boolean;
}

/**
 * What to call the retailer on a case.
 *
 * Three answers, in order: the debtor a human created, when exactly one matched;
 * otherwise the name as the notice printed it, marked unmatched; otherwise
 * nothing was read at all (ADR 0019).
 */
export function retailer(
  summary: { debtorName?: string; retailerNameAsPrinted?: string },
  unread: string,
): Retailer {
  if (summary.debtorName !== undefined) return { name: summary.debtorName, matched: true };
  if (summary.retailerNameAsPrinted !== undefined) {
    return { name: summary.retailerNameAsPrinted, matched: false };
  }
  return { name: unread, matched: true };
}

/**
 * What a document was read as, in words.
 *
 * Every one of `DOC_TYPES`, written out: a `Record` over the union, so a
 * thirteenth type is a compile error here rather than a document the list shows
 * as its code name.
 */
const DOC_TYPE_LABELS: Readonly<Record<DocType, string>> = {
  deduction_notice: 'deduction notice',
  remittance_advice: 'remittance advice',
  invoice: 'invoice',
  po: 'purchase order',
  bol: 'bill of lading',
  pod: 'proof of delivery',
  asn: 'advance ship notice',
  correspondence: 'correspondence',
  promo_agreement: 'promotion agreement',
  price_agreement: 'price or rate agreement',
  routing_guide: 'routing guide',
  other: 'other document',
};

export function docTypeLabel(docType: DocType): string {
  return DOC_TYPE_LABELS[docType];
}

/**
 * The database's ratio as a percentage to one place: `0.4521` → `45.2%`.
 * Display only — never clamped (a month can file more than it found, ADR 0030
 * §4, and `1.25` reads `125.0%`) and never computed from cents here.
 */
export function percent(ratio: number): string {
  return `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;
}

/**
 * A classifier's confidence, or a tenant's floor, as a percentage: `0.75` →
 * `75%`, `0.955` → `95.5%`, `0.9499` → `94.99%`. Display only — the number is
 * the database's (or the hold's), and nothing here decides with it (ADR 0044).
 *
 * **Truncated, never rounded**, to hundredths of a percent: a hold at 0.94995
 * against a floor of 0.950 must not read "95% … at 95% or above", which would
 * say the reading met the floor it was held for missing. The digits are taken
 * off a fixed-point string rather than by multiplying, because `0.95 * 10000`
 * is 9499.999…, and flooring that would show a reading exactly at the floor as
 * below it.
 */
export function confidencePercent(ratio: number): string {
  const [whole = '0', fraction = ''] = ratio.toFixed(6).split('.');
  const basisPoints = Number(whole) * 10_000 + Number(fraction.slice(0, 4).padEnd(4, '0'));
  return `${basisPoints / 100}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-09-01` → `Sep 2026`, read from the string's own parts rather than
 * through `Date`, so no time zone can move a month into its neighbour.
 */
export function monthLabel(isoDay: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(isoDay);
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  if (match === null || month === undefined) return isoDay;
  return `${month} ${match[1]}`;
}
