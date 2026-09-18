# 0009 — Reducto provides the text layer for scans, not a second extractor

- Status: accepted
- Date: 2026-09-18

## Context

The build plan puts Reducto behind Claude as an *extraction* fallback: route
skewed, scanned and multi-hundred-line documents to it for better table fidelity.
That was the right guess before there was any measurement. There is now.

On four simulated scans — rotated, greyscaled, speckled, JPEG 50–68, no text
layer — Claude vision scored 100% field recall and precision against the same
ground truth as the clean sources. Extraction is not where scans hurt.

Where scans hurt is grounding. Every extracted field carries the page and a
verbatim quote, and we check that quote against the page's own text. A scan has
no text to check against, so `quoteVerified` comes back `null` for every field —
honest, and much weaker than the `true` we get on a digital PDF. The check that
catches an invented value is exactly the check a scan switches off.

A probe of Reducto's `/parse` on the worst of the scans returned clean OCR text,
correctly paired labels with values that the source PDF's own text layer had left
as orphaned lines, and — the part that decides this ADR — per-block **normalised
bounding boxes** with per-block confidence, in 4.9 seconds for 2 credits.

## Decision

Reducto is an **OCR and layout provider**, not an extractor. It sits behind an
`OcrProvider` port and does two jobs:

1. **Gives a scan a text layer.** When a document has no extractable text, the
   pipeline OCRs it first and attaches the result as `pageText`. Extraction then
   runs exactly as it does for a digital PDF, and quote verification works again
   — a scan stops being a document we cannot check.
2. **Supplies the bounding boxes.** ADR 0007 stopped asking the model for a box
   because a vision model's box is a guess. A layout engine's box is not a guess.
   After extraction, each field's verbatim quote is located in the OCR blocks and
   takes that block's bbox, so `extraction_results.source_bbox` — nullable since
   0007 and empty ever since — finally carries something a reviewer UI can draw.

A box derived this way is only as good as the quote match, so a box is attached
only when the quote is found in exactly one block. An ambiguous match gets no box,
on the same principle as 0007: no box beats a box pointing at the wrong place.

Claude remains the extractor for every document type. If a later measurement
shows Reducto extracting dense remittance tables better than Claude vision, that
is a second ADR with the numbers in it, not an assumption carried over from the
plan.

## What measurement changed after the decision

Wiring it up produced a result the decision above did not anticipate, so the
design is narrower than first written.

Giving the extractor the OCR transcription **made extraction worse**. Reducto
read `PO-PRD-3356` as `P0-PRD-3356` — letter O as zero — and the model, which had
read that same PO number correctly from the pixels on the previous run, adopted
the transcription's error. Telling it in the prompt that the image is
authoritative did not fix it; it anchors on text in front of it.

Giving the *classifier* the transcription made classification better. The
degraded bill of lading went from `pod` at 0.75 confidence to `bol` at 0.98.

So the roles are split by where each input actually helps:

| Consumer | Gets the OCR text? | Measured effect |
| --- | --- | --- |
| Classifier | Yes | bill of lading 0.75 `pod` → 0.98 `bol` |
| Extractor | **No** — reads the image | keeps 100% field accuracy; loses it with OCR text |
| Quote verification | Yes | scans go from unverifiable to 98.4% verified |
| Bounding boxes | Yes | 0 → 57 fields a reviewer can follow |

Quote matching also gained a third tier that folds the glyph pairs OCR confuses
(O/0, I/1, S/5, B/8, Z/2, G/6), so a value read correctly from the image still
verifies against an imperfect transcription. It is deliberately narrow — a
hallucinated value differs in far more than one glyph class — and a match found
that way is reported as `ocr_confusion`, never as an exact match, so a reviewer
is told which kind of verification a field got.

The first run with verification live immediately caught something worth having:
on one scan the model extracted `qty_invoiced: 400` correctly but cited it to the
quote "400 of 400 cases" where the page reads "380 of 400 cases". The value was
right and the citation was fabricated. That is the failure mode the check exists
for — on the next document the same sloppiness produces a wrong value behind a
confident-looking citation.

## Consequences

Scans become verifiable, which is the point. The cost is an extra round trip and
Reducto credits (2 for a one-page complex document) on the subset of documents
that need it — digital PDFs never touch Reducto.

OCR output is document content, so it is untrusted (invariant 4): it goes through
the same quarantine wrapper as any other text layer, and the reader model that
receives it still has no tools.

A failed or slow OCR must not block ingest. When OCR fails, extraction proceeds
without a text layer and the fields come back unverifiable — the behaviour we
have today — with the failure recorded on `model_calls` rather than swallowed.

## Invariants touched

**4**: OCR text is untrusted document content and is quarantined as such.

**5**: every Reducto call is recorded on `model_calls` with `provider = 'reducto'`,
its credits as cost and its duration as latency.

## Rollback

Stop constructing the provider. Scans revert to unverifiable quotes and null
boxes, which is where they were before this ADR.
