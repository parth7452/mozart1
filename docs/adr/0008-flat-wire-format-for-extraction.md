# 0008 — A flat wire format for extraction

- Status: accepted
- Date: 2026-09-18

## Context

Phase 1 asked the extractor for a typed nested object per document type, via
structured outputs. The API refused it:

```
400 invalid_request_error: The compiled grammar is too large, which would cause
performance issues. Simplify your tool schemas or reduce the number of strict tools.
```

Probing the limit directly (rather than guessing at it) showed what the
constraint actually is:

| Schema shape | Result |
| --- | --- |
| 10 flat fields, long descriptions | compiles |
| 13 flat fields, long descriptions | **grammar too large** |
| 13 flat fields, one-character descriptions | **grammar too large** |
| 13 flat fields + an 8-field repeating group | **too many properties** |
| flat array of field records, any size | compiles |

So the limit is on the number of distinct properties in the schema, not on how
much text the descriptions carry — shortening the descriptions bought nothing.
A deduction notice has 13 header fields plus 8 per line item, which is past the
limit by construction, and every richer document type would be too.

Removing the per-field `source_bbox` array and collapsing nullable *objects*
into nullable *values* both helped the schema's size on paper and neither one
brought it under the limit.

## Decision

Keep the typed Zod schemas as the source of truth for what each document type
contains, and stop using them as the wire format.

The model is sent a **field list** derived from the schema (path, type, whether
it is optional, and the description) and returns a **flat array of records**:

```json
{ "fields": [
  { "path": "lines[0].deduction_amount", "value": "$3,120.00",
    "confidence": 0.97, "source_page": 1, "source_quote": "Total deduction: $3,120.00" }
]}
```

One repeated shape, so the grammar is small and constant whatever the document
type. `reassemble()` then rebuilds the nested object on our side and validates it
against the Zod schema:

- a path that is not in the schema is dropped with an issue — there is nowhere to
  put it and no way to check it;
- a value that will not coerce to its declared type (`"about thirty"` for a
  quantity) is dropped with an issue rather than rounded into something plausible;
- fields the model left out are filled with an explicit "not present", so a
  *required* field that never arrived fails validation loudly instead of vanishing;
- the result carries `validated` and `issues`, and an unvalidated document is
  recorded as `schema_mismatch` on its `model_calls` row.

Extracted fields are stored either way — a partial read is still evidence — but
only a validated document may be reconciled, because reconciliation reads typed
paths.

## Consequences

The wire format now matches `extraction_results` one-to-one, which removed a
translation step rather than adding one. Adding a field to a document type is
still a one-line change to the Zod schema; the field list and the reassembly
follow from it.

The model no longer returns a bounding box. It was a large part of the grammar,
and it was the least reliable part of the output — the reviewer UI highlights the
verbatim quote instead. `extraction_results.source_bbox` stays nullable for a
layout-aware extractor (Reducto) to fill in later.

Values arrive as text and are coerced here, which is the same division of labour
money already had: the model reports what is printed, our code decides what it
means.

## What the first eval run found

Recording cassettes for all eight fixtures scored 100% recall and precision with
every quote verified — after one genuine finding, which was a bug in our spec
rather than in the model.

`signature_present` on the Walmart BOL came back `false`. The document reads
`Signature: /s/ R. Alvarez`, and the field's description said to set it true only
if a signature is *visible* and "do not infer it from a printed name". A
conformed signature is typed text, so the model followed the instruction exactly
and returned false. The instruction was asking a pixel-level question that no
text layer can answer, when the question the business needs is whether the
consignee signed. The description now asks that instead, and the negative case —
a carrier-generated report stating no signature was captured — still scores
false.

The ground truth was not touched.

## Invariants touched

**4**, in its favour: the model's output is now validated against a schema it
never sees, and every path is checked against a known field list before anything
is stored.

**5** extends: an extraction that fails validation is recorded as
`schema_mismatch` with the reasons, rather than being silently dropped.

## Rollback

If a future API raises the grammar limit, `zodOutputFormat(schemaFor(docType))`
can go back to being the wire format; `reassemble()` becomes a no-op and the
field list is no longer needed. Nothing else changes.
