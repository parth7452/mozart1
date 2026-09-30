# Road to MVP, and where we are on it

*2026-09-30, against `origin/main` at `62475f5`. Surveyed: every ADR through
0064, every PR (none open; #135 merged 2026-09-29), the four unmerged branches,
the Phase 2 drafts, the pilot, build-now, UNFI and Ariba plans. This is the
simple version; `PLATFORM-MODEL.md` says what the product is and
`EXECUTION.md` says what to build next and in what order.*

## What "MVP" means here

Not "the platform works". It has worked end to end since 2026-09-21. The MVP
is the smallest thing that turns a lead into a paying pilot:

> A supplier connects QuickBooks and forwards its distributor remittances.
> Within a week it sees every deduction it is sitting on, which ones are worth
> fighting and why, and files its first dispute packet with our help. Ninety
> days later it has a recovery number and we invoice a fee on it.

Four milestones get there. Each has a go/no-go a person can check.

```
 M0 Live ──► M1 Demo-ready ──► M2 Pilot-ready ──► M3 First recovery
 (done)      (the pre-sell)    (LOI → onboarded)   (the MVP proper)
```

## M0: live in production. Done.

Verified on the deployed app, not only in tests (`docs/STATE-OF-PLAY.md`):

- Sign-in by magic link, invitation only, owner-managed team (ADR 0051).
- Three doors in: upload (single or many files, PDF and images), email-in
  (held for a person), QuickBooks daily sync on Intuit's production keys.
- Every field with its page and verbatim quote; cross-document findings.
- The review queue and a searchable ledger; possible duplicates confirmed,
  merged, undone.
- Decide, assemble a payer-facing packet (letter plus zip), approve by a
  second person, record the filing and the outcome. One case through all of it.
- Coverage per channel; failure alerts to us.
- Spreadsheet imports, the evidence checklist, draft journal entries and
  the fuller dispute letter (PR #127, migrations 0036–0037 applied).
- Built and off, on purpose: QuickBooks posting (ADR 0060/0063), the portal
  read engine (ADR 0057/0062/0064, paused before any real run).

**Go/no-go met:** one production case reached `partial` through the gate.

## M1: demo-ready. Partly done. This is the pre-sell blocker.

What a lead sees on a 30-minute call. Today the demo is a freight case
(`docs/DEMO.md`, LOG-001) and the workspace the founder demos in holds
synthetic staffing and freight documents. A natural-channel food brand selling
through UNFI and KeHE will not recognise itself in it.

| Item | State |
| --- | --- |
| A demo workspace that reads as a natural/specialty food brand: a UNFI-style deduction remittance (MCB, promo billback `-111`, spoilage, fill-rate fee), a KeHE-style chargeback, the deal sheet they came from, and the backup | **Not done.** The `formats` suite has a broadline chargeback statement and an EDI 812 printout; nothing UNFI- or KeHE-shaped exists |
| A QuickBooks sandbox company connected to that workspace with matching short-pays, so "connect your books and we show you what you are sitting on" is demonstrable live | **Not done** as a demo; the connect flow and sync are live |
| Beachhead reason codes on the decide form (MCB, deviated-pricing billback, promo allowance, spoilage/unsaleables, fill rate, new-item fee) | **Partly.** Eleven pilot codes are on the form (E5); the foodservice and natural-channel vocabulary is named as absent in Phase 2 draft D |
| A 30-minute call script and the materials (this plan's `docs/onboarding/PRE-SELL-CALL.md`) | **Done in this PR** |
| A one-page data-handling note naming the sub-processors | **Not done** (pilot README, Friday list) |
| Custom SMTP for sign-in mail, so a lead's first link arrives (pilot B5) | **Unknown.** Not recorded as done anywhere |

**Go/no-go:** the founder runs the demo script end to end in the demo
workspace in under 20 minutes, and a lead's email address receives a sign-in
link on the call.

## M2: pilot-ready. Mostly built; the production runs are not done.

What the first LOI customer hits on day one. The pilot plan's eight builds
(E1–E8) all merged 2026-09-25. What is left is the founder's click-throughs
and a few gaps a food brand will hit at once.

| Item | State |
| --- | --- |
| VERIFY-CHECKLIST §11 (20 files in one selection, a 6 MB PDF, a deadline entered, Assemble again, the letter and the zip) | **Not run in production** |
| VERIFY-CHECKLIST §5.6–5.8 (email-in's failure paths) before a customer gets an address | **Not run** |
| Rebuild a workspace from `create-workspace.sql` on `mozart-preview` (E8 failed once when pasted) | **Not done** |
| Large files: ADR 0055 (direct-to-storage) accepted, **not built**; stopgap is "send it to us" | Decide: build 0055 or run the stopgap for pilots 1–3 |
| Per-payer dispute windows and the UNFI/KeHE code map as playbook data (Phase 2 draft D, task 04) | **Not built.** Until then, windows live in onboarding notes and codes are picked by hand |
| Dense remittances past ~120 rows fail loudly in the app (ADR 0053 §6). UNFI natural remittances can be long | **Decision pending.** A WIP branch `claude/paged-extraction-in-production` (1 commit, untested) attempts the proactive gate |
| A broker's view: one identity across several manufacturers' workspaces | **Built** (E4 switcher). Not exercised with a real broker |
| Done-with-you routine: our analyst inside the workspace daily (ONBOARDING §6) | **Written.** Needs a named person and 15 minutes a day per workspace |
| Pilot terms: fee percentage (`fee_pct_bps` defaults to 25%), pilot length, invoicing by hand | **Founder's decision** |
| Security housekeeping from the Ariba pause: rotate the AWS key and worker token exposed on 2026-09-29 (`docs/plans/ariba-portal/STATUS.md`) | **Not done.** Not customer-facing, but do it before any customer data sits near that worker |

**Go/no-go** (pilot README, Sunday): every real notice or remittance opens a
case or is held with a reason; one case reaches `approved` with a packet a
person would send; their largest file has a documented path in; an address
outside our team receives a sign-in link.

## M3: first recovery measured. Not started.

The MVP proper, and STRATEGY §9's stage-3 gate. Nothing here is code.

- A pilot customer's real deductions in, decided, filed by them with our
  packet, and outcomes recorded as they land (30–90 days).
- Recovery rate for one customer: filed, won, collected, in dollars.
- One contingency fee invoiced by hand (Phase 4 billing is not built).
- Analyst minutes per case measured in week one, because that number sets
  how fast the next customers come on (pilot README).

**Go/no-go:** a recovery rate exists for one customer, and a fee was paid.

## After the MVP, in the order the plans already set

1. Portal read of UNFI (ADR 0058, paused): terms read, a dedicated login, the
   walk-through, then the recipe. The SAP Business Network plumbing test
   (ADR 0062) is paused ahead of it and needs four runner changes.
2. Phase 2 in shadow: playbooks (draft D), the decision state (C), the shadow
   table (A), the Claude provider (B), scored against ≥30 human decisions.
   Jev needs access and a DPA first.
3. QuickBooks posting switched on for one customer after a sandbox trial
   (ADR 0060 §5 was waived; the switch is set, the owner toggle is off).
4. EDI 812/820, NetSuite, filing by recipe (ADR 0061).

## Where we are, in one line each

- **Engineering:** M0 done, M2 built, M1 missing the natural-channel demo.
- **Operations:** the production click-throughs in VERIFY-CHECKLIST §5 and
  §11 are the founder's and are not done.
- **Commercial:** two leads, no LOI, no real customer document in the repo.
  Every eval number is synthetic or public-record, and STATE-OF-PLAY names
  real documents as the one blocker.
- **Risk to watch:** an exposed AWS key and worker token from 2026-09-29
  await rotation.
