# The platform, as a client meets it

*Written 2026-09-30 for the pre-sell push. It describes what exists on
`origin/main` at `62475f5` and what a client would touch. Where something is
built but not live, or planned but not built, it says so. Nothing here changes
an invariant.*

## In one paragraph

Mozart (the product; `recouple` is the repo) recovers money a supplier's
customers withhold from invoices. Distributors and retailers short-pay: they
take a "deduction" off a payment and attach a reason code (a promo billback, a
manufacturer chargeback, spoilage, a fill-rate fee, freight). Some of those
deductions are invalid. The supplier usually never fights them, because
finding, documenting and filing a dispute costs more attention than the
deduction is worth. Mozart pulls every deduction into one place, reads the
documents behind it so that every number traces to a quote on a page, assembles
the dispute packet, and stops for a person to approve before anything is filed.
The supplier pays a contingency fee on what comes back.

## The loop a client sees

```
 deduction arrives ─► case opens ─► documents read ─► findings ─► a person decides
                                                                        │
       fee invoiced ◄─ outcome recorded ◄─ filing recorded ◄─ second person approves ◄─ packet assembled
```

Every step above the arrow is automatic and deterministic. Every step below it
is a person's, and the database refuses to record a filing without an approval
by someone other than the preparer (invariant 1). That gate is the product's
answer to "how do I trust an AI with my receivables": it never files, and it
shows the page it read every number from.

## Who the users are

| Role | Who, at a lead like Tarazi Foods | What they do in the app |
| --- | --- | --- |
| `owner` | The founder or controller | Connects QuickBooks, issues the email address, adds people, approves |
| `analyst` (writer) | Whoever chases deductions today: often the broker's back office, sometimes an outsourced bookkeeper | Uploads, attaches evidence, decides, assembles |
| `approver` | A second person: the controller, or the owner | Approves packets; records filings and outcomes |
| `read_only` / `accountant_guest` | Outside accountant, sales lead | Sees everything, changes nothing |

Two people per workspace is a hard minimum: the preparer of a decision cannot
approve it (separation of duties, enforced in the database). A broker agency
holding several manufacturers' cases gets one workspace per manufacturer and a
switcher between them (built, pilot E4).

## How deductions get in (discovery)

| Door | State | What the client does | What happens |
| --- | --- | --- | --- |
| **Upload** (PDF, PNG, JPEG, TIFF, HEIC, multi-file) | **Live** | Drags the notice, remittance or backup in, from the case list or a case page | Scanned, classified, read with per-field quotes; a notice or remittance at or above the confidence floor opens a case per deduction; evidence attaches to a case |
| **Email-in** | **Live** (2026-09-25) | Forwards the distributor's remittance email to `<token>@in.mozart.financial` | Every attachment is stored and read; a notice or remittance is **held** for a person to open with one click, because email is unauthenticated |
| **QuickBooks Online** | **Live** on Intuit production keys | Owner presses Connect on Settings → QuickBooks | A daily sync reads payments and credits, finds every short-paid invoice and opens a case for each gap. This is the coverage denominator: the deductions the supplier never surfaced |
| **Spreadsheets** (CSV, TSV, XLSX) | **Built**, merged, migration 0036 applied | Uploads the distributor's deduction export; confirms a column mapping once per payer | Each row becomes a case line with cell-level provenance |
| **Portal read** (UNFI, KeHE, SAP Business Network) | **Built as an engine**, no live portal, paused 2026-09-29 | Would enter a dedicated read-only portal login | A recipe pulls deduction detail and backup; captures are held for a person. Terms and a service login per portal come first |
| **EDI 812/820** | Not built (Phase 2.5) | — | A printout fixture reads correctly today; a VAN feed does not exist |
| **NetSuite, Xero, Sage** | Not built | — | Same `AccountingSource` port as QuickBooks |

## What the client sees once a case exists

- **Review queue**: every open case, most urgent first (due soon, past due,
  no deadline printed, due later), each with its next step in words.
- **Ledger**: every case, searchable by claim, invoice, payer.
- **Case page**: the original document beside every extracted field with the
  quote it was read from and a "quote found" badge; cross-document findings
  ("arrived before the appointment", "gross less net matches the deduction");
  the payer's reason code and reference; an evidence checklist for the reason
  chosen; a draft journal entry labelled not posted; possible duplicates.
- **Actions**, each a card that appears only when the state machine and the
  role allow: decide (dispute or decline with what it was worth), assemble
  packet (a payer-facing letter plus a zip of enclosures with SHA-256s),
  approve (second person), record the filing (confirmation number), record
  the outcome (won, partial, lost, cents recovered).
- **Coverage**: found against filed per channel, never blended; the ledger
  sync's runs and anomalies.
- **Settings**: QuickBooks, Email addresses, Team, and (built, off) posting.

## What leaves the platform (outbound)

| Side effect | State | Gate |
| --- | --- | --- |
| Dispute packet (letter + zip) | **Live**; the person downloads and files it | Approval row |
| Filing on a portal by recipe | ADR 0061 accepted; **not built** | Approval row, per-portal terms, after that portal's read |
| QuickBooks write-back (journal + payment) | **Built, off** (`QBO_POSTING`, owner switch, account map) | Approval row plus three switches |
| Contingency fee invoice | Fee maths built and property-tested; **invoicing by hand** (Phase 4) | — |
| Failure alerts to us | **Live** (Resend) | — |
| Reminders or digests to the client | Not built (needs an ADR: new outbound side effect) | — |

## External systems, and what each is for

| System | Role | State |
| --- | --- | --- |
| Supabase (Postgres + Auth) | Every table, RLS, the approval trigger, magic-link sign-in | Production through migration 0039 |
| Vercel | The app | Production and preview, split projects |
| Inngest | Background reads, the daily ledger sync, alerts | Live |
| Anthropic (Claude) | Classify and extract with no tools, quotes only | Live |
| Reducto | OCR text layer for scans and photos | Live |
| ClamAV on Fly | The scan gate, fail closed | Live |
| Postmark | Inbound email | Live |
| Resend | Failure alerts | Live |
| AWS KMS | Sealing QuickBooks and portal credentials | Live |
| Intuit (QuickBooks Online) | The ledger read; write-back built and off | Live read |
| Jev (TypeSafe) | The decision provider for Phase 2 | No access yet; Claude structured fallback not built either |
| UNFI (myUNFI, Natural Supplier Portal, Dispute Center, SVHarbor ePASS, UNFI Insights by Crisp) | Where a natural-channel supplier's deductions and backup live | Researched (`docs/plans/unfi-portal/research.md`); terms unread; no login |
| KeHE (KeHE CONNECT) | Same, for KeHE | Not researched in the repo yet; see the Tarazi lead notes |
| SAP Business Network (Ariba) | A retailer-side portal | Terms recorded (ADR 0062), sign-in walked, paused before any run |

## What the platform is not

- Not autonomous. A model reads pages; code does arithmetic; a person decides
  and a second person approves. There is no browser agent clicking on a portal.
- Not a portal-filing service today. The client files, and pastes the
  confirmation number back. A recipe-driven filing of an approved packet is
  the accepted next step (ADR 0061), not a built one.
- Not a promo-planning tool. It does not submit deals to a planner. It reads
  the deductions the planner's deals produce and checks them against the
  deal calendar, once playbooks exist (Phase 2 draft D, not built).
