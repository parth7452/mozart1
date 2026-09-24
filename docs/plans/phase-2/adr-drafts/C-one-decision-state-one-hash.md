# Draft C — One decision state and one hash, for a person and a model alike

- Status: **proposed**
- Date: 2026-09-24
- Builds on: ADR 0020 §1 (a human decision is a `decisions` row), invariant 4,
  `DecisionState` (`packages/decision/src/types.ts`)

## Context

Phase 2 is to be "scored against the human decisions recorded so far". Today
a model's decision and a person's cannot be lined up, for three reasons:

1. **Two hashes over two inputs.**
   - A human decision's `input_state_hash` comes from `workflow.ts`: a buffer
     over the case's amount, claim id, dates, retailer and document ids.
   - `packages/decision`'s `inputStateHash` is hex over
     `{orgId, deductionId, facts}`.

   They never agree, even for the same case at the same moment.
2. **Two shapes.** A person records `dispute_reason` (a canonical reason
   code) and a sentence. Schema B asks for validity, basis, evidence
   sufficiency, win odds and a recommended action.
3. **Two tables.** A person's "no" is a `declined_candidates` row, not a
   `decisions` row.

And nothing yet says what a decider is **allowed to see**. The rule so far is
only "extracted fields, never document text".

## Decision

1. **`buildDecisionState(caseId)`**, one function in `packages/pipeline`,
   builds the facts every decider sees, human or model. It is a **whitelist**
   of our own values:
   - amount in cents, and the canonical reason code (mapped through draft D);
   - the payer's code as a closed-set token only when the playbook maps it;
   - days to deadline, and the debtor as matched or unmatched;
   - evidence present and missing (draft E's vocabulary);
   - reconciliation findings as their constant names;
   - line arithmetic as numbers, the source channel, and the tenant's
     thresholds.
   - It excludes free text: payer memos, descriptions, retailer names as
     printed, rationales. Invariant 4 and ADR 0043's "no payer text".
   - `assertStateIsStructured` runs on it.
2. **One hash, `state_hash`:** sha256 of the canonical JSON of that state,
   stamped with `state_version`. It is written:
   - on every `model_opinions` row (draft A);
   - on every new human `decisions` row, in a **new column**
     `decisions.decision_state_hash`. It is nullable, because existing rows
     have none and the table is append-only.

   The existing `input_state_hash` stays exactly as it is. The new column is
   what the two sides are joined on.
3. **A person's answer, mapped into the model's shape by a view, never by
   rewriting a row.** `human_decision_answers` reads both tables:
   - `decisions` (human) → `recommended_action = dispute`,
     `canonical_reason_code = dispute_reason`;
   - `declined_candidates` with `decided_by_version = 'human/v1'` →
     `recommended_action = write_off`, with the decline reason as a closed
     set.

   Schema B's `validity` and `invalid_basis` have no human answer, and the
   view says `null` rather than guessing one.
4. **The scoring join is `(deduction_id, state_hash)`.** A model opinion
   asked on the same state the person saw is comparable. One asked on a later
   state (more evidence arrived) is reported apart, never averaged in.

## Options not taken

- **Recomputing the old human hash from `packages/decision`.** Its inputs are
  not the facts a model would see, and redefining a stored hash falsifies the
  row.
- **Updating old `decisions` rows with the new hash.** The table is
  append-only (invariant 2). The one production human decision (2026-09-21)
  simply has no state hash, and is matched by `deduction_id` with its state
  rebuilt and marked *reconstructed*.
- **Letting the model see the rationale a person wrote.** It is free text and
  a leak of the answer.

## Consequences

- The human decision form writes the state hash at decide time, a small
  change in `recordHumanDecision`.
- Scoring (task 10) is a query, not a heuristic.
- `state_version` bumps whenever the whitelist changes, and opinions on
  different versions are not compared.

## Invariants touched

- Invariant 2: a nullable column added to an append-only table, so ADR first,
  which this is. No UPDATE grant.
- Invariant 4: the state is a whitelist of our own values.
