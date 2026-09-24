# 12 — Expected-value routing

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Draft G accepted; 10 and 11 meet their go/no-go; the founder promotes per tenant.

## Steps
- Schema B v2 (a win question as a noul); EV in integer cents (property-tested); `min_expected_value_cents` and `cost_to_file_cents` join the tighten-only guard **and** the TypeScript mirror (which gets its existing drift fixed), ADR first — the hook requires it.
- The `decision.routed` evaluator; Schema C run before `packet.assembled`; packets accept a model decision.
- Widening `model_opinions.mode` / writing model `decisions` rows is its own migration.

## Done when
- Every path still ends at `awaiting_approval`; the approval trigger and separation of duties are unchanged and re-tested.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
