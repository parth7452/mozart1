# 0020 — A human decides, and the gate is exercised

- Status: accepted
- Date: 2026-09-20

## Context

`docs/STATE-OF-PLAY.md` ends on the sentence this ADR exists to answer:
"Nothing has ever been submitted or recovered. No dispute has been sent, no
money has come back, and the approve button does not exist." The case state
machine has fourteen states and cases reach the second one. Phase 0 built the
approval gate — the trigger, the separation-of-duties check, the append-only
tables — and eighteen months of invariant tests prove it refuses things. Nothing
has ever gone *through* it.

The build order in `CLAUDE.md` puts Phase 1.5 (ERP read) and Phase 2 (evidence
and a Jev-decided validity call) before Phase 3 (packet, approval, manual
submission, outcome). `STRATEGY.md` §9 sequences them the same way, and the
reasoning behind that order is sound and unchanged: coverage — the ~70% of
deductions a supplier never surfaces — is the thesis, and ERP read plus portal
read are what find them.

But §9 also states the go/no-go for stage 3 as "recovery rate measurable end to
end", and that is the number every other stage is justified by. Coverage without
recovery is a list of things we found and could not act on. And §10 names
approval throughput as "the binding constraint on the whole thesis …
structural" — a constraint nobody has observed once, because no human has ever
approved anything here.

There is a second, blunter constraint. Phases 1.5 and 2 are both multi-week and
both depend on things we do not have: QBO credentials on a customer's ledger,
per-tenant calibration data, playbook facts verified against current retailer
documentation, and Jev early access on a money path. Phase 3, minus the model,
depends on nothing we do not already have. A case exists, its fields are
extracted and quote-verified, its documents are durable, and the gate is built.
The only thing between a stored case and a filed dispute is a decision, a
packet, a human, and a record of what came back.

So: what is the smallest thing that makes a recovery rate measurable? A human
looks at a case and says "dispute this, for this reason". That is a decision. If
it is a decision, it has to be a `decisions` row, because `app.require_approval()`
keys on `approvals.decision_id` joined through `decisions` to the deduction.
There is no other way to reach the far side of the gate, and building one would
be the loosening this project exists to refuse.

## Decision

**Build Phase 3 now, with the dispute decision made by a human, and run one case
end to end. Phases 1.5 and 2 follow, unchanged.** Nothing about the approval
gate, the append-only tables or RLS is weakened. The gate is exercised for the
first time, which is the point.

This ADR records the foundation: the shape of a human decision, the packet
record, the submission and outcome path, the state-machine edges and the store
interface. It writes no UI, no store implementation and no route — those are the
tasks that follow it.

### 1. A human decision is a `decisions` row

`decisions.provider` was checked to `('jev', 'claude-structured')`. Migration
0016 extends it to include `'human'`. A human row looks like this:

| Column | Value | Why |
| --- | --- | --- |
| `schema_id` | `'B'` | Schema B is the validity question — "is this deduction invalid, and should we dispute it" — which is the question the human is answering. `schema_id` says *what was asked*; `provider` says *who answered* |
| `schema_version` | `'human-1'` | The human form is a different form from Jev's B question set, so it carries its own version. Consumers key on `(schema_id, schema_version)`, which is what pinning versions was always for |
| `provider` | `'human'` | |
| `model_version` | `'human'` | The column is `not null`. A human is not a model version, and writing a model's name here would be a lie a later cost query would believe |
| `questions` | the form's fields | The dispute reason (a `CanonicalReasonCode`) and a one-line rationale |
| `result` | the analyst's answers | Same shape a Schema B answer has, so Phase 2 can score a model against what humans decided |
| `raw_probabilities` | `{}` | There are none. An empty object is the honest answer; a fabricated 1.0 distribution would be scored as calibration data |
| `confidence` | `1.0000` | Not a claim about correctness. It records that no model confidence was involved, which is also why a human decision skips EV routing |
| `cost_micros` | `0` | |
| `latency_ms` | `0` | |
| `prepared_by` | the analyst's user id | **Not null for a human row** |

`prepared_by` is the one of these the database enforces, via
`check (provider <> 'human' or prepared_by is not null)`. It is enforced there
and not in the store because
`app.enforce_separation_of_duties()` reads exactly that column: a human decision
with a null `prepared_by` would pass the SoD trigger silently, and the person
who decided could then approve their own decision. The other columns in the
table above are conventions the store applies and the tests assert; none of them
is read by a trigger, so none of them belongs in a constraint.

Separation of duties then applies unchanged, and for the first time it applies to
a real human on both ends: the analyst who prepared the decision cannot approve
it, and only `owner` and `approver` may approve at all.

**Rejected: `schema_id = 'D'`.** D is weekly root-cause analytics
(`packages/decision/src/schemas.ts`). Reusing its letter would make `schema_id`
mean two unrelated things and would quietly corrupt any later query that groups
by it. **Rejected: a fifth letter.** A–D are the four decision points in the
workflow (plan §9); a human deciding validity is not a fifth decision point, it
is a different answerer at the second one.

### 2. The packet is recorded, hashed, and approved by hash

A packet is three things: the case's notice, the evidence documents attached to
it (existing `document_blobs`, referenced by document id), and a cover narrative.

**The narrative is built by our code from extracted fields, deterministically.
No model call.** `STRATEGY.md` §6.3 already argues a dispute narrative is short,
templated and built from structured state we hold; a model-written narrative is
Phase 2 work and would need a recorded cassette for both providers before it
could ship (`CLAUDE.md`, "Workflow"). A deterministic narrative also means the
packet hash is a pure function of the case, which is what makes the next
paragraph work.

The packet's canonical contents are sha256-hashed. Two ways to record it were
considered:

- **(b) The `packet.assembled` `deduction_events` row is the record.** No new
  table. But `payload` is unconstrained jsonb, so the content hash — a
  load-bearing value on a money path — would be a string inside a document with
  no type, no uniqueness and no way to say "this decision has one packet with
  these contents". `deduction_events` is a hash-chained audit trail ordered per
  deduction; finding *the packet for this decision* through it means a scan and
  a jsonb path dig, and the store's "does this submission's packet hash match
  the approval's" check would compare two values neither of which the database
  knows anything about.
- **(a) A new append-only `packets` table.** One more table and one more set of
  policies, against a typed `content_hash bytea`, a real foreign key to the
  decision, and `unique (decision_id, content_hash)` — which turns re-assembly
  idempotence from a convention into a constraint: assembling the same contents
  twice is refused by the database, and assembling *different* contents for the
  same decision is a distinct row that can be told apart from the first.

**(a).** The `packet.assembled` event is still written — it is what carries the
case across the state-machine edge, and the projection must be rebuildable from
the events. The question was only whether the payload is also the record, and it
is not.

`approvals` gains `packet_hash bytea`, nullable, so an approval names the exact
packet it approved. Nullable because a `writeoff` or `writeback` approval has no
packet, and because approvals already exist. `submissions.packet_hash` has
existed since migration 0005.

**The equality check — a submission's packet hash must match its approval's —
lives in the store, not in the trigger.** The trigger's job is the one-way door:
no submission without an approval for that exact decision. Widening it to also
compare hashes would put a second, different rule inside the function every
invariant test is written against, and a bug in the comparison would read as a
gate failure. The gate stays exactly as narrow and as provable as it is.

`packets.file_document_ids` is `uuid[]`, which cannot carry a foreign key. That
is accepted rather than overlooked: a packet's documents are an *ordered* list,
`documents` is append-only and nothing deletes from it, and the ids are inside
the hashed canonical contents, so a substituted or dangling id changes the hash.
The alternative — a `packet_documents` join table — is a second append-only
table with its own triggers and policies to express one ordered list, and can be
added later without changing anything that reads the array.

### 3. Manual submission and outcome

The submission channel for the MVP is `manual_portal`: a human files the dispute
on the retailer's portal and records the confirmation number. `email` follows.
`portal_agent` stays where it is, in Phase 6, behind the same gate.

An outcome is recorded by a human as `won`, `partial` or `lost`, with
`recovered_cents` — an integer, 0 for `lost`, and strictly between 0 and the
deduction amount for `partial`. It is an `outcome.recorded` row in
`deduction_events` plus the case state, which is the projection. **No new
table.** Phase 4 needs attributable recoveries for contingency billing, and the
event stream is where they come from; a table would be a second place for the
same fact to disagree with itself.

The existing `outcome.detected` edges stay. A detected outcome — Phase 5 reading
a remittance and noticing the money came back — is a different fact from a human
typing it in, and the trigger on the edge is what tells them apart.

### 4. The MVP path through the state machine

`packages/core-domain/src/state-machine.ts` carries the human path **without
adding a state**:

| From | To | Trigger | Guard | Workflow |
| --- | --- | --- | --- | --- |
| `classified` | `analyst_review` | `decision.recorded` | `human_decision_recorded` | `decide.human` |
| `analyst_review` | `awaiting_approval` | `packet.assembled` | `packet_assembled_and_submission_safe` | `assemble.packet` |
| `awaiting_approval` | `submitted` | `submission.recorded` | `approval_row_exists` | `submit.packet` |
| `submitted` | `won` / `partial` / `lost` | `outcome.recorded` | `outcome_recorded_by_human` | `record.outcome` |

Only the first and last rows are new; the middle two already existed and are
unchanged. `classified → analyst_review` skips `evidence_pending`,
`evidence_complete`, `decided` and the EV routing fan-out, because a human
decision carries no model confidence and there is nothing for an
expected-value gate to gate on. Those states and edges are untouched and are
what Phase 2 will use.

Two edges may now share a `(from, to)` pair and differ only in their trigger —
`submitted → won` is reachable by `outcome.detected` and by `outcome.recorded`.
So the table's key becomes `(from, to, trigger)`, and `applyTransition` takes any
candidate edge whose guards are met rather than the first one it finds. The
invariant the file exists to prove is unaffected and still asserted: no path
reaches `submitted` or `written_off` without passing through
`awaiting_approval`.

**The table is the spec and the database is the referee** — but the database
only checks that `deductions.state` is one of the fourteen values. It does not
check the edges, and this ADR does not add a trigger that does. Adding one would
be a new gate on a money path, written at the same moment as the path it gates,
with nothing to test it against; the two-referee story (`CLAUDE.md`,
`core-domain`) is about the approval gate, which is already enforced in both
places.

### 5. Roles: what the database enforces, and what the store enforces

| Rule | Enforced by |
| --- | --- |
| Only `owner`, `approver` or `analyst` may write anything | **Database** — `app.member_may_write()` in every `tenant_insert` policy (ADR 0012) |
| Only `owner` or `approver` may approve | **Database** — `app.enforce_separation_of_duties()`, migration 0005 |
| The preparer may not approve their own decision | **Database** — the same trigger, which is why `prepared_by` is `not null` on a human row |
| No submission without an approval for that exact decision on that exact deduction | **Database** — `app.require_approval('submit')`, on INSERT and UPDATE (ADR 0012) |
| A submission's packet hash equals its approval's | **Store** — §2 above |
| An analyst or owner may decide and assemble | **Store** — the database sees both as ordinary writes by a writer, which is correct: a `decisions` row is not an outbound act |
| Any writer may record a submission and an outcome | **Store**, on top of the database's writer check |
| A case is in the right state for the action | **Store** — the state machine is the spec; the database checks only the value |

The pattern is the one the project already has: the database enforces everything
that is one-way — approval, immutability, tenancy, who may approve — and the
store enforces sequencing and consistency on top of it. Nothing the store
enforces can be used to reach the far side of the gate if the store is wrong.

### 6. The interface

`packages/pipeline/src/ports.ts` gains `CaseWorkflowStore` as a **separate**
interface. It does not extend `PipelineStore`: every existing implementation and
every test double would otherwise stop compiling, and the two have genuinely
different lifetimes — the pipeline runs unattended, this one runs behind a
person. All cents are integer `number` (invariant 3). Typed errors for every
refusal the gate or the store can produce, because a money path that swallows a
refusal is the failure mode `CLAUDE.md` names first.

## Consequences

**What this makes easy.** A customer can run one case from upload to recovery,
and a recovery rate becomes measurable — the go/no-go `STRATEGY.md` §9 sets for
stage 3. Approval throughput, named in §10 as the structural constraint, becomes
observable instead of theoretical. Phase 2's model decision arrives into a slot
that already exists and is already exercised, with a corpus of human decisions in
the same `schema_id` to score against. That corpus is not a side effect; it is
the only ground truth a validity model will ever have.

**What this makes hard.** Phases 1.5 and 2 move out by the length of Phase 3, so
coverage — the thesis — is demonstrated later. That is the trade, taken
deliberately: a coverage number with no recovery rate behind it is a claim about
finding things, and this product's claim is about getting money back.

**What we live with.** The first customer's throughput is one human per case,
which is exactly what §8 says does not scale. It is also the only way to learn
what the approval step actually costs. Until Phase 2, a case goes from
`classified` straight to `analyst_review` with no evidence checklist, so the
human is deciding on the notice and whatever they attached — which is what a
deductions analyst does today, and is the baseline the model has to beat.

## Invariants touched

- **1 (no submission without an approval).** Unchanged and, for the first time,
  used. The trigger is untouched; the new `'human'` provider value widens what
  may sit on the *near* side of the gate, not what may cross it. Enforcement:
  `app.require_approval()` in migration 0005, on INSERT and UPDATE since 0010;
  tested in `02_approval_invariant.sql` and again for a human decision in
  `11_a_human_decides.sql`.
- **2 (append-only).** Extended to one more table. `packets` gets the same
  `no_update_delete` / `no_truncate` triggers and the same revoked grants as
  `declined_candidates` (migration 0014). No UPDATE or DELETE grant is added
  anywhere. `approvals` gains a nullable column, which is DDL and changes no
  grant and fires no row trigger.
- **3 (money is integer cents).** `recovered_cents` is a bigint in the event
  payload and an integer `number` at the port. No new float reaches a money path.
- **4 (document content is untrusted).** Strengthened by omission: the packet
  narrative is built by our code from already-extracted, already-quote-verified
  fields. No model reads a document here, so there is no call to construct
  without tools.
- **5 (Jev sits behind `DecisionProvider`).** Untouched. A human decision does
  not go through `DecisionProvider` — there is no provider to call — but it
  lands in the same `decisions` row shape, so the port stays the only way a
  *model* decision is made.
- **6 (RLS on every table).** `packets` carries the four-policy-per-command
  pattern from ADR 0012, keyed on `org_id`, with `app.member_may_write()` on
  every write. Grants are `insert, select` to `app_rw` and `select` to `app_ro`.
  The service role appears nowhere. Tested: another tenant sees no packets.
- **7 (thresholds auto-tighten only).** Untouched. A human decision is not a
  threshold, and nothing here reads or writes `org_settings`.

## Rollback

Reverting the sequencing is a docs change: restore the build order in
`CLAUDE.md`, the README phase table and the `STRATEGY.md` §9 row.

Reverting the schema is a new migration (never an edit to 0016, which is merged
by the time this matters): drop the `packets` table, drop
`approvals.packet_hash`, and narrow `decisions_provider_check` back to
`('jev', 'claude-structured')`. Narrowing the provider check fails while any
human decision exists, which is correct — those rows are the record of a person
authorising a dispute, and a migration that would have to delete them to proceed
is a migration that should stop.

Reverting the state-machine edges is deleting four rows from the table in
`state-machine.ts` and the two guard names. Nothing else reads them.

None of this is a loosening, so rolling it back needs no ADR of its own. Adding
`'human'` to the provider check is the only widening, and it widens the set of
things that may be *prepared*, not the set of things that may be *approved* or
*submitted*.
