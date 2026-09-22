# 0030 — Coverage has a denominator

- Status: accepted; §1's denominator counts a case that was opened and then declined once, not twice, since ADR 0038
- Date: 2026-09-21

## Context

STRATEGY §2 is the reason this system exists in the shape it does:

```
Recovery Rate  =  Coverage Rate  ×  Win Rate  ×  Collection Rate
  Coverage = disputable dollars filed / disputable dollars existing
```

Migration 0014 could only build half of that. `coverage_by_period` reports
`coverage_of_seen = filed ÷ (filed + declined)` and its own comment says what it
is not: the denominator is *what reached us*, and until a ledger could be read
nothing could reach us that the customer had not already surfaced. A coverage
number computed that way is self-reported in the exact way §2 says a win rate
is: it goes up when you look at less.

ADR 0029 closed that. Every ledger candidate triage examines now leaves a row —
an opened case whose notice arrived through `uploads.source = 'erp_sync'`, or a
`declined_candidates` row with `discovered_from = 'erp_sync'`. Dollars that
nobody surfaced are, for the first time, *in the database*, attributed to the
channel that found them. STRATEGY ADD-2 is the work of turning that into a
denominator.

## Decision

### 1. The denominator is opened dollars plus declined dollars, per source

Per `(org_id, period, discovered_from)`:

```
discovered_cents      = opened_cents + declined_cents
coverage_of_discovered = filed_cents / discovered_cents
```

`opened_cents` is `sum(deductions.deduction_amount_cents)` for the cases opened
in that period from that source: every deduction we decided was worth opening a
case for. `declined_cents` is `sum(declined_candidates.estimated_recoverable_cents)`
for that period and source: every one we decided was not. Together they are the
disputable dollars that source put in front of us — which is as close to
"disputable dollars existing" as a database can get today (§5 below says how far
short that still is).

`filed_cents` keeps migration 0014's meaning exactly: the deduction amount of
every case with a `submissions` row.

### 2. Attributed by source, never blended into one number

The new view is `coverage_by_period_by_source` and it carries
`discovered_from` as a grouping column. This is the same rule the eval suites
follow and for the same reason: a blended rate moves when the *mix* moves, so a
single coverage number that went from 40% to 55% because one tenant turned on an
ERP sync would read as the product getting better. It is not one number; it is
one number per channel that found the money.

A tenant total is still a legitimate thing to want, as long as nobody mistakes
it for the rate, and it is published as a second new view,
`coverage_by_period_totals`: the per-source view summed, carrying
`discovered_cents`, `coverage_of_discovered` and `coverage_of_seen` recomputed
to migration 0014's definition so the old question and the new one can be
compared on one row.

**`coverage_by_period` itself is not touched, and that is forced rather than
chosen.** The obvious move is to add the two columns to it. `scripts/db-test.sh`
applies every migration twice in file order, so on the second pass migration
0014's own `create or replace view coverage_by_period` runs *after* this
migration — and `create or replace view` cannot drop columns, so an extended
view makes 0014 fail. 0014 is merged and may not be edited (CLAUDE.md), and
dropping the view in 0023 does not help because 0014 runs first on that pass. A
new view is what is left. It is also the smaller change: nothing that already
reads `coverage_by_period` sees anything different, and `coverage_of_seen` keeps
its name, its meaning and its view.

The two views differ in one way worth knowing about. A period in which cases
were opened but nothing was filed and nothing declined has a row in
`coverage_by_period_totals` and none in `coverage_by_period` — which is the
point. A denominator that disappears exactly when the numerator is zero is a
coverage number that flatters itself.

### 3. A case's source is derived from its own notice, or it is `'unknown'`

The derivation is the one `declineCase` already performs, moved into SQL
verbatim rather than re-invented (`packages/store-postgres/src/store.ts`; that
file is not edited by this change): the case's **earliest** `notice` document by
`(created_at, id)`, then `uploads.source` through `documents.upload_id`, and
failing that `uploads.source` through the `document_arrivals` row an operator
asserted (ADR 0024 §3). At most one of the two can exist for a document, so this
reads whichever answered rather than choosing.

A case with no notice, or a notice whose arrival nothing recorded, is reported
under the literal `'unknown'` — **never** guessed into a channel and never
dropped. Both failures are real: cases opened before ADR 0024 have notices with
no `uploads` row, and `openCase` can be called for a case whose notice is
attached afterwards. Guessing would put those dollars into some channel's
denominator and quietly move that channel's rate; dropping them would remove
them from the total and flatter every number at once. `'unknown'` is a row a
person can see and an operator can fix with `pnpm link:provenance`, after which
the dollars move to the channel that earned them.

`'unknown'` is deliberately not a value `uploads.source` or
`declined_candidates.discovered_from` admits — it exists only in this view,
because it is not a channel, it is the absence of one.

### 4. Period, and the mismatch it creates, stated rather than hidden

- An opened case's period is `date_trunc('month', deductions.created_at)` — when
  we found it.
- A decline's period is `date_trunc('month', declined_candidates.decided_at)` —
  when we decided against it.
- A filing's period is `date_trunc('month', submissions.created_at)`, which is
  what migration 0014 already used and is not changed here.

**These are not the same clock, and the ratio is therefore approximate at the
edges.** A deduction dated 12 February that a sync discovers on 3 March is an
opened case in March; if it is filed in March it lands in the same bucket, and
if it is filed in April the March denominator carries dollars whose numerator
arrived in April. Two consequences, both accepted for now: a month's
`coverage_of_discovered` is unstable until the filings for it have happened, and
`filed_cents` can exceed `discovered_cents` in a period where an earlier
period's cases were filed — so the ratio can exceed 1 and is *not* clamped,
because a clamped number would hide the skew rather than show it.

The alternative — bucketing everything by `deductions.deduction_date` — is not
taken, for two reasons. That column is nullable by design (ADR 0019: a date the
parser will not guess at leaves it null and the case opens anyway), so it would
silently drop cases from the denominator, which is the one failure this ADR
exists to prevent. And a decline that never became a case has no deduction date
at all: `declined_candidates` carries `decided_at` and nothing else. When
recovery rate is reported to a customer as a trailing figure rather than a
monthly one this stops mattering; a cohort view keyed on the deduction date is
the later answer, and it needs the date to be reliably present first.

### 5. What this number is not, said plainly

**It is a coverage rate over the candidates triage examined, not over the
disputable dollars that exist.** The true denominator is every short-paid line
in the customer's ledger, and what this view can see is only the lines a sync
actually walked. Three gaps, named:

- **Nothing runs on a schedule.** `syncLedger` is a function; ADR 0029 left what
  calls it on a timer to a later change. A tenant whose sync ran once has one
  month of denominator and nothing before or after it.
- **Exact-match skips write no row, by design.** ADR 0029 §3 skips a candidate
  the ledger names that we already hold: no case, no decline, no document. Those
  dollars are already in the denominator under the channel whose notice opened
  the case, and counting them again under `erp_sync` would double the invoice.
  So the ERP slice's denominator is *the dollars the ERP found that nothing else
  had*, which is the right question for a per-channel rate and the wrong one for
  "what does the ledger hold" — and the second question needs a row per line
  examined, which is a schema change nobody has asked for yet.
- **A line below the arithmetic's own threshold never becomes a candidate.**
  `detectShortPays` decides what a short pay is before triage sees anything.

Until syncs run on a schedule across a tenant's whole ledger, this is
"coverage of what we looked at", which is strictly more honest than "coverage of
what was sent to us" and strictly less than what §2 asks for. It is reported
with the source on it so nobody has to guess which of the two they are reading.

### 6. Views only. No new table, no new column, no new grant

Everything this needs is already recorded. `coverage_by_period_by_source` and
`coverage_by_period_totals` are both
`create or replace view … with (security_invoker = true)` — so RLS on the
underlying tables (`deductions`, `submissions`, `declined_candidates`,
`documents`, `uploads`, `document_arrivals`) applies to the caller, the view
answers per tenant, and there is no `security_definer` surface to harden
(ADR 0010). `select` is granted to `app_rw` and `app_ro`, matching the existing
view exactly. No UPDATE or DELETE grant is issued anywhere, and no append-only
table is altered.

No existing view, table, column, grant, policy or test is changed by this
migration: it adds two views and nothing else, which is why
`supabase/tests/10_the_counterfactual_log.sql` needs no amendment and
`coverage_of_seen` reads exactly what it read before.

### 7. `declineCandidate` records the customer as well as the invoice

`PostgresDiscoveryStore.declineCandidate` wrote
`external_ids = { ledger_invoice_id, invoice_number }`. It now also writes
`customer_external_id` and `customer_name`, verbatim from the candidate, because
a per-debtor cut (STRATEGY ADD-2 asks for per debtor, ADD-4 for the dilution
profile) is impossible after the fact for a declined candidate that never became
a case: it has no `deduction_id`, so no `debtor_id`, and nothing else on the row
names who deducted. Recording the two strings costs nothing now and cannot be
back-filled later.

They are the ledger's own strings about a third party and are treated as such:
stored verbatim, never matched into master data here, never used to mint a
debtor (invariant 4, ADR 0019). The per-debtor view is **not** built here —
`customer_external_id` is a vendor's key, not a `debtor_id`, and joining the two
is identity resolution's job (STRATEGY §5.2).

## Consequences

**What this makes easy.** Coverage is computable per channel the first time a
sync runs, from rows that already exist, with no back-fill and nothing asserted
by a caller. The `'unknown'` bucket makes the provenance gap a visible number
rather than a silent subtraction, and it shrinks as `pnpm link:provenance` is
used.

**What this makes hard.** The view scans `deductions` and laterals a notice
lookup per case; at a tenant with hundreds of thousands of cases it will want a
materialised roll-up. Not now: nothing has a month of real data in it, and a
materialised view is a refresh policy and a staleness question that would be
answered with guesses today.

**What is deliberately not built.** No column on `coverage_by_period`, no
per-debtor view, no cohort view keyed on
the deduction date, no clamping of a ratio above 1, no scheduler, and no row per
ledger line examined.

## Invariants touched

- **1 (no submission without an approval).** Untouched. Nothing here writes
  `submissions`, `writebacks` or `writeoffs`, and no gate function is read or
  replaced. The suite writes one submission and, like every other suite, has to
  mint an `approvals` row first — the gate is exercised, not routed around.
- **2 (append-only).** Honoured. Views only; no UPDATE or DELETE grant is added
  and no append-only table is altered. `declineCandidate` still only INSERTs.
- **3 (money is integer cents).** Held, and this is where it earns its keep.
  Every sum is over a `bigint` cents column and stays `bigint`; the only
  division is the ratio, which is `numeric` rounded to 4 decimal places **inside
  the view**. `coverageByPeriod` in `discovery.ts` parses the cents columns as
  exact integers and refuses anything outside the safe-integer range; it never
  divides in TypeScript.
- **4 (document content is untrusted).** Held. `customer_name` is a vendor's
  string stored verbatim into a `jsonb` value, never executed, never matched
  into master data, never used to create a debtor.
- **5 (Jev behind `DecisionProvider`).** Untouched; no model is called.
- **6 (RLS on every table).** Held. Both views are `security_invoker`, so they
  answer through the callers' policies; the suite proves a second tenant sees
  none of the first's dollars. The service role appears nowhere.
- **7 (thresholds auto-tighten only).** Untouched; no threshold is read or
  written.

## Rollback

`drop view coverage_by_period_totals` then
`drop view coverage_by_period_by_source`. Nothing else has to be reversed:
`coverage_by_period` was never altered, and both new views are over rows nothing
else depends on. Delete `coverageByPeriod` from
`packages/store-postgres/src/discovery.ts` and its test. The `external_ids`
addition in §7 is not reversible for rows already written and does not need to
be: a reader that does not know those keys ignores them.
