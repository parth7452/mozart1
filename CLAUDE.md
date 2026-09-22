# recouple — deductions agent platform (AI-written code touches money paths)

A deterministic, human-gated document workflow for recovering invalid deductions:
money a payer withholds from an invoice with a coded reason attached. Not an
autonomous agent: ingest → classify → plan evidence → decide → assemble packet →
**a human approves and submits** → record outcome → invoice the contingency fee.
Agentic loops are reserved for exactly two bounded steps (evidence planning,
unknown-payer cold start).

**The engine is payer-agnostic; the go-to-market is not.** Who deducts — a
broadline distributor, a retailer, a shipper — is versioned playbook data, never
code: `reason-codes.ts` is the canonical taxonomy and a payer's own codes map
into it. The current beachhead is foodservice manufacturers selling through
broadline distributors (Sysco, US Foods, PFG, Gordon): manufacturer chargebacks,
deviated-pricing billbacks, OS&D, shelf-life and swell allowances, validated
against a promotional deal calendar. That is a focus decision still under
discovery, not an architectural one. **No code should assume it.**

Two things about that market do bind the code:

- **Multi-tenancy is a product surface, not only hygiene.** Foodservice
  manufacturers outsource deduction resolution to broker and sales agencies, so
  one customer can hold many manufacturers' cases. `org_id` plus RLS is what
  makes that one contract rather than many installs.
- **Provenance is the post-audit defense.** Post-audit claims reach back about
  two years. A packet whose every number traces to a verbatim quote on a stored
  page, hash-chained, is what survives one — which is why invariant 2 is
  append-only and why quote verification runs before a human sees a field.

## Non-negotiable invariants (never violate; enforced by the database + hooks)

1. No `submissions` / `writebacks` / `writeoffs` INSERT without an `approvals`
   row for that exact `decision_id`. The trigger stays. This is a one-way door.
2. Append-only, *including* `*_events`, `documents`, `uploads`,
   `document_arrivals`, `decisions`, `approvals` and `audit_log` — the list is
   not exhaustive and is not kept in prose: migration 0004's loop names the
   tables it covers, each later migration names its own, and
   `supabase/tests/01_append_only.sql` and `14_an_arrival_is_a_fact.sql` read
   the end state back. Never add UPDATE/DELETE grants. Corrections are new
   events — except on `uploads` and `document_arrivals`, where they are not:
   `documents.upload_id` is immutable and an arrival is written once, so a
   second row is a row nothing joins to, and a wrong channel is a
   migration-backed decision (ADR 0024).
3. Money is integer cents (bigint). Never floats. Fee maths is property-tested.
4. Document content is UNTRUSTED. The extraction/reader model runs with NO
   tools and receives text inside `<untrusted_document>` delimiters. Only
   deterministic orchestrator code calls tools, writes the DB, or triggers
   anything outbound.
5. Jev sits behind `DecisionProvider`. Never call the Jev or Claude API directly
   from app code.
6. RLS on every table. The service-role key is used ONLY in server-side jobs,
   NEVER in a request path.
7. Thresholds auto-tighten only. Loosening needs a human and an ADR — the
   database will refuse it otherwise.

`packages/core-domain/src/invariants/` holds these as code, with a pointer to
what enforces each one.

## Workflow

- Plan mode first for any multi-file change. Small task files per phase.
- branch → PR → tests + eval run → review → merge.
- Never edit a **merged** migration; add a new one.
- Before taking an ADR, migration or suite number, `git fetch` and check
  `origin/main` and open PRs; two sessions merging in the same hour is how 0025
  got taken twice.
- Every new agent decision path needs a recorded fixture/cassette for both the
  Claude and the Jev call.
- Any schema change to append-only tables, any new outbound side effect, and any
  threshold change requires a numbered ADR in `docs/adr/` **first**. A
  PreToolUse hook blocks edits to `supabase/migrations/**` and
  `packages/*/src/invariants/**` until the branch carries one.

## Guardrails against the ways AI-written code fails on money paths

- Do NOT swallow errors. Fail loud.
- Do NOT leave mocks or fixtures reachable from production code paths.
- Do NOT weaken or delete a test to make CI pass. Fix the code.
- Do NOT bypass RLS with the service role to "make it work".
- Do NOT edit a migration in place. Do NOT relax the approval trigger.
- Do NOT put a retailer's rules in code. They are versioned, effective-dated
  playbook *data* with provenance.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Vitest across every package (includes the money property tests) |
| `pnpm typecheck` | `tsc` over the workspace |
| `pnpm db:test` | Applies migrations to a scratch DB, then the invariant/RLS suites. Run it **before** `pnpm test`: the Postgres integration tests need those migrations |
| `pnpm eval` | Replays recorded cassettes, scores against ground truth, fails on regression |
| `pnpm record:cassettes` | **Spends money.** Calls the API and re-records the fixture cassettes |
| `pnpm verify` | typecheck + db:test + test + eval — what CI runs, in that order |

`pnpm db:test` needs `DATABASE_URL` pointing at a throwaway database owned by
the connecting role.

## Build order (do not reorder)

Phase 0 foundations → 1 ingest+classify → **3 packet+approval+manual
submission+outcomes, human-decided (ADR 0020)** → **1.5 ERP read + triage** → 2
evidence+decision (EV-gated) + portal **read** → **2.5 EDI 812/820** → 4 QBO
write-back + contingency billing → 5 learning loop → 6 careful autonomy.

Phase 3 moved ahead of 1.5 and 2 per ADR 0020, with the dispute decision made
by a human rather than by Jev, so a customer can run one case end to end and a
recovery rate becomes measurable — STRATEGY §9's own go/no-go for that stage.
A human decision is an ordinary `decisions` row with `provider = 'human'` and a
non-null `prepared_by`, so separation of duties applies to it unchanged and the
gate is exercised rather than routed around. Phases 1.5 and 2 follow,
unchanged; Phase 2's model decision lands in the slot Phase 3 has already used.

Phases 1.5, 2's portal read and 2.5 are new, from `docs/STRATEGY.md` §5.4. The
reason is one sentence: a deduction could only enter the system if the supplier
already knew about it and sent it to us, and the whole coverage thesis is the
~70% they never surface. **Read** moves early; **write** (auto-submission,
write-back) stays exactly where it was, behind the approval gate.

**Do not build yet**: browser-agent auto-submission (Phase 6), portal *write* of
any kind, NetSuite/Xero (after QBO, same `AccountingSource` port). Their
interfaces (`SubmissionChannel`, `EvidenceSource`) already exist so adding them
is additive.

Portal credentials, when they arrive, belong in KMS-backed storage and never in
an application table, and a credential failure degrades to upload/email rather
than failing the case.

Definition of done for a phase: exit tests green in CI, an eval run recorded
with no regression beyond tolerance, fixtures/cassettes committed for every new
decision path, the demo script updated, and no new UPDATE/DELETE grants on
append-only tables.

## Per-package notes

| Package | Remember |
| --- | --- |
| `core-domain` | Money is integer cents; the state machine table is the spec, and the DB is the referee |
| `ingest` | Check magic bytes, not the declared type; the scan gate fails closed — no verdict means no read. On email, the tenant comes from the address, never the sender; DKIM or DMARC must pass before an email may open a case. An email *body* is text, not a file: it gets `acceptEmailBody`, chosen by `source`, never by a caller's flag (ADR 0016) |
| `extraction` | The reader gets no tools, ever. Models report verbatim quotes; our code does the arithmetic. A document read back out of the store goes through the same `reassemble` and the same schema validation as one read from the model (`restoreDocument`), so an absent field comes back stated as absent rather than as a missing key. It is the same object except where a field was stored without provenance or its confidence was rounded to four decimals, and both exceptions are said out loud rather than assumed away. A repeating group is capped at `MAX_ROWS_PER_GROUP`: a row past it is dropped with an issue, never filled up to |
| `pipeline` | A `remittance_advice` opens one case per short-paid line (`openCasesFromRemittance`, ADR 0028): the short-pay is `deduction_amount` as printed else `gross − net`, never the model's arithmetic; only an **exact** identifier match merges, a probable one opens the case and names the other on the event; identifiers go to `deduction_identifiers`, never to a column of ours. `readDocument` reports a read whose rows will not rebuild into their own type (`document.stored_without_provenance`) and reads it anyway; `reconcileCase` reconciles over it and grades the gap — blocking when a money field is among the fields that were lost, a warning otherwise. Steps are pure functions over ports. `@recouple/pipeline/testing` never reaches production. `CaseWorkflowStore` (Phase 3, ADR 0020) is a *separate* port, not an extension of `PipelineStore`: the pipeline runs unattended, that one runs behind a person authorising money. Every refusal is a named `CaseWorkflowError`, never a bare `RangeError` |
| `fixtures` | Document text, ground truth and expected extraction live together so they cannot drift |
| `evals` | Never move a baseline to make a run pass |
| `store-postgres` | Runs as `app_rw` with the tenant's claim set transaction-locally, so a pooled connection cannot carry one tenant's claims into another's query. The service role never appears here. `PostgresQboTokenStore` writes ciphertext only, one store per connection, and a rotation is a new row (ADR 0033) |
| `crypto` | The `TokenCipher` port and `KmsTokenCipher`. It reads no environment variable and holds no key material: AWS credentials are the SDK's provider chain's business and the key id is a constructor argument. `LocalTokenCipher` is under `@recouple/crypto/testing` and the index must never re-export it |
| `decision` | Map questions to Choice ≤255 / Score / Noul; Jev primary, Claude structured fallback; state is extracted fields, never document text |
| `adapters` | Interfaces only until their phase; a channel that submits still has to pass the DB approval gate |
| `packets` (Phase 3) | Append-only; the hash an approval names is a foreign key to the packet that was assembled, so an approval cannot authorise a packet nobody built. A packet's decision must be the same tenant's and the same case's — the foreign keys say each id exists, not that they are one case |
| `declined_candidates` | Every case we decline to fight gets a row with what it was worth and what was missing. A discard is not a decision; coverage has no numerator without this (docs/STRATEGY.md, ADD-1). `discovered_from` is **derived** from the notice's own `uploads` row, never passed in — a case whose notice records no arrival is refused (`ProvenanceUnknownError`), because a channel credited on a caller's say-so is a number that looks right. `uploads` is append-only since ADR 0024, so that row cannot be re-labelled after the declines attributed to it were counted; a notice stored before provenance existed gets its channel from a `document_arrivals` row an operator writes with `pnpm link:provenance`, which the database refuses for any document ingest already recorded an arrival for and for any channel but the three doors that existed then. `provenance_kind` says which of the two answered — derived like `discovered_from`, never passed in — so a coverage number can report the split rather than needing three joins to find it |
| `web` (apps/) | Supabase Auth for identity only; every read goes through `PostgresStore` as `app_rw`. The service-role key appears nowhere. Views in `components/` are pure functions of what the store returned; `app/` reads and renders them |
| `playbooks` (Phase 2) | Versioned, effective-dated, every fact carries provenance |
| `rules` (Phase 5) | JDM validation + backtest + shadow before promotion; auto-demote on precision drop |
| `qbo` (Phase 4) | Idempotent `Request-Id`, proactive token rotation, persist the rotated refresh token every cycle |
| `billing` (Phase 4) | Integer cents; only *attributable* recoveries are billable |

## Models

Extraction and narrative run on `claude-sonnet-5`; first-page doc-type
classification runs on `claude-haiku-4-5` (ADR 0007). Both are overridable with
`RECOUPLE_EXTRACT_MODEL` / `RECOUPLE_CLASSIFY_MODEL`, and every call writes the
model it actually used to `model_calls` alongside its tokens, cost and latency.

Two rules that are easy to break by accident:

- **The reader is constructed with no `tools` parameter.** Not "with an empty
  tool list" — the parameter is never passed. If you find yourself adding a tool
  to a call that reads a document, you are about to break invariant 4.
- **Models copy, we compute.** Money comes back as the verbatim text on the page
  (`"$3,120.00"`), and `parseMoneyToCents` turns it into cents. A model that does
  its own arithmetic leaves nothing to check.
- **Never send a document schema as the output format.** The API compiles a
  structured-output schema into a grammar and rejects anything past ~10–12
  properties, so a typed document schema will not compile (ADR 0008). The wire
  format is the flat `WireExtractionSchema`; `describeFields` tells the model
  what to look for and `reassemble` rebuilds and validates the typed object.
  Adding a field to a document type stays a one-line schema change.

## Current state

Phase 0: done. Migrations with the approval trigger, append-only tables and hash
chains, RLS policies, the SQL invariant suite, money maths, the case state
machine, the decision and adapter contracts.

Phase 1: the pipeline is built and tested — upload hardening, the fail-closed
scan gate, doc-type classification, typed extraction with per-field provenance,
quote verification, cross-document reconciliation, the synthetic fixture corpus
and the eval harness. Cassettes are recorded for all eight fixture documents and the eval baseline is
in `packages/evals/baseline.json`: 100% recall, precision and quote verification,
8/8 classification, $0.015 per document. That is a floor, not a victory — the
corpus is generated text PDFs, and the numbers that matter will come from scans.

Since then: a held-out corpus of twelve documents written elsewhere, a scanned
suite, Reducto OCR behind an `OcrProvider` port, the schema deployed to Supabase
with every invariant verified there, and Postmark email-in.

Six recorded suites and two waiting on cassettes, every one of them scored
separately (never blended — the mix changes, and a blended number moves when it
does):

| Suite | What it measures | Recall / precision | Grounding | Classification |
| --- | --- | --- | --- | --- |
| authored | does the pipeline work | 100% / 100% | 100% | 8/8 |
| held_out | does it generalise | 100% / 100% | 100% | 12/12 |
| scanned | does it survive a scan | 99.1% / 100% | 100% | 12/12 |
| dense | does it survive a 42-row remittance | 100% / 100% | 100% | 1/1 |
| email_body | does it work with no page at all | 100% / 100% | 100% | 1/1 |
| logistics | does one dispute hold together across five documents | 89.5% / 89.5% | 100% | 5/5 |
| authored_pending | shapes the numbers do not cover yet | not yet recorded | — | — |
| customer | simulated camera pages, on staffing and freight | not yet recorded | — | — |

`customer` is fifteen documents across three cases — two staffing, one freight —
twelve of them simulated camera photographs. It is the market the product is
sold into rather than the one the other suites are drawn from. Synthetic, like
everything else here, and `packages/fixtures/customer/README.md` keeps the
pack's own caveats verbatim. `pnpm eval` reports every unrecorded suite as
skipped rather than failing, and `packages/evals/baseline.json` names them in
`pendingSuites` so a suite with no numbers cannot be mistaken for a suite that
passed. `pnpm eval --record-pending` is how that list is kept honest: it
rewrites `pendingSuites` and nothing else, so the bookkeeping no longer needs
the one command a baseline may never be moved with. A suite the baseline *has*
measured is never skipped: if its cassettes are missing or short, the run
fails, because a rate averaged over fewer documents is not the number the
baseline is being compared against. Record with
`pnpm record:cassettes --suite customer` (it spends money), then
`pnpm eval --record-baseline`.

Classification is 39/39. The two misses in the corpus are both the same field
pair on one document: `commitments[0].supersedes` and `.establishes` on the
LOG-001 appointment change, where the page prints "Appointment AP-BSC-771
revision 2 replaces revision 1" and the model reports the change in prose
instead of the identifiers. Its scanned twin returns null for both rather than
the wrong answer, which is the better failure of the two.

The `scanned` suite was four documents until 2026-09-21, three of them deduction
notices, and the renderer stamped a fake "RECEIVED" box on every one — added
content that contradicted the ground truth each scan inherits from its source.
`carrier-bol-scan` classified `pod` four recordings running because of it. The
stamp is gone, the suite is twelve documents spanning nine document types, and
a single flip now costs 8 points rather than 25.

About $0.0235 per document across 39 of them, and 311 of 821 fields carry a
bounding box a reviewer can follow. Extraction streams with a 32,000
output-token budget because a dense document costs ~250 output tokens per row —
roughly 120 rows before a read is cut off, at which point it fails loudly rather
than storing a truncated document as a complete one.

`apps/review-prototype` renders a reviewer's workspace over the recorded output —
the scan with every field boxed and traceable to its quote. It is a prototype, not
the product: no database, no auth, and approving is a Phase 3 action a trigger
governs.

`apps/web` is the product's shell: Next.js 16 App Router, Supabase Auth by magic
link, a case list and a review route, reading through the same RLS policies as
everything else (ADR 0015). Signing in resolves a tenant rather than creating
one — `app.link_auth_user()` and `app.my_orgs()`, both security definer and both
taking the identity from the claims rather than an argument (migration 0012, ADR
0012). Document bytes are durable and served through a route under the same
policies, not a signed URL (migration 0013, ADR 0014). Still no approve button,
for the same reason.

Uploading from the app runs the real pipeline. `pipelineDepsFor` fails closed,
and delegates the whole choice to `scannerFromEnv` so there is one answer to
"what scans here": `CLAMAV_SCAN_URL` + `CLAMAV_SCAN_TOKEN` gives the hosted
`HttpScanner`, `CLAMAV_HOST` gives clamd over TCP, and anything else — including
a URL with no token — gives `NullScanner`, which reports an error rather than a
clean bill of health, so an unconfigured environment cannot read a stranger's
file at all. No `REDUCTO_API_KEY` builds no OCR provider rather than one that
throws. `apps/web/test/fail-closed.test.tsx` asserts all of it.

The deployed scanner is `services/clamav-scan`: clamd bound to loopback in a
container, behind a token-checked HTTP endpoint, because clamd has no
authentication and Vercel's egress is not an allowlistable set of addresses
(ADR 0018). `docker compose up -d clamd` is the laptop equivalent.
`packages/ingest/test/scan-service.test.ts` spawns the real service against a
fake clamd and checks the token, both size ceilings, INSTREAM chunking and the
JSON contract — the service reimplements `interpretClamdReply` rather than
importing it, so that test is what keeps the two from drifting.

The upload path is live and verified in production (2026-09-19). The scan
service runs on Fly as `recouple-clamav`; `CLAMAV_SCAN_URL` and
`CLAMAV_SCAN_TOKEN` are set on the Vercel project alongside `ANTHROPIC_API_KEY`
and `REDUCTO_API_KEY`. A scanned Walmart APDP notice uploaded through the
signed-in app came back as a case with every field quote-verified against the
OCR text layer — so scan, classify, OCR and extract all work against the real
vendors, not only against cassettes.

The gap that verification exposed — `openCase` took a `retailerName` it never
wrote and no dates at all, so every case read "Retailer unknown" with no dispute
deadline — is closed (ADR 0019, migration 0015). A case now keeps
`retailer_name_as_printed` exactly as extraction reported it, and `openCase`
*looks up* a debtor, setting `debtor_id` only when exactly one of the tenant's
debtors matches. It never creates one: document text is untrusted, so it may
select master data through an alias a human added but not mint it, and two
matches count as none. Dates go through `parsePrintedDate` in `core-domain`,
month-first and deterministic, the way `parseMoneyToCents` handles money; a
window it will not guess at ("60 days of deduction date" is a retailer rule,
Phase 2's job) leaves the column null, opens the case anyway, and records why on
`case.discovered`. The views show the debtor, else the printed name marked as
unmatched, and only then "Retailer unknown".

Two things that fixing it surfaced: `unique (org_id, debtor_id, claim_id)` never
fired while `debtor_id` was always null, so the same claim uploaded twice opened
two cases silently — it now raises `DuplicateCaseError` naming the existing case,
and merging the two is still identity resolution's job (STRATEGY §5.2). And
`retailerMatchKey` folds "WALMART STORES, INC." to `walmart stores`, which does
*not* match `walmart` on purpose: whether those are one retailer is data, not
code.

`pnpm link:retailer` is how a person supplies that data. It adds a
`debtor_aliases` row for a tenant and then resolves the cases that were waiting
on it, writing through `PostgresStore` as `app_rw` like everything else. The two
halves are one command but not one act: adding an alias fixes every later case
by itself, and the backfill is what reaches back through the ones already open —
deliberate, because a silent rewrite of old cases is not something anyone asked
for. It never creates a debtor, refuses an alias on another tenant's debtor, and
reports (with a non-zero exit) rather than resolving a case whose claim is
already open against that debtor — that is two cases for one claim, and merging
them is identity resolution's job.

`--from-extraction` repairs the cases opened *before* ADR 0019, whose rows have
none of this on them. Nothing was lost: `extraction_results` still holds the
retailer and both dates with their quotes, so the repair reads them back through
the same `parsePrintedDate` and `resolveDebtorId` the pipeline uses, and a
repaired case says what a case uploaded today would. It fills only columns that
are null, never overwrites what the pipeline or a person put there, records a
`case.backfilled_from_extraction` event for each row it changes, and reports an
unreadable date instead of guessing. Running it twice is a no-op.

Production (Supabase project `hvheqbgkvwhlqutklwfh`) carries migration 0024 as
of 2026-09-22 (0019–0021 applied 2026-09-21; 0022–0024 applied 2026-09-22 and
the new tables, views, functions and grants read back and verified).

The Inngest binding over the existing steps exists, and which environment gets
it is `runnerFromEnv`'s answer the way what scans is `scannerFromEnv`'s: both
`INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` gives a job, neither reads inside
the request as before, one without the other is an error (ADR 0021). The request
keeps the cheap fail-closed half — session, CSRF, magic bytes, the `documents`
row, the scan gate — and the job does the read, through `PostgresStore` as
`app_rw` with the claims the event names, never the service role. `ingestForJob`
and `readDocumentJob` in `packages/pipeline` are the same `ingestDocument` and
`readDocument` the synchronous path runs; the event carries ids and the acting
member, never document text — and neither does a failure, whose message is
rebuilt from the class name and the ids rather than passed through, because
`DuplicateCaseError` quotes the claim id off the page.

A job asks two questions before it spends anything. May this member write in
this org — `app.member_may_write()`, asked of the database, because a signed
event says Inngest delivered it and nothing more, and `tenant_read` checks only
the org claim. And has this document already been read — because a read is not
idempotent on its own and `unique (org_id, debtor_id, claim_id)` does not fire
while `debtor_id` is null, so a redelivered event used to open a second case and
pay for the page twice. A document that already has an extraction is answered
from what was recorded; the two reads that still happen are the ones that would
do something new, attaching it to a case it is not on yet or opening a case for a
notice that has none. The same guard runs on the inline path, where the same
thing happens when a file is uploaded twice.

**A second delivery costs nothing, and three different things make that true
depending on when it lands.** Saying it costs nothing full stop was wrong, and a
reviewer proved it with two concurrent `readDocumentJob` calls on one document:
four model calls, two extractions, two cases. *Late* — after the first read
finished — is answered from the record, by the guard above. *Overlapping* is
answered by a lock: the guard and the read run together while the job holds that
document's claim, `PostgresStore.withDocumentRead`, a `pg_try_advisory_xact_lock`
on `hashtextextended(document_id, 0)` as `app_rw` with the tenant's claims, on
its own pool so a connection held for a whole read cannot starve the reads. A
delivery that does not get the claim answers `beingRead` and spends nothing
rather than waiting. It is transaction-scoped, not session-scoped, because
`DATABASE_URL` is the Supabase transaction pooler: a session lock could be taken
on one server connection and unlocked on another, and the document would be
unreadable for ever. *A redelivery of the same event* is also caught by the
runtime, within its window — `idempotency: 'event.data.readKey'`, where an upload
sets `readKey` to the document id and the re-drive route sets a fresh
`randomUUID()`. The key was `event.data.documentId` until 2026-09-21, when
production showed a run invoked once, answered with a step plan and never called
back to execute the step — no error, no log, the reviewer's notice saying "being
read" for ever, and the event sent to recover it swallowed by that key's own
24-hour window. Keying on the document made the recovery indistinguishable from
the thing it was recovering; keying on the request does not. The function also
logs its own step boundaries now — run entered, step entered, what it concluded,
run returned, ids only — so a run line with no step line under it is a visible
stall.

If `client.send` fails the document is not orphaned: it is stored, scanned, and
the reviewer is told where to find it. That place is the case list's **Documents
waiting to be read** — every document of the tenant's that is stored, scanned
clean, has no `extraction_results` row and is older than five minutes
(`PostgresStore.unreadDocuments`, through `withTenant` as `app_rw`, no new
table) — with a "Read again" button per row posting to
`/documents/[id]/reread`. That route refuses cross-site, resolves the session,
checks the id and the role, asks `memberMayWrite` of the database, 404s a
document the tenant cannot see, and then re-drives through whichever runner
`runnerFromEnv` gives: the same event where there is a queue, the same
`readDocumentJob` inline where there is not. Pressing it twice is safe for the
reasons above: the second press is answered from the record if the first has
finished, and refused the claim if it has not. It asks `documentIsVisible` — a
`select 1`, not the bytes — and it derives `allowCaseOpen` from where the
document came from, which is a question the database can now answer. And
`/api/inngest` refuses to serve at all — 503, logged — when `INNGEST_DEV` is set
in a production build, because dev mode turns off the signature check that is
the endpoint's only authentication.

**Where a document came from is recorded, not assumed.** `ingestDocument`
writes an `uploads` row before it stores the bytes — `source` from the door it
came through (`web_upload`, `email_in`, `email_body`), `created_by` the
signed-in member for an upload and null for an email, because the sender is not
one of our users and `From:` is forgeable — and the document names it. No
migration: the table and `documents.upload_id` have been there since 0003 and
nothing wrote them. A re-upload of the same bytes keeps the first arrival's
`upload_id` and records nothing new; the channel that re-sent a document we
already had did not find it.

Two things follow. `declineCase` **derives** `discovered_from` from the case's
notice instead of taking `assumedDiscoveredFrom: 'web_upload'` from whichever
route was calling — the parameter is gone, and a case whose notice records no
arrival raises `ProvenanceUnknownError` rather than being counted under a
guess, because that column is the one a coverage number is sliced by and a wrong
number there reads exactly like a right one. And the "Read again" button asks
the document: `web_upload` may open a case, which closes the gap where an
upload whose first read recorded fields and then failed could never get one.
Anything else keeps the old conservative rule — read once, no case — because
whether an inbound email authenticated is **not persisted anywhere**
(`InboundEmail.authenticated` decides it at ingest and is never written down),
and the answer that cannot let a forged `From:` acquire a case is the one to
give when the database does not know.

**A field with no provenance is not a document with no lines.**
`flattenExtraction` writes no `extraction_results` row for a value it cannot
point at — no page, or no quote — because provenance is not optional. That was
only ever meant to cost the field. It cost the case: the rebuild had nothing to
put back, the notice stopped satisfying `DeductionNoticeSchema`, and
`reconcileCase` answered a whole case with no lines, no totals and a blocking
`stored_document_not_typed`. One smudged date on a scan was enough, and the
recorded corpus already carries the pattern twice — `hl-case-01-notice-scan`
reports a `gln` it cannot quote and `hl-case-05-notice` a `store_or_dc` — on
optional fields, where it costs the field and nothing else. On a required one
it costs the case.

Both seams say so now. At the write, `readDocument` puts the rows it is about
to store back through `restoreDocument`; if what comes back is not typed it
records `document.stored_without_provenance` on the case, naming the fields and
nothing off the page, and logs. It does **not** refuse the read — a scan with
one unquoted date still has to open a case. At the read, `reconcileCase` tells
a required field that came back with no value apart from a shape it does not
understand: the first is reconciled over anyway and downgraded to a warning
naming the fields, the second is still refused outright. It stays blocking when
one of the lost fields carries money (`*_amount*`, `*_total*`, `unit_cost`),
because the arithmetic that says whether a claim adds up is over exactly those.
Both ends name a field the same way — `lines[0].deduction_amount` — so the
event on the case and the finding on the page are recognisably one thing.

Two smaller holes went with it. `reconcileCase` asked for a `pod` only when
there was no `bol`, so an unreadable delivery record went unmentioned whenever
another one happened to parse; both are asked now. And it never passed a
`correspondence` document to `reconcileNotice` at all, which made every
`appointment_superseded` and `charge_waived_in_writing` finding unreachable
from a case page — most of what a freight case turns on.

**An arrival is a fact** (ADR 0024, migration 0019). Making a coverage number
depend on `uploads.source` exposed where that column lived: 0006's *mutable*
list, so `app_rw` held UPDATE and DELETE on it and no trigger guarded it. An
analyst could re-label which channel found a deduction after the declines
attributed to it were counted, moving a published number with no audit row
anywhere. `uploads` now joins the append-only set on 0004's pattern — revoke,
plus `no_update_delete` and `no_truncate` on `app.block_mutations()`, because a
grant answers for `app_rw` and the trigger is what answers for the owner. The
usual "corrections are new events" does *not* apply here and the ADR says so
plainly: `documents.upload_id` is immutable, so a second `uploads` row is a row
nothing joins to. The documents stored before provenance existed have one way
back, and only one — `document_arrivals`, at most one row per document,
append-only, `recorded_by` not null, and `app.arrival_only_when_unknown()`
refusing any document that already names an upload, so it fills in what nothing
observed and never overwrites what something did. `pnpm link:provenance` writes
one; it requires an explicit `--source`, has no default, and the *database*
refuses anything but the three doors that existed before provenance was recorded
— `web_upload`, `email_in`, `email_body` — because `erp_sync`, `portal_fetch`
and `edi_812` will each write an arrival at ingest and so could not have
delivered a document that has none. That the deployment "never had an
inbound-email caller" is an assertion about the deployment rather than anything
the database knows, which is why the channel is typed rather than defaulted.
`declineCase` reads observed-or-asserted — at most one of the two can exist — and
the decline is then attributable, and says which way it got there:
`declined_candidates.provenance_kind` is `'observed'` when the notice's own
`uploads` row answered and `'asserted'` when a `document_arrivals` row did, set
from which join answered and never passed in. It was added in 0019 rather than
later because production has no declines and no recorded uploads, so the default
back-fills nothing; who asserted it, when and why stay on the `document_arrivals`
row, in `uploads.created_by` and on the case's `document.provenance_recorded`
event, because the column is for counting and those are for auditing.

**The database knows every document type the reader does** (ADR 0027, migration
0021). `DOC_TYPES` had twelve values and migration 0004's check constraint
listed eleven, so a dispatch-note JPEG classified `correspondence` — the type a
waiver or an approved reschedule arrives as — was OCR'd, classified, extracted
and then refused at the read's last statement. The refusal arrived as a driver
error nothing recognised, so the queue retried it: four reads, one document, no
case. The constraint now names all twelve;
`packages/store-postgres/test/doc-types.test.ts` reads it out of `pg_constraint`
and asserts set equality with `DOC_TYPES` in both directions, so a thirteenth
type is a two-file change CI insists on, and
`supabase/tests/16_every_document_type.sql` proves each of the twelve actually
inserts and that the table is no less append-only than it was. A refusal is now
a typed
`ClassificationRefusedError` — a document id and one of twelve constants, never
text off the page — and `asJobFailure` maps it, and any bare SQLSTATE 23514, to
`NonRetriableError`: a check constraint answers the same every time, and on
this path a retry costs three model calls to hear it again. All three calls are
recorded before the first row the database can refuse, so the extraction — the
expensive one, previously written on the far side of the statement that raised —
is no longer the read least visible in `model_calls`.

**A short-paid remittance line is a discovered deduction** (ADR 0028, migration
0022). `openCaseFromNotice` opened cases for `deduction_notice` and nothing
else, so a remittance advice was scanned, classified, read — and appeared
nowhere in the product. In staffing, freight and foodservice the remittance *is*
the notice, so those were exactly the deductions the coverage thesis is about,
sitting inside a document we had already paid to read.
`openCasesFromRemittance` runs where `openCaseFromNotice` does, under the same
`allowCaseOpen` guard, so it is on the Inngest path and the inline path at once.
The short-pay per line is `deduction_amount` as printed, else `gross − net`
through `subCents` when both are printed, else no case and a recorded reason —
the model is never asked for a difference. A line opens a case only over both
halves of a per-tenant floor (`org_settings.remittance_tolerance_cents` /
`_bps`), and the proportional half is a `BigInt` cross-multiplication rather than
`applyBps`, because half-up rounding on a threshold is a coin toss at the
boundary. Those two columns join `app.guard_threshold_direction()` in the
opposite sense from every ceiling in it: **raising** a tolerance skips more
short-pays silently, so raising is the loosening. `remittance_dedup_days` is
deliberately not guarded — neither direction is the conservative one.

Dedup goes through `deduction_identifiers` and `resolveIdentity`, not a column
of its own: every case opened now writes its identifier rows, which is the
`openCase` wiring ADR 0025 left as follow-up and nothing but its backfill had
done. A notice writes its claim id and, where the page prints one, its invoice
number; a remittance line writes `payment_reference:invoice_number` (so
`unique (org_id, debtor_id, claim_id)` still fires) and the invoice. Only an
**exact** match merges. `probable` and `ambiguous` open the case and name the
other one on `case.discovered`, because a duplicate case is visible and
mergeable while a wrong merge destroys a disputable deduction and leaves no
record it was seen. The invoice number is recorded as a name and never matched
on as an exact key — one invoice carries many deductions. The resolve-then-open
runs under a second advisory lock, per (org, invoice), seeded `1` so it cannot
collide with `withDocumentRead`'s document keys; it waits rather than giving up,
and cannot deadlock because the claim is taken and released per line. Lines below
the floor become `declined_candidates` rows with `decided_by_version` naming the
policy that declined them, and a document whose arrival nothing recorded has its
below-tolerance lines counted as unattributed rather than credited to a guess.
Model spend and the extraction are recorded against **no** case: one read pays
for many, and attributing it to one would overstate the number a contingency fee
is set against.

**The ledger sync runs on a schedule, as a member** (ADR 0031, migration 0024).
`syncLedger` was a function nothing called, so the coverage thesis was measured
at zero by construction. `accounting_connections` says which orgs have a ledger,
which provider account, whether it is still wanted and who connected it — and
holds no token, no secret and no credential, because those belong in KMS-backed
storage; it is the one table added in a while that is *not* append-only, since
`enabled` flips. `ledger_sync_runs` is append-only on 0004's pattern, which
forces ADR 0023's shape: written once, when the run finishes, complete. A run
killed mid-flight leaves no row, which the next day's overlapping window covers
and ADR 0031 §2 says out loud rather than glossing.

A cron has no session, so the sync acts as the connection's `created_by` and
asks `memberMayWrite` of the database the way `readDocumentJob` does; a member
who may no longer write gets the run recorded as `refused` and nothing is read.
`app.record_ledger_sync_run()` is the only door into the run table — `app_rw`
holds SELECT and no INSERT — and is definer for exactly that case, bounded to
the caller's own org claim and own subject so it reaches no further than its
caller. `app.ledger_connections_to_sync()` hands the fan-out ids only, because
the fan-out is the query that decides which tenants to adopt. The service role
appears nowhere. `accountingSourceFromEnv` is `scannerFromEnv`'s shape: there is
no production `QboTokenStore` yet, so every connection today gets a
`not_configured` run row and the rest of the fleet carries on. The window is a
trailing 35 days (`LEDGER_SYNC_WINDOW_DAYS`) so consecutive daily runs overlap,
which `syncLedger`'s identity resolution already makes free — the second pass
skips rather than opens, and `packages/pipeline/test/ledger-job.test.ts` asks
that rather than asserting it. Nothing creates a connection yet: the consent
flow is a later change, and so is the KMS token store.

**A possible duplicate is answered by a person** (ADR 0032, no migration).
Identity resolution has handed every `probable` pair to a human since ADR 0025
and nothing has ever shown one to a human: the pair was recorded on a
`case.possible_duplicate` event nobody read, so the asymmetry was a deferral to
nobody. `possibleDuplicates` reads those events back — both halves joined to
`deductions`, so a pair naming a deduction this tenant cannot see is not a pair
this tenant is shown, and RLS decides that rather than a filter — and the case
list and the case page both show it. `recordDuplicateVerdict` writes the
answer: one append-only `case.duplicate_confirmed` or `case.duplicate_dismissed`
event on **each** case, naming the other and the basis that agreed, under row
locks taken in id order so two reviewers cannot deadlock, and a second verdict
on a pair is refused by name rather than appended. `deduction_events.event_type`
is free text with no check constraint, so nothing in the database had to widen.

**A verdict records what a person concluded and nothing else.** No state moves,
no row is hidden, and no identifier is re-pointed — which is not restraint but
arithmetic: `deduction_identifiers` is append-only and unique on `(org_id,
source, identifier_kind, identifier)`, so the rows naming the duplicate are
exactly the rows that would collide, and the two ways round it are a fabricated
`source` (ADR 0024's misattribution) or matching an invoice number as an exact
key (refused by ADR 0025 §6, because one invoice carries many deductions). So
`openCase` resolves against exactly the identifiers it resolved against before,
and an arrival that exact-matches both halves of a confirmed pair is still
`ambiguous` — the first thing the follow-up should fix. A confirmed duplicate
also still counts in `coverage_by_period*`, which is an over-count that is
written down rather than discovered later; excluding it belongs with the merge
decision, since which row's dollars survive is the same question as which row
survives. A `merged` case state is that decision's too.

**A token is sealed before it is stored** (ADR 0033, migration 0025).
`qboTokenStoreFromEnv` returned `undefined` — the named KMS port with no
implementation — so every connection recorded `not_configured` and the ERP
discovery path was a scheduler with nothing behind it. Supabase Vault was
refused on environment parity (`pnpm db:test` is vanilla Postgres 16 and has no
`pgsodium`, so the table could not be created by a migration the suite applies)
and because it puts the decryption path inside the database; an external secrets
manager was refused because a rotation here is hourly, not rare. What landed is
envelope encryption: a `TokenCipher` port, `KmsTokenCipher` over AWS KMS
(`GenerateDataKey`/`Decrypt`, credentials left to the SDK's own provider chain
so nothing in `packages/qbo` or `packages/crypto` reads an AWS variable), and
AES-256-GCM in process. `LocalTokenCipher` lives under `@recouple/crypto/testing`
and the index does not re-export it, asserted the way
`InMemoryAccountingSource`'s absence is — it does real envelope encryption, so a
test that passes with it is evidence about the real one.

The encryption context is `{orgId, realmId}` and it is authenticated at both
layers, so a ciphertext lifted into another tenant's row does not open: a
row-level compromise of the database is not a cross-tenant credential leak.
`accounting_credentials` is append-only on 0004's pattern and **the current
tokens are the latest row** — a rotation is a new row, the chain is the audit
trail, and the reason is not habit: an UPDATE here is the one statement that can
strand a customer irrecoverably, where a failed INSERT leaves the previous row
still good. `seq` breaks the `created_at` tie that `now()` being
transaction-fixed would otherwise leave to the planner. The tenancy tie is a
composite foreign key on `(org_id, connection_id)`, ADR 0025 §7's pattern, and
suite 21 asserts the column list against the catalogue in both directions so a
later migration adding `refresh_token` fails there rather than in review.
`PostgresQboTokenStore` is scoped to **one** connection — the realm is fixed
from the row the job already read through RLS, and another is
`QboRealmMismatchError` rather than a lookup. A row that will not open is
`CredentialUnreadableError` carrying ids and a class name, never ciphertext, and
never `undefined`: "never authorised" and "will not decrypt" send a person to
two different places. Fail closed is unchanged — no `QBO_TOKEN_KMS_KEY_ID` and
no member to act as means no store, and the run row still says
`not_configured`. `pnpm link:qbo` places the first token set from `.env` with
the **real** cipher and no flag that changes that; `docs/qbo-credentials.md` is
the once-per-deployment AWS setup written for somebody who does not work in AWS.
Nothing here has met a live KMS or a live Intuit rotation.

Still to do before Phase 1 is done: fixtures for the formats still missing —
dense retailer tables with merged cells, and EDI-derived portal exports. Real
customer documents would be worth more than all of them.
