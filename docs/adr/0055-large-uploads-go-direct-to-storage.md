# 0055 — Large uploads go direct to storage, into quarantine, and a job promotes them

- Status: proposed (2026-09-26). Awaiting the founder on the four decisions
  in §9. Nothing here is built: no code, no migration, no bucket.
- Date: 2026-09-26
- Amends: ADR 0014's "for now" (bytes still end in `document_blobs`; only
  the way in changes)
- Adds, if accepted: one new place untrusted bytes sit (a quarantine bucket),
  two append-only tables, and three new outbound calls (a presigned-POST
  signature, S3 GetObject and DeleteObject from a job)

## Context

### What the door is today

The only way a file reaches document storage is inside a function's request
body, and Vercel answers any request body over 4.5 MB with 413
`FUNCTION_PAYLOAD_TOO_LARGE` before our code runs (ADR 0047, context item 8).
E2 (PR #105) made that an honest limit rather than a bare error page:

- `apps/web/lib/upload-limits.ts` holds `PLATFORM_BODY_LIMIT_BYTES =
  4_500_000`, `FORM_OVERHEAD_BYTES = 64 KiB` and `UPLOAD_MAX_MB = 4`. It has
  no imports, so the browser reads the numbers the server enforces, and its
  header already says a larger file "waits for its own ADR". This is that ADR.
- `apps/web/app/upload/route.ts` refuses on the declared `content-length`
  before `formData()`, and again on the real `file.size`; both answer
  `upload_too_large`. The batch uploader (`lib/upload-batch.ts`) refuses an
  over-size file before sending it.
- The notice (`lib/notices.ts`) tells the person to split the PDF, rescan at
  200 dpi black and white, or "send it to us and we will add it". The last is
  manual, and a person on our side has only the same 4 MiB door.

Email has the same ceiling, lower: about 3.3 MB of attachments once base64
and the JSON around them are counted (ADR 0047). This ADR does not change
email; §8 says why.

A foodservice distributor's remittance, a scanned month of proofs of
delivery or a 60-page carrier invoice is routinely past 4 MB. The pilot
README puts large-file upload in week one.

### The limits behind the door do not agree

The 4 MiB door hides every one of these. A direct path exposes all of them,
so they are part of this decision rather than a follow-up.

| Where | Limit | What is wrong with it |
| --- | --- | --- |
| `packages/ingest/src/sniff.ts` `MAX_UPLOAD_BYTES` | 50 MB | Twice what the scanner accepts, so a 30 MB file passes the door and then has no verdict |
| `services/clamav-scan/server.mjs` `MAX_BYTES`, Dockerfile `StreamMaxLength 26M` | 25 MB | The real ceiling today, stated nowhere the app reads |
| `sniff.ts` `MAX_MODEL_PAYLOAD_BYTES` | 32 MB | Compared with the raw bytes (`sniff.ts:393`), but the Messages API receives base64 (`packages/extraction/src/prompt.ts`), four thirds the size. The raw ceiling is about 24 MB, less the prompt |
| `sniff.ts` `MAX_PAGES_PER_READ` | 100 pages | Sets `requiresSplit`, which `ingestDocument` passes to `putDocument` and nothing persists: `PostgresStore` reads it back as `false` (`store.ts:1141`) and no read consults it. The pilot README's "a PDF over 100 pages is refused" is not what the code does: the file is accepted with a warning and the read proceeds |
| Images to the model | none of ours | Sent as base64 blocks with no image-specific check. The API's per-image limit must be read from the current reference at build time, not assumed |
| Reducto | unverified | Its upload limit must be read from its docs at build time |

### Unscanned bytes already sit in `document_blobs`

`ingestDocument` (`packages/pipeline/src/steps.ts`) writes the `uploads` row,
then `putDocument` (the bytes), then scans, then `recordScan`. The scan gate
is enforced at read (`readablePayload` → `assertScannedClean`), so nothing a
model sees is unscanned. But the bytes of a file ClamAV called infected, or
never answered for, are durable in Postgres, and
`GET /api/document/[id]` serves any visible document without asking
`latestScan`. The sandbox CSP and `nosniff` blunt that in a browser; a
download (`application/octet-stream`, `attachment`) is still offered. That
route fix is small, needs no migration and no ADR, and is being made
separately; this ADR only has to not make it worse.

Vercel also caps a function's **response** body at 4.5 MB. Once a document
over 4.5 MB can exist, `/api/document/[id]` cannot serve it, and neither can a
packet's per-file download. Whether a streamed response is exempt must be
read from Vercel's docs, not assumed (§7).

### Invariant 6 and ADR 0037 decide how an upload may be authorised

The obvious path — Supabase Storage, `createSignedUploadUrl` or
`storage.upload` with the user's JWT — needs an INSERT policy on
`storage.objects` `to authenticated`, and a tenant-scoped one would have to
read `memberships`. Migration 0028 (ADR 0037) revoked every privilege
`anon`, `authenticated` and `service_role` held in `public` and `app`, and
suite 24 asserts it; the Data API is off. That path either gives a request
role a grant back or needs a new definer-function schema for it alone, and it
is ADR 0014's rejected option 2 again: a second authorisation story kept in
step with the first by hand. Signing storage tokens with the project's JWT
secret is strictly more powerful than the service role. The service-role key
may not be in a request path at all.

## Options

**A. An S3 quarantine bucket, written by a presigned POST, promoted by a job.
Recommended.** The app already runs on AWS for exactly one thing, KMS (ADR
0033, `@aws-sdk/client-kms`, `docs/qbo-credentials.md`), so AWS is an existing
sub-processor and not a new vendor. Two IAM principals, neither of them a
Supabase credential:

- `upload-signer`, in the request path: `s3:PutObject` on
  `arn:aws:s3:::<bucket>/quarantine/*` and nothing else. It cannot read,
  list or delete.
- `upload-promoter`, in jobs only: `s3:GetObject` and `s3:DeleteObject` on
  `quarantine/*`, `kms:Decrypt` on the bucket's key. Never on Vercel's request
  side, never on Preview.

A presigned **POST**, not PUT, because its policy document lets S3 itself
enforce what we would otherwise have to trust the browser for: the exact key
`quarantine/<org_id>/<intent_id>`, a `content-length-range` of `1..cap`, an
expiry of ten minutes, no ACL, and SSE-KMS. The bucket blocks all public
access, versioning is off, and a lifecycle rule expires every object under
`quarantine/` after one day — so an unscanned byte cannot outlive 24 hours
whatever the app does or fails to do.

**B. Supabase Storage with user-JWT RLS on `storage.objects`.** Rejected: it
re-grants `authenticated` (ADR 0037, suite 24), it is a second authorisation
story (ADR 0014 option 2), and it makes storage reachable directly by any
signed-in session.

**C. Supabase Storage signed by the service role or the JWT secret.**
Rejected under invariant 6.

**D. Vercel Blob client uploads** (`handleUpload`, `maximumSizeInBytes`, a
pathname-scoped client token). Workable, and the closest second. Against it:
its server token is read-write across the whole store, whether a store can be
made private (no public URL for an unscanned object) must be verified, it has
no equivalent of a lifecycle rule we control, and it would be a second Vercel
storage product for one use. Kept as the alternative if the founder does not
want the AWS setup.

**E. Make the Fly scan service the upload receiver, scanning inline.**
Scan-before-rest is its real merit. Rejected for now: it puts a database
credential or a second storage path into a service ADR 0018 built to be
stateless and credential-free. Noted as how scan-before-rest could be had
later.

**F. The status quo plus an operator path.** A `pnpm ingest:file` script that
runs the unchanged `ingestDocument` as `app_rw` with an explicit member,
through the test-database-style guards on which database it reaches. This is
the stopgap until A is built, and it is honest about being one: "send it to
us" becomes a command rather than a split.

## Decision (proposed)

Option A, with the stopgap F until it ships.

### 1. An intent is not an arrival

`POST /upload/intent` takes a small JSON body: the filename, the declared
size, the declared type if any, and an optional case to attach to. In order it
checks `isCrossSite`, `requireSession`, the member's role, `memberMayWrite`
asked of the database, and the declared size against
`LARGE_UPLOAD_MAX_BYTES`. It then writes one `upload_intents` row and returns
the presigned POST.

It writes **no** `uploads` row and **no** `documents` row. ADR 0024: an
arrival is a fact, and a URL handed out is not one. A signed URL nobody used
must leave nothing a coverage number could count.

`upload_intents` is append-only on 0004's pattern: `id`, `org_id`,
`created_by` (the caller, enforced by an authorship trigger the way 0016 and
0041 enforce theirs), the declared filename and size, `attach_to_case`
nullable, `expires_at`. The filename is untrusted text, bounded and never
logged.

### 2. The browser sends the bytes to S3, and then says so

The browser POSTs the file to the bucket with the signed fields. S3 refuses a
wrong key, a size outside the range or an expired policy on its own. Then the
browser calls `POST /upload/complete` with the intent id. That route checks
the session again, that the intent is the caller's own org's and was created
by the caller, and that it has not expired, and sends one Inngest event
carrying ids and the acting member — never bytes, never the filename. The
event's `readKey` is the intent id, so a double click is one promotion
(ADR 0021's idempotency, keyed on the request as it has been since
2026-09-21).

A browser that never calls `complete` leaves an object the lifecycle rule
removes and an intent with no outcome, which is what it is.

### 3. `promote-upload` scans, then stores

A new job, as `app_rw` with the event's claims, never the service role. It
asks `memberMayWrite` first, as `readDocumentJob` does, and takes an advisory
lock seeded on the intent id (a new seed, recorded beside 1, 2 and 3).

1. Fetch the object with the promoter principal. Its `ContentLength` must
   equal the declared size and be within the cap. No object is
   `never_arrived`.
2. **Scan the quarantine bytes first.** An infected file, or a scanner with no
   verdict, never enters `document_blobs`: only an outcome row records it, and
   the quarantine object is deleted. A scanner error is retried by the job;
   the lifecycle rule bounds how long it can be retried against.
3. Only then run `ingestDocument` with `source: 'web_upload'` and `uploadedBy`
   the intent's `created_by`: magic bytes and PDF inspection
   (`acceptUpload`), the `uploads` row, `putDocument`, `recordScan` with the
   verdict already obtained. The `uploads`-before-`documents` order of ADR 0024
   is kept. ADR 0014 is unchanged at rest: a promoted file's bytes live in
   `document_blobs` under the same policy as every other, so there is still one
   read-authorisation story.
4. Write one `upload_intent_outcomes` row: `promoted` with the document id,
   `rejected` with the ingest `RejectionCode`, `infected`, `scan_error`,
   `size_mismatch` or `never_arrived`. Append-only, at most one per intent.
5. Delete the quarantine object.
6. Hand off to the existing `readDocumentJob`. `attachToCase`, holds
   (ADR 0044), `answerFromRecord` and dedupe by hash are all unchanged.

The page polls the outcome, or says the document will appear under
"Documents waiting to be read" — the list that already catches a queued read
that stalls.

**Scan-then-store is proposed for this path only.** Reordering the existing
small-upload path the same way is right too, and is the founder's decision 3
below, because it changes what `ingestDocument` does on every door.

### 4. One table of sizes, from one module

| Limit | Value proposed | Source of truth |
| --- | --- | --- |
| Small upload (unchanged) | 4 MiB | `apps/web/lib/upload-limits.ts` |
| Large upload cap `LARGE_UPLOAD_MAX_BYTES` | 25 MB | new, in `@recouple/ingest`, imported by the web app and asserted equal to the scanner's by a test |
| Scanner `MAX_BYTES`, `StreamMaxLength` | 25 MB | raised only with the cap, never apart |
| Ingest `MAX_UPLOAD_BYTES` | 25 MB, down from 50 | the same constant |
| Model payload | raw bytes × 4/3 + prompt ≤ the API's request limit | `MAX_MODEL_PAYLOAD_BYTES` compared with the **base64** length |
| Image to the model | the API's per-image limit, read from the reference at build time | new check in `acceptUpload`; an image over it is refused at the door, not at the model |
| PDF pages | 100 | `requiresSplit` persisted and **consulted**: a document that requires a split is held for a person rather than sent (ADR 0044's `document.held`, a new reason). Persisting it on append-only `documents` is a migration, so it is a new table keyed by document or a column added by a new migration — a build-time choice |

The job holds up to 25 MB about three times (the S3 read, the bytea
parameter, the base64 payload), which is within a function's memory. Ten
gigabyte folders and zip files are out of scope: they need S3 multipart or
TUS and a streaming unpacker, and stay in the pilot README's
"Miscellaneous".

### 5. The new tables

`upload_intents` and `upload_intent_outcomes`: RLS on, one policy per
command, a writer role to insert, `no_update_delete` and `no_truncate` on
`app.block_mutations()`, `app_rw` SELECT and INSERT, `app_ro` SELECT, and
nothing for the request roles. Suites 01 and 24 read them back; a new suite
holds the authorship trigger and "at most one outcome per intent". The
migration takes the next free number at the time it is written.

### 6. Where the credentials live

`UPLOAD_SIGNER_*` (the signer's access key, or better a role it assumes) and
the bucket name on Vercel **Production** only. `UPLOAD_PROMOTER_*` wherever
the Inngest functions run with their production keys, and nowhere a request
handler can read it. **Preview holds neither**, for the reason
`docs/supabase.md` gives for Inngest's keys. `largeUploadFromEnv` is
`scannerFromEnv`'s shape: all set is on, none set is off (the form shows the
4 MB limit and "send it to us", as today), some set is an error that names the
variable.

### 7. Serving a document over 4.5 MB

Open. Either a presigned GET from a durable bucket, which moves bytes out of
Postgres and so needs its own read-authorisation story (a new ADR superseding
0014), or a streamed response from `/api/document`, if Vercel's response cap
does not apply to streaming. The build must read Vercel's current docs and
decide; until then a large document shows "too large to preview here" with its
fields, boxes and quotes, which are what a reviewer approves against.

### 8. What this does not do

- Email stays at about 3.3 MB. Postmark keeps no attachment we could fetch
  later, so the only fix is a different inbound provider or raw MIME to our
  own bucket; neither is proposed here.
- No portal write, no auto-submission, no new `uploads.source`: a large upload
  is a `web_upload` like any other.

### 9. What the founder decides

1. **Option A** (an S3 quarantine bucket, presigned POST, two IAM
   principals), or D (Vercel Blob), or F alone for now.
2. **The cap**: 25 MB, matching the scanner, or raise the scanner's memory and
   `StreamMaxLength` with it.
3. **Scan before storing** on every door, so that infected or verdict-less
   bytes never enter Postgres — or on this path only.
4. **Who provisions the bucket and the two principals, and when**, as a
   `docs/qbo-credentials.md`-style runbook. For the pilot, the 4 MB limit and
   "send it to us" stand until this is done.

## Consequences

- A person can upload up to 25 MB themselves, and the refusal they meet above
  it is ours, in words.
- Every limit between the door and the model is stated once and tested
  together; `requiresSplit` stops being a flag nothing reads.
- An unscanned byte sits in exactly one place, which nothing reads without a
  scan and which empties itself within a day.
- AWS grows from one KMS key to a bucket and two principals, each with a
  single-purpose policy. That is more to set up and more to rotate.
- A promotion is asynchronous. The person sees "arrived, being checked" before
  "being read", one more state than a small upload.
- Serving is not solved (§7), and until it is, a large document is reviewed
  through its fields rather than its pixels.

## Invariants touched

- **2 (append-only)**: both new tables are append-only; an intent is never
  edited into an outcome.
- **4 (untrusted content)**: kept, and strengthened on this path: nothing
  reads a quarantine object except the scanner and the door's own byte
  inspection, and nothing reaches `document_blobs` unscanned.
- **6 (RLS, no service role in a request path)**: kept. The request path holds
  a credential that can write one key into a place nothing reads unscanned. It
  is not a Supabase credential and it reaches no table. The new tables have
  RLS.
- The new outbound calls (signing, S3 GET and DELETE) are why this ADR comes
  first, per CLAUDE.md.

## Rollback

Unset the signer variables: the form falls back to the 4 MB limit on its own
(`largeUploadFromEnv` answers off). The tables stay, append-only, holding what
happened. Empty and delete the bucket; the lifecycle rule has already bounded
what is in it. Documents promoted before the rollback are ordinary documents
in `document_blobs` and need nothing.
