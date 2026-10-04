# 0066 — A payer's reason code maps to ours as data

- Status: **Proposed** 2026-10-04. Not accepted. Built on branch
  `overnight/payer-code-map` so the decision can be looked at running;
  migration 0040 is applied to no remote database.
- Date: 2026-10-04
- Builds on: draft D (`docs/plans/phase-2/adr-drafts/D-playbooks-are-versioned-data.md`),
  of which this is the code-map slice only; ADR 0019 (a debtor is master data a
  person made), ADR 0025 §7 (composite tenancy keys), ADR 0041 (a row is
  written by the person it names), ADR 0056 (`sheet_mappings`, the nearest
  table in shape)
- Adds, if accepted: one append-only table, one function pair and one view

## The decisions that are the founder's

1. **Accept this ADR**, or not. Until then nothing here should be applied.
2. **Whether a mapping taken from a competitor's published guide may be loaded
   at all.** `pnpm seed:payer-codes` proposes rows from
   `docs/competitive/glimpse/playbook-drafts/*.yaml` as `source: glimpse_guide`,
   `confidence: low`. It is dry-run unless `--write` is given, and nothing runs
   it by itself. The alternative is to load nothing until the customer confirms
   their payer's codes themselves (`customer_confirmed`).
3. **Whether the decide form should pre-select the mapped reason.** Built: it
   does, where the mapped code is one the form offers, and says where the
   default came from. A person still chooses and presses the button. The
   alternative is to show the mapping beside the form and pre-select nothing.
4. **Who may add a mapping.** Built: owner or approver, by RLS policy as well
   as by the page. An analyst sees mappings and cannot add one.
5. **What an expired later row means** (§4 below): today an older open-ended
   row applies again once a later, dated row has run out.

## Context

A case keeps the payer's code as printed (`deductions.reason_code_as_printed`,
or derived at read time by `payerTermsFor`). The decide form takes a canonical
code a person picks from `reason-codes.ts`. Nothing connects the two.
`reason-codes.ts` says a payer's codes map in "via retailer_code_maps playbook
data", and no such table exists. So `CB-203`, `PREMIUM-NOAUTH` or UNFI's `MCB`
stays a string, and the same code is re-read and re-interpreted by a person on
every case that prints it.

`CLAUDE.md` forbids the two shortcuts: a payer's rules in code, and a model
doing the mapping (a fact about a payer would become a model's opinion).

## Decision

### 1. One table, `payer_code_maps`

| Column | |
| --- | --- |
| `id` | uuid |
| `org_id` | not null. Every row is a tenant's. There is no shared or global row: a payer's codes are data a customer confirms, and a map we shipped to everyone would be our opinion presented as theirs |
| `debtor_id` | not null; the payer. Tied to the tenant by a composite foreign key `(org_id, debtor_id) → debtors (org_id, id)` (ADR 0025 §7), so a row cannot name another tenant's debtor |
| `payer_code` | the code as printed, normalised (§2) |
| `canonical_code` | one of `CANONICAL_REASON_CODES`, by a check constraint |
| `effective_from` | date, not null |
| `effective_to` | date, nullable, never before `effective_from` |
| `source` | `payer_guide_url`, `customer_confirmed`, `glimpse_guide` or `operator` |
| `source_note` | free text, at most 500 characters: the URL, the person, the post |
| `confidence` | `low`, `medium` or `high` |
| `recorded_by` | not null, and must be `app.current_user_id()` |
| `created_at` | |

Unique on `(org_id, debtor_id, payer_code, effective_from)`.

Append-only on migration 0004's pattern: `app_rw` holds SELECT and INSERT,
`app_ro` SELECT, the request roles nothing, and `no_update_delete` and
`no_truncate` on `app.block_mutations()` answer for the owner. RLS on.

### 2. One normalisation rule

`normalisePayerCode` in `core-domain`: trim, collapse every run of whitespace
to one space, uppercase. Nothing else: no punctuation is dropped, `CB-203` and
`CB203` are two codes, and whether they are one is data a person adds as a
second row. The database does not re-implement the rule; it refuses a row that
could not have come out of it (leading, trailing or doubled space, a tab or
line break, a lowercase ASCII letter, empty, or over 64 characters).

A lookup is an exact match on the normalised code. Never the nearest, never a
prefix, never a model (draft D §2).

### 3. The canonical list is checked in both directions

The check constraint lists the 47 codes. `payer-code-maps.test.ts` reads it out
of `pg_constraint` and asserts set equality with `CANONICAL_REASON_CODES` both
ways, as `doc-types.test.ts` does for document types (ADR 0027), so a code
added to the taxonomy without a migration fails CI.

### 4. Superseding is a new row; the rule is written once

The mapping for (debtor, payer code, date) is the row with the latest
`effective_from` on or before the date, among rows whose `effective_to` is null
or on or after it. The SQL is `app.payer_code_maps_as_of(date)`, not definer,
so RLS applies to its caller; `payer_code_maps_current` is that function at
`current_date`, `security_invoker`. `resolveCanonicalCode` in `core-domain` is
the same rule as a pure function, property-tested, and an integration test
holds the two to one answer.

A consequence to know: a mapping cannot be withdrawn back to "unmapped". A
later row with an end date stops applying when it ends, and the older
open-ended row applies again. To correct a wrong mapping, add a row with the
right code. If "the newest row governs, and an expired newest row means
unmapped" is wanted instead, it is a change to one function before any row
exists.

### 5. Which date

A case's mapping is asked as of its `deduction_date`, else the day the case
was opened (UTC). Draft D §3: the mapping in force when the deduction was
taken.

### 6. Who writes

`recorded_by` must be the caller (`app.payer_code_map_names_its_recorder()`,
0031's and 0036's authorship trigger, no exception for the table owner). The
insert policy also requires an owner or approver
(`app.member_is_owner_or_approver()`, not definer, pinned, in
`app.member_is_owner()`'s shape). The settings page checks the role first only
to answer sooner.

### 7. What reads it

- The case page: "Payer code X → reason (mapped by source, confidence)", or
  "no mapping yet" with a link to add one. The mapping is shown, never applied:
  nothing writes a canonical code onto a case.
- The decide form pre-selects the mapped reason where the form offers that
  code. A person still chooses and submits (decision 3 above).
- Settings → Reason codes: each debtor's current mappings, a form to add one,
  and the reconciliation list: every payer code on this tenant's cases with no
  mapping, with its case count and dollars, each linking to the form
  prefilled.
- `pnpm seed:payer-codes`, an operator's command, dry-run by default.

## What the four Glimpse drafts actually hold

Checked before the loader was designed.

- **Chewy**: sixteen printed chargeback names with one canonical code each
  (ten under `code_map.entries`, six freight accessorials). These load.
- **UNFI**: eleven entries, seven with a canonical code, and every one of the
  seven is a *shape* (`MCB(yyyymmdd)`, `LCPV(PO#)`), not a code. A real
  remittance prints `MCB20260901`. An exact match cannot map a shape, so the
  loader reports them and proposes none.
- **KeHE**, **Walgreens**: no entries, only categories with several candidate
  codes each. Nothing to load.

So exact matching does not cover a payer whose code embeds a date or a PO
number, and UNFI is one. That needs its own decision (a prefix rule is the
obvious one, and draft D refuses "nearest match" for good reason), and is not
built here.

## Not in this ADR

Deadlines, evidence requirements, channels, `playbooks` and
`playbook_versions` (the rest of draft D); taxonomy additions for staffing and
foodservice; shared maps across tenants; any model proposing a mapping; a
canonical code stored on a case or a decision because of a mapping; prefix or
shape matching.

## Options not taken

- **A global seed map with `org_id` null.** Refused above: it would decide a
  customer's dispute basis from a source they never saw.
- **A JSON or YAML file per payer in the repo, read at run time.** Code by
  another name: it changes with a deploy and carries no author.
- **`effective_to` written onto the old row when it is superseded.** That is an
  UPDATE on an append-only table.
- **Teaching the reader the mapping.** Invariant 4 in reverse.

## Consequences

- A deployment running this code without migration 0040 fails on the case page
  and the settings page, which read the new table. The PR is therefore not to
  be merged before the migration is applied to `mozart-preview` and then
  production.
- The mapping never moves money, state or a deadline. A wrong mapping shows a
  wrong default, which a person can see and change, with its source and
  confidence beside it.
- The unmapped list reads every case of the tenant's. It is bounded
  (`UNMAPPED_CASES_LIMIT`) and says when it stopped.

## Invariants touched

- Invariant 2: one new append-only table. No UPDATE or DELETE grant anywhere.
- Invariant 6: RLS on the table; the view is `security_invoker`; the service
  role appears nowhere.
- "Do NOT put a retailer's rules in code": the mapping is tenant data with an
  author, a source, a confidence and effective dates.
