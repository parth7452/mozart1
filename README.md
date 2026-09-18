# recouple

Deductions recovery for CPG suppliers and their retail customers. A supplier
ships to a retailer, the retailer short-pays the invoice with a coded reason, and
somewhere between 5% and 15% of gross sales leaks out this way — most of it never
challenged because challenging it is slow, deadline-bound paperwork.

recouple is the paperwork, automated: ingest the notice → classify it → plan the
evidence → decide → assemble a packet in the retailer's required format → **a
human approves and files it** → detect the recovery → bill a share of what was
actually recovered.

It is a deterministic, human-gated workflow, not an autonomous agent. Genuine
agentic loops are reserved for two bounded steps: planning evidence, and
cold-starting an unknown retailer.

## The invariants

Seven rules the code is not allowed to break, enforced by the database rather
than by good intentions. In full in [CLAUDE.md](./CLAUDE.md); the two that shape
everything else:

- **Nothing goes out and nothing is written back to accounting without an
  approval row for that exact decision.** A Postgres trigger fails the
  transaction. There is no application-level path around it.
- **Truth is append-only.** Events, documents, decisions, approvals and the audit
  log take INSERT and SELECT only, hash-chained for tamper evidence. Corrections
  are new rows.

## Quickstart

Requires Node 20+, pnpm 10+, and a Postgres 16 you can throw away.

```bash
pnpm install
cp .env.example .env            # only DATABASE_URL matters for Phase 0

pnpm typecheck
pnpm test                       # 149 unit, property and pipeline tests
pnpm db:test                    # migrations + 58 database invariant assertions
pnpm eval                       # replays cassettes, scores against ground truth
pnpm verify                     # all four, in the order CI runs them
```

`pnpm db:test` applies every migration to the database in `DATABASE_URL` and then
runs the invariant suites. Point it at a scratch database — the suites roll back,
the migrations do not.

Expected tail of `pnpm db:test`:

```
  ok — submission without an approval fails at the DB (blocked: submissions blocked: no submit approval row for decision …)
  ok — the trigger rejects UPDATE even for the table owner (blocked: append-only table deduction_events: UPDATE is not allowed)
  ok — a tenant cannot insert rows owned by another tenant (blocked: new row violates row-level security policy …)
database invariants: all suites passed
```

## Layout

```
recouple/
├─ packages/
│  ├─ core-domain/      money (integer cents), case state machine, reason codes, invariants
│  ├─ decision/         DecisionProvider contract, schemas A–D, state hashing
│  ├─ adapters/         SubmissionChannel + EvidenceSource contracts
│  ├─ ingest/           upload hardening, zip-bomb check, malware scan gate
│  ├─ extraction/       typed schemas, the no-tools reader, reconciliation
│  ├─ pipeline/         ingest → classify → extract as pure steps over ports
│  ├─ fixtures/         generated documents + labelled ground truth
│  └─ evals/            field-level scoring and the regression gate
├─ supabase/
│  ├─ migrations/       append-only DDL, approval trigger, RLS policies
│  └─ tests/            invariant, RLS and separation-of-duties suites
│  ├─ store-postgres/    the same PipelineStore against Postgres, under RLS
├─ apps/review-prototype/  a reviewer's workspace over the recorded output
├─ scripts/db-test.sh   applies migrations to a scratch DB, runs the suites
├─ docs/adr/            architecture decision records
└─ .claude/             hooks, slash commands (CLAUDE.md is at the root)
```

## Where the build is

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Foundations: append-only DDL, approval trigger, RLS, roles, money maths, state machine, contracts, CI | **done** |
| 1 | Ingest + classify: upload hardening, scan gate, email-in, doc-type, typed extraction with provenance, OCR, reconciliation, fixtures, evals | **pipeline done and measured**; `apps/web` and the Inngest binding remain |
| 2 | Evidence + decision: playbooks, cold start, Jev + Claude providers, confidence gates, calibration | — |
| 3 | Packet + approval + manual submission + outcomes | — |
| 4 | QBO write-back, attribution, Stripe contingency billing | — |
| 5 | Learning loop: override capture, candidate rules, backtest, shadow, promotion | — |
| 6 | Careful autonomy — only where per-tenant ECE < 0.10 is sustained | — |

Deliberately not built, by design rather than by omission: retailer portal
credentialed fetch, browser-agent auto-submission, EDI/carrier/3PL connectors,
NetSuite and Xero. Their interfaces exist (`SubmissionChannel`,
`EvidenceSource`), so each is a new implementation rather than a refactor.

## How extraction is kept honest

Three things, none of which is "trust the model":

**Every field carries provenance, and the quote is checked.** A field arrives
with the page it was read from and the text exactly as printed. We then look for
that text in the page and record whether we found it. A quote that is nowhere on
the page is the signature of an invented value, and it is caught before a human
sees the field. Bounding boxes are stored when the model offers one, but the
reviewer UI highlights the quote — a confident rectangle in the wrong place is
worse than no rectangle ([ADR 0007](./docs/adr/0007-phase-1-ingest-and-extraction.md)).

**The model copies; our code computes.** Money comes back as the verbatim text on
the page. `parseMoneyToCents` turns it into integer cents, and
`reconcileNotice` does the shortage arithmetic, the total check and the
three-way match against the PO, invoice and delivery document. A model that does
its own arithmetic leaves nothing to check.

**The model's output is validated against a schema it never sees.** It returns a
flat list of `{path, value, confidence, source_page, source_quote}` records; we
rebuild the typed document from them and validate it here. A path that is not in
the schema is dropped, a quantity that will not parse is dropped rather than
rounded into something plausible, and a required field that never arrived fails
loudly instead of vanishing ([ADR 0008](./docs/adr/0008-flat-wire-format-for-extraction.md),
which also records why the nested-schema approach could not be used).

**The reader has no tools and no clean bill of health by default.** The reader
client is constructed without a `tools` parameter at all, so an instruction
injected into a PDF has nothing to reach for, and document text is wrapped in
quarantine delimiters with any forged delimiter defanged first. Nothing reaches a
model until the document has a recorded `clean` scan verdict — and with no
scanner configured the verdict is `error`, not `clean`, so an unconfigured
environment reads nothing rather than reading everything.

## Fixtures, cassettes and evals

Fixtures are generated, not committed as binaries: the document text, its ground
truth and its expected extraction sit in the same file, and the suite fails if
they disagree. Three cases ship: the plan's worked Walmart code 24 shortage
($3,120, four documents), a KeHE claim whose only evidence is an unsigned
carrier-generated report, and a Target price-discrepancy claim the PO
contradicts.

`pnpm record:cassettes` calls the API once per fixture and writes what the model
actually said to `packages/fixtures/cassettes/`. `pnpm eval` replays those
recordings through the same flatten-and-verify code production uses, scores them
against ground truth, and fails when recall, precision, grounding or
classification accuracy drops more than two points below the recorded baseline.
CI runs the replay, so tests never call a model or spend anything.

### The recorded baseline

Eight documents, Sonnet 5 extracting and Haiku 4.5 classifying:

Four suites, each gated on its own baseline — never blended, because the mix
changes and a blended number moves when it does:

| Suite | What it measures | Recall / precision | Grounding | Classification |
| --- | --- | --- | --- | --- |
| `authored` | does the pipeline work | 100% | 100% | 8 / 8 |
| `held_out` | does it generalise to documents written elsewhere | 100% | 100% | 12 / 12 |
| `scanned` | does it survive a rasterised, skewed, JPEG-degraded page | 100% | 98.4% | 4 / 4 |
| `dense` | does it survive a 42-row, two-page remittance | 100% | 100% | 1 / 1 |

25 documents, 464 extracted fields, $0.52 to read all of them.

### What a document costs, and how that scales

| | Single-line notice | 42-row remittance |
| --- | --- | --- |
| Output tokens | ~900 | 10,702 |
| Latency | ~7s | ~63s |
| Cost | ~$0.015 | $0.128 |

Cost on a dense document is almost entirely output tokens, at roughly **250
output tokens per row**. That number sets a hard limit: extraction now streams
with a 32,000-token budget, which is about 120 rows. Past that the read is cut
off — and it fails loudly rather than storing a truncated document as a complete
one, because a remittance missing its last fifteen lines is worse than one that
never arrived.

Against the plan's $0.20–$1.00 per case: a four-document case of simple notices
runs about $0.06, and one carrying a dense remittance about $0.17. The estimate
holds.

Treat 100% across the board as "the corpus is not hard enough yet", not as
"extraction is solved". These are generated PDFs and simulated scans. The numbers
that matter will come from real customer documents, and the formats still missing
are the ones most likely to move them: dense retailer tables with merged cells,
notices in an email body, EDI-derived portal exports.

The first run did find one real defect — in our spec, not the model. Full account
in [ADR 0008](./docs/adr/0008-flat-wire-format-for-extraction.md); the short
version is that a field asked whether a signature was *visibly* present, which no
text layer can answer, when the question that matters is whether the consignee
signed. The model answered the question as written, correctly. The description
was fixed; the ground truth was not touched.

## Seeing it work

`apps/review-prototype` builds a self-contained review workspace from the
recorded data — `pnpm build:review`. It is the scanned Walmart notice with every
extracted field placed on the page: click a field and its box lights up on the
scan, click a box and it scrolls to the field. Each row carries the value, the
model's confidence, whether the quote was found on the page it cited, and the
quote itself.

It is a prototype over recorded output, not the product: no database, no auth,
and the approve button is deliberately dead, because approving is a Phase 3
action that a Postgres trigger governs.

## The app

`apps/web` is the real thing: Supabase Auth, a case list and a review route,
reading through the same RLS policies as everything else.

```
pnpm --filter @recouple/web dev        # needs NEXT_PUBLIC_SUPABASE_* and DATABASE_URL
```

Sign-in is a magic link to an address a workspace already invited — signing in
resolves a tenant, it does not create one. From there the request reaches
Postgres as `app_rw` with the tenant's claims set transaction-locally, exactly
the way the pipeline does, so what a page can see is what the policies allow
rather than what a query remembered to filter. The service-role key does not
appear in the app at all; the publishable key is the only Supabase credential it
holds, and that one is designed to be public
([ADR 0015](./docs/adr/0015-the-web-app-authenticates-with-supabase-and-reads-as-app-rw.md)).

The review route shows every stored field with the document, page and quote it
came from, and says which of three checks each field got: the quote was found in
the page text, it was looked for and was not there, or there was no text to look
in. There is still no approve button, for the same reason as in the prototype.

To see the two views without a sign-in, `pnpm render:web` seeds a tenant, runs
the real pipeline over the fixture case, reads it back through RLS and writes
`apps/web/preview/*.html` — the same components the app renders, over real rows.

### What is not built yet

No Inngest binding: the steps exist and are tested, but the durable wrapper needs
an HTTP endpoint. No decision layer, no packet, no submission, and no money
movement anywhere. No upload route in the app yet either — documents arrive
through the pipeline API and inbound email.

Phase 0's floor still holds under all of it: nothing can be submitted or written
back to accounting without an approval row, and the database is what refuses.

## Working on it

Read [CLAUDE.md](./CLAUDE.md) first — it is the operating manual, and the hooks
in `.claude/` enforce part of it. Changes to `supabase/migrations/**` or to
`packages/*/src/invariants/**` need a numbered ADR in `docs/adr/` on the branch
before the edit; see [0001](./docs/adr/0001-record-architecture-decisions.md).

Why this project sits inside the Mozart repository, and how to extract it into
its own: [ADR 0002](./docs/adr/0002-recouple-lives-in-the-mozart-repository.md).
