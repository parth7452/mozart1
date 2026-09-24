# Draft D — A payer's rules are versioned, effective-dated data with provenance

- Status: **proposed**
- Date: 2026-09-24
- Builds on: CLAUDE.md ("Do NOT put a retailer's rules in code"),
  `reason-codes.ts`, `.claude/commands/new-playbook.md`

## Context

`reason-codes.ts` says a payer's own codes "map into the canonical taxonomy via
`retailer_code_maps` playbook data". No such table exists, and no playbook
package exists. So:

- **A payer's code stays a string nobody can reason about.** The `customer`
  eval expects `stf-203-short-payment-notice`'s printed `CB-203` to come out
  as `PREMIUM-NOAUTH`. The reader is told to copy the code "exactly as
  printed", and it does. The mapping is the missing piece, and it belongs in
  data, not in the model or in code.
- **The canonical taxonomy (47 codes, 10 families) has no staffing or
  foodservice codes:** unauthorised premium or overtime, billback, OS&D, swell
  and shelf-life allowance, deviated-pricing billback. The beachhead's own
  vocabulary is absent.
- **Deadlines, required evidence and the filing channel per payer have
  nowhere to live.** Evidence planning (draft E) and the deadline guard need
  them.

## Decision

1. **Tables** (one migration). All are append-only, tenant-scoped with RLS,
   and nullable-org for a shared playbook. A fact is corrected by a new
   version, never by an edit.
   - **`playbooks`:** identity.
     - `payer_key`: a debtor's `retailer_key`, or a shared key.
     - `org_id`, null for a playbook shared by every tenant.
   - **`playbook_versions`:**
     - `version`, `effective_from` and `effective_to`;
     - `status`: `draft`, `confidence_low` or `reviewed`;
     - `created_by`.
   - **`playbook_code_maps`:**
     - the payer code as printed (normalised), mapped to the canonical code;
     - `provenance`: the document and quote it came from, or a named human
       source.
   - **`playbook_deadline_rules`:** the dispute window in days, and what it
     is counted from (`deduction_date`, `payment_date` or notice date), with
     provenance.
   - **`playbook_evidence_requirements`:** the canonical reason code, then the
     required evidence types (draft E's vocabulary), with provenance.
   - **`playbook_channels`:** `PlaybookChannelSpec` as data. It describes how
     a payer accepts filings. Nothing reads it to send anything; submission
     stays manual.
2. **Mapping is deterministic.** `mapPayerCode(payerKey, printedCode, onDate)`
   is a pure function over the version effective on that date: an exact
   normalised match, else **unmapped**. It never uses the nearest match, and a
   model never maps. An unmapped code is a finding on the case ("payer code
   CB-203 has no mapping in this payer's playbook"), not a guess.
3. **The taxonomy grows by ADR-tracked edits to `reason-codes.ts`.** It stays
   under the 60-code ceiling, and the first additions are staffing and
   foodservice codes. `deductions.reason_code_as_printed` stays as it is. The
   canonical code is derived at read time from the playbook version that was
   effective when the deduction was taken, and is recorded on the case's
   decision state (draft C).
4. **Drafting a playbook** uses the existing `/new-playbook` workflow. A model
   may *propose* rows from a routing guide, each quoting its source, but they
   land as `draft` and only a person promotes a version to `reviewed`.
   Only `reviewed` versions feed routing (draft G). A `confidence_low` version
   feeds shadow scoring and the case page, marked as such.
5. **Deadlines:** once a reviewed version states a window, a printed deadline
   is still preferred. A computed one is marked computed, with the rule and
   version that produced it.

## Options not taken

- **Teaching the reader the mapping.** It turns a fact about a payer into a
  model's opinion, which is invariant 4's quarantine in reverse.
- **A JSON file per payer in the repo.** It is code by another name: no
  effective dates per tenant, no provenance per fact, and it changes with a
  deploy.
- **Fuzzy matching of payer codes.** A wrong mapping is a wrong dispute
  basis.

## Consequences

- The `customer` suite's `CB-203` finding becomes a product behaviour:
  STF-203's case shows `PREMIUM-NOAUTH` once a playbook for its payer maps it.
  The **eval's extraction field stays as printed**; mapping is scored
  separately.
- Evidence planning and the deadline guard get their inputs.

## Invariants touched

- Invariant 2 (new append-only tables), invariant 6 (RLS).
- CLAUDE.md's "a retailer's rules are data" is satisfied rather than
  deferred.
