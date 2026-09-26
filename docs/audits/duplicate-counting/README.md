# Where one deduction still counts twice, after ADR 0042

*Audit, 2026-09-24. Nothing is changed by this document; it records what is
left. Every finding below has a reproduction in this folder that runs in one
transaction and rolls back:*

- *`repro.sql` and `repro-survivor-invoice.sql` against a migrated scratch
  database;*
- *`triage-repro.ts` with `pnpm exec tsx`.*

## In plain language

ADR 0042 fixed the case it was built for. When a person says two cases are the
same deduction, they are merged, and the merged-away copy stops counting:

- in coverage;
- in the case-list figures;
- in the review queue;
- in the matching of new arrivals.

It did **not** stop one deduction being counted two or three times in five
other ways, and in those five the page says nothing. Three of them can never
be merged at all, because the pair was never recorded as a possible duplicate
in the first place. Production is not affected yet: it has no merged pairs and
almost no duplicates. But every one of these moves the coverage number, which
is the number the business is judged by.

## The five silent ones

Ordered by how likely they are to happen with real customers.

| # | What happens | Where | Effect | Fix | Needs |
| --- | --- | --- | --- | --- | --- |
| F1 | **The notice arrives first, then a remittance line for the same deduction.** The line's case is opened with the match written only inside its `case.discovered` event, never as a `case.possible_duplicate`. The reverse order works. | `steps.ts` `openCaseForLine` (passes no invoice number to `openCase`, records `probable_duplicate_of` only) | Two cases, never listed as a pair, can never be answered or merged (`not_confirmed`). Found dollars are counted once per channel. | **Fixed (pilot E7).** `openCaseForLine` also appends `case.possible_duplicate` for each probable match; `pnpm link:duplicates` backfills existing `case.discovered` payloads. Tests: `store-postgres/test/remittance-possible-duplicate.test.ts`. | No migration. A note on ADR 0028 §7 |
| F2 | **The ledger sync meets a deduction we already hold twice.** Its invoice number is sent as an exact key, so two cases on that invoice make the arrival `ambiguous`. It is declined as `duplicate_of_other`, with no case and the full amount. Also, a probable match under the $25 floor is declined `below_economic_floor` instead of being named as the duplicate it is. | `core-domain/src/triage.ts` (floor is checked before probable), `discovery.ts` (invoice number as an exact key) | A declined row with no case counts as newly found dollars under `erp_sync`. One $1,000 deduction reads as $3,000 found. | Leave `duplicate_of_other` declines out of the found-dollars column. Name the probable id instead of calling it below the floor. Stop treating the invoice number as an exact key on the ledger path, as ADR 0025 §6 already says. | A migration re-creating the coverage view, and an ADR amending 0038 §1 and 0029 §3–4 |
| F3 | **A remittance line under the tenant's tolerance is declined before identity is checked, and never deduplicated.** The same advice arriving twice (different bytes) is declined twice. A later ledger sync or notice cannot match it, because declines write no identifiers. | `store.ts` `recordDeclinedLine`, called before the identity step in `steps.ts` | One $30 short-pay reads as $90 found across three channels. | Resolve identity before the tolerance check. Deduplicate declined lines on (payment reference, invoice, policy version), as the ledger path does. | No migration for the ordering and dedup. A unique index, or letting declines take part in matching, needs a migration and an ADR |
| F4 | **A chain: A, B and C are the same deduction, but C only matched B.** Once B is merged into A, the B–C pair disappears from every list, and A–C was never a pair. | `coverage.ts` ("counted twice" drops pairs with a merged half), `workflow.ts` `possibleDuplicates` | C counts twice, and nothing says so. | Map each half of a pair to its survivor instead of dropping the pair. Let a verdict name a merged-away half and redirect it to its survivor. | Reporting: no migration. Merging: a migration and an ADR amending 0042 §9–10 |
| F5 | **After a merge where the newer copy survives, a third copy matches nothing.** The probable matcher reads the invoice number off the case's own identifier rows. The survivor's own row was skipped as a collision when it arrived. | `store.ts` `knownOpenDeductions`, `discovery.ts` `knownDeductions` | A third copy opens with no pair, so it counts again. | Read the invoice over the case and every case merged into it, as `identityCandidates` already does. | No migration |

## Also worth fixing

- **The case list's figures count unanswered and unmerged pairs twice, and
  count declined cases as open.** TOTAL DEDUCTED, OPEN CASES and DEADLINES TO
  WATCH come from `caseTally` and `caseMetrics`. A decline never changes a
  case's state, so a case declined as "Same deduction, already handled" still
  counts as open and in the deadlines, although the review queue drops it. No
  migration is needed to leave declined cases out and to show a line counting
  the pairs next to the figures. *Declined cases: fixed 2026-09-26* — the tally
  splits them out with the queue's own predicate (`DECLINED_SQL`) and the
  figures leave them out of open work; the pairs line is still open.
- **A declined copy wins the merge.** `app.merge_work_rank()` counts a decline
  as work, so the copy a person declined as a duplicate survives, and the
  deduction drops out of every queue. Leave `duplicate_of_other` declines out
  of the rank. This needs a migration and an ADR amending 0042 §2.
- **The "counted twice" notice on /coverage** has three gaps:
  - it reports found dollars only, so a pair that was *filed* twice
    (`both_filed`) is doubled in the filed column too;
  - it uses the newer half's channel rather than the group's;
  - its wording ("until cases can be merged") predates ADR 0042.

  No migration needed.
- **The old `coverage_by_period` view** (migration 0014) is still granted,
  read by nothing, and still counts a merged-away case's decline. Drop it or
  mark it deprecated. That needs a migration and an ADR.
- **Two small mismatches with ADR 0042's own text:**
  - the view takes a merged group's month from its earliest *case*, where §8
    says the earliest *notice*;
  - remittance probable candidates are not filtered by closed state, where
    §10 says they are.
- **Before contingency billing is built** (Phase 4): count recoveries per
  surviving group, and leave out every pair above. Otherwise a `both_filed`
  pair is billed twice.

## Closed by ADR 0042 (checked, no action)

- A merged-away case leaves the opened, filed and declined columns of
  `coverage_by_period_by_source`. Its group is counted once. Its own decline
  is excluded.
- It leaves the case-list figures and the review queue.
- Exact identifier matching maps a merged-away case to its survivor everywhere
  (`knownIdentifiers`, `identityCandidates`, `caseForDocument`, the explain
  lookups, the ledger sync). A re-sync of a merged pair is skipped rather than
  declined.
- New work on a merged-away case is refused by the database (`RCM01`).
- A confirmed pair that cannot be merged (`amounts_disagree`, `both_filed`,
  and so on) is shown on /coverage as counted twice. That is by design, and
  said.

## Suggested order

1. **F1** (done, pilot E7) **and F5**, and the case-list figures: code only, no migration, one PR.
2. **F3's ordering and dedup** (code only), and **F4's reporting half** (code
   only).
3. **One ADR and one migration** for the rest: F2's coverage rule, F3's index,
   F4's redirecting verdict, the merge rank for declined copies, and the 0014
   view.

This is Phase 1.5 work (identity and coverage), not Phase 2, so it can go ahead
of the Phase 2 plan without reordering the build.
