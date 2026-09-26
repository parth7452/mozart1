# 0052 — A failed job reaches a person

- Status: accepted
- Date: 2026-09-26
- Adds: one outbound side effect, an email to the operator, from one Inngest
  function (`apps/web/lib/alerts.ts`)

## Context

Four background jobs do the work a customer cannot watch: `read-document`
(ADR 0021), `read-inbound-email` (ADR 0047), `sync-ledger` and
`ledger-sync-fan-out` (ADR 0031). When one of them exhausts its retries, the
run is marked Failed in the Inngest dashboard, and that is all. Nobody is told.
The week-one routine (ONBOARDING §6, item 8) says "Inngest and Vercel failure
alerts: anything from this workspace's jobs gets read and answered the same
day". No such alert existed to read.

Research on 2026-09-26 found no built-in email or Slack alert for a failed run
on any Inngest plan. That covered the docs, the pricing page and the
changelog. The dashboard charts "Failed Functions". Metric export to Datadog
or Prometheus is paid-only. The founder checked the same day: Inngest's own
answer to "alerts" is a failure handler, or a function that listens for the
`inngest/function.failed` system event. So the alert has to be ours.

The facts this decision rests on were read from Inngest's docs and from the
open-source server and the installed SDK (4.20.0):

- `inngest/function.failed` is emitted once per run that ends Failed. That is
  after the last retry, or at once for a `NonRetriableError`. It is **not**
  emitted for a cancelled run or a timed-out run; those emit
  `inngest/function.cancelled`.
- Its `data` carries `function_id`, `run_id`, `error` (`name`, `message`,
  `stack`) and `event`, the original triggering event with its `data`.
  `function_id` is the app id and the function's id joined by a hyphen:
  `recouple-read-document`.
- The server does not emit `inngest/function.failed` for a run that was itself
  triggered by `inngest/function.failed`. A handler cannot loop on its own
  failure. The same guard makes a handler's own failure silent.
- Event names under `inngest/` are reserved: the event API refuses them with a
  400. A holder of the event key cannot forge a failure.
- `rateLimit` is available on the Free plan, drops runs over the limit rather
  than queueing them, accepts periods up to 24 hours, and keeps one bucket per
  function per key value. A key expression over a field the event does not
  carry does not rate-limit that event at all.

## Decision

### 1. One function, triggered by the failure event, filtered to four jobs

`alert-on-failure` (`recouple-alert-on-failure`) is served from
`/api/inngest` beside the others. It has two triggers:

- `inngest/function.failed`, with an `if` expression that names exactly the
  four watched functions by their full ids. The ids are built from each job's
  own exported config, so renaming a job cannot quietly drop it from the
  filter. `apps/web/test/alerts.test.tsx` holds the list to those four
  configs. A fifth job added to `/api/inngest` is not watched until it is
  added here.
- `recouple/alert.test`, which the founder sends from the dashboard (§6).

The handler checks the function id again against the same list before it
sends. A failure of any other function, in this app or another app in the same
Inngest environment, sends nothing. That includes this function's own
failures, which the server does not report anyway.

### 2. The channel is Resend, with a key that can only send

Two services already send mail for us: Postmark (inbound, ADR 0047) and Resend
(Supabase Auth's SMTP, for sign-in links). The alert goes through **Resend's
HTTP API with a `sending_access` key restricted to one domain**. Such a key can
send from that domain and do nothing else. Any other endpoint answers
`restricted_api_key`.

Postmark was not taken. Its only API credential is a server token, which on the
inbound server reads every tenant's mail and can repoint the webhook. That is
why ADR 0047 keeps it off Vercel. Using Postmark would mean a second,
outbound-only Postmark server with its own token, and a second sending domain
to verify. Resend's domain is already verified for sign-in mail, and its
narrowest key is narrower than anything Postmark offers.

`ResendAlertMailer` sends plain text only. It sets an `Idempotency-Key` of
`alert:<run id>`, so a send that succeeded at Resend but whose response was
lost is not delivered twice when the step retries; Resend honours the key for
24 hours. Every request carries a `User-Agent`, which Resend requires. A call is
capped at 10 seconds.

### 3. Three variables, Production only, all or nothing

| Variable | What |
| --- | --- |
| `ALERT_EMAIL_TO` | The one address alerts go to |
| `ALERT_EMAIL_FROM` | The sender, an address on the domain the key is restricted to |
| `RESEND_API_KEY` | The `sending_access` key |

They are set on Vercel **Production only** and never on Preview. A preview has
no Inngest keys, so it serves no functions and would never send an alert.
Keeping the mail key off Preview as well means a preview holds nothing that
can send mail as us (the 2026-09-23 lesson, `docs/supabase.md`).

`alertsFromEnv` is `scannerFromEnv`'s shape: one typed answer.

- **None set.** Alerts are off. The function still runs on a failure, logs
  "alerts are not configured" and returns `not_configured`. The run's output in
  the dashboard shows why no mail came.
- **Some set, or an address that is not one address.** Alerts are
  misconfigured. The function logs the reason as an error, names the variable,
  and sends nothing.
- **All three set and well formed.** Alerts are on.

The function is registered in every case. Registering it only when configured
would make "no alert came" indistinguishable from "no alert was ever
possible". Its run would not exist to look at.

### 4. What the email may say

Four things, and each is either a constant or checked against a closed format:

- **The function**: its full id, one of the four constants, and its name.
- **The run id**: accepted only as a 26-character ULID. Anything else prints
  as "not given".
- **The error's class name**: `data.error.name`, accepted only as an
  identifier of at most 64 characters (`[A-Za-z_$][A-Za-z0-9_$]*`). Anything
  else prints as "not given".
- **A link to the run**: `https://app.inngest.com/env/production/runs/<run
  id>`. When there is no valid run id, it links to the function's runs page.

A fixed paragraph per function says what to do next, such as "press Read
again once under Documents waiting to be read".

Two things the event carries are never read. **`data.error.message`** can
quote the page: `DuplicateCaseError` interpolates a claim id, and a payload
refusal repeats a value it was handed. **`data.event`** is the triggering
event: ids today, but a third party's durable copy of whatever we send. This
is ADR 0021's rule for a failed run's message, applied one hop further. That
rule is why `asJobFailure` rebuilds a message from class names and ids. The
parser reads `function_id`, `run_id` and `error.name` by name, and nothing
else. The tests put a marker string in every other field and assert it
reaches neither the subject nor the body.

The class name is often generic. `asJobFailure` throws `NonRetriableError` or
`Error`, with the original class at the start of the message. The message is
exactly the field this email does not read, so the email says
`NonRetriableError`, and the run page one click away says the rest.

### 5. One email per function per hour

`rateLimit: { limit: 1, period: '1h', key: 'event.data.function_id' }`. The
first failure of a function sends. Every further failure of that function in
the next hour is dropped by Inngest before a run starts. The email says so.
The dashboard's Runs page lists them all. A burst, such as fifty reads failing
because a vendor is down, is one email per function.

`retries: 2`, not the default 3. A refusal Resend will give again is a
`NonRetriableError`: 400, 401, 403, 404 or 422, which cover a bad key, an
unverified domain and a malformed address. A timeout, a network error, a 409
(a concurrent request with the same key), a 429 or a 5xx is retriable. The
send is one `step.run`, so it is attempted at most three times. The run then
fails silently, per the server's guard. So every failed send is also logged
to Vercel as `[recouple] alert: not sent`, with the function, the run and the
status, and never the key.

### 6. A test the founder can press

Inngest dashboard → production → **Events** → **Send event**:

```json
{ "name": "recouple/alert.test", "data": {} }
```

The function sends an email whose subject begins `[TEST]` and whose body says
it is a test and that nothing failed. It carries no `function_id`, so the rate
limit does not apply to it (§ Context). Every press sends. A run of **Email a
failed run** appears either way, and its output says `sent`, `not_configured`
or `misconfigured`.

## What it does not catch

- **A stall.** A run that is invoked and never comes back to execute its step
  (2026-09-21, ADR 0021) is not a failure and emits nothing. "Documents
  waiting to be read" on the case list, and the week-one routine's daily look
  at it, stay the check for stalls.
- **A cancelled or timed-out run.** It emits `inngest/function.cancelled`.
  None of the four jobs sets `timeouts` or `cancelOn` today. The first one to
  do so should add that trigger here.
- **A failure inside a step that the job catches.** Such a run completes. The
  ledger sync records its own failed runs on `/coverage` (ADR 0031), and that
  page stays the place to look.
- **Vercel.** A route that returns 500, or a build that fails, is Vercel's to
  report. ONBOARDING §6 item 8 keeps Vercel's own notifications for that.
- **The alert itself.** A send that fails three times is a log line only (§5).
  The test in §6 is how to know the path works.

## Options not taken

- **`onFailure` on each of the four functions.** It gives four hidden handler
  functions, one per job, and a rate limit per job rather than one place. The
  system event does the same job in one function.
- **Metric export to Datadog or Prometheus.** It is paid-only, and it moves
  the question to another vendor's alerting.
- **Postmark** (§2).
- **Slack.** It would need a webhook URL, one more secret on Vercel, and a
  channel someone reads. Email reaches a phone with nothing new to set up.
- **Including the error message, redacted.** Nothing reliably redacts text
  off a page. A class name and a link are enough to start from.

## Consequences

- A job that fails after its retries reaches the founder's inbox within
  minutes, once the three variables are set.
- A burst of failures is one email per function per hour. The rest are in the
  dashboard, and the email says so.
- Resend's free plan allows 100 emails a day, and **that quota is shared with
  Supabase Auth's sign-in mail**, which goes through the same account (§2).
  Four functions at one an hour is at most 96 alerts, and the test event is
  unlimited. So a day on which every job fails every hour could use up the
  quota. From then until the next UTC day, Resend answers 429 to both the
  alerts and members' magic links, and nobody can sign in. That takes all four
  jobs failing all day, which is itself an outage. If it happens once, or if
  sign-ins grow, the fix is Resend's paid plan or a separate Resend account
  for alerts, not a code change. The quota is visible in Resend's dashboard.
- The dashboard counts every alert run as an execution: two per email, the run
  and its step. Inngest drops rate-limited events before a run starts, so they
  cost nothing.

## Invariants touched

- **Invariant 4 (document content is untrusted).** This is the one to check.
  The email carries no text off a document, and no text from the error message
  or the triggering event (§4), and the tests assert it. The function calls no
  model and reads no document.
- **Invariant 6 (RLS; no service role in a request path).** Untouched. The
  function opens no database connection at all.
- **Invariants 1, 2, 3, 5, 7.** Not in this path. Nothing is written to the
  database, no money moves, and no threshold changes.

## Rollback

Unset `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` and `RESEND_API_KEY` on Vercel
Production and redeploy. The function stays registered and answers
`not_configured`. To remove it entirely, delete `apps/web/lib/alerts.ts`, its
entry in `apps/web/app/api/inngest/route.ts` and its test. The next deploy
unregisters it.
