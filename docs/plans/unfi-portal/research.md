# UNFI: what public sources say, verified

*Research of 2026-09-26, for ADR 0058. Every claim below was checked against
its sources by a second pass. The verdict **confirmed** means the sources say
it. **Partly** means the claim as first written went too far, and the
corrected version is what appears here. Claims the check refuted or could not
support are listed under* Dropped *at the end, so that nobody reuses them.*

**Read this before relying on anything here:**

- **Most UNFI-owned pages are behind bot protection.** The Supplier Terms,
  the myUNFI Terms of Use and UNFI's site Terms of Use were seen only as
  search-result excerpts. Direct Commerce's terms were not found.
- **Most detail comes from deduction vendors** (SPS Commerce, SupplyPike,
  Glimpse, Crisp, Confido, OverDeduct), who sell services around UNFI
  deductions.
- **UNFI-authored documents read in full:** the 2021 Shipping & Handling
  Guidelines (V5.4, hosted by a third party; its fee amounts may be out of
  date), the Supplier Code of Conduct (March 2026) and the SVHarbor terms
  (July 2, 2020). The Supplier Terms and both Terms of Use were seen only as
  excerpts.
- **Nothing here has been checked against a real UNFI document or a real
  login.** That is what the founder's walk-through and the real deductions
  are for (`README.md`, steps 3 and 4).

## Verified findings

### Portals, access, sign-in and terms

| # | Claim | Verdict | Source |
| --- | --- | --- | --- |
| P1 | myUNFI's supplier dashboard calls itself "the digital front door". It holds no deduction detail itself and links out to the Natural Supplier Portal (`suppliers.unfi.com/Oidc`), the Dispute Center, the Harbor portals and UNFI Insights (Crisp). Its public script has no deduction, remittance or payment endpoint | confirmed | [myunfi-dash] [myunfi-bundle] |
| P2 | The Dispute Center is built by Direct Commerce and opened from myUNFI with "GO TO DISPUTE CENTER". It was announced January 2026, launched February 2026, is for natural suppliers only, and suppliers are onboarded in phases through 2026. SSO target `my.directcommerce.com/unfisso`. Its help centre returns a Cloudflare challenge | confirmed | [supplypike-eco] [sps-dc] [glimpse-dispute] [myunfi-bundle] [dci-zendesk] |
| P3 | `suppliers.unfi.com` (`/Account/Login`, and `/Oidc` from myUNFI) is the Natural Supplier Portal, which myUNFI labels "Natural Supplier Portal – Connect with your natural reports and tools." Vendor write-ups seen only as search snippets say it shows posted invoices, payments and deductions | partly | [suppliers-login] [myunfi-bundle] [glimpse-kehe] |
| P4 | Conventional deductions are handled in SVHarbor ePASS (`epass.svharbor.com/epass/home`). myUNFI also links three Harbor portals and SVInquire. SVHarbor's applications page names eight applications, and its SVInquire page lists "Vendor Funds - ability to view fund balances and transactions online in real time" | confirmed | [myunfi-bundle] [svh-epass] [svh-apps] [svh-emerch] [sps-conv] |
| P5 | UNFI Insights (Crisp) is reached through myUNFI. UNFI's 2023 release names "deduction and food waste dashboards". Crisp's Open Payables dashboard updates daily, serves natural and conventional suppliers, downloads as PDF and Excel, and its Invoice Number column "provides the keys UNFI uses to identify the deduction" | confirmed | [crisp-press] [crisp-open] [crisp-blog] [myunfi-bundle] |
| P6 | Natural remittances and backup arrive by email: PDFs, zips or a SharePoint link. Missing backup is requested from `DeductionsBackup@unfi.com`. myUNFI links "Supplier Deduction Key.xlsx", "Conventional Transaction Key.xlsx" and two FAQ PDFs, each redirecting to the B2C login. Glimpse puts the January 2025 key at 446 codes in 55 categories | confirmed | [supplypike-eco] [myunfi-bundle] [glimpse-kehe] |
| P7 | myUNFI enrollment asks for current Natural Supplier Portal or Harbor credentials and refuses without a validated remit or cross-reference. The Dispute Center needs a myUNFI account; onboarding is phased | confirmed | [myunfi-enroll] [myunfi-enroll-bundle] [sps-dc] [glimpse-dispute] |
| P8 | SVHarbor access is managed by an administrator. The terms of July 2, 2020 set an annual subscription fee, deducted from payments, based on the vendor's sales and the number of vendor users. The FAQ page is **older**, not newer: it bases the fee on yearly sales alone, lists an older set of applications and gives a SUPERVALU access address | partly | [svh-info] [svh-faq] [svh-terms] |
| P9 | The Natural Supplier Portal appears to have Owner, Manager and User roles, with an Owner able to set up users. This rests on help-centre titles and snippets only; the help centre returns a Cloudflare challenge and one result is titled "Help Center Closed". Confido says only one person can get the MCB emails | confirmed (snippets only) | [zd-add-user] [zd-manager] [slideplayer] [confido-cash] |
| P10 | myUNFI signs in through Azure AD B2C (`unfib2c.b2clogin.com`, policy `B2C_1A_P1_V1_SI_PE_PROD`, username-first `signInName`). The Dispute Center uses SAML policy `B2C_1A_P1_V1_SI_PE_SAML_DCIApp_PROD`. Password rules are ten characters minimum, three of four classes, and not the user id. The Harbor apps (epass, svcportal, svinquire) are fronted by F5 BIG-IP APM, which posts SAML to the same B2C tenant (`B2C_1A_P1_V1_SI_PE_SAML_F5_POCAPPS_PROD`). No MFA statement was found. The redirect and the policy name are seen on the 302 from `www.myunfi.com/api/authenticate/login`; `www.myunfi.com/` itself answers 200 | partly | [myunfi-login] [myunfi-bundle] [myunfi-enroll-bundle] [svh-epass-home] |
| P11 | UNFI's terms pages and `suppliers.unfi.com` return Imperva Incapsula challenges to automated requests, and the help centres return Cloudflare challenges. An unauthenticated svharbor request ends at a BIG-IP logout page. PDFs under `content/dam` are served. `robots.txt` has no Disallow | confirmed | [unfi-terms] [suppliers-login] [zd-deductions] [unfi-robots] [unfi-coc] [svh-epass-home] |
| P12 | The Dispute Center (per SPS, updated June 23, 2026) has Quick and Advanced Search, View Payments (30 days), My Docs (30/60/90), "Use search tools to find and export invoice, adjustment, payment, and dispute details.", attachments of "PDF, TIFF, JPEG, XLSX, and CSV. The maximum file size is 20MB per file.", and a History of every action. No export format is named | confirmed | [sps-dc] |
| P13 | ePASS gives deduction copies, a payment search and "Create PASS#", on a pay-in-full-then-deduct model. Glimpse: 12 months of electronic copies. No ePASS export is documented. SVInquire's "Download Listing" covers funds, orders, items and sales, not deductions. SPS: pass attachments are capped at 5 MB | confirmed | [svh-terms] [svh-epass] [svh-emerch] [glimpse-dispute] [sps-conv] |
| P14 | Glimpse describes weekly MCB, PLC, CMQ and reclaim email summaries. Confido gives MCB sign-up through `supplierdeductiondisputemgmt@unfi.com` and the `PB` suffix. Backup requests go to `deductionsbackup@unfi.com`, subject "BACKUP REQUEST" (Glimpse). A search snippet of UNFI's "Natural Deduction Backup Requests" article says requests use an Excel form. Remitparse says deductions "arrive in PDF form" and calls the remittance a "UNFI Direct Deposit Advice" | partly | [supplypike-eco] [glimpse-dispute] [confido-cash] [zd-backup] [remitparse] |
| P15 | Only EDI vendors say UNFI sends an 820: one says so, one lists 820 and 824 as UNFI-sent, one lists 820 as optional. No source mentions an 812. SVHarbor's EDI page gives only `ec.helpline@unfi.com` | confirmed | [crstl] [endless-edi] [infocon] [svh-edi] |
| P16 | Natural disputes go through the Dispute Center: adjustments older than 12 months denied, one appeal, 35–45 days. Some types go by email: AP Cash Terms, SAS, SASIF, PRGX. myUNFI names `SupplierDeductionDisputeMgmt@unfi.com`. The older process (SPS, July 2025) used `Deductions@unfi.com` and an `.xlsb` form | confirmed | [sps-dc] [supplypike-eco] [myunfi-bundle] [sps-natural] [glimpse-dispute] |
| P17 | Conventional disputes are PASS# inquiries in ePASS. The 2020 SVHarbor terms set an 18-month limit, one re-open and an escalation ladder ("Supply Chain Services Only"). SPS (July 2025): 60 days suggested, 12 months the limit, 30–45 days to resolve | confirmed | [svh-terms] [sps-conv] |
| P18 | The Supplier Terms (search excerpts only): UNFI pays net of deductions; what it cannot deduct within 30 days it bills, due immediately; disputes go to senior management within 30 days, then mediation, then AAA arbitration in Providence, RI. No deduction-dispute deadline appeared in the excerpts seen | confirmed (excerpts only) | [unfi-terms] |
| P19 | The myUNFI Terms of Use (search excerpts only): "The Service is protected by user-specific passwords or login"; user or password sharing is forbidden; users must not "take any action that might compromise the security of the Site". The site Terms of Use forbid mirroring, framing and deep links. No wording on robots, scrapers or automated access appeared in the excerpts; the full texts have not been read | confirmed (excerpts only) | [myunfi-tou] [myunfi-tou-2] [unfi-site-tou] |
| P20 | The SVHarbor terms (July 2, 2020) cover confidential logons, administrator-assigned access, a "Vendor" definition that includes agents, and acceptance by entering the system. No automation clause. The information page says suppliers and brokers should not set up users across profiles | confirmed | [svh-terms] [svh-info] |
| P21 | The Supplier Code of Conduct (March 2026) limits information use to its purpose, makes the supplier liable for damages from its access to UNFI systems, and has cyber incidents reported to `cyber@unfi.com`. The Supplier Terms' confidential information includes "any reports provided by UNFI to Supplier", and disclosure to a third party needs written consent | confirmed (excerpts only for the Supplier Terms) | [unfi-coc] [unfi-terms] |
| P22 | SPS Revenue Recovery "ingests UNFI's email-based and MyUNFI deduction data" without saying how. iNymbus "Submits the dispute directly on the appropriate portal". Neither says UNFI permits it. No public UNFI API was found | confirmed | [sps-rr] [inymbus] |
| P23 | `my.directcommerce.com/robots.txt`, on the Dispute Center's host, reads `User-agent: *` / `Disallow: /`. The other portal hosts publish no robots file: `www.myunfi.com/robots.txt` returns the app's HTML page, and `suppliers.unfi.com/robots.txt` answers a redirect (302). The `www.unfi.com` file (P11) covers no portal host | confirmed (fetched 2026-09-26, at review) | [dc-robots] [myunfi-robots] [suppliers-robots] |

### Deduction types, codes, backup and windows

| # | Claim | Verdict | Source |
| --- | --- | --- | --- |
| C1 | The Supplier Terms say UNFI pays invoices net of all deductions, chargebacks and fees owed under the Supplier Policies. What it cannot deduct within 30 days is billed and due immediately. The Supplier Policies are the Guidelines, the Shipping & Handling Policies and the Product Recall and Withdrawal Policy (search excerpts; Glimpse repeats the 30-day rule) | confirmed (excerpts only) | [unfi-terms] [glimpse-dispute] [endless-playbook] |
| C2 | Natural and conventional deductions run through separate systems with different code sets. Natural: AP reps, emailed backup, the Dispute Center, East and West managed separately. Conventional: legacy SUPERVALU, SVHarbor ePASS. No source says which retailers each side serves | partly | [crisp-open] [supplypike-eco] [sps-conv] [glimpse-dispute] |
| C3 | An MCB (manufacturer chargeback) bills a supplier for discounts UNFI gave a retailer under a deal the supplier authorised, at UNFI's wholesale catalogue price. One 2018 supplier agreement filed with the SEC: "UNFI may deduct all Supplier chargebacks at UNFI's wholesale catalogue price." Glimpse: UNFI does not accept MCB-only promotions unless agreed with the SRM | confirmed | [sec-farmer] [glimpse-dispute] [grocerynerd] |
| C4 | Crisp documents MCB deal-type letters "provided by UNFI": East A, C, D, M, N, O, P, T, U, Z and West A, C, E, F, M, O, P, S, T. Crisp defines West A as "Ad Deal", C as "Customer-specific Published Deal" and E as "EDLP". Glimpse, in the format `MCB(yyyymmdd)`: West A is ad promotions, C price promotions, E EDLP. The two sources differ on C; Crisp's is the definition "provided by UNFI" | confirmed | [crisp-codes] [glimpse-kehe] |
| C5 | Retailer pass-throughs: Sprouts says items through KeHE or UNFI "will receive a deduction on behalf of Sprouts" for free fill, and vitamins, body care and general merchandise free fill is "at 100% MCB". SPS: `(Invoice#)(Company Code)` is "Retailer-incurred costs passed through to the supplier by UNFI". Crisp lists a "Whole Foods Third Party" report | confirmed | [sprouts] [sps-natural] [supplypike-eco] [crisp-open] |
| C6 | EDLC is Whole Foods' "Everyday Low Cost Program" in the 2015 WFM–UNFI agreement: UNFI will "deduct from or credit to the supplier or manufacturer the appropriate EDLC reconciliation amount". The formula is redacted | confirmed | [sec-wfm] |
| C7 | Discretionary programmes include OI, scans, EDLP and distributor advertising; OIs are usually on the invoice, not deducted. SupplyPike lists scan allowance, in-store execution, weekly chargebacks, quality chargebacks, reclaims, fair share deductions and DC inventory pulls as contractual types, without codes | confirmed | [confido-blog] [promomash-instore] [supplypike-types] |
| C8 | Glimpse: spoils allowances (Supplier Policies §7C) are given off invoice, and a shortfall can be deducted; reclamations (§11B) at 100% supplier cost; reset fees (§11C) proportional. Confido: fair share percentage allowances are "almost always non-negotiable". The section numbers are Glimpse's, not checked against UNFI's text | confirmed | [glimpse-dispute] [confido-blog] |
| C9 | The 2021 Shipping & Handling Guidelines (V5.4): "UNFI will bill back concealed damages and hidden shorts plus additional labor costs"; drivers picking up sign "subject to count"; UPS and FedEx deliveries are signed by package count | confirmed | [sh-2021] |
| C10 | UNFI may reject unacceptable product or require return or disposal at supplier cost. The 2018 agreement defines unacceptable product (quality or shelf life; packaging, labelling or UPC; warranty; recall or withdrawal). SPS lists `CMQ(mmyy)0(Remit#)` ("Quality-Based Manufacturer Chargeback") and `CMQUNB(Invoice#)` ("Unbilled Quality Recall Chargeback") | confirmed | [sec-farmer] [sps-natural] [unfi-terms] |
| C11 | 2021 fees. Natural DCs: $54 (31–60 min late), $204 (61+), $304 unscheduled, $254 reschedule under 24 h. Conventional: $300 late over 30 min, $300 unscheduled, $300 reschedule, $500 no call/no show, "collected at the time of driver arrival". $6.50 per pallet floor-loaded; $63 administration charge | confirmed | [sh-2021] |
| C12 | A broker newsletter: from January 1, 2023, a $50 per pallet PO placarding fee and a $500 per PO barcode non-compliance fee, citing the S&H guidelines | confirmed | [pmidpi] |
| C13 | UNFI expects a fill rate of at least 95%. Two consecutive weeks below it triggers a corrective action plan and, "traditionally", about a 3% service-level fine on shorted goods | confirmed (vendor sources) | [confido-blog] [glimpse-dispute] [endless-playbook] |
| C14 | Confido: overships deducted at a 35% off-invoice discount if UNFI elects to sell them; a sliding scale of pack-change fees per SKU per DC; recalls at $3,000 base plus disposal. SPS: `29CM`, `PCM`, `FNCM` for recall disposal | confirmed | [confido-blog] [sps-natural] |
| C15 | SSA charges a flat 2.5% of purchases in place of dozens of fees. It was announced about March 2024 and charged from May 1, 2024. From February 1, 2026, enrolled natural suppliers get one monthly deduction per region, posting about two weeks after month end, at unchanged cost. SSA is opt-in | confirmed | [beerinsights] [confido-blog] [grocerynerd] [promomash-ssa] [glimpse-kehe] |
| C16 | SSA waives DCE, new-item and reactivation slotting, SVHarbor access and ReposiTrak fees. It waives compliance fees only while monthly thresholds are met (5% or less appointment, load and costing letters per PO; 95% fill or better; 1% or less late notification or disposition); warnings for three consecutive months revoke the waiver | confirmed | [glimpse-dispute] |
| C17 | Standard terms include a 2% cash discount (Confido says within 10 days; Glimpse gives net 45 by check, 50 by ACH and 25 by card, with 2% at 20, 25 and 10 days). A November 2024 class action alleges UNFI takes prompt-payment discounts outside the window; UNFI said it was "reviewing the details of the complaint" | confirmed | [scd-classaction] [confido-blog] |
| C18 | UNFI publishes "Supplier Deduction Key 01.14.2025.xlsx" on its support site, mapping the Invoice Number column's keys for natural and conventional. Glimpse's count of 446 codes in 55 categories is Glimpse's own | confirmed | [crisp-open] [sps-natural] [glimpse-kehe] |
| C19 | `(Invoice#)-111` is a quantity or pricing discrepancy. SupplyPike lists both Shortage (111) and Pricing (111), so `-111` alone is ambiguous; the backup tells them apart. In the Dispute Center, an adjustment number's middle section is 0 ("deduction") or 111 ("invoice chargeback"), and a 111 there is also the adjustment reason code. SPS's examples are `9876543–111–EAST` and `1234567-0-East`, and it calls the first section "the adjustment number"; whether that is the supplier's invoice number is not stated | confirmed | [sps-natural] [supplypike-types] [glimpse-kehe] [sps-dc] |
| C20 | Natural compliance and logistics prefixes, keyed on the PO: `LCBC`, `LCP`, `LCPV`, `LCBOL`, `AVL` (more than 30 minutes late), and per SPS also `LCF`, `LCO`, `AVNCNS`, `AVR`. `LCBC` rests on SPS alone | confirmed | [sps-natural] [glimpse-kehe] |
| C21 | Other natural patterns, each from a single vendor source. SPS: `ERSLSBYS(mmyy)0(Remit#)` Sales Velocity Report by State, `(Invoice#)CV`, `(Invoice#)SP`, `WRSLOFE(mmyy)` slotting, `29CM`/`PCM`/`FNCM` recall disposal. Glimpse: East `UOI(mmyy)`, "UNFI's billback for promotional activity beyond what was agreed"; West `MCB(yyyymmdd)`; `[DC#]CNDM(mmmyy)` with 01 Rocklin, 02 Seattle, 05 Denver. Promomash: `SSA0226ERemit` and `SSA0226WRemit` | confirmed | [sps-natural] [glimpse-kehe] [promomash-ssa] |
| C22 | Suffixes that are not new deductions: `PP` is a prepayment or reversal netting to zero ("not a deduction"); `PB` is the payback of a won dispute; SPS lists `PB`/`DM` as "repayment or correction of a previously disputed deduction". Confido: deductions show as a negative gross amount | confirmed | [confido-blog] [glimpse-dispute] [sps-natural] |
| C23 | Third-party recovery prefixes: SAS to `unficorr@sasrecovery.com`; SASIF (freight) to `unfifrt@sasrecovery.com`; PRGX to `UNFIAudit@prgx.com`. On the conventional side, "SAS/PRG" is labelled Post Audit | confirmed | [supplypike-eco] [sps-dc] [glimpse-dispute] [sps-conv] |
| C24 | SPS (July 24, 2025) lists conventional three-letter codes with descriptions: `BB6`, `BBT`, `CCS`, `CPI`/`CPN`, `DIR`, `DIV`, `FBB`, `HCG`, `MER`/`WRM`, `PLR`, `PMD`/`DEX`/`SBT`, `PME`, `PMT`, `PRM` ("Promotions, Floorstock, and Price Deadline"), `SAS`/`PRG`, `SVI`, `SWL`, `SXP`. It is the only source | confirmed | [sps-conv] |
| C25 | Natural backup mostly arrives by email with the remittance (PDFs, zips, SharePoint links, from at least four UNFI senders). Missing backup: `DeductionsBackup@unfi.com`, subject "BACKUP REQUEST", with remit number, deduction invoice number and check number | confirmed | [crisp-open] [supplypike-eco] [glimpse-dispute] |
| C26 | Crisp: Weekly MCB, Quality MCB, Reclamation and Whole Foods Third Party reports "are automatically emailed when generated". Confido: MCB documents, by sign-up at `supplierdeductiondisputemgmt@unfi.com`, come weekly and "include backup for a wide variety of deductions"; "UNFI only allows one person can get these emails" | partly | [crisp-open] [confido-blog] [confido-cash] |
| C27 | Conventional suppliers self-serve in ePASS by Document Search or by creating a PASS#; 12 months of electronic copies (Glimpse); access through `MerchandisingServices@unfi.com` | confirmed | [sps-conv] [crisp-open] [glimpse-dispute] |
| C28 | The Dispute Center: find by payment or adjustment number; payment details, deductions, related documents and history; attachments up to 20 MB; statuses from Draft to Appealed. SPS relies on UNFI's Dispute Center Supplier Training Manual v1.2 | confirmed | [supplypike-eco] [sps-dc] [glimpse-dispute] |
| C29 | AP Cash Terms types (short payments, PP lines, cash discounts, unpaid invoices, detention and redelivery) go to `UNFINaturalResearch@unfi.com`; SAS, SASIF and PRGX to those firms (SupplyPike, as of July 2026) | confirmed | [sps-dc] [supplypike-eco] [glimpse-dispute] |
| C30 | Before the Dispute Center: an Excel form, "UNFI Natural Supplier Dispute Form 01012024.xlsb" ("Excel format (not PDF or screenshot)"), sent to `Deductions@unfi.com` with a set subject line; a tracking number in about two business days; weekly status emails | confirmed | [sps-natural] [glimpse-dispute] |
| C31 | Two EDI vendors say UNFI sends an 820 with payment and deduction details, and one lists an 824. Neither shows an 812. No source describes backup by EDI | confirmed | [crstl] [endless-edi] |
| C32 | Vendors agree adjustments older than 12 months are denied. Glimpse: the clock starts when UNFI records the deduction. SPS (conventional): up to 12 months, 60 days recommended. Endlesscommerce: about 30–60 days in practice. No UNFI primary text confirms any of it | confirmed (vendor sources) | [sps-dc] [glimpse-dispute] [sps-conv] [endless-playbook] [overdeduct-compliance] |
| C33 | Disputes resolve in 30–45 days (SPS also says 35–45). Repayment takes 7–10 business days (Glimpse). One appeal with new documentation, opening three business days after resolution (Glimpse) | confirmed | [sps-dc] [sps-natural] [glimpse-dispute] |
| C34 | Glimpse says UNFI "reserves the right to conduct third-party invoice audits within 24 months of the fiscal-year close, which can produce a post-audit deduction". No checked source says these arrive under SAS or PRGX; only the conventional "SAS/PRG" label says Post Audit | partly | [glimpse-dispute] [supplypike-eco] [sps-conv] |
| C35 | 2021 guideline: excess or unauthorised shipments are reported within 24 h, with disposition within 24 h, else donated, dumped or returned freight collect within 15 days; FOB PO shortages notified preferably 96 h, and no less than 48 h, ahead. Supplier Terms (excerpt): at least 90 days' written notice of price changes, including off-invoice allowance programmes. A newer SPS article gives 14 days to arrange overage pickup | confirmed | [sh-2021] [unfi-terms] [glimpse-dispute] |
| C36 | Evidence by type. Shortage: a signed, dated BOL tied to the PO, plus signed POD and packing list. Pricing: the PO with the agreed cost, the current price list, a signed deal sheet or price confirmation. MCB: a signed deal confirmation or approved item file, the promo calendar and the contract. Compliance: routing confirmations, ASN/EDI records, labelling documents and photos. Concealed damage (CNDM): "proof of disposal or a return authorization" | partly | [glimpse-dispute] [glimpse-kehe] [overdeduct-pricing] [overdeduct-howto] [vividly] [overdeduct-compliance] |
| C37 | Inference, labelled as the researcher's: because drivers sign "subject to count", parcels are signed by package count, and concealed damage and hidden shorts are billed back, a signed BOL or POD alone may not rebut a concealed or small-parcel shortage | confirmed (as an inference) | [sh-2021] |
| C38 | Vendors single out shortages (`-111`) as most often invalid on the natural side, and pricing as highly disputable, often a data-entry error. These are vendor opinions, not measured rates | confirmed (opinion) | [glimpse-kehe] [glimpse-dispute] [endless-playbook] [overdeduct-pricing] |
| C39 | MCBs are valid when tied to a signed deal and disputable when billed against a promotion never authorised. Glimpse rates reclamations and resets "Rarely" recoverable, spoils "Partially", compliance "Yes, if threshold was met" | confirmed | [glimpse-dispute] [glimpse-kehe] [overdeduct-howto] |
| C40 | A pet-food supplier sued UNFI in January 2024 over $268,816.94 of unacceptable-product chargebacks on more than $326,780 of product sold to one retailer, alleging no return, disposal or accounting. These are allegations, not findings | confirmed | [scd-omaha] [acru] [inymbus] |
| C41 | Promomash (citing consultants and its own data): trade and promotion deductions 70–80% valid; 60–70% of shortage and damage claims overstated; overall invalid about 5–10% of value. Promomash itself says "there is no public, industry-wide benchmark". Not specific to UNFI | confirmed (estimates) | [promomash-warning] |
| C42 | A Glimpse case study: one brand found $40,000 of undisputed invalid deductions under $50, and $80,000 under $200, from KeHE and UNFI **combined** in one year | partly | [glimpse-kehe] [glimpse-dispute] |

## Seed list: UNFI deduction types and codes

Every row is **public source, unverified against real UNFI documents**. The
candidate canonical code is from `packages/core-domain/src/reason-codes.ts`
and is a starting point for a person building the code map as Draft D rows,
not a mapping. "Open" means no candidate is justified yet. "Gap" means the
taxonomy has no code for it and Draft D's taxonomy edit should consider one.
Dollar amounts are from sources dated 2021–2024 and may be out of date.

### Natural side: printed codes and patterns

| Code or pattern (as the source prints it) | What the source says | Candidate canonical code | Status | Source |
| --- | --- | --- | --- | --- |
| `(Invoice#)-111` | Quantity **or** pricing discrepancy; the backup tells which | None by code alone: a person picks `shortage_quantity` or `price_discrepancy` from the backup | public source, unverified against real UNFI documents | [sps-natural] [supplypike-types] [glimpse-kehe] |
| `MCB(yyyymmdd)` (West) | Manufacturer chargeback for an authorised deal, at wholesale catalogue price | `promo_allowance_claimed` | public source, unverified against real UNFI documents | [glimpse-kehe] [glimpse-dispute] [sec-farmer] |
| MCB deal type A, F, P (West) | A ad promotions; F flyer; P publications | `coop_advertising` | public source, unverified against real UNFI documents | [crisp-codes] [glimpse-kehe] |
| MCB deal type E (West) | Crisp: "EDLP", customer-specific discounts submitted to UNFI by the supplier or broker; Glimpse: EDLP | `promo_allowance_claimed` | public source, unverified against real UNFI documents | [crisp-codes] [glimpse-kehe] |
| MCB deal type C (West) | Crisp, "provided by UNFI": "Customer-specific Published Deal", a discount published through UNFI that customers sign up for. Glimpse: price promotions. The two differ | Open until real backup settles it; family `promotion` | public source, unverified against real UNFI documents | [crisp-codes] [glimpse-kehe] |
| Other MCB deal-type letters (East A, C, D, M, N, O, P, T, U, Z; West M, O, S, T) | Defined by Crisp; definitions not transcribed here | Open | public source, unverified against real UNFI documents | [crisp-codes] |
| `UOI(mmyy)` (East) | "UNFI's billback for promotional activity beyond what was agreed"; the letters' meaning is unverified | `promo_allowance_claimed` | public source, unverified against real UNFI documents | [glimpse-kehe] |
| `CMQ(mmyy)0(Remit#)` | Quality-Based Manufacturer Chargeback | `quality_spec_mismatch`, or `quality_expired_short_dated` when the backup says shelf life | public source, unverified against real UNFI documents | [sps-natural] |
| `CMQUNB(Invoice#)` | Unbilled Quality Recall Chargeback | Gap (recall); nearest `quality_spec_mismatch` | public source, unverified against real UNFI documents | [sps-natural] |
| `29CM`, `PCM`, `FNCM` | Recall disposal | Gap (recall and disposal); nearest `return_handling_fee` | public source, unverified against real UNFI documents | [sps-natural] |
| `AVL` | Delivery more than 30 minutes late | `compliance_late_delivery` | public source, unverified against real UNFI documents | [sps-natural] [glimpse-kehe] |
| `AVNCNS(PO#)` | SPS: "No-Show Delivery Fee", charged when a supplier misses a delivery appointment without notice | `compliance_appointment_missed`, on SPS's description | public source, unverified against real UNFI documents | [sps-natural] |
| `AVR(PO#)` | SPS: "Last-Minute Rescheduling Fee", when a delivery is rescheduled with less than 24 hours' notice | `compliance_appointment_missed`, on SPS's description | public source, unverified against real UNFI documents | [sps-natural] |
| `LCBC(PO#)` | SPS: "Barcode Non-Compliance Fee", when barcodes are missing or not scannable on cartons or pallets | `compliance_label_barcode`, on SPS's description | public source, unverified against real UNFI documents | [sps-natural] [glimpse-kehe] |
| `LCO(PO#)` | SPS: "Missing or Unreadable UPCs", UPC barcodes not included or not scannable on the product | `compliance_label_barcode`, on SPS's description | public source, unverified against real UNFI documents | [sps-natural] |
| `LCP(PO#)` | SPS: "Pallet Labeling Non-Compliance", a fee for missing or incorrect pallet placards or required PO labels | `compliance_label_barcode`, on SPS's description | public source, unverified against real UNFI documents | [sps-natural] [glimpse-kehe] |
| `LCPV(PO#)` | SPS: "Pallet Construction Violation", a pallet failing one or more standards (overhang, damage, poor stacking) | `compliance_pallet_spec`, on SPS's description | public source, unverified against real UNFI documents | [sps-natural] [glimpse-kehe] |
| `LCF(PO#)` | SPS: "Load Securement Failure", product not properly secured, leading to movement or damage in transit | Open; `compliance_pallet_spec` or `compliance_packaging`, from the backup | public source, unverified against real UNFI documents | [sps-natural] |
| `LCBOL(PO#)` | SPS: "Incomplete Shipping Docs", a missing or incorrect BOL or packing slips on delivery | Open; family `compliance` | public source, unverified against real UNFI documents | [sps-natural] [glimpse-kehe] |
| `ERSLSBYS(mmyy)0(Remit#)` | Sales Velocity Report by State | `administrative_fee` | public source, unverified against real UNFI documents | [sps-natural] |
| `WRSLOFE(mmyy)` | Slotting | Gap (slotting); nearest `new_store_allowance` | public source, unverified against real UNFI documents | [sps-natural] |
| `(Invoice#)CV` | SPS: "ClearVue Program Deduction", deducted when the ClearVue allowance is not reflected on the invoice | Open; family `promotion`, from the backup | public source, unverified against real UNFI documents | [sps-natural] |
| `(Invoice#)SP` | SPS: "Spoilage Allowance Omission", issued when spoilage credits are left off the invoice. It bears on the spoils-allowance gap below | Gap (spoils allowance); nearest `return_unsaleable` | public source, unverified against real UNFI documents | [sps-natural] |
| `[DC#]CNDM(mmmyy)` | Concealed damage; DC 01 Rocklin, 02 Seattle, 05 Denver | `quality_damaged_in_transit` | public source, unverified against real UNFI documents | [glimpse-kehe] [glimpse-dispute] |
| `SSA0226ERemit`, `SSA0226WRemit` | Monthly SSA fee per region (2.5% of purchases, opt-in) | `administrative_fee` | public source, unverified against real UNFI documents | [promomash-ssa] [beerinsights] |
| `(Invoice#)(Company Code)` | Retailer-incurred costs passed through by UNFI | Open until the backup names the retailer's reason; `unknown_uncoded` meanwhile | public source, unverified against real UNFI documents | [sps-natural] [supplypike-eco] |
| `SAS`, `SASW` prefix | Routed to `unficorr@sasrecovery.com` | Open; family `post_audit` only by analogy with the conventional label | public source, unverified against real UNFI documents | [supplypike-eco] [glimpse-dispute] |
| `SASIF` | Freight; routed to `unfifrt@sasrecovery.com` | Open; family `freight` or `post_audit`, from the backup | public source, unverified against real UNFI documents | [supplypike-eco] [sps-dc] |
| `PRGX` | Routed to `UNFIAudit@prgx.com` | Open; family `post_audit` only by analogy | public source, unverified against real UNFI documents | [supplypike-eco] [sps-dc] |
| `PP` suffix | Prepayment or reversal netting to zero; "not a deduction" | None: not a deduction. Draft D's code map has no way to say so yet | public source, unverified against real UNFI documents | [glimpse-dispute] [confido-blog] |
| `PB`, `DM` suffix | Repayment or correction of a previously disputed deduction | None: not a new deduction but an outcome. Draft D's code map has no way to say so yet | public source, unverified against real UNFI documents | [confido-blog] [sps-natural] |

### Conventional side (SVHarbor): printed codes

| Code | What the source says | Candidate canonical code | Status | Source |
| --- | --- | --- | --- | --- |
| `SAS/PRG` | Post Audit | `post_audit_pricing`, `post_audit_allowance` or `post_audit_freight`, from the backup | public source, unverified against real UNFI documents | [sps-conv] |
| `PRM` | "Promotions, Floorstock, and Price Deadline" | Open; family `promotion` or `pricing`, from the backup | public source, unverified against real UNFI documents | [sps-conv] |
| `SXP` | AdMax | `coop_advertising` | public source, unverified against real UNFI documents | [sps-conv] |
| `BB6`, `BBT`, `CCS`, `CPI`/`CPN`, `DIR`, `DIV`, `FBB`, `HCG`, `MER`/`WRM`, `PLR`, `PMD`/`DEX`/`SBT`, `PME`, `PMT`, `SVI`, `SWL` | Listed with descriptions by SPS alone; descriptions not transcribed here | Open | public source, unverified against real UNFI documents | [sps-conv] |
| Code descriptions "Billback Cub Retail DSD", "Billback Shoppers Retail DSD" | DSD billbacks for UNFI's own retail banners | Gap (billback); nearest `promo_allowance_claimed` | public source, unverified against real UNFI documents | [sps-conv] [supplypike-eco] |

### Deduction types with no printed code in any source

| Type | What the source says | Candidate canonical code | Status | Source |
| --- | --- | --- | --- | --- |
| Early-payment discount taken outside its window | A 2% cash discount; a class action alleges it is taken late | `unauthorised_deduction_no_basis` | public source, unverified against real UNFI documents | [confido-blog] [scd-classaction] |
| EDLC reconciliation | Whole Foods' Everyday Low Cost Program; "deduct from or credit to"; whether it still runs is unknown | `promo_allowance_claimed` | public source, unverified against real UNFI documents | [sec-wfm] |
| Retailer free fill | Sprouts: free fill at wholesale value; "at 100% MCB" for vitamins, body care, general merchandise | `new_store_allowance` | public source, unverified against real UNFI documents | [sprouts] |
| Scan allowance; fair share | Contractual programmes; fair share "almost always non-negotiable" | `promo_allowance_claimed` | public source, unverified against real UNFI documents | [supplypike-types] [confido-blog] |
| Spoils allowance shortfall | Off-invoice allowance; a shortfall may be deducted (§7C per Glimpse). SPS's `(Invoice#)SP` may be its printed code | Gap (spoils allowance); nearest `return_unsaleable` | public source, unverified against real UNFI documents | [glimpse-dispute] |
| Reclamation | 100% supplier cost (§11B per Glimpse) | `return_unsaleable` | public source, unverified against real UNFI documents | [glimpse-dispute] |
| Reset fee | Proportional (§11C per Glimpse) | Gap; nearest `new_store_allowance` | public source, unverified against real UNFI documents | [glimpse-dispute] |
| Concealed damage and hidden shorts, plus labour | Billed back (2021 guidelines) | `quality_damaged_in_transit` (damage) or `shortage_concealed` (shorts) | public source, unverified against real UNFI documents | [sh-2021] |
| Late delivery fee | Natural $54 / $204; conventional $300 (2021) | `compliance_late_delivery` | public source, unverified against real UNFI documents | [sh-2021] |
| Unscheduled, rescheduled or no-call/no-show delivery | Natural $304 / $254; conventional $300 / $300 / $500 (2021) | `compliance_appointment_missed` | public source, unverified against real UNFI documents | [sh-2021] |
| Floor-loaded pallets | $6.50 per pallet (2021) | `compliance_pallet_spec` | public source, unverified against real UNFI documents | [sh-2021] |
| Administration charge | $63, for an audited missing transportation allowance or erroneous freight charges (2021) | `administrative_fee` | public source, unverified against real UNFI documents | [sh-2021] |
| PO placarding; barcode non-compliance | $50 per pallet; $500 per PO (from 2023) | `compliance_label_barcode` | public source, unverified against real UNFI documents | [pmidpi] |
| Service-level fine | About 3% of shorted goods when fill is under 95% for two weeks | `compliance_otif` | public source, unverified against real UNFI documents | [confido-blog] [glimpse-dispute] |
| Overship | Deducted at a 35% off-invoice discount if UNFI sells the goods | Gap; nearest `price_discrepancy` | public source, unverified against real UNFI documents | [confido-blog] |
| Pack change | Sliding-scale fee per SKU per DC | `administrative_fee` | public source, unverified against real UNFI documents | [confido-blog] |
| Recall | $3,000 base plus disposal | Gap (recall); nearest `administrative_fee` | public source, unverified against real UNFI documents | [confido-blog] |
| Unacceptable product | Quality or shelf life; packaging, labelling or UPC; warranty; recall | `quality_spec_mismatch` or `quality_expired_short_dated` | public source, unverified against real UNFI documents | [sec-farmer] |

**Gaps this list shows in the taxonomy**, for Draft D's taxonomy edit:
billback, slotting and placement, spoils allowance, recall and disposal,
overship, and a way for a code map to say "not a deduction" (`PP`) or "a
repayment of one" (`PB`, `DM`).

## Dropped or unsupported: do not reuse

Each of these was in a draft of the research and failed the check, or was
narrowed to the corrected version above.

1. That Glimpse gives `suppliers.unfi.com/Account/Login` as the Dispute
   Center's address. Its link is labelled "myUNFI" and points to the legacy
   Natural Supplier Portal. The Dispute Center is at `my.directcommerce.com`.
2. That the Natural Supplier Portal shows invoices, payments and deductions,
   stated as fact. It rests on search snippets; no cited source says it.
3. That the SVHarbor FAQ page is newer than the 2020 terms. It is older.
4. That legacy Harbor is federated through a CA SiteMinder proxy. The Harbor
   apps are fronted by F5 BIG-IP APM posting SAML to B2C. The SiteMinder-style
   proxy appears only as a link prefix, and it answered 503.
5. That `www.myunfi.com` redirects to a login. It answered 200 [myunfi-root].
   The redirect to B2C is from `www.myunfi.com/api/authenticate/login`
   [myunfi-login].
6. That "Backup request for [your remit]" is a UNFI support article's title.
   It is from a search snippet; the article is titled "Natural Deduction
   Backup Requests".
7. That the natural side serves Whole Foods and Sprouts and the conventional
   side serves Cub and Shoppers. No source assigns retailers to sides. Cub and
   Shoppers appear only in DSD billback code descriptions.
8. That MCB documents name each chargeback in the MCB deduction. No checked
   source says so.
9. That the 24-month post-audit right comes from UNFI's Supplier Policies, and
   that post-audits arrive under SAS or PRGX. Glimpse states the 24 months
   without attributing it there; no source links it to SAS or PRGX.
10. That compliance disputes are evidenced by scorecard data, and spoils by DC
    records. No checked source names either.
11. That the $40,000 and $80,000 small-dollar findings were UNFI's alone. They
    are KeHE and UNFI combined.
12. That UNFI sends EDI 812s. No source says so.
13. That UNFI sends EDI 820s with deduction detail, stated as fact. Only EDI
    vendors say so, one calls it optional, and the reason-code mapping is
    undocumented.
14. Endlesscommerce's numeric code families (01 shortages, 02 pricing, 05
    unsaleables, 10–12 advertising, MCB and OI, 30+ compliance). Not
    corroborated anywhere.
15. OverDeduct's labels "W&M FINE", "ASN COMPLIANCE", "ROUTING FINE" and
    "LABEL FINE" as UNFI codes. Not corroborated.
16. A 90-day dispute window. It appeared in one search summary and could not
    be traced to a source.
17. That the Supplier Terms require **prior** written consent before
    disclosure to a third party. "Written consent" is in the excerpt; "prior"
    is not confirmed.
18. "2% within 10 days" as UNFI's standard terms. That is Confido's
    simplification; Glimpse gives the fuller terms (C17).
19. Promomash's and Vividly's MCB descriptions as statements about UNFI.
    Neither names UNFI.
20. Glimpse's count of 446 codes in 55 categories, as a fact about the key.
    It is Glimpse's figure, unverified.

Four more are inferences, not facts, and should be cited as inferences:

- that the Dispute Center is hosted at `my.directcommerce.com` (from the SAML
  EntityId);
- that the help centre's "UNFI Supplier Portal" is `suppliers.unfi.com`;
- that myUNFI self-serve access needs existing legacy credentials (from the
  enrollment flow);
- that SAS deductions are raised by SAS Recovery (from the email domain).

## Still unknown

These are for the walk-through (ADR 0058, Decision §11) or for real
documents:

- **The full terms.** The full text of the myUNFI Terms of Use, UNFI's site
  Terms of Use and the Supplier Terms. Whether any terms mention automated
  access by name. Whether the confidentiality clause excepts agents or service
  providers. The Dispute Center's own terms (Direct Commerce's), which were
  never located, and its user model. A review reported archived copies of the
  first three on the Wayback Machine, dated 2025-03-28, 2026-07-18 and
  2026-07-20. They were not opened here, and the archive refused requests
  when this was checked. The founder can read them for ADR 0058, Decision §2:
  - https://web.archive.org/web/20250328/https://www.unfi.com/myunfi/terms-of-use.html
  - https://web.archive.org/web/20260718/https://www.unfi.com/privacy/terms.html
  - https://web.archive.org/web/20260720/https://www.unfi.com/supplier-terms.html
- **The Dispute Center's export format**, and the Natural Supplier Portal's
  current features and future.
- **MFA** on each system, whether used and of what kind.
- **EDI**: whether UNFI sends 820s today, to whom, and whether it sends 812s
  at all.
- **The code sets**: the contents of the Supplier Deduction Key, the
  Conventional Transaction Key and the two FAQ PDFs.
- **The dispute window**: which one applies on the conventional side (18
  months or 12), and what the natural 12 months count from.
- **Fees**: whether the SVHarbor per-user fee is still charged, and current
  amounts for spoils, fair share, service-level, overship, recall, placard,
  barcode and DCE fees.
- **Whether the support site is still live** (one result said "Help Center
  Closed").
- **Backup**: how long it is kept on the natural side, and how SharePoint
  links are shared.
- **Recovery rates**: any neutral figure for the share of UNFI deductions that
  are invalid.

## Sources

[myunfi-dash]: https://www.myunfi.com/supplier-dashboard
[myunfi-bundle]: https://www.myunfi.com/supplier-dashboard/assets/index-B450dmki.js
[myunfi-root]: https://www.myunfi.com/
[myunfi-login]: https://www.myunfi.com/api/authenticate/login
[myunfi-robots]: https://www.myunfi.com/robots.txt
[myunfi-enroll]: https://www.myunfi.com/enroll/signup
[myunfi-enroll-bundle]: https://www.myunfi.com/enroll/assets/index-DWLpLp4q.js
[myunfi-tou]: https://www.unfi.com/myunfi/terms-of-use.html
[myunfi-tou-2]: https://www.unfi.com/myunfi/terms-of-use
[unfi-site-tou]: https://www.unfi.com/privacy/terms.html
[unfi-terms]: https://www.unfi.com/supplier-terms.html
[unfi-robots]: https://www.unfi.com/robots.txt
[dc-robots]: https://my.directcommerce.com/robots.txt
[unfi-coc]: https://www.unfi.com/content/dam/unfi-corporate/footer/Supplier%20Code%20of%20Conduct_English.pdf
[suppliers-login]: https://suppliers.unfi.com/Account/Login
[suppliers-robots]: https://suppliers.unfi.com/robots.txt
[dci-zendesk]: https://dciunfi.zendesk.com/hc/en-us
[svh-epass]: https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-applications/epass.html
[svh-epass-home]: https://epass.svharbor.com/epass/home
[svh-apps]: https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-applications.html
[svh-emerch]: https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-applications/emerchandising.html
[svh-info]: https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-information.html
[svh-faq]: https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-information/faqs.html
[svh-terms]: https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-information/terms-and-conditions/termsndconditionpage.html
[svh-edi]: https://myhome.svharbor.com/content/svpublic/trading-partners/edi.html
[zd-add-user]: https://unfinc.zendesk.com/hc/en-us/articles/360016435173-VIDEO-Adding-User-to-Supplier-Group
[zd-manager]: https://unfinc.zendesk.com/hc/en-us/articles/360008792994-UNFI-Supplier-Portal-User-Guide-Manager
[zd-deductions]: https://unfinc.zendesk.com/hc/en-us/sections/206791827-Deductions
[zd-backup]: https://unfinc.zendesk.com/hc/en-us/articles/14439343198227-Natural-Deduction-Backup-Requests
[slideplayer]: https://slideplayer.com/slide/14457713/
[sps-dc]: https://www.spscommerce.com/community/articles/how-to-submit-and-appeal-a-deduction-dispute-in-unfis-dispute-center
[sps-natural]: https://www.spscommerce.com/community/articles/how-natural-suppliers-dispute-unfi-deductions
[sps-conv]: https://www.spscommerce.com/community/articles/how-conventional-suppliers-dispute-unfi-deductions
[sps-rr]: https://www.spscommerce.com/products/revenue-recovery/unfi/
[supplypike-eco]: https://help.supplypike.com/en/articles/15926163-unfi-s-deduction-ecosystem
[supplypike-types]: https://help.supplypike.com/en/articles/14992828-unfi-deduction-types
[glimpse-dispute]: https://www.tryglimpse.com/post/how-to-dispute-unfi-deductions
[glimpse-kehe]: https://www.tryglimpse.com/post/unfi-kehe-supplier-deductions
[crisp-press]: https://ir.unfi.com/news/press-release-details/2023/United-Natural-Foods-and-Crisp-Unveil-New-Platform-Giving-Consumer-Packaged-Goods-Companies-Enhanced-Access-to-Retail-Insights/default.aspx
[crisp-open]: https://docs.gocrisp.com/docs/support/articles-Reviewing-open-UNFI-invoices
[crisp-codes]: https://docs.gocrisp.com/docs/support/articles-UNFI-chargeback-codes
[crisp-blog]: https://www.gocrisp.com/blog/unfi-insights
[confido-cash]: https://www.confidotech.com/resources/a-complete-guide-to-unfi-cash-application-and-deductions
[confido-blog]: https://www.confidotech.com/blogs/manage-deductions-and-disputes-for-unfi
[remitparse]: https://remitparse.com/blog/unfi-deduction-codes-explained
[crstl]: https://www.crstl.ai/blog/unfi-edi-requirements
[endless-edi]: https://endlesscommerce.com/edi/requirements/unfi/
[endless-playbook]: https://endlesscommerce.com/playbook/kehe-and-unfi-deductions-codes-and-clocks/
[infocon]: https://www.infoconn.com/edi/partners/Unfi.htm
[inymbus]: https://blog.inymbus.com/unfi-deduction-disputes-common-issues
[sec-farmer]: https://sec.gov/Archives/edgar/data/1979484/000110465924044421/tm2326271d17_ex10-15.htm
[sec-wfm]: https://www.sec.gov/Archives/edgar/data/865436/000086543616000252/wfmq12016ex101.htm
[grocerynerd]: https://grocerynerd.substack.com/p/grocery-update20-retailer-and-wholesaler
[promomash-instore]: https://www.promomash.com/blog/in-store-promotions-for-cpg-brands
[promomash-ssa]: https://www.promomash.com/blog/unfi-ssa-deduction-change-2026
[promomash-warning]: https://www.promomash.com/blog/why-a-high-deduction-recovery-rate-is-a-warning-sign-not-a-win
[sprouts]: https://about.sprouts.com/vendor-policies-2/
[sh-2021]: https://static1.squarespace.com/static/5581a7cbe4b0f48ec46afcdd/t/6077bb64e9b8d92c7a6db9df/1618459494976/SOP+Logistics_Shipping++Handling_03.12.2021.pdf
[pmidpi]: https://www.pmidpi.com/blog/newsletter/unfi-operational-non-compliance-fees/
[beerinsights]: https://beerinsights.com/archive-article/51640
[scd-classaction]: https://www.supplychaindive.com/news/unfi-class-action-lawsuit-payment-discounts-grocery-natural-foods/732231/
[scd-omaha]: https://www.supplychaindive.com/news/omaha-sues-grocery-distributor-unfi-chargebacks-giant-food/704810/
[acru]: https://www.acru.solutions/news/project-one-8rnlj-5y69a-w3trx-zesr4-6s3rg-jw8hp-sb454-fd554-6wj3d-r7gx4-24xdd-n8hct-6zcp7-n3sbx-axdzx-exn8l-my992-jxngs-nwbws-a228c-84n87-2g9hm-bfd2n-jnand-s4y6g-clwhz
[overdeduct-compliance]: https://www.overdeduct.com/deductions/unfi/codes/compliance-fines
[overdeduct-pricing]: https://www.overdeduct.com/deductions/unfi/pricing
[overdeduct-howto]: https://www.overdeduct.com/distributors/unfi/how-to-dispute
[vividly]: https://www.govividly.com/blog/deductions-management-tip-no-1-mcb

| Label | Address |
| --- | --- |
| myunfi-dash | https://www.myunfi.com/supplier-dashboard |
| myunfi-bundle | https://www.myunfi.com/supplier-dashboard/assets/index-B450dmki.js |
| myunfi-root | https://www.myunfi.com/ |
| myunfi-login | https://www.myunfi.com/api/authenticate/login |
| myunfi-robots | https://www.myunfi.com/robots.txt |
| myunfi-enroll | https://www.myunfi.com/enroll/signup |
| myunfi-enroll-bundle | https://www.myunfi.com/enroll/assets/index-DWLpLp4q.js |
| myunfi-tou | https://www.unfi.com/myunfi/terms-of-use.html |
| myunfi-tou-2 | https://www.unfi.com/myunfi/terms-of-use |
| unfi-site-tou | https://www.unfi.com/privacy/terms.html |
| unfi-terms | https://www.unfi.com/supplier-terms.html |
| unfi-robots | https://www.unfi.com/robots.txt |
| dc-robots | https://my.directcommerce.com/robots.txt |
| unfi-coc | https://www.unfi.com/content/dam/unfi-corporate/footer/Supplier%20Code%20of%20Conduct_English.pdf |
| suppliers-login | https://suppliers.unfi.com/Account/Login |
| suppliers-robots | https://suppliers.unfi.com/robots.txt |
| dci-zendesk | https://dciunfi.zendesk.com/hc/en-us |
| svh-epass | https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-applications/epass.html |
| svh-epass-home | https://epass.svharbor.com/epass/home |
| svh-apps | https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-applications.html |
| svh-emerch | https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-applications/emerchandising.html |
| svh-info | https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-information.html |
| svh-faq | https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-information/faqs.html |
| svh-terms | https://myhome.svharbor.com/content/svpublic/trading-partners/svharbor-information/terms-and-conditions/termsndconditionpage.html |
| svh-edi | https://myhome.svharbor.com/content/svpublic/trading-partners/edi.html |
| zd-add-user | https://unfinc.zendesk.com/hc/en-us/articles/360016435173-VIDEO-Adding-User-to-Supplier-Group |
| zd-manager | https://unfinc.zendesk.com/hc/en-us/articles/360008792994-UNFI-Supplier-Portal-User-Guide-Manager |
| zd-deductions | https://unfinc.zendesk.com/hc/en-us/sections/206791827-Deductions |
| zd-backup | https://unfinc.zendesk.com/hc/en-us/articles/14439343198227-Natural-Deduction-Backup-Requests |
| slideplayer | https://slideplayer.com/slide/14457713/ |
| sps-dc | https://www.spscommerce.com/community/articles/how-to-submit-and-appeal-a-deduction-dispute-in-unfis-dispute-center |
| sps-natural | https://www.spscommerce.com/community/articles/how-natural-suppliers-dispute-unfi-deductions |
| sps-conv | https://www.spscommerce.com/community/articles/how-conventional-suppliers-dispute-unfi-deductions |
| sps-rr | https://www.spscommerce.com/products/revenue-recovery/unfi/ |
| supplypike-eco | https://help.supplypike.com/en/articles/15926163-unfi-s-deduction-ecosystem |
| supplypike-types | https://help.supplypike.com/en/articles/14992828-unfi-deduction-types |
| glimpse-dispute | https://www.tryglimpse.com/post/how-to-dispute-unfi-deductions |
| glimpse-kehe | https://www.tryglimpse.com/post/unfi-kehe-supplier-deductions |
| crisp-press | https://ir.unfi.com/news/press-release-details/2023/United-Natural-Foods-and-Crisp-Unveil-New-Platform-Giving-Consumer-Packaged-Goods-Companies-Enhanced-Access-to-Retail-Insights/default.aspx |
| crisp-open | https://docs.gocrisp.com/docs/support/articles-Reviewing-open-UNFI-invoices |
| crisp-codes | https://docs.gocrisp.com/docs/support/articles-UNFI-chargeback-codes |
| crisp-blog | https://www.gocrisp.com/blog/unfi-insights |
| confido-cash | https://www.confidotech.com/resources/a-complete-guide-to-unfi-cash-application-and-deductions |
| confido-blog | https://www.confidotech.com/blogs/manage-deductions-and-disputes-for-unfi |
| remitparse | https://remitparse.com/blog/unfi-deduction-codes-explained |
| crstl | https://www.crstl.ai/blog/unfi-edi-requirements |
| endless-edi | https://endlesscommerce.com/edi/requirements/unfi/ |
| endless-playbook | https://endlesscommerce.com/playbook/kehe-and-unfi-deductions-codes-and-clocks/ |
| infocon | https://www.infoconn.com/edi/partners/Unfi.htm |
| inymbus | https://blog.inymbus.com/unfi-deduction-disputes-common-issues |
| sec-farmer | https://sec.gov/Archives/edgar/data/1979484/000110465924044421/tm2326271d17_ex10-15.htm |
| sec-wfm | https://www.sec.gov/Archives/edgar/data/865436/000086543616000252/wfmq12016ex101.htm |
| grocerynerd | https://grocerynerd.substack.com/p/grocery-update20-retailer-and-wholesaler |
| promomash-instore | https://www.promomash.com/blog/in-store-promotions-for-cpg-brands |
| promomash-ssa | https://www.promomash.com/blog/unfi-ssa-deduction-change-2026 |
| promomash-warning | https://www.promomash.com/blog/why-a-high-deduction-recovery-rate-is-a-warning-sign-not-a-win |
| sprouts | https://about.sprouts.com/vendor-policies-2/ |
| sh-2021 | https://static1.squarespace.com/static/5581a7cbe4b0f48ec46afcdd/t/6077bb64e9b8d92c7a6db9df/1618459494976/SOP+Logistics_Shipping++Handling_03.12.2021.pdf |
| pmidpi | https://www.pmidpi.com/blog/newsletter/unfi-operational-non-compliance-fees/ |
| beerinsights | https://beerinsights.com/archive-article/51640 |
| scd-classaction | https://www.supplychaindive.com/news/unfi-class-action-lawsuit-payment-discounts-grocery-natural-foods/732231/ |
| scd-omaha | https://www.supplychaindive.com/news/omaha-sues-grocery-distributor-unfi-chargebacks-giant-food/704810/ |
| acru | https://www.acru.solutions/news/project-one-8rnlj-5y69a-w3trx-zesr4-6s3rg-jw8hp-sb454-fd554-6wj3d-r7gx4-24xdd-n8hct-6zcp7-n3sbx-axdzx-exn8l-my992-jxngs-nwbws-a228c-84n87-2g9hm-bfd2n-jnand-s4y6g-clwhz |
| overdeduct-compliance | https://www.overdeduct.com/deductions/unfi/codes/compliance-fines |
| overdeduct-pricing | https://www.overdeduct.com/deductions/unfi/pricing |
| overdeduct-howto | https://www.overdeduct.com/distributors/unfi/how-to-dispute |
| vividly | https://www.govividly.com/blog/deductions-management-tip-no-1-mcb |
