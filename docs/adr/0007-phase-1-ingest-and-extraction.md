# 0007 — Phase 1: ingest, classification and extraction

- Status: accepted
- Date: 2026-09-18

## Context

Phase 1 turns an uploaded file into a case with extracted, grounded fields. Five
decisions needed making before the code, and each one is a place where a
plausible-looking shortcut would quietly break an invariant or oversell what the
system knows.

## Decision

**1. Model roles, pinned and overridable.** Extraction and narrative work run on
`claude-sonnet-5`; cheap first-page doc-type classification runs on
`claude-haiku-4-5`. This follows the build plan's own split (Sonnet for
vision/extraction, Haiku for classify) at the current model generation. Both IDs
live in one module and are overridable by env var, and every call records the
model ID it actually used on the `model_calls` row, so a change of model is
visible in the data rather than inferred from a deploy date.

**2. Grounding is a verbatim quote first, a bounding box second.** The plan
specifies `source_page` + `source_bbox` per field. A page number is reliable. A
bounding box from a vision model is an estimate, and a reviewer UI that draws a
confident rectangle in the wrong place is worse than one that highlights nothing:
it teaches the reviewer to trust the wrong thing. So every extracted field
carries `source_page` (required) and `source_quote` (required, verbatim from the
document), with `source_bbox` nullable. The quote is what the reviewer UI
highlights, by searching for it in the page's own text; the bbox is a hint used
only when it is present. `extraction_results` stores all three.

A quote that cannot be found in the document's own text is a signal the model
invented the value, so the verifier checks it — this is cheaper and stricter
than anything a bbox gives us.

**3. No model sees a file that has not been scanned clean.** The plan puts a
ClamAV scan before any model call. Rather than trusting call order, the gate is a
function that reads the document's latest `document_scans` verdict and refuses to
produce model input without a `clean` one. Fail-closed: no scanner configured
means no verdict, which means no extraction — never "assume clean because no
scanner is wired up yet". `NullScanner` therefore returns `error`, not `clean`.

**4. Untrusted text never becomes instructions, and never becomes state.** The
reader client is constructed with no `tools` parameter at all, so there is no
tool for an injected instruction to reach for. Document content goes inside the
`<untrusted_document>` delimiters from `core-domain`, with any forged delimiter
in the source defanged first. The extractor's output is validated against a Zod
schema before it is persisted, and `assertStateIsStructured` (Phase 0) already
refuses to pass document-sized or quarantined text to a decision provider.

**5. The pipeline is pure functions over ports; Inngest binds in Phase 1b.**
Each step (`ingestUpload`, `classifyDocument`, `extractDocument`,
`reconcileClaim`) is a function taking explicit ports — a store, a scanner, a
classifier, an extractor, a clock. Durability, retries, `waitForEvent` and
deadline timers are Inngest's job, and Inngest needs an HTTP endpoint to deliver
to, which arrives with `apps/web`. Binding the steps to Inngest is then a thin
adapter over functions that are already tested, rather than logic trapped inside
a workflow runtime.

## Consequences

Tests run the whole pipeline with in-memory ports and recorded model responses,
with no database, no network and no Inngest. The cost is one extra indirection
per step, and the risk is that the Inngest binding drifts from the step
signatures — a contract test in Phase 1b covers that.

Bounding boxes will be sparse until a layout-aware extractor (Reducto) fills them
in. The reviewer UI must be built to highlight a quote, not to require a box.

## New tables (migration 0007)

- `deduction_documents` — links a document to the case it belongs to, with its role
- `document_pages` — one row per page: rendered image ref, dimensions
- `extraction_results` — append-only, one row per extracted field, with value,
  confidence, `source_page`, `source_quote`, nullable `source_bbox`
- `model_calls` — append-only: provider, model, purpose, tokens, cost, latency

All four are append-only and RLS-scoped, matching invariants 2 and 6.

## Invariants touched

- **2** — four new append-only tables, same trigger and grant pattern.
- **4** — the scan gate and the quarantine wrapper are its enforcement points;
  the reader client is constructed without tools.
- **5** — `model_calls` extends "every decision persists its cost and latency" to
  every model call, not only decisions.
- **6** — RLS policies on all four new tables, tested in `06_extraction.sql`.

## Rollback

Phase 1 tables are additive; dropping them loses extracted data but no Phase 0
guarantee. The model-role choice is one module and an env var.
