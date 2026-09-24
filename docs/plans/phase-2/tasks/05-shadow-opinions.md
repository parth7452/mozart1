# 05 — The shadow opinions table

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Draft A accepted.

## Steps
- Migration: `model_opinions` per draft A (append-only, RLS, `mode in ('shadow')`, unique idempotency key, composite `(org_id, deduction_id)` key), `model_calls.purpose` gains `triage`.
- Store methods to write and read opinions as `app_rw`.

## Done when
- Suite: UPDATE/DELETE/TRUNCATE refused; `mode <> 'shadow'` refused; a second insert with the same idempotency key is a no-op; cross-tenant reads empty.
- Nothing routes on it (grep-level test: no reader outside scoring).
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
