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
`idempotency: 'event.data.documentId'`, and two concurrency limits — one keyed
on `event.data.orgId` so a tenant's bulk upload cannot starve another's, and one
with no key at all, which is the ceiling on how many reads this app runs at
once however many tenants want one. The per-org limit bounds a tenant; only the
keyless one bounds the bill. It declares `maxDuration = 300`, the largest value
Vercel allows on the plans we might be on; the project's plan is not recorded
anywhere in this repository, so if it is Hobby the platform will clamp it to that
plan's ceiling rather than honour 300.

The route serves nothing when the keys are absent: no client, no functions, and
a 503 that says the read runs inline here. An unconfigured deployment therefore
has no endpoint that runs a job at all, rather than one that would run whatever
it was handed.

It also serves nothing when `INNGEST_DEV` is set in a production build, keys or
no keys — 503 with the reason logged. Dev mode turns off verification of
Inngest's request signature, and that signature is this endpoint's entire
authentication: it has no session, and the function behind it builds a tenant's
store from ids in the body it is handed. `INNGEST_DEV` on a laptop is what it is
for; the same variable on a deployment would publish an endpoint that runs a read
as any org and any member for anyone who can reach the URL. Refusing to serve is
the only reading of those two settings together that is not a hole.

**The job checks the actor before it spends anything.** `tenant_read` is
`org_id = app.current_org_id()` and nothing more (migration 0010) — the write
policies are where `app.member_may_write()` is consulted. So a validly signed
event naming a victim's org and one of its documents, with any user id at all,
would be fetched, OCR'd and read by a model, and only refused when the first row
was written. `readDocumentJob` therefore asks the database whether this member
may write in this org *before* it fetches the document, and refuses with
`InvalidJobPayloadError` — non-retriable, because a membership does not appear
because we asked again.

## Consequences

An upload returns as soon as the bytes are stored and scanned. With the job
runner there is no case id to redirect to yet, so the reviewer goes back to the
case list with a message saying the document is being read; a reviewer attaching
evidence goes back to the case they were on. With the inline runner the redirect
is unchanged — straight to the case the notice opened.

**When the queue will not take the event, the upload still succeeds.** The bytes
are stored and scanned before the event is sent, so a failing `send` is a
document that exists and nobody is coming for. Throwing there would hand the
reviewer a 500 for an upload that worked. Instead the failure is logged with its
cause, and the reviewer is told the document is stored and will be read when the
queue is reachable, and that uploading the same file again re-queues it — which
it does: the bytes dedupe to that same document row, no read was ever recorded
for it, and the job does the read rather than reporting one.

A failed read is now visible and retried. Inngest records the error and retries
three times; the steps are idempotent by construction (the same bytes dedupe to
the same document, `recordPages` is keyed on the document, and a document that
already has a recorded extraction is answered from what was recorded rather than
read again), so a retry finishes the work rather than duplicating it.

A redelivered event does not open a second case, and does not pay for a second
read. Three things stand behind that, in order of how much they are worth:
`readDocumentJob` answers a document that already has an extraction from what
was recorded, without classifying, extracting or opening anything; `idempotency`
on the document id is the runtime's own promise, within its window;
`unique (org_id, debtor_id, claim_id)` is the database's, and it holds only once
a human has linked the retailer, because a null `debtor_id` never collides (ADR
0019). The middle one is a third party's word and the last one is null for every
case a new tenant opens, which is why the first one exists.

The one thing that guard must not skip is a read that would do something the
first one did not: attaching the document to a case it is not yet linked to (the
same BOL is evidence for two deductions), or opening a case for a notice that
has none — an unauthenticated email's notice is read and deliberately left
caseless (ADR 0016). Both re-read.

One interaction is worth writing down rather than discovering: `idempotency` is
keyed on the document id alone, so within its window the runtime will also
suppress the *second* event for a document a reviewer is deliberately attaching
to another case — the same BOL, uploaded again from a second deduction's page.
The guard is written so that read does its work when it runs; whether it runs
inside that window is the runtime's decision and not ours. Narrowing the key to
include `attachToCase` is the fix if a reviewer reports an attachment that never
appeared, and it is a CEL expression change worth making against a real Inngest
rather than guessing at here.

**A failed run reports its class and its ids, and never its message.**
`DuplicateCaseError` interpolates the claim id, which is text off the page, and
an extractor's error can quote the page itself. Those messages would otherwise
land in a third party's run history and stay for its retention period, which is
precisely what the event payload is careful not to do. So the error that reaches
Inngest says `DuplicateCaseError reading document <id> for org <id> (case <id>)`
and carries no cause; the original is logged in full where the platform's own
logs are.

Spend is still attributed. The job records every `model_calls` row through the
same store as the request would, with the same tenant claims, so cost per case
and cost per document do not change shape. A retry's calls are recorded too:
they happened.

**What a clamped `maxDuration` costs.** `maxDuration = 300` is a request, not a
guarantee: the platform clamps it to the plan's ceiling, and this repository does
not record which plan the project is on. A clamp that lands mid-extraction kills
the function between the model call finishing and `recordModelCall` writing it
down — the read is one step, and its writes come after the page is read — so
those tokens are spent, billed by Anthropic, and absent from `model_calls`. Cost
per document then understates, and the retry pays again. Nothing is corrupted:
the second attempt records what it spends, and a third-party invoice is the only
place the lost tokens appear. Two things would fix it and neither is in this
change: recording a model call as soon as it returns rather than after the read
completes, and knowing the plan's real ceiling. Until then, a large jump between
Anthropic's invoice and the sum of `model_calls` is the symptom to look for, and
a dense document is where it would come from.

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
function's routing. A failed run's error message carries none either, which is
why it is rebuilt from ids rather than passed through.

**One thing in this dependency is a trap, and it is worth writing down.**
`inngest` depends on `@traceloop/instrumentation-anthropic` and on
`@opentelemetry/auto-instrumentations-node`. Nothing registers them: we install
no OpenTelemetry provider, we do not call `extendedTracesMiddleware`, and the
client is constructed with keys and nothing else. The client does attach a span
processor of its own, but what it reports is Inngest's view of the run — steps,
timings, outcomes — and not the contents of anything the step called. No span of
an Anthropic call is created or exported today. That middleware is what would
change it. Its
whole purpose is to attach richer spans to the traces in the Inngest dashboard,
and the instrumentation it can register around the Anthropic SDK records the
call's prompts and completions as span attributes. Our prompts *are* the
document: the page text goes to the model inside `<untrusted_document>`
delimiters, and the completion is the quotes copied off it. Enabling that
middleware would therefore ship the contents of a customer's deduction notice to
a third party's trace storage — quietly, as a telemetry improvement, and past
every other care this ADR takes about what the queue is allowed to know. So:
**`extendedTracesMiddleware` is not to be enabled without re-reading invariant 4
and deciding, in an ADR, what a span may contain.** If richer traces are wanted,
the thing to check first is whether the instrumentation can be given an
attribute filter, and the thing never to do is to turn it on because a dashboard
looked empty.

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
