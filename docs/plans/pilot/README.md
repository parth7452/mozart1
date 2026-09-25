# Pilot readiness: the first customer by Monday

*Drafted Friday 2026-09-25, 13:30 ET, against `origin/main` at `90bd649`.
Target: customer #1 onboarded **Monday 2026-09-28, 09:00 ET** (T+68h), then the
rest of a 17-company waitlist (foodservice manufacturers and logistics) over the
following weeks. **A plan, not a build.** Nothing here is implemented yet, and
each item waits for the founder's go.*

## The call, in plain language

Run customer #1 as a **done-with-you pilot on what is already live**. Build only
the handful of things a real customer would hit on day one. Everything else is
done by us by hand, or waits.

This is the plan, not a detour from it. Every gate ahead needs real customers:

- Stage 3's go/no-go is a recovery rate measured end to end (STRATEGY §9).
- Phase 2's model decision needs **≥ 30 human decisions** to score against
  (task 10).
- Its calibration needs **≥ 50 recorded outcomes** (task 11).
- Real customer documents are the one blocker `STATE-OF-PLAY.md` names.

So none of Phase 2's plan is cancelled. Its data-hungry steps get their data
from the pilots.

## Where the build stands

| Phase | State |
| --- | --- |
| 0 Foundations | **Done** |
| 1 Ingest + classify | **Done and live**: upload, email-in, OCR, the scan gate. Eleven eval suites, all on synthetic or public documents |
| 3 Packet, approval, filing, outcome (a person decides, ADR 0020) | **Built.** Run once end to end in production (2026-09-21). Denial and re-file (ADD-5) are not built |
| 1.5 QuickBooks read + triage | **Built and live** on Intuit's production keys (2026-09-24). Triage step B (the Jev model) waits on Jev access |
| 2 Evidence, model decision, playbooks, portal read | **Designed** (drafts A–H, tasks 01–13). **Not started** |
| 2.5 EDI 812/820 | **Not started.** Only a printout fixture exists |
| 4 QuickBooks write-back + contingency billing | **Not started.** The fee maths exists and nothing calls it |
| 5 Learning loop · 6 Careful autonomy | **Not started** |

## What a customer can do today

Each of these is live in production.

- **Sign in** by magic link. Access is by invitation only.
- **Get deductions in**, three ways:
  - **upload** a PDF or an image;
  - **email** it to the workspace's address, where it is held until a person
    opens it with one click;
  - **connect QuickBooks** Online, whose daily sync (07:00 UTC) opens a case
    for each short-paid invoice.
- **See what to work on next:** a review queue ordered by deadline, and a
  searchable ledger of every case.
- **Review a case:**
  - every field comes with the quote it was read from, beside the original
    document;
  - cross-document findings (for example, "arrived before the appointment");
  - evidence can be added.
- **Decide** to dispute (with a reason and a rationale) or decline (with what
  the case was worth and what was missing).
- **Assemble** a packet, which a **second person approves**.
- **Record** the filing's confirmation number, then the outcome and the amount
  recovered.
- **Handle possible duplicates**: confirm, merge, or undo.
- **Coverage**: found against filed, per channel, plus the ledger anomalies
  worth a look.

## What a pilot customer will hit

### Blockers: fix before Monday

| # | Gap | Evidence |
| --- | --- | --- |
| B1 | **The packet cannot be sent as it is.** The cover sheet is a Markdown field list headed "Retailer", with the raw reason code (`compliance_late_delivery`). It has no supplier name, addressee or invoice number. Files download one at a time, and there is no PDF or zip | `core-domain/src/packet.ts` `buildPacketNarrative`; `apps/web/app/cases/[id]/packet/route.ts` |
| B2 | **Large files probably fail with a bare error.** The app allows 25 MB (`UPLOAD_MAX_MB`), but Vercel refuses a function request over 4.5 MB before our code runs (ADR 0047 records this for email, in its context item 8). Not yet confirmed on `/upload` | `apps/web/lib/notices.ts:75` |
| B3 | **One file per upload.** A backlog of 100 documents means 100 form submissions | `apps/web/app/upload/route.ts` |
| B4 | **No sign-out button and no workspace switcher.** The session already honours a `recouple_org` cookie and `/logout` exists; there is no control for either. Our analysts working inside several customers' workspaces need both, and so do broker agencies | `apps/web/lib/session.ts:66`; VERIFY-CHECKLIST *Found while writing this* #8 |
| B5 | **Sign-in email may not reach customers.** Magic links and invitations go through Supabase Auth's mailer. The repo's own note says the built-in SMTP is rate-limited and "fine for a handful of testers, not for customers". Whether production has custom SMTP is not recorded. Sender DNS can take hours to verify, so check it **today** | `docs/supabase.md` *Auth settings to check* |
| B6 | **A one-person workspace cannot finish a case.** The preparer may not approve, and a decision is append-only, so a lone member's dispute waits at `awaiting_approval` until somebody else who is an owner or approver approves it. Every pilot workspace needs that second member from day one. In done-with-you, that is the customer's controller | `app.enforce_separation_of_duties()`, migration 0005 |

### Quality gaps: fix if there is time, otherwise work around

| # | Gap | Workaround until fixed |
| --- | --- | --- |
| Q1 | **Most cases have no dispute deadline.** Remittance-line and QuickBooks cases never get one, and about 65% of the fixture notices print none | Put the customer's per-payer windows in the onboarding notes. The queue falls back to age |
| Q2 | **The decide form offers 20 of the 47 canonical codes.** Short-dated, unsaleables, detention, missed appointment, routing guide and administrative fee are in the taxonomy but not on the form. There is no billback code at all | Use "Something else" and say what it is in the rationale |
| Q3 | **Duplicate F1:** a notice and then its remittance line open two cases that are never listed as a pair | Watch for them by hand. Do not quote coverage numbers to a customer yet |
| Q4 | **Onboarding is manual:** four SQL inserts plus a dashboard invitation per person. The invitation link lands on a signed-out page | The runbook (E8) and a welcome email that says "then sign in from the form" |

### Limits to tell the customer: not fixed in 68 hours

- **File types:** PDF, PNG, JPEG, GIF and WebP only. No TIFF, HEIC, XLSX, CSV
  or Word.
- **Size:** about 3.3 MB of attachments per email.
- **Dense documents:**
  - a remittance past about 120 rows fails loudly (the extraction output
    budget), so large distributor remittances need splitting;
  - a PDF over 100 pages is refused.
- **Ledgers:** QuickBooks Online only. No NetSuite, Sage or Dynamics.
- **Filing is theirs.** We file nothing, and there is no per-payer portal
  guidance (that is playbooks, Phase 2).
- **Two people per case:** the preparer cannot approve their own decision.
- **Nothing is sent to anyone:** no reminders or digests.
- **Billing is by hand** on recovered cash.

## The 68 hours

**Friday (now to 23:00): decide and gather.** Founder.

- Answer the five decisions at the end of this document.
- Get **10–20 of customer #1's real documents** under NDA today: notices,
  remittances and the backup behind them. Saturday's and Sunday's testing runs
  on these.
- **B5, today:** check Supabase → Authentication → SMTP settings on production.
  If it is the built-in mailer, set up custom SMTP (Postmark outbound is
  already a vendor) and start the sender-domain DNS now.
- Pilot terms. `org_settings.fee_pct_bps` defaults to 25%. Invoicing is by hand.
- A one-page data-handling note listing the sub-processors: Supabase, Vercel,
  Anthropic, Reducto, Fly.io, Postmark, Inngest, AWS KMS and Intuit.

**Saturday: build and verify.** Four parallel sessions. Each change is a small
PR with `pnpm verify` green.

| # | Build | Est. | Done when |
| --- | --- | --- | --- |
| E1 | **A payer-facing packet.** A new, still deterministic narrative template: from the supplier (`organizations.name`) to the payer; the claim, invoice number(s), amount and date; the reason in words; the rationale; the enclosures. Plus a printable view (Save as PDF) and a streamed zip of the enclosures. The template changes the hash of **new** packets only, so what the approver approves is exactly what is sent. Also offer **Assemble again** while a packet awaits approval: the store allows it, but the card disappears, so evidence added after assembly can never get in | 6–8h | Packet tests updated to the new template, not weakened; a case in the test workspace yields a letter and a zip |
| E2 | **An honest size limit.** First upload a 6 MB PDF to production to confirm the cap. If it fails: check the size in the browser before sending, set the server limit to match, and tell the user what to do instead | 2–3h | A 6 MB file gets our message, not Vercel's |
| E3 | **Multi-file upload** on the case list and the case page: one request per file, in turn, with a result per file | 4–5h | 20 files go in with one selection |
| E4 | **Sign-out and a workspace switcher**: a POST that sets `recouple_org` after checking membership, plus the controls in the sidebar | 2–3h | One identity in two workspaces moves between them |
| E5 | **Expose the existing codes** the pilot verticals need on the decide form. No change to the taxonomy: new codes such as billbacks are ADR-tracked, in Phase 2 task 04 | 1h | Codes and labels in `case-actions.tsx` |
| E6 | **A deadline a person enters**, only where none is recorded, with a `case.deadline_set` event naming who entered it and on what basis. A printed deadline is never overwritten | 3–4h | Remittance and QuickBooks cases can carry a deadline |
| E7 | **Duplicate F1**: also append `case.possible_duplicate`, plus a one-off backfill (`docs/audits/duplicate-counting/`). No migration | 3h | The notice-then-remittance repro is listed as a pair |
| E8 | **An onboarding runbook**: one parameterised SQL block (organisation, settings, users, memberships, the customer's payers as debtors), the dashboard invitation, `pnpm link:retailer` for the aliases, and the welcome email | 2h | The test workspace is rebuilt from it with no edits |

Founder on Saturday: run VERIFY-CHECKLIST **§2** (sign-in), **§4** (a second
workspace, which becomes the dry-run workspace) and **§3** (read-only). Add
**§5.6–5.8** if customer #1 gets an email address on day one, and **§8** if
they are foodservice (dense remittances). Also turn on failure alerts in
Inngest and Vercel.

**Sunday: dry run and freeze.**

- Take customer #1's real documents through the test workspace, end to end:
  upload, email, QuickBooks, decide, packet, approve, filing, outcome.
- Log every miss. A misread field is a finding, not a reason to hide the field.
- Fix only after 18:00. **Go/no-go at 20:00**:
  - §2, §3 and §4 pass;
  - an address outside our team receives both the invitation and a sign-in
    link (B5);
  - every real notice or remittance opens a case, or is held with a reason;
  - one case has reached `approved` with a packet a person would send;
  - their largest file has a documented path in.
- Freeze at 22:00, deploy, and smoke-test production.

**Monday 09:00: onboarding call** (60 minutes).

1. Both users sign in.
2. The owner connects QuickBooks, which queues the first sync.
3. Upload the first batch together and watch the cases open.
4. Walk one case from the quotes to an approved packet.
5. Agree the backlog hand-off, the filing routine and a weekly review.

In week one, a person from our side does these every day:

- check every held document and every failed read;
- run `pnpm sweep:inbound`, if email-in is on.

A customer's outside accountant can be given `accountant_guest`, which sees
everything and changes nothing.

## Not in the 68 hours, on purpose

- **Phase 2**: Jev and Claude providers, EV routing, calibration, playbook
  tables, portal read.
- **Phase 4 billing**: the first outcomes are 30–90 days away, so invoice them
  by hand.
- **Integrations**: EDI, NetSuite and Xero.
- **Self-serve**: sign-up and a team-invite screen. An invitation needs the
  Supabase admin API, and the service role never goes in a request path
  (invariant 6).
- **Dense remittances**: paging them.
- **More file types**: XLSX/CSV import, TIFF and HEIC.
- **Duplicates F2–F5**: each needs an ADR.
- **Large files**: direct-to-storage upload needs an ADR, because it is a new
  place where unscanned bytes sit.

None of the seven invariants moves for the pilot.

## After Monday: onboarding the other 16

| When | Work |
| --- | --- |
| Week 1 (Sep 28 – Oct 2) | Fix what customer #1 hits. Email-in's failure paths (§5.6–5.8), then give out addresses. Large-file upload (ADR). "Found while writing this" #5 (a decline leaves no trace) and #6 (dash lines). The case-list figures count declined cases as open |
| Week 2 (Oct 5–9) | Customers 2–5, batched by vertical. Paged extraction for dense remittances. Spreadsheet deduction reports (ADR: a cell's provenance). TIFF and HEIC. A daily digest of held documents and deadlines (ADR: it is a new outbound side effect) |
| Weeks 3–4 (Oct 12–23) | Customers 6–17. Phase 2 task 04, playbooks, seeded from the pilots' own payers: computed deadlines and the payer-code map, once draft D is accepted. Tasks 01, 02 and 05 need no data. Duplicates F2–F5 (ADRs), before any coverage number is shown to a customer as a result |
| Month 2 | Phase 4 billing once outcomes land, counting recoveries per surviving duplicate group first (audit). Phase 2 tasks 06, 10 and 11 as decisions and outcomes accrue. Jev when access arrives |

**What limits scale is people, not compute** (STRATEGY §8). Every filing needs a
person's approval. Measure analyst minutes per case in week one: that number,
not the software, sets how fast the other 16 can come on.

## Decisions needed now

1. **The operating model.** We recommend done-with-you for pilots 1–5: our
   analyst prepares and the customer's controller approves. The alternative is
   self-serve.
2. **Customer #1.** Which vertical, whether they use QuickBooks Online, their
   top payers, and how they file today (portal or email).
3. **Email-in.** On day one (run §5.6–5.8 on Saturday) or in week one.
4. **Terms.** The contingency percentage, the pilot's length, and invoicing by
   hand.
5. **Scope.** Approve E1–E8 as the build list, and name anything to cut.
