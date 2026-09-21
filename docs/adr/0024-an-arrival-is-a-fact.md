# 0024 — An arrival is a fact

- Status: accepted
- Date: 2026-09-22

## Context

`uploads` has been in the schema since migration 0003 and was written by nothing
until 2026-09-21. `ingestDocument` now writes one row per arrival of new bytes —
`source` taken from the door the bytes came through, `created_by` the signed-in
member for an upload and null for an email — and `documents.upload_id` names it.
Off the back of that, `declineCase` stopped taking `assumedDiscoveredFrom` from
whichever route happened to be calling and started **deriving**
`declined_candidates.discovered_from` from the case's own notice. A case whose
notice records no arrival is refused by name rather than counted under a guess.

That made `uploads.source` load-bearing for a number, and it exposed where the
column lives. Migration 0006 sorts every table into two lists. The append-only
one — `documents`, `document_scans`, `document_classifications`,
`deduction_events`, `audit_log`, `decisions`, `approvals` — gets `revoke all`
then `grant insert, select`, and 0004 puts `no_update_delete` and `no_truncate`
on `app.block_mutations()` over the top. The mutable one — `organizations`,
`users`, `memberships`, `org_settings`, `debtors`, `debtor_aliases`,
**`uploads`**, `deductions`, `submissions`, `writebacks`, `writeoffs` — gets
`select, insert, update, delete` to `app_rw` and no trigger at all.

`uploads` is on the wrong list, and it was on the right one while nothing read
the column. It is not the right one now:

- **`declined_candidates` is append-only and `coverage_by_period` groups by
  `discovered_from`.** A decline cannot be corrected; the row that decided what
  it says can be. An `update uploads set source = 'erp_sync'` re-labels which
  channel found a deduction *after* every decline attributed to it has been
  counted, and moves a published coverage number with nothing anywhere recording
  that anything moved. No `audit_log` row is written on any `uploads` path — that
  table is written deliberately, by code, and no code writes it here — so the
  before and after are indistinguishable by inspection. The column reads exactly
  as it would have read if it had always said that.
- **`created_by` is the same shape of fact.** It is who put a document in front
  of the pipeline. Rewriting it moves an act between people.
- **`received_at` is when something reached this tenant**, which is the first
  timestamp in a case's history and the one a "how long did this take" number
  would be counted from when anybody asks.

None of the three is reachable from the application: nothing in `packages/*` or
`apps/web` issues an `update uploads` or a `delete from uploads`, and
`recordUpload` inserts and returns. The exposure is that the database permits it,
and invariant 2's whole argument is that the database is the referee rather than
the store — "the only thing standing between a rewritten record and a clean audit
is code nobody has written yet" is the position this project treats as not having
a rule at all (ADR 0022 said it about `submissions`; it is the same sentence).

`docs/STATE-OF-PLAY.md` carries this as follow-up 2 of the two that
provenance-at-ingest left behind. Follow-up 1 is the other half, and it is
decided here too, because freezing the table is what settles how it has to be
answered.

## Decision

### 1. `uploads` joins the append-only set

Migration 0019 revokes `update, delete, truncate` on `uploads` from `app_rw` and
`app_ro`, grants `insert, select` to `app_rw` and `select` to `app_ro` — which is
what they already effectively hold for reading, restated so the end state is
written down in one place rather than inferred from 0006 minus this — and adds
the two triggers 0004 puts on every other append-only table:

```
no_update_delete  before update or delete  for each row        app.block_mutations()
no_truncate       before truncate          for each statement  app.block_mutations()
```

Same function, same names, same shape. Nothing is invented here: this is
`uploads` moving from one of 0006's arrays to the other, expressed as the
statements that array would have executed.

**Why the triggers and not just the revoke.** The grant answers for `app_rw` and
`app_ro`. It does not answer for the table owner, which is the role migrations
run as, the role a Supabase SQL-editor session runs as, and the role anybody with
the database password gets — grants and RLS are both bypassed there. 0004's
pattern is a revoke *and* a trigger for exactly that reason, and a trigger is also
what survives the next `grant all` somebody writes in a hurry. Following the
pattern rather than half of it is the whole point of there being one.

**No gate function is touched.** `app.require_approval()`,
`app.guard_immutable_core()` and `app.member_may_write()` are not read, replaced
or referenced by this migration. `app.block_mutations()` is used, not redefined.
No grant is added to any table; the only `grant` statements restate INSERT and
SELECT, which `app_rw` already had.

**RLS is left exactly as 0010 wrote it.** `uploads` keeps `tenant_read`,
`tenant_insert`, `tenant_update` and `tenant_delete`. The last two now govern a
statement the grants and the trigger both refuse, which is harmless and is how
`declined_candidates` has looked since 0014. Dropping them would be a second,
separate way of saying the same thing, in a place a reader does not expect to
find it; the trigger is the answer and it answers for every role.

### 2. A correction is a new arrival — and for `uploads` that is a dead end, plainly

Everywhere else in this schema, "append-only" comes with "corrections are new
events", and the new event is reachable: a second `document_scans` row is the
current verdict because `document_state` reads the latest one.

`uploads` has no such reading. The document names the arrival, not the other way
round, and `documents` has been append-only since 0004 — `upload_id` cannot be
repointed by anyone, including the owner. So a second `uploads` row saying the
right thing is a row nothing joins to and nothing counts. **A source recorded
wrongly at ingest cannot be corrected at all after this migration, in place or
otherwise, short of a further migration.**

That is stated rather than softened because it is the honest reading, and it is
the *same dead end* `ProvenanceUnknownError` already names to a reviewer: "it
cannot be declined until a migration adds a way to record its arrival". The
correction path for a channel that is wrong is a migration-backed one, and this
ADR is one of those.

The cost is small, and it is worth naming why. `uploads.source` is not typed by a
person and is not read off a document: `ingestDocument` sets it from the entry
point — `web_upload` in the upload route, `email_in` / `email_body` in the
Postmark handler — so a wrong value is a bug in three lines of orchestrator code,
not a typo an operator made. The fix for a bug is a fix and a backfill argued in
its own ADR, which is where a mass re-labelling of a coverage dimension belongs
anyway.

### 3. Pre-provenance documents: `document_arrivals`, adopted

The documents stored before 2026-09-21 have `documents.upload_id` null. Their
cases cannot be declined and, because §2 freezes the only other lever, nothing
about this migration changes that on its own. Three ways to change it were
considered.

**Rejected: a nullable `uploads.document_id`.** It is the same link pointing the
other way, so the two can disagree and nothing says which wins. It is the wrong
cardinality on its own terms — one inbound email with three attachments is one
arrival and three documents, and a single column is wrong the first time
`email_in` carries two files. And it could not be filled in anyway: `recordUpload`
runs *before* the bytes are stored, deliberately (a `documents` row naming an
`uploads` row that is not there would be a document with no provenance, and the
other order can only leave an `uploads` row nothing points at, which nothing
counts). A column on the frozen table that is null at insert and frozen
thereafter is a column that is always null.

**Rejected: deferring.** The refusal a reviewer already meets promises this
migration in as many words, and the pre-provenance documents are precisely the
ones the first coverage number would be computed over. Leaving them undeclinable
does not make coverage incomplete-and-visible, which is the trade `declineCase`
took; it makes a set of cases that cannot be moved at all.

**Adopted: `document_arrivals`.** A small append-only mapping — at most one row
per document, saying *this stored document came from that arrival*, recorded
after the fact and marked as such by construction:

```
document_arrivals (
  id, org_id,
  document_id   references documents(id),   unique
  upload_id     references uploads(id),
  recorded_by   references users(id)  not null,
  detail        text,
  recorded_at   timestamptz not null default now()
)
```

Five properties make it a record of an assertion rather than an invention of
provenance, and each is enforced rather than documented:

1. **It may only be written where nothing is known.** A `before insert` trigger,
   `app.arrival_only_when_unknown()`, refuses a row whose document already has an
   `upload_id`. It is therefore never an override: what ingest recorded remains
   the only answer for every document ingest recorded anything about, and §2's
   dead end stays a dead end.
2. **It is written once.** `unique (document_id)` — a second assertion about the
   same document is refused, not stacked. With the append-only triggers on the
   table, that means the first answer is the only answer.
3. **It names who asserted it.** `recorded_by` is `not null`, and the `uploads`
   row it points at is inserted by the same operator with `created_by` set to
   them. An arrival recorded at ingest by an email has a null `created_by`; one
   asserted afterwards never does.
4. **One tenant.** The same trigger checks that the document and the upload are
   both this `org_id`. The foreign keys say each id exists, not that they are one
   tenant's — the point `packets` already has to make.
5. **The channel is typed by a person, never defaulted.** `pnpm link:provenance`
   requires an explicit `--source` and has no default. The fact that would
   justify a value — `ingestInboundEmail` has never had a production caller, so
   every pre-provenance production document arrived by web upload — is an
   assertion about *this deployment*, not a derivation from anything in the
   database. It is written here, in an ADR, and it has to be typed out by the
   operator at the point of use. A default would turn "we know because we know
   the deployment" into "the database said so".

`uploads.received_at` for an asserted arrival is set to the document's
`created_at` rather than left to `now()`. When the bytes were stored is a fact the
database holds and is the closest thing to when they arrived; `now()` would be a
statement about when somebody ran a script, in a column that means something
else.

The derivation in `declineCase` becomes `coalesce(direct.source,
asserted.source)` over the case's earliest notice — one extra pair of left joins,
onto a table with a unique index on `document_id`, so no row multiplies and the
"earliest notice wins, `doc.id` breaks the tie" rule is untouched. Which notice
is picked does not change; only whether the one that was picked can answer.

`recordDocumentArrival` in `PostgresStore` writes all of it in one transaction as
`app_rw` under the tenant's claims — the `uploads` row, the `document_arrivals`
row, and a `document.provenance_recorded` event on every case the document is
attached to, so a case's own timeline says that its provenance was supplied by a
person on a date rather than having been there all along.

## Consequences

**What this makes easy.** The channel that found a deduction is now a fact with
the same standing as the deduction notice itself. A coverage number grouped by
`discovered_from` cannot be moved after it is published without a migration, and
the pre-provenance cases have a way — one way, with a person's name on it — to
become declinable.

**What this makes hard.** A wrong `uploads.source` is uncorrectable in place; see
§2 for why that is a small cost and where the real fix would live. And an arrival
asserted by mistake is uncorrectable too: `unique (document_id)` plus append-only
means the first `document_arrivals` row for a document is the last one.
`--dry-run` exists for that reason, and the script prints the exact channel it is
about to assert for each document before it writes anything.

**What we live with, and it is the one that could mislead somebody.** A
`declined_candidates` row attributed through an asserted arrival is
*indistinguishable, in `declined_candidates`*, from one derived at ingest. Both
carry a plain `discovered_from`. What tells them apart lives elsewhere: the
`document_arrivals` row (who, when, and whatever they wrote in `detail`), the
`uploads` row's `created_by`, and the `document.provenance_recorded` entry on the
case's own timeline. Anyone computing a coverage number over a period that
includes the pre-provenance documents should know to ask, and this paragraph is
where they are told to. Adding a column to `declined_candidates` to carry it was
considered and not done: that table is append-only, the rows already written
could not acquire the new column's value, and a column that is null for every
historical row and meaningful for the next one is worse than a sentence here.

**Migrations are re-runnable, and this one is.** `scripts/db-test.sh` applies
every migration twice in a single run. Every statement here is `create or
replace`, `create table if not exists`, `drop trigger if exists` + `create
trigger`, `drop policy if exists` + `create policy`, or `create unique index if
not exists`; the revoke and the grants are idempotent by nature. Suite 14 reads
the end state back after the second pass rather than assuming it.

## Invariants touched

- **1 (no submission without an approval).** Untouched. `app.require_approval()`
  is not read or replaced, no trigger on `submissions`, `writebacks` or
  `writeoffs` is added, dropped or reordered, and nothing here can reach the
  gate.
- **2 (append-only).** Extended, which is the ADR. `uploads` joins the list, and
  `document_arrivals` is created as a member of it rather than added to it later.
  No UPDATE or DELETE grant is created anywhere by this migration; the only
  grants issued are INSERT and SELECT, to roles that already read these rows.
  CLAUDE.md's enumeration of invariant 2 gains `uploads` in the same change, so
  the prose and the schema do not drift.
- **3 (money is integer cents).** Untouched. No money column is read or written;
  `declineCase`'s `exactCents` path is not edited.
- **4 (document content is untrusted).** Untouched, and deliberately reinforced:
  the `--source` an operator types is an argument, never a value read out of a
  document. Nothing here opens a document, and no model is called.
- **5 (Jev behind `DecisionProvider`).** Untouched.
- **6 (RLS on every table).** Honoured. `document_arrivals` gets RLS enabled and
  the same four policies 0010 gives every org-scoped table — `tenant_read` on the
  org claim, and `tenant_insert` / `tenant_update` / `tenant_delete` on the org
  claim plus `app.member_may_write()`, so a `read_only` member is refused an
  insert by the policy before the grants are consulted. `uploads`' own policies
  are not edited. The service role appears nowhere: `link:provenance` resolves the
  org and the member with the admin connection and then writes through
  `PostgresStore` as `app_rw`, the way `link:retailer` does.
- **7 (thresholds auto-tighten only).** Not literally in scope. Same direction:
  this change only removes permissions. Restoring any of them needs a human and
  an ADR, which is what this one is.

## Rollback

Reverting is a new migration — never an edit to 0019 once merged — that drops the
two triggers on `uploads` and re-grants `update, delete` to `app_rw`, and, if the
mapping is to go as well, drops `document_arrivals` and
`app.arrival_only_when_unknown()` and restores `declineCase`'s derivation to
`uploads.source` alone. `supabase/tests/14_an_arrival_is_a_fact.sql` goes with
it.

The first half of that revert is a loosening — it hands `app_rw` back the ability
to re-label which channel found a deduction after the declines attributed to it
were counted — so it needs its own ADR saying why, which is the right amount of
friction for a one-way door being re-opened. The second half would additionally
strand any `document_arrivals` rows already asserted; because they are the only
record that a channel was supplied by a person rather than observed, they should
be exported before they are dropped, and the revert ADR should say where to.
