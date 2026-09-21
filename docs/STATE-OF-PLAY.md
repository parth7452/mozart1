# State of play

*2026-09-21*

A supplier can sign in, upload a deduction notice, and get back a case where
every extracted field traces to the quote it came from. Phase 3 is now complete
**in code**: a reviewer can decide, assemble a packet, have a second person
approve it, record the filing and record the outcome. None of that has been run
through the deployed app yet, because the production app is not synced with
Inngest — that sync is what stands between here and the first end-to-end run.

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

The scanner runs as its own container on Fly, with clamd bound to loopback
behind a token-checked HTTPS endpoint (ADR 0018). Verified directly: a clean
file passes, the EICAR test file is flagged by name, unauthenticated callers get
401.

Production (Supabase `hvheqbgkvwhlqutklwfh`) carries migration 0018, applied
2026-09-21 — the filed record is immutable there too, and complete when
written, not only in test.

## Built, not yet exercised

The gap between *it worked once* and *it works*. Each of these is implemented
and tested in isolation and has never been run through the deployed app:

| | What would prove it |
| --- | --- |
| **Phase 3 end to end** | One case: decide → assemble → approve as the second member → record the filing → record the outcome, in the deployed app. Blocked on the Inngest sync below |
| **The Inngest binding** | ADR 0021 chooses the job path by environment. The production app has **not** been synced with Inngest: the sync was refused because the app declares a concurrency cap above the plan limit. Fix in flight |
| **Roles** | A `read_only` member is refused an upload and a decline in the UI. The DB policy enforces it and a Postgres test proves it refuses; nobody has watched it happen |
| **A second tenant** | Two orgs, each seeing only their own cases, through the app rather than through SQL |
| **Email-in** | Postmark is built. Has a real email ever opened a case? |
| **The dense path** | A 42-row remittance is 63s of model time in the recorded cassettes. The Inngest job is the answer to that; it is the same sync that is blocked |

## Blocked, and on whom

| Blocker | Who | Why it matters |
| --- | --- | --- |
| Inngest sync (concurrency cap over the plan limit) | **next change** | Nothing about Phase 3 can be demonstrated end to end until the deployed app registers its functions |
| `ANTHROPIC_API_KEY` for cassette recording | **you** | LOG-001 is wired and self-consistent but not scored by `pnpm eval` until its cassettes exist. One local command |
| ~~Positioning line~~ | **done** | `CLAUDE.md` and `README.md` now open on staffing and logistics first, retail CPG as upside |
| Real customer documents | **you** | Every fixture is synthetic. See *What not to claim* |
| ~~Provenance at ingest~~ | **done** | `ingestDocument` writes the `uploads` row before it stores the bytes, so `documents.upload_id` is set on everything stored since. `declined_candidates.discovered_from` is derived from the notice's own arrival — the `assumedDiscoveredFrom` parameter is gone — and a case whose notice records no arrival is refused rather than attributed to a guess. Coverage can be grouped by channel; a declined web upload and a declined email-in case land in different ones. Two things it leaves behind are under *Follow-ups this change created* |

## Where the phases stand

Against the build order in `CLAUDE.md`:

- **Phase 0 — foundations.** Done. Approval trigger, append-only tables, hash
  chains, RLS, the SQL invariant suite, money maths, the case state machine.
- **Phase 1 — ingest + classify.** Substantially done and live. The Inngest
  binding exists in code (ADR 0021): both keys give a job, neither reads inside
  the request, one without the other is an error. Remaining: the production
  sync, and fixtures for formats still missing.
- **Phase 3 — packet, approval, submission, outcomes.** **Complete in code**
  (PRs #5, #7, #8, #9), ahead of 1.5 and 2 per ADR 0020, with the dispute
  decision made by a human rather than by Jev:
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
- **Phase 1.5 — ERP read + triage.** Not started.
- **Phase 2 — evidence + decision.** Not started. Phase 2's model decision lands
  in the slot Phase 3 has already used, with a corpus of human decisions in the
  same `schema_id` to score against.

The case state machine has 14 states. Cases reach state 2 in production; the
states above it are exercised only in tests.

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

A **15-document synthetic "customer" pack** (staffing and logistics) has
arrived. It is the next eval suite, scored separately like the others — never
blended into the existing five.

`authored_pending` joins `logistics` and `customer` as a suite with fixtures and
no cassettes. All three are named in `baseline.json`'s `pendingSuites`, which
`pnpm eval --record-pending` refreshes without touching a metric row — the
bookkeeping no longer needs `--record-baseline`, which rewrites the file.

## What not to claim yet

- **Nothing has ever been submitted or recovered.** No dispute has been sent to
  a retailer, no money has come back, no fee has been invoiced. Phase 3 existing
  in code is not Phase 3 having happened.
- **Every fixture is synthetic**, including the new 15-document pack. The eval
  numbers — 100% recall, 100% precision, 99.8% grounding — measure documents we
  generated or were given as labelled test data. They are a floor, not a result.
- **The OCR starter pack stamps every page `SYNTHETIC TRAINING SAMPLE`**, and
  its own README warns that marker can become a shortcut feature. A classifier
  scoring 100% on it may have learned the watermark. LOG-001 carries no such
  banner and a test keeps it that way.

## Next

1. **Fix the concurrency cap and sync Inngest**, then run one case end to end in
   production — upload, decide, assemble, approve as the second member, file,
   outcome.
2. **Score the customer pack** as its own suite.
3. **Cassettes for LOG-001 and `authored_pending`**, once the key is in place.
   LOG-001's findings are reachable from a case page now, so recording it
   measures the argument rather than five unread documents.
4. ~~Provenance at ingest~~ — done, and so are both follow-ups it left (ADR
   0024, migration 0019). Apply 0019 to production with the next deploy: until
   then `uploads` is still editable there, and the pre-provenance cases there
   still have no way to record how they arrived.

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

Nothing in production has been migrated for this yet — Supabase
`hvheqbgkvwhlqutklwfh` still carries 0018.
