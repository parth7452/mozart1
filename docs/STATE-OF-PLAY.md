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
4. ~~Provenance at ingest~~ — done. What is left of it is below.

## Follow-ups this change created

1. **The pre-provenance cases cannot be declined, and no script can fix that.**
   Cases opened before ingest recorded arrivals have notices with
   `documents.upload_id` null, and `declineCase` refuses them by name rather
   than attributing the decline to a guessed channel. A backfill was considered
   and deliberately not written, because there is nowhere honest to write it:
   `documents` is append-only (migration 0004 revokes UPDATE from `app_rw` and
   puts a `before update` trigger on the table for every other role), so
   `upload_id` cannot be filled in afterwards, and `uploads` has no column that
   points back at a document. A script could have inserted `uploads` rows, but
   nothing would have linked them to the bytes they claimed to describe — the
   backfill would have looked like a fix and changed nothing the derivation
   reads. **This needs an ADR and a migration**: somewhere for an already-stored
   document to record the arrival it came from, written once and never
   rewritten. Until then the refusal says so in as many words — "this case
   predates provenance recording; it cannot be declined until a migration adds
   a way to record its arrival" — rather than sending somebody after a button
   that does not exist.

   Note for whoever writes it: the deployment history is the fact that would
   justify a value. `ingestInboundEmail` has never had a production caller, so
   every pre-provenance production document arrived by web upload. That is an
   assertion about this deployment, not a derivation from anything in the
   database, so it belongs in an ADR and in an operator's explicit `--source`,
   never in a default.

2. **`uploads.source` is mutable; ADR + migration to make `uploads` append-only
   now that coverage depends on it.** `uploads` is in migration 0006's `mutable`
   list, so `app_rw` holds UPDATE and DELETE on it and there is no
   `no_update_delete` trigger. That was harmless while nothing read the column.
   It is not harmless now: `declined_candidates.discovered_from` is derived from
   `uploads.source`, the declined row is append-only and cannot be corrected,
   and an UPDATE to `uploads.source` would silently re-label which channel found
   a deduction *after* the declines attributed to it were counted — changing a
   published coverage number with no record that anything moved. An arrival is a
   fact about the past, like every other row the invariants protect; it should
   be insert-and-select only, and a correction should be a new row rather than
   an edit.
