# 0042 — A confirmed duplicate is merged without destroying either row

- Status: accepted
- Date: 2026-09-23
- Amends: ADR 0032 §3, §4, §5, §6; ADR 0025's consequences

## Context

ADR 0032 let a person answer a pair identity resolution refused to merge, and
said plainly that the answer changed nothing: no state moved, no row was hidden,
no identifier was re-pointed. It named what that left open, and all three are
still true today:

- **Both cases stay live.** Either half can be decided, packeted, approved and
  filed, and a reviewer who works the wrong half does the work twice — or files
  the same deduction twice with the retailer.
- **The pair counts twice in coverage.** ADR 0032 §6 recorded the over-count
  rather than fixing it; the coverage page lists these cases as "counted twice"
  and sums them by channel so the error is visible, which is not the same as
  gone.
- **An arrival that exactly matches both halves is held as `ambiguous`**, and
  no case opens for it — for a pair a person has already said is one deduction.

ADR 0025's consequences called merging "the remaining half of STRATEGY §5.2",
needing its own decision about what happens to the losing row's events, packets
and approvals. This is that decision. The founder answered its seven questions
on 2026-09-23 with the recommended answers; they are §2–§8 below.

## Decision

**A merge is one append-only row. The database checks it, moves the state and
writes the events, and nothing is deleted or rewritten.**

### 1. The record: `deduction_merges`

A new append-only table, on migration 0004's pattern (revoke plus
`no_update_delete` and `no_truncate`). Each row is `merge` or `unmerge`, names
the merged-away case (the *loser*) and the surviving one, and records who did it
and when. A `merge` row also records the loser's state before the merge, the
amount both cases agreed on, and the verdict event it rests on; an `unmerge`
row carries none of those. Each side carries the `(org_id, id)` composite
foreign key of ADR 0025 §7, so a row cannot tie one tenant's case to another's.

A unique index on `(org_id, least(a, b), greatest(a, b), action)` is what makes
§5's "once" true in both directions: a pair is merged at most once and undone at
most once, whichever way round it was written.

`deduction_merges_current` is the view every reader uses: merges with no unmerge
of the same pair.

### 2. Which case survives: the one somebody worked on, else the older one

`app.merge_survivor(a, b)` ranks each case by the work on it — **2** if it has
been filed (a submission, write-off or write-back), **1** if it has a decision
or a decline, **0** otherwise — and the higher rank survives. A tie goes to the
older case by `(created_at, id)`, which is the survivor ADR 0032 §4 already
names on the verdict and the one every identifier already points at. Two filed
cases return no survivor and the merge is refused (§4).

The rule is a database function, used by the check and by the store alike, so
there is one answer to "which one survives" and it is the one the database will
accept. **The merge row, not the verdict payload, is authoritative on the
survivor**: ADR 0032 §4 wrote `surviving_deduction_id = older` on every
confirmation, and under this rule the newer case survives whenever only it was
worked on. That payload field is left as written — the events are append-only —
and no reader takes the survivor from it.

### 3. Whose dollars: the two must agree to the cent

A merge whose two amounts differ is refused (`amounts_disagree`). Every pair the
matcher raises already agrees to the cent, because equal cents is one of
`probable`'s three conditions, so this costs nothing today. Where two amounts
differ the second one is often a separate, partial deduction against the same
invoice, and merging it would quietly lose money that could have been disputed.

### 4. Work already done: the loser must not have been filed

**The merged-away case must not have been filed with anybody.** It may carry a
decision, a packet, an approval or a decline — those stay on its row, on the
record, because they are append-only and because they are true: somebody did
decide that, before knowing it was a duplicate. **The survivor may be at any
stage**, filed and won included; absorbing a fresh copy changes nothing about a
filing.

§2's ranking already guarantees the loser is unfiled whenever one of the pair
is. When **both** have been filed, two disputes are live at the retailer and
withdrawing one is a person's job there, not a row here: the merge is refused
(`both_filed`) and the page says so.

### 5. A merge can be undone once, and the undo withdraws the verdict

An `unmerge` row returns the loser to exactly the state it was in, which the
merge row recorded. It is recorded like the merge, by whoever did it.

**The undo also withdraws the "same deduction" verdict.** This amends ADR 0032
§3, which said reversing a verdict needed its own ADR — this is that ADR, and
this is the one sanctioned reversal. Without it an undone pair would be stuck:
the verdict says "one deduction", the pair cannot be merged again (§1's index),
and ADR 0032 refuses a second verdict. So the database appends
`case.duplicate_verdict_withdrawn` on both cases in the same statement as the
undo, and the pair goes back on the list as an open question. A person can then
answer it "different" — which is usually why the merge was undone — or "same"
again, which records the verdict and leaves the pair confirmed but **not**
merged: a pair is merged at most once, so a merge cannot flip back and forth. A
mistaken undo therefore cannot be re-merged; it can still be confirmed, and the
coverage page counts it as it counts every confirmed pair that is not merged.

A verdict now stands until it is withdrawn, and the list, the verdict write, the
merge check, the coverage page and the case page all read that from one view,
`duplicate_pair_verdicts`: the latest of the three verdict events per unordered
pair, where a withdrawal answers "no verdict".

### 6. Who may merge: anyone who can edit cases

Owners, approvers and analysts may merge and undo, through the same
`member_may_write` policy as any other write, and every row records who did it.
Separation of duties (ADR 0020) is not applied: a merge sends nothing anywhere
and moves no money, and the two-person rule is kept for approvals and filings,
where it is what stands between a mistake and a retailer. What this does accept,
knowingly, is that **one person can hide a deduction**: a wrong merge takes the
loser out of coverage and out of matching. It is undoable and it is on both
cases' timelines with a name on it, which is what makes that acceptable.

### 7. One click: "Same deduction" merges

Answering "Same deduction" records the verdict and merges in the **same
transaction** when the pair is eligible. When it is not, the merge half is
rolled back to a savepoint, the verdict stands, and the page says why the two
were not merged. Pairs confirmed before this shipped, and pairs that later
become eligible (for example once another merge is undone), get a Merge button.

### 8. Coverage credits the channel that brought the first copy

`coverage_by_period_by_source` is re-created with the same columns. A
merged-away case leaves `opened`, and its survivor's group — the survivor and
everything currently merged into it — is counted once, **in the month and under
the channel of the earliest notice across the group**. That is ADR 0024's rule
applied to a group rather than a row: the first arrival is how the deduction
reached us, and a later copy is only a copy. A channel's number cannot rise
because it re-sent something another channel had already found. Declines on a
merged-away case leave `declined_count` and `declined_cents` for the same
reason. `coverage_by_period_totals` reads this view and inherits all of it;
migration 0014's `coverage_by_period` is not touched.

This amends ADR 0032 §6: a merged pair is no longer an over-count. A confirmed
pair that is **not** merged still is, and the coverage page's "counted twice"
figure now means exactly those.

Two costs, stated rather than discovered. **A published month can move** when a
merge is recorded: the loser's dollars leave its month, and the group may move
to the survivor's earlier one. `deduction_merges.created_at` is what an as-of
reconstruction would read. And **a declined survivor's channel may differ**: its
`declined_candidates.discovered_from` was fixed from its own notice when it was
declined and is immutable, while `opened` now credits the group's earliest
notice. The same deduction can then sit in one channel's `opened` and another's
`declined`. It needs a merge of a declined case whose copy arrived first through
a different door, and it is left visible rather than patched over.

### 9. The database is the referee, in both directions

This amends ADR 0032 §5: `merged` is added to `CASE_STATES` and to
`deductions_state_check`. It is **closed, not terminal**: it has a way out, and
the way out is an undo. `MERGEABLE_STATES` is every state before a filing, and
`CLOSED_STATES` is the terminal states plus `merged`, which is what "open"
means to every reader.

The state and the ledger cannot disagree:

- **A merge row cannot exist without its state move.** The store inserts one
  row; an `AFTER INSERT` trigger on `deduction_merges` moves the loser to
  `merged` (or back to `state_before` on an undo) and writes the events:
  `case.merged_into` on the loser and `case.absorbed` on the survivor, or
  `case.merge_undone` and `case.duplicate_verdict_withdrawn` on both.
- **A state move cannot exist without its row.** A trigger on `deductions`
  refuses any move into or out of `merged` that the ledger does not back, and a
  case created as `merged`.
- **The row is checked before it lands.** `app.merge_refusal(a, b)` names why a
  pair cannot be merged — `not_confirmed`, `merged_before`, `already_merged`,
  `absorbs_another`, `both_filed`, `amounts_disagree` or `not_mergeable_state` —
  or answers null. The check trigger requires null, requires the row to agree
  with the database on the survivor, the state, the amount and the standing
  verdict, requires `recorded_by` to be the caller, and takes both cases' row
  locks in id order first. The page asks the same function, so the reason it
  shows is the reason the database would give.
- **Nothing more can be hung on a merged-away case.** A trigger on `decisions`,
  `packets`, `submissions`, `writeoffs`, `writebacks`, `declined_candidates`,
  `deduction_documents` and `deduction_identifiers` refuses a new row naming a
  case that is currently merged away. It takes `for key share` on the case
  first, so an insert racing a merge waits for it rather than landing on a case
  that became a loser a moment later. It is named to fire after
  `enforce_approval`, so the gate's own refusals keep their words.

Refusals carry their own SQLSTATEs rather than a message to match on: `RCM01`
for work on a merged-away case (the case id in DETAIL), `RCM02` for a merge or
undo refused (the reason key in HINT), `RCM03` for a state move the ledger does
not back. The store turns the first two into `CaseMergedAwayError` and
`MergeRefusedError`, and a read job treats `CaseMergedAwayError` as
non-retriable — the answer will be the same in thirty seconds and a retry would
pay for the page again. `RCM03` is a bug in whoever moved the state and is
thrown as it comes.

A chain is refused: a case that has absorbed another cannot itself be merged
away until that merge is undone (`absorbs_another`), and a case already merged
away cannot absorb or be absorbed again (`already_merged`). It is a dead end a
reviewer could hit, and it is rare; the alternative is a tree of merges whose
undo order matters.

### 10. Identity afterwards: every reader maps a loser to its survivor

This amends ADR 0032's first consequence. `resolveIdentity` is unchanged: it
already keys exact matches by deduction id, so two identifiers naming the same
id are one `exact` answer. Every store read that feeds it —
`knownIdentifiers`, `identityCandidates`, the ledger sync's
`knownIdentifiers` — maps a merged-away case's identifiers onto its survivor
through `deduction_merges_current`, and so do the three lookups that name an
existing case after a unique constraint fires or a document is already filed
(`explainDuplicateCase`, `explainDuplicateIdentifier`, `caseForDocument`). An
arrival that exactly matches both halves of a merged pair is therefore `exact`
on the survivor, and a remittance line or a ledger re-sync attaches there.
Probable candidates exclude every closed state, `merged` included.

Identifiers are still never moved. One learned while the pair was merged is
written against the survivor, and stays there after an undo — append-only and
per-source uniqueness forbid moving it (ADR 0025 §8). That is a stated cost, not
a bug.

A pair on the review list whose other half is currently merged away is hidden
until the merge is undone: answering it would name a case that is no longer the
deduction.

### 11. What is never touched

No approval, packet, submission, write-off or write-back row is written or
changed by a merge or an undo. The approval gate's triggers are unchanged. No
UPDATE or DELETE grant is added anywhere. No model is involved. Nothing is
copied into the survivor's packet: its page shows the absorbed case and links to
it, and a document that should be filed with the survivor is attached to the
survivor the way any other evidence is.

## Consequences

- A reviewer answers "Same deduction" and the duplicate is gone from every open
  list, from the totals on the case list, from matching and from coverage — and
  still there, marked, with its whole timeline, one click from being put back.
- An arrival that matches a merged pair lands on the survivor instead of being
  held, which is the first time a person's answer to a pair changes what the
  pipeline does next.
- The coverage page's "counted twice" shrinks to the confirmed pairs that could
  not be merged, each of which has a reason on its case page.
- `merged` is a fifteenth state that every state list must know about. The
  state-machine test pins its edges, and a store test reads
  `deductions_state_check` out of `pg_constraint` and asserts it equals
  `CASE_STATES`, so a sixteenth is a change CI insists is made in both places.
- A reader of `deduction_identifiers` that does not map through
  `deduction_merges_current` would try to attach to a loser. The work-refusal
  trigger turns that into a loud, named, non-retriable error rather than a
  silent misfile — which is the intended failure, but it will surface as a job
  failure, and the per-package note in CLAUDE.md says to map.

## Invariants touched

- **1 (the approval gate)** — untouched and not relaxed. The new refusal trigger
  only refuses more, fires after `enforce_approval`, and suites 02 and 07 run
  unchanged. A merged-away case returns only to the state it left, so no path
  reaches a filing without passing `awaiting_approval`, and the state-machine
  test still proves it.
- **2 (append-only)** — extended. `deduction_merges` is append-only by grant and
  by `app.block_mutations()`; a correction is an `unmerge` row. Every event the
  merge writes is an insert into the hash-chained `deduction_events`. The one
  mutable write is `deductions.state`, which was always the projection, and is
  now refused unless the ledger backs it.
- **3 (integer cents)** — held. Amounts are compared as `bigint` in the
  database and never pass through a JS number on the way to the check.
- **4 (documents are untrusted)** — held. Rows and payloads carry ids, states,
  action names and reason keys; no text off any page.
- **6 (RLS on every table)** — held. `deduction_merges` has RLS with the
  tenant policies, the composite foreign keys tie both sides to the row's
  tenant, the two views are `security_invoker`, and everything runs as
  `app_rw` with the tenant's claims. The service role appears nowhere.
- **5, 7** — untouched.

## Rollback

Stop offering the merge (the routes and the buttons) and the rest is inert:
`deduction_merges` stays, append-only, and a case already merged stays merged
until an undo. To take the schema out, a new migration restores 0029's
coverage view body, drops the three triggers on `deductions` and the work
tables, and drops the functions and views; the table and the `merged` state
must stay while any case is merged, because deleting the row that explains a
state is exactly what this ADR refuses. No UPDATE or DELETE is ever the
rollback.
