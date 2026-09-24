# 07 — Jev provider and its cassettes

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Jev access and answers to `jev-requirements.md`; the founder's DPA decision.

## Steps
- `JevDecisionProvider` over the confirmed API; full distribution and model version recorded; errors mapped to `DecisionUnavailableError` / `DecisionContractError`.
- Recorded with the **test** key; cassettes committed only with TypeSafe's permission.

## Done when
- Both providers have cassettes for every decision path (CLAUDE.md); the same cases scored for each, side by side, never blended.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
