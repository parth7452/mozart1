# 0066 — The books are read through, and keeping a snapshot of them is proposed

- Status: **accepted** by the founder on 2026-10-04 (§1–§3, the read, built
  and merged in PR #145). §4 (keeping snapshots) is approved as the direction
  and still **not built**: it needs a migration the founder applies by hand,
  and nothing in it exists yet.
- Date: 2026-10-04
- Extends: ADR 0026 (the `AccountingSource` port), ADR 0063 §1 (a settings
  request reads a chart live and may refresh the company's token)
- Adds (§1–§3): three reads on the port, two reads on `QboClient`, one page.
  No table, no column, no grant, no migration, no new environment variable, no
  outbound write.

## Context

The founder asked for "easy ERP / QuickBooks integration with ledger, trial
balance and chart of accounts sync": an accountant connects QuickBooks, and we
can show the chart of accounts with names and codes, a trial balance with
numbers, and the general ledger.

Before this, the QuickBooks adapter read three entities for one purpose —
invoices, payments and credit memos, to find short-pays (ADR 0026, 0035) — and
the chart of accounts for one other, proposing an account map (ADR 0063). An
accountant looking at the product could not see their own books in it, and
there was no way to answer the first question they ask of a deductions tool:
*do your cases agree with what my ledger says was deducted?*

Two things constrain how it is built. A trial balance and a ledger are money,
so the reading has to be to the cent or refused (invariant 3). And storing
them is a schema change to append-only tables, which the founder applies by
hand and which should not be decided overnight — so the first version stores
nothing.

## Decision

### 1. Three reads on the port, and nothing stored

`AccountingSource` gains `chartOfAccounts()`, `trialBalance(asOf)` and
`generalLedger(window, { accountIds? })`. They return domain rows declared in
`core-domain/src/books.ts` — `LedgerAccount`, `TrialBalance`, `GeneralLedger` —
in integer cents with ISO dates. The port still has no method that writes.

For QuickBooks:

- **The chart** is posting setup's own read (`Account where Active in (true,
  false)`), with `AcctNum`, `Classification` and `CurrentBalance` read as well.
  Whole or `QboChartTooLarge`, never part of a chart.
- **The trial balance** is `GET /reports/TrialBalance` with `start_date` and
  `end_date`. QuickBooks reports it over a period; we ask for the calendar year
  to date and return the period QuickBooks reported, so a page prints it rather
  than assuming it.
- **The general ledger** is `GET /reports/GeneralLedger` with `start_date`,
  `end_date`, nine named columns (date, type, number, name, memo, account,
  debit, credit, balance) and, when asked, an `account` filter.

The Reports API **does not paginate**. A report past Intuit's cell limit comes
back cut short with a sentence inside it saying so. So the bound is ours, on
both sides of the request: a window longer than
`GENERAL_LEDGER_MAX_WINDOW_DAYS` (186) is refused before anything is asked; a
report carrying Intuit's cut-short sentence, or more than
`GENERAL_LEDGER_MAX_LINES` (20,000) postings, is `QboReportTooLarge`. Never
part of a ledger.

Parsing (`packages/qbo/src/reports.ts`) is defensive and loud:

- The envelope is validated with zod; anything else is `QboMalformedResponse`
  naming the path. **An empty report is returned only when the report's own
  `NoReportData` option says so.**
- A section's `Summary`, a ledger's "Beginning Balance" row and the trial
  balance's `GrandTotal` are never read as lines. The totals are what the lines
  are **checked against**: the lines read must add up to every total the report
  prints, to the cent, or the read is refused. A row dropped or read twice in
  parsing therefore fails the read instead of shrinking the report.
- A trial balance whose debits and credits differ is **not** refused. That is
  the ledger's fact; the page shows the difference.
- Money is decimal text and goes through `parseMoneyToCents`. A fraction of a
  cent, a comma, a currency sign or an exponent fails the read. One decimal
  place (`"225.0"`) is read as written, as `qboAmountToCents` already reads a
  JSON `1234.5`: a cell is a whole JSON string, so it cannot be an amount cut
  short.
- A multicurrency company answers with other column keys (`debt_home_amt`).
  That is refused by name rather than read as home currency.
- No refusal quotes a figure, a name or a memo from the books.

### 2. A Books page, read in the request

`/books`, in the workspace navigation and linked from Settings → QuickBooks.
Every member sees it, `read_only` included. It has one form, a GET that
chooses the ledger window, and no action.

For each enabled connection it shows the chart (code, name, type, detail type,
active) with the accounts the saved account map posts to marked; the trial
balance as of today with QuickBooks' own totals and, when they differ, the
difference stated; and the general ledger for a window — the ledger sync's
trailing 35 days by default — for the receivable, the posting accounts and the
accounts that look like deductions accounts, with every account one link away.

The reads are made inside the request, as the signed-in member, as `app_rw`,
through the connection's sealed token store and the company's refresh lock —
ADR 0063 §1's pattern. It is not gated on `QBO_POSTING`: reading the books is
not posting to them. A deployment without the Intuit app's credentials or the
KMS key builds no source and every connection reads "not set up".

**The one write a read can cause is a token refresh, and only a member whose
refresh can be stored may cause one.** The database stores a rotated token
only for a member it lets write (`member_may_write()`, migration 0030), and
Intuit kills the old refresh token on use. A refresh made for a `read_only`
member would be exchanged and then refused at the save, and the customer would
have to reconnect. So the page asks `member_may_write()` first, and for a
member it would refuse, the token store is wrapped (`withoutRefresh`): a fresh
token is used, a stale one is refused **before** anything is sent to Intuit,
and the page says a member who can write has to open it first.

A failure costs its own section and is shown as a fixed sentence chosen by the
error's class — for a refused or expired sign-in, by the OAuth outcome and
nothing else. No message, body, fault text or figure reaches the page or a
log line; the log carries the class name, an HTTP status and ids.

### 3. The deductions reconciliation, read-only

For the window, the ledger's postings on the posting and deductions accounts
are listed beside this workspace's cases dated in the same window
(`PostgresBooksStore.casesInWindow`, one SELECT under RLS).

`reconcileDeductions` (`core-domain`, property-tested) asserts a match **only**
when the amount is the same to the cent, the date is the same day, and neither
the posting nor the case has another partner on that amount and day. Anything
else is "in books, no case" or "case, not in books", each with its candidates —
the same amount within `RECONCILIATION_CANDIDATE_DAYS` (7), or a case with no
printed date — labelled "not asserted". Names are shown and never compared.
Nothing is written to a case, to an event or to QuickBooks.

Which accounts "look like deductions" is a heuristic, written out as data and
printed on the page: a detail type of `DiscountsRefundsGiven` or
`AllowanceForBadDebts`, or a full name containing, at the start of a word,
one of *deduction, chargeback, charge back, charge-back, allowance, short pay,
short-pay, shortpay, billback, bill back, bill-back, trade spend, promo*. An
account receivable is never one.

### 4. Proposed, not built: keep a snapshot with each sync

Everything above is gone when the page is closed. Two things want it kept:

- **Month-end tie-out.** An accountant closing September wants the trial
  balance and the deductions accounts' ledger *as they stood at close*, beside
  the cases as they stood then. A live read on 9 October shows October's
  postings and any back-dated entries; it cannot show what was true on the
  30th.
- **Post-audit defence.** A post-audit claim reaches back about two years. A
  recovery we billed a fee on is defended by showing what the customer's own
  ledger said when we found and filed it. Today that rests on the ledger
  extract stored with each case (ADR 0029). A snapshot would add the account
  balances around it, hash-chained like everything else a packet cites.

The proposal, for a later migration:

- `ledger_snapshots` — one row per sync run per connection, written once, when
  the run finishes, complete (ADR 0023's and 0031's shape): `org_id`,
  `connection_id`, `run_id`, `as_of`, `window_from`, `window_to`, `basis`,
  `currency`, the trial balance's totals in cents, counts, and a `sha256` over
  the canonical JSON of what was read.
- `ledger_snapshot_lines` — the trial balance's rows and the general-ledger
  postings on the receivable, posting and deductions accounts, in cents, each
  naming its snapshot. Not the whole ledger: the accounts this product is
  about.
- Both append-only on migration 0004's pattern (revoke, `no_update_delete`,
  `no_truncate` on `app.block_mutations()`), RLS on, `app_rw` SELECT only with
  a definer door bounded by the caller's claims as `ledger_sync_runs` has,
  `app_ro` SELECT, every function's `search_path` pinned, and a SQL suite that
  reads the end state back.
- Written by the daily ledger sync, as the member it already acts as. **Not**
  by the Books page: a GET that stores a customer's ledger on every view is a
  write nobody asked for.
- A correction is a new snapshot. A snapshot is never edited.

What has to be decided before it is built: how long snapshots are kept; whether
a customer's whole ledger, rather than the deductions accounts, should ever be
stored; and whether the hash is chained to the previous snapshot's.

### 5. What is not done

- QuickBooks has never been asked for either report by this code. The fixtures
  are hand-written from Intuit's documented shape; the first real answer should
  be recorded with `pnpm qbo:verify --record` and committed beside them, as
  the README in `packages/qbo/test/fixtures` asks. Until then the parser's
  strictness is untested against a real company, and a real company may be
  refused by it.
- The trial balance's period start is 1 January of the as-of year, not the
  company's fiscal year start (`CompanyInfo.FiscalYearStartMonth` is not read).
- Multicurrency companies are refused.
- A cash-basis view is not offered: the report is read on the company's own
  default basis and the page prints which it was.

## Consequences

An accountant can open the product and see their chart, their trial balance
and the ledger of the accounts deductions live in, and can see which postings
have a case and which cases have a posting. Every figure is QuickBooks' and is
labelled as read just now.

Each view of the page costs up to four QuickBooks requests per connection and
can take as long as QuickBooks does; the route allows 90 seconds. The page is
only as current and as available as QuickBooks is.

NetSuite and Xero, when they arrive, implement the same three reads behind the
same port. "Accounts Receivable" as an account type and the two detail types
in the heuristic are QuickBooks' names and will need their equivalents.

## Invariants touched

- **3 (integer cents).** Every amount read is cents through
  `parseMoneyToCents`; a value that is not exact cents fails the read. Tested
  in `packages/qbo/test/reports.test.ts`.
- **6 (no service role in a request path).** Our own rows are read as `app_rw`
  under the member's claims; the token store is the per-connection one, under
  the same claims.
- **2 (append-only).** Untouched: nothing is stored. §4 would add two
  append-only tables and is not built.
- Invariants 1, 4, 5 and 7: none. No document text is read, no model is
  called, nothing is submitted or posted, no threshold moves.

## Rollback

Revert the PR. There is no data to migrate back: nothing was stored. The port's
three methods, the two client reads and the page go together; the daily ledger
sync, posting setup and the account map do not use them.
