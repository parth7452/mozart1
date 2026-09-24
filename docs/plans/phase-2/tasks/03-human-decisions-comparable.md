# 03 — Human decisions in a comparable shape

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** 02.

## Steps
- View `human_decision_answers` (`security_invoker`), draft C §3: human `decisions` → `recommended_action=dispute` + canonical code; `declined_candidates` (`human/v1`) → `write_off` + closed-set reason; `validity`/`invalid_basis` null.
- The one existing production human decision: state rebuilt and marked `reconstructed`.

## Done when
- The view returns one row per human decision or decline, under RLS, with the state hash where one exists.
- `pnpm db:test` suite reads it back for both kinds.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
