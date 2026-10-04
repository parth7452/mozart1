# Glimpse (tryglimpse.com): what is public, read on 2026-10-03

A competitor file. Everything here is from Glimpse's own pages, its public
job board, third-party listings and the unauthenticated shell of its app.
Nothing past a sign-in page was touched. Company-reported numbers are marked
as such; `docs/STRATEGY.md` §1–4 and §11 already frame why win rate is the
wrong metric and what Glimpse's packaging implies for ours, and this file does
not repeat that.

## 1. The company

| Fact | Source |
| --- | --- |
| YC S20; pivoted from Airbnb product placements to deductions, product launched April 2024 | TechCrunch 2026-03-25; every job post ("Since launching in April 2024") |
| $52M raised: $10M from 8VC (2025, now called seed), $35M Series A led by a16z (2026-03-25) | tryglimpse.com/post/seriesa, TechCrunch |
| 52 people, NYC, in-person | YC profile |
| "200+ brands", "14x growth in 2025", "scaling to eight figures this year" | Series A post; GTM Engineer job post. Company-reported |
| Named customers: Evermark (Suave, ChapStick, Q-Tips), Miss Jones Baking, Bero, IQBar, Lemon Perfect, Brami, Refresh Gum, Belcam Beauty, Table 87, Calyan Wax, immi, Sauz | Homepage, customer stories, job posts |
| Verticals on the site: natural channel, grocery, drug and convenience, beauty, big box, Amazon 1P, pet | Sitemap `/channel/*`, resources page |
| Not on the site anywhere: foodservice (Sysco, US Foods, PFG, Gordon), brokers or agencies as the customer | Sitemap, integrations page |

## 2. The product, in their words

Three modules plus one: Deductions Management ("Track, validate, and resolve
deductions"), Revenue Recovery, Cash Application ("95%+ auto-match rate"),
and Deduction Itemization ("available for KeHE and UNFI specifically"). Two
named agents: a Shortage Agent (claim vs. "freight, shipping, and delivery
data") and a Promo Agent (deduction vs. "approved promotional calendar and
underlying deal data").

How it connects, per the integrations page: "grant Glimpse access to your
retailer portals. One login, low lift", and a "one-time, read-first setup"
to QuickBooks or NetSuite. Retailers listed: Whole Foods, Meijer, Sephora,
PetSmart, Walgreens, ULTA, BJ's, H-E-B, Kroger, Target, Sam's Club, Walmart,
Amazon 1P. Distributors: UNFI, KeHE. "New connectors ship every month."

The human layer is explicit. The Deduction Analyst posting (2026-08) says the
analyst is "the critical human in the loop", will "Prepare, submit, and manage
deduction disputes through retailer portals", and will "use your final
decisions to actively train our AI models". The Product Operations posting
(2026-09) names the agents' three jobs as they "classify deductions, match
backup documentation, and queue disputes", and tracks "revenue at risk from
approaching dispute windows". The Founding Forward Deployment Engineer posting
(2026-10-01) is about "messy ERPs, undocumented data", and asks the hire to
"Help define how Glimpse proves AI-driven outputs to customers and auditors".
That last sentence is the provenance gap our packets are built around, stated
by them as an open problem.

Customer quotes describe the approval model: "I just get emails telling me
they've already won." The disputing-agents post says "You can review,
approve, or adjust disputes", so review exists in the product, but the small
brands in the case studies describe disputes going out without them.

## 3. Pricing and terms

| Item | What is public | Source |
| --- | --- | --- |
| Listed pricing | $1,000/month platform fee, 10% commission on won disputes, add-ons: automated credit memos from $250/month, new distributor connector $100/distributor/month | toolradar.com listing. Third party, may be stale |
| Investor's description | "low monthly SaaS fee with commissions on successful disputes" | 8VC |
| Trial default | 30 days when the Order names none, "solely for Customer's internal evaluation" | Cloud Services Agreement |
| Credentials | Customer authorizes access to "Connected Data Sources using the access credentials or other means provided by or on behalf of Customer" | CSA |
| Data rights | Broad license on Customer Data; CDS Data may be used to "create, maintain, and update the Customer Model"; customer may not use Output "to develop, enhance or fine-tune artificial intelligence models" | CSA |
| Filing authority | No clause in the CSA authorizes Glimpse to file disputes for the customer; it must sit in the Order or SOW | CSA (absence) |
| Term | One year, auto-renews, 30 days' notice; renewal at then-current rates | CSA |
| Liability | 12 months' fees; trial and beta liability capped at $50 | CSA |
| Guarantee | "We'll find it, or give you $10K", only for brands with $100M retail revenue across Walmart, KeHE or UNFI and $1M in shortage deductions, no other vendor, not in a settlement program | tryglimpse.com/glimpse-guarantee |

Nothing public says what a "won dispute" is for commission purposes, when
commission is due, or whether a later reversal claws it back. That is the
question to ask on a call.

## 4. Taking the audit as a prospect (step 2 of the plan)

The `/audit` and `/deduction-trial` pages are gone (404; `/free-audit`
redirects to `/audit`). The front door is now `/contact`: a "45-minute scoping
call", then "We plan a multi-month audit of your historic deductions", then
"You get a report on how much you could recover". The page embeds no form of
its own; it loads Default.com's SDK, which routes inbound to a calendar.

Booking that call is the founder's to do, as themselves. What to bring and
what to ask:

1. **What they want from a brand before the audit.** Portal credentials or a
   delegated portal user, remittance exports, ERP read access, or files. The
   CSA says credentials; the case studies say "connected directly to UNFI and
   KeHE portals". Ask whether a read-only portal user is enough.
2. **What a "won dispute" is for the 10%.** Approved by the payer, or cash
   received. And whether a payer's own reversal with no dispute filed counts.
3. **Who presses submit.** Whether a dispute leaves without the brand's
   approval, who at Glimpse approves it, and what the brand sees first.
4. **What the audit report contains.** Whether a line in it traces to the
   page it came from, or is a total per reason code.
5. **The onboarding checklist.** They quote 45 days and "no IT lift"; Table 87
   was first made to fix its BOL process. Ask what a brand has to change.

## 5. Stack, from public surfaces only

| Layer | Observation | Source |
| --- | --- | --- |
| App | `app.tryglimpse.com`, Next.js with partial prerendering and Turbopack, served from "Google Frontend" (Google Cloud), strict CSP, `frame-ancestors 'none'`, `/api/health` answers `{"status":"ok"}` | Response headers, 2026-10-03 |
| Auth | Clerk, on a custom domain `clerk.app.tryglimpse.com`, clerk-js 6.22.1 | Sign-in page script tags and CSP |
| Telemetry | PostHog (US), Sentry; Stripe JS referenced in the public bundle | Public chunks |
| Backend and data | "Python, Node.js, Next.js; MongoDB, PostgreSQL"; "Experience building with LLMs" | Every engineering posting |
| GTM | HubSpot, Apollo, Clay; "AI-powered outbound sequences" | GTM Engineer posting |
| Marketing site | Webflow, Jetboost, Cookiebot, Default.com | Homepage source |
| Not stated anywhere | The LLM provider, the OCR vendor, any browser-automation tool | Nine postings read in full |

The nine open roles on the Ashby board (2026-10-03): Sales Development
Representative, GTM Engineer, Partnership Manager, Account Executive (on YC's
page), Software Engineer, Senior Software Engineer, Founding Forward
Deployment Engineer, Deduction Analyst, Product Operations Manager. Five of
nine are go-to-market or operations.

## 6. The guides as playbook data (step 1 of the plan)

Glimpse publishes, per payer, the dispute channels, windows, documents and
code shapes it works from. Four were put through `/new-playbook` and live in
`playbook-drafts/` as data with provenance on every fact, `confidence: low`,
and the questions that would raise it. The one thing worth saying here: on
two of the four, another vendor's write-up disagrees with Glimpse (Walgreens'
pre-deduction tier schedule, and which Walgreens address takes a post-audit
dispute). Both versions are recorded and neither is used. A competitor's blog
is a lead on where a payer's rule lives, not the rule.

Second pass, 2026-10-04: every page of their blog list was read. Glimpse
publishes a guide for six payers and no more; Walmart and PetSmart are now
drafted beside the first four, and the KeHE and Chewy drafts carry what two
older posts add. Three more conflicts were recorded (two Walmart codes, the
Walmart chargeback window, and Glimpse's two different Chewy windows).
`playbook-drafts/README.md` lists what Glimpse says about every other payer
it names, which is a logo or a sentence. `PRODUCT-TEARDOWN.md` is the product
capability by capability, against ours.

## 7. What this adds to STRATEGY.md

- Pet and beauty are their growth verticals; foodservice and the broker
  model are untouched by them.
- "No minimum dollar threshold" is now their claim too, so the long-tail
  argument in STRATEGY §3.1 has to be made on cost per case, which we
  measure and they do not publish.
- They state the provenance problem as unsolved in a job posting. Our
  quote-verified, hash-chained packet is the answer to the sentence they
  wrote.
- Cash application is their retention hook for small brands. We have the
  QuickBooks read and a gated, unposted write-back (ADR 0060); the
  "I just click match" experience is the part we do not have.

What the teardown changes (`PRODUCT-TEARDOWN.md`, 2026-10-04):

- **Their public playbooks do not cover the first pilot.** No convenience
  distributor or chain appears in a guide or as a connector, and foodservice
  and K-12 not at all. Frazil's payer rules have to come from Frazil's own
  agreements, so the Oct 14 call is a document-collection call first
  (`docs/onboarding/leads/frazil.md`).
- **A deadline computed from the payer's rule is the first thing to build**
  (teardown row 13). "Files before the window closes" is their whole promise,
  and our cases carry a deadline only when a page prints one. Rules as
  effective-dated data, shown as "by rule, not printed", need an ADR and no
  migration.
- **They take the customer's own portal password; we should ask for a
  separate read-only user** (rows 2 and 3). Their setup is "Authenticate with
  your retailer portal credentials". Our read-only guard is a difference a
  customer's controller can check. Which we ask for is the founder's call.
- **Do not build a portal connector for the pilot.** Nothing public says
  which distributors Frazil uses. For the largest candidate, McLane, a
  dispute goes by email to the Accounts Payable address on McLane's own
  supplier page (per SPS Commerce's reading of McLane's vendor guide), so the
  work would be the packet and the fields that email must carry.
- **The weekly email is part of their product, and people write it** (row
  22). Customers quote it more than any screen. For the pilot the founder
  writes it from the payer board; a product email needs an ADR.
- **Their claims about human review disagree with each other** across 2025
  and 2026 posts (teardown §4), and their onboarding figure ranges from "days"
  to 45 days by page (§3). Neither is a number to quote against.

## Sources

Glimpse: homepage, `/post/seriesa`, `/post/glimpse-ai-disputing-agents`,
`/integrations`, `/solutions-hub`, `/contact`, `/glimpse-guarantee`,
`/cloud-services-agreement`, `/supplypike-vs-glimpse`,
`/channel/natural-channel`, customer stories (Evermark, Calyan Wax Co., Table
87), the four payer guides named in `playbook-drafts/README.md`, and
`jobs.ashbyhq.com/glimpse` (public posting API, with compensation). Third
party: TechCrunch 2026-03-25, 8VC, YC company page, toolradar.com,
settle.com partner directory (404 at read time), SPS Commerce and Endless
Commerce for corroboration only. All read 2026-10-03.

Second pass, read 2026-10-04: the sources listed at the foot of
`PRODUCT-TEARDOWN.md` and in each new draft's `drafted_from`.
