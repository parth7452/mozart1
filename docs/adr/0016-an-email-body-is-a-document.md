# 0016 — An email body is a document, and gets its own door

- Status: accepted
- Date: 2026-09-18

## Context

`ingestInboundEmail` read attachments. Only attachments. Some retailers and
brokers send the deduction as the message itself — no attachment, the claim id
and the amounts in the body — and for those emails the pipeline produced nothing
and said nothing about why. An inbox with a real deduction in it looked like an
empty inbox. That is the worst shape a bug can have here: silent, and on the path
where money is at stake.

The plan named this as a missing format. It is also a missing capability, and the
fixture was never the hard part.

## Decision

**An email body becomes a document when no attachment turned out to be the
notice.** If one did, the body is a cover note — "please see attached" — and
reading it would cost a model call to discover that. So the rule keys on the
classification, not on the presence of attachments: an email can carry a
signature image and still have its notice in the body.

**It goes through a different door, and the door is chosen by `source`, not by a
flag.** `acceptUpload` sniffs magic bytes because an uploaded file is opaque and
the sender's claim about its type is worthless. An email body is text the mail
server already parsed; there are no magic bytes and nothing lied about a type, so
sniffing it would be checking the wrong thing. `acceptEmailBody` checks what
actually matters for text — enough of it to be a notice, not so much that it is a
forwarded thread — and hashes the normalised text so the same body arriving twice
deduplicates the way a re-sent attachment does.

`IngestInput.source` carries `'email_body'` and `ingestDocument` picks the gate
from it. A caller cannot hand in a pre-accepted document, so no upload path can
reach the text door by mistake.

**The reader gets text and no document block.** `buildReadContent` emits the body
as the quarantined text block and nothing else: there is no image behind it, so
asking for a document block would be asking for a file that does not exist. The
"withhold the text layer" rule from ADR 0009 is an OCR judgement — a transcription
can be worse than the image it came from — and it is explicitly not applied here,
because withholding a text document's text leaves nothing to read.

**A body too short to be a notice is skipped with its reason, not raised.** Most
email is "thanks". The email still returns, and `skipped` says what happened,
because silence was the bug.

**A body opens a case only from an authenticated sender**, exactly as an
attachment does. A body is if anything easier to forge: it is text in a message
anyone can send.

**It is its own eval suite.** A body has no page, no layout and no image, so
whether extraction holds up there is a different question from whether it holds
up on a scan. Blending them would let a good scan number hide a bad body one. The
first recorded run: 100% recall, 100% precision, 26 of 26 quotes verified,
classified as a deduction notice at 0.98, $0.0218.

## Consequences

`text/plain` now exists as a document type, which touches more than ingest: the
document route serves it inline (with nosniff and a sandbox, so a body claiming
to be markup is shown as the characters it is), and the review page embeds a
document with its own type rather than always as a PDF.

A body has no bounding boxes, ever. Quote verification still works — the quote is
checked against the body text — but a reviewer follows a field to a line, not to
a rectangle. That is the honest limit of the format.

The 200-character floor will occasionally refuse a very terse real notice. It is
a constant in one place and the skip is recorded, so the failure is visible
rather than silent, which is the property that matters.

## Invariants touched

**4**, unchanged in substance: the body is stored and scanned like anything else
before it is read. A malware scanner has less to find in text, and the gate does
not get to decide that.

**2** and **3**, unchanged: the reader still copies verbatim and we still do the
arithmetic.

## Rollback

Reverting means email-body notices are silently dropped again. If the body
reading ever proves expensive or noisy, the rule to change is *when* the body is
read — not whether the email says what became of it.
