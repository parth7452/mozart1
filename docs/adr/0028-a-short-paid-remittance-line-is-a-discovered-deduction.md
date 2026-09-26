# 0028 — A short-paid remittance line is a discovered deduction

- Status: accepted; §7's claim key amended by 0048 for an invoice printed on several lines;
  §7 carries a note (2026-09-25) on naming a probable match as a pair
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

Three fixtures already carry the shape. `log-202-remittance-advice` prints a
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
   *also* sends a debit memo. Without something to recognise that, they are two
   cases for one deduction — which double-counts the book, double-counts
   coverage, and puts the same claim in front of two reviewers.

### Two things that landed while this was being written

**ADR 0025 / migration 0020 — a deduction has many identifiers.**
`deduction_identifiers` exists precisely so that one deduction can carry a claim
id, an invoice number, an EDI reference and a portal id at once, each qualified
by the source that said it, append-only. `resolveIdentity` in
`packages/core-domain/src/identity.ts` is the matcher that reads it, and its gate
is asymmetric on purpose: an exact identifier match resolves, a probable one is
held for a person, and nothing else merges. That is the mechanism this change's
dedup has to be built out of rather than beside, and §6 is where it is.

**`detectShortPays` — the *other* short-pay detector.**
`packages/core-domain/src/short-pay.ts` also finds short-pays, over a customer's
own **ledger** (Phase 1.5): an invoice for $100,000 against which $92,000
arrived. This one reads a **document the customer sent us**. They will
eventually agree about the same money and that agreement is the point, but the
ledger path needs an ERP connection and this one needs an email attachment, and
today only one of those exists. §9 says what is shared between them and what is
not.

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
- else **no case**, and the line is counted as `unreadable` with the reason.

Every one of those is `parseMoneyToCents` over verbatim text, and the
subtraction is `subCents` — `core-domain`'s own, which keeps the `Cents` brand
and refuses a result outside the safe integer range rather than producing one
(§9). A value that will not parse is `unreadable`, not zero: a deduction we
cannot price is not a deduction of nothing. A subtraction that comes out zero or
negative is `not_short_paid` — an overpayment is a real thing and it is not a
deduction, and inventing a case for it would be worse than silence.

We never ask the model for the difference. `RemittanceAdviceSchema` is unchanged.

**Note (2026-09-26, no migration).** "Prints one" means prints an amount. A
deduction column printing only a dash (`-`, `–`, `—`, `$ -`) prints none
(`printsNoAmount` in `core-domain`), so the line goes to the subtraction:
`not_short_paid` when gross equals net, a case at `gross − net` when it does
not. It used to be `unreadable`, which dropped the 30 paid-in-full lines of the
dense advice there and would have dropped a real short-pay printed beside a
dash. `parseMoneyToCents` still refuses a dash; it is never zero cents.

### 3. Tolerance: two columns on `org_settings`, and a direction

```
remittance_tolerance_cents  bigint  not null default 500  check (>= 0)
remittance_tolerance_bps    integer not null default 50   check (between 0 and 10000)
```

A line opens a case when **both** hold:

- `delta >= remittance_tolerance_cents`, and
- the gross is unknown, **or** `delta * 10000 >= gross * remittance_tolerance_bps`.

The second is written as a cross-multiplication in `BigInt` rather than
`delta >= applyBps(gross, bps)`, and that is deliberate. `applyBps` rounds
half-up, which is right for computing a fee and wrong for a threshold: it would
make a line exactly on the boundary fall one side or the other depending on the
cent, and nobody reading the code could say which without working out the
rounding. Cross-multiplied there is no division, no rounding and no question,
and integer cents times an integer bps is exact on both sides at any amount a
document could print.

A gross we could not read does not veto the case. The absolute floor still has
to clear, and a line whose delta is over the floor with no gross to measure it
against is a deduction we can price and cannot proportion; refusing it would
lose a real case over a missing column.

**Which direction is tighter, for invariant 7.** Tighter means *less* is skipped
without a person seeing it. For a tolerance, lowering it opens **more** cases —
so **lowering is tightening and raising is loosening**, which is the opposite
direction from `auto_dispute_ceiling_cents` and the same as nothing else in the
table. That is exactly why it is wired into `app.guard_threshold_direction()`
rather than left to a reviewer's judgement: a number that quietly rises is a
number that quietly stops filing cases, and by the time anyone notices, the
deductions it skipped are past their windows.

Migration 0022 redefines `app.guard_threshold_direction()` with `create or
replace`, keeping all four existing comparisons and adding:

```
new.remittance_tolerance_cents > old.remittance_tolerance_cents  -- loosening
new.remittance_tolerance_bps   > old.remittance_tolerance_bps    -- loosening
```

Migration 0005 is not edited. It is merged (CLAUDE.md), and `create or replace`
in a later migration is how a function changes here.

### 4. The dedup window is *not* a threshold, and is deliberately not guarded

`remittance_dedup_days integer not null default 30 check (>= 0)` goes on
`org_settings` beside them and is **not** in the direction guard. It is
`resolveIdentity`'s `dateToleranceDays`: how far apart two printings of one
deduction date may be and still be the same deduction. Invariant 7 is about
thresholds that gate automated action on money, and the two directions here are
not one safe and one unsafe — a longer window flags more probable duplicates for
a person, a shorter one flags fewer, and since §6 **never merges on a probable
match anyway**, neither direction can silently destroy anything. A guard here
would assert a direction the mechanism does not have, and a guard that asserts
something false is worse than no guard.

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

### 6. The invoice number is an identifier, not a column — and dedup is `resolveIdentity`

An earlier draft of this ADR added `deductions.invoice_number` with its own
index. It is not here, and migration 0020 is why: a deduction's names are
`deduction_identifiers` now — source-qualified, append-only, one kind per row,
with `invoice_number` already among the six kinds it admits. A column on
`deductions` would be a second, *mutable* place for the same fact, and the two
would disagree the first time a portal or an EDI 812 named the same invoice
differently. Worse, the column would be the one the dedup query read, so the
disagreement would decide whether two documents are one deduction.

So:

**Every case this change opens writes its identifiers.** A remittance-line case
writes a `claim_id` row (the composite of §7) and an `invoice_number` row. And
`openCaseFromNotice` — which until now wrote none, because ADR 0025 left wiring
`openCase` into that table as follow-up and nothing but the backfill has ever
written it — writes the same two: the notice's `claim_id`, and its top-level
`invoice_number` where it prints one. Without that second half the window would
work remittance→notice and not the commoner order, notice first and remittance a
week later.

**`source` needs no widening.** `deduction_identifiers.source` admits the six
`uploads.source` channels, and the source of a name read off a document is the
channel that document arrived through — which is one of those six. It is derived
in the store from the document's own arrival, observed or asserted, by the same
read `declineCase` uses. It is never a parameter, for ADR 0024's reason.

A document that records no arrival at all — one stored before 2026-09-21 — gets
**no identifier rows**, and the reason is recorded on the case's
`case.discovered` event rather than guessed at. This is a different call from
`declined_candidates.discovered_from`, which is *refused* in the same situation,
and the difference is what the column is for: `discovered_from` is a published
coverage number, so a guess there is a wrong number that reads like a right one.
An identifier's source only qualifies a name, and a missing row makes the matcher
answer `none` — a second case, which is visible and mergeable — rather than a
wrong merge, which is not. Writing nothing is the conservative direction here and
refusing would be the reckless one, because it would cost the case.

**The dedup decision is `resolveIdentity`, and it merges only on `exact`.**
Before a line opens a case, the store is asked for the identifier rows and the
candidate deductions that could match, and `resolveIdentity` is run over them
with `dateToleranceDays = remittance_dedup_days`. Then:

- **`exact`** — an arrival identifier equals a known identifier of the same kind.
  Merge: no case is opened, the remittance is linked to the existing case as
  `evidence`, and `case.merged_duplicate_line` is appended to it naming the
  document, which kind of document arrived second, the invoice, the amount, and
  what the match was on.
- **`probable` or `ambiguous`** — **open the case anyway**, and record on its
  `case.discovered` event that a probable duplicate exists, with the other case's
  id and the basis that agreed. A person decides. This is ADR 0025's rule applied
  literally and it is the opposite of what the founder's brief asked for, so it
  is worth saying why: a duplicate case is visible — two rows, one claim, the
  money still disputable — and a wrong merge is invisible, because the arrival
  disappears into another deduction's row and nothing records that a second
  deduction was ever seen. With post-audit claims reaching back two years we
  would find out long after the window closed.
- **`none`** — open the case.

**The arrival's exact-match identifiers deliberately do not include the invoice
number.** The invoice number is *written* as an identifier, because it is a name
the deduction is known by; it is not *matched* on as an exact key, because one
invoice legitimately carries many deductions — a shortage and a price claim
against the same invoice are two. Matching exactly on it would merge them and
destroy one. It reaches `resolveIdentity` as `arrival.invoiceNumber`, which is
the probable branch's field, where it has to agree with the amount and the date
before it means anything and still only produces a flag for a person.

**Two locks, because one is not enough.** `withDocumentRead` already stops two
deliveries of the *same document* reading it at once (ADR 0021). It says nothing
about two *different* documents — a notice and a remittance, arriving seconds
apart — racing the resolve-then-open on the same invoice. So
`PostgresStore.withInvoiceClaim(invoiceNumber, work)` takes a second advisory
lock on `hashtextextended(org_id || ':' || invoice_number, 1)`, and the
resolution and the `openCase` both happen inside it. Seed `1`, not `0`, so an
invoice key cannot collide with a document key from `withDocumentRead`.

This one **waits** rather than giving up, which is the opposite of what
`withDocumentRead` does, and for the opposite reason: there are no model calls
inside it, only short queries, so a waiter waits milliseconds — and a line that
gave up would be a deduction silently dropped rather than a read harmlessly
skipped. It cannot deadlock: the claim is taken and released **per line**, so a
read holds at most one invoice claim at a time and there is no second lock for a
cycle to form around.

### 7. `claim_id` for a remittance-originated case

`${payment_reference}:${invoice_number}` — the remittance's own two identifiers,
both as printed, and the invoice number alone when the advice prints no payment
reference.

The remittance prints no claim id, because there is no claim: nobody filed
anything, the customer just paid less. But `unique (org_id, debtor_id, claim_id)`
and the `DuplicateCaseError` built on it (ADR 0019) are the constraint that stops
the same deduction opening two cases once a debtor resolves, and leaving
`claim_id` null opts every one of these cases out of it — nulls do not collide in
Postgres, which is the bug ADR 0019 was written about. A composite of the payment
reference and the invoice number is stable (it is on the page), unique per line
within a payment, and readable by a person looking at the remittance. It is also
what makes `resolveIdentity`'s **exact** branch fire on a re-read of the same
advice, which is the one duplicate we are certain about.

`retailer_name_as_printed` is `payer_name`; `deduction_date` is `payment_date`
through `parsePrintedDate`, month-first and deterministic, leaving the column
null and recording the reason on `case.discovered` when it will not parse —
identical to the notice path. `dispute_deadline` stays null: a remittance prints
no window, and "dispute within 90 days" in its footer is a payer rule, which is
Phase 2's job.

**Note (2026-09-25, audit F1, no migration).** Because this composite is the
only identifier a line resolves on exactly, a line that *probably* matches a
case already open — a notice read first, then the advice that short-paid it —
is resolved in `openCasesFromRemittance`, not in `openCase`, which never sees
the invoice number on this path. Until this note the match was written only
into the line's own `case.discovered` event (`probable_duplicate_of`), which
nothing reads, so the pair never reached Possible duplicates (ADR 0032) and
could never be answered or merged (ADR 0042 answered `not_confirmed`). The
reverse order was unaffected, because the notice's `openCase` names the pair
itself. `openCaseForLine` now also appends one `case.possible_duplicate`
event per candidate on the line's case, `{ of, basis }` exactly as `openCase`
writes it, so the list, the verdict and the merge check read it unchanged.
`probable_duplicate_of` stays on `case.discovered` as before. Cases opened
before the fix are repaired by `pnpm link:duplicates`, an operator command that
names each match from its `case.discovered` payload as `app_rw` with a
member's claims (ADR 0034), skips any pair already named in either direction,
and adds `backfilled_from_event` to the payload so the repair is traceable.
Events are append-only, so the repair is additive and running it twice writes
nothing more.

### 8. One line's failure does not cost the others

Lines are processed one at a time, each its own `openCase`. A
`DuplicateCaseError` on line 17 of a 42-line advice is caught, treated as the
merge it is, and the other 41 go on. Nothing else is caught: a database that is
down is not a line outcome.

Each opened case gets `case.discovered` — with `discovered_via`, the invoice, the
amount, the reason code, how the delta was derived, and any probable duplicate —
and then the same `discovered → classified` transition through the state machine
table that `openCaseFromNotice` makes, so the transition table stays the spec.

When the read is finished, `remittance.lines_processed` records the whole
outcome: counts of opened / merged / probable_duplicate / below_tolerance /
not_short_paid / unreadable, and the ids. It carries invoice numbers and reason
codes and **no other document text** — those two are already on the case rows and
identifier rows the event sits beside, and the rest is untrusted content that
events do not carry.

`deduction_events.deduction_id` is `not null` (migration 0004), so there is no
such thing as a document-level event today. Rather than make an append-only
table's column nullable — a schema change to an append-only table, which is its
own ADR — the summary is appended **to every case the read opened or merged
into**. Any case a reviewer lands on says what the whole read concluded and names
its siblings. A read that opened no case logs it and writes nothing, which is
what §10 is for.

### 9. What is shared with `detectShortPays`, and what is not

`detectShortPays` was read before any arithmetic here was written. Three things
came out of that:

- **Its tolerance helpers do not exist.** It has no floor of any kind: every
  invoice paid short by a cent is a candidate, because triage downstream is what
  decides what to do about one. There was nothing to share and nothing to
  duplicate.
- **Its gap rule does not transfer, and assuming it did would be a bug.** Its gap
  is `total − payments`, with credits reported beside it and deliberately *not*
  subtracted, because a credit memo raised by the supplier's own bookkeeper is a
  write-off rather than a payment. A remittance line has no credits on it at all:
  what it prints is one payer's own statement of gross, deduction and net. The
  two arrive at "money that did not come" from different rows and the shapes do
  not compose.
- **What is shared is `money.ts`**, which is where sharing belongs: every amount
  here is `parseMoneyToCents` and every subtraction is `subCents`, the same
  primitives `detectShortPays` uses, so the safe-integer refusal and the `Cents`
  brand are one implementation rather than two. `applyBps` was considered for the
  proportional floor and rejected for §3's reason.

The two detectors meet later, in Phase 1.5's triage: a ledger candidate and a
remittance-line case for the same invoice are one deduction, and
`deduction_identifiers` plus `resolveIdentity` is already the mechanism that will
say so. That is exactly why this change writes identifier rows rather than a
column.

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
uses, and are never parameters.

A remittance stored **before** provenance recording existed has neither, and
`LineProvenanceUnknownError` is raised. That is caught **once per document**: the
first below-tolerance line that hits it stops the decline attempts for that
document, and `remittance.lines_processed` reports the count as
`below_tolerance_unattributed` with the reason. The cases the document opened are
not lost over the lines it could not attribute, and nothing is silently counted
under a guess. It cannot happen to a document ingested since 2026-09-21;
`pnpm link:provenance` is the way back for one that predates it.

The refusal is its own class, in `packages/pipeline/src/ports.ts` beside
`DuplicateCaseError` — not `store-postgres`'s `ProvenanceUnknownError`, which is
about a **case** ("case X cannot be declined") and takes a `deductionId`. A
below-tolerance line has no case, and passing that class a made-up id to reuse it
would put a fiction in a message a person reads. Same rule, different subject, and
the subject is the part that tells somebody what to go and fix.

## Consequences

- A remittance advice stops being a document the product reads and forgets. On
  the dense 42-row fixture it opens a dozen or so cases from one upload, which is
  the first time a single document in this system produces more than one.
- **`deduction_identifiers` starts being written on the live path**, which ADR
  0025 left as follow-up. Every case opened from today carries its claim id and,
  where a document printed one, its invoice number — so the matcher has something
  to match against rather than only the backfilled claim ids.
- **Model spend and the extraction are recorded against no case.** One read paid
  for many cases and attributing it to one of them would overstate that case's
  cost, which is the number a contingency fee is set against (Phase 4). The
  consequence is real and is not hidden: a remittance-originated case's review
  page shows no per-field provenance panel, because `extraction_results` rows
  carry at most one `deduction_id`. The invoice number, the reason code, the
  amount and the payer are on the case row and its identifier rows and are
  rendered; the document itself is linked and viewable. Letting
  `extraction_results` name more than one case is a schema change to an
  append-only table and belongs in its own ADR — it is the main follow-up this
  change leaves behind.
- **A remittance whose read died part-way is not retried.** `recordedRead` treats
  any document with an extraction as read, and that is left alone on purpose: a
  remittance that reached the decline step would write its `declined_candidates`
  rows a second time, and those are append-only and summed into coverage. A
  duplicated decline is a double-counted dollar in a published number, which is
  worse than a document a person has to look at. The narrow case — a read that
  recorded fields and then failed before opening anything — is visible in the log
  line `reportLinesProcessed` writes.
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
  trigger changes, no new UPDATE or DELETE grant anywhere in migration 0022.
  `declined_candidates` and `deduction_identifiers` gain rows through their
  existing INSERT grants and nothing else; neither table's definition is touched.
  `deduction_events.deduction_id` is left `not null`, which is the reason §8 puts
  the summary on the cases rather than making it nullable.
- **3 (money is integer cents, bigint, never floats).** Central here. Every
  amount is `parseMoneyToCents` over verbatim printed text; the delta is
  `subCents`; the proportional floor is an integer cross-multiplication with no
  division anywhere. `remittance_tolerance_cents` is `bigint`. The property tests
  over `money.ts` are untouched and the new line-level arithmetic gets unit tests
  of its own on both sides of both thresholds.
- **4 (document content is untrusted; the reader has no tools).** Untouched and
  load-bearing. `RemittanceAdviceSchema` is unchanged, no tool is added to any
  call, and the model is never asked for a difference — it copies two amounts and
  our code subtracts. Invoice numbers and reason codes are stored as printed,
  capped, escaped by the views, and used only as keys. An invoice number may
  **select** an existing case and never mint anything, the rule ADR 0019 set for
  a retailer name selecting a debtor — and §6 is stricter still, because selecting
  on it alone never merges.
- **5 (Jev behind `DecisionProvider`).** Untouched. No decision is made here: a
  discovered case is a case a human or Jev will decide later, and opening one is
  not deciding it.
- **6 (RLS on every table).** Honoured. No new table, so no new policy is needed;
  every read and write goes through `PostgresStore` as `app_rw` with the tenant's
  claims set transaction-locally, including both advisory-lock connections. The
  service role appears nowhere. The every-table-has-RLS suite passes unchanged
  because the table count is unchanged.
- **7 (thresholds auto-tighten only; loosening needs a human and an ADR).**
  Extended. Two new threshold columns join `app.guard_threshold_direction()` with
  their direction argued above — **raising** a tolerance is the loosening, which
  is the opposite sense from the ceilings already in the guard.
  `remittance_dedup_days` is deliberately not in the guard (§4).

## Rollback

Reverting is a new migration — never an edit to 0022 once merged — that drops
`deductions.reason_code_as_printed` and `deductions.discovered_via`, drops the
three `org_settings` columns, and `create or replace`s
`app.guard_threshold_direction()` back to 0005's four comparisons.
`supabase/tests/18_remittance_lines.sql` goes with it, and
`openCasesFromRemittance` and its store methods come out of the pipeline.

Three things a revert has to decide, and none is automatic. The cases already
opened from remittance lines are ordinary `deductions` rows and stay — dropping
`discovered_via` only loses the ability to tell them apart from notice-opened
ones, which is a reason to export the column before dropping it rather than a
reason to delete the rows. The `deduction_identifiers` rows this change wrote are
append-only and are not removed: they are correct statements about what each
deduction is called, and they remain useful to every other source. And the
`declined_candidates` rows written for below-tolerance lines cannot be removed
either; a coverage number computed after the revert still includes them,
correctly, because they record something that was in fact decided.

Dropping the two guard comparisons is itself a loosening in invariant 7's sense —
it hands back the ability to raise a tolerance, and so to stop filing cases,
without an ADR — so that half needs its own ADR saying why.
