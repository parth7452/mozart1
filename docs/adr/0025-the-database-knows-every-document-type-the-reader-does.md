# 0025 — The database knows every document type the reader does

- Status: accepted
- Date: 2026-09-21

## Context

A supplier uploaded a dispatch-note JPEG. It scanned clean, went to OCR, was
classified `correspondence`, and was extracted. Then the read failed on its
last cheap statement:

```
new row for relation "document_classifications" violates check constraint
"document_classifications_doc_type_check"                        (SQLSTATE 23514)
```

`DOC_TYPES` in `packages/extraction/src/ports.ts` has twelve values.
`document_classifications.doc_type` in migration 0004 lists eleven: every one
of them except `correspondence`. The comment above `correspondence` in the code
says what it is for — "a message that changes or waives something: an approved
reschedule, a written exception, a confirmation. Often the document that
decides a dispute" — so this is not an exotic type nobody meant to store. It is
the type a waiver arrives as, and the database had never heard of it.

Nothing about that failure was quiet, and nothing about it was cheap.

**It was charged for four times.** `readDocument` records the read in one
closure: the model calls first, then the classification, then the extraction.
Each of those is its own transaction (`withTenant`), so the model calls
committed, `recordClassification` raised, and the extraction was never written.
The failure reached `asJobFailure`, which did not recognise it, so it came back
as a plain `Error` — retriable. Inngest ran the function three more times. Each
run re-read the document from the top: Reducto for the text layer,
`claude-haiku-4-5` for the classification, `claude-sonnet-5` for the
extraction — and each one hit exactly the same constraint, because a check
constraint does not change its mind in thirty seconds. Four reads, one
document, no case — and, because of where in the closure the failure landed,
four `model_calls` rows for the OCR and four for the classification, and none
at all for the four extractions, which were the expensive part.

**And it is invisible in the place a reviewer looks.** The document has a
`documents` row and a clean `document_scans` verdict, but no
`document_classifications` row and no `extraction_results` rows, so it appears
— correctly — in "Documents waiting to be read", with no indication that four
reads have already been paid for and that the fifth will fail the same way.

Three separate things are wrong here, and they are worth naming separately
because only one of them is about `correspondence`.

1. Two lists of document types exist and nothing compares them. The list in
   the code is the one the classifier may answer with; the list in the database
   is the one that may be stored. They were written by the same rule — "the doc
   types" — and drifted the first time a type was added to one of them. Adding
   the thirteenth type will do it again.
2. A refusal by the database was treated as a transient fault. The queue's
   default is to retry, and the default is right for a timeout or a vendor's
   500. A check constraint is a settled fact: it is the same answer every time,
   and repeating it on a path that calls two models first is the most expensive
   possible way to be told so.
3. The spend and the fact it was spent on do not commit together, and where the
   failure landed, half the spend was not recorded at all. That second half is
   fixed here; the first is not (see Consequences). Neither is the reason this
   cost four reads — retrying is.

## Decision

**1. The constraint lists every value `DOC_TYPES` does.** Migration 0020 drops
and re-adds `document_classifications_doc_type_check` with all twelve, so
`correspondence` is storable. This is the only place in `supabase/migrations/`
that constrains a `doc_type` — `grep -rn "doc_type" supabase/migrations/` finds
the constraint in 0004 and the `document_state` view that reads the column, and
nothing else. `extraction_results` and `model_calls` carry no `doc_type` column
at all.

**2. A test keeps the two lists identical, so this cannot recur.**
`packages/store-postgres/test/doc-types.test.ts` reads the constraint's own
definition out of `pg_constraint` and asserts set equality with `DOC_TYPES`.
Adding a type to the code without a migration fails CI, and so does widening
the constraint past what the reader can answer with. Set equality rather than
containment in one direction, because both directions are bugs: one is the
production failure above, and the other is a database that will accept a type
nothing in this repository can produce.

**3. A refusal by the database is a typed error, and the queue does not retry
it.** `recordClassification` catches SQLSTATE 23514 on that insert and raises
`ClassificationRefusedError` — a named error in `packages/pipeline/src/ports.ts`
next to the port it belongs to, carrying the document id and the doc type that
was refused. The doc type is a closed set and the id is an id: neither is
document text, so the message may travel (invariant 4). `asJobFailure` in
`apps/web/lib/inngest.ts` maps it, and any bare 23514 that reaches it by
another route, to `NonRetriableError`.

Both, not either. The typed error is the one we can say something useful
about; the bare-code branch is the net under it, because 23514 on a read is a
row the database has refused on its contents, and that is not a fault that
answers differently on the second try.

**4. The spend stays recorded, and is therefore spent once.** `recordModelCall`
commits before `recordClassification` runs, and it keeps doing so. The money
was spent: Reducto rendered the page and Anthropic answered, and a failed read
that records no `model_calls` rows understates what this system cost by exactly
the reads that went wrong — which is the set of reads most worth knowing about.
Invariant 3's honesty about money is about the numbers being true, not about
them being flattering.

Examining that closure found the half of it that was *not* honest.
`recordTheRead` recorded the OCR and classify calls in a loop, then the
classification, then called `recordExtraction`, which recorded the extract call
and the rows together. So the failure landed between the two: the two cheap
calls were kept and the expensive one — 63 seconds of `claude-sonnet-5` on a
dense document — was thrown away with the extraction it belonged to. The three
calls now go in one loop before the first statement the database can refuse,
and the rows follow. That is not a new rule; it is the rule the line below it
already follows, where a failing `openCaseFromNotice` records the read before
re-raising, "so a failed `openCase` cannot lose a read we paid for" (ADR 0021).

What made this expensive was never that the first read was recorded. It was
that it happened four times. Making the failure non-retriable is what fixes the
cost, and it leaves one set of `model_calls` rows — one OCR call, one classify
call, one extract call, attributable to the document — for a read that did not
finish. `doc-types.test.ts` asserts exactly that set, and asserts that a second
attempt is what would produce a second one.

## Consequences

Storing a waiver, an approved reschedule or a written exception works, which is
the document Phase 2's evidence planning most wants and the one a dispute most
often turns on.

A document that fails classification now fails once. The reviewer still sees it
in "Documents waiting to be read" — that list is computed from the absence of
an extraction, which is exactly what is absent — and re-driving it (ADR 0021's
`readKey`) is still the recovery, which will now succeed because the constraint
has been widened. Re-driving a document that fails for a *new* reason will cost
one read rather than four.

What we live with: the spend and the classification still commit separately, so
a read that dies between them leaves `model_calls` rows attached to a document
with no classification. That is deliberate and it is not free — anyone summing
cost per document must accept that a document may carry the cost of a read that
produced nothing. The alternative is one transaction across the whole
`recordTheRead` closure, which would mean holding a database transaction open
across two model calls, and a pooled connection held for the ~60 seconds a
dense extraction takes is a worse problem than an honest orphan row. If that
changes, it changes for the whole closure and in its own ADR.

The pairing test is a real constraint on future work: a thirteenth document
type is now a two-file change, code and migration, and CI says so before
production does. That is the point.

## Invariants touched

- **1 (no submission without an approval).** Untouched. This migration adds no
  grant, no policy and no trigger, and `app.require_approval()` is not read or
  edited. `document_classifications` is not one of the gated tables.
- **2 (append-only).** Untouched in substance and re-asserted in the suite. No
  UPDATE or DELETE grant is added to `document_classifications`; widening a
  CHECK constraint changes which rows may be *inserted* and nothing about
  whether a row may be changed afterwards.
  `supabase/tests/16_every_document_type.sql` re-asserts that `app_rw` still
  holds no UPDATE and no DELETE on the table.
- **3 (money is integer cents).** Untouched arithmetically, and named
  deliberately in the Decision: the rule that spend is recorded as it was spent
  is the same rule that says the cents are true rather than convenient.
- **4 (document content is untrusted).** Respected, and the reason the error
  message is shaped the way it is. `ClassificationRefusedError` carries a
  document id and a doc type — a UUID and one of twelve constants — and never
  the filename, the page, a quote or the driver's own message. The bare-23514
  branch in `asJobFailure` keeps the existing rule that the original message is
  logged locally and never handed to the queue.
- **5 (Jev behind `DecisionProvider`).** Untouched.
- **6 (RLS on every table).** Untouched. No policy is created, dropped or
  altered, and no service-role key appears. The new SQL suite runs as `app_rw`
  under a tenant's claims, and the new Postgres test reads `pg_constraint` as
  the connecting owner because a constraint is not a tenant's row.
- **7 (thresholds auto-tighten only).** Not a threshold. It is worth being
  explicit that this change is a *loosening* of a constraint: it lets rows in
  that were refused before. It is the specific loosening of letting the database
  store what the reader is already allowed to say, it is bounded by `DOC_TYPES`
  and by a test that will not let it exceed that list, and it is written down
  here — which is the friction invariant 7 is asking for.

## Rollback

Reverting is a new migration (never an edit to 0020 once merged) that drops
`document_classifications_doc_type_check` and re-adds it with the eleven values
0004 had. It would fail on any `correspondence` row already stored, so the
revert has to say what happens to those rows, and there is no honest answer —
the table is append-only. In practice this is not revertible and should not
need to be.

The other three parts revert independently and cheaply: delete
`supabase/tests/16_every_document_type.sql`, delete
`packages/store-postgres/test/doc-types.test.ts`, and drop the
`ClassificationRefusedError` branches from `recordClassification` and
`asJobFailure`. Dropping the last of those puts the retry behaviour back to
what it was, which is the part that cost four reads; doing it needs its own ADR
saying why.
