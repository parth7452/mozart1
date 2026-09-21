# 0022 — The record of what was filed is immutable

- Status: accepted
- Date: 2026-09-21

## Context

Migration 0005 built the one-way door: no `submissions`, `writebacks` or
`writeoffs` row without an `approvals` row for that exact decision and action.
Migration 0010 closed the half of it that was open — the gate fired on INSERT
only while `app_rw` held UPDATE and DELETE, so a row could be filed against an
approved decision and afterwards repointed at an unapproved one. 0010 took
DELETE away, put the gate on UPDATE as well, and added
`app.guard_immutable_core()`: a before-update trigger that refuses a change to
the columns which decide *what was authorised*.

That column list is where this ADR starts. It is

```
id, org_id, deduction_id, decision_id
```

plus one per table: `channel` for `submissions`, `method` for `writebacks`,
`amount_cents` for `writeoffs`. Everything else on the row may be rewritten by
any writer in the tenant — and on `submissions` "everything else" is
`packet_hash`, `confirmation_number` and `submitted_at`.

Those three are not incidental columns. They are the record of what was filed:

- **`packet_hash`** is the contents that went out. ADR 0020 §2 makes the store
  refuse a submission whose packet hash differs from its approval's, deliberately
  keeping that comparison out of the gate's own function so the gate carries one
  rule. The comparison happens once, at insert. A `packet_hash` that can be
  rewritten afterwards makes that check a formality: file the approved packet,
  then set the column to the hash of something else, and the row now says a human
  approved contents nobody approved. Worse, it reads as evidence that they did —
  `approvals.packet_hash` is a foreign key onto a real packet, so the two would
  disagree with no third place to ask.
- **`confirmation_number`** is the only handle anybody has on a dispute sitting
  in a retailer's portal. The submit route already refuses one that is too long
  rather than truncating it, on the grounds that a reference cut to fit finds
  nothing and looks like one that would. A reference that can be rewritten a
  month later is the same failure with a longer fuse.
- **`submitted_at`** is what a dispute deadline and every follow-up are counted
  from, and in Phase 4 it is what a contingency fee will be attributed against.
  A filing date that can be moved is a recovery that can be moved into a
  different billing period.

None of this is reachable by the application today — nothing in `packages/*` or
`apps/web` issues an `update submissions`; `recordSubmission` writes every one of
these columns once, at insert, inside the same transaction as the event and the
state change. The exposure is that the database permits it, and invariant 2's
whole argument is that the database is the referee rather than the store. The
only thing standing between a rewritten filing record and a clean audit is code
nobody has written yet, which is the position this project treats as not having
a rule at all.

`supabase/tests/07_gate_every_statement.sql` even asserts the current permission
explicitly — "a confirmation number can still be recorded after filing" — so the
behaviour is deliberate rather than overlooked. It was the right call while
`submissions` was a table nothing wrote: the shape of a filing was not settled,
and freezing an unused column would have been guessing. Phase 3 settled it. A
submission is now recorded by a human who has already filed, with what the portal
gave back, in one insert (ADR 0020 §3). There is no longer a step in which one of
these three values is not yet known.

## Decision

**`packet_hash`, `confirmation_number` and `submitted_at` join the immutable core
of `submissions`. `status` stays mutable.**

Migration 0017 does it by `create or replace` on `app.guard_immutable_core()`,
adding the three to the `submissions` branch of the column list and changing
nothing else. Every other branch stays byte-identical: `writebacks` keeps
`method`, `writeoffs` keeps `amount_cents`, the shared four stay shared, and the
comparison is still `to_jsonb(old) -> col is distinct from to_jsonb(new) -> col`,
so the function still works for a table that has no such column.

**Why extend that function rather than add a second trigger.** A dedicated
`submissions`-only trigger was the alternative, and it is worse in the specific
way this codebase cares about: the guard's value is that one function is the
answer to "what can never change once written", and a reviewer reads one column
list to know. Two triggers means two lists, two error messages for one rule, and
a fired-order question nobody wants to have to answer (`enforce_approval_on_update`
sorts before `guard_immutable_core` today, and that ordering is what makes suite
07 expect the gate's words rather than the guard's when a row is repointed at an
unapproved decision). The change here is a column list getting three entries
longer, which is exactly the shape the function was written for — 0010's own
comment says "the column list is data rather than three near-identical
functions".

**`status` stays mutable, and that is the whole reason this is a column list and
not a table-level freeze.** `recorded → sent → accepted → rejected` is a real
lifecycle: a dispute is recorded when it is filed and the retailer answers later,
and that answer is an update to a column that describes *where the filing got to*,
not *what was filed*. Freezing it would leave no way to record a rejection short
of a second submission row, which `unique (decision_id, channel)` refuses on
purpose.

**A null may not be filled in later either.** The guard compares values, so
`null → 'APDP-99812'` is a change and is refused. This is deliberate and it is the
one thing in this ADR that costs something. A future `email` channel might send a
dispute and learn its reference afterwards; under this rule, that filing cannot
acquire its confirmation number by an update. The alternative — permit a
transition out of null, refuse every other change — was considered and rejected
twice over. It puts a second, conditional rule inside the function whose entire
merit is that it carries one; and it is a rule with a hole in it, because a row
inserted with nulls is a row whose filing record can still be written by anyone
who can reach the tenant, just once and at a time of their choosing. When `email`
arrives it arrives with its own ADR, its own migration and a considered answer to
"what is the record of a filing whose reference comes back a week later" — very
likely an `outcome`-shaped event rather than a column rewrite, which is what
"corrections are new events" has meant everywhere else here (invariant 2).

**The `search_path` pin is part of the function definition now.** `CREATE OR
REPLACE FUNCTION` assigns every property from the command, so a replacement that
omits `SET search_path` silently drops the pin `0008`/`0010 §4` put there with
`ALTER FUNCTION` — an unqualified name in a security-relevant function then
resolves however the caller pleases. Migration 0017 therefore carries
`set search_path = pg_catalog, public, extensions` inside the definition, the way
every function added since 0012 does, and `supabase/tests/12_*.sql` asserts the
pin is still there rather than trusting that it is.

**Suite 07's assertion changes, and it is a strengthening.** The line that read
"a confirmation number can still be recorded after filing" asserted the
permission this ADR removes. It becomes: `status` alone still moves, and a
rewrite of the confirmation number is refused. No assertion is dropped; one
changes sides because the rule changed, and the new one is stricter.

## Consequences

**What this makes easy.** A `submissions` row is now what it claims to be: a
record of an outbound act, with the same standing as the `approvals` row that
authorised it. Answering "what was filed, when, and under what reference" needs
no `audit_log` cross-check and no argument about whether the row was edited
after the fact. Phase 4's attributable recoveries are attributed against a
`submitted_at` that cannot have moved.

**What this makes hard.** Correcting a typo in a confirmation number now takes a
migration-level decision rather than an `update`. That is the intended cost, and
it is the same cost `channel` has carried since 0010. If it turns out to bite —
a reviewer pastes the wrong reference and the dispute becomes unfindable — the
answer is not to unfreeze the column but to decide, in an ADR, what the record of
a corrected reference looks like. `unique (decision_id, channel)` means it cannot
be a second submission row without also deciding what two rows for one filing
mean.

**What we live with.** The `email` channel, when it lands, cannot record a
late-arriving reference by update. That is written down here so the person
building it meets the rule rather than the rule's absence, and so the loosening —
if that is what they conclude is right — is an argued change and not a quiet one.

**Migrations are re-runnable, and this one is.** `create or replace` is
idempotent by construction, and `scripts/db-test.sh` now applies every migration
twice in a single run so that idempotence is proved rather than assumed: a
migration that is not safe to re-run fails the suite on the spot rather than the
next time somebody points `db:test` at a database that already carries it.

## Invariants touched

- **1 (no submission without an approval).** Untouched, and deliberately not
  extended. `app.require_approval()` is not edited by this migration — no new
  argument, no new lookup, no second rule. The gate still asks one question on
  INSERT and on UPDATE, and `12_the_filed_record_is_immutable.sql` asserts it
  still refuses an update that repoints a submission at a decision nobody
  approved, so extending the guard beside it cannot have displaced it.
- **2 (append-only).** Strengthened. `submissions` is not fully append-only —
  `status` is a projection of where a filing got to — but the part of it that
  records an outbound act now behaves the way `decisions`, `approvals` and
  `packets` do. No UPDATE or DELETE grant is added anywhere; this migration adds
  no grant at all, and `12_*.sql` re-asserts that `app_rw` still holds no DELETE.
- **3 (money is integer cents).** Untouched. No arithmetic and no money column
  moves; `writeoffs.amount_cents` was already frozen by 0010 and stays exactly as
  it was.
- **4 (document content is untrusted).** Untouched. Nothing here reads a
  document.
- **6 (RLS on every table).** Untouched. No policy is created, dropped or
  altered, and the new suite runs as `app_rw` under a tenant's claims for the
  parts that are about a member, and as the table owner for the parts that are
  about the trigger — because a guard that only a grant enforces is a guard that
  the next `grant` undoes.
- **7 (thresholds auto-tighten only).** Not literally in scope — this is not a
  threshold — but the same direction: this change only takes permissions away.
  Restoring any of them needs a human and an ADR, which is the point of writing
  this one.

## Rollback

Reverting is a new migration (never an edit to 0017 once merged) that
`create or replace`s `app.guard_immutable_core()` with 0010's column list,
keeping the `search_path` pin, and restores suite 07's original assertion while
dropping `supabase/tests/12_the_filed_record_is_immutable.sql`.

That revert is a loosening — it hands `app_rw` back the ability to rewrite what a
submission says was filed — so it needs its own ADR saying why, which is the
correct amount of friction for a one-way door being re-opened. Nothing else
depends on this change: no application code path updates a `submissions` row
today, so the revert is a database-only change with no code to follow it.
