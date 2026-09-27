# 0058 — UNFI is the first portal, and its terms are read before anything runs

- Status: accepted (the founder, 2026-09-27). **The terms-of-service check is
  still pending.** No
  automated read of any UNFI system runs until the founder has read UNFI's
  terms and recorded the answer in §2 of the Decision. Nothing is built.
- Date: 2026-09-26
- Depends on: ADR 0057 (portal read) being accepted; Draft D (playbooks and
  code maps) for the code map; ADR 0056 (spreadsheets) being built, if the
  export UNFI gives is a spreadsheet
- Adds, if accepted: a UNFI recipe and a UNFI code map, both data; the UNFI
  hosts on the worker's allowlist; no code of its own beyond what ADR 0057
  builds

## Context

### Why UNFI first

These are the founder's reasons:

- For emerging consumer-goods brands, distributor deductions from UNFI and
  KeHE usually outnumber direct-retailer ones by a wide margin.
- UNFI deductions are hard to decode: many small line items, cryptic codes,
  and backup spread across several documents and channels.
- Suppliers get portal access themselves, so a dedicated login needs no
  enterprise onboarding.

The research below agrees with the second reason. It finds two code sets, a
deduction key a secondary source puts at hundreds of codes, one suffix
(`-111`) that means either a shortage or a price discrepancy, and backup that
arrives through at least four email senders, a portal and a legacy system.
It partly supports the third: myUNFI's enrollment is self-serve for a supplier
that already holds legacy credentials, and the natural portal appears to let
an owner add users. The first reason is the founder's market knowledge; the
research did not measure it.

### UNFI is not the beachhead `CLAUDE.md` names

`CLAUDE.md` names foodservice manufacturers selling through broadline
distributors (Sysco, US Foods, PFG, Gordon) as the current focus, and calls
that a decision still under discovery. UNFI is not a broadline foodservice
distributor. It is a natural and specialty grocery wholesaler. So the pilot's
market is not `CLAUDE.md`'s named beachhead, and `docs/plans/pilot/README.md`
describes a waitlist of foodservice manufacturers and logistics companies.

The plan rests on the pilot customer being a UNFI supplier; its name is kept
off the repository. This ADR records that as a discovery finding. Whether
`CLAUDE.md`'s go-to-market paragraph and the pilot plan change is the
founder's call. If they do, the `CLAUDE.md` edit is part of the change that
accepts ADR 0057 and amends the build order (ADR 0057 §14).

Either way the engine stays payer-agnostic. This ADR picks the pilot's first
portal, and the choice is data: a recipe and a code map. No code names UNFI.

### How far the research can be trusted

The research (`docs/plans/unfi-portal/research.md`, 2026-09-26) was verified
claim by claim against its sources. Only claims verified as confirmed, or
partly confirmed and corrected, appear here. Three limits apply to all of it:

- Most UNFI-owned pages sit behind bot protection. The Supplier Terms, the
  myUNFI Terms of Use and UNFI's site Terms of Use were seen only as
  search-result excerpts, not read on the page. Direct Commerce's terms were
  not found at all.
- Most detail comes from deduction vendors' articles (SPS Commerce,
  SupplyPike, Glimpse, Crisp, Confido), not from UNFI.
- Nothing has been checked against a real UNFI document or a real login. The
  founder's hand walk-through (Decision §11) is where these become facts.

## What the research says

Every claim below has its source. The labels are defined at the end of this
ADR, and `research.md` lists each address with its verdict.

### 1. Two sides, several systems

- **UNFI has two separate deduction worlds with different code sets.**
  - **Natural** (legacy UNFI) uses AP reps, emailed backup and the Dispute
    Center. Its East and West balances are managed separately.
  - **Conventional** (legacy SUPERVALU) uses SVHarbor ePASS.

  No source says which retailers each side serves.
  [crisp-open] [supplypike-eco] [sps-conv] [glimpse-dispute]
- **myUNFI is the front door.** Its supplier dashboard describes itself as
  "the digital front door". It holds no deduction detail itself and links out
  to the Natural Supplier Portal, the Dispute Center, the Harbor portals and
  UNFI Insights (Crisp). Its public script has no deduction, remittance or
  payment endpoint. [myunfi-dash] [myunfi-bundle]
- **The Dispute Center** is built by Direct Commerce and opened from myUNFI
  with "GO TO DISPUTE CENTER". It was announced in January 2026 and launched
  in February 2026. It is for natural suppliers only, and suppliers are being
  onboarded in phases through 2026. Its sign-in goes by SAML to
  `my.directcommerce.com/unfisso`. [supplypike-eco] [sps-dc]
  [glimpse-dispute] [myunfi-bundle]
- **The Natural Supplier Portal** is `suppliers.unfi.com`. myUNFI labels it
  "Natural Supplier Portal – Connect with your natural reports and tools."
  Vendor write-ups seen only as search snippets say it shows posted invoices,
  payments and deductions. Whether it is being retired is unknown.
  [suppliers-login] [myunfi-bundle]
- **The conventional side** handles deductions in SVHarbor ePASS, at
  `epass.svharbor.com/epass/home`. myUNFI also links three Harbor portals and
  SVInquire. SVHarbor's SVInquire page lists "Vendor Funds - ability to view
  fund balances and transactions online in real time". [myunfi-bundle]
  [svh-epass] [svh-apps] [svh-emerch] [sps-conv]
- **UNFI Insights** is run by Crisp, a third party reached through myUNFI.
  Its Open Payables dashboard:
  - updates daily and serves natural and conventional suppliers;
  - downloads as PDF and Excel;
  - has an Invoice Number column that "provides the keys UNFI uses to
    identify the deduction".

  [crisp-press] [crisp-open] [crisp-blog]

### 2. Access

- **myUNFI enrollment asks for existing credentials.** It asks for current
  Natural Supplier Portal or Harbor credentials, and refuses without a
  validated remit or cross-reference. That self-serve access needs those
  legacy credentials is an inference from the flow, not a statement. The
  Dispute Center needs a myUNFI account. [myunfi-enroll]
  [myunfi-enroll-bundle] [sps-dc] [glimpse-dispute]
- **The natural portal appears to have Owner, Manager and User roles**, and
  an Owner can set up users. This rests on help-centre article titles and
  snippets only, because the help centre could not be read, and one search
  result was titled "Help Center Closed". [zd-add-user] [zd-manager]
  [slideplayer]
- **MCB documents go to one person.** Confido says of the weekly MCB emails:
  "UNFI only allows one person can get these emails". [confido-blog]
  [confido-cash]
- **SVHarbor (conventional) access is managed by an administrator.** Its
  terms of July 2, 2020 say: "SVHarbor subscribers are subject to an annual
  subscription fee that is deducted from payments to Vendors (brokers are
  invoiced)... based on a Vendor's annual SUPERVALU sales and the number of
  Vendor users added to the account." So a dedicated user on the conventional
  side may raise the customer's fee. Whether the fee is still charged is
  unknown. For suppliers enrolled in UNFI's SSA programme, Glimpse says SSA
  waives SVHarbor access fees. [svh-info] [svh-faq] [svh-terms]
  [glimpse-dispute]

### 3. Sign-in, SSO and MFA

- **myUNFI signs in through Azure AD B2C.** Its login
  (`www.myunfi.com/api/authenticate/login`) redirects (302) to
  `unfib2c.b2clogin.com`, policy `B2C_1A_P1_V1_SI_PE_PROD`, with a
  username-first `signInName` field. The Dispute Center uses the SAML policy
  `B2C_1A_P1_V1_SI_PE_SAML_DCIApp_PROD`. [myunfi-login] [myunfi-bundle]
- **The password rules** are ten characters minimum, three of four character
  classes, and not matching the user id. [myunfi-enroll-bundle]
- **The Harbor apps** (`epass`, `svcportal`, `svinquire`) are fronted by F5
  BIG-IP APM, which posts a SAML request to the same B2C tenant (policy
  `B2C_1A_P1_V1_SI_PE_SAML_F5_POCAPPS_PROD`). [svh-epass-home]
  [myunfi-bundle]
- **No MFA statement was found.** The B2C page carries only its standard
  email-verification strings. [myunfi-login]

### 4. Bot protection

- UNFI's terms pages and `suppliers.unfi.com` answer automated requests with
  Imperva Incapsula challenges. The help centres answer with Cloudflare
  challenges.
- An unauthenticated ePASS request ends at a BIG-IP logout page.
- `robots.txt` on `www.unfi.com` has no Disallow line. That file covers no
  portal host.
- `my.directcommerce.com/robots.txt`, on the Dispute Center's host, reads
  `User-agent: *` / `Disallow: /`: it disallows all user agents (fetched
  2026-09-26). [dc-robots]
- The other portal hosts publish no robots file. `www.myunfi.com/robots.txt`
  returns the app's HTML page, and `suppliers.unfi.com/robots.txt` answers a
  redirect (302). [myunfi-robots] [suppliers-robots]

[unfi-terms] [suppliers-login] [zd-deductions] [unfi-robots] [svh-epass-home]

A recipe that meets a challenge stops (ADR 0057 §1). These challenges mean the
UNFI recipe may stop at sign-in, which the walk-through will show.

### 5. What each system gives, and exports

- **The Dispute Center** (natural), per SPS, updated June 23, 2026, offers:
  - Quick Search and Advanced Search;
  - View Payments (30 days) and My Docs (30/60/90 days);
  - "Use search tools to find and export invoice, adjustment, payment, and
    dispute details.";
  - a History of every action.

  Its attachments (for disputes, which we never file by machine) may be "PDF,
  TIFF, JPEG, XLSX, and CSV. The maximum file size is 20MB per file." No
  source names the export's format. [sps-dc]
- **ePASS** (conventional) gives deduction copies, a payment search and
  "Create PASS#" (a dispute, which is a write). Glimpse says suppliers can
  "pull electronic copies of deductions going back 12 months". No ePASS export
  is documented. SVInquire's "Download Listing" covers funds, orders, items
  and sales, not deductions. [svh-terms] [svh-epass] [svh-emerch]
  [glimpse-dispute]
- **Crisp's Open Payables** downloads as PDF and Excel (§1). [crisp-open]
- **UNFI's deduction keys are behind the login.** myUNFI links "Supplier
  Deduction Key.xlsx", "Conventional Transaction Key.xlsx" and two FAQ PDFs,
  each redirecting to the B2C login. SPS names the current file "Supplier
  Deduction Key 01.14.2025.xlsx". Glimpse counts 446 codes across 55
  categories; that count is Glimpse's own, not verified. [myunfi-bundle]
  [sps-natural] [glimpse-kehe]

### 6. Email, which is already a door

- **Natural remittances and backup arrive by email**, as PDFs, zips or a
  SharePoint link, from at least four UNFI senders. Missing backup is
  requested from `DeductionsBackup@unfi.com`; Glimpse gives the subject line
  "BACKUP REQUEST", and UNFI's support article on backup requests is
  described in a search snippet as using an Excel form. [supplypike-eco]
  [glimpse-dispute] [zd-backup]
- **The remittance document** is called a "UNFI Direct Deposit Advice", and
  deductions "arrive in PDF form". [remitparse]
- **MCB documents come weekly**, after signing up at
  `supplierdeductiondisputemgmt@unfi.com`. Crisp says the Weekly MCB, Quality
  MCB, Reclamation and Whole Foods Third Party reports "are automatically
  emailed when generated". [confido-blog] [crisp-open]

Email-in is live (ADR 0047). A customer can forward UNFI's remittance and
backup emails to their workspace address today. PDF and image attachments,
and the body, are stored and held by email for a person. The door takes no
other type (`packages/ingest/src/sniff.ts:26-39`): a zip attachment is
recorded as a refused part and not stored, and so is a spreadsheet until ADR
0056 is built (`packages/pipeline/src/inbound.ts:146`). A SharePoint link is
not followed. That needs no portal and no build.

### 7. EDI

Only EDI vendors' pages say UNFI sends an 820. One lists the 820 and 824 as
UNFI-sent, and one lists the 820 as optional. No source mentions an 812.
SVHarbor's EDI page gives only a helpline address. [crstl] [endless-edi]
[infocon] [svh-edi]

### 8. Disputes and windows

- **Natural** disputes go through the Dispute Center. According to SPS, as of
  June 2026:
  - adjustments older than 12 months are denied;
  - there is one appeal, with new information;
  - resolution takes 35–45 days.

  Glimpse says the 12 months run from when UNFI records the deduction, and
  that the appeal window opens three business days after resolution. Some
  types still go by email: AP Cash Terms (short and prepaid payments, cash
  discounts, unpaid invoices, detention and other fees), SAS, SASIF and PRGX.
  The process before the Dispute Center used an Excel form
  (`UNFI Natural Supplier Dispute Form 01012024.xlsb`) sent to
  `Deductions@unfi.com`. [sps-dc] [supplypike-eco] [myunfi-bundle]
  [sps-natural] [glimpse-dispute]
- **Conventional** disputes are PASS# inquiries in ePASS. The 2020 SVHarbor
  terms set an 18-month limit, one re-open and an escalation ladder. SPS (July
  2025) says 60 days is suggested, 12 months is the limit, and a pass usually
  resolves in 30–45 days. The two sources disagree on the limit. [svh-terms]
  [sps-conv]
- **The Supplier Terms**, seen as search excerpts only, say:
  - UNFI pays "net of any and all deductions, chargebacks and fees due and
    payable by a Supplier";
  - what it cannot deduct within 30 days it bills, due immediately;
  - disputes go to senior management within 30 days, then mediation, then
    arbitration in Providence, RI;
  - no deduction-dispute deadline appeared in the excerpts seen.

  [unfi-terms]

Disputing is a write. It is never automated here: a person files, after the
packet is approved (ADR 0020).

### 9. Terms

What the research found. The founder's reading (Decision §2) replaces this.

- **myUNFI Terms of Use** (search excerpts only; the page is behind Incapsula)
  say "The Service is protected by user-specific passwords or login". They
  forbid "user or password sharing", and ask users "not to take any action
  that might compromise the security of the Site". [myunfi-tou]
- **UNFI's site Terms of Use** (excerpt) say users "may not mirror or frame...
  may not connect 'deep links'". [unfi-site-tou]
- **No wording on robots, spiders, scrapers, bots or automated access**
  appeared in the search excerpts of the myUNFI and site Terms of Use. Their
  full texts, and Direct Commerce's terms, have not been read. [myunfi-tou]
  [unfi-site-tou]
- **The Supplier Terms' confidential information** includes "any reports
  provided by UNFI to Supplier". In excerpt, the terms say the supplier "may
  not disclose any Confidential Information to a third-party without written
  consent". Whether that consent must be prior is not confirmed. No carve-out
  for agents, brokers or service providers was found. [unfi-terms]
- **The SVHarbor terms** (July 2, 2020, read in full) cover:
  - confidential logons;
  - access assigned by an administrator;
  - a definition of "Vendor" that includes agents;
  - acceptance by entering the system.

  They have no clause on automation. SVHarbor's information page says
  suppliers and brokers should not set up users across profiles.
  [svh-terms] [svh-info]
- **UNFI's Supplier Code of Conduct** (March 2026, read in full) limits the
  use of information to its purpose. It makes the supplier liable for damages
  arising from its access to UNFI systems, and has cyber incidents reported to
  `cyber@unfi.com`. [unfi-coc]
- **Other vendors read UNFI data. None says UNFI allows it.** SPS Revenue
  Recovery "ingests UNFI's email-based and MyUNFI deduction data", and
  iNymbus "Submits the dispute directly on the appropriate portal". Neither
  says how, or that UNFI permits it. Another vendor's practice is not
  permission. [sps-rr] [inymbus]

## Decision (proposed)

### 1. UNFI is the first portal

UNFI is read under ADR 0057 and nothing else. The side read first is the
side the pilot customer uses. If they use both, natural goes first, because
the Dispute Center and emailed backup are there and because conventional users
may carry a per-user fee (*What the research says*, §2). The walk-through confirms
which.

This ADR is also the per-portal ADR for the Dispute Center, which Direct
Commerce built and runs and myUNFI links to (ADR 0057 §16). That holds only
if the founder's reading of Direct Commerce's own terms (§2, question 1)
allows it. Otherwise `my.directcommerce.com` stays off the allowlist (§6).
Crisp is not covered (§5).

### 2. The terms check comes before any automated read: pending

No recipe runs against any UNFI host, on the schedule, in a dry run or by the
agent, until the founder has read UNFI's terms in a browser and recorded the
answer here (ADR 0057 §2).
This ADR is not accepted with this section empty.

The founder answers:

1. Which documents govern, and the version or date of each as read: the
   myUNFI Terms of Use, UNFI's site Terms of Use, the Supplier Terms, the
   Dispute Center's own terms (Direct Commerce), the SVHarbor terms if the
   conventional side is used, and the Supplier Code of Conduct.
2. Does any of them forbid automated access, scripts, bots or scraping? And
   does Direct Commerce's `robots.txt`, which disallows every user agent
   (*What the research says*, §4), bind a user the supplier authorised?
3. Is a separate user, created by the supplier's owner for a service provider
   acting for the supplier, allowed? Or is it the "user or password sharing"
   the myUNFI terms forbid?
4. Under the Supplier Terms' confidentiality clause, is a service provider
   reading "reports provided by UNFI to Supplier" on the supplier's behalf a
   "third-party", so that UNFI's written consent is needed?
5. Is anything shown at sign-in (a clickwrap, a banner) that a recipe would
   have to accept?

The record:

- Terms read by: *pending*
- On: *pending*
- Documents and versions: *pending*
- Answer: *pending* (one of: allowed; allowed with conditions; needs UNFI's
  written consent; not allowed)
- Conditions, if any: *pending*

If the answer is "needs consent" or "not allowed", no automated read runs.
The founder downloads by hand and uploads, and the rest of the plan (the code
map, the identity match) goes ahead on uploaded documents.

### 3. Access: a dedicated user, least role

- The pilot customer's portal owner creates a user for this service. It is
  never a person's own login. It gets the least role that can see
  deductions, payments and backup. If a role exists that cannot dispute,
  that is the one.
- **The dispute systems need that role.** The Dispute Center's host
  (`my.directcommerce.com`) and ePASS's (`epass.svharbor.com`) are where
  disputes are filed ("Create PASS#" in ePASS). They go on the allowlist (§6)
  only if the dedicated user's role cannot dispute there. That is recorded on
  the walk-through (§11, item 3) and checked by the fixture portal's decoy
  test (plan, step 6). If no such role exists, those hosts stay off the
  allowlist, and what they hold is read by hand or by email (*What the
  research says*, §6).
- The credential is entered by our owner in Settings → Portals and sealed
  (ADR 0057 §7). It is never sent in chat, email or the repository.
- On the conventional side, the owner is told a user may add to the SVHarbor
  fee before one is created.

### 4. Sign-in and MFA

B2C is username-first. No MFA statement was found in the public sign-in page
or scripts [myunfi-login] [myunfi-bundle]. Whether MFA applies is pending the
walk-through (§11, item 4), which records what the dedicated user is actually
asked. The recipe answers TOTP if the account can enrol it. It answers email
codes only if ADR 0057 §8's code-address variant is built. Anything else
stops the run with `mfa_unanswerable`, and the customer is back on upload and
email.

### 5. What the recipe reads, in order

1. **An export**, where one exists (the Dispute Center's search export, if the
   walk-through finds one and its format is one the door takes).
2. **Per-deduction detail pages and backup downloads.**
3. **List pages, last**, and paged. A long list page runs into the reader's
   row budget.

Crisp's UNFI Insights is a third party with its own terms and is not read
under this ADR (ADR 0057 §16).

### 6. The UNFI never-click list and hosts (seed; confirmed on the walk-through)

- **Never click**, in addition to the runner's own list: anything that starts,
  saves, submits or appeals a dispute; attaches or bulk-uploads a file; or
  creates a PASS#. The walk-through records each control's exact text.
- **Hosts** (seed): `www.myunfi.com`, `unfib2c.b2clogin.com` and
  `suppliers.unfi.com`. `my.directcommerce.com`, and `epass.svharbor.com` for
  the conventional side, are added only under §3's condition (a role that
  cannot dispute) and, for Direct Commerce, §1's (its terms allow it).
  Crisp's hosts are not on it.

### 7. Rate and schedule

UNFI's rate limits are unknown. The default is ADR 0057's: one serial read per
connection per day, off-hours in US Eastern time, with caps on pages,
downloads and run time set from what the walk-through counts. Nothing retries
within a day. A challenge or a rejected sign-in stops the connection until a
person looks.

### 8. Captures are held for a person

Every UNFI capture that would open a case is held as `by_portal`, as ADR 0057
§10 holds every portal's, and a person opens it. Lifting the hold follows ADR
0057 §10: an ADR, and a one-way guarded row keyed by the portal key, never a
setting and never code that names UNFI.

### 9. Identity with QuickBooks

- **UNFI's key.** UNFI keys a deduction by a value Crisp shows in the Invoice
  Number column, which "provides the keys UNFI uses to identify the
  deduction" [crisp-open]. SPS prints the natural form for a `-111` as
  `(Invoice#)-111` [sps-natural]. For the Dispute Center, SPS describes an
  adjustment number in three sections, `<adjustment number>-<0 or
  111>-<East or West>`, with the examples `9876543–111–EAST` and
  `1234567-0-East`. It calls the first section "the adjustment number that is
  unique to that specific adjustment", and the middle one "0 = deduction, 111
  = invoice chargeback" [sps-dc]. Whether the Dispute Center's adjustment
  number is the supplier's invoice number is not known. The whole key is
  recorded as the case's `claim_id`, with source `portal_fetch` (ADR 0057
  §11), so a UNFI notice forwarded by email that prints the same key meets
  the capture exactly.
- **The invoice number.** It is recorded only where the page prints the
  supplier's invoice as its own field. Taking it from the key's prefix is
  UNFI's convention. If done at all, it is a playbook rule with provenance,
  never code, and never a fuzzy match.
- **Meeting the short-pay.** The first demo's deduction and its QuickBooks
  short-pay meet as a `probable` pair only when three things hold (ADR 0057
  §11):
  - the capture prints the supplier's invoice number as its own field (§11,
    item 20);
  - the QuickBooks gap on that invoice equals this one deduction to the
    cent, which holds only when it is the only deduction on the invoice;
  - the deduction date is within seven days of the invoice's last payment
    date in QuickBooks.

  A person then confirms the pair and it is merged (ADR 0032, ADR 0042). If
  the short-pay arrives second instead, and the capture recorded the invoice
  number, it resolves `exact` to the portal case on the invoice number and
  opens nothing; after ADR 0057 §11's triage change, it does so only when the
  amounts agree to the cent. If the capture recorded no invoice number, the
  two never meet and both stay open (ADR 0057 §11).
- **What QuickBooks sees.** How the customer's books record a UNFI deduction
  (left open on the invoice, or cleared to a deductions account) decides
  whether the ledger sees a short-pay at all. The walk-through asks.
- **Not every line is a new deduction.** Per the research, a `PP` suffix is a
  prepayment or reversal netting to zero, and `PB` and `DM` mark a repayment
  or correction of a disputed deduction [confido-blog] [sps-natural]
  [glimpse-dispute]. Draft D's code-map rows map a printed code to a
  canonical code and have no way to say "not a deduction" or "a repayment of
  one". That is a gap Draft D must close before those lines are mapped. Until
  then they are left unmapped and shown to a person.

### 10. Codes

- `docs/plans/unfi-portal/research.md` holds a seed list of UNFI deduction
  types and codes. Each has a candidate canonical code, and every one is
  marked unverified against real UNFI documents. It is a starting point, not
  a code map.
- The code map is built as Draft D rows, each with provenance, from:
  - real deductions and their backup;
  - the Supplier Deduction Key, if the terms answer (§2) lets the customer
    share it with us, since it may be one of the "reports provided by UNFI to
    Supplier".
- `-111` maps to nothing by code. A person picks `shortage_quantity` or
  `price_discrepancy` from the backup.
- **A reason is mapped only from what the page prints on its own.** UNFI
  prints reasons inside composite keys (`(Invoice#)-111`, `MCB(yyyymmdd)`,
  `CMQ(mmyy)0(Remit#)`, `[DC#]CNDM(mmmyy)`), and Draft D's `mapPayerCode` is
  an exact normalised match, else unmapped, so no plain Draft D row maps a
  key like these. A UNFI reason is mapped from a reason field the page prints
  on its own, or by a Draft D amendment that adds effective-dated pattern rows
  as data with provenance. It is never mapped by parsing a key in code, and
  the reader is never asked to split one.
- The taxonomy's gaps go to Draft D's taxonomy edit, not into the map as a
  nearest match: billback, slotting and placement, spoils allowance, recall
  and disposal, overship. A way to say "not a deduction" (`PP`) or "a
  repayment of one" (`PB`, `DM`) is the gap §9 names.
- Dispute windows are not encoded until a reviewed playbook version cites
  UNFI's own text. The sources disagree (*What the research says*, §8), and a printed
  deadline wins (Draft D).

### 11. Open items for the founder's hand walk-through

Recorded as labels, hosts and counts only: no values, no customer data, no
credentials.

1. Which side or sides, and which natural regions (East, West), the pilot
   customer is on.
2. Whether their myUNFI shows the Dispute Center yet, given phased
   onboarding.
3. Whether an owner can add a user; which roles exist; whether a role can see
   deductions and backup without being able to dispute (the precondition for
   the dispute hosts, §3).
4. What sign-in asks of a new user: MFA or not, of what kind, how often, and
   whether "remember this device" is offered.
5. Whether a bot challenge appears in an ordinary browser at sign-in.
6. How long a session lasts before it signs out.
7. Every host the flow visits, in order.
8. What each screen shows: the list's columns, a deduction's detail fields,
   and where its backup lives (in the portal, by email only, or behind a
   SharePoint link).
9. Which screens export, in what format, over what date range, and the export's
   header row as printed.
10. Whether backup downloads one file at a time or only as a zip.
11. Whether the screens show a dispute deadline or the date the 12 months
    count from.
12. The exact text of every control that writes (dispute, appeal, save,
    attach, bulk upload, create PASS#), for the never-click list.
13. Any terms, banner or clickwrap shown at sign-in.
14. Whether the customer receives MCB and remittance emails, who receives
    them, and whether they could go to the workspace's issued address.
15. Whether the customer receives EDI 820s.
16. How the customer's QuickBooks records a UNFI deduction.
17. Whether the Supplier Deduction Key is visible, and whether it may be
    shared with us (after §2).
18. On the conventional side, whether a user adds to the SVHarbor fee.
19. Roughly how many deductions a month, and how many pages a month's list
    runs to.
20. Whether a deduction's detail prints the supplier's invoice number as its
    own field, not only inside the key (§9).

### 12. What the founder decides

1. UNFI as the first portal.
2. The terms answer (§2). Without it this ADR is not accepted.
3. Which side first, if the customer uses both (default: natural).
4. Whether to start forwarding UNFI's emails to the workspace address now, as
   a zero-build step.

## Consequences

- The first portal is the one whose deductions are hardest to read by hand,
  which is where reading them for the customer is worth most. It is also the
  one most likely to need a person per code at first, because the codes are
  many and one of the commonest is ambiguous.
- If the terms answer is no, or needs UNFI's consent, the portal read waits.
  The code map, the identity match and the email door still go ahead.
- Two sides and several systems mean two recipes, not one, if a customer uses
  both.
- Bot protection may stop the recipe at sign-in. The answer is then a person
  and upload, never evasion.

## Invariants touched

None beyond ADR 0057's. The UNFI recipe and code map are data. The
never-click list only adds refusals. No UNFI name appears in code.

## Rollback

Disable the UNFI connections. The recipe and code-map versions stay as data
and are no longer used. Captured documents and the cases opened from them stay
ordinary documents and cases. The customer is back on upload and email.

## Sources

Every source was checked on 2026-09-26. Addresses and verdicts are in
`docs/plans/unfi-portal/research.md`, Sources. The labels used above are
defined here.

[myunfi-dash]: https://www.myunfi.com/supplier-dashboard
[myunfi-bundle]: https://www.myunfi.com/supplier-dashboard/assets/index-B450dmki.js
[myunfi-login]: https://www.myunfi.com/api/authenticate/login
[myunfi-robots]: https://www.myunfi.com/robots.txt
[myunfi-enroll]: https://www.myunfi.com/enroll/signup
[myunfi-enroll-bundle]: https://www.myunfi.com/enroll/assets/index-DWLpLp4q.js
[myunfi-tou]: https://www.unfi.com/myunfi/terms-of-use.html
[unfi-site-tou]: https://www.unfi.com/privacy/terms.html
[unfi-terms]: https://www.unfi.com/supplier-terms.html
[unfi-robots]: https://www.unfi.com/robots.txt
[dc-robots]: https://my.directcommerce.com/robots.txt
[unfi-coc]: https://www.unfi.com/content/dam/unfi-corporate/footer/Supplier%20Code%20of%20Conduct_English.pdf
[suppliers-login]: https://suppliers.unfi.com/Account/Login
[suppliers-robots]: https://suppliers.unfi.com/robots.txt
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
[glimpse-dispute]: https://www.tryglimpse.com/post/how-to-dispute-unfi-deductions
[glimpse-kehe]: https://www.tryglimpse.com/post/unfi-kehe-supplier-deductions
[crisp-press]: https://ir.unfi.com/news/press-release-details/2023/United-Natural-Foods-and-Crisp-Unveil-New-Platform-Giving-Consumer-Packaged-Goods-Companies-Enhanced-Access-to-Retail-Insights/default.aspx
[crisp-open]: https://docs.gocrisp.com/docs/support/articles-Reviewing-open-UNFI-invoices
[crisp-blog]: https://www.gocrisp.com/blog/unfi-insights
[confido-cash]: https://www.confidotech.com/resources/a-complete-guide-to-unfi-cash-application-and-deductions
[confido-blog]: https://www.confidotech.com/blogs/manage-deductions-and-disputes-for-unfi
[remitparse]: https://remitparse.com/blog/unfi-deduction-codes-explained
[crstl]: https://www.crstl.ai/blog/unfi-edi-requirements
[endless-edi]: https://endlesscommerce.com/edi/requirements/unfi/
[infocon]: https://www.infoconn.com/edi/partners/Unfi.htm
[inymbus]: https://blog.inymbus.com/unfi-deduction-disputes-common-issues
