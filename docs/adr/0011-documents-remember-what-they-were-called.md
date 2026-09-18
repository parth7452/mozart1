# 0011 — Documents remember what they were called

- Status: accepted
- Date: 2026-09-18

## Context

Writing the Postgres-backed `PipelineStore` surfaced a gap the in-memory store
hid: `documents` stores `sha256`, `byte_size`, `mime_type` and `storage_ref`, and
nothing else. A document can be round-tripped through the database and come back
without the name the supplier gave it.

That name is not decoration. A reviewer looking at a case sees "the Walmart APDP
notice" and "the carrier's BOL", not two content hashes. Email-in makes it
sharper: an attachment arrives as `signed-pod-aug-08.pdf`, and that string is
often the only statement anyone makes about what the file is meant to be.

The in-memory store never noticed because it carries the whole `StoredDocument`
object in a map, filename included. It is exactly the kind of thing that only
shows up when something real has to persist and reload the data.

## Decision

`documents` gains a nullable `filename`. Nullable because existing rows have none
and because a document can legitimately arrive without one — a portal export, a
future connector — and an empty string would be a worse lie than a null.

The column is set once at insert, like everything else on this table. `documents`
stays append-only: a file renamed after upload is a new fact about an existing
document, not an edit to it, and if that ever needs recording it belongs in an
event.

## Consequences

The reviewer UI can show what a file was called. The filename is supplier-supplied
text and therefore untrusted: it is displayed, never used to decide a document's
type (that is the classifier's job, from the content) and never used to build a
filesystem path.

## Invariants touched

**2**: `documents` is append-only and stays that way — this adds a column written
at insert, not a mutable field.

## Rollback

Drop the column. The store falls back to showing a hash, which is where it was.
