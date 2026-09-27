# 0060 — A deduction's accounting is posted to QuickBooks, one approval per decision

- Status: proposed (2026-09-27). Nothing here is built: no code, no migration.
- Date: 2026-09-27
- Amends: ADR 0020 (a case may carry a second human decision, the
  settlement), ADR 0036 (the ledger reader learns the shape our own postings
  leave), ADR 0033/0039 (the QuickBooks client, read-only today, gains writes)
- Moves: Phase 4's write-back ahead of Phases 1.5, 2 and 2.5, the way ADR 0020
  moved Phase 3. Contingency billing stays in Phase 4.
- Adds, if accepted: the first outbound write to a customer's books, one
  migration (the next free number: 0037 at the time of writing, because
  `docs/plans/build-now/04-spreadsheets.md` claims 0036; re-check before taking
  it), one append-only table, and a per-connection switch that is off by
  default

## Context

Customers book recoveries by hand. Tonight's
`packages/core-domain/src/journal.ts` (build-now 03) drafts the entries in
integer cents for three stages, `found`, `recovered` and `written_off`, against
`DEFAULT_ACCOUNT_MAP`, and labels them "Draft — not posted". The founder wants
them posted, beginning to end, with one approver button at each decision point.

- Migration 0005 created `writebacks` and `writeoffs` for this. Since 0010,
  `app.require_approval()` refuses any statement on either unless an
  `approvals` row exists for that exact `decision_id` and action (`writeback`,
  `writeoff`). `approvals` is unique on `(decision_id, action_type)`.
  `writebacks` is unique on `(decision_id, method)` and carries `status`,
  `qbo_txn_id` and `request_id`. `writeoffs` is unique on `decision_id`.
  Neither can be deleted.
- `packages/qbo` only reads: `client.ts` sends GETs with a fresh `Request-Id`
  each and refreshes tokens under `withRefreshLock` (ADRs 0039, 0046).
- The one scope we ask for, `com.intuit.quickbooks.accounting`, already grants
  write, and Intuit offers no read-only accounting scope. "Read-only" is true of
  our code, not of the customer's grant.
- An outcome is an `outcome.recorded` event, not a decision (migration 0016),
  so a recovery or write-off has no `decision_id` to be approved against.

## Decision

### 1. Three postings, from the drafts

No model is involved. The amounts are `draftEntries` output in integer cents,
where A is the case amount and R is the recovered cents.

| Posting | QuickBooks entities | Lines |
| --- | --- | --- |
| **Found** (approved with the filing) | `JournalEntry`, then a zero-total `Payment` applying its credit to the short-paid invoice | Dr Deductions Receivable A / Cr Accounts Receivable A (customer = payer) |
| **Recovered** (won, or part of a partial) | One settlement `JournalEntry`, then an update to the payer's existing `Payment` applying R to that entry | Dr Accounts Receivable R (payer) / Cr Deductions Receivable R |
| **Written off** (lost, rest of a partial, declined) | The same settlement `JournalEntry` | Dr write-off account for the reason family (A − R) / Cr Deductions Receivable (A − R) |

- **A JournalEntry, not a CreditMemo, for found.** A credit memo needs an
  item, cuts sales and sales-tax figures, and concedes the deduction before it
  is fought (ADR 0036 reads one as a write-off). A journal entry moves the
  balance to an asset and nothing else. The zero Payment closes the invoice
  against that credit, so aging does not show both.
- **We never debit a cash account.** The draft's `Dr Cash R` becomes Dr AR in
  our entry, and the customer's own recorded Payment is then applied to it. The
  books end where the draft says. We never create a Payment that carries money,
  because that invents a receipt the clerk also records. The applied payment's
  id is also the ledger evidence that a recovery can be billed.
- **Each settlement is one entry**, because `writebacks` admits one row per
  method per decision. A partial is one entry with three lines.
- **A declined case** was never filed, so its found posting never happened. Its
  settlement entry carries both drafts' lines: four lines, where Deductions
  Receivable nets to zero, plus the zero Payment. If a filed case's found
  posting did not succeed, the case gets no settlement posting, and its draft
  stays on the page to be booked by hand.
- **Memos and dates.** A memo holds the case id, the canonical reason and our
  reference. The draft's `Payer reason as printed:` is text from the page
  (invariant 4) and is never posted. A posting is dated the day it is approved
  and never back-dated.
- **Invoice and customer.** A ledger case has both from the sync's identifiers.
  Any other case gets them only when the preparer picks the invoice from a live
  read, and that choice is stored in the decision's `result`, so the approval
  covers it. Text from a document never selects a ledger record (ADR 0019).

### 2. The gate: two approval moments

Every posting is one `writebacks` row per QuickBooks entity, and every write-off
is also a `writeoffs` row. The database refuses both without the approval.
Neither `app.require_approval()` nor `app.enforce_separation_of_duties()` is
touched.

- **Moment 1: file the dispute and post found.** This is the existing approve
  card on the dispute decision (schema B, `provider = 'human'`). When posting is
  on, its one button writes the `submit` and `writeback` approvals in one
  transaction, and its label says both.
- **Moment 2: confirm the outcome and post it.** Whoever records the outcome,
  or declines the case, prepares a **settlement decision**. It is a `decisions`
  row with `provider = 'human'`, the new `schema_id = 'S'`, and `result = {outcome,
  recovered_cents, family, invoice_id, payment_id?}`. Another member approves
  it. Their one button writes `writeback`, and also `writeoff` when A − R > 0.
  The store refuses a `writeoffs.amount_cents` that differs from the entry's
  expense debit.

Separation of duties applies unchanged: the preparer cannot approve, and the
approver must be an owner or an approver. The workflow's latest-decision read
(`workflow.ts`) is narrowed to schema B, so a settlement never shadows the
dispute decision.

### 3. Posting, idempotency, read-back, failure

- **A job posts, never the request.** An Inngest function keyed on the
  writeback id, one at a time per connection, runs as `app_rw` with the
  approver's claims and asks `memberMayWrite` first. Its event carries ids
  only. The service role is not used.
- **The request id is the row id.** The row is inserted `pending` with
  `request_id` set to its own id before anything is sent. Intuit's accounting
  API reads the key as the `requestid` query parameter, while `client.ts` sets a
  header. The sandbox run settles which one a POST honours. Each entity also
  carries a reference stamped from the row id (`DocNumber` on an entry,
  `PaymentRefNum` on the zero Payment).
- **Post, then read back.** After a 2xx the job GETs the entity and compares
  the customer, the date, and every line's account, side and cents, plus the
  payment's link to our entry. Only a match sets `succeeded` and `qbo_txn_id`.
  A mismatch is `failed` (`readback_mismatch`) and raises an alert (ADR 0052).
  Nothing is ever reversed automatically.
- **A failed post is a failed row.** The runtime never retries the step that
  sends. A timeout or a 5xx after sending is an unknown outcome and is recorded
  as `failed`. The only retry is a person pressing "Check QuickBooks and retry",
  which reads back by the reference first: if the entity is found, the row is
  marked `succeeded`; if not, the job resends with the same request id.
  `unique (decision_id, method)` means a second row cannot exist. Each attempt
  is a `deduction_events` row, and `status` is its projection.
- **Order and tokens.** A Payment is sent only after its entry verifies. A
  stale `SyncToken` fails the row for a person, never an overwrite. A token
  refresh stays under the company's lock.

### 4. The account map, per tenant, set by an owner

This is why the ADR is required. The migration makes four changes:

1. **`ledger_account_maps`.** Columns: `org_id`, `connection_id` (composite FK,
   ADR 0025 §7), `seq`, the account ids for Accounts Receivable and Deductions
   Receivable, `writeoff_by_family jsonb` (a check requires exactly
   `REASON_FAMILIES`' keys), `unclassified_writeoff`, and `created_by`, which
   must be the caller. The table is append-only on migration 0004's pattern, so
   a change is a new row. Only an owner may insert (`app.member_is_owner()`).
2. **`writebacks`** gains `connection_id`, `account_map_id`, `amount_cents
   bigint` and `lines jsonb` (account ids, sides and cents only). All four join
   0017's immutable core. `method` admits `journal_entry` and
   `payment_application`. `succeeded` becomes final and `qbo_txn_id` write-once.
3. **`decisions.schema_id`** admits `'S'`.
4. **`accounting_connections.posting_enabled`**, `boolean not null default
   false`, may be true only while the connection has a map.

A job uses the map row that was latest at `approved_at`, so a later edit never
changes what was approved. Saving a map reads the accounts live and checks
their types: Accounts Receivable, Other Current Asset, and Expense or Other
Expense. `DEFAULT_ACCOUNT_MAP`'s names are only suggestions. We never create
an account.

### 5. Off by default

- **Per connection.** An owner turns `posting_enabled` on in Settings →
  QuickBooks, and each change writes one `audit_log` row. A connection moved to
  another owner is a new row, so it starts off.
- **Per deployment.** `qboPostingFromEnv` follows `scannerFromEnv`'s shape.
  Without `QBO_POSTING`, the job refuses before it builds a request, and the
  switch is hidden.
- **Sandbox first.** A laptop run with `QBO_ENVIRONMENT=sandbox` against the
  sandbox company `link:qbo` connected. Every request and response is recorded
  and replayed in CI, as `settlement-window.test.ts` does for the sync.
  `QBO_POSTING` goes onto Vercel Production only after the founder accepts this
  ADR and has seen that run. Previews never get it.

### 6. Scope and logging

No new scope is needed and nobody re-consents. Log lines, events and audit rows
name ids only: org, case, decision, writeback, connection, realm, QuickBooks
entity and request id, plus the HTTP status and Intuit's fault code. They never
contain a token, a request or response body, or a customer name.

### 7. Rollback

We never delete or void in QuickBooks. Turning the switch off, or unsetting
`QBO_POSTING`, stops new posts; what was posted stays. A person reverses a wrong
posting in QuickBooks and records the reversal as an event on the case. An
in-app reversal, approved like any other posting, is a follow-up. Undoing the
migration takes a new one.

## Invariants touched

1. It is exercised, not changed: two approval moments, both ordinary
   `approvals` rows.
2. `decisions` (a check is widened) and `writebacks` (columns are added)
   change schema, which is why this ADR comes first. No UPDATE or DELETE grant
   is added.
3. Cents become Intuit's decimal amounts through `centsToQboAmount`, a string
   formatter with no float, property-tested against `qboAmountToCents`.
4. No document text reaches QuickBooks.
6. RLS applies throughout, and every write is made as `app_rw`.

## Options not taken

A CreditMemo for found, which concedes revenue before the dispute. Writing
off at found, which hides the asset while the dispute is fought. Creating the
recovery Payment ourselves, which invents cash. One approval per case, which
cannot work because the outcome is unknown at filing. New approval actions per
stage, which would touch the gate. Posting in the request. An account map in
code.

## Consequences

- `map.ts` must learn our shape before the first posting. It ignores a
  `JournalEntry` link today, so our zero Payment's invoice line would read as
  cash on a Payment whose `TotalAmt` is 0. That throws `QboMalformedResponse`
  and stops the company's sync. A line funded by a JournalEntry must pair as a
  credit, as ADR 0036 pairs a CreditMemo line, proven by a sandbox replay.
- A found posting records the invoice identifier the sync keys on, so the next
  sync resolves to this case.
- `alert-on-failure` gains the posting function.

## What the founder decides

1. Whether to move ahead of Phases 1.5, 2 and 2.5, given that `CLAUDE.md` says
   "do not reorder".
2. How a recovery is applied: we apply the payer's existing payment
   (recommended), or we post the entry and leave the application to the
   customer's bookkeeper.
3. Whether moment 1 is one button (recommended) or two.
4. Whether the settlement is a schema `S` decision (recommended) or uses new
   approval actions.
5. Whether a declined case with no dispute decision is booked to the
   unclassified account unless a reason is named (recommended).
6. When `QBO_POSTING` goes on in Production, after the sandbox run.
