/**
 * A payer's dispute window, as data (ADR 0071, migration 0043).
 *
 * A window says that, for one tenant's debtor, a deduction may be disputed
 * within N calendar days of its deduction date, from a date on. Which row
 * applies on a date is `app.payer_dispute_windows_as_of()` in SQL and
 * {@link resolveDisputeWindow} here; the store's test holds the two to one
 * answer. Nothing here reads a clock.
 */

import { isIsoDate, type PayerCodeConfidence, type PayerCodeSource } from './payer-code-map';

export const DISPUTE_WINDOW_MAX_DAYS = 730;
export const DISPUTE_WINDOW_MEASURED_FROM = ['deduction_date'] as const;
export type DisputeWindowMeasuredFrom = (typeof DISPUTE_WINDOW_MEASURED_FROM)[number];

/** One `payer_dispute_windows` row. Dates are `YYYY-MM-DD`. */
export interface DisputeWindowRow {
  readonly id: string;
  readonly debtorId: string;
  readonly windowDays: number;
  readonly measuredFrom: DisputeWindowMeasuredFrom;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly source: PayerCodeSource;
  readonly sourceNote?: string;
  readonly confidence: PayerCodeConfidence;
  readonly recordedBy: string;
  /** ISO timestamp. */
  readonly createdAt: string;
}

export function isDisputeWindowDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= DISPUTE_WINDOW_MAX_DAYS;
}

/**
 * The window in force for a debtor on a date, or undefined. Among that
 * debtor's rows whose range covers the date: the latest `effectiveFrom`, then
 * the latest `createdAt`, then the greater id — the order
 * `app.payer_dispute_windows_as_of()` sorts by, so the answer never depends on
 * the list's order.
 */
export function resolveDisputeWindow(
  rows: readonly DisputeWindowRow[],
  debtorId: string,
  asOf: string,
): DisputeWindowRow | undefined {
  if (!isIsoDate(asOf)) throw new RangeError(`asOf is not a YYYY-MM-DD date: ${asOf}`);
  let best: DisputeWindowRow | undefined;
  for (const row of rows) {
    if (row.debtorId !== debtorId) continue;
    if (row.effectiveFrom > asOf) continue;
    if (row.effectiveTo !== undefined && row.effectiveTo < asOf) continue;
    if (best === undefined || supersedes(row, best)) best = row;
  }
  return best;
}

function supersedes(a: DisputeWindowRow, b: DisputeWindowRow): boolean {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom > b.effectiveFrom;
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return at > bt;
  return a.id > b.id;
}

const DAY_MS = 86_400_000;

/**
 * The deduction date plus `windowDays` calendar days, as `YYYY-MM-DD`. UTC
 * arithmetic on whole days only. Throws on a date that is not a real ISO date
 * or a day count outside 1..{@link DISPUTE_WINDOW_MAX_DAYS}.
 */
export function deadlineFromWindow(deductionDate: string, windowDays: number): string {
  if (!isIsoDate(deductionDate)) throw new RangeError(`deduction date is not a YYYY-MM-DD date: ${deductionDate}`);
  if (!isDisputeWindowDays(windowDays)) {
    throw new RangeError(`window is not a whole number of days in 1..${DISPUTE_WINDOW_MAX_DAYS}: ${windowDays}`);
  }
  const start = Date.parse(`${deductionDate}T00:00:00Z`);
  return new Date(start + windowDays * DAY_MS).toISOString().slice(0, 10);
}
