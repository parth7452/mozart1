# 08 — Triage step B, in shadow

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** 05, and 06 or 07; every condition in ADR 0043 step B.

## Steps
- An Inngest event per opened case (ids only), its own concurrency; asks the triage question set over a whitelist of our own numbers (no payer text); writes a `model_opinions` row with `purpose='triage'`.
- A `triage` eval suite with a decline-precision baseline; a page listing where the model and the rules disagree.
- `TRIAGE_SHADOW` must be set on purpose; unset means nothing is asked.

## Done when
- A provider failure never affects the sync or the case (tested by a throwing provider).
- Cost per candidate is reported over every candidate triaged, not only those asked.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
