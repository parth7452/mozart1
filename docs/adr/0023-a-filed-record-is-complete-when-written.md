# 0023 — A filed record is complete when written

- Status: accepted
- Date: 2026-09-21

## Context

ADR 0022 and migration 0017 froze three columns on `submissions`:
`packet_hash`, `confirmation_number` and `submitted_at`. They are the record of
what was filed — the contents that went out, the handle the retailer gave back,
and the date every deadline and, in Phase 4, every contingency fee is counted
from — so `app.guard_immutable_core()` now refuses an update to any of them.
The ADR is explicit that a null counts: the guard compares values, so
`null → 'APDP-99812'` is a change and is refused, and it says so under the
heading "A null may not be filled in later either".

All three columns are nullable. Migration 0005 declared them that way while
`submissions` was a table nothing wrote, when the shape of a filing was not
settled and a `not null` would have been a guess. Phase 3 settled it, and 0017
took away the update — but not the null. The two facts together are the gap
PR #9's review found:

> `recordSubmission` always writes all three, but the schema permits a blank
> filed record and the complement of "you may not fill it in later" is "you
> must supply it at insert".

A row inserted with `confirmation_number = null` is not a filing awaiting its
reference. It is a filing whose reference can never be recorded at all, because
the only statement that could record it is the update 0017 refuses. The same
holds for `packet_hash` — a submission that names no contents, with no way to
ever say what went out — and for `submitted_at`, a filing with no date that
cannot acquire one. 0017 made these rows permanent; it did not make them
impossible. A blank filed record is worse than a missing one: it satisfies
`unique (decision_id, channel)`, so the case reads as filed, and the state
machine has already moved the deduction to `submitted`. Nothing later can
repair it short of a migration.

Today nothing writes such a row. `recordSubmission`
(`packages/store-postgres/src/workflow.ts`) writes all three in one insert,
refuses an empty confirmation number with `ConfirmationNumberRequiredError`
before it gets there, and derives `packet_hash` from the packet it has just
compared against the approval's. That is the store, on the near side of the
gate, and invariant 2's whole argument is that the database is the referee
rather than the store. The sentence ADR 0022 wrote about the update applies
unchanged to the insert: the only thing standing between a blank filing record
and a clean audit is code nobody has written yet.

There is a second, smaller version of the same gap on the same column. The
submit route refuses a confirmation number longer than
`CONFIRMATION_MAX_LENGTH` (120) rather than truncating it, on the grounds that
a reference cut to fit finds nothing and looks like one that would
(`apps/web/lib/notices.ts`). The column is plain `text`, so the database accepts
any length — and since 0017 it accepts it *permanently*. The cap lives in one
TypeScript constant and in nothing the database knows.

## Decision

**For `channel = 'manual_portal'`, the three columns must be supplied at
insert, enforced by a check constraint. A `confirmation_number` on any channel
is capped at 120 characters by a second one.**

```sql
alter table submissions add constraint submissions_manual_filing_is_complete
  check (
    channel <> 'manual_portal'
    or (packet_hash is not null
        and confirmation_number is not null
        and submitted_at is not null)
  );

alter table submissions add constraint submissions_confirmation_number_length
  check (confirmation_number is null or length(confirmation_number) <= 120);
```

Migration 0018 adds exactly these two constraints, drop-then-add inside a
`do $$` block so it is re-runnable, the way 0016 adds a constraint. No grant, no
policy, no trigger, no function: `app.require_approval()` and
`app.guard_immutable_core()` are not edited, and this migration creates nothing
that could edit them.

**Why the constraint is conditional on the channel rather than three plain
`NOT NULL`s.** A table-level `not null` says the column is never null on any
row of any channel, and `submissions.channel` already admits `email` and
`portal_agent`, both of them interfaces whose phases are not built. ADR 0022
flags the first of them by name:

> A future `email` channel might send a dispute and learn its reference
> afterwards; under this rule, that filing cannot acquire its confirmation
> number by an update. […] When `email` arrives it arrives with its own ADR, its
> own migration and a considered answer to "what is the record of a filing whose
> reference comes back a week later".

A `not null` on `confirmation_number` would answer that question now, in the
worst way available: the email channel would have to insert a placeholder to get
its row written, and the placeholder would be frozen by 0017 exactly as a real
reference is — indistinguishable from one, in the column every follow-up reads.
A null at least says "not known". The rule this ADR is actually making is not
"these columns are never null"; it is "a filing recorded by a person who has
already filed is complete when it is written", and `manual_portal` is the
channel where that is true. Putting the channel in the predicate says so in the
database, rather than leaving the reason in prose while the schema states
something broader than anyone decided.

That is also the mistake 0005 avoided, and this ADR is not about to repeat it in
the other direction. Freezing the shape of a filing for a channel nothing writes
is guessing; `manual_portal` is the channel Phase 3 writes through and the only
one whose shape is settled (ADR 0020 §3: a submission is recorded by a human who
has already filed, with what the portal gave back, in one insert). Each other
channel gets its own answer in its own ADR, and finds this constraint's
predicate naming the one channel that was settled rather than a `not null` that
pretends they all were.

Two smaller reasons point the same way. A named check constraint tells a caller
*which rule* refused — `submissions_manual_filing_is_complete` — where three
`not null`s give three unrelated messages for one rule; and the codebase already
has this exact shape in `decisions_human_names_its_preparer` (migration 0016), a
conditional completeness rule keyed on a discriminator column. A check
constraint is also droppable and re-addable by name, which is what makes the
migration idempotent in 0016's style.

**Why the length cap is not conditional.** 120 characters is a fact about the
value, not about the channel: a reference longer than that is one the app will
never render or accept, whatever channel produced it. The predicate is written
`confirmation_number is null or length(…) <= 120` so it binds any channel that
supplies one and stays silent about a channel that does not. The number matches
`CONFIRMATION_MAX_LENGTH` exactly, and `apps/web/lib/notices.ts` now says so, so
the app keeps the sentence a reviewer reads and the database keeps the floor.
This matters more since 0017 than it did before it: an over-long reference that
got past the route — a second caller, a script, a future channel — is one no
update can trim.

**The gate still answers first.** Row-level BEFORE triggers run ahead of check
constraints, so an insert that is both unapproved and incomplete is refused by
`app.require_approval()` in its own words, not by a constraint about
completeness. That ordering is asserted rather than assumed:
`supabase/tests/13_a_filed_record_is_complete.sql` inserts a blank submission
against a decision nobody approved and expects "no submit approval row".

**`status` is untouched**, as in 0022. It has a default and a lifecycle, and it
is not part of the record of what was filed.

## Consequences

**What this makes easy.** "Is this case filed?" and "what was filed?" become the
same question again. A `manual_portal` submission row now carries its contents,
its reference and its date by construction, so a reader never has to decide
whether a null means "not filed yet" (it cannot — the state machine moved the
case to `submitted` when the row was written) or "filed, and we lost the
record". Phase 4's attributable recoveries are attributed against a
`submitted_at` that is both present and unmovable.

**What this makes hard.** A caller that wants to record a manual filing must
have all three values in hand. That is already true of every caller there is:
`recordSubmission` takes `confirmationNumber` and `submittedAt` as required
parameters and reads the hash off the approved packet. A future path that wanted
to record a manual filing before the portal had answered now cannot — and should
not, because 0017 means the row it wrote could never be completed.

**What we live with.** The `email` and `portal_agent` channels remain able to
insert a row with nulls, which 0017 then freezes. That is deliberate — the
alternative is deciding their shape here, before anyone has built them — but it
is a known hole rather than an oversight, and it is the reason suite 13 asserts
the permissive case as well as the strict one: an `email` row with nulls is
accepted today, visibly, so the day someone tightens it they are changing an
assertion rather than discovering an assumption.

**Two places, one number.** 120 is now written in `apps/web/lib/notices.ts` and
in migration 0018. They cannot be kept in step by a type, so they are kept in
step by a comment on each pointing at the other, and by suite 13 asserting the
boundary at 120 and 121 exactly. A cap the database enforces one character
differently from the app is a refusal the reviewer meets with the wrong
sentence; the tests are what stop that drifting.

**Three existing suites now write a complete row.** Suites 02, 07 and 10 each
filed a `manual_portal` submission to get at something else — the one-way door,
the gate on UPDATE, the coverage projection — and each wrote it with columns
missing, because the schema allowed it. They now supply the packet hash, the
reference and the date. No assertion is dropped and none changes sides: the
same statements still expect the same refusals, in the same words, for the same
reasons. What changed is the shape of a row those suites were never about, and
in one place it is a strengthening — 02's "the same decision cannot be
submitted twice on one channel" now writes a filing that is complete, so
`unique (decision_id, channel)` is provably what refuses it rather than the new
constraint standing in front of the rule the test names.

**Migrations are re-runnable, and this one is.** Drop-then-add inside `do $$`,
and `scripts/db-test.sh` applies every migration twice in one run, so the
idempotence is proved rather than claimed.

**No existing row is invalidated.** `ADD CONSTRAINT` validates the table, and
`submissions` is empty everywhere it matters: production carries migration 0015
(CLAUDE.md, 2026-09-19), so it has neither `packets` nor a Phase 3 filing, and
`db:test` builds from nothing. Were a row to exist that violated this, the
migration would fail loudly on the spot — which is the correct outcome, since a
blank filed record is precisely what this ADR says must not be stored.

## Invariants touched

- **1 (no submission without an approval).** Untouched.
  `app.require_approval()` is not edited: no new argument, no new lookup, no
  second rule. A check constraint cannot weaken a BEFORE trigger — it runs
  after one, and only ever refuses more. Suite 13 re-asserts that an insert
  with no approval is refused by the gate, and refused by the gate *first*,
  before completeness is ever considered.
- **2 (append-only).** Strengthened in the direction 0022 pushed. The record of
  an outbound act may not be written blank and may not be rewritten; together
  those mean the row says what happened or does not exist. No UPDATE or DELETE
  grant is added — this migration adds no grant at all — and suite 13
  re-asserts that `app_rw` still holds no DELETE on `submissions`.
- **3 (money is integer cents).** Untouched. No money column is read or
  written; `length()` on a text reference is the only arithmetic here.
- **4 (document content is untrusted).** Untouched. Nothing here reads a
  document. A confirmation number is a person typing what the portal showed
  them, which is why the route bounds it and why the database now bounds it
  too.
- **5 (Jev behind `DecisionProvider`).** Untouched.
- **6 (RLS on every table).** Untouched. No policy is created, dropped or
  altered. Suite 13 runs as `app_rw` under a tenant's claims for the parts that
  are about a member, and as the table owner for the length cap, because a
  constraint binds the owner too.
- **7 (thresholds auto-tighten only).** Not a threshold, but the same
  direction: this change only takes permissions away. 120 is a ceiling matching
  the app's; lowering it later is a tightening, raising it is a loosening and
  needs its own ADR.

## Rollback

Reverting is a new migration (never an edit to 0018 once merged) that drops
`submissions_manual_filing_is_complete` and/or
`submissions_confirmation_number_length` by name, and drops the corresponding
sections of `supabase/tests/13_a_filed_record_is_complete.sql`. Nothing else
follows it: no application code depends on the constraints existing —
`recordSubmission` already supplied all three values and already refused an
over-long reference before either constraint was written — so the revert is a
database-only change.

Dropping either one is a loosening: it hands back the ability to store a filing
record that says nothing, permanently. So it needs its own ADR saying why, which
is the friction ADR 0022 asked for, for the same reason.
