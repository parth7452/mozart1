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
| `pipeline` | A `remittance_advice` opens one case per short-paid line (`openCasesFromRemittance`, ADR 0028): the short-pay is `deduction_amount` as printed else `gross − net`, never the model's arithmetic; only an **exact** identifier match merges, a probable one opens the case and names the other on the event; identifiers go to `deduction_identifiers`, never to a column of ours. Either opens only at or above the tenant's classification floor with a reading that fits its type; otherwise the document is held for a person and opened by `openHeldDocument`, which reads nothing (ADR 0044). `readDocument` reports a read whose rows will not rebuild into their own type (`document.stored_without_provenance`) and reads it anyway; `reconcileCase` reconciles over it and grades the gap — blocking when a money field is among the fields that were lost, a warning otherwise. Steps are pure functions over ports. `@recouple/pipeline/testing` never reaches production. `CaseWorkflowStore` (Phase 3, ADR 0020) is a *separate* port, not an extension of `PipelineStore`: the pipeline runs unattended, that one runs behind a person authorising money. Every refusal is a named `CaseWorkflowError`, never a bare `RangeError` |
| `fixtures` | Document text, ground truth and expected extraction live together so they cannot drift |
| `evals` | Never move a baseline to make a run pass |
| `store-postgres` | Runs as `app_rw` with the tenant's claim set transaction-locally, so a pooled connection cannot carry one tenant's claims into another's query. The service role never appears here. `PostgresQboTokenStore` writes ciphertext only, one store per connection, and a rotation is a new row (ADR 0033). `connectQboCompany` is the only way a connection row is made — the button and `link:qbo` both call it — and it seals before it touches the database (ADR 0039). Every read of `deduction_identifiers` maps a merged-away case to its survivor through `deduction_merges_current`; a reader that forgets hits `RCM01` on its first write (ADR 0042). A case's documents and their fields are read by its `deduction_documents` links (`caseDocuments`, `fieldsForCase`, one shared CTE), never by `extraction_results.deduction_id`, which says only which case a read was paid for — a remittance's, a held notice's and a list-attached document's belong to none — and never derived from the fields: a ledger extract is a notice with none |
| `crypto` | The `TokenCipher` port and `KmsTokenCipher`. It reads no environment variable and holds no key material: AWS credentials are the SDK's provider chain's business and the key id is a constructor argument. `LocalTokenCipher` is under `@recouple/crypto/testing` and the index must never re-export it |
| `decision` | Map questions to Choice ≤255 / Score / Noul; Jev primary, Claude structured fallback; state is extracted fields, never document text |
| `adapters` | Interfaces only until their phase; a channel that submits still has to pass the DB approval gate |
| `packets` (Phase 3) | Append-only; the hash an approval names is a foreign key to the packet that was assembled, so an approval cannot authorise a packet nobody built. A packet's decision must be the same tenant's and the same case's — the foreign keys say each id exists, not that they are one case |
| `declined_candidates` | Every case we decline to fight gets a row with what it was worth and what was missing. A discard is not a decision; coverage has no numerator without this (docs/STRATEGY.md, ADD-1). `discovered_from` is **derived** from the notice's own `uploads` row, never passed in — a case whose notice records no arrival is refused (`ProvenanceUnknownError`), because a channel credited on a caller's say-so is a number that looks right. `uploads` is append-only since ADR 0024, so that row cannot be re-labelled after the declines attributed to it were counted; a notice stored before provenance existed gets its channel from a `document_arrivals` row an operator writes with `pnpm link:provenance`, which the database refuses for any document ingest already recorded an arrival for and for any channel but the three doors that existed then. `provenance_kind` says which of the two answered — derived like `discovered_from`, never passed in — so a coverage number can report the split rather than needing three joins to find it |
| `web` (apps/) | Supabase Auth for identity only; every read goes through `PostgresStore` as `app_rw`. The service-role key appears nowhere. Views in `components/` are pure functions of what the store returned; `app/` reads and renders them. `/settings/quickbooks/callback` is the one GET that writes: it cannot use `isCrossSite`, so the state cookie is its CSRF defence (ADR 0039) |
| `playbooks` (Phase 2) | Versioned, effective-dated, every fact carries provenance |
| `rules` (Phase 5) | JDM validation + backtest + shadow before promotion; auto-demote on precision drop |
| `qbo` (Phase 4) | Idempotent `Request-Id`, proactive token rotation, persist the rotated refresh token every cycle. A refresh holds the company's lock (`QboTokenStore.withRefreshLock`) and re-reads the tokens under it, because Intuit kills the old refresh token on use (ADR 0039). An error from Intuit names its OAuth error code at most — never a body, a code or a token |
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
with every invariant verified there, and the Postmark email-in parser and
pipeline step — which nothing in the app calls yet: there is no inbound
webhook route, so no email can reach it (`docs/VERIFY-CHECKLIST.md` §5).

Nine recorded suites, every one of them scored
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
| authored_pending | shapes the numbers do not cover yet | 100% / 100% | 100% | 1/1 |
| customer | simulated camera pages, on staffing and freight | 98.8% / 98.8% | 98.2% | 15/15 |
| formats | a distributor's merged-cell chargeback and an EDI 812 printout | 100% / 100% | 96.9% | 2/2 |

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
baseline is being compared against. `customer` was recorded on 2026-09-22
($0.39, OCR through Reducto for the twelve photographs), and `formats` on
2026-09-24 ($0.10), so `pendingSuites` is empty.

`customer`'s misses are the useful part of it. As first recorded (2026-09-22),
`stf-203-service-order-terms` — a staffing service order that fixes bill rates
and orders no quantities — read as `po` at 0.95, so its agreed rates were never
extracted as an agreement. The classifier's definitions now say that setting
prices is not ordering, and re-asked (2026-09-23, `--classify-only`) it reads
`price_agreement` five times in five, where the old prompt read `po` five in
five. The two classification misses that remained were `stf-203-dispatch-note`
(`correspondence`, expected `other`, 0.85) and `stf-203-short-payment-notice`,
which read `remittance_advice` at 0.70–0.75 three times in five **under the old
prompt too** — its correct answer in the first recording was a lucky draw.
Every classification number here was recorded with no pinned temperature, so
each is one sample, and a suite's classification rate could move by a document
between runs of the same prompt; a notice read as a remittance opens cases per
line instead of per claim, which made that instability a product problem, not
only an eval one. The classifier now asks at `temperature: 0`
(`CLASSIFY_TEMPERATURE`) on every model that accepts sampling, and sends none to
one that rejects it (`classifyTemperatureFor`: Sonnet 5, Opus 4.7 and later,
Fable and Mythos would answer a 400), so `RECOUPLE_CLASSIFY_MODEL` cannot turn
every read into an error. A cassette's classifier stamp records the temperature,
and `classificationIsCurrent` requires it, so every classification recorded
before the pin replays as stale until `pnpm record:cassettes --classify-only`
re-asks it; the eval says so rather than gating on it. That re-ask ran on
2026-09-24 ($0.2046, all 57 documents, prompt unchanged): 55 of 57, the same
two misses at the same confidences, and eight answers whose type held while
their confidence moved by a point or three. So the two misses were never the
sampling — they are what this prompt says — and the one-sample caveat above no
longer applies to any recorded classification.

The same day the definitions were sharpened for both, and re-asked in full
($0.2258, then $0.0114 on three documents and $0.2289 in full again): a
deduction notice is a payer's, not a retailer's; the printed title decides
notice against remittance by what it names, and "advice" alone decides
nothing — a remittance advice is a remittance and a deduction advice is a
notice, which the first wording got wrong for LOG-202's remittance; and
correspondence is a message one organisation sent another, while a note
written for one's own file is `other`. 57 of 57, and every notice and
remittance at or above 0.95.

The review floor is the product's as well as the eval's (ADR 0044). Wherever a
notice or a remittance would open its case(s) on its own, `readDocument` reads
the tenant's `org_settings.min_classification_confidence` and opens only when
`classificationIsActionable` holds — inclusive, so LOG-001's remittance at 0.95
still opens — and the reading fits its type. Anything else is held for a
person. In replay no recorded document is held any more: two were —
`stf-203-short-payment-notice`, a notice read as a remittance at 0.75, and
`stf-201-short-pay-remittance`, one unpinned sample at 0.92 — and both read
0.95 today and open; the hold is exercised by readings built to fall below the
floor. The `classification_confidence_meets_tenant_minimum`
guard, on Phase 2's `classified → evidence_pending` edge, still has no
evaluator because that edge is not taken yet. One field:
`log-202-rate-confirmation`'s counterparty came back as Crestline Dispatch
rather than Westhaven Paper Supply; nothing in the product reads it.
`stf-203-short-payment-notice`'s reason code came back as `CB-203` rather than
`PREMIUM-NOAUTH` until 2026-09-24: the page prints "CB-203 / PREMIUM-NOAUTH",
a chargeback's own number and then the payer's reason, and the notice schema
had nowhere to put the first. It now has `lines[].deduction_reference`, and
`reason_code` says a reason names a kind of reason while a chargeback or debit
memo number belongs to one deduction (*A deduction's own number*, below). Grounding on the
four STF-201 camera pages was 64–83% until the verifier learned column rules
(*A column rule is one glyph*, below); it is now 100% on the remittance and the
invoice, 81.8% on the time register and 91.3% on the approval. The two quotes
still refused are ones where OCR glued a rule onto a number (`STF-2011`,
`0.001`), and refusing them is right: the text layer disagrees with the value.

Classification is 57/57. Before `customer`, the two field
misses in the corpus were both the same field
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

About $0.0241 per document across 57 of them, and 428 of 1,133 fields carry a
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
one — `app.link_auth_user()` and `app.my_orgs()`, both security definer
(migration 0012, ADR 0015). `my_orgs()` takes the subject from the claims rather
than an argument; `link_auth_user()` takes the subject and email as arguments,
which `resolveSession` passes from the session the server verified — 0012's own
header says both read the claims, and it is wrong about that one — and since
migration 0033 it refuses any caller that carries a claim (ADR 0045). Document bytes
are durable and served through a route under the same policies, not a signed URL
(migration 0013, ADR 0014). The case page carries Phase 3's five actions —
decide, assemble, approve, record the filing, record the outcome — each shown
only where the state machine and the member's role allow it, and the approve
card never to the preparer (ADR 0020). One production case has been taken
through all five (2026-09-21, ending `partial`).

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

Production (Supabase project `hvheqbgkvwhlqutklwfh`) carries migration 0033 as
of 2026-09-24 (0019–0021 applied 2026-09-21; 0022–0027 applied 2026-09-22;
0028–0029 applied 2026-09-23, after being staged on the preview project that
morning; 0030 applied 2026-09-23 at 17:08, a minute after the preview
project; 0032 at 20:26 and then 0031 at 20:31, each after the preview
project — 0031 merged after 0032, and 0032 does not touch `approvals`, so the
order does not matter; 0033 on 2026-09-24 at 05:20, a minute after the preview
project). Each was read back — for 0027, `ledger_sync_anomalies` has RLS on,
`no_update_delete` and `no_truncate`, `app_rw` and `app_ro` hold SELECT only,
and `app.record_ledger_sync_anomalies` is security definer with EXECUTE held by
the owner and `app_rw` alone. For 0028 and 0029: the stored statements' md5s
equal the files'; `anon`, `authenticated` and `service_role` hold no privilege
on any relation or routine in `public` or `app`; `authenticated` is no longer a
member of `app_rw`; `recouple_app` still has SET on both app roles; every `app`
function has a pinned `search_path`, the guard included; the only
default-privilege rows still naming a request role are `supabase_admin`'s,
which 0028 skips by design; `coverage_by_period_by_source` is
`security_invoker` and computes `discovered_cents` from `uncased_cents`; and the
security advisor's `function_search_path_mutable` finding is gone. `postgres` —
the SQL editor and the MCP connector — can no longer `set role app_rw`, as ADR
0037 accepted; read-only checks as `postgres` are unaffected.

**A preview is not production** (2026-09-23). Vercel previews run against their
own Supabase project, `mozart-preview` (`jvbnqofmoamyhntjwjdn`), with their own
Auth and `DATABASE_URL`, and hold no Inngest, Anthropic, Reducto, QBO or KMS
keys. Inngest re-registers the app on every deployment, so a preview holding
Inngest keys takes production's jobs — which is how the 2026-09-23 daily ledger
sync ran on an unmerged PR's preview and wrote into production. Never give
Preview those keys or production's database; migrations go to `mozart-preview`
first. `docs/supabase.md` has the variable-by-variable split.

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

**A document that is read and opens nothing is still somewhere** (2026-09-23).
A delivery receipt and a rate confirmation uploaded from the case list in
production were read — as `pod` and `price_agreement` — and, being evidence
rather than notices, opened nothing. They then appeared nowhere: not on a case,
and not under "Documents waiting to be read", because they had been read. The
queued-upload notice had told the reviewer "the case will appear here when it
is", whatever the document turned out to be. Now it says what each kind will do,
and the case list shows **Read, not on a case**: every document with an
extraction and no `deduction_documents` row (`unattachedDocuments`, newest
first, with what it was read as). Each one has an Attach control that files the
recorded reading against an open case — `attachReadDocument`, then
`attachEvidence`, which writes the link and an `evidence.attached` event in one
transaction, and only when the case holds the document in no role. Nothing is
read and nothing is charged. A case reads a document's fields by document, so a
link is all that was missing — `reconcileCase` always did, and since 2026-09-24
so does the review page's `fieldsForCase`, which had read by
`extraction_results.deduction_id` and so showed a remittance-opened case, a
held notice a person opened and a list-attached document no fields at all. The
page lists a case's documents with `caseDocuments` rather than from their
fields, so the original it embeds is the notice by its link — a ledger case's
JSON extract included, which `/api/document` now shows in place, sandboxed —
and the packet names every file it encloses.
Uploading the same file on the case page files it the same way: the bytes
dedupe to the document already read, and `answerFromRecord` — asked first by
the inline upload, by the request that would queue a read and by the job —
files the recorded reading on the case with `attachEvidence` rather than
reading it again (`evidence.attached`, `read_again: false`, no model call;
`jobs.test.ts` and `upload-route.test.tsx`). What it cannot reach is an upload
to a second case while the first read is still running: nothing is recorded
yet, so it is queued, and the upload's `readKey` (the document id) is the
first upload's, whose idempotency window swallows it. Keying an attachment's
read on the case too is a follow-up.

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
that rather than asserting it. Nothing created a connection then: the KMS token
store came with ADR 0033 and the consent flow with ADR 0039.

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
survives. A `merged` case state is that decision's too — and ADR 0042 is that
decision (*A confirmed duplicate is merged*, below).

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

**A ledger window is anchored on what was paid** (ADR 0035, migration 0027).
The first production sync (2026-09-22) examined 12 invoices, found nothing and
recorded 8 anomalies: every entity was filtered by its own `TxnDate`, so a
payment inside the window applied to an invoice dated before it was
`application_to_unknown_invoice` — and in a net-30/net-60 world that is most
short-pays. `syncLedger` now lists **payments and credits** in the window, then
reads the invoices they name by id through `getInvoiceHistories` — a new read on
the `AccountingSource` port that returns each invoice with **every** application
the ledger has for it, whatever the date, and throws rather than return part of
one, because a partial tally reads as a short-pay that never happened.
`settlementLedger` in `core-domain` joins the two reads (one copy of each
payment, applications trimmed to the invoices asked for) and the detector is
unchanged. `packages/qbo/test/settlement-window.test.ts` replays the recorded
sandbox: 0 candidates and 8 anomalies before, the 3 short-pays and 1 anomaly
after. A run's anomalies are now rows, `ledger_sync_anomalies` — kind and ledger
ids, no detail text, written once and complete through
`app.record_ledger_sync_anomalies()` in the run row's own transaction, and
shown at `/coverage`.

**A credit memo is not cash, in either shape QuickBooks writes it** (ADR 0036,
no migration). ADR 0026 knew that applying a credit to an invoice is a write-off
rather than money arriving, and read it off the one line shape the hand-written
fixture has: a Payment line naming both the Invoice and the CreditMemo. The
sandbox recording holds the other shape for the ordinary case — payment 74 is
`TotalAmt: 0` with a $100 line naming Invoice 71 beside a $100 line naming
CreditMemo 73 — so line by line that invoice line was $100 of cash on a payment
that carried none, and credit memo 73 resolved to no invoice at all. Invoice 71
($205, $105 of cash, $100 written off) read as paid in full, which is precisely
the deduction `short-pay.ts` argues at length must never be netted away, arriving
through the mapper instead of the detector. `readPaymentApplications` now reads
a Payment once into cash and credits and **asserts the bound nothing checked
before**: cash applications summing past `TotalAmt` is `QboMalformedResponse`.
Pairing an invoice line to the credit line funding it is taken only where
arithmetic forces it — one invoice line makes the split subtraction; several
require an exact equal-amount match, one to one — and a credit matching none of
them, or two, refuses rather than apportions, the way two invoices on one line
already refused (two credit memos on one line now refuse too, where they used to
credit each the whole amount). The detector, `DEFAULT_MIN_DISPUTE_CENTS` and
every tolerance are untouched: only which numbers reach them moved. The full
recording now yields four short-pays rather than three, invoice 71 being the
fourth — an expectation moved because it was wrong, not because it was in the
way. Under ADR 0035's production window it stays three, since payments 72 and 74
are dated before it.

**Only the app roles hold grants, and invariant 7's guard is pinned again**
(ADR 0037, migration 0028). Migration 0022 replaced
`app.guard_threshold_direction()` with `create or replace` and no `set` clause,
which drops the search-path pin 0008 put on it; 0028 pins it again with
`alter function`, and suite 24 now asks the catalogue that *every* `app.*`
function is pinned and that the guard still refuses a loosening when the caller
shadows `array_length`. Separately, Supabase's default privileges grant its
request roles (`anon`, `authenticated`, `service_role`) ALL on every new object
in `public` — 0006 revoked `anon`'s once, for the tables that existed then —
and 0006 itself made `authenticated` a member of `app_rw`, so a token minted
with the JWT secret could `set role app_rw` with any `org_id`. Nothing uses the
Data API (the evidence from production is in the ADR: supabase-js is Auth only,
every database path is `recouple_app` with direct memberships, 24 hours of edge
logs show no `/rest/v1` reads), so 0028 revokes every privilege the three hold
in `public` and `app`, their default privileges, and the membership, then
re-reads the catalogue and aborts rather than warns if anything survived or if
`recouple_app` would lose `set role app_rw`. `service_role` is included (the
founder's call): the service-role key reaches nothing in `public`. CI finally
sees the platform — `supabase/tests/_supabase_shape.sql` creates the four
Supabase roles and their default privileges before `db:test` applies the
migrations — and suite 24 derives invariant 2's grant half for every role from
each `block_mutations` trigger's own events. Turning off the Data API in the
dashboard is the founder's switch, after 0028 is applied, the ledger sync has
run and both members have signed in; docs/supabase.md has the pre- and
post-apply queries. Production carries 0028 since 2026-09-23, and all three
conditions held that afternoon: the sync ran at 15:25, and both members signed
in through `app.mozart.financial/auth/callback` at 16:35 and 16:36. **The Data
API has been off since 2026-09-23**, and the app's logs showed no error after
the switch.

**Sign-in and the fan-out refuse callers they were not written for** (ADR 0045,
migration 0033). The two items ADR 0037 left open, closed as defence in depth,
since neither was reachable once 0028 was applied and the Data API was off.
The login form sends `shouldCreateUser: false`, so it creates no Supabase Auth
user, and an invitation is now the `users` and `memberships` rows **plus**
Authentication → Users → Add user → Send invitation in the dashboard
(`apps/web/DEPLOY.md`). The form answers every address alike. An unknown
address comes back `otp_disabled` (or `signup_disabled` once the project's
sign-ups are off), and every failure only an existing account can meet (the
per-address cooldown, the mail quota, the mailer) is answered as sent and
logged. Only what the provider refuses before it looks at the address is
shown: its request limit, or no answer at all. `requireSession` signs an
identity out at the provider (global scope) when the database answers **no
invitation** (SQLSTATE 42501 and that exact opening) or **no membership**, and
on nothing else, so a fault never costs a member their session. 0033 restates
`app.ledger_connections_to_sync()` and `app.link_auth_user()` in full: definer,
pinned, same results and grants. Each now refuses a caller carrying an `org_id`
**or** a `sub` (a Data API request always carries `sub`). `link_auth_user()`
also refuses, as `cardinality_violation`, an address two `users` rows answer to
case-insensitively, rather than linking one at random. `resolveSession` and
`listConnectionsToSync` clear the claims transaction-locally first. Suite 29
reads it back. Production carries 0033 since 2026-09-24, applied to
`mozart-preview` first and read back on both: the stored statement's md5 equals
the file's, both functions are still definer, pinned and of the same result
type, EXECUTE is held by `app_rw` and the owner alone, no `app` function is
unpinned, neither project has two users whose addresses differ only in case,
and a `sub`-only caller is refused by both while a caller with no claims still
lists the connections (tested in a block that writes nothing). Turning off "Allow new users to sign up" in the
dashboard is the founder's switch, after the web change is deployed and both
members have signed in through it.

**Coverage counts each deduction once** (ADR 0038, migration 0029).
`coverage_by_period_by_source` added `opened + declined`, and `declineCase`
writes a declined row naming the case with its full amount while the case stays
in `deductions` — so the first case a reviewer declined would have been in its
channel's denominator twice. Production has no declines, so nothing published
moved. `discovered_cents` is now every case opened, in the month it was found,
plus the declines that never became a case (`deduction_id is null`); a later
decline moves no month's denominator. `declined_count` and `declined_cents`
still report every decline, because `coverage_by_period_totals.coverage_of_seen`
is 0014's `filed ÷ (filed + declined)` and narrowing them would make it rise
whenever a case is declined — so `opened + declined` is no longer `discovered`,
and the view's column comments say so. Same columns, same order, still
`security_invoker`; suite 25 and `coverage-declined-case.test.ts` decline a real
case and find its dollars once. Production carries 0029 since 2026-09-23.

**A customer's owner connects their own ledger** (ADR 0039, migration 0030).
`pnpm link:qbo` was the only way a connection existed, so no customer could
connect their books without an operator holding their refresh token in a
`.env`. Settings → QuickBooks now runs the consent in the app. `POST
/settings/quickbooks/connect` sends an owner to Intuit with one scope and a
single-use state held in a `__Host-` cookie — `HttpOnly`, `Secure`,
`SameSite=Lax` because Intuit's redirect back is cross-site, ten minutes.
`GET /settings/quickbooks/callback` is the one GET in the app that writes and
the one route that cannot call `isCrossSite`, so the state is its CSRF defence:
compared in constant time, cleared on every exit, and the only thing the cookie
says that is taken on trust — the org and the member are re-derived from the
live session, which must still be an owner there. The code is exchanged in the
request, never in a job, because it is a credential and an event payload is
durable in a third party; the new token must then read the company Intuit named
before anything is written. The redirect URI is derived,
`${siteUrl}/settings/quickbooks/callback`, so a Connect pressed on any other
host is sent to the canonical one to start again rather than coming back to a
host that holds neither the cookie nor the session.

`connectQboCompany` is the one way a connection row is made — `link:qbo` calls
it too, and `createConnection` is gone. It seals first, so a KMS failure writes
nothing and leaves a working connection working; then takes the company's lock;
then writes the claim, the sealed credential and the audit row in one
transaction. **One enabled connection per company across the deployment**, as
a partial unique index: an agency's two workspaces may not both sync one
manufacturer's books, and a company held elsewhere is
`AccountConnectedElsewhereError` with nothing stored. One row per member per
company: the same owner reconnecting reuses theirs, and a different owner's
connect is a move — the old row off, a new row on, `created_by` frozen by
trigger, since the member a sync acts as is not something to edit. **Owner-only
is the database's rule as well as the app's**: `app.member_is_owner()` gates
writes to `accounting_connections`, and `memberships` writes are owner-only too
— any writer could previously make themselves an owner, which made "owner only"
worth nothing. A credential row's `created_by` and an audit row's `actor_id`
must now be the caller.

**A token refresh is serialized per company.** Intuit replaces the refresh
token on every use and kills the old one, so two refreshes racing from the same
row leave one of them holding a dead token — and a customer who has to
reconnect. `QboTokenStore.withRefreshLock` is a transaction-scoped advisory lock
on the lock pool, seed 2 on `provider:realm`, and the client re-reads the tokens
under it, so the second of two concurrent refreshes finds the first one's
tokens and does not refresh at all. Connect, disconnect and both scripts take
the same lock, and nothing nests it. A wait is capped at 15 seconds
(`LedgerAccountBusyError`, nothing changed) and every OAuth call at 10, body
included; a lock connection that fails is destroyed rather than pooled, because
its aborted transaction would fail the next document read to borrow it. Disconnect turns the connection off and
commits that first, then revokes at Intuit and audits the result —
`confirmed`, `failed` with a class name, or `not_attempted` — and a failed
revoke never undoes the disable. `pnpm unlink:qbo` is the operator's release
for a connection nobody will press Disconnect on, since one dead connection
would otherwise hold its company from every other workspace. The sync now
releases one itself (ADR 0046): when Intuit answers a refresh with
`invalid_grant`, or the refresh token's own expiry has passed
(`deadGrantOf`), the run is recorded `failed` as before and then, under the
company's lock, the connection is turned off — only while the refused
credential is still the latest, so a reconnect since is never undone — with
`accounting_connection.disconnected` (`via: 'ledger_sync'`) and a
`not_attempted` revoke row, as the owner the run acts as. The failure is not
retried, `invalid_client` never releases, and a member who is no longer an
owner is refused and left for `pnpm unlink:qbo`. The settings page says why the
connection is off. The first sync is
queued on connect. A redirect that arrives again after it connected — the first
production click-through saw one, a second later — is refused like any request
without a state, but says the company is connected when this member's own
connection to it stored a sign-in in the last two minutes — as does an arrival
whose code the first had already spent — and every refusal and connect logs its
reason, the notice given and the request's fetch metadata. No code, token or anything Intuit said reaches a log line, a
redirect, an event or an audit payload, and the route and store tests spy on all
four. Production carries 0030 since 2026-09-23, applied to `mozart-preview`
first and read back on both: the stored statements' md5 equals the file's, the
per-org unique is gone and the partial index is there, `app.member_is_owner()`
is pinned, not definer, and executable by `app_rw` and `app_ro` alone, the
policies read as written, the request roles still hold nothing, and the one
existing connection — made by the owner — is enabled with its six credential
rows. Nothing here has met a live Intuit consent or revoke yet.

**Coverage is on a page** (`/coverage`, no ADR, no migration). What we found and
what we filed, per channel: a card per channel with its trailing-12-month rate,
a month-by-channel table, and the ledger sync's recent runs with what each
connection's latest completed run found that a person has to look at in
QuickBooks. Two reads, `PostgresStore.coverageReport` and `ledgerSyncHealth`,
each one tenant transaction as `app_rw`, reading the views and tables that
already grant it SELECT. **Never blended** (ADR 0030 §2): the all-channels
totals carry dollars and no rate — `coverage_by_period_totals`' two blended
rate columns are never selected, so no view can render one — and the page says
why there is no combined figure. **Every division is the database's**: the
trailing rate is `round(sum(filed)/sum(discovered), 4)` over the window in SQL,
the months are pinned to UTC for the read, and the page only formats. The
dollars no channel can claim (`unknown`, ADR 0030 §3) are shown and explained
but get no rate; a month that filed more than it found is shown unclamped with
its likely reason; and the confirmed duplicates still counted twice (ADR 0032
§6) are counted, summed and split by channel in SQL — a case in two confirmed
pairs once — with links to them. Anomalies are per connection, from its own
latest completed run, with the window that run read, because an anomaly
missing from a later run may only have aged out of the 35 days. A run counted
before migration 0027 kept no anomaly ids and says so. Every member sees the
page, `read_only` included; it has no action on it. The QuickBooks and crypto
error classes now carry literal names, since a run's `error_class` is what the
page's guidance keys on and a minified class name would read as nothing.

**A remittance-opened case reconciles against its line** (ADR 0040, no
migration). Every case ADR 0028 opened showed no findings, because
`reconcileCase` looked for a `deduction_notice` and returned nothing without
one. A case whose `discovered_via` is `remittance_line` now reconciles against
the line whose rebuilt claim id is its own (`reconcileRemittanceLine`): the
line's `gross − net` against its printed deduction, the invoice it short-paid,
and then the same delivery, appointment and waiver checks a notice gets.
`charge_waived_in_writing` is its own pass rather than a branch of the
supersession loop, because both recorded readings of LOG-001's `04` report the
waiver as a commitment that moves nothing, and the sentence that wins the case
was being skipped. The upload route sends the reviewer to the case a remittance
opened when it opened exactly one, and to the list with a count when it opened
several. `packages/pipeline/test/log-001.test.ts` walks the demo from the
recorded cassettes and reaches all three findings.

**An approval is written by the person it names** (ADR 0041, migration 0031).
`app.enforce_separation_of_duties()` judged the name on an `approvals` row —
not the preparer, and an owner or approver — and never who wrote it, while
`tenant_insert` admits any writer. So the analyst who prepared a decision could
insert an approval naming an approver, pass every trigger, and then file the
submission the gate let through; only the store's `requireCaller` was in the
way. `app.approval_names_its_approver()` is 0016's authorship trigger for the
other column SoD reads: `approver_id` must be `app.current_user_id()`, with no
exception for the table owner or a session with no claims. It fires ahead of
SoD by name, so a forged approval is refused as forged. The gate and SoD are
untouched. Nine suites had written approvals as the analyst or as the owner;
each now acts as the approver it names, and suite 27 is the hole. Applied to
`mozart-preview` and then production on 2026-09-23, and read back on each: the
stored statement's md5 equals the file's, the trigger sits ahead of
`enforce_separation_of_duties` with its `search_path` pinned, `approvals`
grants are unchanged (`app_rw` SELECT and INSERT, `app_ro` SELECT), and an
approval naming someone other than the caller is refused with SQLSTATE 23001
even for the table owner with no session.

**A confirmed duplicate is merged** (ADR 0042, migration 0032). "Same
deduction" now merges the pair in the same click: one append-only
`deduction_merges` row, and **the database does the rest**. `app.merge_refusal()`
names why a pair cannot be merged (`not_confirmed`, `already_merged`,
`merged_before`, `absorbs_another`, `both_filed`, `amounts_disagree`,
`not_mergeable_state`) or answers null; `app.merge_survivor()` keeps the case
somebody worked on (filed over decided or declined over untouched), else the
older one. The check trigger refuses a row that disagrees with either, then an
`AFTER INSERT` trigger moves the merged-away case to the new `merged` state and
writes `case.merged_into` and `case.absorbed`; a trigger on `deductions`
refuses any move into or out of `merged` the table does not back, so the state
and the ledger cannot disagree either way. `merged` is closed but not terminal
(`CLOSED_STATES`, `MERGEABLE_STATES` in `core-domain`): a case may be merged
away from any state before a filing — its decision, packet or approval stay on
the record — and the survivor may be at any stage; two filings refuse. The
amounts must agree to the cent. **An undo** is an `unmerge` row: the case goes
back to exactly the state it left, and the database also appends
`case.duplicate_verdict_withdrawn` on both, so the pair is an open question
again rather than stuck; a pair is merged once and undone once, either way
round (a unique index), so a mistaken undo can be re-confirmed but not
re-merged. Which verdict stands on a pair is `duplicate_pair_verdicts`' answer,
and the list, the verdict write, the merge check, the coverage page and the
case page all read it. Any writer may merge or undo; every row names who.

Nothing more is hung on a merged-away case: a trigger on `decisions`,
`packets`, `submissions`, `writeoffs`, `writebacks`, `declined_candidates`,
`deduction_documents` and `deduction_identifiers` refuses one with SQLSTATE
`RCM01`, after taking `for key share` on the case so a link racing a merge
waits and is refused; it sorts after `enforce_approval`, which is untouched. The
store turns `RCM01` into `CaseMergedAwayError` (non-retriable in a job) and
`RCM02` into `MergeRefusedError` with its reason; the upload route and
`attachReadDocument` refuse a merged case before anything is stored or read.
**Every reader of `deduction_identifiers` maps a merged-away case onto its
survivor** through `deduction_merges_current` — `knownIdentifiers`,
`identityCandidates`, the ledger sync's, `explainDuplicateCase`,
`explainDuplicateIdentifier` and `caseForDocument` — so an arrival matching
both halves is `exact` on the survivor rather than `ambiguous`, and a ledger
re-sync lands there. `coverage_by_period_by_source` drops a merged-away case
and counts its survivor in the month and under the channel of the earliest
notice across the two; the coverage page's "counted twice" is now only the
confirmed pairs that could not be merged, each with its reason on the case page.
Nothing is deleted, no identifier moves, no approval or filing row is written,
and no UPDATE or DELETE grant is added. Production carries 0032 since
2026-09-23, applied to `mozart-preview` first and read back on both: the stored
statement's md5 equals the file's, `deductions_state_check` is the only state
check and admits `merged`, `deduction_merges` has RLS with `app_rw` holding
SELECT and INSERT and `app_ro` SELECT, its four triggers are in place, the work
refusal is on all eight tables, the seven functions are pinned and none is
definer, the three views are `security_invoker`, the coverage view kept its
columns, the request roles still hold nothing, and the coverage figures did not
move — no case is merged yet.

**What to work on next is a queue, and a ledger case can be decided** (ADR
0043, no migration). The case list led with the newest 100 cases whatever their
state, so an old, urgent case fell off the page once a hundred newer ones
existed, and nothing said what to do next. It now opens with a review queue:
every case a person can act on now — not closed (`merged` included), not
`submitted`, not declined — in the founder's four buckets: due within
`DUE_SOON_DAYS` (14, in `core-domain`, which the deadline label imports too),
past the deadline, no deadline printed (every ledger case and most remittance
lines, oldest short-pay first, and the page says age is standing in for a
window nobody printed), then due later; ties go to the larger amount, then the
id. `rankForReview` is the order — pure, no clock of its own, property-tested —
and `PostgresStore.reviewQueue` reads as `app_rw` in the same order with the
same constant and the same `today`, so its limit of 500 keeps the most urgent
rows; `review-queue.test.ts` holds the two to one answer at every cut, and the
page says how many it is not showing. Each row says its bucket and its next step
in words, from the state and whether an approval exists — decide, assemble,
approve, record the filing — and an approval the viewer prepared, or whose role
cannot give one, reads "Waiting for another approver", because the database
would refuse them. Every member sees it, `read_only` included; it has no action
of its own.

Planning it found that a ledger case never left `discovered` — only the notice
and remittance paths crossed to `classified` — so the case page offered it
neither decide nor decline, and ADR 0029's "declinable the day it is opened" was
true of the store and false of the product. `recordLedgerCase` now crosses the
existing `discovered → classified` edge (`doc_type_known`, which a ledger
extract is by construction) in the transaction that links the extract, with a
`case.classified` event naming the sync, and every sync first sweeps the
tenant's `discovered` cases whose notice arrived through `erp_sync`. Production's
two moved on 2026-09-23 at 21:49 UTC, when the founder invoked the fan-out from
the Inngest dashboard: the run logged `classified 2`, and each case carries one
`case.classified` event. The sweep
does not reach ADR 0029's crash window: a case `openCase` committed before the
sync died short of linking it has no notice to say where it came from. Step B, a
shadow-only model tier, is designed in the ADR and not built — it waits on Jev
access, both cassettes and a triage eval.

**A doubtful classification is held for a person** (ADR 0044, no migration).
`min_classification_confidence` had been in every tenant's `org_settings` since
0002, guarded by invariant 7, and nothing read it: a notice or a remittance
opened its case(s) on its type alone, so a notice misread as a remittance
opened one case per line. Now, where a read would open a case by itself — a
`deduction_notice` or `remittance_advice`, no case named, `allowCaseOpen` — the
floor is read first (`classificationFloor()`, as `app_rw`, before anything is
spent; a missing row is `ClassificationFloorError`, never a default), and the
case opens only at or above it with a reading that fits its type (`typeFits`:
validated against the type it was read as, and a remittance with at least one
line). Otherwise the document is **held**: read and recorded exactly as any
other, against no case, then one `audit_log` row `document.held` naming the
acting member (0030's policy) with `{doc_type, confidence, floor, reason,
fields?}` — `below_floor` wins when both apply, and `fields` are schema paths
filtered to the type's own, present exactly when the reading did not fit.
Evidence, an attachment to a named case and an unauthenticated email are never
held. `recordedRead` asks `documentHold` after `caseForDocument`, so a
redelivery, a "Read again" and the same file uploaded again are answered from
the record with no model call; the upload and reread routes say
`upload_held`/`reread_held`, and the job carries `held` and logs its reason.
"Read, not on a case" shows each document's confidence and its hold line, and
**Open a case from it** on every held notice and every held remittance but one
with no lines: `POST /documents/[id]/open-case` → `openHeldDocument`, under the
document's read claim, which restores the recorded reading and **opens from
whatever survived** — a notice that did not fit its type, or whose stored rows
lost a required field to missing provenance, opens with those fields empty,
exactly as the automatic path always has ("better a case with no deadline than
no case"); the gate got stricter, what a person may open did not. It refuses
only what has nothing to open (a remittance with no lines, or a reading no
longer the type the hold named), runs the same
`openCaseFromNotice`/`openCasesFromRemittance` with only the store in reach,
stamps `held` (with the hold's `fields`), `confirmed_by` and, when the restored
reading does not fit, `fields_missing_on_open` on `case.discovered`, and then
writes `document.hold_released`. Not one transaction, by the store's shape; the
release comes after the case, so a crash between leaves a case under a stale
hold (which `caseForDocument` answers first) rather than an unheld notice a
redelivery would pay to read again. `audit_log.subject_id` has no index, which
the hold look-ups scan past; indexing it is a migration and a follow-up.

**Bold is not a word on the page** (no ADR, no migration). Reducto began
wrapping bold runs in text PDFs in `<b>…</b>` (seen 2026-09-23: LOG-001 through
the app verified 66 of 77 quotes, and every miss was a bolded value). The model
quotes the page without markup, so each one read as "quote not found" — and the
glyph fold read the tag's `b` as an `8`, so a bold "$4,800.00" verified an
invented "$84,800.00". `withoutInlineMarkup` (`packages/extraction/src/markup.ts`)
removes named inline formatting tags (`b`, `strong`, `i`, `em`, `u`, `s`, `sup`,
`span` and the like), turns `<br>` into a newline and decodes the escapes a
serialiser writes (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`,
numeric), and nothing else: table markup and `<dispatch@carrier.example>` stay.
`ReductoOcr` applies it to every block, so the stored text layer, the boxes and
the verifier read the same words; `checkQuote` applies it again to page and
quote, because a text layer stored before the fix keeps its tags (invariant 2)
and is what a later read of that document checks against. That is the only
thing the check gained. No recorded string changes under it, so `pnpm eval` is
byte-identical.

**A column rule is one glyph, and a number keeps its point** (no ADR, no
migration). A camera page prints its columns separated by a vertical rule, and
neither reader draws it the same way twice: Reducto writes `|`, `I` or nothing,
and the model — reading the pixels, since a JPEG's text layer is withheld from
it (ADR 0009) — writes `|` or `I`. Twelve right quotes on the STF-201 pages
failed on nothing but that. `withColumnRules` (`markup.ts`) turns a
whitespace-bounded token that is only a rule glyph (`|`, `I`, `l`, `!`, `¦`,
`│`) into `|`; it never touches a character inside a longer token and never a
digit. `checkQuote` gains a `separator` tier after `exact`, and every later tier
reads the rule-normalised text, and `locateQuote` normalises the same way (416 →
428 boxes). Two holes closed with it. The glyph fold read a rule drawn as a lone
`I` as a `1`, so an invented "Qty 201" verified against a page reading "Qty 20
I"; on normalised text that `I` is punctuation and nothing folds. And the
punctuation tier dropped every `.` and `,`, so "$60,000" verified against
"$600.00"; a decimal point or thousands separator between two digits is now
kept, by that tier and by the fold (which folds letters to digits first, so an
OCR'd "$6OO.OO" still reads). Every one of the 53 matches the old punctuation
tier made still verifies. `customer` grounding rose 92.9% → 98.2%, overall
98.0% → 99.4%, and the baseline was re-recorded for those two numbers only;
`grounding.test.ts` and `ocr.test.ts` pin both holes shut.

**A case's page opens however old the case is** (no ADR, no migration). The
case page found its case in `listCases()`, the newest 100, so past a hundred
cases every older one was a 404 on its own page — the old, urgent cases the
review queue links to among them. It now reads `caseSummary(id)`: one row
through RLS, the list's own SELECT and mapping, `undefined` (and a 404) for a
case this tenant cannot see. The case list's four figures had the same limit
and summed the newest hundred; they now fold `caseTally`, a per-state count,
sum and due-soon-or-past count over every case, with what a state means left
to `isClosed` in the app, and the ledger says when its table lists only the
newest. The attach control under "Read, not on a case" still offers only the
open cases among the newest hundred.

**A deduction's own number is not its reason** (no ADR, no migration). A
deduction notice's lines now carry `deduction_reference` — a chargeback, debit
memo or deduction number printed beside the reason — and `reason_code` is told
the difference; schema 1.2.0. All 17 recorded notices were re-read with
`pnpm record:cassettes --extract-only --doc-type deduction_notice` ($0.4127),
which re-asks the extractor alone against the OCR its cassette already holds:
no Reducto key, and the classification and the pages stay byte for byte.
`customer` rose to 98.8%, and `stf-203-short-payment-notice` reads
`PREMIUM-NOAUTH` and `CB-203` exactly, which `packages/evals/test/deduction-reference.test.ts`
asserts rather than trusting the eval's containment match. Four of the eight
Harbor Lane notices (scans included) put their own notice number there as well, against the
description, and one reported the text `"null"` with no quote, which provenance
drops before it is stored. Nothing downstream reads the field yet.

Every extraction recorded now carries an `extractor` stamp — model, schema
version and a hash of the system prompt and that type's instruction — and
`pnpm eval` names the ones this checkout's extractor did not give, as it does
classifications; the 40 recorded before the stamp are counted, not listed. The
remittance side was tried and **withdrawn**: told about the reference, the
model read LOG-202's two deductions on one invoice as two lines, and
`openCasesFromRemittance` keys a line by payment and invoice, so the $300 line
exact-matched the $500 one and was merged into it — a deduction lost without a
word. That collision does not need the new field: any remittance that prints
two deductions against one invoice as two lines meets it today, and fixing it is
identity's job (ADR 0028's claim key), a follow-up.

The formats that were missing have fixtures (`packages/fixtures/src/formats.ts`,
suite `formats`), both from the beachhead — a foodservice manufacturer and a
broadline distributor. A chargeback statement whose program cells are merged
down their groups, so each reason code is printed once for several lines, the
same item sits in two programs under two codes, and three subtotal rows are not
lines. And a supplier portal's printout of an EDI 812, which states every amount
twice: once as money and once in the raw segments with the decimal point
implied (`184250`), which a reader must not copy. Both are generated from one
table, and `formats.test.ts` holds them to it. Recorded 2026-09-24 ($0.1036):
both read at 100% recall and precision — every line took its group's code, no
subtotal was read as a line, and no EDI amount was copied as money. Grounding on
the chargeback is 93.8%: the five reason descriptions a merged cell prints
across two rows ("Deviated price" / "billback") come back joined, and a joined
quote is not on the page. That is this format's real cost, measured. With it,
Phase 1's fixture list is complete. Real customer documents would still be worth
more than all of them.
