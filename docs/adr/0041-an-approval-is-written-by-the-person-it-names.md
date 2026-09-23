# 0041 — An approval is written by the person it names

- Status: accepted
- Date: 2026-09-23

## Context

ADR 0020 §5 lists "The preparer may not approve their own decision" as
enforced by the **database**. What the database actually enforces is narrower.
`app.enforce_separation_of_duties()` (migration 0005) reads two things off the
row it is given: that `decisions.prepared_by` is not `new.approver_id`, and that
`new.approver_id` is an `owner` or `approver` of the org. It never asks who is
writing the row. And the `tenant_insert` policy on `approvals` (migration 0010)
admits any writer, `app.member_may_write()`, which includes `analyst`.

So an analyst who prepared a decision can insert an `approvals` row that names
an approver's user id as `approver_id`, and every trigger passes: the name on
the row is not the preparer's, and it is an approver's. Then the same analyst
inserts the `submissions` row, which `app.require_approval('submit')` now
accepts, because an approval row for that decision exists. Invariant 1 holds to
the letter while separation of duties does not hold at all: one person decided,
"approved", and filed.

The one thing in the way is the store. `approve()` in
`packages/store-postgres/src/workflow.ts` calls `requireCaller(approverId,
tenant.userId)` before it inserts, so the web app cannot do this. That is a
check in code on the near side of the gate, which is the phrase migration 0016
used when it closed the same hole for decisions. A human decision could name
anyone as `prepared_by` until `app.human_decision_names_its_author()` compared
the column to `app.current_user_id()`. `prepared_by` is the column separation
of duties reads on one side, and `approver_id` is the column it reads on the
other. 0016 pinned the first and nothing pinned the second.

## Decision

### 1. A before-insert trigger on `approvals` compares `approver_id` to the caller

Migration 0031 adds `app.approval_names_its_approver()` on 0016's pattern:
`plpgsql`, security invoker, `search_path` pinned to `pg_catalog, public,
extensions`. It refuses, with `restrict_violation`, any row whose `approver_id`
is distinct from `app.current_user_id()`:

```
approval blocked: approver_id <id> is not the caller <id | (no session)>
```

`app.current_user_id()` is the `sub` in the claims the store sets
transaction-locally from the session the server verified. It is the same
identity every RLS policy, `app.member_may_write()` and 0016's trigger already
key on. With both triggers in place, the approver is the caller, the caller is
an owner or approver of the org (SoD's second check, now asked of the real
person), and the caller did not prepare the decision (SoD's first check, likewise).

It does **not** give the table owner a way around it. With no claims set,
`app.current_user_id()` is null and every row is refused, whoever the database
role is. An approval is one person's act, and a job, a script or the SQL editor
that wants to write one has to say whose session it is, in the same claim every
policy reads. The owner can of course drop the trigger, and a migration that
does so needs an ADR. It is not a door that opens by default.

There is no special case for a null `approver_id`. The column is `not null`,
and SoD's membership check already refuses a null before the constraint is
reached. This trigger refuses it too, as "not the caller".

### 2. It runs first, and nothing about the existing triggers changes

Postgres fires a table's row-level `before` triggers in name order, so
`approval_names_its_approver` runs ahead of `enforce_separation_of_duties`.
That order is on purpose. Everything SoD checks is a check on the person the
row names, and when that name is not the caller, those checks describe the
wrong person. A forged approval is reported as forged, whatever else is wrong
with it. Suite 27 pins this with an analyst who names a `read_only` member. That
row breaks both rules, and the refusal is this trigger's.

`app.enforce_separation_of_duties()` and `app.require_approval()` are not
touched: not their bodies, their triggers or their messages. The approval gate
still carries one rule. This is a new trigger beside it, the way 0016's was.

### 3. The store names the refusal

`requireCaller` still refuses first, with `ActorIsNotTheSessionError`. If it
ever does not, the database now refuses, and `approve()` translates that into
`ApprovalAuthorError`, a named `CaseWorkflowError` carrying the database's
words. This mirrors `HumanDecisionAuthorError` on the decide path. It matches
on SQLSTATE 23001 and the substring `is not the caller`. Neither of SoD's
messages contains that substring, so the store's existing mapping of
`PreparerCannotApproveError` and `WrongRoleError` is unchanged. The approve
route rethrows it, as it rethrows everything it does not recognise, because
this can only mean a bug, and a bug on a money path is not a notice.

### 4. The suites that wrote approvals in someone else's name are corrected, not the rule

Nine SQL suites and one TypeScript test inserted `approvals` either as the
analyst's session naming the approver (02, 03, 11) or as the owner with the
analyst's claims or none (07, 10, 12, 13, 19, 25, `coverage-by-period.test.ts`).
Suites 12 and 13 said why in a comment: "inserted as the owner because
separation of duties refuses an approval by the analyst who prepared the
decision." SoD never refused it. It checks the name on the row and not the
session. Those comments are the misunderstanding this ADR corrects. Each setup
now acts as the approver it names, and each refusal it asserts is asserted in a
session where only the rule under test is broken:

- 03's "a read_only member cannot approve" is attempted **as** the read_only
  member naming themselves. An analyst naming the reader would now be refused
  as a forgery before SoD saw it.
- 11's "an analyst who prepared nothing is still not an approver" is attempted
  as that analyst naming themselves. Its packet-hash refusals, which are a
  foreign key and a check constraint and so run after every `before` trigger,
  are attempted as the approver.

## Consequences

**What this makes true.** ADR 0020 §5's row now means what it says. The rule
"the preparer may not approve their own decision" is enforced by the database
against the person writing the approval, not just against the name they typed.
An analyst session, a buggy store or a job holding a writer's claims can no
longer produce an approval for anyone but itself, and an approval for itself
is exactly what SoD judges.

**What it makes harder.** An operator cannot backfill or hand-write an approval
from the SQL editor without setting `request.jwt.claims` to the approver it
names, which amounts to asserting in writing whose act it was. That cost is
intended. If Phase 6 ("careful autonomy") ever writes an approval with no person
behind it, it will meet this trigger. That design needs its own ADR anyway,
because an approval with no approver is a change to what invariant 1 means.

**What it does not touch.** Other columns name a person without the database
checking: `packets.assembled_by` and `deduction_events.created_by`, for example.
`requireCaller` guards both in the store, and neither is read by a gate. They
are the same class of gap with a smaller blast radius. Closing them is separate
work. The approval is the one that separation of duties and invariant 1 are
both built on.

**Existing rows.** The trigger is `before insert` only. `approvals` is
append-only, so no existing row is re-checked or could be rewritten. Production
holds the approvals of the one case taken end to end (2026-09-21), written
through `approve()` and therefore through `requireCaller`. The read-back
compares each approval's `approver_id` with the `created_by` of its
`approval.granted` event.

## Invariants touched

- **1 (approval gate).** Strengthened, not changed. `app.require_approval()` is
  byte-for-byte what it was. What changes is that the row it looks for can only
  be written by the person it names, so "an approval exists" once again implies
  "somebody other than the preparer approved".
- **2 (append-only).** Untouched. A trigger is added to `approvals`, and no
  grant changes: `app_rw` still holds `select, insert` and nothing else, and
  `no_update_delete` and `no_truncate` are unchanged.
- **6 (RLS).** Held. The trigger keys on the same claim the policies do, and it
  reads no table, so it cannot see past them.
- **7 (thresholds).** Untouched. Suite 24's enumeration covers the new
  function's pinned `search_path`.
- **3, 4, 5.** Untouched.

## Rollback

A new migration that drops the trigger and the function reopens the gap, and
it would itself need an ADR. There is no reason to. If an approval ever
legitimately needs to be written by a session that is not its approver, the
answer is a column that names who wrote it, alongside the approver. Taking this
check away is not the answer.
