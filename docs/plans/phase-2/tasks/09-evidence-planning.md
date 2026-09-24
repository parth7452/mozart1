# 09 — Evidence planning

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** 01 and 04.

## Steps
- `evidence_checklist` table (append-only), derived from the playbook's requirements and the case's documents; recomputed on every new document.
- Evaluators for `classified → evidence_pending` (classification floor + a checklist exists) and `evidence_pending → evidence_complete`.
- Enumerate (unsatisfied type × capable source: case documents, the QuickBooks ledger, request from customer); v1 chooses by rule. A model's choice over the same enumeration is shadow-only.

## Done when
- A case page says what is missing and where it would come from; nothing is fetched from outside.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
