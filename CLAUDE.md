# recouple — deductions agent platform (AI-written code touches money paths)

A deterministic, human-gated document workflow for recovering invalid retailer
deductions. Not an autonomous agent: ingest → classify → plan evidence → decide
→ assemble packet → **a human approves and submits** → record outcome → invoice
the contingency fee. Agentic loops are reserved for exactly two bounded steps
(evidence planning, unknown-retailer cold start).

## Non-negotiable invariants (never violate; enforced by the database + hooks)

1. No `submissions` / `writebacks` / `writeoffs` INSERT without an `approvals`
   row for that exact `decision_id`. The trigger stays. This is a one-way door.
2. `*_events`, `documents`, `decisions`, `approvals` and `audit_log` are
   append-only. Never add UPDATE/DELETE grants. Corrections are new events.
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

Phase 0 foundations → 1 ingest+classify → **1.5 ERP read + triage** → 2
evidence+decision (EV-gated) + portal **read** → **2.5 EDI 812/820** → 3
packet+approval+manual submission+outcomes → 4 QBO write-back + contingency
billing → 5 learning loop → 6 careful autonomy.

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
| `extraction` | The reader gets no tools, ever. Models report verbatim quotes; our code does the arithmetic |
| `pipeline` | Steps are pure functions over ports. `@recouple/pipeline/testing` never reaches production |
| `fixtures` | Document text, ground truth and expected extraction live together so they cannot drift |
| `evals` | Never move a baseline to make a run pass |
| `store-postgres` | Runs as `app_rw` with the tenant's claim set transaction-locally, so a pooled connection cannot carry one tenant's claims into another's query. The service role never appears here |
| `decision` | Map questions to Choice ≤255 / Score / Noul; Jev primary, Claude structured fallback; state is extracted fields, never document text |
| `adapters` | Interfaces only until their phase; a channel that submits still has to pass the DB approval gate |
| `declined_candidates` | Every case we decline to fight gets a row with what it was worth and what was missing. A discard is not a decision; coverage has no numerator without this (docs/STRATEGY.md, ADD-1) |
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

Four suites, gated separately (never blended — the mix changes, and a blended
number moves when it does):

| Suite | What it measures | Recall / precision | Grounding | Classification |
| --- | --- | --- | --- | --- |
| authored | does the pipeline work | 100% | 100% | 8/8 |
| held_out | does it generalise | 100% | 100% | 12/12 |
| scanned | does it survive a scan | 100% | 98.4% | 4/4 |
| dense | does it survive a 42-row remittance | 100% | 100% | 1/1 |
| email_body | does it work with no page at all | 100% | 100% | 1/1 |

About $0.021 per document across 26 of them. Extraction streams with a 32,000
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

Still to do before Phase 1 is done: the Inngest binding over the existing steps,
and fixtures for the formats still missing — dense retailer tables with merged
cells, and EDI-derived portal exports. Real customer documents would be worth
more than all of them.
