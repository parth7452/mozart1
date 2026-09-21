/**
 * Triage over short-pay candidates (ADR 0028 §2–§4, STRATEGY §6.3, ADD-7).
 *
 * The ledger produces thousands of candidate lines a month, most of which must
 * never reach extraction. This is the function that decides which of them
 * becomes a case — and in v1 it is **deterministic rules, no model**. The
 * `DecisionProvider` slot STRATEGY ADD-7 reserves is carried as a port
 * parameter on `syncLedger` that defaults to absent, to be filled in Phase 2.
 *
 * It is pure: no I/O, no clock, no randomness, and it does not throw on any
 * candidate `detectShortPays` can produce.
 *
 * Two properties make this safe to put in front of money:
 *
 * - **Every branch writes something.** There is no "discard" answer. A decline
 *   is a counterfactual-log row with what it was worth and why (STRATEGY
 *   ADD-1), which is both the coverage numerator and the population a later
 *   model has to be scored against.
 * - **The identity gate is asymmetric, and it errs towards keeping the
 *   deduction** (ADR 0025 §6, ADR 0028 §3). An `exact` match is the only answer
 *   that resolves without a person. A `probable` one opens the case anyway with
 *   a flag on it: a duplicate case is visible and still disputable, while a
 *   dropped arrival is invisible and, with post-audit windows of about two
 *   years, is found out long after the deadline has passed.
 */

import type { IdentityResolution } from './identity';
import type { Cents } from './money';
import type { ShortPayCandidate } from './short-pay';

/**
 * The reasons this function may give. A subset of the `decline_reason` enum in
 * migration 0014 — the rules can only reach these two, and a reason the rules
 * cannot reach has no business being in their type.
 */
export type TriageDeclineReason = 'below_economic_floor' | 'duplicate_of_other';

export type TriageDecision =
  | {
      readonly kind: 'open_case';
      /**
       * A deduction this may be the same as. Set only for a `probable`
       * resolution; the case is opened regardless and this becomes a
       * `case.possible_duplicate` event on it.
       */
      readonly possibleDuplicateOf?: { readonly deductionId: string; readonly basis: readonly string[] };
    }
  | {
      readonly kind: 'skip_exact_match';
      readonly deductionId: string;
      /** The kind of identifier that matched, for the log. Never its value. */
      readonly matchedKind: string;
    }
  | {
      readonly kind: 'decline';
      readonly reason: TriageDeclineReason;
      readonly detail: string;
      readonly estimatedRecoverableCents: Cents;
    };

export interface TriageOptions {
  /** Below this, a gap is declined `below_economic_floor` (ADR 0028 §4). */
  readonly minDisputeCents: number;
}

/**
 * What to do with one short-pay candidate.
 *
 * In this order, and the order is the decision:
 *
 * 1. **exact** → skip. We already hold this deduction; a second case would be a
 *    double count and two half-argued disputes.
 * 2. **ambiguous** → decline `duplicate_of_other`, naming the candidate
 *    deductions in `detail` so a person can look. Two matches count as none.
 * 3. **gap below the floor** → decline `below_economic_floor`.
 * 4. otherwise → open the case, carrying the possible duplicate when the
 *    resolution was `probable`.
 *
 * Identity is asked before the floor deliberately: a deduction we already hold
 * is not a small deduction we chose not to fight, and counting it as one would
 * put its dollars in the coverage denominator twice.
 */
export function triageCandidate(
  candidate: ShortPayCandidate,
  resolution: IdentityResolution,
  options: TriageOptions,
): TriageDecision {
  if (resolution.kind === 'exact') {
    return {
      kind: 'skip_exact_match',
      deductionId: resolution.deductionId,
      matchedKind: resolution.matchedOn.kind,
    };
  }

  if (resolution.kind === 'ambiguous') {
    return {
      kind: 'decline',
      reason: 'duplicate_of_other',
      // Deduction ids and basis names — our own identifiers and our own field
      // names. No document text and no ledger text (invariant 4).
      detail:
        `matches more than one deduction we already hold (${resolution.deductionIds.join(', ')}) ` +
        `on ${resolution.basis.join(', ')}; merging them is identity resolution's job`,
      estimatedRecoverableCents: candidate.gapCents,
    };
  }

  // A floor that is not a usable number would silently decline everything or
  // nothing. Neither is an outcome to reach by accident, so the value is read
  // as "no floor" only when it is genuinely absent-shaped (zero or less), and
  // anything unusable is treated the same way rather than compared against.
  const floor =
    Number.isFinite(options.minDisputeCents) && options.minDisputeCents > 0
      ? Math.ceil(options.minDisputeCents)
      : 0;

  if (candidate.gapCents < floor) {
    return {
      kind: 'decline',
      reason: 'below_economic_floor',
      detail: `the gap of ${candidate.gapCents} cents is below the ${floor}-cent dispute floor`,
      estimatedRecoverableCents: candidate.gapCents,
    };
  }

  if (resolution.kind === 'probable') {
    return {
      kind: 'open_case',
      possibleDuplicateOf: { deductionId: resolution.deductionId, basis: resolution.basis },
    };
  }

  return { kind: 'open_case' };
}
