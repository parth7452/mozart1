# The natural channel (`natural` suite, case HL-NAT-001)

Six synthetic documents shaped like what a natural or specialty food brand
selling through a UNFI-shaped and a KeHE-shaped distributor receives. They are
generated at run time from `packages/fixtures/src/natural.ts`, one table per
document, so each page, its totals and its ground truth cannot disagree.
`packages/fixtures/test/natural.test.ts` holds them to it.

| Key | Type | What it is | What it is for on the pre-sell call |
| --- | --- | --- | --- |
| `natural-dda-remittance` | `remittance_advice` | A direct deposit advice: five invoices paid, three short-paid by code: `HF-30418-111` (shortage), `MCB20260815` (manufacturer chargeback), `AVL4180311` (late delivery) | The founder uploads it live. It opens three cases, one per coded line (ADR 0028) |
| `natural-mcb-backup` | `deduction_notice` | The MCB's backup page: chargeback number, deal type `E`, item lines with cases and allowance per case, promotion window, the customer the discount went to. Totals $540.00, the advice's MCB line | Shows the backup attached to the MCB case |
| `natural-ksolve-deduction-detail` | `deduction_notice` | The second distributor's deduction detail export: a warehouse spoils line (`SPL-WH`) and an MCB admin fee (`MCB-ADM`), each with its own deduction number | "And your other distributor's export reads too" |
| `natural-deal-confirmation` | `promo_agreement` | The signed deal the MCB is checked against. Item 210441 is agreed at $2.50 a case where the backup bills $3.00, so $48.00 is arguable as `promo_rate_mismatch` | The evidence that turns an MCB into a dispute |
| `natural-bol` | `bol` | The shortage's PO 4180267: 140 cases shipped, matching the order | Shortage evidence |
| `natural-pod` | `pod` | The same PO delivered: 140 received, signed, "received in full", no exceptions | Shows the `-111` shortage is disputable |

## Names and sources

Every name is invented. Harborline Foods is the brand `pnpm render:web`
already uses. "Northwind Natural Distribution" stands in for a UNFI-shaped
payer and "Keystone Specialty Distribution" for a KeHE-shaped one. No page
prints UNFI, KeHE or K-Solve, and the test checks that. The code patterns
(`(Invoice#)-111`, `MCB(yyyymmdd)`, MCB deal type `E`, `AVL(PO#)`, spoils and
an MCB admin fee at 8%) come from the public sources in the seed list of
`docs/plans/unfi-portal/research.md` and the KeHE notes in
`docs/onboarding/leads/tarazi-foods.md`. None has been checked against a real
UNFI or KeHE document.

## Departures from the plan

- The deal confirmation is `promo_agreement`, not `price_agreement`. The
  classifier's definitions send a signed deal sheet and its allowances to
  `promo_agreement`, and the evidence checklist asks a promotion reason for a
  `promo_deal_sheet`, which is what that type counts as. Both types read
  through the same `AgreementSchema`, so the truth paths are the same.
- The MCB backup's per-line deal type `E` is printed but not asserted as
  `reason_code`. The scorer matches text by containment, so a one-letter
  expectation would pass almost any answer.
- The allowance per case on the MCB backup is not asserted as `unit_cost`,
  because an allowance is not a unit cost and the notice schema has no field
  for it. The rate check is in the test, over the generating table.
- The schemas have no field for the promotion window or the pass-through
  customer on a notice, or for the region on an agreement. Those are printed
  and not extracted.
- No "camera" rendition yet (EXECUTION.md P1 mentions one). The late fee has
  no appointment record in the pack.

## Not recorded

No cassettes are recorded. `packages/evals/baseline.json` names the suite in
`pendingSuites`, and `pnpm eval` reports it as skipped, not failed. Recording
is EXECUTION.md P2: `pnpm record:cassettes --suite natural`, which spends
money and waits for the founder's go, then `pnpm eval --record-baseline`.
