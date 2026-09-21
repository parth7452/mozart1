# 0026 — A short-paid remittance line is a discovered deduction

- Status: accepted
- Date: 2026-09-22

## Context

`openCaseFromNotice` opens a case for exactly one document type:
`deduction_notice`. A document the classifier calls `remittance_advice` is
scanned, classified, OCR'd if it is a scan, read by the model, and stored with
every field quote-verified — and then nothing happens to it. It appears on no
case list. A reviewer who uploads a remittance sees it in "Documents waiting to
be read" until the read finishes, and then it disappears from the product
entirely.

That is not a gap in a corner. In staffing, freight and foodservice — the
markets STRATEGY §5.4 names as the wedge — most deductions never get a separate
notice. The customer pays the invoice short and the remittance line *is* the
notice: an invoice number, a gross, a net, and a three-letter code. If the
remittance does not open a case, those deductions are exactly the ~70% the
coverage thesis is about, sitting inside a document we already paid to read.

Two fixture packs already carry the shape. `log-202-remittance-advice` prints a
$5,600.00 gross against $4,800.00 net and **no deduction column at all** — the
short-pay is only the subtraction. `stf-201-short-pay-remittance` prints the
deduction outright, $600.00 against code `OT-UNAUTH`. The dense
`crosswind-dense-remittance` prints 42 rows, roughly a third of them short-paid,
which is what a real advice looks like.

Three things have to be true before a line may open a case, and none of them is
a judgement call a model gets to make.

1. **The arithmetic is ours.** Invariant 3 and CLAUDE.md's "models copy, we
   compute". The model reports `"$5,600.00"` and `"$4,800.00"` as printed;
   `parseMoneyToCents` turns both into cents and the subtraction happens in our
   code, where it can be tested.
2. **Not every difference is a deduction.** A rounding difference, a
   $0.03 remainder, a settlement discount taken to the penny — filing those as
   cases would bury a reviewer under noise and make the recovery rate
   meaningless. There has to be a floor, and it has to be per-tenant, because a
   staffing agency invoicing $7,200 and a foodservice distributor invoicing $90
   do not have the same floor.
3. **The same deduction can arrive twice.** A customer short-pays an invoice and
   *also* sends a debit memo. Today those are two documents, and without a
   window they would be two cases for one deduction — which double-counts the
   book, double-counts coverage, and puts the same claim in front of two
   reviewers.

There is a second short-pay detector on `main` already:
`packages/core-domain/src/short-pay.ts`, from the `AccountingSource` port
(Phase 1.5). It is a different question and not a duplicate of this one. That
one reads a customer's own **ledger** and finds invoices that were paid and came
up short *with no document anywhere*. This one reads a **document the customer
sent us** and finds the lines on it that say so. They will eventually agree
about the same money and that agreement is the point — but the ledger path needs
an ERP connection and this one needs an email attachment, and today only one of
those exists.

## Decision

### 1. `openCasesFromRemittance`, beside `openCaseFromNotice`, in the same place

A new step in `packages/pipeline/src/steps.ts`, called from `readDocument`
exactly where `openCaseFromNotice` is called, under exactly the same three
conditions: the classifier said `remittance_advice`, the document is not being
attached to a case a reviewer named, and `allowCaseOpen` is true. The
`allowCaseOpen` guard applies unchanged and for the unchanged reason — a
remittance from a sender we could not authenticate (ADR 0016) is filed for a
human, and a re-drive of an already-read document does not get to open a second
round of cases.

Because it is inside `readDocument`, it is on the Inngest path and the inline
path at once. `readDocumentJob` wraps `readDocument`; there is one
implementation, not a queued one and a synchronous one that drift (ADR 0021).

### 2. The short-pay for a line, and what happens when there isn't one

Per line, in this order:

- `deduction_amount` as printed, when the line prints one;
- else `gross_amount − net_amount`, when the line prints both;
- else **no case**, and the line is counted as `unreadable` on the document-level
  event with the reason.

Every one of those is `parseMoneyToCents` over verbatim text. A value that will
not parse is `unreadable`, not zero: a deduction we cannot price is not a
deduction of nothing. A subtraction that comes out zero or negative is not a
short-pay and is counted as `not_short_paid` — an overpayment is a real thing
and it is not a deduction, and inventing a case for it would be worse than
silence.

We never ask the model for the difference. `RemittanceAdviceSchema` is unchanged.

### 3. Tolerance: two columns on `org_settings`, and a direction

```
remittance_tolerance_cents  bigint  not null default 500  check (>= 0)
remittance_tolerance_bps    integer not null default 50   check (between 0 and 10000)
```

A line opens a case when **both** hold:

- `delta >= remittance_tolerance_cents`, and
- the gross is unknown, **or** `delta * 10000 >= gross * remittance_tolerance_bps`.

The second is written as a cross-multiplication rather than
`delta >= gross * bps / 10000`, and that is deliberate: there is then no
division, no rounding, and no question to answer about which way a half-cent
goes. Integer cents times an integer bps is an exact integer on both sides
(invariant 3). "Round toward opening more cases" was on the table and is not
needed — the comparison is exact.

A gross we could not read does not veto the case. The absolute floor still has
to clear, and a line whose delta is over the floor with no gross to measure it
against is a deduction we can price and cannot proportion; refusing it would
lose a real case over a missing column.

**Which direction is tighter, for invariant 7.** Tighter means *less* is
automated away without a person seeing it. For a tolerance, lowering it opens
**more** cases and skips fewer — so **lowering is tightening and raising is
loosening**, which is the opposite direction from `auto_dispute_ceiling_cents`
and the same as nothing else in the table. That is exactly why it is wired into
`app.guard_threshold_direction()` rather than left to a reviewer's judgement: a
number that quietly rises is a number that quietly stops filing cases, and by
the time anyone notices the deductions it skipped are past their windows.

Migration 0021 redefines `app.guard_threshold_direction()` with `create or
replace`, keeping all four existing comparisons and adding:

```
new.remittance_tolerance_cents > old.remittance_tolerance_cents  -- loosening
new.remittance_tolerance_bps   > old.remittance_tolerance_bps    -- loosening
```

Migration 0005 is not edited. It is merged (CLAUDE.md), and `create or replace`
in a later migration is how a function changes here.

### 4. The dedup window is *not* a threshold, and is deliberately not guarded

`remittance_dedup_days integer not null default 30 check (>= 0)` goes on
`org_settings` beside them and is **not** in the direction guard. Invariant 7 is
about thresholds that gate automated action on money, and the two directions here
are not one safe and one unsafe: a longer window merges more, which risks
folding two genuinely different deductions into one case; a shorter window merges
less, which risks double-filing. Neither is the conservative side. Putting it in
the guard would claim a direction the mechanism does not have, and a guard that
asserts something false is worse than no guard. It is recorded here instead, and
a change to it is a change a person makes with this paragraph in front of them.

### 5. `deductions.discovered_via`, not a new `uploads.source`

```
discovered_via text not null default 'notice'
  check (discovered_via in ('notice', 'remittance_line'))
```

The obvious-looking alternative — a seventh `uploads.source` value,
`remittance_parse` — is wrong, and wrong in a way that would be expensive to
undo, because `uploads` is append-only since ADR 0024 and the rows written under
a bad meaning could not be relabelled.

`uploads.source` is **the door the bytes came through**: web upload, inbound
email, email body, ERP sync, portal fetch, EDI 812. It is observed at ingest,
from the entry point, and never read off a document. "This deduction was named
by a remittance line rather than by a notice" is a fact about **what the document
turned out to be**, which is known only after a model has read it. They are
orthogonal: a remittance arrives by web upload today and by `edi_812` in Phase
2.5, and the same remittance-line deduction would have to be recorded under two
different `source` values — or, worse, the door would be overwritten with the
document kind and the channel a coverage number is sliced by would become a lie.

Coverage slices by **both**: "which channel found it" and "what kind of document
named it" are two different questions a customer asks, and answering the second
by corrupting the first is not a saving. `declined_candidates.discovered_from`
keeps deriving from `uploads` exactly as ADR 0024 left it, untouched.

`discovered_via` is on `deductions`, which is a mutable projection of the event
stream, so the column costs no grant and no trigger — the same argument
migration 0015 made for `retailer_name_as_printed`.

**The remittance is linked to each case it opens with role `notice`**, not
`evidence`. It *is* the notice for that deduction, and `declineCase` derives
`discovered_from` from the case's `notice`-role document — so linking it any
other way would make every remittance-originated case undeclinable with
`ProvenanceUnknownError`, which is a provenance mechanism breaking on a document
whose provenance is perfectly well known.

### 6. `invoice_number` and `reason_code_as_printed`

```
invoice_number          text  -- nullable, <= 200 chars
reason_code_as_printed  text  -- nullable, <= 200 chars
index on (org_id, invoice_number) where invoice_number is not null
```

Both are untrusted document text, stored **as printed**, capped so a
pathological extraction cannot store a page, and used for exactly one thing:
looking a case up by invoice. `reason_code_as_printed` is never mapped to a
canonical reason code here — that mapping is a retailer's rule and so it is
Phase 2 playbook *data*, not code (CLAUDE.md), and a column called
`reason_code_as_printed` cannot later be mistaken for one that was.

The name follows `retailer_name_as_printed` for the same reason it did there:
the suffix is the whole warning.

### 7. `claim_id` for a remittance-originated case

`${payment_reference}:${invoice_number}` — the remittance's own two identifiers,
both as printed.

The remittance prints no claim id, because there is no claim: nobody filed
anything, the customer just paid less. But `unique (org_id, debtor_id, claim_id)`
and the `DuplicateCaseError` built on it (ADR 0019) are the constraint that stops
the same deduction opening two cases once a debtor resolves, and leaving
`claim_id` null opts every one of these cases out of it — nulls do not collide in
Postgres, which is the bug ADR 0019 was written about. A composite of the payment
reference and the invoice number is stable (it is on the page), unique per line
within a payment, and readable by a person looking at the remittance.

`retailer_name_as_printed` is `payer_name`; `deduction_date` is `payment_date`
through `parsePrintedDate`, month-first and deterministic, leaving the column
null and recording the reason on `case.discovered` when it will not parse —
identical to the notice path. `dispute_deadline` stays null: a remittance prints
no window, and "90 days" in its footer is a retailer rule, which is Phase 2's
job.

### 8. Dedup, in both directions, under two locks

Before a line opens a case, the store is asked
`findRecentCaseByInvoice(orgId, invoiceNumber, amountCents, withinDays)`: is
there already a case for this tenant, this invoice number, this **exact** amount
in cents, discovered within `remittance_dedup_days`? If there is, no case is
opened. The remittance is linked to the existing case as `evidence`, and
`case.merged_duplicate_line` is appended to it naming the document, the invoice,
the amount and which kind of document arrived second.

It works in both directions because it matches on `invoice_number` and nothing
about how the case was opened: a notice arriving after a remittance merges into
the remittance's case, and a remittance arriving after a notice merges into the
notice's. For that to be true of the notice direction, `openCaseFromNotice` also
fills `invoice_number` when the notice prints one — `DeductionNoticeSchema`
already carries an optional top-level `invoice_number`, "the supplier invoice
this deduction was taken against", and nothing has ever stored it. **A notice
whose invoice number is absent falls back to the existing `claim_id` dedup
only**, which is what it has today: a merge on a missing key would merge
everything.

The exact-amount match is deliberate. A notice for $600 and a remittance line for
$600 on the same invoice inside the window are one deduction. A notice for $600
and a line for $150 on the same invoice are two, and merging them would silently
drop $150 from the book.

**Two locks, because one is not enough.** `withDocumentRead` already stops two
deliveries of the *same document* reading it at once (ADR 0021 / the advisory
lock). It says nothing about two *different* documents — a notice and a
remittance, arriving seconds apart — racing the check-then-insert on the same
invoice. So `PostgresStore.withInvoiceClaim(invoiceNumber, work)` takes a second
`pg_try_advisory_xact_lock`-family lock on
`hashtextextended(org_id || ':' || invoice_number, 1)`, and the lookup and the
`openCase` both happen inside it. Seed `1`, not `0`, so an invoice key cannot
collide with a document key from `withDocumentRead`.

This one **waits** rather than giving up, which is the opposite of what
`withDocumentRead` does, and for the opposite reason: there are no model calls
inside it, only two short queries, so a waiter waits milliseconds — and a line
that gave up would be a deduction silently dropped rather than a read
harmlessly skipped. It cannot deadlock: the claim is taken and released **per
line**, so a read holds at most one invoice claim at a time and there is no
second lock for a cycle to form around.

### 9. One line's failure does not cost the others

Lines are processed one at a time, each its own `openCase`. A
`DuplicateCaseError` on line 17 of a 42-line advice is caught, counted, and the
other 41 go on. Nothing else is caught: a database that is down is not a line
outcome.

Each opened case gets `case.discovered` (with `discovered_via`, the invoice, the
amount, the reason code and how the delta was derived) and then the same
`discovered → classified` transition through the state machine table that
`openCaseFromNotice` makes, so the transition table stays the spec.

When the read is finished, `remittance.lines_processed` records the whole
outcome: counts of opened / merged / below_tolerance / not_short_paid /
unreadable / duplicate, and the ids. It carries invoice numbers and reason codes
and **no other document text** — those two are already on the case rows the
event sits beside, and the rest is untrusted content that events do not carry.

`deduction_events.deduction_id` is `not null` (migration 0004), so there is no
such thing as a document-level event today. Rather than make an append-only
table's column nullable — a schema change to an append-only table, which is its
own ADR — the summary is appended **to every case the read opened or merged
into**. Any case a reviewer lands on says what the whole read concluded and
names its siblings. A read that opened no case logs it and writes nothing, which
is what §10 is for.

### 10. Below-tolerance lines go in the counterfactual log

A line under the floor is precisely "a case we decline to fight, with what it was
worth", which is what `declined_candidates` is (migration 0014, STRATEGY ADD-1).
The schema fits without a change: `deduction_id` is **nullable** on purpose, and
0014's own comment says why — "ERP triage will decline thousands of short-pay
lines that never reach extraction, and those are the rows coverage is measured
against". These are those rows, arriving a phase earlier than expected.

So a below-tolerance line writes one row: `reason = 'below_economic_floor'`,
`estimated_recoverable_cents` = the delta, `external_ids` = the invoice number,
the payment reference and the reason code as printed, `decided_by =
'remittance_tolerance'` and `decided_by_version` = the policy that decided it,
written out as `<cents>c/<bps>bps`. That last one is what makes the column worth
having: when a tenant lowers its floor, the rows declined under the old one say
what the old one was, and the change can be evaluated against them.

`discovered_from` and `provenance_kind` are **derived in the store** from the
remittance's own arrival — observed from `documents.upload_id`, else asserted
from `document_arrivals` — by the same `coalesce`-shaped read `declineCase`
uses, and are never parameters. ADR 0024's argument applies unchanged: a channel
credited on a caller's say-so is a number that looks right.

A remittance stored **before** provenance recording existed has neither, and
`ProvenanceUnknownError` is raised. That is caught **once per document**: the
first below-tolerance line that hits it stops the decline attempts for that
document, and `remittance.lines_processed` reports the count as
`below_tolerance_unattributed` with the reason. The cases the document opened
are not lost over the lines it could not attribute, and nothing is silently
counted under a guess. It cannot happen to a document ingested since
2026-09-21; `pnpm link:provenance` is the way back for one that predates it.

`ProvenanceUnknownError` moves from `store-postgres` to
`packages/pipeline/src/ports.ts` and is re-exported from its old home, so
existing imports and every `instanceof` are unchanged. It is a refusal of the
port's contract that both stores now make, which is where `DuplicateCaseError`
already lives and for the same reason.

## Consequences

- A remittance advice stops being a document the product reads and forgets. On
  the dense 42-row fixture it opens roughly a dozen cases from one upload, which
  is the first time a single document in this system produces more than one.
- **Model spend and the extraction are recorded against no case.** One read paid
  for many cases and attributing it to one of them would overstate that case's
  cost, which is the number a contingency fee is set against (Phase 4). The
  consequence is real and is not hidden: a remittance-originated case's review
  page shows no per-field provenance panel, because `extraction_results` rows
  carry at most one `deduction_id`. The invoice number, the reason code, the
  amount and the retailer are on the case row and are rendered; the document
  itself is linked and viewable. Letting `extraction_results` name more than one
  case is a schema change to an append-only table and belongs in its own ADR —
  it is the main follow-up this change leaves behind.
- `reconcileCase` returns `undefined` for these cases, because it keys on a
  stored `deduction_notice` and there is none. That is today's behaviour for any
  case without a notice and it is honest: there is nothing yet to reconcile a
  remittance line *against*. It becomes reconcilable when the supplier's own
  invoice is attached, which is Phase 1.5's ERP read and Phase 2's evidence
  planning.
- A tenant that wants a different floor now has one to set, and can only move it
  in the direction that files more cases without an ADR.
- Three new `org_settings` columns are defaulted, so every existing tenant gets
  $5.00 / 50 bps / 30 days without anyone doing anything. Those defaults are a
  guess about a market, not a measurement; the first customer's real numbers
  should move them.

## Invariants touched

- **1 (no submission/writeback/writeoff without an approval row).** Untouched.
  Nothing here writes to any of the three tables, and `app.require_approval()` is
  not edited. A remittance-originated case is an ordinary `deductions` row and
  goes through the identical gate.
- **2 (append-only, including `*_events`, `documents`, `uploads`,
  `document_arrivals`, `decisions`, `approvals`, `audit_log`).** Honoured, and
  deliberately not extended. `deductions` and `org_settings` are mutable
  projections and gain nullable or defaulted columns there — no grant changes, no
  trigger changes, no new UPDATE or DELETE grant anywhere in migration 0021.
  `declined_candidates` gains rows through its existing INSERT grant and nothing
  else. `deduction_events.deduction_id` is left `not null`, which is the reason
  §9 puts the summary on the cases rather than making it nullable.
- **3 (money is integer cents, bigint, never floats).** Central here. Every
  amount is `parseMoneyToCents` over verbatim printed text; the delta is an
  integer subtraction; the proportional floor is an integer cross-multiplication
  with no division anywhere. `remittance_tolerance_cents` is `bigint`. The
  property tests over `money.ts` are untouched and the new line-level arithmetic
  gets unit tests of its own on both sides of both thresholds.
- **4 (document content is untrusted; the reader has no tools).** Untouched and
  load-bearing. `RemittanceAdviceSchema` is unchanged, no tool is added to any
  call, and the model is never asked for a difference — it copies two amounts and
  our code subtracts. `invoice_number` and `reason_code_as_printed` are stored as
  printed, capped, escaped by the views, and used only as lookup keys. The
  invoice number selects an existing case; like a retailer name selecting a
  debtor (ADR 0019), it may **select**, never mint.
- **5 (Jev behind `DecisionProvider`).** Untouched. No decision is made here: a
  discovered case is a case a human or Jev will decide later, and opening one is
  not deciding it.
- **6 (RLS on every table).** Honoured. No new table, so no new policy is needed;
  every read and write goes through `PostgresStore` as `app_rw` with the tenant's
  claims set transaction-locally, including both advisory-lock connections. The
  service role appears nowhere. `supabase/tests/15_every_table_has_rls.sql`
  passes unchanged because the table count is unchanged.
- **7 (thresholds auto-tighten only; loosening needs a human and an ADR).**
  Extended. Two new threshold columns join `app.guard_threshold_direction()` with
  their direction argued above — **raising** a tolerance is the loosening, which
  is the opposite sense from the ceilings already in the guard, so the comparison
  is `>` where theirs is `>` for a ceiling and `<` for a confidence floor, and
  the reasoning is written into the migration beside the code.
  `remittance_dedup_days` is deliberately not in the guard (§4).

## Rollback

Reverting is a new migration — never an edit to 0021 once merged — that drops
`deductions.invoice_number`, `deductions.reason_code_as_printed`,
`deductions.discovered_via` and its index, drops the three `org_settings`
columns, and `create or replace`s `app.guard_threshold_direction()` back to
0005's four comparisons. `supabase/tests/16_remittance_lines.sql` goes with it,
and `openCasesFromRemittance` and its store methods come out of the pipeline.

Two things a revert has to decide, and neither is automatic. The cases already
opened from remittance lines are ordinary `deductions` rows and stay — dropping
`discovered_via` only loses the ability to tell them apart from notice-opened
ones, which is a reason to export the column before dropping it rather than a
reason to delete the rows. And the `declined_candidates` rows written for
below-tolerance lines are append-only and cannot be removed; a coverage number
computed after the revert still includes them, correctly, because they record
something that was in fact decided.

Dropping the two guard comparisons is itself a loosening in invariant 7's sense —
it hands back the ability to raise a tolerance, and so to stop filing cases,
without an ADR — so that half needs its own ADR saying why.
