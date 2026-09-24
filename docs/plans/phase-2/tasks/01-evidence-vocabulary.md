# 01 — Unify the evidence vocabulary

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Draft E accepted.

## Steps
- Make `EVIDENCE_TYPES` canonical in `core-domain` (move from `adapters`, re-export).
- Explicit maps, each exhaustive and tested in both directions: `DOC_TYPES → evidence type`, the decline form's `MISSING_EVIDENCE_TYPES → evidence type` (stored strings unchanged — `declined_candidates` is append-only), Schema B `missing_evidence` → bumped schema version on the one list.
- No migration.

## Done when
- One list; every other list is a tested map onto it; `pnpm verify` green.
- The decline form still writes exactly the strings it writes today.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
