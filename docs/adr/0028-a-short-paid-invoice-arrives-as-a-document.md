# 0028 — A short-paid invoice arrives as a document

- Status: accepted
- Date: 2026-09-21

*Numbering: this is 0028. The identity decision it builds on — "a deduction has
many identifiers and one row" — is cited throughout as ADR 0027 and its table's
migration as 0021, which is where a parallel renumbering puts them.*

## Context

`detectShortPays` (`packages/core-domain/src/short-pay.ts`, the arithmetic behind
the accounting port of ADR 0026)
can already look at a customer's own ledger and say: this invoice was for
$100,000, $92,000 arrived, and $8,000 is missing. That is the coverage thesis'
whole point — a deduction can only enter this system today if the supplier
already knew about it and sent it to us, and STRATEGY §5 says the ~70% they
never surface is the market (`uploads.source` was constrained to two channels
for exactly that reason until migration 0014 opened it).

What does not exist is the part after the arithmetic. A `ShortPayCandidate` is a
value object in memory. Nothing stores it, nothing decides whether it is worth
fighting, nothing records the ones we decide against, and nothing stops the next
sync opening a second case for the same invoice. Four questions have to be
answered together, because each answer constrains the next:

1. **How does a ledger-discovered deduction enter the system?** Every other
   deduction enters as a document, and a great deal rests on that: provenance is
   derived from `uploads` (ADR 0024), `declineCase` refuses a case whose notice
   records no arrival, and the post-audit defence is that every number traces to
   something stored.
2. **What decides whether to open a case?** STRATEGY §6.3 and ADD-7 reserve this
   slot for a Jev triage tier — thousands of candidate lines per tenant per
   month, most of which must never reach extraction at ~$0.015–0.128 a document.
3. **What happens when the ledger names a deduction we already have?** ADR 0027
   built `resolveIdentity` and `deduction_identifiers` for precisely this
   arrival and left the wiring to "the wiring task". This is it.
4. **What is too small to fight?** A remittance rounding difference of two cents
   is not a deduction, and there is no floor constant anywhere in the codebase.

## Decision

### 1. A ledger-discovered deduction enters as a document, through the same door

`buildLedgerExtract(candidate, invoice, payments, credits)` in `core-domain`
renders one **canonical JSON ledger extract** per short-paid invoice: the
candidate's own fields, plus the ledger rows that produced it — the invoice, the
payments applied to it and the credits applied to it, each with the source's own
external ids, dates, memos and references verbatim. Those bytes are then stored
through the path an email attachment takes and no other:

```
recordUpload(source: 'erp_sync', createdBy: null)
  → putDocument(uploadId, sha256, 'application/json')
  → openCase(...)
  → linkDocument(role: 'notice')
```

Three things follow from choosing a document rather than a new table:

- **Provenance is derived, not asserted.** The `uploads` row exists before the
  bytes do, exactly as `ingestDocument` writes it, so `documents.upload_id` is
  filled and `declineCase` can read `erp_sync` off the case's own notice. No
  caller ever passes a channel, which is the rule ADR 0024 §1 made
  non-negotiable for a column coverage is grouped by. A case opened this way is
  declinable the day it is opened. A shadow table would have made every
  ERP-discovered case undeclinable, which is the exact hole ADR 0024 §3 had to
  build `document_arrivals` to dig out of.
- **The extract is what a reviewer sees.** A case page renders documents. A
  ledger extract is a document, so the page works, the packet can enclose it,
  and the post-audit answer to "where did this $8,000 come from" is a stored
  artefact with a hash rather than a re-run of a query against a ledger that has
  since moved on.
- **`created_by` is null.** The arrival had no signed-in member behind it — a
  scheduled job read a third party's API — and `uploads.created_by` means the
  member who put a document in front of the pipeline. The email path already
  answers this way for the same reason.

**The extract is untrusted content, like any document.** Its fields are a
vendor's strings about a third party's ledger; the customer name, the memos and
the references are all text nobody here wrote. Nothing in this path reads it
with a model, but the rule that matters is the one it obeys anyway: our code
does the arithmetic (`detectShortPays`, integer cents throughout) and the
identifiers it yields are stored verbatim, bounded and compared, never executed
and never allowed to mint master data. `openCase` keeps its ADR 0019 behaviour
unchanged — `retailer_name_as_printed` gets the ledger's customer name as
printed, and a debtor is *selected* only when exactly one alias matches, never
created.

**Canonical serialisation, so a re-sync is free.** Keys are emitted in a fixed
order, arrays are sorted by the ledger's own external ids, money is integer
cents and no timestamp of "now" appears anywhere. The same ledger state
therefore produces byte-identical bytes and the same sha256 — so
`findDocumentByHash` recognises the second sync's extract as the document it
already holds, and `ingestDocument`'s rule ("a re-upload keeps the first
arrival's `upload_id` and records nothing new") applies here without a second
mechanism. A ledger that has genuinely changed produces different bytes and a
new document, which is correct: it is a different statement about the invoice.

### 2. Triage v1 is deterministic rules, and the model slot is left open

`triageCandidate(candidate, resolution, { minDisputeCents })` is a pure function
in `core-domain` returning `open_case` / `skip_exact_match` / `decline`. No
model, no I/O, no provider. STRATEGY ADD-7's `DecisionProvider` slot is carried
as a **named port parameter on `syncLedger` that defaults to "no provider"**, to
be filled in Phase 2; `packages/decision` keeps its port with no implementation
and this ADR does not build one.

Why rules first, when §6.3 is explicitly an argument for a model here:

- The rules that matter at v1 — is this the deduction we already hold, is it
  above the floor — are comparisons of structured fields we computed ourselves.
  A model in front of them would be an unreviewable judgement in front of the
  operation that decides whether a disputable deduction is ever disputed, which
  is the position ADR 0027 §5 already refused for identity.
- **Every rule writes a row.** A declined candidate is a counterfactual-log
  entry, not a discard (STRATEGY ADD-1), and each carries `decided_by =
  'triage-rules'` with a version. That is what makes the later model evaluable:
  Phase 2 can be scored against exactly the population the rules declined,
  rather than against a set nobody recorded.
- §6.3's economics are about *volume* — thousands of lines where extraction is
  unaffordable. The rules cost nothing per line, so nothing about the funnel is
  blocked by waiting; what a model adds is judgement on the residue, and the
  residue is not knowable until the deterministic half has run against a real
  ledger.

### 3. The identity gate is asymmetric, and it errs towards keeping the deduction

`resolveIdentity` is asked before anything is written, and its four answers get
four different treatments (ADR 0027 §6 is the reasoning; this is the wiring):

| Resolution | What happens |
| --- | --- |
| `exact` | **Skip.** No case, no decline, no document. The only write is an identifier row for a *kind we did not already hold* for that deduction — the ledger's own name for a deduction a notice found is a fact worth recording, and it makes the next sync's match cheaper. Never a second case. |
| `ambiguous` | **Decline**, `duplicate_of_other`, with the candidate deduction ids in `detail`, so a person sees it. Two matches count as none: we do not choose. |
| `probable` | **Open the case anyway**, and record a `case.possible_duplicate` event naming the other deduction and the basis. |
| `none` | Open the case. |

The `probable` branch is the one worth defending. ADR 0027 says a probable pair
is "held for a human" and that nothing in it built the queue to hold it in. The
queue still does not exist. Given that, there are two ways to be wrong, and they
are not symmetric: opening a duplicate case is visible — two rows, one invoice,
a reviewer sees both and the money is still disputable — whereas dropping the
arrival is invisible, and with post-audit windows of about two years we would
find out long after the deadline passed. So a `probable` arrival becomes a case
with a flag on it, which is the visible failure. The event is the held-pair
record until a merge operation exists (STRATEGY §5.2), and it carries basis
names, never values, because a basis is written onto an append-only event and
document text does not go there (invariant 4).

A decline on `ambiguous` and an open on `probable` may look inconsistent. They
are not: `ambiguous` means *exact identifier matches pointing at more than one
deduction*, which is a database this sync cannot safely add to; `probable` means
no identifier matched at all and some fields agreed, which is a guess we decline
to act on in either direction.

### 4. The economic floor: `DEFAULT_MIN_DISPUTE_CENTS = 2_500`

A candidate whose `gapCents` is below the floor is declined
`below_economic_floor` — with a row, a number and the identifiers, so it is
counted rather than dropped.

**$25.00, and deliberately far below what a dispute costs.** The honest cost of
a dispute is a reviewer's minutes plus $0.015–0.128 of extraction, which would
argue for a floor of several hundred dollars. That is not the number to write
down now, for three reasons. The long tail *is* the product (STRATEGY §3.1): a
floor set where a human's time breaks even is the incumbent's floor, and
reproducing it here would decline exactly the deductions we exist to fight.
Second, nothing has measured a recovery rate yet — §9's go/no-go is a customer
running one case end to end — so a floor chosen on cost modelling would be a
guess that quietly removes dollars from the coverage numerator before anybody
can see them. Third, $25 still does the one job v1 needs: a two-cent remittance
rounding difference, a freight-rounding penny, a $3 fuel-surcharge tail are not
deductions anybody would dispute, and they would otherwise open cases and spend
extraction budget.

**Which way it may move.** A *lower* floor opens more cases and declines fewer,
so lowering is the tightening direction and may be done freely. **Raising it
declines more deductions automatically and is a loosening**: it needs a human
and an ADR, per CLAUDE.md's threshold rule. `assertMinDisputeCentsDirection` in
`packages/core-domain/src/thresholds.ts` states that in code beside the
constant, in the shape `assertThresholdDirection` already uses.

**What the database does not do here, said plainly.** Invariant 7 says the
database refuses a loosening, and for the four `org_settings` thresholds it
does. This is not one of them: it is a code default with no column behind it,
because per-tenant dispute floors are a migration and a product decision nobody
has asked for yet. So the enforcement for this threshold is a PR, an ADR and the
assertion above — weaker than a trigger, and named as weaker rather than implied
to be the same thing. When a tenant first needs its own floor, that migration
adds the column to `org_settings`, adds it to `Thresholds`, and inherits the
real enforcement; this constant becomes its default.

### 5. Where each piece lives

- `core-domain`: `ledger-extract.ts` (canonical bytes), `triage.ts` (the rules),
  the floor constant. Pure, no I/O, property-tested.
- `store-postgres`: `PostgresDiscoveryStore` in `discovery.ts` — a separate
  class with its own tenant scoping, modelled on `workflow.ts`, running as
  `app_rw` under the tenant's claims like everything else. The service role
  appears nowhere. It holds a `PostgresStore` and **delegates** `putDocument`,
  `openCase` and `findDocumentByHash` rather than copying them.
- `pipeline`: `syncLedger` in `discovery.ts` — pure over ports, in the manner of
  every other step, so the whole sync runs in a test with no database and no
  vendor.

**`recordLedgerCase` is not one transaction, and that is a consequence rather
than a choice.** `recordUpload`, `putDocument` and `openCase` each open their
own transaction inside `PostgresStore`, and `store.ts` is not edited here. The
writes that must land together do: the notice link, the identifier rows and the
`case.discovered` / `case.possible_duplicate` events are one transaction in
`PostgresDiscoveryStore`, because the identifier rows are what stop the *next*
sync opening a duplicate case. What remains is a crash window between
`openCase`'s commit and that one, and it is narrowed rather than hidden: a
re-sync recognises the stored extract by hash and, when that document is already
attached to a case, reuses the case instead of opening a second one. A genuine
one-transaction version means `openCase` taking a caller's client, which is a
change to `store.ts` and belongs to whoever owns that file.

**`declineCandidate` is idempotent by a read inside its transaction**, keyed on
`(org, ledger_invoice_id, decided_by_version)` read out of `external_ids`. A
partial unique index would be better and is not added here:
`declined_candidates` is append-only and migration-owned, so adding one is
migration 0022 plus an amendment to this ADR. It is proposed, not done.

## Consequences

**What this makes easy.** The ledger becomes a first-class discovery channel
with no new schema: `uploads.source` already admits `erp_sync`,
`declined_candidates.deduction_id` was already nullable for exactly this triage,
and `deduction_identifiers` already holds `ledger_invoice_id`. Coverage by
channel starts producing an `erp_sync` slice the first time a sync runs, and it
is derived rather than asserted.

**What this makes hard.** A ledger extract is a document, so a tenant with
thousands of monthly short-pays stores thousands of small JSON documents in
`documents` — which is Postgres-backed today (ADR 0014). That is a volume
question for whoever moves bytes out of the database, not a reason to store less
than a case needs to defend itself.

**What is deliberately not built.** No submission, no write-back, no model, no
merge of a probable pair, no per-tenant floor, no scheduler. `syncLedger` is a
function; what calls it on a timer is a later change, and it goes through the
same `runnerFromEnv` split as everything else.

## Invariants touched

- **1 (no submission without an approval).** Untouched. Nothing here can insert
  a `submissions`, `writebacks` or `writeoffs` row, and no gate function is read
  or replaced.
- **2 (append-only).** Honoured, not extended. No migration, no new grant, no
  UPDATE or DELETE anywhere: every write is an INSERT into a table that already
  takes them — `uploads`, `documents`, `deduction_documents`, `deductions`,
  `deduction_identifiers`, `deduction_events`, `declined_candidates`.
- **3 (money is integer cents).** Held. `gapCents` and every amount in the
  extract are the integer cents `detectShortPays` produced; the extract's
  serialisation is tested for integrality, and no float arithmetic occurs on
  this path.
- **4 (document content is untrusted).** Held, and the reason §1 spells the
  posture out: the extract is a third party's data, it is stored and compared,
  never executed, and no model reads it. Nothing in this path constructs a
  reader, with or without tools.
- **5 (Jev behind `DecisionProvider`).** Held by not being used: triage v1 calls
  no provider, and the slot for one is a port parameter that defaults to absent.
  No Claude or Jev API is called from anywhere in this change.
- **6 (RLS on every table).** Held. `PostgresDiscoveryStore` runs as `app_rw`
  with the tenant's claims set transaction-locally, the same `withTenant`
  discipline `PostgresStore` uses. The service-role key appears nowhere.
- **7 (thresholds auto-tighten only).** Engaged by §4. A new threshold constant
  is added, its tightening direction is stated in code, and the limit of that
  enforcement — no column, so no trigger — is written down rather than glossed.

## Rollback

Delete `packages/core-domain/src/ledger-extract.ts`, `triage.ts`,
`packages/store-postgres/src/discovery.ts`, `packages/pipeline/src/discovery.ts`
and their tests, and the two export lines. No migration ran, so there is nothing
to reverse in the database. Rows a sync has already written stay: the cases it
opened are ordinary cases with ordinary notices, and the declined candidates are
ordinary counterfactual-log entries — none of them depends on this code to be
read, which is the property choosing "a ledger extract is a document" bought.
