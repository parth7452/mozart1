/**
 * A dispute deadline a person enters (pilot E6).
 *
 * Remittance-line cases and ledger cases never carry `dispute_deadline` — the
 * advice and the ledger print none — and most notices print none either, so
 * the review queue ranks them by age. A person who knows the payer's window
 * ("Sysco vendor agreement: 60 days from deduction date") can now write it
 * down, once, with the basis beside it.
 *
 * The rules live here rather than in either store so both refuse the same
 * thing in the same words. Three of them:
 *
 *  - **Only where none is recorded.** A printed deadline is evidence; a typed
 *    one is a person's reading of a contract. The store sets the column only
 *    where it is null and refuses by name otherwise, so the second can never
 *    replace the first.
 *  - **A basis is required.** A date with no reason is a number nobody can
 *    check, and the review queue ranks by it.
 *  - **Not in the past and not absurdly far out.** A deadline already gone is
 *    not a deadline to enter, it is a case to decline; one years away is a
 *    typo in the year. Refused, never clamped.
 */

import {
  DeadlineBasisRequiredError,
  DeadlineBasisTooLongError,
  DeadlineOutOfRangeError,
} from './ports';

/** How long the basis may be. A sentence naming a contract, not the contract. */
export const DEADLINE_BASIS_MAX_LENGTH = 280;

/**
 * How far out an entered deadline may be, in days from today.
 *
 * Two years: post-audit claims reach back about that far, so no payer's
 * window a person could cite is longer, and anything past it is far likelier
 * a mistyped year than a real deadline.
 */
export const MAX_ENTERED_DEADLINE_DAYS = 730;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` that is a real calendar date, as UTC midnight; else undefined. */
function calendarDate(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  // `Date.UTC(2026, 1, 30)` is 2 March, not a refusal: read it back to be sure.
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return undefined;
  }
  return at;
}

/**
 * Checks an entered deadline and its basis, and answers the trimmed basis.
 *
 * "The past" is judged against the earliest date it is anywhere: today in UTC
 * less one day. A reviewer in New York at 21:00 is already on tomorrow in UTC,
 * and refusing their today as yesterday would be this check being wrong, not
 * them. The cost is that yesterday is accepted for an hour or so each evening
 * somewhere, which the review queue then shows as past its deadline.
 *
 * @throws {DeadlineOutOfRangeError} not a calendar date, in the past, or past
 *   {@link MAX_ENTERED_DEADLINE_DAYS}
 * @throws {DeadlineBasisRequiredError} the basis is empty or only whitespace
 * @throws {DeadlineBasisTooLongError} the basis is past {@link DEADLINE_BASIS_MAX_LENGTH}
 */
export function checkEnteredDeadline(
  deductionId: string,
  input: { readonly deadline: string; readonly basis: string },
  now: Date,
): { readonly deadline: string; readonly basis: string } {
  const at = calendarDate(input.deadline);
  if (at === undefined) {
    throw new DeadlineOutOfRangeError(deductionId, input.deadline, 'not_a_date');
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (at < today - DAY_MS) {
    throw new DeadlineOutOfRangeError(deductionId, input.deadline, 'in_the_past');
  }
  if (at > today + MAX_ENTERED_DEADLINE_DAYS * DAY_MS) {
    throw new DeadlineOutOfRangeError(deductionId, input.deadline, 'too_far_out');
  }
  const basis = input.basis.trim();
  if (basis === '') throw new DeadlineBasisRequiredError(deductionId);
  if (basis.length > DEADLINE_BASIS_MAX_LENGTH) {
    throw new DeadlineBasisTooLongError(deductionId, basis.length, DEADLINE_BASIS_MAX_LENGTH);
  }
  return { deadline: input.deadline, basis };
}
