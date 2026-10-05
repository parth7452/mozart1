# 0068 — A settlement's journal lines are what the approver approves

- Status: proposed (2026-10-05). Built on `overnight/editable-settlement`.
  Migration 0041 is not applied anywhere; the PR that carries it is not to be
  merged before the founder applies it to `mozart-preview` and then production.
- Date: 2026-10-05
- Amends: ADR 0060 §1 (the settlement entry's lines were always `draftEntries`
  output; they may now be a person's), §2 (a settlement decision carries its
  lines; a decision is superseded by a later one until it is approved), §3 (the
  job sends the stored lines and compares the read-back with them).
  Unchanged: both approval moments, `app.require_approval()`,
  `app.enforce_separation_of_duties()`, the `QBO_POSTING` gate, the
  per-connection switch, the account map, write-once `writebacks`, the request
  id, and that a 5xx is an unknown outcome only a person retries.
- Adds: one migration (0041), one append-only table (`settlement_lines`), a
  `unique (org_id, id)` on `decisions`, and one deferred constraint trigger on
  `decisions` and on the new table. No new outbound side effect: the same
  `JournalEntry`, under the same approval, with lines a person may have
  changed.

## Context

The founder's words: "under each case we show the draft accounting entries
(which can be edited on the Mozart dashboard) and then have a button where
they can say yes or no — if yes, the entry is made within their accounting
platform."

Since ADR 0060 the entries are shown and the button exists, but the lines are
computed twice and stored nowhere a person chose them: `draftEntries` and the
account map give the lines when the approval's `writebacks` row is inserted,
and the job computes them again and refuses to send if the two differ. An
accountant can change the outcome and the map. They cannot change a line: send
the write-off to a different expense account for this one case, split it
across two, or say why in a memo.

Three things about the existing design decide the shape of the edit.

- The approval is an `approvals` row naming a `decision_id`, and `decisions` is
  append-only. What a person approved is therefore whatever that decision row
  pins, and nothing else.
- `writebacks` is unique on `(decision_id, method)`, so one decision posts one
  journal entry, once — and a **second** approved settlement decision on the
  same case would post a second entry.
- The settlement entry's Accounts Receivable line is not free. For a recovery
  it is the debit the payer's own Payment is applied against; for a declined
  case it is the credit the zero Payment applies to the short-paid invoice
  (ADR 0060 §1). QuickBooks also wants a customer on a receivable line and
  takes one receivable line an entry.

## Decision

### 1. Which posting the edit covers

The **settlement entry** only — ADR 0060 §2's moment 2: `recovered` and
`written_off` in one `JournalEntry`, with `found` as well for a declined case
that was never filed.

The **found** entry at filing (moment 1) stays computed. It was checked rather
than assumed to be a different path, and it is: it hangs off the dispute
decision (schema `B`), which is approved together with the packet's hash under
ADR 0020, is two lines whose amounts and accounts the zero Payment depends on,
and has no moment at which an accountant is looking at lines. Editing it would
change what ADR 0020's approval covers; it is not done here.

The zero `Payment` is not a journal entry and has no lines to edit.

### 2. The decision carries its lines

A settlement decision (`schema_id = 'S'`) is prepared **with** its lines.

`settlement_lines`: `org_id`, `decision_id` (composite foreign key to
`decisions (org_id, id)`, ADR 0025 §7's pattern, which needs the `unique
(org_id, id)` this migration adds to `decisions`), `line_no` (1 to 20),
`account_external_id`, `account_name_as_reported`, `account_type_as_reported`,
`debit_cents bigint`, `credit_cents bigint` (both ≥ 0, exactly one above zero),
`memo` (null, or 1 to 500 characters with no control character), `created_by`
and `created_at`. Append-only on migration 0004's pattern; RLS; `app_rw`
SELECT and INSERT, `app_ro` SELECT; the request roles nothing.

**Why a table and not the decision's own `result`.** Putting the lines in
`decisions.result` would have made them immutable with the row for free. The
table was kept because cents stay `bigint` (a JSON number can be `1.5`, and
invariant 3 would then rest on a hand-written check), because each column gets
its own constraint, and because a memo — text a person typed — then lives in
one table that nothing else reads, rather than in a payload that events,
exports and the learning loop will read.

**What makes the table as immutable as the row.** A separate table opens a
hole the payload would not have: lines added to a decision *after* the
approver looked at it. It is closed by the decision pinning its own count.

- The decision's `result` carries `line_count`. `decisions` is append-only, so
  the count cannot change.
- `app.settlement_lines_are_whole(decision)` is the one check: a decision with
  no `line_count` has **no** lines; otherwise it has exactly lines 1 to
  `line_count` (2 to 20), and their debits equal their credits to the cent.
- Two **deferred constraint triggers** run it at commit: one on
  `settlement_lines` (for the decision each inserted line names) and one on
  `decisions` (for each new `S` decision). The second is what stops a decision
  being committed with a count and no lines, to be filled in later.
- So the lines exist, whole and balanced, when the decision's transaction
  commits; a later transaction cannot add one (the count would be wrong),
  change one or remove one (append-only, `unique (decision_id, line_no)`).
- A `BEFORE INSERT` trigger also requires `created_by` to be the caller and
  the decision's own `prepared_by`, the decision to be a person's `S`
  decision, and no approval to exist for it yet.

A decision prepared before this migration has no `line_count` and can never
gain lines.

### 3. An edit after preparing is a new decision, never an update

- **Before approval**, preparing again writes a new decision with its own
  lines. The case's settlement is its **latest** `S` decision; the earlier one
  is superseded and stays on the record. `approveSettlement` refuses a
  decision that is not the case's latest (`superseded`).
- **After approval**, nothing more is prepared: `prepareSettlementDecision`
  refuses a case that already has a settlement decision with a `writeback`
  approval. A second approved decision would post a second entry (above), and
  nothing here can take the first one back. Correcting a posted entry is still
  ADR 0060 §7's: a person reverses it in QuickBooks; an in-app reversal,
  approved like any posting, remains a follow-up.
- Both take the case's row lock, so an approval and a re-prepare of the same
  case cannot interleave.

The approve path is otherwise unchanged. The approval names the decision id;
the decision pins its lines.

### 4. What a person may change, and what they may not

`validateSettlementLines` (`core-domain`, pure, property-tested) is the rule,
and the store applies it against a chart of accounts it reads live — the names
and types stored on a line are the chart's, never the form's.

- 2 to 20 lines; each one side only, positive integer cents; debits equal
  credits.
- Every account is in the chart **and active**. The type is checked as
  QuickBooks reports it, the way a map's is (ADR 0060 §4).
- **The receivable lines are the case's, not the accountant's.** The lines on
  the map's Accounts Receivable account must be exactly the computed ones —
  same account, side and cents — and no other line may be on an account of
  type Accounts Receivable. They are shown and not editable.
- No line on an **Accounts Payable** account (QuickBooks wants a vendor on it,
  and every line of ours names the customer) or a **Bank** account (ADR 0060
  §1: we never debit a cash account, and an entry that touched one would
  invent a receipt or a payment).
- The entry moves no more than the computed entry does: total debits ≤ the
  computed total. Splitting a line or netting two keeps or lowers it; adding
  an unrelated pair of lines raises it and is refused.
- The write-off recorded in `writeoffs` stays `A − R` from the outcome,
  whichever accounts the lines put it on. It is a fact about the case.

The first rule set is deliberately wide on accounts and narrow on amounts.
Narrowing accounts to the map's own plus the reason-family write-off accounts
is one line (`SETTLEMENT_ACCOUNT_POLICY`), and is the founder's call below.

### 5. The memo

A line's memo is bounded text **typed by a person** on the prepare form: at
most 500 characters, no control characters, trimmed. It is not document text
(invariant 4): nothing reads it off a page and no model writes it. The draft's
`Payer reason as printed:` memo is still never posted.

It reaches QuickBooks as that line's `Description` (the memo column of a
journal entry line). A line with no memo keeps today's description. The
entry's `PrivateNote` stays ours — case id, reason family, reference — because
that is how a posting is traced back.

It reaches nothing else: not an event, not `audit_log`, not
`writebacks.lines` (account ids, sides and cents only, as before), not a log
line, and not a URL — the form is a POST, and when a refused form is sent back
to be corrected the amounts and accounts travel in the redirect and the memos
do not.

### 6. Posting sends the stored lines

- When the approval's `writebacks` row is inserted, its `lines` are the
  decision's stored lines (account, side, cents, in `line_no` order), not a
  computation.
- The job builds the `JournalEntry` from the stored lines and their memos. It
  never calls `draftEntries` for such a decision. It still refuses
  (`lines_changed`) if what it built differs from the row's copy.
- The read-back compares the posted entry with the stored lines: each line's
  account, side and cents, in order, and the customer — as before. **The memo
  is not compared.** It carries no money, and a difference in how QuickBooks
  stores text must not turn a posted entry into a failed row that a retry
  would then find and fail again.
- **Fallback.** A settlement decision with no stored lines — one prepared
  before migration 0041 — is posted from the computed lines exactly as ADR
  0060 built it. So is every found entry (§1).

### 7. The page

The draft-accounting card on a case becomes the prepare form for a member who
may write, on a deployment and connection that post. How the case settled is
chosen first (a GET round trip, prefilled from the recorded outcome); the
computed lines are then shown pre-filled: an account `<select>` over the
connection's chart, debit and credit as text read by `parseMoneyToCents`, a
memo, totals, **Reset to computed**, and Prepare. No script: totals are
rendered by the server, and a form that does not balance comes back with what
was entered and the two totals stated.

The chart is read through the Books read (ADR 0066) and only where the form is
drawn. A member the database would not let write is never shown the form, and
the read is made `withoutRefresh` for any member whose refresh could not be
stored.

The approver sees the stored lines, what differs from the computed ones
("account on line 2, memo on line 2"), and the existing approve button.

Any member who may write may prepare and edit; the approver — never the
preparer — is the gate.

## Invariants touched

1. Exercised, not changed. The approval gate and separation of duties are
   untouched; what an approval covers is now pinned line by line.
2. `decisions` gains a unique constraint and a deferred constraint trigger
   that reads; `settlement_lines` joins the append-only set. No UPDATE or
   DELETE grant is added.
3. Cents are `bigint` in the table and integer cents in code; the form's text
   goes through `parseMoneyToCents`. No float.
4. A memo is a person's typing, never document text, and no model sees it.
6. RLS on the new table; every write is made as `app_rw`.

## Options not taken

- **Lines in `decisions.result`.** Above (§2).
- **Updating lines until approval.** An update is what append-only forbids,
  and it reopens the race where the approver approves what they did not see.
- **A same-transaction test by `xmin` or by timestamp** to stop late lines.
  The count pinned in the decision is exact and needs no assumption about
  clocks or transaction ids.
- **Comparing the memo in the read-back.** Above (§6).
- **Letting the receivable line be edited.** The payment application depends
  on it.
- **Editing the found entry.** Above (§1).

## Consequences

- A person can now send a write-off to an account the map does not name. The
  approver sees which, and the stored line keeps the account's name and type
  as the chart reported them that day.
- A case whose settlement was approved cannot be re-prepared. Before this ADR
  the store did not refuse that, and a second approval would have posted a
  second entry.
- Preparing needs the chart: when QuickBooks cannot be read, nothing is
  prepared and the page says so.
- The first posting ever made will exercise this path. ADR 0060 §5's sandbox
  run is still waived; `docs/VERIFY-CHECKLIST.md` §13 is the click-through.

## What the founder decides

1. **Which accounts an edited line may use.** Built: any active account in the
   chart except Accounts Receivable, Accounts Payable and Bank types.
   Alternative: only the map's accounts and the reason-family write-off
   accounts.
2. **The memo's maximum length.** Built: 500 characters.
3. **Who may edit.** Built: any member who may write, since the approver is
   the gate. Alternative: owners and approvers only.
4. **Whether amounts may change at all**, or only accounts and memos. Built:
   amounts may change, the receivable lines excepted, and the entry may not
   move more than the computed one.
