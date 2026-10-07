# 0071 — A payer's dispute window is data, and fills in a deadline

- Status: **Accepted** by the founder 2026-10-07 ("merge and go for it").
  Migration 0043 applied on that go to `mozart-preview` and then production,
  and read back on both: the migration's own closing check passes, the stored
  statement's md5 equals the file's (`292f6618…`), RLS is on with
  `tenant_read` and `tenant_insert`, the three triggers are present, `app_rw`
  holds SELECT and INSERT only, no `app` function is unpinned, and the
  security advisor shows nothing new. The Supabase MCP `apply_migration` (and
  `execute_sql`) hang until timeout on any statement containing `drop`, so the
  file was applied through `execute_sql` without its `drop … if exists`
  guards (no-ops on a first apply) and its history row written with the
  file's exact text.
- Date: 2026-10-07
- Builds on: ADR 0019 (a debtor is master data a person made; a window the
  page does not print is "a retailer rule, Phase 2's job"), ADR 0067 (payer
  code maps — the table this one copies in shape), ADR 0070 (a manual case
  records `deadline: 'no_payer_window_on_record'`)
- Adds: one append-only table, one function, one event type

## Context

A case's `dispute_deadline` is set only when the notice prints a date
`parsePrintedDate` will read, or when a person types one on the case page
(`case.deadline_set`). A payer's window — "disputes within 30 days of the
deduction" — lives in its supplier guide, so most cases (every ledger case,
most remittance lines, every manual case) open with no deadline, and the review
queue ranks them by age instead. `CLAUDE.md` forbids putting the window in
code: it is versioned, effective-dated playbook data with provenance.

## Decision

### 1. One table, `payer_dispute_windows`, in `payer_code_maps`' shape

| Column | |
| --- | --- |
| `id` | uuid |
| `org_id` | not null; every row is a tenant's, there is no shared window |
| `debtor_id` | not null; composite FK `(org_id, debtor_id) → debtors (org_id, id)` |
| `window_days` | integer, 1 to 730, calendar days |
| `measured_from` | text, `'deduction_date'` only, by check constraint — the one anchor we hold for every case; others are a later, additive value |
| `effective_from` | date, not null |
| `effective_to` | date, nullable, never before `effective_from` |
| `source` | `payer_guide_url`, `customer_confirmed`, `glimpse_guide` or `operator` (0040's set) |
| `source_note` | at most 500 characters |
| `confidence` | `low`, `medium` or `high` |
| `recorded_by` | not null, must be `app.current_user_id()` (an authorship trigger, 0040's pattern) |
| `created_at` | |

Append-only on 0004's pattern (`no_update_delete`, `no_truncate`), RLS,
`app_rw` SELECT and INSERT, `app_ro` SELECT, the insert policy an owner or
approver writing as themselves (`app.member_is_owner_or_approver()`, from
0040). A correction is a new row with a later `effective_from`, or a later
recording for the same dates.

### 2. Which window applies on a date

`app.payer_dispute_windows_as_of(as_of date)` answers, per debtor, the row in
force on that date: its effective range covers the date, and among those the
latest `effective_from`, then the latest `created_at`, then the `id` (unlike
`payer_code_maps`, two rows may share a start date, since a later recording
for the same dates is the correction).
`resolveDisputeWindow` in `core-domain` is the same rule in TypeScript, and a
test holds the two to one answer. `deadlineFromWindow(deductionDate, days)` adds
calendar days to an ISO date, pure and property-tested.

### 3. Where it fills a deadline

In `PostgresStore`'s one case-opening statement (`openCaseOn`), so every path
that opens a case — notice, remittance line, report row, ledger, manual entry,
a held document a person opens — gets it from one place: when the caller gave
no deadline, the case has a debtor and a deduction date, and a window is in
force on the deduction date, `dispute_deadline` is set to
`deadlineFromWindow` and a `case.deadline_derived` event records
`{ window_id, window_days, measured_from, effective_from, source, confidence,
deadline }`
in the same transaction. **A printed deadline always wins**, and a person's
`case.deadline_set` later wins as it does today.

**An open case is never rewritten by a window recorded after it opened.** Its
page shows "Payer window: N days from the deduction date → date" and prefills
the existing deadline form with that date and a basis naming the window; a
person presses it, which is an ordinary `case.deadline_set`.

### 4. Who records a window

An owner or approver, on Settings → Dispute windows: the windows in force
today per payer with their source and confidence, a form to add one, and every
payer with open cases and no window, with the count of those cases that have
no deadline. A `read_only` member or analyst sees the list and no form.

## Consequences

- A window is not an invariant-7 threshold (`org_settings` is untouched); it is
  data with provenance, and moving it is a recorded row, never an update.
- A wrong window gives a wrong deadline on cases opened after it, each traceable
  by its `case.deadline_derived` event to the row and the person who recorded it.
- Business days, "from invoice date", or "from remittance date" windows are not
  modelled; `measured_from` is the column that will say so.

## Invariants

1, 3, 4, 5 and 7 untouched. 2: the new table is append-only and no UPDATE or
DELETE grant is added; the one write to `deductions` (a mutable projection) is
at insert, in `openCaseOn`. 6: RLS on the new table.
