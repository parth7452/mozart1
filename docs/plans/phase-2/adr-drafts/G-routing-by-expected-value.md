# Draft G — A decided case is routed by expected value; a person still approves every filing

- Status: **proposed**
- Date: 2026-09-24
- Builds on: STRATEGY CH-1, the `decided → auto_dispute_queued |
  analyst_review | auto_writeoff_queued` edges (declared, no evaluator),
  invariant 1, invariant 7, drafts A, C and F

## Context

`DEFAULT_MIN_DECISION_CONFIDENCE = 0.95` routes anything a model is under 95%
sure of to a person. That optimises win rate and caps coverage. A 55%-likely
$8,000 dispute is worth filing; a 97%-likely $40 one may not be (STRATEGY §2,
CH-1).

Three more gaps have to close before any model decision can be routed:

- **Schema B's `estimated_win_probability`** is an ordinal over five risk
  levels. An ordinal cannot be multiplied by dollars.
- **`assemblePacket` accepts `provider = 'human'` decisions only.**
- **The packet guard `submission_safe` is hard-wired to `true`.** Schema C,
  the verifier, never runs.

## Decision

1. **Schema B v2.** `estimated_win_probability` becomes a noul, "would this
   dispute be won?", whose answer's probability is a raw feature for draft F.
   A schema version bump means old recordings are not compared across it.
2. **Expected value in integer cents:**
   `EV = round_half_even(P(win) × amount_cents) − cost_to_file_cents`.
   `P(win)` comes from draft F's calibrator, never from the provider.
   `cost_to_file_cents` is a tenant setting. `applyBps`-style integer
   arithmetic is used, and the rounding is property-tested (invariant 3).
3. **Routing**, deterministic, in the `decision.routed` evaluator:
   - **auto-queue** (`auto_dispute_queued`) only when **all** hold:
     - Schema C passed, with both providers agreeing on `submission_safe`;
     - P(win) is calibrated (draft F §4);
     - EV ≥ the tenant's `min_expected_value_cents`;
     - the amount is ≤ `auto_dispute_ceiling_cents`;
     - the payer's playbook version is `reviewed`;
   - **write-off queue** only within `auto_writeoff_ceiling_cents`, which is 0
     by default, so never;
   - **everything else to `analyst_review`.**

   **Every** path still ends at `awaiting_approval`, and a person approves
   before anything is filed. The approval trigger is not touched.
4. **Thresholds only tighten.** `min_expected_value_cents` and
   `cost_to_file_cents` join `app.guard_threshold_direction()` in the
   migration that adds them. Raising the minimum EV is tightening. Lowering
   the cost to file is loosening, because it raises EV. The TypeScript mirror
   (`invariants/index.ts`) gets them in the same change. Its current drift (it
   knows four of the six guarded columns) is fixed in the same change. Both
   files are behind the ADR hook, which is why this ADR exists first.
5. **Promotion out of shadow** (draft A's `mode`) is the founder's call, per
   tenant, **only after** all of these on recorded cases:
   - agreement with human decisions on the same decision state ≥ a threshold
     set **before** the numbers are seen (proposal: 85% on
     `recommended_action`);
   - decline precision on people's declines ≥ 95%, because a wrong decline is
     money left unfought;
   - both providers' cassettes are recorded;
   - ECE is measured.

   Promotion widens draft A's `mode` check with its own migration.
6. **The packet reads any decision**, human or model. Schema C runs before
   `packet.assembled`, and a model decision's packet names the calibration
   and playbook versions it used.

## Options not taken

- **Keep confidence routing and lower 0.95.** That loosens a threshold, and
  optimises the wrong thing.
- **Let a model approve.** Invariant 1 and STRATEGY §8. Scoped policy approval
  is Phase 5, shadow only, and needs its own one-way-door ADR.
- **EV in floating point.** Invariant 3.

## Consequences

- A person's time moves from deciding everything to reviewing what the router
  sends them, and approving.
- The first auto-queued case is months away, gated on outcomes. The
  decisions and scoring before that are still useful, because they show where
  the model disagrees with people.
