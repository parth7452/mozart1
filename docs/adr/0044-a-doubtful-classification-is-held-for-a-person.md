# 0044 — A doubtful classification is held for a person

- Status: accepted
- Date: 2026-09-23
- Amends: ADR 0028 §1 (which documents open cases on their own), ADR 0021 (what a
  second delivery answers)

## Context

Every tenant has had a classification floor since migration 0002:
`org_settings.min_classification_confidence`, `numeric(4,3)`, default `0.950`,
the same value in every tenant today. Invariant 7's guard refuses to lower it
without a named ADR (migrations 0005 and 0022). **Nothing in the product reads
it.** `classificationIsActionable` in `core-domain` is called only by
`scripts/run-evals.ts`, and its docstring describes routing to review that did
not exist.

`readDocument` opens cases on the document type alone. A `deduction_notice`
goes to `openCaseFromNotice`, one case per claim. A `remittance_advice` goes to
`openCasesFromRemittance`, one case per short-paid line (ADR 0028). The
classifier's confidence is in scope at both sites and ignored, and so is whether
the reading actually fits the type it was read as.

The recorded corpus says where that goes wrong. Every notice and remittance
cassette classifies at 0.95 or above — notices at 0.98–0.99, remittances at
0.95–0.99, LOG-001's remittance at exactly 0.95 — except two:

- `stf-203-short-payment-notice` is a notice read as `remittance_advice` at
  0.75. Re-asked, it reads that way three times in five under both classifier
  prompts. A notice read as a remittance opens a case per line instead of per
  claim, so the instability is a product problem, not only an eval one.
- `stf-201-short-pay-remittance` is a remittance read correctly, at 0.92.

Classification runs with no pinned temperature, so each of these numbers is one
sample. Production shows the same shape: every real notice and remittance read
so far has come in at 0.95 or above.

There is a second gap behind the first. A document can clear the floor and
still not fit its type: a "remittance" whose reading has no lines, or a notice
with no claim id. `ExtractionResult.validated` already says whether the reading
satisfied its schema. Nothing on the case-opening path asks it.

And a held document must not cost a second read. `recordedRead` answers "read it
again" for a `deduction_notice` that is on no case and may open one. That is how
a web upload whose first read failed gets its case. Left alone, it would make
every redelivery and every "Read again" of a held notice pay for the page again.

## Decision

**A document that would open a case on its own opens one only when the
classifier is at or above the tenant's floor and the reading fits its type.
Otherwise it is held: read, recorded, on no case, and shown to a person, who can
open a case from the recorded reading with one click and no second read.**

### 1. The gate sits where a case would otherwise open

It applies at exactly the two sites that open cases automatically. The document
is a `deduction_notice` or a `remittance_advice`, no case was named, and the
read may open one (`allowCaseOpen`). Nothing else is gated:

- Evidence types (`pod`, `invoice`, …) never open a case, so there is nothing to
  hold.
- A document uploaded to a named case goes on that case. A person chose the
  case, and the read does not open one.
- An email that failed DKIM and DMARC (`allowCaseOpen: false`, ADR 0016) keeps
  its existing halt. It is filed for a person with no case, and is not also
  held: it would have opened nothing whatever the confidence.

The case opens when `classificationIsActionable(confidence, floor)` holds and
`typeFits(docType, extraction)` says it fits. The comparison is inclusive: 0.95
against a 0.950 floor opens, which is what LOG-001's remittance needs.

**The floor is the tenant's own column**, read per document through
`PipelineStore.classificationFloor()`, one select as `app_rw` under the tenant's
claims. It is read before the page is fetched or a model is called, so a missing
`org_settings` row fails loudly and spends nothing. The store parses the column's
text exactly and refuses anything that is not a number in [0, 1]. The number is
not cached: a tenant that raises its floor holds the next document at the new
one.

### 2. What "fits its type" means

`typeFits` is a pure function in `packages/pipeline`. A reading fits when it
validated against the type it was read as (`ExtractionResult.validated`). A
remittance must also carry at least one line: an advice with no lines opens
nothing, so calling it a remittance is not a reading anyone can act on.

A reading that does not fit names the fields that failed. They are schema paths
such as `claim_id` or `lines[0].invoice_number`. They are re-derived from the
schema's own complaint and kept only when they are fields the document type
declares, so a path a model invented never reaches an audit row or a page, and
no value ever does.

### 3. Held means recorded, and said once

A held document is read exactly as today. The OCR, classify and extract calls
go to `model_calls`, the classification and the extraction are stored, and all of
it is recorded against no case. Then one `audit_log` row is written:

- `action = 'document.held'`, `subject_table = 'documents'`,
  `subject_id = <document id>`
- `payload = {doc_type, confidence, floor, reason, fields?}`
- `reason` is `below_floor` or `type_did_not_fit`. When both apply it is
  `below_floor`.
- `fields` is present exactly when the reading did not fit, including alongside
  `below_floor`. It lists the fields `typeFits` could name.
- `confidence` is the number the gate compared, before the classification row
  rounds it to `numeric(5,4)`.
- The actor is the acting member. Migration 0030's policy requires
  `actor_id = app.current_user_id()` and `app.member_may_write()`.

`audit_log` rather than a new table, because it already has what this needs. It
is append-only and hash-chained (0004), org-scoped under RLS, and its insert
policy makes the row name the member who wrote it. `deduction_events` cannot
hold this: a held document has no case, and `deduction_id` is not null.

`DocumentRead.haltedBecause` gains `'held_for_review'`, and `DocumentRead.held`
carries the hold in structured form, so a route never matches on a sentence. A
job's result carries the reason (`held`), and the job logs it by id and reason
only.

### 4. A held document is answered from the record

`PipelineStore.documentHold(documentId)` returns the latest `document.held` row
for the document, unless a `document.hold_released` row follows it.
`recordedRead` asks it when the document is on no case, before its "a notice
with no case is read again" rule. A held document is then answered from the
record with no model call, on every path that asks: a redelivered job, the "Read
again" button, and the same file uploaded again, inline or queued. Each path
tells the reviewer where the document is.

`caseForDocument` is asked first. A document on a case is on that case, and a
stale hold row cannot say otherwise (§5 says how one can be left behind).

### 5. A person decides

"Read, not on a case" shows each document's latest classification confidence
and its hold. Below the floor, it says the confidence and this workspace's
floor. For a misfit, it names the fields it could not read. For a hold whose
reading fits (`below_floor` with no `fields`) it offers **Open a case from it**.
It does not offer the button for a reading that does not fit. The route would
refuse it (below), and the page does not offer what would be refused; the Attach
control beside it files the document as evidence instead.

`POST /documents/[id]/open-case` has the same shape as the attach and reread
routes. It refuses cross-site requests, resolves the session, checks the id and
the role, asks `memberMayWrite` of the database, and 404s a document the tenant
cannot see. It then calls `openHeldDocument`, which:

- runs under the document's read claim (`withDocumentRead`), so two presses, or
  a press and a read, cannot both open cases;
- refuses by name a document that is not held, one already on a case, and one
  whose recorded reading no longer fits. The last one is re-checked on the
  restored reading: a required field stored without provenance comes back
  absent, and a case opened from such a reading would lack it. The notice says
  to attach it as evidence instead;
- restores the recorded reading (`latestExtraction`, which goes through
  `restoreDocument`) and runs the same `openCaseFromNotice` or
  `openCasesFromRemittance` the read would have run. There is no classifier, no
  extractor and no model call, and so no `model_calls` row;
- adds `held: {confidence, floor, reason}` and `confirmed_by: <member>` to each
  `case.discovered` event it writes;
- writes `document.hold_released`, naming the member, with the case ids.

The release is not in the same transaction as the case. `openCaseFromNotice` is
several store calls, each its own transaction, and making it one is a change to
every store. So the order is chosen for what a crash leaves behind:

- **Open the case, then release.** A crash in between leaves a document on a
  case under a stale hold row. That is harmless: `caseForDocument` answers
  first, and the list shows only documents on no case.
- **Release, then open** would be worse. A crash in between leaves an unheld
  notice on no case, and the next delivery would read it and pay again.

The redirect follows ADR 0040: to the case when exactly one opened or merged,
to the list with a count when several did, and to the list saying so when a
remittance's lines opened none. A merged-away target is handled as ADR 0042
says: `RCM01` is `CaseMergedAwayError`, with its own notice.

### 6. The helper, corrected

`classificationIsActionable` now says what it is for. It answers false for a
confidence that is `NaN` or outside [0, 1], and for a floor that is not a finite
number in [0, 1]. A number no classifier can produce is not a reason to act
without a person. The store refuses such a floor before it gets here.

### 7. No threshold moves, and no migration

The floor is the column's own value, 0.950 everywhere, and the direction guard
is untouched: raising it holds more, and lowering it still needs an ADR. Suite
05 now asserts both for this column. It already asserted them for every other
threshold, and this one had gone unasked.

## Consequences

- In replay, `stf-203-short-payment-notice` (0.75) and
  `stf-201-short-pay-remittance` (0.92) are held, and every other recorded
  notice and remittance opens its case as before.
  `packages/pipeline/test/confidence-floor.test.ts` walks every cassette, and
  LOG-001's walk is unchanged.
- A correct but uncertain reading now waits for one click. That is the price of
  a notice misread as a remittance no longer opening a case per line.
- Cassette replay reports every reading as validated (`buildExtractionResult`'s
  default), so the misfit half is exercised by live reads and by the tests that
  build one, not by the eval corpus.
- A hold is one sample of an unpinned classifier. Reading the document again
  would draw another sample and pay for it, so it is not offered. The person
  decides from the recorded reading.
- `org_settings` has to exist for a tenant before a notice or remittance can be
  read. Every path that creates a tenant writes one, and every test that reads
  on Postgres seeds one.
- `audit_log` has no index on `subject_id`. The hold look-ups scan the tenant's
  audit rows, which is nothing at today's volume. An index is a migration, and a
  follow-up.
- The Phase 2 guard `classification_confidence_meets_tenant_minimum` (on
  `classified → evidence_pending`) still has no evaluator, because that edge is
  not taken yet. When it is, a case opened from a hold says who confirmed it on
  `case.discovered`.

## Invariants touched

- **1 (the approval gate)**: untouched. Opening a case is not a filing.
- **2 (append-only)**: held. A hold and its release are two `audit_log` inserts.
  Nothing is updated. Classifications, extractions and events are written as
  before.
- **3 (money)**: untouched. The released case's amount comes from the same
  `parseMoneyToCents` path as an automatically opened case.
- **4 (documents are untrusted)**: held. The hold payload carries a doc type
  (one of twelve constants), two numbers, a reason from a closed set, and schema
  field paths filtered against the type's own field list. There is no value, no
  quote and no filename, and the same is true of log lines, job results and
  redirects.
- **5 (DecisionProvider)**: untouched. The classifier is the reader's, not a
  decision, and releasing a hold calls no model.
- **6 (RLS)**: held. `classificationFloor`, `documentHold`, the hold and its
  release all run through `withTenant` as `app_rw`. The audit insert is refused
  for a member who may not write, by migration 0030's policy.
- **7 (thresholds)**: exercised, not moved. The column is read for the first
  time. Its guard is unchanged and now tested for this column too.

## Rollback

Drop the gate in `readDocument` and the hold check in `recordedRead`, and
documents open cases on type alone again. The `document.held` and
`document.hold_released` rows stay: they are append-only history, nothing else
reads them, and a document held before the rollback is then an ordinary read
document on no case, which the Attach control and "Read again" already handle.
