# 0035 — A ledger window is anchored on what was paid, not on what was invoiced

- Status: accepted
- Date: 2026-09-22

## Context

The scheduled ledger sync (ADR 0031) walks a trailing 35-day window and asks the
accounting source for invoices, payments and credits, **each filtered by its own
transaction date** (ADR 0026: `select * from <Entity> where TxnDate between …`).
`detectShortPays` then tallies only the invoices that came back, and a payment
whose application names an invoice outside that set is reported as
`application_to_unknown_invoice`.

Production showed what that means on 2026-09-22. Run
`be42505b-cf27-4376-8edc-17d97811bdba` against the Intuit sandbox company
completed over 2026-08-19..2026-09-22 and recorded 12 invoices examined, 0
opened, 0 skipped, 0 declined and **8 anomalies**. Replaying the recorded
fixtures (`packages/qbo/test/fixtures/recorded-*.json`) through the same mapper
and detector reproduces it exactly. All eight are `application_to_unknown_invoice`:
payments dated inside the window, applied to invoices dated before it — payment
128 to invoice 96, payment 120 to invoice 12, and six more. Over the full 90-day
recording the same detector finds three short-pays (invoices 67, 13 and 16) and
one anomaly.

So the window anchored on invoice date is not a narrow window, it is the wrong
axis. A short-pay *happens* when the payment lands, and a payment lands after its
invoice by the terms of trade: net 30, net 60, net 90 in foodservice. Anchoring
on the invoice date means every short-pay on an invoice older than the window is
structurally invisible — and in a net-30/net-60 world that is most of them,
which are exactly the deductions the coverage thesis is about (STRATEGY §5.4).
The three short-pays in the sandbox are all paid inside the production window;
the sync found none of them because their invoices were dated before it. A wider
fixed window only moves the cliff: net 90 plus a slow remittance puts an invoice
outside any window short enough to be cheap to walk daily.

There was a second, quieter defect underneath. The detector tallies an invoice
against the applications it was *shown*. An invoice fetched without all its
applications — one payment in the window, an earlier one outside it — tallies as
paid short when it was paid in full. The invoice-date window never hit this in
practice only because it hid those invoices altogether. Any fix that fetches the
invoices a payment names has to fetch *all* of each one's applications, or it
trades an invisible short-pay for a fabricated one.

And the run row records only `anomaly_count`. Eight anomalies is a number nobody
can act on: which invoices, which payments, what kind. The detector knew; the
database was told a count.

## Decision

### 1. The window is anchored on payment and credit dates: what changed in the period

`syncLedger` now asks the source for **payments and credits** dated inside the
window — the activity, the thing that can make an invoice short-paid today — and
collects every invoice those name. It then asks for those invoices **by id,
regardless of their date**, each with every payment and credit the ledger has
applied to it, **regardless of their dates**, and runs the unchanged detector
over that.

`listInvoices(window)` stays on the port (the sandbox verifier reads it, and it
is the right primitive for a later "open AR" view) but the sync no longer calls
it. `LEDGER_SYNC_WINDOW_DAYS` stays 35; what it counts is now days of payment
activity rather than days of invoicing.

What falls out of the examined set, said plainly: an invoice with no payment or
credit dated in the window. It is either unpaid (not a short-pay: `detectShortPays`
never made a candidate of it) or it was last touched more than 35 days ago (the
run that saw that activity examined it then). `negative_amount` and
`currency_mismatch` on such an invoice are raised when it is next paid rather
than while it sits unpaid — a later check, not a missing one.

### 2. The port gains one read: `getInvoiceHistories(invoiceExternalIds)`

```ts
getInvoiceHistories(invoiceExternalIds: readonly string[]): Promise<LedgerInvoiceHistories>;
// { invoices, payments, credits }
```

The named invoices, whatever their dates, and every payment and credit the
ledger records against any of them, whatever *their* dates. An id the ledger does
not have is simply absent from `invoices`. A returned payment or credit may also
apply to invoices that were not asked for; the caller trims (§3).

This is deliberately one method returning the whole history rather than a bare
`getInvoices(ids)` beside `getPayments(ids)` and `getCredits(ids)`, and the
reason is QuickBooks-shaped but belongs to every ledger: QBO records a credit
memo's application on the **Payment** that links it (ADR 0026, `map.ts`), and
`LedgerPayment` drops those credit lines on purpose so a credit is never counted
as cash. A caller holding three by-id primitives could not assemble a complete
tally without learning that quirk, and "complete" is the whole point (§3). The
adapter knows how its ledger links things, so the adapter assembles the history;
the port promises only that it is complete. It is still read-only: the port has
no method that writes, and the port-surface tests in `adapters` and `qbo` are
updated to name the new read and nothing else.

**QBO implements it** with `Id in ('…', …)` queries, chunked (`QBO_IDS_PER_QUERY`
= 100, well inside the page size so one chunk is one page):

1. `Invoice where Id in (…)`.
2. Every `LinkedTxn` of type `Payment` on those invoices — QBO lists on an
   invoice every payment applied to it, including the zero-dollar payment that
   applies a credit memo — then `Payment where Id in (…)`.
3. `resolveCreditApplications` over those payments gives the credit memos they
   apply, then `CreditMemo where Id in (…)`.

Ids are interpolated into QBO's query language inside single quotes, so every id
is proven to be digits before it is used (`assertQboId`), the same discipline
`assertWindowDate` applies to a date. An invoice that names a payment QBO then
does not return raises `QboMalformedResponse` rather than tallying without it:
a missing application is precisely the partial tally that reads as a short-pay,
and a sync that fails loudly is re-run tomorrow where a fabricated candidate is
disputed.

**`InMemoryAccountingSource` implements it** by id, plus every payment and credit
with an application naming a returned invoice.

### 3. Each invoice is tallied against all its applications — a pure step in `core-domain`

`settlementLedger(activity, histories)` is where the two reads meet, and it is
pure so the rules can be tested without a vendor:

- **Requested** is every invoice id an in-window payment or credit names.
- **Payments and credits** are the union of the histories and the in-window
  activity, deduplicated by external id, the history's copy preferred (it was
  assembled for exactly these invoices). Without the dedup a payment inside the
  window would be counted twice and every short-pay would be an overpayment.
- **Every application is trimmed to the requested set.** A history payment that
  also paid some other invoice is that invoice's business: left in, it would
  raise an `application_to_unknown_invoice` for an invoice nobody asked about.
  Trimming never touches an in-window application, because every one of those
  names a requested invoice by construction — so an in-window payment applied to
  an invoice the ledger did not return **is still an anomaly**. That is the one
  the sandbox still produces (payment 128 to invoice 96, which the recording
  does not hold) and it is the right one.

The detector is unchanged: the same passes, the same four anomaly kinds, the
same `total − payments` gap with credits beside it, the same
`DEFAULT_MIN_DISPUTE_CENTS`, the same tolerances. The one textual change is the
`application_to_unknown_invoice` detail, which said "not in this window" and now
says "which the ledger did not return", because that is what it means now.
`LedgerAnomaly` gains an optional `transactionExternalId` — the payment or
credit whose application raised it — so the anomaly can be persisted as ids
(§5).

`invoicesExamined` is now the number of invoices the ledger returned for the
window's activity. The same word, a truer count: those are the invoices whose
arithmetic was actually checked.

Replayed against the recorded sandbox over the production window, the new
semantics find the three short-pays and one anomaly, where the old found none
and eight. `packages/qbo/test/settlement-window.test.ts` asserts both, through
`QboAccountingSource` against a fake that serves the recorded bodies filtered
the way QBO filters them.

### 4. The overlap story, re-checked rather than inherited

ADR 0031 §6 said consecutive runs overlap by 34 days and that identity
resolution makes the overlap free. Under the new semantics:

- **Still free where it was.** An invoice whose short-pay became a case on day 1
  has its `ledger_invoice_id` in `deduction_identifiers`, so every later run that
  sees activity on it resolves `exact`, skips, and writes only identifier rows
  that already exist. A declined candidate is re-declined with `written: false`.
  Nothing here changed.
- **It now carries more.** An invoice stays in view for 35 days after its *last*
  payment or credit rather than 35 days after it was issued, so a partial payment
  followed by a later one is re-tallied with both, and the second pass sees the
  true gap. That is the overlap doing its job.
- **What it does not do, stated rather than discovered.** A skip is a skip: when
  a later payment shrinks or clears the gap on an invoice that already has a
  case, the case is not updated and not closed, because the `exact` branch
  writes identifiers only (ADR 0029 §3) and this change does not touch
  `resolveIdentity`, `openCase` or triage. The case keeps the gap it was opened
  with and a reviewer sees the ledger's current state on the next extract they
  ask for. Reconciling an open case against later ledger activity is a follow-up,
  and it belongs with the case's own state machine rather than with discovery.
- **The window's blind spot moves, and shrinks.** Payments are fetched by
  `TxnDate`, so a payment entered today but back-dated more than 35 days is
  never seen. That was equally true of invoices before; it is rarer for
  payments, which are usually dated the day they are received. The complete
  answer is to anchor on `MetaData.LastUpdatedTime`, which QBO can filter on;
  that is a change to the client's query builder and is left as a follow-up.

### 5. Anomalies are persisted as kind and ids, in an append-only child of the run

`ledger_sync_anomalies` (migration 0027): `org_id`, `run_id`, `kind`,
`invoice_external_id`, `transaction_external_id` (nullable: an invoice-level
anomaly has none), `recorded_at`. `kind` is a check constraint over the
detector's four kinds. The run is tied by a composite foreign key on
`(org_id, run_id)` against a new `unique (org_id, id)` on `ledger_sync_runs` —
ADR 0025 §7's pattern, the one 0025 used for credentials — so an anomaly cannot
name another tenant's run.

**No `detail` column.** The detector's detail is ledger text: invoice numbers the
customer's customer sees, amounts rendered as currency strings. The run row
already refuses a message for invariant 4's reason (ADR 0031 §2: "a run row is
not a place to keep a third party's data"), and a free-text amount in a table is
money that is not integer cents with nothing to stop someone summing it. The ids
are enough to act on — a reviewer opens invoice 96 in their own ledger — and the
kind says what to look for. The detail is re-derivable by re-running the window.

Append-only on migration 0004's pattern: revoke UPDATE/DELETE/TRUNCATE, plus
`no_update_delete` and `no_truncate` on `app.block_mutations()`. RLS with a
per-command policy set, the read policy on the org claim.

**One door, a sibling of the run's.** `app_rw` holds SELECT and no INSERT; rows
are written by `app.record_ledger_sync_anomalies(p_run_id, p_anomalies jsonb)`,
security definer for the same reason `app.record_ledger_sync_run` is and bounded
the same way — the caller's org claim must be the run's org and the caller's
subject must be the run's `requested_by`. Two more guards make it **written
once, complete**, ADR 0023's shape: the run must be `completed`, it must carry no
anomaly rows yet, and the array must have exactly `anomaly_count` elements. So
the anomaly rows of a run are all of them or none of them, and they cannot be
appended to later. `PostgresLedgerSyncStore.recordLedgerSyncRun` calls both
functions in one transaction, so a run row with a non-zero count and no rows
cannot be committed through the store either.

The one run already in production (`be42505b-…`, anomaly count 8) predates the
table and has no rows; the recorded fixture test is its record.

**The read is left for a follow-up.** Showing anomalies beside "Documents waiting
to be read" wants a store read, a view and a route change, and the case list is
not where a person reconciling a ledger works; that belongs with the connection
page that does not exist yet. The rows are queryable today, under RLS.

## Consequences

- The sync now finds short-pays on invoices of any age, as soon as the payment
  that made them lands. On the sandbox that is three found where none were.
- A run costs more reads: one query per 100 named invoices, plus one per 100
  linked payments, plus one per 100 linked credits, on top of the two window
  queries. Still a handful of calls for a ledger of normal size, and each is a
  paid read the rate limiter already governs.
- `invoicesExamined` means something different and a dashboard comparing runs
  across this change must say so: before, invoices dated in the window; after,
  invoices touched in the window.
- A ledger inconsistency that used to be counted as an anomaly — an invoice
  that names a payment the ledger will not return — now fails the run. That is
  deliberate: it is a partial tally, and a partial tally is a fabricated
  short-pay.
- A new append-only table and a new definer function. Neither reads nor writes
  anything but `ledger_sync_runs` and `ledger_sync_anomalies`.

## Invariants touched

- **1 (no submission without an approval).** Untouched. Nothing here inserts a
  `submissions`, `writebacks` or `writeoffs` row, and no gate function is read,
  replaced or referenced.
- **2 (append-only).** Extended by one table, `ledger_sync_anomalies`, named in
  its own migration per invariant 2's rule. `ledger_sync_runs` gains a unique
  constraint and no grant; no append-only table gains UPDATE or DELETE.
- **3 (money is integer cents).** Held, and the reason the detail is not stored.
  The detector's arithmetic is untouched and still integer cents through
  `money.ts`; the assembly step does no arithmetic at all; no money column is
  added.
- **4 (document content is untrusted).** Held. No model is involved. The
  anomaly table stores closed-set kinds and ledger ids, never ledger text, and
  every id reaching QBO's query language is proven to be digits first.
- **5 (Jev behind `DecisionProvider`).** Not engaged.
- **6 (RLS on every table).** Held. The new table has RLS with per-command
  policies; the door is bounded by the caller's own claims; the service role
  appears nowhere.
- **7 (thresholds auto-tighten only).** Not engaged. No threshold, tolerance,
  floor or window length changes. `DEFAULT_MIN_DISPUTE_CENTS` is untouched.

## Rollback

A new migration dropping `app.record_ledger_sync_anomalies`, then
`ledger_sync_anomalies`, then the `ledger_sync_runs_org_id_id_key` constraint —
never an edit to 0027. In code, revert `syncLedger` to list invoices by window,
drop `getInvoiceHistories` from the port and both implementations, and drop
`settlementLedger`. Rolling back the semantics restores the invisibility this
ADR exists to remove, so it should be paired with an explanation of which
short-pays the coverage number stops seeing.
