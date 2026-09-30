# Execution: the pre-sell platform, built on what exists

*2026-09-30. The goal, in one sentence: within two weeks, a 30-minute
screen-share in which a natural-channel food brand watches its own kind of
deductions become disputes in Mozart, and leaves signed into a workspace of
its own. That is what converts a call into an LOI. Everything below serves
that sentence; anything that does not is parked.*

## The strategy in three moves

1. **Demo on their documents' shape, not ours.** The live demo is a freight
   case. Both leads sell through UNFI and KeHE (Tarazi confirmed; Anthem
   unknown, likelier direct-to-retailer). The demo workspace has to hold a
   UNFI direct-deposit advice with `-111`, `MCB` and `AVL` lines, a KeHE
   K-Solve-style deduction export, the deal sheet they came from and the
   backup. Synthetic, generated from one table the way `formats.ts` does, so
   the page, the totals and the truth cannot disagree.
2. **Lead with the door they already use.** Tarazi asked about "paystubs".
   Those are the remittance stubs UNFI and KeHE email. Email-in is live: the
   first thing they do on the call is forward one to their workspace address
   and watch it get held, opened and read. QuickBooks connect is the second
   door and the coverage story: "we show you what you are sitting on".
3. **End the call in their workspace, not ours.** A workspace per lead exists
   before the call (one SQL file), the founder is its owner, the lead's
   contact is its approver. The last ten minutes are them approving a packet
   the founder prepared. Nothing files. That is the LOI conversation.

## Build list, in order

Each item is a small PR with `pnpm verify` green. Estimates are for one
session. Nothing here touches a migration, an invariant or a threshold, so
no ADR is needed, with one exception marked.

| # | Build | Est. | Done when | Depends on |
| --- | --- | --- | --- | --- |
| P1 | **Natural-channel fixture pack** (`packages/fixtures/src/natural.ts`, suite `natural`): a UNFI-style direct deposit advice (five invoices, three short-paid: a `-111` shortage, an `MCB(yyyymmdd)` billback, an `AVL` late fee), the MCB backup page, a KeHE-style deduction detail (a spoils line and an MCB admin fee), a signed deal confirmation (`price_agreement`), a BOL and POD for the shortage. Generated text PDFs plus one "camera" rendition. Ground truth in the same file. Names invented; codes and patterns from `docs/plans/unfi-portal/research.md`'s seed list and the KeHE notes in `docs/onboarding/leads/tarazi-foods.md` | 6–8h | `formats.test.ts`-style test holds page to truth; `pnpm eval` lists `natural` as pending | — |
| P2 | **Record the `natural` cassettes** (`pnpm record:cassettes --suite natural`). **Spends money**, about $0.50; the founder says go | 1h | Suite scored; misses written into the suite README as findings, not hidden | P1 |
| P3 | **Beachhead codes on the decide form**: expose `promo_allowance_claimed`, `promo_not_agreed`, `promo_duplicate_allowance`, `promo_rate_mismatch`, `return_unsaleable`, `quality_expired_short_dated`, `compliance_otif`, `administrative_fee`, `freight_rate_mismatch` with natural-channel labels ("MCB billed against a deal we never authorised", "Spoils charged past the allowance"). No taxonomy change; a new code (slotting or new-item fee, recall disposal) is Phase 2 draft D and waits | 1–2h | `reason-words.test.ts` pins the list | — |
| P4 | **UNFI and KeHE seed code map as a document**, not a table: `docs/playbooks/unfi-natural.md` and `kehe.md`, each row "printed pattern → candidate canonical code → what backup decides it → source", from the research already in the repo. Draft D's tables get these rows when accepted. On the call this is the answer to "do you know our codes" | 2h | Two files, every row sourced | — |
| P5 | **Demo workspace on production**: `Harborline Foods` (the fixture name `pnpm render:web` already uses) from `create-workspace.sql`, founder as owner, a second team account as approver, debtors `UNFI` and `KeHE` with aliases (`pnpm link:retailer`). Upload P1's documents through the app so cases open the real way; leave one remittance un-uploaded for the call. Decide two cases, assemble one, approve one, so the queue shows every state | 2h, founder's clicks | The 20-minute demo runs end to end in it | P1, P3 |
| P6 | **A QuickBooks company for the demo.** Production keys will not open an Intuit sandbox company, so use a QuickBooks Online trial company holding the five demo invoices and the three short payments, connected from Settings → QuickBooks. The sync opens three ledger cases, and the Attach/merge flow ties them to the remittance's cases | 2h, founder | Coverage shows one completed run with three short-pays | P5 |
| P7 | **Sign-in mail a stranger receives** (pilot B5): confirm Supabase Auth's SMTP on production is custom, or set Postmark outbound and the sender DNS today. Test with an address outside the team | 1h plus DNS wait | VERIFY-CHECKLIST §2 passes for an outside address | — |
| P8 | **Lead workspaces**: one per lead from the same SQL file, founder owner, lead contact approver, nothing uploaded. Created the morning of the call | 15 min each | The lead signs in on the call | P7 |
| P9 | **Production click-throughs the demo will exercise**: VERIFY-CHECKLIST §11.1 (20 files), §11.2 (a 6 MB PDF gets our message), §11.4–11.7 (Assemble again, the letter, the zip) | 2h, founder | Each row ticked in the checklist with its date | — |
| P10 | **The materials** (`docs/onboarding/PRE-SELL-CALL.md`, this PR): the script, the one-pager, the data-handling note with the sub-processor list, and the limits we say out loud | done | — | — |
| P11 | **Rotate the exposed AWS key and worker token** (`docs/plans/ariba-portal/STATUS.md`). Not customer-facing. Do it before a customer document is stored anywhere near that worker | 30 min, founder | New key in IAM; old one deleted | — |
| P12 | **Proactive paging decision** (ADR 0053 §6). UNFI natural remittances can run past 120 rows, and a dense one fails loudly in the app today. The WIP branch `claude/paged-extraction-in-production` is one untested commit. Options: (a) a step per two-page part inside the Inngest job, (b) raise `maxDuration`, (c) tell pilots to split at 100 rows. **Default for pre-sell: (c)**, said in the limits; decide (a) before the first pilot uploads a backlog | — | Founder's answer recorded on ADR 0053 | — |

## Two weeks

| Day | Work |
| --- | --- |
| 1–2 | P1 fixture pack; P3 codes; P4 code-map docs; P7 SMTP started; P11 rotation |
| 3 | P2 record (founder's go); P9 click-throughs |
| 4 | P5 demo workspace populated; P6 QuickBooks trial company |
| 5 | Dry run of the 30-minute script twice, timed; fix what breaks |
| 6–7 | First call (Tarazi). P8 their workspace that morning |
| 8–10 | Fix what the call exposed; second call (Anthem) once their doors are known |
| 11–14 | LOI follow-ups; pilot terms; pilot week-one routine staffed (ONBOARDING §6) |

## Parked, on purpose

Not before the LOIs, however tempting on a call:

- **Portal read** of UNFI or KeHE (ADR 0058 paused). Say: "we read the
  remittance you already get; pulling from myUNFI directly is next, after
  UNFI's terms are read and you give us a read-only login."
- **Filing for them** (ADR 0061 accepted, unbuilt). Say: "you paste the
  confirmation number; we never file without your approval, and the database
  will not let us."
- **Phase 2**: playbook tables, the model's decision, expected-value routing,
  calibration. All proposed; none needed to close an LOI.
- **QuickBooks posting** (built, off). Show the draft entries; do not switch
  it on for a lead.
- **Large uploads** (ADR 0055). "Send it to us" for a backlog over 4 MB a
  file.
- **NetSuite, EDI 812/820**, digests and reminders.

## What each lead's call has to answer (for the build, not the pitch)

- **Tarazi:** which "planner" (UNFI Promotional Planning in the Supplier
  Portal, KeHE CONNECT Promotions, or the broker's calendar); who at the
  broker submits deals and who chases deductions today; whether UNFI backup
  arrives by email or is pulled from myUNFI; whether their ledger is
  QuickBooks Online; their foodservice distributor; how many remittance
  emails a month. Each answer either turns on a door we have or names one
  we do not.
- **Anthem:** whether they sell to Lowe's, Wegmans, Costco and United direct
  or through a distributor; whether a broker submits their promos; who
  co-packs and ships (the label says Glenwood Snacks, Idaho) and so who
  holds the BOL and POD; their ledger; whether retailer deductions reach
  them as portal notices, EDI 812s or remittance stubs. If it is Costco or
  Walmart.com direct, their notices come through retailer portals we have
  not read, and upload plus email-in is the honest answer for a pilot.
