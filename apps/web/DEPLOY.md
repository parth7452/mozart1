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
Do not set `CLAMAV_HOST` here: that is the direct-clamd path, and it is for a
laptop running `docker compose up -d clamd`, where there is no untrusted network
in between.

Without any of them, sign-in, the case list and the review route all work.

Transaction-mode pooling is safe here for a specific reason: every setting the
store touches is transaction-local (`set local role`, `set_config(..., true)`),
so a pooled connection cannot carry one tenant's claims into another tenant's
query.

## Supabase, after the first deploy

Add the deployment origin to **Authentication → URL Configuration**:

- **Site URL**: the deployment origin
- **Redirect URLs**: `<origin>/auth/callback`

Without it, Supabase ignores the app's `emailRedirectTo` and falls back to the
Site URL, so the magic link lands somewhere that cannot complete the sign-in.

## Who can sign in

Only an address that already has a `users` row and a `memberships` row.
`app.link_auth_user()` refuses anyone else — a verified email is not an
entitlement (ADR 0012). Invite someone by inserting those two rows.
