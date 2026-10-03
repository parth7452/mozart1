# Playbook drafts mined from Glimpse's published guides

These are **drafts of payer playbooks as data**, written with `/new-playbook`
from four guides Glimpse (tryglimpse.com) publishes as content marketing. They
are here so the facts a competitor publishes about a payer are captured with
provenance before they move, not because anything reads them.

What they are not:

- **Not code and not seed data.** Nothing imports these files. Draft D
  (`docs/plans/phase-2/adr-drafts/D-playbooks-are-versioned-data.md`) puts
  playbooks in append-only tables with a version, effective dates and
  provenance per fact; when that migration lands, a person promotes rows from
  these drafts, one fact at a time, and the file stays as the record of where
  each came from.
- **Not verified.** Every fact's source is a vendor's blog post, dated to the
  month, captured on the date on each row. A payer's own document outranks all
  of it. Where another vendor's write-up disagrees, both are recorded and the
  conflict is left open.
- **Not a reason to assume anything about billing.** `auto_reversal_behavior`
  is `unknown` on every draft on purpose: whether a payer reverses a deduction
  on its own, and how a reversal is told apart from a won dispute, decides
  whether a recovery is attributable, and nobody has observed it.

Each draft carries `confidence: low` and the one to three questions that would
raise it. UNFI already has a far deeper research file,
`docs/plans/unfi-portal/research.md` (ADR 0058); the UNFI draft adds only what
Glimpse's two UNFI posts state and points at that file for the rest.

| Draft | Source posts | Month published (per Glimpse's resources page) |
| --- | --- | --- |
| `unfi.yaml` | `/post/how-to-dispute-unfi-deductions`, `/post/unfi-kehe-supplier-deductions` | September 2026 |
| `kehe.yaml` | `/post/unfi-kehe-supplier-deductions` | September 2026 |
| `walgreens.yaml` | `/post/walgreens-deduction-disputes-cpg` | September 2026 |
| `chewy.yaml` | `/post/pet-brands-chewy-vendor-deductions`, `/post/pet-retailer-compliance-fees-independent-brands` | September and August 2026 |

Canonical reason codes are `packages/core-domain/src/reason-codes.ts`. A payer
code is mapped only where the guide's own description makes the family
unambiguous; otherwise `canonical` is `null` with the reason, because an
unmapped code is a finding and a wrong mapping is a wrong dispute basis.
