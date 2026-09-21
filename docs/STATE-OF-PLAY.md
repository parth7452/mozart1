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
| ~~Provenance at ingest~~ | **done** | `ingestDocument` writes the `uploads` row before it stores the bytes, so `documents.upload_id` is set on everything stored since. `declined_candidates.discovered_from` is derived from the notice's own arrival — the `assumedDiscoveredFrom` parameter is gone — and a case whose notice records no arrival is refused rather than attributed to a guess. Coverage can be grouped by channel; a declined web upload and a declined email-in case land in different ones |

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

## Evals

A **15-document synthetic "customer" pack** (staffing and logistics) has
arrived. It is the next eval suite, scored separately like the others — never
blended into the existing five.

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
3. **Cassettes for LOG-001**, once the key is in place.
4. ~~Provenance at ingest~~ — done. What is left of it is the cases opened
   before it: their documents have no `uploads` row, so declining one is
   refused by name until somebody records how it arrived. There is no backfill,
   deliberately — nothing in the database knows the answer, and inventing one
   is the thing this change removed.
