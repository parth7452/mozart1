# Deploying `apps/web`

The app builds from the monorepo root, not from this directory. On Vercel that
means one setting matters more than the rest: **Root Directory = `apps/web`**,
with "Include source files outside of the Root Directory" left on, so pnpm can
resolve `@recouple/*` from the workspace.

## Settings

| | |
| --- | --- |
| Repository | this one |
| Root Directory | `apps/web` |
| Framework | Next.js (auto-detected) |
| Production Branch | `main` |
| Build / install command | leave as detected |

## Environment variables

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | The Supabase **transaction pooler** URI (port 6543), as a role that may `set role app_rw`. Not the `postgres` superuser |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable key. Designed to be public; used only for auth |
| `NEXT_PUBLIC_SITE_URL` | The deployment's own origin. Magic links come back here, so a wrong value sends people to localhost |

There is deliberately no `SUPABASE_SERVICE_ROLE_KEY`. It bypasses RLS and does
not belong in a request path — invariant 6, and the one invariant the database
cannot enforce for us (ADR 0015).

### Uploads need three more

An upload runs the real pipeline, and each of these refuses rather than guesses
when it is missing:

| Variable | Why |
| --- | --- |
| `CLAMAV_SCAN_URL` | The hosted scan service's `/scan` endpoint. Without it there is no scanner, and the gate refuses every file — `not scanned clean: error (none)` |
| `CLAMAV_SCAN_TOKEN` | The bearer token that service was started with. A URL **without** a token is treated as no scanner at all, not as an unauthenticated call |
| `ANTHROPIC_API_KEY` | Classification and extraction. An upload fails at the reader rather than silently doing nothing |
| `REDUCTO_API_KEY` | OCR for scans. Optional: without it a scan still extracts, with every quote unverifiable (ADR 0009) |

The scan service is a container that has to be deployed once, separately —
`services/clamav-scan`, with its own README. It exists because clamd has no
authentication and cannot be exposed to Vercel's egress directly (ADR 0018).
Its host needs billing set up: Fly's free trial stops every machine five
minutes after it starts, and the next scan then waits for a cold start.
Do not set `CLAMAV_HOST` here: that is the direct-clamd path, and it is for a
laptop running `docker compose up -d clamd`, where there is no untrusted network
in between.

Without any of them, sign-in, the case list and the review route all work.

Transaction-mode pooling is safe here for a specific reason: every setting the
store touches is transaction-local (`set local role`, `set_config(..., true)`),
so a pooled connection cannot carry one tenant's claims into another tenant's
query.

### Where the read runs

An upload stores and scans the file in the request and then either reads it
there and then or hands the read to an Inngest job. Which one is these two
variables' answer, and nothing else's (ADR 0021):

| Variable | Why |
| --- | --- |
| `INNGEST_EVENT_KEY` | Lets the app send `document/read.requested`. Without it there is no job to send to |
| `INNGEST_SIGNING_KEY` | Lets `/api/inngest` verify that a call to run a job really came from Inngest. It is that endpoint's whole authentication |

Set **both** or **neither**. One without the other is an error at startup rather
than a fallback: an event key with no signing key serves an endpoint that cannot
tell Inngest from anybody else, and a signing key with no event key serves a
function nothing can trigger.

The recommended way to set them is the **Inngest Vercel integration**
(Vercel → Integrations → Inngest): it creates the keys, writes both variables to
the project, and syncs the app on every deployment, so `/api/inngest` is
registered without anyone pasting a URL. Doing it by hand works too — take the
keys from the Inngest dashboard, set them here, and point Inngest at
`https://<origin>/api/inngest`.

**Without them the app runs the read inline**, exactly as it did before, and
`/api/inngest` answers 503 because there is no binding to serve. That is the
right setting for a preview deployment and for a laptop. It is the wrong one for
production: a dense remittance is about 63 seconds of model time, more than a
serverless request should be holding open, which is the whole reason for the
job.

Locally, `npx inngest-cli@latest dev` runs the dev server and its UI on
`http://localhost:8288` and discovers the app at
`http://localhost:3000/api/inngest`. Set both variables to anything non-empty —
the dev server does not check them — and `INNGEST_DEV=1` so the SDK talks to it
instead of to Inngest Cloud.

Never set `INNGEST_DEV` on a deployment. It puts the SDK in dev mode, where the
signing key is not checked — which is what a laptop's dev server needs and the
opposite of what an endpoint on the public internet needs. A production build
that has it set refuses to serve `/api/inngest` at all: 503, with the reason in
the log. Uploads still store, scan and queue; nothing reads them until the
variable is unset. A visible stop is the right failure here — the alternative is
an endpoint on the public internet accepting unsigned work.

### Email-in: Production only

Suppliers email documents to `<token>@<INBOUND_DOMAIN>`; Postmark receives them
and posts each one to `/api/inbound/postmark` (ADR 0047). Both variables go on
**Production only** — never Preview — so Postmark's single webhook URL can only
reach production:

| Variable | Why |
| --- | --- |
| `POSTMARK_INBOUND_SECRET` | The password in the webhook URL Postmark is given, `https://postmark:<secret>@app.mozart.financial/api/inbound/postmark`. Postmark signs nothing, so this is the webhook's whole authentication, and it reaches every tenant. `openssl rand -hex 32`; under 64 characters is refused |
| `INBOUND_DOMAIN` | The subdomain whose MX points at `inbound.postmarkapp.com` (priority 10), used for nothing else. Production's is `in.mozart.financial`, its MX at Porkbun (the domain's DNS host). An email to any other domain is refused |

Set both or neither. With neither, the route answers 503 and logs nothing — what
a preview answers. One without the other, a short secret, no Inngest keys (an
email's read must not run inside Postmark's two-minute wait) or no scanner is a
misconfiguration: 503, logged with the reason, and Postmark retries for about
ten hours while it is fixed. `POSTMARK_SERVER_TOKEN` is **not** set here: it
reads every tenant's mail and can repoint the webhook, so it stays in the
operator's own `.env` for `pnpm sweep:inbound`.

After the next production deploy, an owner issues an address under
**Settings → Email**. To rotate the secret: set the new value here, redeploy,
update the URL in Postmark, and watch the 401s stop — Postmark retries the mail
that met the old one. The founder's full setup is ADR 0047's "What the founder
does"; the click-through is `docs/VERIFY-CHECKLIST.md` §5.

### Failure alerts: Production only

When one of the four background jobs fails after its retries, the app emails
one person (ADR 0052). The email goes through Resend with a key that can only
send. All three variables go on **Production only**, never Preview:

| Variable | Why |
| --- | --- |
| `ALERT_EMAIL_TO` | The one address alerts go to. A single bare address |
| `ALERT_EMAIL_FROM` | The sender. It must be on the domain the key is restricted to, the one Supabase's sign-in mail already uses |
| `RESEND_API_KEY` | A Resend key with **Sending access** only, restricted to that domain. It can send mail and do nothing else |

Set all three or none:

- **None:** there are no alerts. A failure logs `alerts are not configured`,
  and the alert's run output says `not_configured`. The rate limit still
  applies, so later failures of the same job within the hour log nothing.
  Count failures in the Inngest dashboard, not from these lines.
- **Some, or an address that is not one address:** logged as an error naming
  the variable, and nothing is sent.

To prove it works, send `recouple/alert.test` from the Inngest dashboard
(`docs/VERIFY-CHECKLIST.md` §10).

## Supabase, after the first deploy

Add the deployment origin to **Authentication → URL Configuration**:

- **Site URL**: the deployment origin
- **Redirect URLs**: `<origin>/auth/callback`

Without it, Supabase ignores the app's `emailRedirectTo` and falls back to the
Site URL, so the magic link lands somewhere that cannot complete the sign-in.

## Who can sign in

Only an address that already has a `users` row and a `memberships` row.
`app.link_auth_user()` refuses anyone else, because a verified email is not an
entitlement (ADR 0015). An identity it refuses, or one with no membership left,
is signed out at the provider rather than kept with a live cookie (ADR 0045).

The login form creates no Supabase Auth user (`shouldCreateUser: false`, ADR
0045), so inviting someone takes three steps. For a new customer, follow
[`docs/ONBOARDING.md`](../../docs/ONBOARDING.md), which does step 1 for a whole
workspace in one tested SQL block and has the welcome email for step 3.

1. Insert their `users` row and a `memberships` row for their tenant, as the
   owner.
2. In the Supabase dashboard: **Authentication → Users → Add user → Send
   invitation**, with the same address. This creates the auth user and emails
   the invitation.
3. They follow the invitation link once, which confirms the address, then sign
   in from the login form. The invitation link does not sign them in by itself.
   It lands on the Site URL with the session in the URL fragment, and the app
   only takes a session from `/auth/callback`.

Skip step 2 and the form still says a link is on its way. It says that for
every address, so it cannot be used to find out who has an account. The app's
log records `otp_disabled` instead. With "Allow new users to sign up" switched
off (recommended, the founder's switch, docs/supabase.md), someone who has not
yet followed their invitation gets `signup_disabled` in the log and no mail.
Re-send the invitation.
