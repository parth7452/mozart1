/**
 * Tenant safety defaults.
 *
 * These mirror the column defaults in
 * `supabase/migrations/…_0002_tenancy.sql`. They live here too so the app can
 * explain a routing decision before a request is made; the database remains the
 * authority, and `assertThresholdDirection` governs which way they may move.
 *
 * One of them — `DEFAULT_MIN_DISPUTE_CENTS` — has no column behind it, and says
 * so where it is declared.
 */

import { ThresholdDirectionError } from './invariants/index';

export const DEFAULT_MIN_CLASSIFICATION_CONFIDENCE = 0.95;
export const DEFAULT_MIN_DECISION_CONFIDENCE = 0.95;
export const DEFAULT_AUTO_DISPUTE_CEILING_CENTS = 50_000;
export const DEFAULT_AUTO_WRITEOFF_CEILING_CENTS = 0;

/**
 * The smallest gap ERP triage will open a case for (ADR 0028 §4).
 *
 * $25.00, and deliberately far below what a dispute costs. A floor set where a
 * reviewer's time breaks even is the incumbent's floor, and the long tail is
 * the product (STRATEGY §3.1) — so this is set to do one job and no more: a
 * two-cent remittance rounding difference or a $3 fuel-surcharge tail is not a
 * deduction anybody would dispute, and without a floor each one would open a
 * case and spend extraction budget.
 *
 * **Unlike the four above, this is not an `org_settings` column.** There is no
 * per-tenant dispute floor and no trigger behind this number; the enforcement
 * is a PR, an ADR and {@link assertMinDisputeCentsDirection}. That is weaker
 * than the database, and it is said out loud rather than implied to be the
 * same thing. When a tenant first needs its own floor, the migration that adds
 * the column inherits the real enforcement and this becomes its default.
 */
export const DEFAULT_MIN_DISPUTE_CENTS = 2_500;

/**
 * Which way the dispute floor may move.
 *
 * *Lowering* it opens more cases and declines fewer, so lowering is the
 * tightening direction and needs nothing. *Raising* it declines more deductions
 * automatically — money quietly left unfought — which is the loosening, and
 * loosening needs a human and an ADR. The same shape as
 * `assertThresholdDirection` next door, for the same reason: the rule is code,
 * not a sentence somebody remembers.
 */
export function assertMinDisputeCentsDirection(
  current: number,
  next: number,
  authorisingAdr?: string,
): void {
  if (next > current && !authorisingAdr) {
    // The same class the four `org_settings` thresholds raise, because it is
    // the same rule. Two error types for one rule would let a caller catch one
    // and miss the other.
    throw new ThresholdDirectionError(['minDisputeCents']);
  }
}

/**
 * Whether a classification may be acted on without a human looking at it.
 *
 * A wrong answer below the floor is routed to review, which is the system
 * working. A wrong answer above it is acted on, which is the failure that costs
 * money — so the two are counted separately in the evals.
 */
export function classificationIsActionable(
  confidence: number,
  minimum = DEFAULT_MIN_CLASSIFICATION_CONFIDENCE,
): boolean {
  return confidence >= minimum;
}
