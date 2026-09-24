# Draft A — A model's opinion is recorded in shadow, beside the person's decision

- Status: **proposed** (not accepted; takes an ADR number on acceptance)
- Date: 2026-09-24
- Builds on: ADR 0020 (a human decides, in the `decisions` slot), ADR 0043
  step B (the shadow triage tier's conditions)

## Context

Two things in Phase 1.5 and Phase 2 have a model answer a question about a
case before the answer is allowed to do anything:

- **triage step B:** "should this short-pay be a case?" (ADR 0043);
- **the shadow decision:** Schemas A–C about a case a person is deciding.

Both have to be written down, so they can be scored against what people did.
Neither may change what happens to the case.

The `decisions` table is the wrong place for either:

- **Any row there is work.** `app.merge_work_rank()` counts any `decisions`
  row, so a shadow row would change which copy survives a duplicate merge
  (migration 0032). The `RCM01` trigger refuses a decision on a merged-away
  case, so a shadow answer for one would fail.
- **A row there can be approved.** The approval trigger joins an approval to
  a `decisions` row, so a shadow row is one approval away from authorising a
  filing. That is exactly what "shadow" must rule out.
- **Its `schema_id` admits A–D only.** ADR 0020 refused a fifth letter, and
  triage is not one of the four.

## Decision

1. **One new append-only table, `model_opinions`,** on migration 0004's
   pattern:
   - revoke UPDATE and DELETE;
   - `no_update_delete` and `no_truncate` triggers;
   - per-command RLS, with insert gated on `app.member_may_write()`, as since
     0010.
2. **Columns:**
   - `org_id`, and `deduction_id not null`. The opinion is asked after the case
     exists (ADR 0043). There is a composite key `(org_id, deduction_id)` on
     ADR 0025 §7's pattern.
   - `purpose`: `triage` or `decision`.
   - `schema_id`: `triage-1`, `A`, `B` or `C`.
   - `schema_version`, `provider`, `model_version`.
   - `state_hash`: the decision-state hash from draft C.
   - `answers`, `raw_probabilities`, `confidence`, `latency_ms`,
     `cost_micros`.
   - `outcome`: `ok`, `unavailable`, `contract_error` or `refused`, and
     `error_class`.
   - `idempotency_key unique`: one opinion per (case, purpose, schema version,
     state hash, provider). A redelivered or overlapping job pays once.
   - `mode text not null check (mode in ('shadow'))`.
3. **`mode` admits `shadow` and nothing else.** A model that *acts* needs its
   own ADR and migration to widen the check. That is the one-way door, and it
   stays shut until draft G's go/no-go is met.
4. **An opinion is asked outside every lock and every request.** It is an
   Inngest event per case, carrying ids only, with its own concurrency. It
   never runs inside `withDocumentRead`, `withInvoiceClaim`, the ledger sync's
   step, or an upload request. With no queue (the inline runner), nothing is
   asked.
5. **A model can never break the path it shadows.** Every provider error is
   recorded on the opinion row, and in `model_calls` by class name. The case,
   the sync and the upload have already finished.
6. **`model_calls.purpose` gains `triage`.** `decide` already exists.
7. **Nothing reads `model_opinions` to route anything.** Only the scoring
   views of drafts C and G, and a disagreement page, read it.

## Options not taken

- **Shadow rows in `decisions` with a flag.** A flag is a filter every reader
  has to remember, and the approval trigger and merge rank do not know about
  it.
- **Two tables, one for triage and one for decisions.** Same shape and same
  rules. One table with a `purpose` keeps one set of policies and one eval
  reader.
- **Logging opinions to `model_calls` only.** `model_calls` records spend,
  not answers. The distribution is what calibration needs.

## Consequences

- Triage step B and the Phase 2 shadow decision share one table, one
  migration and one scoring path.
- Promoting a model from shadow means writing `decisions` rows (with
  `provider` `jev` or `claude-structured` and a null `prepared_by`) behind
  draft G's gate. The approval trigger and separation of duties apply
  unchanged: any owner or approver can approve a model's decision, and
  nobody's own.

## Invariants touched

- Invariant 2: a new append-only table, so ADR first, which this is.
- Invariant 5: every opinion comes through `DecisionProvider`.
- Invariant 6: RLS on the table, no service role.
- Invariant 1: untouched.
