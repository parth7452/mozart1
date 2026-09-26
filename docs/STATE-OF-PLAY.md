# State of play

*2026-09-25*

A supplier can sign in, upload a deduction notice, and get back a case where
every extracted field traces to the quote it came from — and then take that case
all the way through Phase 3 in the deployed app. One production case has been:
decided, assembled into a packet, approved by the second member, filed and given
an outcome (2026-09-21, ending `partial`). The ledger sync, fixed by ADR 0035
and ADR 0036, ran against the QuickBooks sandbox on 2026-09-23: nine invoices
read, three short-pays found — two opened as cases, one declined — and no
anomalies, where the first run (2026-09-22) found nothing and eight anomalies.
Email-in went live on 2026-09-25: a notice emailed from Gmail to an issued
address was held because it came by email, and a person opened its case.

## Live in production

Verified on the deployed app, not only in tests:

- **Sign-in** by magic link, resolving a tenant rather than creating one
- **Case list and review**, through the same RLS policies as everything else
- **Upload → case.** A scanned Walmart notice went in as a JPEG and came back
  with every field quote-verified against the OCR text layer — the whole chain
  against real vendors: ClamAV, Claude to classify and extract, Reducto for the
  text layer a scan has no other way to get
- **A second member with role `approver`**, so separation of duties has a person
  to exercise it: the preparer of a decision cannot approve it
- **Phase 3 end to end.** One case: `case.discovered > case.classified >
  decision.recorded > packet.assembled > approval.granted >
  submission.recorded > outcome.recorded`, state `partial`. The approval
  trigger admitted the submission because an approval named that decision
- **The Inngest binding.** The concurrency cap fits the plan, the app is
  synced, and the ledger sync ran as a job acting as the connection's member
- **A sealed QuickBooks credential** (ADR 0033): one connection, its token set
  stored as ciphertext and rotated as new rows
- **Email-in** (ADR 0047), 2026-09-25: `in.mozart.financial`, its MX at
  Porkbun, both Production variables set. A PDF notice emailed from Gmail to
  an issued address was answered 200 on its first delivery, recorded with
  aligned DKIM "pass", scanned, read as a `deduction_notice` at 0.99 and held
  `by_email`. **Open a case from it** opened DN-2609-003 for $2,000.00 with
  `confirmed_by` on `case.discovered`, `document.hold_released`, and no
  further model call
- **QuickBooks on production keys** (ADR 0039), 2026-09-24. The sandbox
  connection was disconnected from Settings → QuickBooks at 18:47 UTC, and
  Intuit confirmed the revoke. Intuit's production keys went onto Vercel
  Production at 18:57. At 19:00 a production company was connected through
  the app, and its first sync finished three seconds later. The sandbox
  connection's tokens had already been refreshed, and re-sealed through the
  live KMS, eight times since 2026-09-22

The scanner runs as its own container on Fly, with clamd bound to loopback
behind a token-checked HTTPS endpoint (ADR 0018). Verified directly: a clean
file passes, the EICAR test file is flagged by name, unauthenticated callers get
401. Until 2026-09-25 its Fly organization was on the free trial, which stops
every machine 300 seconds after it starts, whatever `fly.toml` says. Eight of
the first ten production scans waited 36–51 seconds for a cold start, and the
first emailed notice used 51 of its route's 60. Billing is on now, and the
machine stays up.

Production (Supabase `hvheqbgkvwhlqutklwfh`) carries migrations through 0034 (0034, ADR 0047, on
2026-09-24 at 21:37, after `mozart-preview`, read back on both). 0028 and
0029 were applied 2026-09-23 after being staged on the preview project
(`jvbnqofmoamyhntjwjdn`) the same morning, 0030 (ADR 0039) that afternoon and
0032 (ADR 0042) and then 0031 (ADR 0041) that evening, preview first each time.
0031 landed after 0032 because it merged after it; the two touch different
objects, so the order does not change the end state. Read back: Supabase's request roles
hold nothing in `public` or `app`, `authenticated` no longer reaches `app_rw`,
`recouple_app` still does, every `app` function's `search_path` is pinned again
(invariant 7's guard included), and the coverage denominator counts each
deduction once. Both conditions ADR 0037 set before the Data API is switched
off are met: the ledger sync ran at 15:25, and both members signed in through
`app.mozart.financial/auth/callback` at 16:35 and 16:36 — and the Data API was
switched off the same afternoon, with no error in the app's logs after it.

## Built, not yet exercised

The gap between *it worked once* and *it works*:

| | What would prove it |
| --- | --- |
| **Roles** | A `read_only` member is refused an upload and a decline in the UI. The DB policy enforces it and a Postgres test proves it refuses; nobody has watched it happen |
| **A second tenant** | Two orgs, each seeing only their own cases, through the app rather than through SQL |
| **Email-in's failure paths** (ADR 0047) | The main path is live (above). Not yet exercised: forged `X-Spam-*` and `Authentication-Results` headers, an unaligned sender, an iPhone photo, mail over the size limit, a non-token recipient, a wrong secret's 401 being retried, and `pnpm sweep:inbound` against a real failure. Each is in `docs/VERIFY-CHECKLIST.md` §5.6–5.8 and comes before any customer is given an address |
| **The review queue** (ADR 0043) | **The sweep is exercised.** Production's two ledger cases ($450.00 and $239.00) moved to `classified` on 2026-09-23 at 21:49 UTC, when the founder invoked the fan-out from the Inngest dashboard: the run logged `classified 2`, and each case carries one `case.classified` event. What would prove the rest: their case pages offering decide and decline, and one of them decided from the queue |
| **Closed sign-ups, and the claims guard** (ADR 0045, migration 0033) | 0033 was applied to `mozart-preview` and then production on 2026-09-24 and read back on both (md5, both functions still definer and pinned, same results and grants, a `sub`-only caller refused). The web half deployed on merge. What would prove it: both members sign in through the new form; an address with no auth user gets the same "sent" page and no mail, with `otp_disabled` in the log; a person invited from the dashboard follows the invitation once and then signs in from the form; then the founder switches off "Allow new users to sign up" |
| **The dense path** | A 42-row remittance is 63s of model time in the recorded cassettes; the Inngest job is the answer to that and has not yet been given one |
| **Failure alerts** (ADR 0052) | A `recouple/alert.test` event sent from the Inngest dashboard emails `ALERT_EMAIL_TO` a `[TEST]` message, once `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` and `RESEND_API_KEY` are set on Vercel Production. Then the first real failure's email names the job, the run, the error class and a link, and nothing off a document |
| **The classification floor** (ADR 0044) | A real notice or remittance classified below 0.950 is held in production — listed under "Read, not on a case" with its confidence, not read again on "Read again" — and "Open a case from it" opens its case with `confirmed_by` on `case.discovered` and no new `model_calls` row. Every real one read so far has been at 0.95 or above, so nothing in production has been held yet |

Each row has a click-through in `docs/VERIFY-CHECKLIST.md`: the steps, what the
screen should say, and the query or log line that proves it.

## Blocked, and on whom

| Blocker | Who | Why it matters |
| --- | --- | --- |
| Real customer documents | **you** | No fixture is a customer's. See *What not to claim* |

## Where the phases stand

Against the build order in `CLAUDE.md`:

- **Phase 0 — foundations.** Done. Approval trigger, append-only tables, hash
  chains, RLS, the SQL invariant suite, money maths, the case state machine.
- **Phase 1 — ingest + classify.** Substantially done and live, including the
  Inngest binding (ADR 0021). Remaining: fixtures for formats still missing.
- **Phase 3 — packet, approval, submission, outcomes.** **Complete, and run
  once end to end in production** (PRs #5, #7, #8, #9), ahead of 1.5 and 2 per
  ADR 0020, with the dispute decision made by a human rather than by Jev:
  - **ADR 0020** and **migration 0016** — a human `decisions` row
    (`provider = 'human'`, non-null `prepared_by`), the append-only `packets`
    table, an approval that names the packet it approved
  - **The workflow store** — `CaseWorkflowStore` implemented over Postgres as
    `app_rw`; every refusal a named `CaseWorkflowError`
  - **The case-page actions** — five cards and five POST routes, each shown only
    where the state machine and the member's role allow it, and the approve card
    never to the preparer
  - **ADR 0022** and **migration 0017** — `packet_hash`, `confirmation_number`
    and `submitted_at` frozen, so the record of what was filed cannot be
    rewritten after the fact
- **Phase 1.5 — ERP read + triage.** ERP read is built: QuickBooks behind the
  `AccountingSource` port (ADR 0026), a daily sync as a member (ADR 0031), a
  sealed token store (ADR 0033), a window anchored on payments (ADR 0035), credit
  memos read as not cash (ADR 0036), short-pays opening cases, and a customer's
  owner connecting their own company from Settings → QuickBooks with every token
  refresh serialized per company (ADR 0039, deployed 2026-09-23). Triage step
  A is built (ADR 0043): the case list opens with a review queue over what the
  sync and the uploads open, most urgent first, and a ledger case can be
  decided the day it opens. Step B, a shadow-only model tier, is designed and
  waits on Jev access.
- **Phase 2 — evidence + decision.** Not started. Phase 2's model decision lands
  in the slot Phase 3 has already used, with a corpus of human decisions in the
  same `schema_id` to score against.

The case state machine has 14 states. One production case has reached
`partial`, through every Phase 3 transition; `won`, `lost`, `written_off` and
the states between are still exercised only in tests.

## What the store gives back

A production case answered its review page with a 500 on 2026-09-21: a staffing
notice whose one line named no item came back out of the store with no `sku_upc`
key at all, and reconciliation read straight through it. Both layers are fixed
(PR #16). Every store now rebuilds a stored document through `restoreDocument`
— the reader's own `reassemble` and the document type's own schema — so the two
answer identically, which is asserted as a contract test against a real
database.

The same round trip has a second, quieter failure, and it is closed in the same
change. `flattenExtraction` stores no row for a value it cannot point at, so a
*required* field read without a page or a quote comes back absent and the
document stops being typed. That used to cost the case every line it had. Now
`readDocument` says so at the write (`document.stored_without_provenance`, ids
and field paths only) and reads the document anyway, and `reconcileCase`
reconciles over it, naming the fields it could not read — blocking only when one
of them carries money, because that is the arithmetic. Two more gaps went with
it: an unusable `pod` is reported even when a `bol` parsed, and `correspondence`
now reaches `reconcileNotice`, which is what makes LOG-001's findings reachable
from a case page at all.

## Evals

Ten recorded suites, each scored separately and never blended (the table is in
`CLAUDE.md`). The newest, `public` (2026-09-25), is the first built from real
documents: ten public records from ExtractBench, scored against ExtractBench's
verified answers. 97.9% recall and precision, 10 of 10 classified. Recording it
found the upload door refusing three real invoices and orders for their fonts'
names; that is fixed. Its scanned half, `public_scanned`, read through Reducto:
93.9% recall and precision, 10 of 10 classified, but only 79.7% of quotes
checked. The values are right. The gaps are one scan citing a page it does not
have, and quotes of whole table rows that Reducto stores as HTML cells. No suite
is pending.

A one-time check of 160 scanned office papers (RVL-CDIP) opened no case: the
two pages read as payment advices really are check stubs, and both scored
below the floor (`docs/audits/rvl-cdip-classification/`).

## What not to claim yet

- **That production holds only real tenants.** On 2026-09-25 at 22:46 UTC the
  integration tests ran against production as its owner and left 72 test
  organizations, 103 `@example.test` users, 507 cases, 19 documents, 17 debtors
  and 7 ledger connections. They are append-only, so they stay; each sits in its
  own organization under RLS, and the six enabled connections were disabled by
  hand. Any count across the whole fleet includes them. The tests now read
  `TEST_DATABASE_URL`, never `DATABASE_URL`, and a guard refuses any test run
  that could reach a database that is not a throwaway
  (`docs/audits/tests-against-production/`).
- **A recovery rate.** One case in production carries a filing and a `partial`
  outcome — the Phase 3 end-to-end run. One case is not a rate, and no fee has
  been invoiced (Phase 4).
- **No fixture is a customer's.** Every suite is synthetic except `public`,
  which is ten government and Medicaid records, none of them a deduction. The
  eval numbers measure documents we generated or took from public test sets.
  They are a floor, not a result.
- **The OCR starter pack stamps every page `SYNTHETIC TRAINING SAMPLE`**, and
  its own README warns that marker can become a shortcut feature. A classifier
  scoring 100% on it may have learned the watermark. LOG-001 carries no such
  banner and a test keeps it that way.

## Next

1. ~~**Click through QuickBooks connect** against the sandbox: Connect, first
   sync, Disconnect (and confirm Intuit's revoke), Connect again. Only then the
   production QBO keys.~~ **done** (2026-09-24), ending on a production
   company connected with the production keys.
2. ~~**Coverage and ledger anomalies on a page.**~~ **done** — `/coverage`: a
   rate per channel over the last 12 months, the month-by-channel table, and
   the ledger sync's runs and anomalies per connection.
3. **The customer pack's misses.** Recorded 2026-09-22: 97.6% / 97.6%, grounding
   92.9%, 13/15 classified, and the STF-201 camera pages ground at 64–83%. The
   service order no longer reads as a `po` (2026-09-23). The review floor is now
   the product's (ADR 0044, built): a notice or remittance below the tenant's
   floor, or whose reading does not fit its type, is held under "Read, not on a
   case" for a person to open or attach, so `stf-203-short-payment-notice` — a
   notice read as a remittance at 0.75 — no longer opens a case per line. A
   misread *evidence* type still opens nothing either way and is not gated.
   **2026-09-24:** every classification re-asked at temperature 0 (the same two
   misses, so they were the prompt, not the draw), then the classifier's
   definitions sharpened — a short payment notice is a notice, "advice" alone
   decides nothing, and a note written for one's own file is not
   correspondence. 57/57 classified, `customer` 15/15, and no recorded notice
   or remittance is below the floor any more. The column-rule fix took
   `customer` grounding to 98.2%. Left: `stf-203-short-payment-notice`'s reason
   code and `log-202-rate-confirmation`'s counterparty.
4. ~~**Decide how a confirmed duplicate merges.**~~ **built** — ADR 0042,
   migration 0032: "Same deduction" merges in one click, the database moves the
   copy to `merged`, coverage counts the pair once, and an undo puts it back.
   0032 applied to `mozart-preview` and then production on 2026-09-23 and read
   back on both. Not yet exercised on real data: no pair has been confirmed.
   **Not everything is closed:** five ways one deduction still counts twice
   or three times, silently, are written down with reproductions in
   `docs/audits/duplicate-counting/` (2026-09-24).
5. **Triage**, the rest of Phase 1.5.
   Step A is **built** — ADR 0043: a deterministic review queue in four
   buckets, and ledger cases that open `classified`. Step B, a shadow-only
   model tier, has its conditions fixed in the ADR and waits on Jev access and
   both cassettes.

## Follow-ups this change created

Both of these are **done**, in ADR 0024 and migration 0019 — one change, because
freezing the table is what settled how the other had to be answered. What each
one was, and what it became:

1. ~~**The pre-provenance cases cannot be declined, and no script can fix
   that.**~~ **done.** Cases opened before ingest recorded arrivals have notices
   with `documents.upload_id` null, and `declineCase` refused them by name
   rather than attributing the decline to a guessed channel. There was nowhere
   honest for a backfill to write: `documents` is append-only, so `upload_id`
   cannot be filled in afterwards, and `uploads` had no column pointing back at
   a document. Migration 0019 adds the one thing that was missing —
   `document_arrivals`, at most one row per document, append-only,
   `recorded_by` not null, and `app.arrival_only_when_unknown()` refusing any
   document that already names an upload, so it records what nothing observed
   and never overwrites what something did. A nullable `uploads.document_id` was
   the obvious alternative and is rejected in the ADR: wrong cardinality (one
   email, three attachments), two links that can disagree, and unfillable in any
   case because the arrival is written *before* the bytes are stored.

   `pnpm link:provenance` is how a person writes one, and the note this
   follow-up left for whoever wrote it was followed exactly: `--source` is
   required and has no default, because "`ingestInboundEmail` has never had a
   production caller, so every pre-provenance production document arrived by web
   upload" is an assertion about this deployment rather than a derivation from
   anything in the database. It lives in ADR 0024 §3 and in an operator's typed
   argument — and the *database* refuses any other channel, not just the script:
   `app.arrival_only_when_unknown()` already reads the `uploads` row to check its
   org, so it also refuses one whose `source` is not `web_upload`, `email_in` or
   `email_body`. The other three channels write an arrival at ingest, so they
   could not have delivered a document that records none. `declineCase` reads
   observed-or-asserted and the refusal now names the command rather than naming
   a migration nobody had written.

   The thing this was going to leave behind did not have to be left. An earlier
   draft accepted that a `declined_candidates` row attributed through an asserted
   arrival would be indistinguishable *in that table* from one derived at ingest,
   on the grounds that the table is append-only and a column meaningful only for
   new rows is worse than a paragraph. Production has zero declines and zero
   recorded uploads, so there is no history for a default to mislabel: 0019 adds
   `provenance_kind` (`'observed'` / `'asserted'`, ADR 0024 §4) while the window
   is open, set by `declineCase` from which of the two joins answered. Who
   asserted it, when and why are still on the `document_arrivals` row, in
   `uploads.created_by` and on the case's `document.provenance_recorded` event —
   the column is for counting, those are for auditing.

2. ~~**`uploads.source` is mutable; ADR + migration to make `uploads`
   append-only now that coverage depends on it.**~~ **done.** `uploads` was in
   migration 0006's `mutable` list, so `app_rw` held UPDATE and DELETE on it and
   there was no `no_update_delete` trigger — harmless while nothing read the
   column, and not harmless once `declined_candidates.discovered_from` was
   derived from it: an UPDATE would re-label which channel found a deduction
   *after* the declines attributed to it were counted, moving a published
   coverage number with no record that anything moved. Migration 0019 moves it
   to the append-only set on 0004's pattern — revoke UPDATE/DELETE/TRUNCATE from
   `app_rw` and `app_ro`, plus `no_update_delete` and `no_truncate` on
   `app.block_mutations()`, because the revoke answers for the application roles
   and the trigger is what answers for the table owner.

   One correction to how this item was written. "A correction should be a new
   row rather than an edit" is the rule everywhere else here and it does **not**
   hold on this table: `documents.upload_id` is itself immutable, so a second
   `uploads` row is a row nothing joins to and nothing counts. A source recorded
   wrongly at ingest is uncorrectable in place *and* uncorrectable by a new row;
   fixing one is a migration-backed decision, which is the same dead end
   `ProvenanceUnknownError` has always named. ADR 0024 §2 says so plainly rather
   than leaving the usual sentence to imply otherwise. The cost is small because
   `uploads.source` is set from the entry point rather than typed by anyone, so
   a wrong value is a bug in orchestrator code, not an operator's typo.

   `supabase/tests/14_an_arrival_is_a_fact.sql` reads the end state back after
   `db-test`'s second pass: UPDATE, DELETE and TRUNCATE refused for `app_rw` by
   grant and for the owner by trigger, INSERT still working for a writer, the
   grants exactly INSERT and SELECT, a `read_only` member still refused by RLS,
   RLS on and cross-tenant reads empty on `document_arrivals`, nobody holding
   EXECUTE on the definer guard, a refused arrival leaving no orphan `uploads`
   row, and both values of `provenance_kind` landing on the right decline.
   `supabase/tests/15_every_table_has_rls.sql` is the general form of one of
   those: every table in `public` carries `relrowsecurity`, by enumeration, so a
   future table cannot ship without it.

Production carries both: migration 0019 was applied on 2026-09-21.
