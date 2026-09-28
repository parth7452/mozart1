# 0063 — An owner sets up posting with one press, and we create only the two accounts that are missing

- Status: accepted (the founder, 2026-09-27: "let's go with building B with
  the ADR 60 amendment"). Amended 2026-09-28, before merge, from two reviews
  of the build — one amendment, to be confirmed once:
  - §1: the settings page reads each enabled connection's chart on every
    owner's view, with a map saved or without; that read may store a
    refreshed token, so the page is a GET that may write whenever an owner
    opens it on a deployment that posts; and the read is bounded, two pages
    of a chart at most.
  - §2: the `account_create_requested` and `account_found` audit rows; a
    request id per attempt at a row, not one per row for good; a press that
    refuses rather than make a second account while one setup recorded for
    the row is still in the chart; the one-press claim (advisory lock seed 5,
    on a pool of its own); and a time bound on every request and route.
  - Consequences: no count of accounts made is promised, and why.

  None of it changes which two accounts are created. It changes what the
  audit log records, when a create is sent again under the same request id,
  when a press refuses, and when the settings page may write. **The founder
  has not confirmed the amendment.** It is theirs to confirm, recorded in
  this line, before the merge.
- Date: 2026-09-27
- Amends: ADR 0060 §4, whose last sentence is "We never create an account".
  After this ADR, we create only the two accounts §2 names, each on an
  owner's press; never one of them again while an account setup recorded for
  its row is still in the company's chart; and never rename, change or
  delete an account afterwards. Everything else in ADR 0060 is unchanged: the
  per-connection switch, owner-only maps, the `QBO_POSTING` gate, and one
  approval per posting.
- Adds: one outbound write to a customer's QuickBooks (creating an `Account`),
  one settings route, and a proposal function. No migration: the map and the
  switch already exist (migration 0037), and `audit_log.action` is free text.

## Context

Settings → QuickBooks asks an owner for 13 QuickBooks account ids. QuickBooks
never shows an id on screen: it appears only in a register's URL, and an
Expense account has no register. The founder, setting up the first real
company, could not fill the form in.

Most companies also lack two of the accounts the map needs:
- a **Deductions Receivable** (Other Current Asset), which is where a found
  deduction waits (ADR 0060 §1);
- an expense account named for deductions.

As ADR 0060 was written, the owner had to leave the app, create both in
QuickBooks, find their ids, and come back. That is the step a customer
abandons.

The founder chose the flow in which the card is filled in when the owner
arrives, and one press saves the map, creates what is missing, and turns
posting on. They also chose to let that press create the missing accounts,
which ADR 0060 had ruled out. That is a new outbound write, so it needs this
ADR first (CLAUDE.md, *Workflow*).

## Decision

### 1. The card proposes; the owner presses once

When an owner opens Settings → QuickBooks with `QBO_POSTING` on, the page
reads the chart of accounts of each enabled connection live, read-only,
through the connection — with a map saved or without. A connection with no
map gets the proposal below; one with a map gets the dropdowns that change it
(§4). Nobody but an owner causes the read.

Each request of that read waits at most ten seconds, and the read takes two
pages of a thousand accounts at most: a chart that has not ended by then is
refused by name (`QboChartTooLarge`) and its card shows it as unreadable,
never a proposal from part of it. A refresh of the company's token waits on
its own bounds: 30 s for a connection to hold the company's lock on (the lock
pool's wait), 15 s for the lock itself, 10 s for Intuit. So the read ends
within 75 s, inside the page's `maxDuration` of 90 s, and a QuickBooks that
stalls costs the card and not the page. This assumes what ADR 0021 assumes
for `/api/inngest`: a platform that honours a route's `maxDuration` up to
300 s. A route that declares none gets the platform's default, which ADR 0021
records as 10 s on Vercel's Hobby plan and 15 s on Pro.

That read may refresh the company's token, which stores the rotated credential
as a new row (ADR 0033). So the settings page is a GET that may write — on
every owner's visit, for as long as `QBO_POSTING` is on, and not only during
setup — and it takes nothing from the request to do it. The callback stays
the one GET that writes what a request brought (ADR 0039).

For a connection with no map, the page shows a proposal with three rows and
one button, **Turn on posting**:

| Row | Proposed |
| --- | --- |
| Receivable | The company's one active *Accounts Receivable* account. If there are several, the row is a dropdown with no default. If there are none, the row says so and the button is disabled, because we never create an A/R account. |
| Deductions held | An active *Other Current Asset* account named exactly `Deductions Receivable` (case-insensitive), if one exists; otherwise "we'll create it". |
| Write-offs | An active *Expense* account named exactly `Customer Deductions`, if one exists; otherwise "we'll create it". All ten reason families and `unclassified` go to it. |

- **Split write-offs by reason** opens one dropdown per family plus
  `unclassified`. Each lists active Expense and Other Expense accounts, and
  each defaults to the single write-off account.
- **Change accounts** turns every row into a dropdown of the company's active
  accounts of the right type, by name. No id is ever shown or typed.
- The proposal is a pure function over the accounts read, with no clock and no
  model. It suggests nothing it cannot find, except the two fixed names above.

### 2. What the press does, in order

It is one owner-only POST: cross-site refused, the session re-resolved, and
`member_is_owner` asked of the database. It then:

1. **Re-reads the chart of accounts.** The form says only which row chose which
   existing account id, or "create". Nothing the form says about an account's
   type or name is trusted.
2. **Creates each "create" row, find-first.** Every row is decided against
   that one read before anything is created, so a stop on one row creates
   nothing on the other.
   - If an active account with the exact name and the right type now exists,
     it is reused.
   - If an account with that name exists with the wrong type, or inactive, the
     press stops and says so. We do not reactivate, retype or rename it; the
     owner resolves it in QuickBooks.
   - If no account holds the name, but an account setup already recorded for
     the row — created, or found (below) — is still in the chart, the press
     stops and says so. That account was renamed, or moved under another
     account, since; a second create would put a second account in the books
     beside it. We do not rename it back: the owner chooses it (or another
     account) under Change accounts, or gives it back its name in QuickBooks.
     Only an account gone from the chart altogether is made again.
   - Otherwise one `POST /account` with a fixed `Name` and `AccountType`:
     - `Deductions Receivable`: `AccountType: Other Current Asset`,
       `AccountSubType: OtherCurrentAssets`;
     - `Customer Deductions`: `AccountType: Expense`, `AccountSubType:
       OtherMiscellaneousServiceCost`.

     Its `Request-Id` is derived deterministically from the connection id,
     the row and the attempt: the number of `account_created` and
     `account_found` rows the audit log already holds for that row of that
     connection, counted as the request's own row is written. A create sent
     again after one no answer came for is therefore the same request to
     Intuit (ADR 0060 §3), which answers it rather than making a second
     account; a create after an answered one is a new request, which Intuit
     cannot answer with the account the answered one made. The first attempt
     at a row is named by the connection and the row alone.
   - The created account is **read back** by its id. The press continues only
     if the name, type and `Active` are what was sent.
   - Before each `POST`, one `audit_log` row,
     `accounting_connection.account_create_requested`, carrying
     `provider_account_id` (the realm), `row` and `request_id`. It is written
     first, so a create whose answer never arrives still says which press
     asked, as whom and under which request id. The `POST` goes out under the
     request id that row was written with, and every answer below carries it,
     copied from the request it answers.
   - Each creation writes one `audit_log` row,
     `accounting_connection.account_created`, carrying `provider_account_id`,
     `row`, `qbo_account_id` and `request_id`: ids only, never a name typed by
     anyone. The account id is logged before the row is written. An account
     that did not read back as sent is in the customer's books all the same,
     so it gets the row too, with `read_back_mismatch` naming the fields that
     differed (`Id`, `Name`, `AccountType`, `Active`), never their values; the
     press then stops.
   - A create whose answer never came — a timeout, a 5xx, a reply with no id,
     a read-back that could not be made, or a 4xx that does not say whether it
     answered the create or its read-back — leaves only its request row. The
     next press settles it after its own read of the chart and before it
     plans. For each row whose latest request has no `account_created` or
     `account_found` after it, it looks for the one account that request
     could have made: top-level, active, and named and typed exactly as the
     `POST` sent them. That account is recorded then, as the owner pressing,
     in one `audit_log` row, `accounting_connection.account_found`, carrying
     `provider_account_id`, `row`, `qbo_account_id` and the unanswered
     `request_id`.
   - A found account is never recorded as created: nobody saw it made, and a
     person could have made it in QuickBooks in between. So a count of what
     setup created reads `account_created` alone. A found account answers its
     request all the same: it counts as an attempt answered, and it is an
     account setup recorded for its row.
   - Nothing else is recorded, and the request stays unanswered: no such
     account, two of them, or an account under our name that the request
     could not have made (inactive, a sub-account, named otherwise than
     exactly, or of another type). An Other Expense account under the
     write-off name is of another type: the plan may still use it for
     write-offs, but our `POST` sends `Expense`. Until a press finds the
     account, the request row is all the audit log has of it.
3. **Saves the map** through the existing `saveAccountMap`, which reads every
   account's type live again (ADR 0060 §4).
4. **Turns the switch on** through the existing `setPostingEnabled`, one audit
   row as today.

- **Not one transaction, and safe to press again.** Steps 2–4 touch QuickBooks
  and our database, so a failure can leave an account created and no map
  saved. Find-first makes the next press reuse that account rather than
  create a second, and a press that finds it renamed or moved stops rather
  than make another. No step deletes anything to roll back.
- **One press at a time.** A press holds its connection's claim — a
  transaction-scoped advisory try-lock on the connection id, seed 5 — from
  reading the connection until the switch is on. A second press meanwhile (a
  double click, or another owner) is refused at once with
  `posting_setup_busy` and reads, creates and saves nothing. A press after
  the first has ended finds its map and is refused as already mapped. The
  claim is held on a pool of its own, two connections, not on the lock pool:
  a press's token refresh takes a lock-pool connection while the claim is
  held, and one pool for both is a press waiting on itself while document
  reads wait on it. A press that gets no connection for its claim within
  10 s is refused the same way, `posting_setup_busy`.
- **Bounded in time.** Each request a press makes to QuickBooks waits at most
  25 s, and it reads the chart in two pages of a thousand at most. A press
  makes at most seven requests: the chart (two pages), two creates and their
  read-backs, and the type check before the map. Before any of them it waits
  at most 10 s for a connection to hold its claim on, and it refreshes the
  token at most once: 30 s for a lock connection, 15 s for the company's lock,
  10 s for Intuit. So it has asked everything it will within 240 s, a minute
  inside the setup route's `maxDuration` of 300 s on the platform §1 assumes.
  A QuickBooks that answers slowly is then told to the owner as unreachable,
  in words, rather than cut off with a gateway timeout; so is a lock
  connection that could not be had in time (`LockPoolTimeoutError`). The
  account-map route's type check waits the same 25 s, and its refresh the
  same 55 s: 80 s, inside its own `maxDuration` of 120 s.
- **Refusals are named.** Missing A/R, a name taken by the wrong type, an
  account setup recorded for a row and renamed or moved since, a failed
  read-back, a chart longer than a press reads, QuickBooks unreachable and
  another press running are each shown in words, and nothing after the
  failing step runs. A 4xx at a create is said as what is known: QuickBooks
  refused a request while the account was being created, and the account may
  exist all the same. The page the owner lands on reads the chart again, and
  its card shows which.

### 3. What we never do

- Rename, retype, deactivate or delete any account, including the two we
  created.
- Create an account other than those two, or at any time other than an
  owner's press.
- Create one of the two again while an account setup recorded for its row is
  still in the company's chart.
- Create an A/R account.
- Post anything as part of setup. Every posting still needs its case's
  approval (invariant 1), and this press approves nothing.

### 4. Everything else stays

- The raw-id form is removed. Dropdowns replace it, for saving a map and for
  changing one later, and a later change is a new map row as before.
- Turning posting off stays a separate button.
- `DEFAULT_ACCOUNT_MAP`'s names in `journal.ts` stay draft labels only.

## Invariants touched

- **1 (approval gate):** untouched. Creating an account is configuration, not
  a `writebacks` row, and no posting happens at setup.
- **4 (untrusted content):** untouched. The chart of accounts is our read of
  the customer's own books, and no model sees it.
- **6 (RLS, no service role):** the route runs as `app_rw` with the owner's
  claims, like every settings route.

## Consequences

- A new customer turns posting on in one press after connecting, with no ids
  and no trip into QuickBooks, unless they have no A/R account, a name is
  taken by the wrong type, or their chart has two thousand accounts or more.
- The accounts we made in the customer's books are on the audit log: which,
  when and on whose press. For a create whose answer was lost, the request
  row says whose press asked, and a later press's `account_found` row says it
  found the account as that request asked for it (§2). Their accountant may
  rename them or change their detail type once the map is saved; our type
  check reads `AccountType` only, so that is harmless. Before the map is
  saved, a press that would create a renamed or moved one again stops and
  says so instead.
- No count of accounts made is promised, on the card or here. One row gets a
  second account only if the first is gone from the chart when a press would
  create the row, or if a create's answer was lost, the account it made was
  renamed or moved before any press found it, and Intuit's idempotency window
  for its request id had passed by the time a press sent it again. The card
  names the two accounts we create, not how many times, and the notice after
  a failure says to leave them as they are until posting is on.
- The settings page is a GET that may write for as long as posting is on
  (§1): the refreshed token an owner's chart read stores. A chart of two
  thousand accounts or more cannot be set up from the card at all.
- Our first write to a production company is now an `Account` create rather
  than a journal entry, still without the sandbox run ADR 0060 §5 asked for
  (waived by the founder, 2026-09-27).

## Rollback

Restore the raw-id form, or leave it removed and ask owners to use the
dropdowns only (no create). Accounts already created stay in the customer's
QuickBooks. They are the customer's to delete or keep.
