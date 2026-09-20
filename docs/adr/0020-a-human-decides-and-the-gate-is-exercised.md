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

`prepared_by` is the one of these the database enforces, and it enforces two
separate things about it:

- **It is there.** `check (provider <> 'human' or prepared_by is not null)`.
  `app.enforce_separation_of_duties()` reads exactly that column, so a human
  decision with a null `prepared_by` would pass the SoD trigger silently and the
  person who decided could then approve their own decision.
- **It is the caller.** `app.human_decision_names_its_author()`, a before-insert
  trigger on `decisions`, refuses a `provider = 'human'` row whose `prepared_by`
  is anyone but `app.current_user_id()` — the same `sub` claim every RLS policy
  and `app.member_may_write()` already key on.

The second is not a refinement of the first; it closes a different hole. A
not-null column that anyone may fill with anyone's id is a forged authorship in
precisely the column the gate reads. Name the approver as preparer and they are
locked out of a case they never touched; name a colleague and the real author is
then free to approve their own decision, which is the one thing separation of
duties exists to prevent. Both are reachable by a store bug as easily as by
malice, and the store is code on the near side of the gate — the same argument
that put the approval rule in a trigger in the first place puts this one there
too. A human decision is written by the person it names, in their own session,
or it is not written.

A *null* `prepared_by` is deliberately left to the check constraint rather than
also raised by the trigger: row-level before triggers run ahead of check
constraints, so raising there would take that constraint's own refusal away from
it and leave the not-null rule proved only indirectly. Each rule keeps its own
name in the error a caller sees, and `11_a_human_decides.sql` asserts both. The
trigger is scoped to human rows: a model decision made by a scheduled job has no
caller to match, and pinning one would break every provider row that is not a
person.

The other columns in the table above are conventions the store applies and the
tests assert; none of them is read by a trigger, so none of them belongs in a
constraint.

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

**The approval references the packet by `(decision_id, content_hash)` as a
foreign key** (`approvals_packet_is_a_real_packet`), not by packet id. A hash
column on its own says only "32 bytes"; without the constraint an approval could
name a hash nothing was ever assembled under, and would read as a record of a
human authorising a packet that does not exist. The composite key is the point:
the approval must name a packet assembled *for that decision*, so a hash
borrowed from another case is refused too. It is `MATCH SIMPLE`, the default,
which is what keeps a null `packet_hash` valid — with any column of the key
null the constraint is satisfied without a lookup, so a `writeoff` or
`writeback` approval and every approval written before this migration stay
valid, and `MATCH FULL` would have broken exactly those.

Not by packet id, for two reasons. The hash is the value that already travels:
`submissions.packet_hash` has held it since 0005, the store's equality check
compares hashes, and adding a `packet_id` beside `packet_hash` would be two
columns naming one packet with nothing holding them in agreement — a second
place for the same fact to disagree with itself. And the hash is the *contents*,
where an id is only a row: an approval that names a hash says what was approved,
which is the question a reviewer asks a year later. `unique (decision_id,
content_hash)` already exists for the idempotence argument above, so the
reference costs no new index.

This is not the gate and does not touch it. `app.require_approval()` is
unchanged, still reads `(decision_id, action_type, org_id)` and still carries
one rule. Declarative referential integrity on the row the gate looks for is the
opposite of widening the function.

`packets` carries one more before-insert trigger,
`app.packet_matches_its_decision()`. The table's three foreign keys say the org,
the deduction and the decision each exist; none of them says they are the same
case, and RLS asks whether `org_id` is mine, not whether `decision_id` is. A row
naming this tenant's org and deduction beside another tenant's decision
satisfies all three and RLS both. `app.enforce_separation_of_duties()` would
still refuse the approval that followed, so this is not a route through the
gate — it is a stored record of "what a human was shown" attached to a decision
another tenant made, and a defence that rests entirely on the *next* trigger is
one trigger deep. The same check the SoD trigger makes for an approval is made
here for a packet, plus the case: a packet is assembled for one decision on one
deduction, and the decision's own `deduction_id` is the referee. It is `security definer` where the SoD trigger is not, deliberately:
RLS would hide another tenant's decision from the lookup, an invisible row reads
identically to a deleted one, and the trigger would answer "no such decision" to
a cross-tenant reference and to a plain RLS violation alike. Reading the two
columns as definer lets each rule give its own answer — this trigger refuses a
cross-tenant *reference*, RLS still refuses a cross-tenant *write* on its own
terms, and the suite asserts both separately.

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

**`written_off` is reachable in the state machine and `CaseWorkflowStore` has no
write-off method, on purpose.** The edge `awaiting_approval → written_off` has
existed since Phase 0 and is not being removed; what is missing is the port
method, because a write-off is an approval action of its own
(`app.require_approval('writeoff')`, `writeoffs`) and it lands with that action
rather than being bolted onto a method that files disputes. The MVP is a case we
fight; a case we decline already has a `declined_candidates` row, which is where
the coverage numerator comes from (`STRATEGY.md`, ADD-1). A port method that
wrote off a case without the writeoff approval would be a second way through the
gate, so the honest MVP has no method at all rather than a partial one.

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
So the table's key becomes `(from, to, trigger)`, and **`trigger` becomes a
required argument to `applyTransition`.** Required, not optional: with the pair
alone, `submitted → won` matches both edges and whichever guard happened to be
set would decide for the other, so a caller holding `outcome_detected` would
move a case no human ever recorded an outcome for and the resulting state would
no longer say which fact moved it. Naming the event is what makes the answer a
function of what actually happened. Two edges sharing `(from, to, trigger)` with
both guards satisfied is a bug in the table rather than a choice to make at
runtime, so it throws instead of picking one.

The invariant the file exists to prove is unaffected and still asserted: no path
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
| A human decision names its *author* as preparer, not merely someone | **Database** — `app.human_decision_names_its_author()`, a before-insert trigger on `decisions` comparing `prepared_by` to `app.current_user_id()`. Not-null alone would let a store write anyone's id into the column the SoD trigger reads (§1) |
| No submission without an approval for that exact decision on that exact deduction | **Database** — `app.require_approval('submit')`, on INSERT and UPDATE (ADR 0012) |
| An approval's packet hash names a packet that was really assembled for that decision | **Database** — the `approvals_packet_is_a_real_packet` foreign key onto `packets (decision_id, content_hash)`, `MATCH SIMPLE` so a null stays valid (§2) |
| A packet's decision is the same tenant's and the same case's | **Database** — `app.packet_matches_its_decision()`, a before-insert trigger on `packets`; the foreign keys say each id exists, not that they are one case (§2) |
| A submission's packet hash equals its approval's | **Store** — §2 above. The database deliberately permits the mismatch, and `11_a_human_decides.sql` asserts that it does, so nobody closes it in the gate's trigger by accident |
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

Two consequences of "every refusal has a name":

- A bad `recoveredCents` raises `InvalidRecoveryAmountError`, a
  `CaseWorkflowError`, and not `RangeError`. `RangeError` is thrown by the
  language itself, so a caller catching it cannot tell a refusal on a money path
  from a bug in the arithmetic above it, and `instanceof CaseWorkflowError` —
  the one check that sorts rules from bugs — would miss it entirely. Invariant 3
  is the reason the refusal exists; it gets a name that says so.
- `WorkflowSubmissionChannel` is `'manual_portal'` and nothing else. `email` is
  what follows (§3) and `portal_agent` is Phase 6, but a union member is a
  promise to every caller, and a caller passing `'email'` today would be refused
  by a store with no way to send one. Widening the type is the one-line change
  that lands with the channel, so a value of this type can never name a way of
  filing we cannot do. `recordSubmission` takes the alias rather than repeating
  the literal, so there is one place to widen.

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
  `11_a_human_decides.sql`. Two constraints are added *around* it — an
  approval's packet hash must name a real packet, and a human decision must name
  its own author — and neither is inside the function. The gate stays one rule.
  `11_a_human_decides.sql` also asserts that the database still permits a
  submission whose packet hash differs from its approval's, so the store's half
  cannot migrate into the trigger without someone deleting a test that says it
  was deliberate.
- **2 (append-only).** Extended to one more table. `packets` gets the same
  `no_update_delete` / `no_truncate` triggers and the same revoked grants as
  `declined_candidates` (migration 0014). No UPDATE or DELETE grant is added
  anywhere. `approvals` gains a nullable column and a foreign key, both DDL,
  changing no grant and firing no row trigger. The foreign key makes `packets`
  a referenced table, so `truncate packets` on its own is now refused by
  Postgres before the trigger is even reached — a second wall, and the suite
  asserts both it and the trigger.
- **3 (money is integer cents).** `recovered_cents` is a bigint in the event
  payload and an integer `number` at the port. No new float reaches a money
  path, and a `recoveredCents` that is not an integer is refused by name
  (`InvalidRecoveryAmountError`, §6) rather than by a `RangeError` a caller
  cannot tell from a bug.
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
  The service role appears nowhere. Tested: another tenant sees no packets, a
  `read_only` member cannot assemble one, `app_ro` may read them and holds no
  INSERT. `app.packet_matches_its_decision()` is `security definer` and reads
  two columns of one decision the caller already named, which is what lets RLS
  keep answering a cross-tenant *write* in its own words (§2).
- **7 (thresholds auto-tighten only).** Untouched. A human decision is not a
  threshold, and nothing here reads or writes `org_settings`.

## Rollback

Reverting the sequencing is a docs change: restore the build order in
`CLAUDE.md`, the README phase table and the `STRATEGY.md` §9 row.

Reverting the schema is a new migration (never an edit to 0016, which is merged
by the time this matters): drop the `approvals_packet_is_a_real_packet` foreign
key, drop `approvals.packet_hash`, drop the `packets` table with its
`app.packet_matches_its_decision()` trigger and function, drop the
`human_decision_names_its_author` trigger and function, and narrow
`decisions_provider_check` back to
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
