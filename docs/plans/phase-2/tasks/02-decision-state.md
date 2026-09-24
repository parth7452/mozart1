# 02 — The decision state builder and its hash

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Draft C accepted.

## Steps
- `buildDecisionState(caseId)` in `packages/pipeline`: the whitelist in draft C §1, `assertStateIsStructured`, `state_version`.
- `stateHash(state)`: sha256 over canonical JSON (`canonicalJson` already exists in `packages/decision`).
- Migration: `decisions.decision_state_hash bytea null` (append-only table, column add only; no grants change). `recordHumanDecision` writes it.

## Done when
- A property test: no string from any document's page text ever appears in a built state (fixtures corpus).
- The hash is stable across runs and changes when any whitelisted fact changes.
- Suite 30 (or next free) asserts the column exists, is nullable, and no UPDATE grant was added.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
