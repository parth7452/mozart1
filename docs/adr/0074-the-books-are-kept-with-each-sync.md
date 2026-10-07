# 0074 — The books are kept with each sync

- Status: **proposed**. Migration 0045 is applied nowhere; the founder applies
  it by hand, to `mozart-preview` first and then production, and reads it back
  on both. The code that writes a snapshot is merged **off**: it runs only
  where `LEDGER_SNAPSHOTS=1`, which is not to be set on any deployment before
  0045 is applied to that deployment's database.
- Date: 2026-10-07
- Implements: ADR 0066 §4 (keep a snapshot with each sync), which the founder
  approved as the direction on 2026-10-04 and whose three open questions the
  founder has answered (§1 below).
- Builds on: ADR 0031 (a ledger sync runs on a schedule, as a member, and
  records one append-only run row through a definer door), ADR 0035 §5 (a
  run's children are written once, complete, through a door of their own),
  ADR 0025 §7 (the tenancy tie is a composite foreign key), ADR 0066 §1–§3
  (the three books reads and `booksAccountRoles`).
- Adds: two append-only tables, one definer function, one environment
  variable, one section on the Books page. No outbound write, no model call,
  no threshold, no UPDATE or DELETE grant.

## Context

ADR 0066 built the Books page as a read-through: the chart, the trial balance
and the general ledger are read from QuickBooks in the request and forgotten
when the page closes. §4 named two reasons to keep them — an accountant tying
out a closed month wants the books *as they stood at close*, not as a later
live read shows them after back-dated entries; and a post-audit claim reaching
back two years is defended by showing what the customer's own ledger said when
we found and filed the deduction — and proposed two tables for a later
migration. It left three questions for the founder.

## Decision

### 1. The founder's three answers

- **Retention: indefinitely.** Both tables are append-only and nothing deletes
  from them. A post-audit window is about two years and a customer's
  engagement may be longer; a retention job would be a DELETE grant on an
  append-only table, which invariant 2 refuses, and is not built.
- **Scope: not the whole ledger.** A snapshot keeps the trial balance's rows
  and the general-ledger postings on the receivable, posting (account map) and
  deductions-like accounts only — exactly the accounts `booksAccountRoles`
  (`core-domain/src/books.ts`) gives a role, the same set the Books page reads
  by default. A customer's payroll, their bank feeds and every other posting
  are never stored.
- **Hash chain: yes.** Each snapshot stores `prev_sha256`, the `sha256` of the
  previous snapshot for the same connection (null for the first), and its own
  `sha256` covers the canonical JSON of its content **and** `prev_sha256`. A
  removed or altered snapshot breaks every hash after it.

### 2. Two tables, written once, complete

`ledger_snapshots` — one row per completed sync run per connection:
`org_id`; `connection_id`, tied to the tenant by the composite foreign key
`(org_id, connection_id) → accounting_connections (org_id, id)`; `run_id`,
tied the same way to `ledger_sync_runs (org_id, id)` and unique, so a run has
at most one snapshot; `as_of` (the run's last day), `window_from` and
`window_to` (the run's window, by check against the run row); `basis` and
`currency` as the ledger reported them; `status`, `complete` or `refused`;
`refusal_class`, a class name and nothing else, present exactly when refused;
`total_debit_cents` and `total_credit_cents`, `bigint`, null exactly when
refused; `trial_balance_line_count` and `ledger_line_count`; `sha256` and
`prev_sha256`, each 64 lowercase hex; `seq bigserial`, which orders the chain
where `created_at` (fixed per transaction) cannot; `created_by`, the member
the run acted as; `created_at`. `unique (org_id, connection_id, prev_sha256)
nulls not distinct` makes a fork a constraint violation as well as a refusal.

`ledger_snapshot_lines` — the lines, each naming its snapshot by the composite
key `(org_id, snapshot_id)`: `kind` (`trial_balance` or `ledger_posting`),
`line_no` (1.. per kind, in the order the ledger printed them), the account's
external id and name, `debit_cents` and `credit_cents` as `bigint`, and for a
posting its date, transaction type, transaction id and document number.
**No memo and no customer or vendor name**: those are a third party's words
and nothing a tie-out needs (invariant 4's habit for stored ledger text, as in
`ledger_sync_anomalies`).

Both append-only on migration 0004's pattern (revoke, `no_update_delete` and
`no_truncate` on `app.block_mutations()`), RLS on with `tenant_read`, `app_rw`
and `app_ro` SELECT only, the request roles nothing. A correction is a new
snapshot on the next run; a snapshot is never edited.

### 3. One door

`app.record_ledger_snapshot(header jsonb, trial_balance jsonb, postings
jsonb)`, definer for `app.record_ledger_sync_run()`'s reason (`app_rw` holds no
INSERT) and bounded the same way: the header's `org_id` must be the caller's
org claim and its `created_by` the caller's subject. It then checks, and
refuses by name:

- the run is the caller's org's (another tenant's reads as not existing),
  names the caller as `requested_by`, is `completed`, is for this connection,
  and the snapshot's window is the run's with `as_of` its last day;
- under a transaction-scoped advisory lock on the connection (seed 6, after
  0–5 taken by the document read, the invoice claim, the refresh lock, the
  inbound claim, the team locks and the posting-setup claim), `prev_sha256` is
  the latest snapshot's `sha256` for that connection, or null when it has
  none — so two runs cannot fork the chain;
- a complete snapshot's counts equal the arrays' lengths and its trial-balance
  lines add up, debit and credit, to its totals; a refused one has no lines,
  no totals and a class name.

It inserts the header and every line in the caller's one transaction. All of a
snapshot or none of it.

The database does not recompute the hash: canonical JSON is defined once, in
`core-domain` (`buildLedgerSnapshot`, `snapshotSha256` — keys sorted, cents as
strings, no whitespace), and `PostgresLedgerSnapshotStore.snapshotContent`
rebuilds a stored snapshot's content so anyone can recompute it from the rows.
The integration test does exactly that.

### 4. Who writes it, and when

The daily ledger sync (`syncLedgerJob`), as the member it already acts as,
**after** its short-pay pass and after its completed run row is written — the
snapshot names that row. It reads the chart, the trial balance as of the run's
last day, and the general ledger over the run's window restricted to the
accounts `booksAccountRoles` gives a role (the map's posting accounts read
from the latest account map). Only a completed run takes one; a refused,
unconfigured or failed run reads no books.

**Never the Books page.** A GET that stores a customer's ledger on every view
is a write nobody asked for. The page only lists what the sync kept.

### 5. A read that fails

Any failure of the three reads — `QboReportTooLarge`, `QboMalformedResponse`,
an expired sign-in, a source that has no books reads — records a `refused`
snapshot carrying the error's class name and no lines. It does **not** fail
the sync or change its short-pay result: the run row is already written and
the cases already opened. A refused snapshot still chains: its `sha256` covers
its header and `prev_sha256`, so a gap in the books is a link in the chain, not
a hole in it.

Failing to *record* a snapshot (the door refusing, the database unreachable)
is not swallowed: the run row stands, and the job throws, so the failure
reaches `alert-on-failure`. A retry runs the sync again, which ADR 0031 §6
makes free, and takes a snapshot under a new run row.

### 6. The switch

`LEDGER_SNAPSHOTS=1` turns it on, read in `apps/web/lib/ledger-sync.ts` where
the job's other configuration is read; unset, empty or `0` is off; any other
value is a configuration error and throws. It exists so this code can merge and
deploy before 0045 is applied: with the switch off nothing reads the two
tables. The Books page shows "Kept snapshots" only where the switch is on.

## Consequences

- Each daily run costs up to three more QuickBooks requests per connection
  (one chart, one trial balance, one general ledger), and stores a few
  hundred to a few thousand rows a day per connection, kept indefinitely.
- A post-audit packet can cite the snapshot taken on the day a case was found
  or filed, and its hash; wiring a snapshot into a packet is not done here.
- The trial balance's period starts on 1 January of the as-of year (ADR 0066
  §5), and that is what is kept.

## Invariants touched

- **2 (append-only).** Two new append-only tables on 0004's pattern; no
  UPDATE or DELETE grant; nothing deletes; suite 41 reads it back.
- **3 (integer cents).** Every amount is `bigint` cents, passed to the door as
  decimal strings and to the hash as strings; no `numeric`, no float.
- **4 (untrusted content).** No memo, name or other free text from the ledger
  beyond account names, transaction types and document numbers; a refusal is a
  class name, checked as an identifier.
- **6 (RLS, no service role).** RLS on both; the job writes as `app_rw` under
  the member's claims through a door bounded by them.
- 1, 5 and 7: none.

## Rollback

Turn `LEDGER_SNAPSHOTS` off: nothing writes or reads the tables. Reverting the
code is safe at any time. Once 0045 is applied, the tables stay (append-only,
kept indefinitely); dropping them would be a migration and an ADR of its own.
