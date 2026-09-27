# 0063 — An owner sets up posting with one press, and we create only the two accounts that are missing

- Status: accepted (the founder, 2026-09-27: "let's go with building B with
  the ADR 60 amendment").
- Date: 2026-09-27
- Amends: ADR 0060 §4, whose last sentence is "We never create an account".
  After this ADR, we create at most two accounts, on one owner's press, and
  never rename, change or delete an account afterwards. Everything else in
  ADR 0060 is unchanged: the per-connection switch, owner-only maps, the
  `QBO_POSTING` gate, and one approval per posting.
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

When an owner opens Settings → QuickBooks with all three of:
- `QBO_POSTING` on;
- an enabled connection;
- no saved map for it;

the page reads the company's chart of accounts live, read-only, through the
connection. It shows a proposal with three rows and one button, **Turn on
posting**:

| Row | Proposed |
| --- | --- |
| Receivable | The company's one active *Accounts Receivable* account. If there are several, the row is a dropdown with no default. If there are none, the row says so and the button is disabled, because we never create an A/R account. |
| Deductions held | An active *Other Current Asset* account named exactly `Deductions Receivable` (case-insensitive), if one exists; otherwise "we'll create it". |
| Write-offs | An active *Expense* account named exactly `Customer Deductions`, if one exists; otherwise "we'll create it". All eleven reason families and `unclassified` go to it. |

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
2. **Creates each "create" row, find-first.**
   - If an active account with the exact name and the right type now exists,
     it is reused.
   - If an account with that name exists with the wrong type, or inactive, the
     press stops and says so. We do not reactivate, retype or rename it; the
     owner resolves it in QuickBooks.
   - Otherwise one `POST /account` with a fixed `Name` and `AccountType`:
     - `Deductions Receivable`: `AccountType: Other Current Asset`,
       `AccountSubType: OtherCurrentAssets`;
     - `Customer Deductions`: `AccountType: Expense`, `AccountSubType:
       OtherMiscellaneousServiceCost`.

     Its `Request-Id` is derived deterministically from the connection id and
     the row, so a resend of the same press is the same request to Intuit
     (ADR 0060 §3).
   - The created account is **read back** by its id. The press continues only
     if the name, type and `Active` are what was sent.
   - Each creation writes one `audit_log` row,
     `accounting_connection.account_created`, carrying the connection, the
     realm, the row and the QuickBooks account id: ids only, never a name
     typed by anyone.
3. **Saves the map** through the existing `saveAccountMap`, which reads every
   account's type live again (ADR 0060 §4).
4. **Turns the switch on** through the existing `setPostingEnabled`, one audit
   row as today.

- **Not one transaction, and safe to press again.** Steps 2–4 touch QuickBooks
  and our database, so a failure can leave an account created and no map
  saved. Find-first makes the next press reuse that account rather than
  create a second. No step deletes anything to roll back.
- **Refusals are named.** Missing A/R, a name taken by the wrong type, a failed
  read-back and QuickBooks unreachable are each shown in words, and nothing
  after the failing step runs.

### 3. What we never do

- Rename, retype, deactivate or delete any account, including the two we
  created.
- Create an account other than those two, or at any time other than an
  owner's press.
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
  and no trip into QuickBooks, unless they have no A/R account or a name is
  taken by the wrong type.
- Two accounts in the customer's books were made by us. The audit log says
  which, when and on whose press. Their accountant may rename them or change
  their detail type; our type check reads `AccountType` only, so that is
  harmless.
- Our first write to a production company is now an `Account` create rather
  than a journal entry, still without the sandbox run ADR 0060 §5 asked for
  (waived by the founder, 2026-09-27).

## Rollback

Restore the raw-id form, or leave it removed and ask owners to use the
dropdowns only (no create). Accounts already created stay in the customer's
QuickBooks. They are the customer's to delete or keep.
