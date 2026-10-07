# 0072 — A case opened in error is removed, not deleted

- Status: **Accepted** by the founder 2026-10-07. Migration 0044 applied on
  that go to `mozart-preview` and then production, and read back on both: the
  stored statement's md5 equals the file's (`9b76e20e…`), the state check
  admits `removed`, the `removal_is_guarded` trigger is present and its
  function pinned and not definer, both coverage views are `security_invoker`
  with their SELECT grants unchanged, and no `app` function is unpinned. The
  constraint swap went through `execute_sql` as one `do` block (the Supabase
  MCP hangs on SQL containing `drop`), the trigger's `drop … if exists` guard
  was left out (a no-op on a first apply), and the history row holds the
  file's exact text.
- Date: 2026-10-07
- Builds on: ADR 0020 (a case is worked by people, behind a gate), ADR 0042
  (a merged case is closed, not terminal, and counts nowhere), ADR 0070 (a
  person opens a case by hand — and so can open one by mistake)
- Adds, if accepted: one `deductions.state` value (`removed`), one event type
  (`case.removed`), one trigger and one SQLSTATE (`RCR01`). No table, no
  column, no grant.

## The decisions that are the founder's

1. **Accept this ADR**, and apply migration 0044 (preview first). The app code
   writes the new state, so it is **not to be deployed before 0044 is
   applied**: on a database without it, every removal is refused by the state
   check and nothing is written.
2. **Who may remove.** Proposed: an owner or an approver
   (`app.member_is_owner_or_approver()`, from 0040). An analyst may not.
3. **No undo from the app.** Proposed: a removal is final in the product. A
   case removed by mistake is a migration-backed decision, like a wrong
   arrival channel (ADR 0024).

## Context

Since ADR 0070 a person can open a case by hand, and an upload can open a case
for a document that was never a deduction (a test file, a duplicate the
identifier match did not catch, a notice for another supplier). Such a case
sits in the review queue, in the retailer board, in the case tally and in
coverage for ever: there is no way to say "this should not exist".

## Decision

### 1. Why not delete

`deductions` is referenced by `deduction_events`, `deduction_documents`,
`deduction_identifiers`, decisions, packets and approvals, all append-only
(invariant 2). Deleting the case would need DELETE grants nobody may add, and
would erase the record a post-audit reaches back two years for: what arrived,
what was opened, and who decided it was not a deduction. So "delete" in the
product is a state, `removed`, entered once, with an event that names who and
why.

### 2. What `removed` is

Closed, not terminal — like `merged`, it is in `CLOSED_STATES`, so no list of
open work, no total, no matcher and no attach target counts it. Unlike
`merged`, it has no way out: the database refuses any move out of `removed`.

### 3. When a case may be removed

Only from the nine states before a filing (`MERGEABLE_STATES`, 0032's
`state_before`): a filed case is out at a payer and its outcome is a fact. And
not while it is the survivor of a standing merge — removing it would take the
merged-away case's deduction with it; undo the merge first.

### 4. The database is the referee

`app.removal_is_guarded()`, a `BEFORE UPDATE OF state` trigger on
`deductions`, refuses (SQLSTATE `RCR01`, `case removal refused: <reason>`):

- a move into `removed` by a caller who is not an owner or approver
  (`not_owner_or_approver`);
- from any state outside the nine (`not_removable_state`);
- with no `case.removed` event for the case (`no_event`) — the store writes
  the event first, in the same transaction;
- of a standing merge's survivor (`survivor_of_merge`);
- and any move out of `removed` (`irreversible`).

### 5. The claim stays reserved

The case keeps its `claim_id`, debtor and identifiers. Uploading the same
claim again raises `DuplicateCaseError` naming the removed case, and the case
page says it was removed, by whom and when. Re-opening a removed deduction is
not a product action (§3 of the founder's decisions).

### 6. Coverage

`coverage_by_period_by_source` and `coverage_by_period` leave a removed case
out of every column — opened, filed (impossible: no removed case was filed)
and declined. Same columns, same order, `security_invoker`.

### 7. The product

Under each "Open case →" in the review queue an owner or approver sees "Close
case", and a checkbox per row with "Close selected". Both lead to a
confirmation page ("Delete this case?"), which says what removal does and that
it cannot be undone from the app, lists any selected case that cannot be
removed and why, and takes an optional reason (at most 500 characters). One
POST removes up to 100 cases in one transaction, all or nothing.

## Consequences

- A removed case is invisible everywhere a person works, and present in every
  audit read.
- A mistaken removal is not recoverable in the app; that is deliberate.
