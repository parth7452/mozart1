# 0075 — A ledger can arrive as a file the ERP sends

- Status: **proposed**. Nothing is built. The migration sketched in §9 is not
  written; it is written after this is accepted, numbered then (`git fetch`
  first), and applied by the founder to `mozart-preview` first and then
  production.
- Date: 2026-10-07
- First customer: Frazil, on SAP Business One.
- Builds on: ADR 0031 (a ledger sync runs on a schedule, as a member), ADR 0035
  (a window is anchored on what was paid; a history is complete or it is
  refused), ADR 0036 (a credit is not cash), ADR 0024 (an arrival is a fact),
  ADR 0047 (an email reaches a tenant only through an address it was given),
  ADR 0056 (a spreadsheet is read by code, never by a model), ADR 0074 (a
  source with no books keeps a `refused` snapshot).
- Adds, if accepted: one provider value (`file_export`), one
  `AccountingSourceKind`, a ledger file format we own (format 1, in
  `docs/plans/erp-file-export/format-v1.md`), a reader that is code, two
  append-only tables, one owner-only door. No model call, no outbound write,
  no threshold, no UPDATE or DELETE grant on an append-only table.

## Context

The coverage thesis is that most deductions sit in the supplier's own ledger as
invoices paid short, and nobody ever sends us a notice for them (STRATEGY §5).
Today the only ledger we can read is QuickBooks Online, through its API (ADRs
0026, 0031, 0033, 0039).

Frazil runs SAP Business One. The next customers will run NetSuite, Sage,
Dynamics, Acumatica, or a version of Business One hosted by a partner. Writing
an API integration per ERP is the expensive path, and for Business One it is
also the fragile one:

- **The API is usually unreachable.** Business One's Service Layer is an OData
  endpoint on the customer's own server, typically port 50000. Reaching it from
  our cloud needs a VPN, an IP allowlist or a reverse proxy, a certificate that
  is often self-signed, and a session login with a Business One user and
  password. Each of those is a conversation with the customer's IT and their
  SAP partner, and the credential is one more secret to seal (ADR 0033).
- **Unified APIs do not solve it.** Merge starts at $650 a month for ten linked
  accounts and Apideck at $599 a month. Few of them carry Business One at all.
  Codat's Business One integration is "intelligent upload": the customer
  uploads XLS, XLSX or CSV exports.
- **iPaaS connectors** (Workato, CData, Prismatic) still need network access to
  the Business One server, so they add a licence and remove nothing.

Every ERP can already do one thing without any of that: run a saved query on a
schedule and send the result somewhere. If we define the file, any ERP's SAP
partner or accountant can produce it with a query, and we write one reader
instead of one integration per ERP.

## Options

**A. Service Layer, direct.** Our engineering per customer, plus network access
into their server and a sealed Business One credential. Correct, slow, and
repeated for every customer whose server sits behind a different firewall.

**B. A unified API vendor.** A monthly fee before the first customer, and for
Business One the vendor's own answer is a file. Worth revisiting when several
customers run NetSuite, Xero or Dynamics Business Central, which those vendors
do reach by API.

**C. An iPaaS connector.** Same network problem as A, plus a licence.

**D. A scheduled export in our format, sent to an address we issue.
Recommended.** The customer's partner writes one query, once. The ERP or a
scheduled script sends the file daily. Our reader is code. Nothing opens a port
into the customer's network, and we hold no ERP credential.

**E. A person uploads the same file in the app.** Not an alternative to D but
its fallback and its first test: the same reader, a different door. Built with
D.

## Decision

### 1. The format is ours; the query is the customer's

"Recouple ledger export, format 1" is one CSV (or an XLSX with one sheet),
UTF-8, comma-separated, RFC 4180 quoting, one header row. Every row carries the
export's metadata and a `record_type`. The full column list, record types and
rules are in `docs/plans/erp-file-export/format-v1.md`; this ADR fixes what the
reader may rely on:

- **Record types** map onto the existing `core-domain` ledger types with no new
  arithmetic: `INVOICE` to `LedgerInvoice`, `PAYMENT` and its `PAYMENT_LINE`s to
  `LedgerPayment` and its applications, `CREDIT_MEMO` and `JOURNAL_ENTRY` to
  `LedgerCredit`, and `RECON_LINE`s to the applications of those credits.
- **One `CONTROL` row** carries the count of every other row and the sum of
  their `amount` column, computed by the same statement that produced them. A
  file whose rows do not match its `CONTROL` row was cut short or edited, and
  is refused.
- **The file is a complete history** in ADR 0035's sense: every invoice that
  anything in the window touched, and every payment, credit memo and
  reconciliation ever applied to those invoices, whatever their dates.
- **Amounts are as the ERP stores them**, never formatted or rounded by the
  query. Dates are `YYYY-MM-DD` and nothing else.

The SAP Business One query that produces format 1 is in
`docs/plans/erp-file-export/sap-business-one.md`, for both SQL Server and HANA.
It is a draft written from SAP's table reference and has not run against a
live company database; that document lists the checks the partner runs on a
test company before scheduling it. Another ERP needs another query and no
change here.

### 2. Two doors: a ledger address, and an upload

**An address issued for this purpose.** An owner creates the connection in
Settings → Accounting by choosing "Scheduled export". That issues an inbound
address exactly as ADR 0047 does (a database-generated token on
`INBOUND_DOMAIN`, never a slug) and binds it to the new connection in one
transaction, as one row in `ledger_export_addresses` (§9). The binding is
refused for an address that has already received a message, so an address is
a ledger address from its first message or never.

Mail to a ledger address is stored, scanned and recorded on
`inbound_messages` like any other, and then **never classified, extracted or
held as a notice**. Its one CSV or XLSX part goes to the ledger reader. Any
other part is recorded as not read.

**An upload.** The same connection's settings page takes the same file by hand.
That is how the first file is tested before anyone schedules anything, and how
a customer with no scheduler sends a week at a time.

### 3. What arrived is recorded as what arrived

The file is a document like any other. Its `uploads` row says `email_in` for
the address and `web_upload` for the upload, because that is how it came
(ADR 0024). It is scanned, and its bytes are served only on a clean verdict
(`servingRefusal` unchanged).

The cases a sync opens from it are `erp_sync`, as every ledger case is today,
through the extract the sync writes for each case. So a coverage number by
channel still answers "found in the ledger", whichever transport carried the
ledger. The export file itself is never a notice and never counted.

### 4. Who may send one, and what a forged one could do

ADR 0047's facts hold here: Postmark signs nothing, and a sender's headers can
be forged. Anyone who learns the address can send a file to it. The file is
untrusted data, invariant 4, and the reader treats it so.

What a forged file can do: open `erp_sync` cases. No money moves on a case
without a human approval row (invariant 1), so the harm is noise and a
coverage number that is wrong. What it must not do is pass as the customer's
ledger silently. So:

1. **The first export is accepted by an owner.** It is held until an owner
   opens it on the connection page, sees its company, source system, window and
   counts, and presses "This is our ledger". That writes a `ledger_export_verdicts`
   row naming them (§9).
2. **Later exports are read without a press** only when all of these hold:
   - the `CONTROL` row matches the rows;
   - `company`, `source_system` and `format` equal the accepted export's;
   - the window starts on or before the end of the last accepted export's
     window, so there is no gap.
3. **Anything else is held** with its reason (`company_changed`,
   `format_changed`, `gap`, `control_mismatch`) and waits for an owner, and
   the owner's press is a second verdict row.

The aligned-DKIM report ADR 0047 records is shown beside a held export and
decides nothing.

### 5. The reader is code, and a file that does not tie is refused whole

The reader reuses ADR 0056's tokenizer, which refuses any DTD and any markup in
a delimited file. No model sees a cell.

Before anything is used, the reader checks, and refuses the whole file on the
first failure:

- exactly one `CONTROL` row, and its count and sum equal the rows';
- every amount parses with `parseMoneyToCents` (so a fraction of a cent, or
  three decimal places, is refused rather than rounded);
- every date is `YYYY-MM-DD`, with no `parsePrintedDate` guessing;
- one currency throughout (USD for Frazil), else refused;
- every line names a parent the file contains, and every `target_kind` is one
  the reader knows;
- **each payment balances**: its cash equals its invoice lines, less the credit
  memos netted in it, plus what was left on account;
- **each invoice ties**: what the file applies to it, cash and discounts and
  credits, equals the invoice's `paid_to_date`.

The last two are where an export that misses a kind of application shows
itself. A history that does not tie would read as a short-pay that never
happened, which is the one failure ADR 0035 exists to prevent. So a file that
does not tie is refused whole, the run is recorded `failed` with error class
`LedgerExportRefused`, and the reason names row numbers and ids only, never a
cell's text.

A credit netted inside a payment is paired to the invoice it funds only where
arithmetic forces it, and refused otherwise, by ADR 0036's rule. That rule
moves from `packages/qbo` to `core-domain` so both adapters use one copy.

A cash discount taken on a payment (`discount` on a `PAYMENT_LINE`) becomes a
`LedgerCredit` of its own. It is money the invoice did not receive, which is
what the detector looks for; whether a discount taken was earned is a payer's
terms, and terms are playbook data.

### 6. The sync reads the latest accepted export

`FileExportAccountingSource` implements the four ledger reads of the port over
one accepted export:

- `listPayments` and `listCredits` filter by date within the window;
- `getInvoiceHistories` answers from the file, and an id the file does not have
  is absent, as for every adapter;
- a window that reaches outside the export's own `window_from`..`window_to` is
  refused rather than answered in part.

The run's window is the export's window, not the trailing 35 days a QuickBooks
connection uses, because the export already overlaps by construction.

It has no books. `chartOfAccounts`, `trialBalance`, `generalLedger` and
`profitAndLoss` are not implemented, `books` is absent from the resolved
source, and ADR 0074 already says what follows: the snapshot is `refused`. The
Books page and ADR 0073's sizing say this connection sends receivables only. A
later format version may add a profit-and-loss section; nothing here needs it.

**When a sync runs.** An export that is accepted, by the rules or by a press,
queues the sync for its connection, keyed on the document so a redelivery is
one run. The daily fan-out also visits every file connection. If its newest
accepted export is older than `LEDGER_EXPORT_STALE_DAYS` (2, a constant in
`core-domain`), that run is recorded `failed` with error class
`LedgerExportStale` and the job throws a non-retriable error, so
`alert-on-failure` (ADR 0052) emails a person. A schedule that stopped sending
is otherwise invisible: every run would complete over the last file it got.

### 7. An id names its ledger

A ledger invoice's `externalId` becomes `ledger_invoice_id` in
`deduction_identifiers`, unique per tenant. A tenant with two ledgers could
have a QuickBooks invoice 71 and a Business One invoice 71. The file adapter
therefore prefixes every id with the file's `source_system`, as in
`SAP_B1:71`. Ids are stable from one daily file to the next, so the overlapping
windows are free, as they are for QuickBooks (ADR 0035 §4).

### 8. Provenance is better than the API's

A QuickBooks read keeps the JSON the API returned. A file connection keeps the
file: stored, hashed and append-only. The extract the sync writes for each case
names the export's document id, its SHA-256 and the row numbers each value came
from. In a post-audit two years later, the number on a case traces to a row in
a file the customer's own ERP sent, which is the defence CLAUDE.md asks
provenance to be.

### 9. The database (a sketch, written after acceptance)

One migration:

- **`accounting_connections.provider`** admits `file_export` beside `qbo`, and
  `ACCOUNTING_PROVIDERS` in `store-postgres` gains it in the same change.
  `provider_account_id` is the bound address's id. It is database-generated, so
  ADR 0039's one-enabled-connection-per-company index holds trivially; a
  company name read off a file is untrusted text and is never a key.
- **`ledger_export_addresses`**: `org_id`, `address_id` (unique),
  `connection_id` (unique), `recorded_by`, `created_at`. Append-only on 0004's
  pattern, RLS, tenancy by composite foreign key (ADR 0025 §7), written only
  through the definer door below, refused for an address with any message.
- **`ledger_export_verdicts`**: `org_id`, `connection_id`, `document_id`,
  `verdict` (`accepted` or `held`), `reason` (null when accepted),
  `company`, `source_system`, `format`, `window_from`, `window_to`,
  `decided_by` (null when the rules accepted it), `created_at`. Append-only. A
  held export a person later accepts is a second row, never an edit; unique on
  (`document_id`, `verdict`).
- **`app.connect_file_export()`**: definer, pinned, owner-only by
  `app.member_is_owner()`, bounded by the caller's claims; issues the address,
  makes the connection and the binding, and writes one audit row, in one
  transaction. It is the only way a `file_export` connection is made, as
  `connectQboCompany` is for QuickBooks.

No change to `ledger_sync_runs` (its four outcomes and free `error_class`
already fit) or to `ledger_sync_anomalies`.

## Consequences

- Frazil's ledger can be read without a port opened into its network or a
  Business One password stored anywhere.
- The next ERP costs a query written against format 1, not an adapter.
- The customer's SAP partner owns the query. A wrong query fails loudly at §5's
  ties rather than producing quiet wrong numbers, and the first file is tested
  by upload before anything is scheduled.
- Data is a day old at best. Deductions have windows of months, so a daily
  file loses nothing that matters.
- A file connection has no Books page and no sizing until a later format adds
  them.

## What is not done

- No Service Layer read and no write to Business One. Posting (ADR 0060) stays
  QuickBooks-only.
- No query for any ERP but Business One.
- No per-invoice partial acceptance (§5 refuses the whole file). If real
  exports show one odd invoice blocking good files, the alternative is a new
  anomaly kind for an invoice that does not tie, excluded from detection and
  shown on `/coverage`. That is a migration and a later decision, made with
  data.

## Questions for the founder, and the default used until answered

1. **Should every export need an owner's press, not just the first?** Default:
   only the first, and any export that changes company, format or leaves a gap
   (§4).
2. **The channel of a ledger case that came by file.** Default: `erp_sync`, as
   today, with the file's own `uploads` row saying `email_in` or `web_upload`
   (§3).
3. **Staleness.** Default: two days without an accepted export fails the run
   and emails `ALERT_EMAIL_TO` (§6).
4. **A file that does not tie.** Default: refused whole (§5).

## Invariants touched

- **1 (approval gate):** untouched. Reads only; nothing here writes a
  submission, writeback or write-off.
- **2 (append-only):** two new append-only tables with no UPDATE or DELETE
  grant. `accounting_connections` was never append-only (ADR 0031 §1); it gains
  one check value.
- **3 (money in cents):** every amount goes through `parseMoneyToCents`; a
  fraction of a cent refuses the file.
- **4 (untrusted documents):** no model reads the file. Code parses it, with
  ADR 0056's tokenizer, and refuses what it cannot account for.
- **5 (decision provider):** untouched.
- **6 (RLS, no service role):** both tables under RLS. The sync acts as the
  connection's `created_by`, as every ledger sync does.
- **7 (thresholds):** untouched. `LEDGER_EXPORT_STALE_DAYS` is an operational
  alarm, not a decision threshold.

## Rollback

Turn the connection off; the fan-out stops visiting it. The provider value and
both tables stay, because they are append-only and hold verdicts that coverage
numbers were counted under. Removing the code path leaves every case it opened
as an ordinary `erp_sync` case with its extract and its file.
