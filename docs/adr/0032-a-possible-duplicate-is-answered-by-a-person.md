# 0032 — A possible duplicate is answered by a person

- Status: accepted
- Date: 2026-09-22

## Context

Identity resolution has been deliberately asymmetric since ADR 0025, and ADRs
0028 and 0029 kept it that way as new sources arrived: only an **exact**
identifier match resolves an arrival onto a deduction we already hold. A
`probable` match — invoice number *and* amount in cents *and* a deduction date
within tolerance all agreeing — opens the case anyway and records a
`case.possible_duplicate` event naming the other deduction and the basis that
agreed. An `ambiguous` one opens nothing and says which cases it could be.

The reasoning has not changed and is not reopened here. A duplicate case is
visible: two rows, one deduction, and the money is still disputable. A wrong
merge is invisible: the arrival vanishes into another deduction's row, nothing
records that a second deduction was ever seen, and post-audit claims reach back
about two years, so "quietly" means we find out long after the window closed.

**What has not existed is the other half.** ADR 0025 said so in its own
consequences — "a pair the matcher calls *probable* stops. Nothing in this ADR
builds the queue it stops in" — and named the review surface as the wiring
task's. It was not built. So today a pair is recorded on a hash-chained event
nobody reads, no page shows it, and no person can answer it. The asymmetry is
therefore not currently a *deferral* to a human; it is a deferral to nobody.
Every probable pair the matcher has ever found is still open, and the product
cannot tell a reviewer that two of their cases may be one deduction.

This ADR builds the human half: the pair is shown, and a person answers it.

Two things it is deliberately *not*.

It is **not** a merge. Merging two cases into one is still the remaining half of
STRATEGY §5.2 and still needs its own decision about what happens to the events,
packets, approvals and declines on the losing row. ADR 0025 recorded that as
future work and this does not pre-empt it.

It is **not** a second matcher. Nothing here changes `resolveIdentity`, which
stays deterministic code with no I/O and no model (ADR 0025 §5). What is added
is a record of what a person concluded about a pair the matcher already found.

## Decision

**A verdict is an event on both cases, recorded by a person, and it changes
nothing else.**

1. **Two new event types, and no migration.** `case.duplicate_confirmed` and
   `case.duplicate_dismissed`, on `deduction_events`. That column is
   `text not null` with no check constraint (migration 0004), so unlike
   `documents.doc_type` (ADR 0027) there is nothing for the database to refuse
   and nothing to widen. The table is already append-only, hash-chained,
   RLS-scoped and gated on `app.member_may_write()` for insert, which is every
   property a verdict on a money-bearing case needs. Adding a table or a column
   to hold what one append-only event already holds would be a schema change
   bought with nothing.

2. **Both cases, naming each other.** One event per case, in one transaction,
   each naming the other deduction in `of` and carrying the `basis` copied from
   the `case.possible_duplicate` event that raised the pair. A verdict written
   on one side only would be a pair that is resolved when read from one case and
   open when read from the other, and the case page and the list read from
   different sides. `created_by` is the session's user — `recorded_by` is also
   in the payload, so a reader of the timeline does not have to join.

   The payload names ids, a verdict and a basis. It never carries document text
   (invariant 4): `basis` is the names of the facts that agreed and never their
   values, exactly as ADR 0025 defined it.

3. **One verdict per pair, and corrections are a later event, never an
   update.** A second verdict is refused by name
   (`DuplicateVerdictAlreadyRecordedError`) rather than appended, because the
   pair list is computed as "named and not yet answered" and a second row would
   make the answer depend on which one is read. The check-then-write is made one
   decision by row locks on both cases, taken in id order so two reviewers
   answering two overlapping pairs cannot deadlock — the pattern `declineCase`
   uses on one case, for the same reason: READ COMMITTED lets two transactions
   both read no verdict and both write one, and there is no unique index to
   catch the second.

   Reversing a verdict is a later decision with its own ADR. It is not a gap
   this leaves open by accident: the confirmed set is what a merge operation
   will be built on, and a pair that can be un-confirmed silently is a merge
   that can be un-made silently.

4. **The surviving case is the older one.** A `probable` pair is raised on the
   *arriving* case and names the case we already held, so the older row is
   already the one every identifier and every document points at. The store
   derives it from `created_at` with the id breaking the tie rather than reading
   the direction off the event, so the answer is the same whichever side asks
   and does not change when the planner does.

5. **What "confirmed" does beyond the event: nothing, and the reason is a
   constraint rather than a preference.**

   The obvious v1 — copy the duplicate's identifiers onto the surviving case so
   the next arrival matches exactly — **cannot be written.**
   `deduction_identifiers` is unique on `(org_id, source, identifier_kind,
   identifier)` and append-only (ADR 0025 §3, §8), so the rows naming the
   duplicate are exactly the rows that would collide, and they cannot be moved.
   ADR 0025 recorded this as a known cost in its own words: "an identifier
   attached to the wrong deduction cannot be moved to the right one: the
   corrected row collides with the mistake."

   There are two ways round it and both are refused here.

   - Writing the duplicate's identifier against the surviving case under a
     *different* `source` would make the constraint pass by asserting that a
     channel said something it did not say. That is the misattribution ADR 0024
     exists to prevent, on the table ADR 0025 built to be source-qualified.
   - Matching the invoice number as an exact key would make the copy
     unnecessary, and ADR 0025 §6 refuses it on the merits: one invoice carries
     many deductions, and two deductions taken against one invoice is a real
     shape rather than a duplicate.

   So a confirmation records what a person concluded, and nothing in the
   database moves. **No state change** — `merged` is not added to `CASE_STATES`
   here; that is a state-machine change with a database check behind it and it
   is named as follow-up below. **No row is deleted or hidden**, which
   append-only forbids anyway. **No identifier is written or re-pointed.**

   What it buys today is exactly what is missing: the pair leaves the review
   list, the case page stops warning about it, and the record of which pairs are
   one deduction exists for the merge operation, the coverage exclusion and the
   matcher evaluation to be built on. That is a smaller claim than "it merges
   them", and it is the true one.

6. **A confirmed duplicate still counts in coverage.**
   `coverage_by_period` and `coverage_by_period_channel` (migrations 0014 and
   0023) are unchanged by this ADR and are not read from here. A tenant with a
   confirmed pair therefore has one deduction counted twice in the denominator
   until that is fixed, and it is stated here so the number is known to be an
   over-count rather than discovered as one. Excluding it is follow-up, and it
   belongs with the merge decision rather than in front of it: which row's
   dollars survive is the same question as which row survives.

7. **The read is a read like every other one here.** `possibleDuplicates` runs
   through `PostgresStore` as `app_rw` with the tenant's claims set
   transaction-locally. Both sides of a pair are joined to `deductions`, so a
   pair whose other half this tenant cannot see is not a pair this tenant is
   shown — RLS decides that, not a filter we remembered to write. The service
   role appears nowhere (invariant 6).

8. **A narrow port, next to `CaseWorkflowStore` rather than inside it.**
   `DuplicateReviewStore` carries the read and the verdict. The refusals are
   `CaseWorkflowError` subclasses and the write runs behind the same actor,
   role and visibility checks as the Phase 3 workflow, because it is the same
   kind of act: a person deciding something about money-bearing cases, not the
   pipeline running unattended (ADR 0020 §6).

   It is a separate interface for the reason `UnreadDocumentsStore` is one. A
   pair only exists where `resolveIdentity` ran against a real table of
   identifiers; `InMemoryStore` never produces one, and a required method there
   would be a model of a shape that store cannot create — which is worse than no
   model, because a test would then pass against a system that does not exist.

## Consequences

- A reviewer can see every unanswered pair on the case list, side by side with
  the basis that raised it, and answer it in one click from there or from either
  case's page. Until now the only record was an event nothing read.
- The matcher becomes measurable. How often `probable` is confirmed and how
  often it is dismissed is the number that says whether the tolerance is right,
  and it could not be computed before because the answers did not exist. This is
  the deterministic half ADR 0025 §5 said had to be measured before anyone could
  say what residue is left for a model.
- **An arrival that exact-matches both halves of a confirmed pair is still
  `ambiguous`.** `resolveIdentity` does not know about verdicts, so it answers
  "two matches count as none" for a pair a person has already said is one
  deduction — the arrival is held and no case opens. That is the conservative
  failure and it is not made worse by this ADR, but it is the first thing the
  follow-up should fix: teaching the matcher that a confirmed pair is one
  deduction is a change to a pure function plus one read, and it is the point at
  which a confirmation starts to *do* something rather than only record
  something.
- The pair list is computed rather than stored — "a `case.possible_duplicate`
  with no verdict event answering it". A tenant with thousands of pairs gets a
  capped page, like every other list a person looks at, and no new table falls
  out of sync with the events.
- Follow-up, each needing its own decision: a `merged` case state and what
  happens to the losing row's events, packets and approvals; excluding a
  confirmed duplicate from the coverage denominator; a matcher that reads
  verdicts; and re-pointing identifiers, which needs a migration because
  append-only plus per-source uniqueness forbid it today.

## Invariants touched

- **2 (append-only)** — held and used. A verdict is an insert into
  `deduction_events`, which already refuses UPDATE and DELETE by grant and by
  `app.block_mutations()`, and whose hash chain covers the new rows like every
  other. No grant is added anywhere. A correction is a later event, and this
  ADR says what the only sanctioned one is (§3).
- **6 (RLS on every table)** — held. Both the read and the write run as `app_rw`
  under the tenant's claims. The write additionally asks
  `app.member_may_write()` of the database before it spends anything, and the
  insert policy asks it again regardless. A pair naming a deduction of another
  tenant cannot be read, and a verdict on one is refused as a case that is not
  visible.
- **1 (the approval gate)** — untouched. Nothing here inserts a submission, a
  write-back or a write-off, and nothing here changes a case's state, so no path
  to the gate is opened or widened.
- **3 (integer cents)** — held. The pair list carries each case's amount as the
  column's own text and converts it once through `exactCents`, which refuses a
  value no JS number holds exactly rather than rounding it into a page.
- **4 (documents are untrusted)** — held. The verdict payload carries ids, a
  verdict, a basis and a user, and no text off any page. The claim ids and
  retailer names the list renders are the same untrusted strings the case list
  already shows, escaped by React as text.
- **5, 7** — untouched. No decision provider is involved and no threshold moves.

## Rollback

Delete the route, the component and the two store methods; the events already
written stay, because the table is append-only, and nothing reads them once the
methods are gone. No migration was taken, so there is nothing to undo in the
database and no number is retroactively changed by removing the feature.
