# 0025 — A deduction has many identifiers and one row

- Status: accepted
- Date: 2026-09-21

## Context

The same deduction can reach us in up to four ways, each calling it something
different (`docs/STRATEGY.md` §5.2, CH-3):

- a credit memo in the accounting ledger (`erp_sync`),
- an adjustment line on an EDI 812 (`edi_812`),
- a claim id in the retailer's portal (`portal_fetch`),
- and, today, the claim id printed on an uploaded notice (`web_upload`,
  `email_in`, `email_body`).

`deductions` has one nullable `claim_id` and `unique (org_id, debtor_id,
claim_id)` (migration 0003). One column can hold one of those four names, so
the second source has nowhere to put what it knows. Naive ingestion then does
one of two things and neither is acceptable: it opens a second case for a
deduction we already have (double-counting, and two half-argued disputes), or
it folds the arrival into a row it does not belong to and the deduction we
actually saw is never disputed at all.

The second source is not hypothetical. The accounting-ledger source is being
built now, so the column runs out this phase rather than next.

ADR 0019 already paid for the narrow version of this. `unique (org_id,
debtor_id, claim_id)` never fired while `debtor_id` was always null, so the same
claim uploaded twice opened two cases silently; `openCase` now raises
`DuplicateCaseError` instead, and that ADR recorded that merging the pair is
identity resolution's job — this one.

**The two failures are not symmetric, and the gate must not be either.** A
duplicate case is visible: two rows, one claim, a reviewer sees both and the
money is still disputable. A wrong merge is invisible: the arrival vanishes into
another deduction's row, nothing records that a second deduction was ever seen,
and a disputable deduction is destroyed quietly. Post-audit claims reach back
about two years, so "quietly" means we find out long after the window closed.
An identity gate that is right 99% of the time and merges the other 1% is worse
than one that resolves only what it is certain of and hands the rest to a
person.

Three shapes were considered.

- **(a) Widen `deductions.claim_id` into an `external_ids jsonb` blob.** One
  column, no join, and nothing else to build. Rejected: a jsonb blob carries no
  uniqueness, so nothing stops two deductions claiming the same portal id and
  nothing catches the double-count this exists to catch; it cannot say *when* an
  identity was learned or which source said so; and it would be a rewrite of a
  column the duplicate check already rests on.
- **(b) Replace `claim_id` and its unique constraint outright.** Rejected twice
  over. A merged migration is never edited (CLAUDE.md), and dropping that
  constraint would remove the one check that currently catches a re-upload.
- **(c) An additive, append-only, source-qualified `deduction_identifiers`
  table, with `deductions.claim_id` left exactly as it is.** Chosen.

## Decision

**(c).** Migration 0020 adds `deduction_identifiers`. Nothing existing is
altered except one additive unique constraint (§7 below).

1. **Additive, not a rewrite.** `deductions.claim_id` and `unique (org_id,
   debtor_id, claim_id)` stay, bit for bit. The new table is the general answer
   and the old column is one special case of it: the claim id a notice printed.
   The migration backfills one identifier row per existing non-null `claim_id`
   so the two agree from the first day rather than from whenever someone
   remembers to reconcile them. `openCase`'s duplicate check keeps working
   against the column it already uses; nothing in the application changes in
   this ADR.

2. **Source-qualified.** A row is `(org_id, deduction_id, source,
   identifier_kind, identifier, first_seen_at)`. `source` is the same set
   `uploads.source` admits — migration 0014 owns that list and this one copies
   it with a pointer, because a source that can deliver a deduction can name
   one.

3. **One identifier resolves to one deduction, per tenant and per source:**
   `unique (org_id, source, identifier_kind, identifier)`. Uniqueness is *per
   source* on purpose. Two different sources printing the same string is the
   normal case (the portal's claim id is often the notice's), and it is
   evidence, not a collision. What must never happen is one source handing the
   same identifier to two deductions, and that is exactly what the constraint
   refuses.

4. **Stored verbatim; matching normalises.** `identifier` is what the source
   printed or returned, never a cleaned-up version of it — the same rule as
   `retailer_name_as_printed` (ADR 0019 §1). Comparison is trim, case-fold and
   collapse internal whitespace, and nothing cleverer: `APDP-99812` and
   `APDP99812` are different identifiers until a human says otherwise, exactly
   as `walmart stores` is not `walmart`.

5. **The matcher is deterministic code, not a model.** `resolveIdentity` in
   `packages/core-domain/src/identity.ts` is pure, has no I/O and never calls
   anything. Identity across sources is a comparison of structured fields we
   already hold; it is not a reading task, and a model in this position would
   put an unreviewable judgement in front of the one operation that can destroy
   a disputable deduction. STRATEGY CH-3 reserves a Jev binary for the residue
   this leaves, and that is a later decision with its own ADR: the deterministic
   half has to exist and be measured before anybody can say what the residue is.

6. **The gate is asymmetric.** In precedence order:

   - **exact** — an arrival identifier equals a known identifier of the same
     kind after normalisation. Resolve to that deduction.
   - **ambiguous** — exact matches that point at more than one deduction. Two
     matches count as none, the rule ADR 0019 §2 applies to debtors, for the
     same reason: we do not choose.
   - **probable** — no exact match, but invoice number *and* amount in cents
     *and* a deduction date within tolerance (7 days by default) all agree, and
     the debtor agrees where both sides know it. **Held for a human. Never
     merged automatically.** Amount alone, or date alone, is never probable.
   - **none** — a new deduction.

   Only the exact branch may resolve without a person. Everything else is a
   question, and a question is answered by a reviewer, not by a default.

7. **An identifier row cannot point at another tenant's deduction.** `org_id`
   and `deduction_id` are each a foreign key, and neither says they are the same
   case — the hole migration 0016 closed for `packets` with a trigger. Here it
   closes declaratively: `deductions` gains `unique (org_id, id)` (additive,
   implied by the primary key, costing one index) and the identifier's
   `(org_id, deduction_id)` is a foreign key onto it. RLS asks whether `org_id`
   is mine, not whether `deduction_id` is; without this, a writer could hang an
   identifier their own tenant can read onto a deduction belonging to someone
   else, and the matcher would then resolve onto a case the tenant cannot even
   open.

8. **Append-only, because an identity is a fact learned.** INSERT and SELECT
   only for `app_rw`, no UPDATE or DELETE grant, `app.block_mutations()` on both
   plus TRUNCATE — the pattern of migration 0004 and invariant 2. "This
   deduction was called CM-8812 in the ledger" is true of a moment
   (`first_seen_at`) and stays true afterwards; learning a better name is a
   second row, not an edit of the first. It is also the post-audit defence: what
   a packet claims about which deduction it is arguing has to be reconstructible
   two years later, and a mutable identity table would make every such
   reconstruction a matter of trust.

## Consequences

- The second source can land without a schema decision in front of it. An ERP
  credit memo id, an 812 reference and a portal claim id are each one row, and
  the first thing each one does is ask `resolveIdentity`.
- A pair the matcher calls *probable* stops. Nothing in this ADR builds the
  queue it stops in — the review surface for held pairs is the wiring task's,
  and until it exists a caller must treat `probable` as "not resolved" rather
  than as a quiet merge. That is the correct default while the surface is
  missing, and it is the whole point of returning a distinct kind rather than a
  boolean.
- **Re-pointing an identifier is not possible, and that is deliberate but it is
  a cost.** Append-only plus the unique constraint means an identifier attached
  to the wrong deduction cannot be moved to the right one: the corrected row
  collides with the mistake. Merging two cases into one is the remaining half of
  STRATEGY §5.2, needs its own decision about what happens to events, packets
  and approvals on the losing row, and is not done here. Until it is, a wrong
  attachment is a support question, not a self-service fix. This is the reason
  the gate resolves only on exact matches: the cheapest way to live without a
  merge operation is to not create rows that need one.
- The unique constraint is on the *verbatim* value, so `CM-8812` and ` cm-8812 `
  can both be stored, for the same source, pointing at different deductions. An
  arrival matching both then normalises to two deduction ids and the matcher
  answers `ambiguous` — held, not merged. The database refuses the collisions it
  can see and the matcher refuses to guess about the ones it cannot.
- Matching normalises both sides, so an index on the raw `identifier` would not
  serve a lookup anyway. The store reads the tenant's identifiers and matches in
  TypeScript — one implementation, the choice ADR 0019 §4 made for debtors, and
  a tenant has thousands of identifiers rather than millions. When that stops
  being cheap the answer is an expression index on the normalised form, decided
  against a query somebody can measure rather than guessed at now.
- The backfill cannot invent what was never recorded. Where a deduction's notice
  document names an `uploads` row, the identifier's `source` is that upload's;
  where it does not — documents ingested before `uploads` was written, 2026-09-21
  — it is `web_upload`, with the assumption stated in the migration rather than
  buried. Where a claim id cannot be backfilled at all (another case in the same
  tenant already holds it for that source, which is the duplicate pair identity
  resolution exists to merge, or the value does not fit the column's bounds) the
  migration says so with a warning naming the deductions, and does not choose
  between them. The backfill is `app.backfill_claim_id_identifiers()` rather
  than a bare statement, because a statement that exists only inside a migration
  cannot be tested: a scratch database has no rows at migration time, so running
  it there proves nothing. The suite calls the function over rows it seeded
  itself, which means what is tested is the statement that ran in production and
  not a second copy of it. It is invoker-rights and idempotent: called by the
  migration it sees every tenant, called by anyone else it sees what RLS lets
  them see, and either way it inserts nothing that was not already on a
  `deductions` row.
- `identifier` is untrusted text from a document or a vendor API, so it is
  length-bounded and may not be blank. Half an identifier is not an identifier,
  so an over-long one is refused rather than truncated (ADR 0019 §1's rule for
  `retailer_name_as_printed`).

## Invariants touched

- **2 (append-only)** — extended to a new table, not weakened. `revoke update,
  delete, truncate`, no UPDATE/DELETE grant, `app.block_mutations()` on row
  mutations and on TRUNCATE, asserted in
  `supabase/tests/15_a_deduction_has_many_identifiers.sql`.
- **4 (document content is untrusted)** — held. An identifier is verbatim text
  from a document or a vendor, and it is stored, bounded and compared; it is
  never executed, never interpolated, and it cannot create a `deductions` row on
  its own. The matcher is pure code with no tools, the same posture as the
  reader.
- **6 (RLS on every table)** — `deduction_identifiers` enables RLS with the
  `tenant_read` / `tenant_insert` / `tenant_update` / `tenant_delete` policy set
  of migration 0014, granted to `app_rw` (insert, select) and `app_ro` (select).
  §7 above adds the tenancy tie the foreign keys do not carry. No service-role
  path is introduced.
- **3, 5, 7** — untouched. Amounts are compared as the integer cents they
  already are; no threshold and no decision provider is involved.
- **1 (the approval gate)** — untouched. Nothing here can insert a submission,
  write-back or write-off.

## Rollback

Drop the table in a new migration — `drop table deduction_identifiers` — and,
if it is also unwanted, `alter table deductions drop constraint
deductions_org_id_id_key`. Nothing else references either: `deductions.claim_id`
and its unique constraint were never modified, and no application code reads the
table until the wiring task lands. `resolveIdentity` is a pure function with no
callers of its own; deleting the module is the whole of its rollback.
