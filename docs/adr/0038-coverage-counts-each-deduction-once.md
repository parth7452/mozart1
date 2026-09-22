# 0038 — Coverage counts each deduction once

- Status: accepted
- Date: 2026-09-22

## Context

ADR 0030 §1 defined the coverage denominator per `(org, month, channel)` as

```
discovered_cents = opened_cents + declined_cents
```

where `opened_cents` sums `deductions.deduction_amount_cents` over every case
opened and `declined_cents` sums `declined_candidates.estimated_recoverable_cents`
over every decline. That is right when the two sets are disjoint, and ADR 0030
wrote it for the world ADR 0029 described, in which a ledger candidate becomes
*either* an opened case *or* a declined row: "every deduction we decided was
worth opening a case for" and "every one we decided was not".

They are not disjoint. `declineCase` — the reviewer's "don't fight this" on a
case page, live in the app — writes a `declined_candidates` row that carries
the case's own `deduction_id` and the case's full amount, and the case stays in
`deductions`, as it should: a decline is a fact about a case, not the removal
of one. So migration 0023's view counts that case's dollars twice in
`discovered_cents`, once as opened and once as declined: its channel's
denominator is inflated by exactly the case's amount, and its rate understated
accordingly. None of the
existing tests saw it: `coverage-by-period.test.ts` declines only a candidate
that never became a case, and `coverage-by-channel.test.ts` compares only
`declined_cents`. The review of the coverage page's design found it, before any
page rendered the number.

Production has recorded no declines, so no published number is wrong yet. The
first reviewer to decline a case would have moved the headline.

## Decision

### 1. A deduction is in the denominator once, on the clock it was found

```
discovered_cents = opened_cents + (declined_cents of candidates with no case)
```

A case that was opened and then declined **stays in `opened`**. It was opened:
ADR 0030 §1 defines `opened` as every deduction "we decided was worth opening a
case for", and a later decision not to fight it does not un-make that one. §4
puts an opened case in the month "we found it", which is the right clock for a
denominator — it is the question "what did this channel put in front of us
this month". And §1's other half, "every one we decided was not" worth opening,
is exactly the candidates that never became a case: `deduction_id is null`,
which migration 0014 made nullable for precisely those.

What follows from putting the dollars there:

- **Declining a case moves nothing in the denominator** — not the month it was
  found in and not the month it was declined in. A decline is a disposition,
  like a filing, and dispositions are what the ratio measures, not what it is
  measured against.
- **A closed month's denominator never moves because of a later decline.** A
  case opened in July and declined in August is July's dollars, found in July,
  and stays there. August records the decline and adds nothing to its own
  denominator for it.
- `coverage_of_discovered` for a channel is filed over what that channel found,
  whatever became of the rest.

### 2. `declined_count` and `declined_cents` keep reporting every decline

The recommendation this ADR was drafted from went one step further: make the
`declined_*` columns count only candidates with no case, so that
`discovered = opened + declined` stays a sum of the row's own columns. That was
not taken, for two reasons found while building it.

- **It would quietly break a second published number.**
  `coverage_by_period_totals.coverage_of_seen` is computed from these columns as
  `filed ÷ (filed + declined)` and is documented, and asserted by suite 19, as
  migration 0014's number "to the same definition". With declined cases taken
  out of `declined_cents`, declining a case would stop lowering it: a tenant that
  filed one case and declined every other would read 100%. That is the
  number-that-improves-when-you-look-at-less failure ADR 0030 exists to remove,
  arriving through the fix for a different one — and suite 19's "agrees with
  0014 to the digit" would silently stop being true for any tenant with a
  declined case, because its fixture has none.
- **It would take the reviewer's declines out of the only per-channel view of
  them.** For `web_upload` and the email channels, every decline is a declined
  case, so the column would read zero for ever while reviewers declined real
  money. The counterfactual log (STRATEGY ADD-1) exists so that a discard is
  visible.

So `declined_count` and `declined_cents` mean what migration 0014 and ADR 0030
said they meant — **every decline recorded in that month for that channel,
whether or not it had a case** — and `coverage_of_seen` is untouched. What
changes is that `discovered_cents` is no longer `opened_cents + declined_cents`
in general. It is `opened_cents` plus the part of `declined_cents` that never
became a case, and that part is readable off the row:
`discovered_cents − opened_cents`. A reader must not add `opened` and `declined`
to get what was found; `discovered_cents` is that number, and the view's comment
and column comments say so.

### 3. The other way round was considered and not taken

Taking a declined case *out* of `opened` and leaving it in `declined` also
counts it once, and keeps `discovered = opened + declined` as a sum of columns.
It puts the dollars on the decision's clock rather than the finding's: a case
opened in July and declined in August would leave July's denominator, and
July's published coverage would move in August. ADR 0024 was written because a
published coverage number could be moved after the fact with no record of why;
this would be a milder version of the same thing, by design.

### 4. The view keeps its shape

`create or replace view coverage_by_period_by_source with (security_invoker =
true)`, same columns, same names, same order, same types. Only two expressions
change: the `declined` CTE carries the no-case sum beside the full one, and
`discovered_cents` and `coverage_of_discovered` are computed from it.

- `coverage_by_period_totals` needs no change. It sums `discovered_cents` and
  divides in SQL, so its `discovered_cents` and `coverage_of_discovered` are
  corrected by the same statement; its `coverage_of_seen` reads
  `declined_cents`, which is unchanged.
- `coverage_by_period` (migration 0014) is not touched.
- On `db:test`'s second pass migration 0023 re-creates the old body and 0029
  replaces it again; a `create or replace` with an unchanged column list is
  what makes that work.
- `with (security_invoker = true)` is restated because `create or replace view`
  replaces the options with whatever the command says — leaving it out would
  make the view read as its owner, the finding ADR 0010 was about. Suite 24 now
  asks every view in `public` that question.

### 5. What this does not touch

ADR 0032 §6's over-count — a confirmed duplicate is still two cases and still
counts twice — is a different double count with a different fix: which row's
dollars survive is the merge decision's question. Nothing here reads verdicts.

## Consequences

**What this makes easy.** The denominator is one row per deduction or
uncased candidate, found once, in the month it was found, so a channel's rate
over any window is filed over found without a correction for what happened to
the cases afterwards. Past months stop being revisable by later declines.

**What it makes harder.** The row no longer adds up across its own columns:
`opened + declined ≥ discovered`, with equality exactly when no case was
declined. A page showing the three side by side has to label `declined` as
including cases already counted as found; the coverage page's design already
reads `discovered_cents` for "found" rather than adding.

**What changes for callers.** `PostgresDiscoveryStore.coverageByPeriod` returns
the same fields; the doc comment on `discoveredCents` said `openedCents +
declinedCents` and now says what it is.

## Invariants touched

- **2 (append-only).** Untouched. A view is replaced; no table, grant or
  trigger changes.
- **3 (money is integer cents).** Held. Both sums are `bigint` over `bigint`
  columns, the `filter` clause changes which rows are summed and nothing about
  how, and the only division remains the view's own `numeric` ratio rounded to
  four places in the database.
- **6 (RLS).** Held. `security_invoker` is restated, the view answers through
  the caller's policies, and suite 25 reads it as `app_rw` under a tenant's
  claims.
- **1, 4, 5, 7.** Untouched.

## Rollback

Re-applying migration 0023's body restores the double count; there is no
reason to. If §2's reading of `declined_*` turns out to be the wrong one for a
consumer, the answer is a new column on a new view — `create or replace view`
cannot drop or reorder columns, and 0023 re-creates this view on `db:test`'s
second pass.
