# Lead: Tarazi Specialty Foods (tarazifoods.com)

*2026-09-30. Public sources, unverified with the lead; marked where inferred.
Update after the call.*

## Who they are

- Tahini (conventional and organic), falafel mix, baking crumbs, garbanzo
  and fava beans; retail (10 oz) and foodservice (25 lb) packs. Chino, CA.
  Founded ~1970; owned by Highwood Farms since 2013.
- Small: LinkedIn 2–10 staff; revenue estimates disagree tenfold ($1M to
  $10–25M). *Inferred:* low single-digit millions. GM Rocco Fiore II; Plant
  Manager Kirsten Tappan.
- Retail: Safeway, Walmart, Publix, Roche Bros, Whole Foods (online), PCC.
  "1,000+ restaurant partners", so a foodservice distributor exists that
  public sources do not name.
- Distributors: UNFI confirmed (item 2575371 on co-op ordering sites). KeHE
  per the founder. Broker: yes, name unknown.
- Stack signals: WordPress/WooCommerce, Microsoft 365. Nothing on ERP, EDI or
  3PL. *Inferred:* QuickBooks and web-EDI (SPS or TrueCommerce) if any.

## What they asked, and what it means for us

| They said | What it probably is | Our answer today |
| --- | --- | --- |
| "How do you deal with logistics?" | Two readings. (a) Freight and delivery deductions: UNFI's `AVL` late fee, `AVNCNS` no-show, `AVR` reschedule, KeHE's freight allowance and non-compliance fees. (b) Who supplies the BOL and POD when a shortage is disputed, since a 3PL or carrier holds them | (a) The logistics suite is exactly this: a late fee refuted by a rate confirmation, an appointment change and a POD (`docs/DEMO.md`). (b) Evidence is attached by upload or email from whoever holds it; we do not connect to a 3PL |
| "We submit to a planner" | UNFI's Promotional Planning in the Supplier Portal (TPRs, MCBs, Hot Sheets), KeHE's Promotions in CONNECT, or the broker's own calendar. The deals submitted there are what MCB billbacks are later checked against | We do not submit deals. We need the planner's export (a deal sheet per promo) as evidence, so an MCB can be checked against the authorised rate, dates and items. Draft D playbooks would hold this as data later; for the pilot it is an attached document |
| "Paystubs" | Remittance stubs: UNFI's direct deposit advice and KeHE's payment detail, emailed with backup as PDFs, zips or Excel | Email-in is live: forward to the workspace address, held for one click. KeHE's Excel backup goes through the spreadsheet door (ADR 0056, built) |

## How UNFI and KeHE deductions reach them

**UNFI (natural side).** myUNFI is the front door; the Natural Supplier
Portal shows posted invoices, payments and deductions; remittances and backup
arrive by email; missing backup from `DeductionsBackup@unfi.com`; weekly MCB
documents by signing up at `supplierdeductiondisputemgmt@unfi.com`; the code
key runs to ~446 codes. Disputes go through the Dispute Center (Direct
Commerce, launched February 2026): 12-month window, one appeal, 35–45 days.
Patterns to expect on their stubs: `(Invoice#)-111` shortage or pricing,
`MCB(yyyymmdd)` West or `UOI(mmyy)` East promo billbacks, `CMQ` quality,
`AVL` late, `LC*` labelling. Full seed list with candidate canonical codes:
`docs/plans/unfi-portal/research.md`.

**KeHE.** KeHE CONNECT Supplier holds orders, items, promotions and K-Solve,
the only dispute channel: 180-day window, ~3-week response, Excel export, and
backup delivered as Excel. Four buckets: KeHE fees (BI allowance, payment
terms, MCB and EP processing fees, ads, non-compliance), unsaleables
(warehouse and store spoils), invoice adjustments (missed allowances, price
discrepancies), retailer pass-through deductions. MCB admin fee cited at 8%
with a per-DC minimum; freight allowance $0.25–0.40/lb; budget about 1% each
for spoils, returns and merchandising. Sources: iNymbus, Intercept and SPS
write-ups, unverified against a real KeHE document.

## Canonical codes their deductions will map to

| Their line | Canonical | Note |
| --- | --- | --- |
| UNFI `-111` shortage | `shortage_quantity` | Backup decides shortage or pricing |
| UNFI `-111` pricing | `price_discrepancy` | |
| `MCB`, `UOI`, KeHE MCB | `promo_allowance_claimed`; `promo_not_agreed` when no deal; `promo_rate_mismatch`; `promo_duplicate_allowance` | Checked against the deal sheet |
| KeHE MCB admin / EP processing fee | `administrative_fee` | |
| Spoils, unsaleables | `return_unsaleable`; `quality_expired_short_dated` | |
| `AVL`, `AVNCNS`, `AVR` | `compliance_late_delivery`, `compliance_appointment_missed` | |
| Fill rate, service level | `compliance_otif` | |
| Freight allowance | `freight_rate_mismatch` | |
| New-item, slotting, free fill | none yet (nearest `new_store_allowance`) | A taxonomy gap for Phase 2 draft D |
| Recall disposal (`29CM`, `PCM`) | none yet | Gap |

## Who the user is

The broker submits promos and knows whether a deal was authorised, but the
short-pay lands in Tarazi's bank and books, and brokers are paid on gross
sales, not recoveries. So the daily user is Tarazi's bookkeeper or GM, with
the broker as the person who can say "that MCB was never ours". Ask on the
call whether the broker runs deduction management today; if so, the broker's
back office may be the analyst and Tarazi the approver.

## Questions for the call

1. Which planner: UNFI Supplier Portal, KeHE CONNECT, or the broker's own?
   Can it export a deal sheet per promotion?
2. Do UNFI stubs and backup arrive by email today, or are they pulled from
   myUNFI? Is anyone signed up for the weekly MCB documents?
3. Which ledger: QuickBooks Online? If not, which?
4. Who is the foodservice distributor, and how do its deductions arrive?
5. Who chases deductions now: nobody, the bookkeeper, or the broker? What
   is the smallest deduction anyone has ever disputed?
6. Roughly how many stubs a month, and how many lines on a big one? (Over
   120 lines needs splitting until paging is on.)
7. Who would approve: the GM, the owner at Highwood Farms, or the controller?

## Fit

Strong. Both distributors are the beachhead's natural-channel pair, the
documents are exactly the shapes P1 builds, the broker relationship is the
multi-tenant case the architecture was designed for, and a small team with
no dedicated deductions person is the "seventy percent never disputed"
customer.
