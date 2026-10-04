# Playbook drafts mined from Glimpse's published guides

These are **drafts of payer playbooks as data**, written with `/new-playbook`
from the per-payer guides Glimpse (tryglimpse.com) publishes as content
marketing: four on 2026-10-03, two more on 2026-10-04. They
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

| Draft | Source posts | Month published (per Glimpse's resources page) | Drafted |
| --- | --- | --- | --- |
| `unfi.yaml` | `/post/how-to-dispute-unfi-deductions`, `/post/unfi-kehe-supplier-deductions` | September 2026 | 2026-10-03 |
| `kehe.yaml` | `/post/unfi-kehe-supplier-deductions`; added 2026-10-04: `/post/kehe-new-policy-oct2025` | September 2026; November 2025 | 2026-10-03 |
| `walgreens.yaml` | `/post/walgreens-deduction-disputes-cpg` | September 2026 | 2026-10-03 |
| `chewy.yaml` | `/post/pet-brands-chewy-vendor-deductions`, `/post/pet-retailer-compliance-fees-independent-brands`; added 2026-10-04: `/post/pet-cpg-shortage-deductions-dispute` | September and August 2026 | 2026-10-03 |
| `walmart.yaml` | `/post/disputing-walmart-deductions-step-by-step` | September 2026 | 2026-10-04 |
| `petsmart.yaml` | `/post/petsmart-vendor-deductions-cpg-guide` | September 2026 | 2026-10-04 |

## What Glimpse publishes, and what it does not (searched 2026-10-04)

Every page of the blog list on `/resources` was read (five pages, 28 posts),
with the five `/channel/*` pages, `/integrations` and the homepage. Glimpse
publishes a per-payer guide for exactly six payers, the six above. For every
other payer it lists as supported there is a logo or a sentence and no rule:

| Payer | What Glimpse's public pages say | Draft |
| --- | --- | --- |
| Target | One sentence: "Target's compliance chargebacks carry just a two-week exemption window" (`/channel/big-box-retailers`) | None. Kept as a line in `walmart.yaml` under `company_reported_claims` |
| Sam's Club | "Sam's Club shortage claims and MABD" (`/integrations`) | None |
| Kroger, Albertsons, Publix, H-E-B | "each post shortage, spoilage, and promotional deductions under their own code systems" (`/channel/grocery`) | None |
| CVS, Rite Aid | "separate portals" (`/channel/drug-and-convenience`) | None |
| Sephora, Ulta | "their own vendor-compliance programs, chargeback codes, and dispute portals" (`/channel/beauty-retail`) | None |
| Amazon 1P, Whole Foods, Meijer, BJ's, Costco, Petco | Named as connectors, live or planned | None |
| 7-Eleven, Circle K, McLane, Core-Mark, Dollar General, Sprouts, DPI, Sysco, US Foods, PFG | Not named as a payer anywhere. McLane appears once, as a distributor a customer (Refresh Gum) ships through | None. What is public about McLane from other sources is in `docs/onboarding/leads/frazil.md` |

A draft is not written from a logo. The payers the first pilot is likely to
need (McLane, Core-Mark, the convenience chains) are not ones Glimpse writes
about at all.

## Conflicts found on the second pass

- **Walmart codes 24 and 25.** Glimpse: pricing discrepancy and advertising.
  SPS Commerce (2020): carton shortage and no merchandise received. Both
  `canonical: null`.
- **Walmart chargeback window.** Glimpse: "15 to 30 days of the posting date".
  SPS: nothing shorter than 12 months in APDP.
- **Chewy window.** Glimpse's Chewy guide: 60 days from the monthly
  notification. Glimpse's pet-shortage post: "30 to 60 days from the deduction
  posting date". One vendor, two answers.

## How the pages were read

A direct download of Glimpse's site is not permitted from this environment, so every page
was read through a fetch tool that returns a model's reading of the page, not
its bytes. Sentences marked `glimpse_quote` came back as quotations and, for
the Walmart and PetSmart guides, came back the same on a second read asking
for the words verbatim. A field marked `verbatim: false` is the tool's
paraphrase. **Before any fact is promoted, open its `source_url` and check the
sentence against the page.**

Canonical reason codes are `packages/core-domain/src/reason-codes.ts`. A payer
code is mapped only where the guide's own description makes the family
unambiguous; otherwise `canonical` is `null` with the reason, because an
unmapped code is a finding and a wrong mapping is a wrong dispute basis.
