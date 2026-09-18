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
