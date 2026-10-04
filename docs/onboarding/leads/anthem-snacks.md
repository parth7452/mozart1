# Lead: Anthem Snacks (anthemsnacks.com)

*2026-09-30. No conversation yet. Public sources only; marked where
inferred. The first call is discovery, then the demo.*

## Who they are

- Premium beef jerky and meat sticks, a zero-sugar line, dog treats, DTC
  subscription. Founded 2019 by two former Green Berets, Nate Kouhana (CEO)
  and Pat Lynch (VP Ops). Bozeman / Gallatin Gateway, MT; Wyoming LLC;
  SDVOSB-certified. "Official Jerky of the UFC."
- Co-packed: the label reads manufactured by Glenwood Snacks, Saint Anthony,
  Idaho. So no plant, and *inferred* a 3PL or the co-packer ships.
- Where sold: Lowe's (1,700+ stores, 2023), Wegmans (all stores, 2024),
  Scheels, Murdoch's, United Airlines onboard, Walmart.com, Faire, and Costco
  warehouse listings in early 2026 per a third-party tracker.
- Size: LinkedIn 2–10 staff; revenue estimates stale and under $5M. VP
  Sales Brandon Bayman (ex-Country Archer, Tessemae's, Campbell), which
  *inferred* means they run retailer promo calendars and eat retailer
  deductions the CPG way.
- Stack signal: Shopify only. Nothing on ERP, EDI, 3PL, broker or trade
  tools.

## What we do not know, and must find out first

Their deductions may not come through distributors at all. Lowe's, Wegmans,
Costco and an airline are retailer-direct or specialty-DSD accounts, and each
deducts through its own channel:

| If they sell via | Deductions arrive as | Our door |
| --- | --- | --- |
| A distributor (UNFI, KeHE, Core-Mark, McLane, a jerky DSD) | Remittance stubs with codes, backup by email or portal export | Email-in, upload, spreadsheets |
| Lowe's or Wegmans direct | Vendor portal notices (Lowe's Vendor Inquiry / Wegmans supplier portal), often EDI 812 or 820 through a VAN | Upload or forward the portal PDF; no portal read, no EDI feed yet |
| Costco direct | Costco's vendor portal and debit memos | Same |
| Walmart.com | APDP / Retail Link dispute flow | Same; the scanned Walmart APDP notice is a recorded case shape |
| United onboard | A contract with fewer coded deductions | Likely out of scope |

*Inferred* likeliest answer for a 2019 jerky brand at this scale: a mix of
direct retail accounts managed by the VP Sales with a broker for some, and a
3PL holding the BOL and POD.

## Questions for the first call

1. Which accounts short-pay you, and how does each one tell you: a portal
   notice, an EDI document, a remittance stub, or the deposit is just light?
2. Who manages the retailer promo calendars (Lowe's, Wegmans, Costco
   instant savings) and where do they live: a broker, a spreadsheet, a tool?
3. Who ships: the co-packer, a 3PL, or a carrier you book? Who holds the
   BOL and signed POD?
4. Which ledger: QuickBooks Online? (Shopify brands of this size usually
   are.)
5. Do you have EDI, and through whom (SPS, TrueCommerce, a VAN)?
6. What is the biggest deduction you never disputed, and why?
7. Who would prepare and who would approve?

## What to build only if the answers say so

- **Retailer-direct portal notices**: nothing to build for a pilot; upload
  and email-in read them today, and the recorded Walmart APDP case proves a
  scanned retailer notice reads. A read of Lowe's or Wegmans' portal is a
  later recipe under ADR 0057, terms first.
- **EDI 812/820**: if a VAN delivers them, the pilot forwards the human-
  readable printouts; the `formats` suite has an 812 printout that reads at
  100%. A feed is Phase 2.5.
- **Distributor stubs**: the same P1 fixture pack as Tarazi.

## Canonical codes their deductions will likely map to

Retailer-direct accounts lean on compliance and promo rather than MCBs:
`compliance_otif`, `compliance_asn_missing`, `compliance_label_barcode`,
`compliance_routing_guide`, `promo_allowance_claimed`, `markdown_allowance`,
`coop_advertising`, `shortage_quantity`, `return_unsaleable`, `freight_*`.
All exist in `reason-codes.ts`; only slotting and new-item fees are gaps.

## Fit

Unknown until the doors are known. If their deductions are retailer-direct
through portals we do not read, the pilot is upload and email only, and the
coverage story leans entirely on QuickBooks. That still works: a short-paid
Lowe's invoice in QuickBooks opens a case the same way a UNFI one does. If a
broker or a distributor is in the picture, they are the same shape as
Tarazi. Run the discovery call before promising anything specific.
