# 0043 — Triage is a queue before it is a model

- Status: accepted
- Date: 2026-09-23
- Amends: ADR 0029 §1 and §2

## Context

Phase 1.5 is "ERP read + triage". The read is built: the ledger sync finds
short-pays in a customer's QuickBooks every morning (ADRs 0029, 0031, 0035), and a
remittance advice opens one case per short-paid line (ADR 0028). Triage v1
already runs on every candidate as deterministic rules: identity resolution, then
the $25 floor or the tenant's remittance tolerance, with every outcome written
down (ADR 0029 §2).

What STRATEGY §6.3 and ADD-7 describe on top of that is a model tier: Jev,
behind `DecisionProvider`, deciding which candidates deserve a case. Its economic
argument is that opening a case spends extraction money. **In this build it does
not.** A ledger case stores a canonical JSON extract that no model reads, and a
remittance is read once for all its lines. A triage model would save almost
nothing today. With the payer's memo text kept away from it (§4), it would also
see only the numbers the rules already see.

What is scarce is a reviewer's attention, and the product spends it badly. The
case list shows the newest 100 cases, newest first, whatever their state. An
urgent case falls off the page once 100 newer ones exist. A case waiting on the
retailer sits beside one that has to be decided today. Nothing says what to do
next.

Planning the queue also found a gap in ADR 0029 §1. A case the ledger sync opens
is never moved past `discovered`: only the notice and remittance paths cross
`discovered → classified`. The case page offers "decide" and "decline" only on a
`classified` case, so a ledger case can be neither, and ADR 0029's "declinable
the day it is opened" was true of the store and false of the product. Production
holds two such cases.

## Decision

**Triage ships in two steps. Step A, now, is a deterministic work queue. Step B,
later, is a shadow-only model tier, under conditions fixed here so the next
session does not build it as something that declines.**

### 1. Step A: the queue is a pure function of what is recorded

`rankForReview(rows, today)` in `core-domain` orders every case a person can act
on now. It uses no model, no clock of its own and no I/O.

**In the queue:** every case that is not closed (`CLOSED_STATES`), not
`submitted` and not declined. A submitted case is waiting on the retailer: it is
counted on the page but not queued. A declined case (a `declined_candidates` row
naming it) was decided, even though a decline moves no state.

**The next step comes from the state:** `classified` → decide,
`analyst_review` → assemble the packet, `awaiting_approval` with no approval →
approve, `awaiting_approval` with one → record the filing, anything else →
review. An approval is shown to a viewer who prepared the decision or cannot
approve as "waiting for another approver". The database would refuse them, and
the queue should not look as if it is asking them.

**Four buckets, in this order, the founder's choice (2026-09-23):**

1. **Due within 14 days**, today included: deadline soonest first, then the
   larger amount, then the id.
2. **Past the deadline**: most recently passed first, then larger amount, then
   id. These are last-chance cases, fought late or declined as
   `deadline_passed`. They come after the cases that can still be filed on time,
   not above them.
3. **No deadline printed**: every ledger case and most remittance lines. Oldest
   short-pay first (the deduction date, else the date the case opened), then
   larger amount, then id. Age is a proxy, and the page says so: a ledger prints
   no dispute window, and the payer's real window is Phase 2 playbook data. The
   queue does not invent a date.
4. **Due later**: deadline soonest first, then larger amount, then id.

`DUE_SOON_DAYS = 14` lives in `core-domain` alone, and the case list's deadline
label imports it, so the queue and the label cannot drift apart.

**The store reads it in the same order.** `PostgresStore.reviewQueue()` reads as
`app_rw` through RLS. Its SQL sorts by the same four buckets, with the same
constant and date passed in, so a limit of 500 keeps the most urgent rows. The
pure function then gives the final order, and a test holds the two to the same
answer. Past the limit, the page says how many it is not showing rather than
cutting silently.

### 2. A ledger case can be decided (amends ADR 0029 §1)

A ledger extract's type is known by construction, so the case it opens crosses
the existing `discovered → classified` edge on `document.classified`, whose only
guard is `doc_type_known`. `recordLedgerCase` makes that move, checked through
`applyTransition`, in the transaction that already writes the notice link, the
identifiers and `case.discovered`. It appends `case.classified` with
`{classified_by: 'ledger_sync'}`. No state or edge is added.

**The cases already stuck** are moved by the sync itself. Before its loop,
`syncLedger` asks the store to classify every one of the tenant's `discovered`
cases whose notice arrived through `erp_sync`, one `case.classified` event each.
It runs as the connection's member through `app_rw`, like everything else the
sync writes, so the next scheduled run fixes production's two cases with no
operator step. It touches only `discovered` cases with an `erp_sync` notice, so
it cannot move a notice read half-way. After the first run it finds nothing and
costs one query. It also heals a ledger case left `discovered` because the sync
died between opening the case and linking its extract, which the two separate
writes in `recordLedgerCase` make possible.

### 3. Step B: a model tier, shadow only, when these conditions hold

None of this is built. It is the contract for whoever builds it.

- **Shadow only.** The model records an opinion; the rules decide. Its table
  checks `mode in ('shadow')`, so an acting row is refused by the database. A
  model that declines needs its own ADR and migration, and a decline precision
  measured against human decisions. A wrong decline is money left unfought and
  discovered after the two-year post-audit window. A wrong "open" costs a
  reviewer a minute.
- **No payer text.** The state is a whitelist of our own computed numbers and
  flags. Payer memos, credit-memo text, payment references and customer names
  are excluded, because the payer is the other side of the dispute and its memo
  is the adversary's own statement. A model with no tools can still have its
  answer steered by an injected string (invariant 4, and `DecisionState`'s own
  "never raw document text"). A memo may reach it later only as a canonical
  reason code from a deterministic playbook mapping.
- **Asked after the case opens, outside the sync.** The call runs once a case
  exists, so `DecisionState.deductionId` is real and the contract does not
  change. It runs as its own Inngest event per opened case, carrying ids only,
  with its own concurrency. It never runs inside `syncLedgerJob`'s step, or
  inside `withDocumentRead` or `withInvoiceClaim`, whose advisory locks a
  network call must not hold. With no queue (the inline runner) it does not run.
  A remittance line that resolves `exact` never opens a case, so it is never
  asked.
- **A model can never break the sync.** Every provider error — unavailable,
  contract, timeout, anything — is recorded on the opinion row and in
  `model_calls` by class name, and the case has already opened. Jev falls back
  to Claude structured on `DecisionUnavailableError` only.
- **Its table follows the current rules.** Append-only on 0004's pattern.
  Per-command RLS with insert gated on `app.member_may_write()`, as since 0010.
  `deduction_id` not null, with the `(org_id, deduction_id)` composite key of
  ADR 0025 §7. A unique idempotency key so an overlapping or redelivered sync
  does not pay twice. `model_calls.purpose` gains `'triage'`. Cost per
  candidate is measured over every candidate triaged (the sync run's counts and
  the remittance lines), not over the model-asked subset (ADD-3).
- **Enabled only when:** cassettes exist for both the Jev and the Claude call
  (CLAUDE.md, every decision path); a `triage` eval suite is recorded with a
  decline-precision baseline, whose fixtures say plainly that author-labelled
  cases measure agreement with the author; a page shows the disagreements; the
  founder has decided whether TypeSafe needs a DPA as a new sub-processor of
  customers' ledger data; and `TRIAGE_SHADOW` is set on purpose, never by
  default.

## Consequences

- The case list leads with what to do next, in an order a reviewer can read off
  the page: a bucket header and a next step on every row. An old, urgent case no
  longer drops off behind 100 new ones.
- Ledger cases get the decide and decline cards, which makes ADR 0029's coverage
  thesis actionable rather than merely counted. The two production cases move
  at the next 07:00 UTC sync, each with a `case.classified` event naming the
  sync.
- The queue needs no migration, no model and no credential, and changes no
  number any other page shows.
- Phase 1.5's exit criterion, "triage cost per candidate under a cent", is met
  trivially by rules that cost nothing, which says nothing about ADD-7. Step B
  is what measures it, and step B waits on Jev access.

## Invariants touched

- **1 (the approval gate)**: untouched. The queue reads. The ledger case's new
  state is the one a notice case has always reached by the same edge, and
  nothing in this change inserts an approval or a filing.
- **2 (append-only)**: held. `case.classified` is an insert into
  `deduction_events`. `deductions.state` was always the projection.
- **4 (documents are untrusted)**: held. The queue renders retailer names and
  claim ids as text. Step B's whitelist keeps payer text away from a model.
- **5 (DecisionProvider)**: held by construction. Step A calls no model, and
  step B is bound to `DecisionProvider`.
- **6 (RLS)**: held. `reviewQueue` and the sweep run as `app_rw` under the
  tenant's claims.
- **3, 7**: untouched. No money is computed, and no threshold moves.

## Rollback

Remove the queue view and `reviewQueue`; the list is as it was. The ledger
classification stays: undoing it would strand ledger cases again, and a
`classified` ledger case is what every notice case has always been.
