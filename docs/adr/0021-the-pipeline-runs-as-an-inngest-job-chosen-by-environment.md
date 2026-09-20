# 0021 — The pipeline runs as an Inngest job, chosen by environment

- Status: accepted
- Date: 2026-09-20

## Context

`POST /upload` does all of it inside the request: session, CSRF, magic bytes,
store the bytes, scan, classify, OCR, extract, open the case. The cheap half is
milliseconds. The read is not — extraction of the 42-row dense remittance is
about 63 seconds of model time on its own, before OCR, and a scan adds a
Reducto round trip in front of it.

The route declares no `maxDuration`, so it gets the platform's default (10s on
Vercel's Hobby plan, 15s on Pro at the time of writing). A dense document
therefore cannot finish, and what the reviewer sees when it does not is a
gateway timeout: no case, no message, and a document row that is stored and
scanned but never read. Nothing is corrupted — every step is separately
re-runnable, which is what `ingestDocument` returning the existing document on
the same hash is for — but nothing says so either, and the reviewer's only
recourse is to upload the same file again and hope it is faster.

Raising `maxDuration` moves the ceiling; it does not remove it. A serverless
function that holds a request open for five minutes is also a function that
drops the whole read if the instance is recycled, and it gives us no retry, no
record of the attempt, and no way to see a queue.

`packages/pipeline` was built for this: the steps are pure functions over ports
(ADR 0007), and `ports.ts` has said since Phase 0 that "the Inngest binding in
Phase 1b is a thin adapter rather than a rewrite". This is that adapter.

The house rule for an outbound dependency reached from Vercel is ADR 0018's:
one place decides what an environment gets, a half-configured environment is an
unconfigured one, and the unconfigured answer is the safe one rather than the
convenient one.

## Decision

Split the upload into the part a request should do and the part a job should.

**The request** keeps everything cheap, synchronous and fail-closed: the
session, the role check, the cross-site refusal, the size ceilings, the magic
bytes (`acceptUpload`), the `documents` row, and the scan. A file that is not
scanned clean stops there, exactly as it does now — the gate is the verdict, and
no job is sent for a document that did not pass it (invariant 4).

**The job** does the read: classify, OCR when there is no text layer, extract,
open the case. It is triggered by a `document/read.requested` event carrying
`{ documentId, orgId, userId, attachToCase? }` — ids and the acting member's
identity, and nothing else. No bytes, no page text, no extracted fields: the
event goes to a third party, and document content is untrusted content we do not
hand out (invariant 4).

**Which one runs is the environment's decision, made in one place.** The shape
is `scannerFromEnv`'s, deliberately:

| Configuration | Runner |
| --- | --- |
| `INNGEST_EVENT_KEY` **and** `INNGEST_SIGNING_KEY` | `InngestRunner` — ingest in the request, read in a job |
| neither | `InlineRunner` — the whole pipeline in the request, as today |
| one without the other | an error at construction |

`runnerFromEnv` in `apps/web/lib/pipeline.ts` is the only place that decides,
and it announces the decision once at startup so a log says which of the two a
deployment is running. Half-configured is not a third mode and not a silent
fallback: an event key with no signing key would send jobs to an endpoint that
cannot verify what it is being asked to do, and a signing key with no event key
would serve a function nothing can trigger. Both are somebody's half-finished
change, and both fail loudly.

**One implementation, two entry points.** `packages/pipeline/src/jobs.ts`
exposes `ingestForJob` and `readDocumentJob`, both pure functions over the same
ports as everything else. `processUpload` is refactored to call the same
`ingestDocument` and the same `readDocument` those two wrap, so the inline path
and the job path are the same code with the same recorded calls in the same
order — including PR #1's ordering, where model spend is recorded before the
case opens so a failed `openCase` cannot lose a read we paid for.

**The serve route** is `apps/web/app/api/inngest/route.ts`, the Inngest Next.js
adapter over one function: id `read-document` in app `recouple`
(`recouple/read-document`), trigger `document/read.requested`, `retries: 3`,
`idempotency: 'event.data.documentId'`, and a concurrency limit keyed on
`event.data.orgId` so one tenant's bulk upload cannot starve another's. It
declares `maxDuration = 300`, the largest value Vercel allows on the plans we
might be on; the project's plan is not recorded anywhere in this repository, so
if it is Hobby the platform will clamp it to that plan's ceiling rather than
honour 300.

The route serves nothing when the keys are absent: no client, no functions, and
a 503 that says the read runs inline here. An unconfigured deployment therefore
has no endpoint that runs a job at all, rather than one that would run whatever
it was handed.

## Consequences

An upload returns as soon as the bytes are stored and scanned. With the job
runner there is no case id to redirect to yet, so the reviewer goes back to the
case list with a message saying the document is being read; a reviewer attaching
evidence goes back to the case they were on. With the inline runner the redirect
is unchanged — straight to the case the notice opened.

A failed read is now visible and retried. Inngest records the error and retries
three times; the steps are idempotent by construction (the same bytes dedupe to
the same document, `recordPages` is keyed on the document, the case is refused a
second time by `unique (org_id, debtor_id, claim_id)`), so a retry re-reads
rather than duplicating. It costs a model call to retry, which is the price of
not losing the document.

A redelivered event does not open a second case. `idempotency` on the document
id is the first line, and `DuplicateCaseError` is the backstop it is already the
backstop for (ADR 0019) — a second delivery that somehow slips past the first
finds the claim already open and says which case holds it.

Spend is still attributed. The job records every `model_calls` row through the
same store as the request would, with the same tenant claims, so cost per case
and cost per document do not change shape. A retry's calls are recorded too:
they happened.

**We now depend on a third party for the read to ever finish.** If Inngest is
down, documents queue: they are stored, scanned and visible, and the case
appears late. Unsetting the two variables puts every environment back to inline
reads with no code change, which is the rollback below.

The event is one more place a tenant id travels. It carries no document content,
but it does say that org X uploaded a document with id Y at time T, and that
metadata now lives in a third party's queue for its retention period. That is
the same trade ADR 0018 made with the scan service for the bytes themselves,
and a smaller one.

Local development gains a moving part. Without the keys nothing changes:
`pnpm dev` runs the read inline like it does today. With them, `npx
inngest-cli@latest dev` provides the queue and the UI.

## Invariants touched

**Invariant 6 (RLS everywhere; the service role never appears in a request
path).** Unchanged, and deliberately not weakened for the convenience of a
background job. The job builds its store from the identity in the event —
`PostgresStore` as `app_rw` with `{ orgId, userId }` set transaction-locally,
the same construction `storeFor` makes for a request. There is no service-role
key in `apps/web`, none is added here, and a job that names a document the
tenant cannot see gets `undefined` from the database rather than a document. The
event payload is checked before it is used and a malformed one is a
`NonRetriableError`, because an event with no org id must not be read as "any
org".

**Invariant 4 (document content is untrusted; the reader gets no tools).**
Unchanged. The same `readablePayload` → `classify` → `extract` code runs; no
tool is passed to any reader, and the scan gate still stands between the bytes
and the first model call — now in two places that agree, because it is the same
`assertScannedClean` on the same recorded verdict. The event carries no document
text, so nothing a document says can reach the queue, the retry logic or the
function's routing.

**Invariant 2 (append-only tables).** Unchanged. No schema change, no migration,
no new grant. The job writes the same appends the request wrote.

**Invariant 3 (money is integer cents).** Untouched; no arithmetic moves.

The approval gate (invariant 1) is not in this path at all: reading a document
opens a case, and nothing downstream of a case is triggered from here.

## Rollback

Unset `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. Every environment falls
back to the inline runner, which is today's behaviour, and the serve route stops
serving. Documents already queued are lost as events and can be re-read by
re-uploading the same file: the bytes dedupe to the same document row, so a
re-upload is a re-read rather than a second document.

To remove it entirely: delete `apps/web/app/api/inngest/route.ts`,
`apps/web/lib/inngest.ts`, the runner half of `apps/web/lib/pipeline.ts` and the
`inngest` dependency. `packages/pipeline/src/jobs.ts` can stay — it is two
functions over the existing ports and `processUpload` is the same code either
way.
