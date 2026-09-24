# 11 — Calibration

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Draft F accepted; outcomes on at least 50 filed cases.

## Steps
- `calibration_models` (append-only, versioned); isotonic per segment with pooling; a conservative prior below 30 outcomes; ECE per tenant, shown.

## Done when
- Every routed decision names the calibration version it used; ECE is measurable per tenant (STRATEGY §9's go/no-go).
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
