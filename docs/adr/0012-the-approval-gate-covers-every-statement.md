# 0012 — The approval gate covers every statement, and writing needs a writer

- Status: accepted
- Date: 2026-09-18

## Context

A security review of the Phase 1 branch found the first invariant escapable. It
is worth writing down exactly how, because the hole was invisible from the side
the tests were looking at.

`app.require_approval()` is attached `before insert` on `submissions`,
`writebacks` and `writeoffs`. Those three tables are in the *mutable* grant list,
so `app_rw` holds `update` and `delete` on them. The invariant therefore held for
exactly one statement shape:

```sql
-- refused, as designed
insert into submissions (…) values (…);          -- no approval row

-- allowed, and it should not have been
insert into submissions (…) values (…);          -- against an APPROVED decision
update submissions set decision_id = '<unapproved>' where …;
delete from submissions where …;
```

A member could file against an approved decision, repoint the row at an
unapproved one, and end up with a submission no approval ever authorised — or
delete the record of one outright. The same trick on `writeoffs` decouples the
approved amount from the recorded one.

Every invariant suite tested the INSERT path, because that is where the trigger
is. Nothing tested the other two verbs.

The review found a second, related gap. `membership_role` distinguishes `owner`,
`approver`, `analyst`, `read_only` and `accountant_guest`, and the
`tenant_isolation` policies key only on `org_id`. A `read_only` member could
write anything their tenant could write. The role enum was decorative for
authorization everywhere except the approvals trigger, which does check it.

## Decision

**The gate covers every statement.** `submissions`, `writebacks` and `writeoffs`
lose `delete` entirely — a record of an outbound act is not something the
application may remove, and that is the same reasoning that made
`decisions` and `approvals` append-only in ADR 0004. `update` survives only for
the lifecycle columns that legitimately arrive later (a confirmation number, a
status, a QBO transaction id, a submitted timestamp). A column-guard trigger
raises if anything else changes, so `decision_id`, `deduction_id`, `org_id`,
`channel`, `method` and `amount_cents` are immutable once written, and
`require_approval` runs on UPDATE as well so a row can never come to rest
against a decision nobody approved.

**Writing needs a writer.** The single `tenant_isolation` policy per table
becomes four, split by command: SELECT for any member of the tenant, and
INSERT/UPDATE/DELETE additionally requiring `app.member_may_write()` —
membership in the tenant with a role of `owner`, `approver` or `analyst`.
`read_only` and `accountant_guest` can now only read, which is what those names
have always promised.

Splitting by command is what makes this expressible: a single policy's `using`
clause governs both reads and the row-selection half of writes, so a role
predicate in it would have blocked reading too.

## Consequences

A submission's immutable core and its mutable lifecycle are now different things
in the schema, which is a truer description of what they are. Code that wanted to
correct a mis-filed submission must record a new fact rather than rewrite the old
one — and nothing in the codebase wanted to.

Four policies per table instead of one is more to read. The `member_may_write`
lookup adds a `memberships` probe to every write; `memberships` is indexed on
`(org_id, user_id)` as its primary key, so it is a single index hit.

## What this says about the test suite

The suites asserted the invariant through the one verb the trigger covered. An
invariant is a property of the data, not of a statement shape, and the tests now
try every verb that could reach the row — INSERT, UPDATE and DELETE — plus a
`read_only` member attempting each.

## Invariants touched

**1**, restored and widened: no `submissions`/`writebacks`/`writeoffs` row may
exist, be repointed, or be removed without an `approvals` row for that exact
decision.

**6**, extended: tenant isolation now carries the member's role, so authorization
is no longer "any member of the right tenant".

## Rollback

Reverting re-opens both holes. Neither has a legitimate reason to be reverted.
