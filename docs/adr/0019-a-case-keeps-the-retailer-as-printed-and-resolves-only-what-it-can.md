# 0019 — A case keeps the retailer as printed, and resolves a debtor only when it is sure

- Status: accepted
- Date: 2026-09-19

## Context

`openCase` took a `retailerName` and never wrote it, and took no dates at all.
Every case the pipeline opened read "Retailer unknown" with no dispute deadline —
the two fields a reviewer triages on. Verified in production: a scanned Walmart
APDP notice extracted `retailer_name = "WALMART STORES, INC."`,
`deduction_date = "08/14/2026"` and `dispute_deadline = "11/12/2026"`, every
field quote-verified, and the case page still showed neither.

The dates are the easy half. `deductions.deduction_date` and `dispute_deadline`
already exist; the values arrive as verbatim text off the page. The corpus shows
what that text looks like: `08/14/2026`, `2026-09-03`, `August 12, 2026` — and,
for deadlines, `180 days` and `60 days of deduction date`, which are not dates
at all.

The retailer is the hard half. `deductions.debtor_id` is a foreign key to
`debtors`, whose `(org_id, retailer_key)` is the seam Phase 2 playbooks hang off,
and `debtor_aliases` already exists to say that "WALMART STORES, INC." and
"Walmart" are one debtor. There were three ways to get a name onto a case:

- **(a) Match on a normalised key, and create a debtor when nothing matches.**
  Every spelling a model or a scan produces mints a new debtor with a new
  `retailer_key` — `walmart_stores_inc` beside `walmart` — that no playbook will
  ever be keyed to, and that someone later has to merge by re-pointing cases. It
  also lets document text, which is untrusted (invariant 4), create rows in the
  tenant's master data. A crafted notice could invent a debtor.
- **(b) Store the raw extracted name on the case, and leave `debtor_id` for a
  human or a later resolution step.** Nothing is invented; the reviewer sees what
  the page said.
- **(c) A `declined_candidates`-style record of the unresolved name.** That table
  records a decision not to fight, with a dollar value; an unmatched name is not
  a decision and has no value of its own. It would be a second table for what is
  one column's worth of fact about one case.

## Decision

**(b), plus the read-only half of (a).**

1. `deductions` gains `retailer_name_as_printed text` — the name exactly as the
   extraction reported it, never rewritten. It is display, not identity.
   "Exactly as reported" has two edges, and both behave like §7 rather than like
   a rewrite: surrounding whitespace is trimmed, because padding is a property
   of a layout and not of a name, and a reading that is only whitespace is
   absence, not a blank name. A reading longer than the column's cap is stored
   as null with the reason on `case.discovered`, never truncated — half a name
   is not what the page said, and a paragraph cut down to "WALMART STORES" would
   go on to select a debtor the page never named.
2. `openCase` **looks up** an existing debtor for the tenant and sets `debtor_id`
   only when exactly one debtor matches. It never creates a debtor. Matching
   compares `retailerMatchKey(name)` against the same key of each debtor's
   `display_name`, `retailer_key` and every `debtor_aliases.alias`. Two debtors
   matching is treated as no match: we do not choose between retailers.
3. `retailerMatchKey` lives in `core-domain` and is generic text folding only —
   case, punctuation, whitespace, and legal-form suffixes (`Inc`, `Corp`, `LLC`,
   `Co`, `Ltd`, …). It knows no retailer. "WALMART STORES, INC." folds to
   `walmart stores`, which does not match `walmart`, on purpose: whether "Walmart
   Stores" is Walmart is a fact about a retailer, and that belongs in an alias a
   human added, not in code (CLAUDE.md: retailer rules are data).
4. Normalisation runs in TypeScript, once, rather than also in SQL. A tenant has
   tens of debtors, not millions, so reading them to match is cheap, and one
   implementation cannot drift from a second.
5. Dates are parsed by `parsePrintedDate` in `core-domain`, deterministically, the
   way `parseMoneyToCents` handles money. It accepts ISO (`2026-08-14`), US
   numeric with a four-digit year (`08/14/2026`, `8/14/2026`, `08-14-2026`), and
   month names (`August 14, 2026`, `Aug. 14, 2026`, `14 August 2026`). It
   rejects everything else: two-digit years, dates with no year, impossible
   calendar days, years outside 2000–2100, and relative windows. No model is
   asked to normalise a date.
6. Numeric dates are read month-first. V1 is USD-only and US retailers print
   month-first; `14/08/2026` is rejected because 14 is not a month, and there is
   no day-first fallback, because a fallback is a guess and `03/04/2026` would
   then have two readings.
7. A date that does not parse leaves the column null and the case still opens —
   the same rule as an unreadable amount. The verbatim text stays in
   `extraction_results` with its quote, where the reviewer sees it. A relative
   window such as "60 days of deduction date" is a retailer's rule and will be
   computed from playbook data in Phase 2, not by guessing here.
8. The `case.discovered` event records the parsed dates and the `debtor_id` (or
   null), so the projection can be rebuilt from the events.

## Consequences

- The case list and review page show a retailer and a deadline for every notice
  whose text supports one. An unmatched name reads as printed, marked as not yet
  matched to a debtor.
- Adding one alias ("WALMART STORES, INC." → Walmart) resolves every later case
  with that spelling. Cases opened before the alias existed keep `debtor_id`
  null; backfilling them is a separate, deliberate step, not a side effect of
  adding an alias.
- `unique (org_id, debtor_id, claim_id)` starts to bite. With `debtor_id`
  always null it never fired, so the same claim uploaded as a PDF and then as a
  scan opened two cases silently. Once a debtor resolves, the second insert
  violates the constraint. `openCase` turns that into an error naming the
  existing case rather than a bare driver error. Merging the two into one case is
  the identity-resolution layer of STRATEGY §5.2, and is not done here.
- `retailer_name_as_printed` is untrusted text rendered in the app. React
  escapes it, the view tests assert that, and the column is length-capped.

## Invariants touched

- **3 (money is integer cents)** — untouched; dates follow the same "models copy,
  we compute" rule.
- **4 (document content is untrusted)** — strengthened by the choice: document
  text can select an existing debtor through a human-maintained alias, but cannot
  create one.
- **6 (RLS on every table)** — the debtor lookup runs as `app_rw` inside the
  tenant transaction, so it can only ever see the tenant's own debtors.
- `deductions` is a mutable projection, not an append-only table; adding a
  nullable column there changes no grant.

## Rollback

Stop writing the column and drop it in a new migration
(`alter table deductions drop column retailer_name_as_printed`); nothing else
references it. Resolution can be turned off by passing no name to the lookup —
existing `debtor_id` values stay valid either way, because they only ever point
at debtors a human created.
