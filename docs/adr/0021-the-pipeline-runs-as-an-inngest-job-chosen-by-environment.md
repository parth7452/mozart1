# 0021 — The pipeline runs as an Inngest job, chosen by environment

- Status: accepted
- Date: 2026-09-20
- Amended: 2026-09-21 — the function's `idempotency` key moves off the document
  id and onto a per-request `readKey`; a document that was queued and never read
  is visible with a way to re-drive it; and the read's own guard is held under a
  per-document lock in the database, because a guard on its own loses a race.
- Amended: 2026-09-26 — an upload that names a case keys its read on the
  (document, case) pair, and a delivery that finds its document claimed while
  it has a case to file on waits for the read in front of it instead of
  answering `beingRead` (*Amendment, 2026-09-26*, below).

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
`idempotency: 'event.data.readKey'` (see below), and two concurrency limits — one keyed
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
cause, and the reviewer is told the document is stored and that it is listed
under "Documents waiting to be read" on the case list, where it can be re-driven
by hand. That notice used to say to upload the same file again, which was true of
the bytes and false of the read for as long as this function's idempotency key
was the document id — see below.

A failed read is now visible and retried. Inngest records the error and retries
three times; the steps are idempotent by construction (the same bytes dedupe to
the same document, `recordPages` is keyed on the document, and a document that
already has a recorded extraction is answered from what was recorded rather than
read again), so a retry finishes the work rather than duplicating it.

**A second delivery does not open a second case and does not pay for a second
read — and which of three things stops it depends on when the second one
arrives.** The distinction is worth stating plainly, because "it costs nothing"
was written here first and was only true of one of the three.

*A delivery that arrives after the first has finished* is answered from the
record: `readDocumentJob` sees an `extraction_results` row for the document and
reports what was recorded without classifying, extracting or opening anything.
That is the case retries and redeliveries usually are, and it holds on the
inline path too.

*A delivery that overlaps the first* is answered by a lock. The guard is a
question about the past and the read is what changes the answer, so between the
two sits OCR, two model calls and an `openCase` — and two deliveries inside that
window both hear "not read yet". Proved, not theorised: two concurrent
`readDocumentJob` calls on one document produced four model calls, two
`extraction_results` rows and two cases. So the guard and the read now run
together while the job holds that document's claim —
`PostgresStore.withDocumentRead`, a `pg_try_advisory_xact_lock` on
`hashtextextended(document_id, 0)`, taken as `app_rw` with the tenant's claims
set, on its own pool so a connection held for the length of a read cannot starve
the reads themselves. A delivery that does not get the claim is told so
(`beingRead`) and spends nothing; it does not wait, because waiting would hold a
worker for the length of somebody else's model calls to learn something it can
be told immediately. (Amended 2026-09-26: a delivery with a case to file the
document on does wait, by retrying rather than by holding a worker — see
*Amendment, 2026-09-26*, below.) *Transaction*-scoped and not session-scoped on purpose:
`DATABASE_URL` is Supabase's transaction pooler, where a session lock can be
taken on one server connection and unlocked on another — which would leave a
document permanently unreadable. A transaction is the unit that pooler
guarantees, and the lock cannot outlive one.

*A redelivery of the same event* is also covered by the runtime, within its
window, by `idempotency: 'event.data.readKey'` — see below.

Behind all three is `unique (org_id, debtor_id, claim_id)`, the database's
backstop, which holds only once a human has linked the retailer, because a null
`debtor_id` never collides (ADR 0019). It is null for every case a new tenant
opens, which is why the other three exist.

The one thing that guard must not skip is a read that would do something the
first one did not: attaching the document to a case it is not yet linked to (the
same BOL is evidence for two deductions), or opening a case for a notice that
has none — an unauthenticated email's notice is read and deliberately left
caseless (ADR 0016). Both re-read.

**The runtime key moved off the document id and onto the request:
`idempotency: 'event.data.readKey'`.** Amended 2026-09-21, after production
showed what the old one cost. A document was uploaded and queued; Inngest invoked
`recouple/read-document` once; the SDK answered 206 with a step plan; the
runtime never called back to execute the step. Nothing threw, nothing was
logged, and the reviewer's notice said "being read" indefinitely. A second
upload of the same bytes sent a second event, and that key's own twenty-four
hour window swallowed it — so the recovery the `upload_not_queued` notice
promised could not work, for a day, by design.

The document id was the wrong thing to key on, not the keying itself. Two
different things name the same document: a redelivery of one request to read it,
which should be one read, and a deliberate re-drive of a read that did not
happen, which is a new request and must go through. `readKey` says which of the
two an event is. An upload sets it to the document id, so that upload's own
redelivery is still one read. The re-drive route sets a fresh `randomUUID()`, so
the window has nothing to say about it, and the recovery the old key swallowed
cannot be swallowed again. A window that suppresses the recovery is worse than
no window; a window keyed on the request is not one.

It is a window and not the guarantee. The guarantee is in the database, holds on
every delivery rather than inside twenty-four hours, and holds on the inline path
as well as the queued one: the record for a delivery that arrives late, the lock
for one that overlaps.

One interaction survives the change and is worth keeping written down rather than
rediscovering. (Amended 2026-09-26: it no longer survives — see *Amendment,
2026-09-26*, below. The paragraph is kept as it was decided.) An upload's
`readKey` *is* the document id, so within the window
the runtime still suppresses a second upload of the same bytes — which is what a
reviewer does when they attach the same BOL to a second deduction from that
case's page. The read that upload wanted is a real one: the guard deliberately
re-reads for a case the document is not yet linked to, so that an attachment is
not lost. The window can delay its running, and the re-drive button does not
recover this one — it attaches to nothing by design, and a document that has
already been read does not appear on the "waiting to be read" list at all. What
the amendment fixes is the case that was *unrecoverable*, a notice that was never
read; this one still resolves itself when the window closes, and the reviewer can
upload the file a third time then. Narrowing an upload's key to include
`attachToCase` is the fix if a reviewer reports an attachment that never
appeared, and it is a CEL expression worth changing against a real Inngest rather
than guessing at here.

Alongside it the function logs its own step boundaries: run entered, step
entered, what the step concluded, run returned, each with the document and org
ids and nothing else. A run line with no step line under it is exactly the stall
above, and it is now visible in the platform's logs rather than invisible
everywhere.

**A document that was queued and never read can be seen, and read again.** The
case list shows, to a member who may write, every document of theirs that is
stored, scanned clean, has no `extraction_results` row and is older than five
minutes — `PostgresStore.unreadDocuments`, read through `withTenant` as `app_rw`
like everything else, no new table and no migration. Each row carries a "Read
again" button, which POSTs to `/documents/[id]/reread`: cross-site refused,
session, id checked, role checked here and `app.member_may_write()` checked in
the database, the document visible to the tenant or a 404, and then a re-drive
through the same runner `runnerFromEnv` gives — the same
`document/read.requested` event where there is a queue, the same
`readDocumentJob` inline where there is not. It is safe to press twice for the
same reasons a second delivery is safe: a press that lands after the first has
finished is answered from the record, and a press that lands while the first is
still running does not get the document's claim and is answered rather than run.
Every refusal is a notice key and a redirect, never a 500.

Two things the button deliberately does not do. It does not fetch the document
to decide whether the tenant may see it — `documentIsVisible` is a `select 1`
under the same policies, because the alternative was pulling a scanned notice's
bytes out of object storage on every press to learn one bit. And it does not let
a re-drive open a case for a notice that arrived on an email whose sender could
not be authenticated — read and deliberately left caseless by ADR 0016 — so a
button on our own case list cannot be how a forged `From:` finally gets its
case.

**That rule is now read off the document's source, which was the intention all
along.** When this ADR was written nothing wrote the `uploads` table, so
`documents.upload_id` was null on every row and no document recorded where it
came from; the button had to approximate the rule with "has this been read
before", which held for every document that was read and left a gap — a web
upload whose first read recorded an extraction and then failed to open a case
could never get one, because being read at all was taken as having settled the
question. `ingestDocument` writes the `uploads` row now, before it stores the
bytes, and no migration was needed: the table and the column have been there
since 0003. So `web_upload` may open a case, unconditionally, which is exactly
what the upload itself would have done.

Everything else keeps the old approximation, and for a stated reason rather than
an unstated one: whether an inbound email passed DKIM or DMARC is **not
persisted anywhere**. `InboundEmail.authenticated` decides `allowCaseOpen` at
ingest and is never written down, and there is no column for it short of a
migration and an ADR of its own. An email-borne document — and a document
stored before any of this, which records no channel — therefore gets the
conservative answer, because that is the one that cannot let an unauthenticated
sender acquire a case. Persisting the authentication verdict is the change that
would close the remainder.

This is the visible half the original design was missing. Every step was
separately re-runnable from the start; what did not exist was a way to see that
there was something to re-run, and "the reviewer's only recourse is to upload
the same file again and hope" — the sentence this ADR's own Context wrote about
gateway timeouts — turned out to describe the queue too.

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

**The keyless concurrency limit is capped by the Inngest plan, not by us.**
Inngest refuses to sync an app whose function asks for more concurrency than the
plan allows ("The function 'Read an uploaded document' has higher concurrency
limits (16) than your plan limit of 5"), and a refused sync is not a slower read
but no deployed function at all, so `READS_IN_FLIGHT` is 5 — the plan's limit,
recorded beside it as `INNGEST_PLAN_CONCURRENCY_LIMIT` — with the per-org limit
at 2 underneath it so one tenant's bulk upload cannot hold every slot.

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
serving. Documents already queued are lost as events and are then exactly the
"waiting to be read" case above: they appear on the case list and the same
button reads them, now inline. Re-uploading the same file also works — the bytes
dedupe to the same document row, so a re-upload is a re-read rather than a
second document — and it is no longer the only recourse.

To remove it entirely: delete `apps/web/app/api/inngest/route.ts`,
`apps/web/lib/inngest.ts`, the runner half of `apps/web/lib/pipeline.ts` and the
`inngest` dependency. `packages/pipeline/src/jobs.ts` can stay — it is two
functions over the existing ports and `processUpload` is the same code either
way.

## Amendment, 2026-09-26 — an attachment's read is keyed on its case, and waits

The interaction written down above was met: the same bytes uploaded to a second
case while the first upload's read was still running had nothing on record to be
answered from, so they were queued — and lost twice over. The event's `readKey`
was the document id, the first upload's, so the idempotency window swallowed it;
and had it run, it would have found the document claimed and answered
`beingRead` as a success, filing nothing on the second case while the reviewer
was told the document was being read for it.

Two things change, both in `apps/web/lib`, with no migration:

- **An upload that names a case keys its read on the pair,
  `attachReadKey(document, case)`** — deterministic and UUID-shaped, so a
  redelivery of that upload is still one read, and a second case's upload is a
  different request. An upload that names no case still keys on the document
  id, and the re-drive route still sets a fresh `randomUUID()`.
- **A delivery that finds its document claimed and has a case to file on fails
  its step with `RetryAfterError`** (`ATTACH_WAITS_FOR_READ_MS`, two minutes,
  with `READ_DOCUMENT_CONFIG.retries` at three) instead of succeeding. This is
  not the wait the decision above refused: no worker is held for the length of
  somebody else's model calls, because the runtime schedules the retry. The
  retry takes the claim and is answered from the record — the first read's
  recording filed on the second case with `attachEvidence`, no model call — or,
  if the first read failed, reads the document itself. A read that outlasts
  every retry — about six minutes, an estimate no slow dense read has been
  timed against — fails the run, where `alert-on-failure` (ADR 0052) sees it,
  and the reviewer uploads the file to the case again.

A delivery with no case to file on still answers `beingRead` and succeeds, for
the reason given above: there is nothing it could do by waiting that the first
read is not already doing. `apps/web/test/inngest-job.test.tsx` and
`apps/web/test/upload-route.test.tsx` hold both halves.
