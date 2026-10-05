/**
 * The names the settlement prepare form and its route share (ADR 0068 §7).
 * Pure constants and one formatter, so the view that draws the form imports
 * nothing that reaches a database.
 */

/** The address parameters of the editor. Short: one repeats per line. */
export const SETTLE_PARAMS = {
  outcome: 'so',
  recovered: 'sr',
  family: 'sf',
  invoice: 'si',
  /** One per echoed line: `accountId~debitCents~creditCents`. Never a memo. */
  line: 'sl',
  /** The refusals of the form that was sent back: `code` or `code.lineNo`. */
  problems: 'sp',
  /** Open the form on a case whose settlement is prepared and not yet approved. */
  again: 'se',
} as const;

/** The form's field names for line `n` (1-based). */
export const lineField = (n: number, field: 'account' | 'debit' | 'credit' | 'memo'): string =>
  `${field}_${n}`;

/** Cents as the text a money field shows and `parseMoneyToCents` reads back: `1234.50`. */
export function centsAsText(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError('a money field shows non-negative integer cents');
  }
  // Integer arithmetic only: the remainder first, so the division is exact.
  const fraction = amount % 100;
  const whole = (amount - fraction) / 100;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}
