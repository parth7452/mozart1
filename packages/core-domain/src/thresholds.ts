/**
 * Tenant safety defaults.
 *
 * These mirror the column defaults in
 * `supabase/migrations/…_0002_tenancy.sql`. They live here too so the app can
 * explain a routing decision before a request is made; the database remains the
 * authority, and `assertThresholdDirection` governs which way they may move.
 */

export const DEFAULT_MIN_CLASSIFICATION_CONFIDENCE = 0.95;
export const DEFAULT_MIN_DECISION_CONFIDENCE = 0.95;
export const DEFAULT_AUTO_DISPUTE_CEILING_CENTS = 50_000;
export const DEFAULT_AUTO_WRITEOFF_CEILING_CENTS = 0;

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
