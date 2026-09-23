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
  if (days <= 14) return { label: `${days}d left`, tone: 'due-soon' };
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
