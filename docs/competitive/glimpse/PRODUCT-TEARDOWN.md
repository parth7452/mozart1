# Glimpse, capability by capability: what is public, read on 2026-10-04

A teardown of what Glimpse's product does, rebuilt only from pages anyone can
open: its marketing site, blog, customer stories, the third-party copies of
its job posts, and its investors' announcements. Nothing past a sign-in was
touched and no credential was used. `README.md` in this folder has the
company, pricing, contract and stack; this file is the product.

How to read it:

- **"Company-reported"** means the only source is Glimpse saying so. Every
  number in this file is company-reported unless a customer is quoted.
- A page shows what Glimpse *says* the product does. It does not show how.
  Where a row would need their internals, it says "not public".
- Pages were read through a fetch tool that returns a model's reading of the
  page (a direct download is not permitted from this environment). Quoted
  sentences came back as quotations; check them against the URL before
  repeating one to a customer.
- Glimpse's own blog list dates posts to the month. Several page titles carry
  a later month than the list does, so a date here is "per the resources
  list".

Short URLs below are on `https://www.tryglimpse.com`.

## 1. The shape of the product

Four steps, the same on every channel page (`/product`, `/channel/*`):

1. **Retrieve.** "Glimpse pulls deduction documents, automatically", from
   "every retailer portal and inbox": "invoices, PODs, BOLs, remittance files,
   and records".
2. **Validate.** "AI agents check every deduction, and Glimpse's human experts
   check the edge cases."
3. **Dispute.** "Glimpse files disputes before the retailer windows close."
4. **Recover.** "Recovered dollars are applied automatically and reflected in
   your ERP."

Four named modules (homepage): Deductions Management, Revenue Recovery, Cash
Application, Deduction Itemization. Two agents named on the homepage's mock
UI, a Retrieval Agent ("Pulling from all sources") and a Validation Agent
("Validating all transactions"); two more named in posts, a Shortage Agent and
a Promo Agent.

The only screen text that is public is the homepage's mock dashboard: a
deduction card reading "DISPUTE WON", "Dispute amount $6,103.41", "Customer
KeHE", "Status REPAYMENT APPROVED", and four totals: "Deductions disputed",
"Repayments approved", "Deductions validated", "Total amount of deductions
analyzed". One navigation item is public: "Navigate to Connectors in your
dashboard" (`/post/meet-glimpse-connectors`). No other screen, column or
button is shown anywhere public.

**It is a managed service, in their own words.** "Glimpse is a fully managed
service built on AI: agents handle classification, documentation retrieval,
and routing automatically, while human experts review and file every dispute
before the window closes" (`/post/petsmart-vendor-deductions-cpg-guide`, FAQ).
"Most customers spend under an hour per week in Glimpse" (`/product`, FAQ).

## 2. Capability table

Priority is for the Frazil pilot only: **P0** the Oct 14 call or the first
week needs it; **P1** the first month; **P2** not for this pilot.
"No-migration" means a read-time computation or a document; "migration" means
a schema change, which needs an ADR first and the founder's apply.

| # | Capability | Glimpse (evidence, URL) | recouple today (file / ADR) | Gap | Suggested next step | Frazil |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Everything grouped per retailer or distributor | Channel pages per vertical; mock card shows "Customer KeHE"; cash application shows "aging by retailer" (`/cash-application`) | The case list opens with a board per payer: open and closed cases, dollars in dispute, recovered, due soon (`PostgresStore.retailerBoard`, `components/retailer-board.tsx`, CLAUDE.md "The case list opens with a board per retailer or distributor") | None in shape. Ours shows dollars and no rate, on purpose (ADR 0030) | None | P0, done |
| 2 | Portal retrieval ("Connectors") | Setup: "Log in to your Glimpse account / Navigate to Connectors in your dashboard / Select the retailers you want to connect with / Authenticate with your retailer portal credentials". Live Aug 2025: "Amazon 1P, KeHe, Target, and UNFI"; Walmart and Sam's Club followed (`/post/meet-glimpse-connectors`, `/post/introducing-the-walmart-and-sams-club-connector`). Pulls "line-item data" and "backup documentation to every deduction". Calyan: "pulls deductions daily" (`/customer-story/calyan-wax-co`). 2FA handling, sync schedule and automation tool: not public | A read-only portal engine with a request guard, tested only against a local fixture portal; no live portal, no credentials (`packages/portal`, ADR 0057, 0062, 0064). UNFI and SAP Business Network are both paused | We have no live connector. They have at least six, and none is for a payer Frazil is likely to have (§4) | Do not build a connector for the pilot. Ask what Frazil's payers send and take exports by upload or email. No-migration | P2 |
| 3 | Credential hand-off vs delegated user | Credential hand-off. The customer types its own portal password into Glimpse (row 2); the contract says access is by "access credentials or other means provided by or on behalf of Customer" (CSA, README §3). A delegated or read-only portal user is never mentioned on any page | Policy only: credentials belong in KMS-backed storage, never an application table, and a failure degrades to upload (CLAUDE.md "Build order"). The KMS envelope exists for QuickBooks tokens (`packages/crypto`, ADR 0033) | We have not decided which we ask a customer for | Founder decision. Our read-only guard makes "a separate read-only portal user" a claim we can make and they do not | P1 (a question for the call, not a build) |
| 4 | Inbox retrieval | "ingests deduction details straight from inboxes and retailer portals" (`/post/how-glimpse-empowers-you-to-manage-more-deductions-without-headcount-creep`); Bero: "email communications, distributor portals like KeHE, and retailer feeds including Amazon" | Live. An address per workspace; every emailed notice or remittance is held for a person (`apps/web/app/api/inbound/postmark`, ADR 0047) | Ours holds every email for a click; theirs is described as automatic | None before the pilot. The hold is the safety and costs one click | P0, done |
| 5 | EDI | a16z: "ingests deduction claims from every source — retailer portals, EDI, email, PDFs" (a16z.com/announcement/investing-in-glimpse, 2026-03-25); "your EDI feeds" (`/channel/grocery`, FAQ). Which transaction sets: not public | Not built. One fixture, a printed EDI 812 (`packages/fixtures/src/formats.ts`); phase 2.5 in the build order | Full gap | Ask Frazil whether its distributors send 812/820 and through which EDI provider. If its provider can export them as files, upload covers it. Migration only if a new arrival channel is added | P1 (question first) |
| 6 | File types read | "PDFs, Excel files, and HTML" (`/post/glimpse-ai-disputing-agents`) | PDF, images, TIFF, HEIC, email bodies, CSV/TSV/XLSX through a person-confirmed column mapping, portal HTML snapshots (`packages/ingest`, ADR 0054, 0056, 0016) | None | None | P0, done |
| 7 | Classification by type, SKU and reason | "automatically classifies every deduction by type, SKU, and reason — even mapping general ledger and promo codes" (headcount post) | The payer's code is kept as printed and shown on the case (`payer-terms.ts`); the canonical taxonomy exists (`reason-codes.ts`); **no payer-code to canonical map** (Phase 2 task 04, draft ADR D) | A reviewer picks the canonical reason by hand on every case | A code map for Frazil's two or three real payers, as effective-dated data in `core-domain` on ADR 0059's pattern, shown as a suggestion the reviewer confirms. No-migration, but it needs an ADR and the customer's real codes | P1 |
| 8 | GL coding of each deduction | "classifies every deduction and syncs it back to the general ledger codes in your accounting system" (`/post/why-every-brand-needs-...`); Table 87: "Organized deduction codes into a chart of accounts" | One account map per connection, for posting; draft entries per case shown "Draft — not posted" (`draftEntries`, ADR 0060, 0063). No account per reason | We do not code a deduction to a GL account by reason | Wait for Frazil's chart (`/books` reads it, ADR 0066) and ask how they code deductions today. Per-reason accounts change `ledger_account_maps`: migration | P2 |
| 9 | Matching backup to a deduction | "Fetching and attaching backup documentation to every deduction" (connectors post); "match backup documentation" (Product Operations post, README §2) | A read document suggests its case by identifier, exact or probable; a person presses Attach; nothing links by itself (`core-domain/document-match.ts`, CLAUDE.md "A read document suggests the case it belongs to") | Theirs is automatic; ours is one click each | Founder decision already open: may an exact, unique match attach by itself. No-migration either way | P1 |
| 10 | Shortage validation (Shortage Agent) | "automatically retrieved fulfillment documentation, validated each shortage claim against the shipment record" (`/customer-story/evermark`); "17,000 shortage deductions" in "24 hours", "a 12-month lookback across Evermark's two largest retail channels", "trained on distributor- and retailer-specific rules" (`/customer-story/how-glimpses-shortage-agent-uncovered-7-figures-for-evermark`). Inputs per README §2: "freight, shipping, and delivery data". Company-reported; the matching rule is not public | Cross-document findings on a case: quantities, PO price, delivery and appointment, a written waiver (`packages/pipeline` `reconcileCase`, ADR 0040, 0049); an evidence checklist per reason (ADR 0059). A person decides (ADR 0020). No model recommendation (Phase 2, not started) | We show findings; we do not say "invalid" | Nothing to build before the call. A frozen-beverage mix on a distributor truck makes shortage and damage the likely claims, so the PoD/BoL findings are the ones to demo | P0 to demo, P1 to extend |
| 11 | Promo validation (Promo Agent) | Deduction against "approved promotional calendar and underlying deal data" (README §2); "validates each against your vendor agreement and signed promotional calendar. Valid promotional deductions are approved; deductions that don't match an authorized promotion or that exceed contracted rates are flagged" (PetSmart guide FAQ) | A price agreement is a document type we read. No promo calendar, no deal table, no check of a promo deduction against one | Full gap | Ask whether Frazil's distributor deductions include promotions or billbacks (the Free Frazil Friday redemptions are a candidate, §4). If yes, take the deal sheet as a spreadsheet (ADR 0056) and compare by hand first. A deal table is a migration | P1 (question first) |
| 12 | Deduction itemization | "available for KeHE and UNFI specifically" (`/channel/natural-channel`); "Extracts details from backup documentation into structured formats for broker commissions, profitability analysis, and trade analytics" (`/post/glimpse-10x-2025`) | A remittance opens one case per short-paid line; a dense one is read in page ranges, off in the app (ADR 0028, 0048, 0053) | We itemize to cases, not to a SKU-level export | None for this pilot: neither payer is Frazil's | P2 |
| 13 | Dispute-window tracking | "files disputes before the retailer windows close"; "monitors every open deduction against its creation date and files before the deadline" (PetSmart FAQ); "revenue at risk from approaching dispute windows" (Product Operations post) | A deadline exists only when the page prints one (`parsePrintedDate`, ADR 0019); the queue's buckets and the board's "due soon" use it; a case with none is ordered by age (ADR 0043) | A payer's rule ("90 days from the payment due date") is never applied, so most cases have no deadline | Deadline rules as effective-dated data in `core-domain` (ADR 0059's pattern), computed at read time and labelled "by rule, not printed", one payer at a time after the customer confirms the rule. No-migration; needs an ADR | **P0** |
| 14 | Dispute packet | "assembles all the necessary documentation" (`/post/why-every-brand-needs-...`); "a written dispute letter" is on Glimpse's own list of what Chewy needs. What a Glimpse packet looks like: not public | Packet with a letter that states the payer's code, numbered findings, the checklist and each enclosure's SHA-256, hash-chained (`packages/packets`, CLAUDE.md "The dispute letter says why") | None. This is where we are ahead (row 24) | For an email channel, check the letter carries every field the payer asks for in the body (McLane's list is in `docs/onboarding/leads/frazil.md`). No-migration | P0 |
| 15 | Review and approval | "You can review, approve, or adjust disputes, as well as add notes and track every step in one place" (`/post/glimpse-ai-disputing-agents`); "Human experts review every case before submission"; customers describe disputes leaving without them (README §2) | A second person must approve; the database refuses otherwise (invariant 1, ADR 0041). No free-text note on a case | Theirs is optional review by the customer; ours is a required second approver. No notes | For a two-person finance team, decide who the second approver is before the call (founder as approver in a done-with-you pilot is the obvious answer; it is the founder's to give). Notes: an event type, no-migration | **P0** (decision), P1 (notes) |
| 16 | Filing the dispute | Glimpse's people file. "Our expert initiates the dispute process for all invalid deductions, including the first email to the distributor and all the follow-ups" (`/post/meet-the-human-experts-...`); the Deduction Analyst will "Prepare, submit, and manage deduction disputes through retailer portals" (README §2); routing per payer: "compliance deductions go through the AI-DM portal, shortage and damage claims go to proofofdelivery@petsmart.com" | A person files and records the confirmation number. Recipe filing on a portal is accepted and not built (ADR 0061). Nothing of ours sends an email to a payer | They do the filing; our customer does | Done-with-you: Frazil (or the founder, with Frazil's say-so) sends the packet from Frazil's own mailbox. No build | P0, by hand |
| 17 | Follow-up and re-dispute | "keep pinging until every dollar is back in your pocket"; "reviews the denial reason and determines whether the claim is eligible for redispute" (PetSmart FAQ); Walmart "refiled up to 3 times" | `lost` is terminal; denial reason and re-file are not built (STRATEGY ADD-5) | Full gap | Record a denial's reason in the outcome's text for now; the re-file transition changes the state table (ADR, migration) | P1 |
| 18 | Outcome and repayment tracking | Mock UI: "DISPUTE WON", "REPAYMENT APPROVED"; UNFI "Repayment posting ... 7–10 business days" (UNFI guide) | Outcome recorded with the recovered amount; the board sums it (`recordOutcome`) | They show approved and repaid as two states; we record one outcome | None before the pilot | P2 |
| 19 | Cash application | "95%+ Auto-Match Rate" and, on the same page, "96% accuracy"; "automatically applies straightforward matches across invoices, payments, and credits"; "exceptions are routed into clear review flows"; "prepare records for clean posting into your ERP"; "open balances, applied cash, credits, and aging by retailer" (`/cash-application`). Calyan's accountant: "It comes in nicely into my bank feed in QuickBooks, and I just click match". What counts as a match: not public | QuickBooks is read daily and a short-paid invoice opens a case (ADR 0026, 0031, 0035, 0036); `/books` reconciles ledger postings to cases (ADR 0066); write-back is built, gated and off (ADR 0060). We apply no cash | Full gap on applying cash | Not for this pilot. Turning posting on is the founder's switch and a one-way door | P2 |
| 20 | Credit memos | "Credit memo automation" (`/supplypike-vs-glimpse`); Pickerfresh: "Automatic credit memo generation flowing into QuickBooks"; a paid add-on per a third-party listing (README §3) | Draft journal entries, not posted (`draftEntries`) | Same as row 19 | Same | P2 |
| 21 | Accounting systems | QuickBooks and NetSuite, "one-time, read-first setup"; "If you're on something less common, our team will confirm compatibility during onboarding" (`/integrations`) | QuickBooks Online only. NetSuite and Xero are on the do-not-build list until after QBO (CLAUDE.md "Build order") | If Frazil runs NetSuite, the ledger leg does not exist for it | **Ask before the call.** If not QuickBooks Online: run the pilot on documents (upload, email, spreadsheet export of open AR) and say so plainly | **P0** (question) |
| 22 | Notifications to the customer | Calyan: "weekly email updates from his account manager"; Belcam: "every two to three weeks we get an email from the team saying we got another win"; "proactive alerts" (headcount post); "Your team is notified of denial outcomes and redispute decisions" (PetSmart FAQ). The emails read as written by people | None to a customer. An operator alert when a job fails (ADR 0052) and the invitation email (ADR 0065) | Full gap | The founder writes a weekly note from the payer board for the pilot. A product email is a new outbound side effect: ADR first | P1, by hand |
| 23 | Reporting | "Real-time dashboards"; "trend data by deduction category ... a spike in shortage claims from a specific DC" (PetSmart FAQ); "Retailer and broker profitability view", "SKU level itemization" (`/supplypike-vs-glimpse`); "Days Deductions Outstanding (DDO)" (`/post/why-ai-native-...`); "Trade Analytics" (`/post/glimpses-roadmap-...`) | The payer board, `/coverage` (found against filed, per channel), `/books` | No view by reason, SKU or ship-to | A count and dollars by reason code as printed, per payer: one read, no-migration | P1 |
| 24 | Proof of a number | Stated as an open problem: "Help define how Glimpse proves AI-driven outputs to customers and auditors" (FDE post, README §2). The public claim is "a paper trail for every single deduction" | Every field carries the quote it was read from, checked against the page; an amount is verified only when printed whole (ADR 0050); append-only, hash-chained packets | Ours is built; theirs is a hiring goal | Show it on the call: a case, a field, its quote on the page | P0, done |
| 25 | Historic audit / backlog | "Glimpse disputes historical and live deduction data" (homepage); "a multi-month audit of your historic deductions" (`/contact`, README §4); "works through aged claims in parallel, focusing first on those still within the dispute window" | Any document can be uploaded. The ledger sync reads a trailing 35 days (`LEDGER_SYNC_WINDOW_DAYS`, `packages/pipeline/src/ledger-job.ts`); `/books` reads up to 186 days | No one-off backfill of a year of ledger history | For the pilot, ask Frazil for an export of open deductions and take it as a spreadsheet (ADR 0056). A longer first sync is a constant and an ADR-worthy cost question, no migration | P1 |
| 26 | Sub-threshold deductions | "Capture sub-threshold deductions" (homepage) | A remittance line under the tenant's tolerance becomes a declined candidate with its dollars, not a case (ADR 0028) | None in data. STRATEGY §3.1's argument now has to be made on cost per case (README §7) | None | P2 |
| 27 | Working beside a broker or 3PL | "complements the work your broker or 3PL is already doing" (`/channel/grocery`, FAQ); partnership with PLTFRM, a sales agency (`/post/glimpse-pltfrm-partnership`) | Multi-tenant by `org_id` and RLS, so an agency can hold many manufacturers | They reach agencies as a sales partner, not as the customer, so README §1's "brokers or agencies as the customer" still stands | None | P2 |
| 28 | Security posture | "SOC 2 Type 1 compliant" and "currently undergoing SOC 2 Type 2 audit" (PetSmart guide); a Vanta trust-center link in the site footer (not opened) | No attestation. RLS on every table, sealed tokens, append-only tables with SQL suites (CLAUDE.md invariants) | A customer's IT may ask for a report we do not have | Have a one-page answer ready: where data lives, who can read it, what is never stored | P1 |

## 3. Onboarding: what they ask for and how long they say it takes

Glimpse publishes six different timelines. All company-reported.

| Claim | Where |
| --- | --- |
| "2-3 Week setup", "< 60 days Time to Value" | `/solutions-hub` |
| "Get Started with Glimpse in 30 Days" | `/cash-application` |
| "On average, 30 days, from signing the contract to sending out the first dispute"; "most brands see their first disputed deductions within the first week" | `/product`, FAQ |
| "Up to 45 days from activation to your first dispute filed" | `/channel/drug-and-convenience`, `/channel/beauty-retail` |
| Today / Day 10 "We build the pipelines" / Day 45 "We identify lost revenue" | homepage, `/integrations` |
| "Most brands see the first validated disputes filed within days of granting Glimpse read access" | `/channel/big-box-retailers`, FAQ |

What a customer actually reports: Calyan's first recovery came 23 days in;
Refresh Gum "could see the difference" "within about a month"; Bero was "up
and running" "after two brief alignment calls". The 45 days is the outside
figure, and it is to the first dispute *filed*, not to money.

The steps, as far as they are public:

1. A scoping call (`/contact`: 45 minutes).
2. The customer hands over portal logins ("One login, low lift") and connects
   QuickBooks or NetSuite. "Our team handles all integrations."
3. Glimpse pulls history and runs the audit; "AI agents start validating
   deductions across retail channels".
4. Disputes go out, "historical and live".
5. One thing a customer had to change: Table 87 moved from signed invoices to
   signed, dated BOLs filed by PO number, because "they pushed us to have the
   BOL".

Ours is `docs/ONBOARDING.md`: a workspace made by hand, people invited, payer
names mapped with `pnpm link:retailer`, the owner's first sign-in on the call.
It has no step for "what do your payers send you and where do you dispute",
which is the step the Frazil call needs; `docs/onboarding/leads/frazil.md` is
that step for one customer.

## 4. What the analysts do by hand

From `/post/meet-the-human-experts-behind-glimpses-91-win-rate` (August 2025),
the Deduction Analyst posting and the PetSmart guide:

- review "all the AI's work", cross-reference it with the documents, and ask
  the customer for more when needed;
- mark each deduction valid or invalid;
- file: "the first email to the distributor and all the follow-ups it takes";
  disputes "through retailer portals";
- handle edge cases ("incorrect early pay discounts, receiving errors, or
  split deductions") and resubmissions;
- look for root causes and advise on trade practice and forecasting;
- "proactively working retailer finance contacts" (Belcam's words);
- their decisions "actively train our AI models".

The 2025 post describes a person reviewing everything. The December 2025 post
says "Brands can now recover thousands of dollars with no human involvement."
The September 2026 PetSmart guide says "Human experts review every case before
submission." These do not agree, and which is true for a given customer is not
public. It is the question README §4 already tells the founder to ask.

## 5. Where their public list and Frazil's channel do not meet

Glimpse names no convenience distributor and no convenience chain as a
connector or in a guide: not McLane, Core-Mark, 7-Eleven, Circle K, Casey's,
Kwik Trip, Maverik, Love's or Pilot. The `/channel/drug-and-convenience` page
is about CVS, Walgreens and Rite Aid. McLane appears once on the whole site,
as a distributor a customer ships through (`/customer-story/refresh-gum`).
Foodservice and K-12 do not appear at all. So for this pilot there is no
Glimpse playbook to copy; the payer facts have to come from Frazil and from
the payers' own supplier pages (`docs/onboarding/leads/frazil.md`).

## 6. What was not found

- Any help centre, FAQ site, changelog or public API documentation.
- Any screenshot of the real application.
- The definition of a "match" in cash application, of a "won" dispute, or of
  the 91% (called a "win rate" on most pages and a "recovery rate" on the
  Walmart guide).
- How portal two-factor prompts are handled, and how often a connector runs.
- Any statement of which deductions the customer must approve.

## Sources (all read 2026-10-04)

Glimpse: `/`, `/product`, `/solutions-hub`, `/integrations`,
`/cash-application`, `/supplypike-vs-glimpse`, `/channel/big-box-retailers`,
`/channel/grocery`, `/channel/drug-and-convenience`, `/channel/beauty-retail`,
`/channel/natural-channel`, `/resources` (five pages of the blog list), and
the posts and customer stories named in the rows above. Returned 404:
`/platform`, `/deduction-management`, `/trial`, `/post/how-glimpse-stacks-up`.
Not opened: the Ashby job board (the fetch needed an approval nobody was
awake to give), the Vanta trust centre, the `/draft/*` pages the solutions hub
links to.

Third party: a16z.com/announcement/investing-in-glimpse (2026-03-25);
theladders.com copy of the Deduction Analyst posting ($80,000 to $95,000, New
York, in person); workatastartup.com/jobs/90607 (Forward Deployed Engineer).
