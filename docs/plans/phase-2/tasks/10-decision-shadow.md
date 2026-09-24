# 10 — Decision in shadow, scored against people

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** 03, 06; **at least 30 human decisions or declines on real cases**.

## Steps
- On every human decision or decline, ask Schemas A–C over the same decision state; write `model_opinions` (`purpose='decision'`).
- Scoring view and page: agreement on `recommended_action` and canonical code, decline precision, by tenant; only same-`state_hash` pairs are scored.

## Done when
- The numbers exist and are shown; the founder sets the promotion threshold **before** reading them (draft G §5).
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
