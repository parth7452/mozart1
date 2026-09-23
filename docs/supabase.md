# Supabase

The schema is deployed to a live Supabase project and every invariant was
verified there, not only against local Postgres.

| | |
| --- | --- |
| Project ref | `hvheqbgkvwhlqutklwfh` |
| Region | `us-east-1` |
| Postgres | 17.6 (local tests run on 16 — see below) |
| Applied | migrations 0001–0011, as named migrations matching the filenames in `supabase/migrations/` |

## What was verified on the live project

A transaction that seeds a tenant, asserts each invariant and then aborts, so
the project keeps nothing. It raises unless every check passes.

The first pass, after 0007, covered ten:

1. A submission with no approval row is refused
2. A QBO write-back with no approval row is refused
3. The analyst who prepared a decision cannot approve it
4. With a real approver's row, the submission goes through
5. `deduction_events` hash-chains on insert
6. An UPDATE on an append-only table is refused **even for the table owner**
7. Raising an auto-dispute ceiling is refused without a named ADR
8. Tightening one is allowed
9. An extraction with page, quote and bounding box is stored
10. An extraction with no quote is refused

The second pass, after 0010 and 0011, covered fifteen more — and this time
**as `app_rw` throughout**, which is what found the bug below: a submission
cannot be repointed at an unapproved decision or an approved one, its channel
and deduction are immutable, it cannot be deleted, a confirmation number can
still be recorded, a write-off cannot be inflated after approval, a `read_only`
member can read but cannot open, advance, delete or annotate a case, and an
analyst still can.

Structural check afterwards: 22 tables with RLS enabled, 82 policies (four per
command on the twenty org-scoped tables, plus a read policy each for
`organizations` and `users`), and no rows left behind.

### The bug that only a live check could find

Verifying 0010 as `app_rw` rather than as the owner, every hash-chained write
failed:

```
insert into deduction_events … → function digest(bytea, unknown) does not exist
```

pgcrypto lives in `public` on local Postgres and in `extensions` on Supabase.
0008 pinned the function search paths to `pg_catalog, public, extensions` so one
setting would serve both — but a schema in the search path is still invisible
without USAGE on it, and the app roles had none on `extensions`. So on the live
project the application could not append an event at all, while the local suite
passed: `public` is a schema every role may use.

Migration 0011 grants it, reading pgcrypto's schema from the catalogue so the
grant is right on either Postgres. Suite 08 asserts the privilege, which is the
form of the invariant that travels; the behavioural half of that suite passes
locally either way, which is exactly why the live run was necessary. Running the
invariants as the owner is not running them.

## Two Postgres versions on purpose

Local and CI run Postgres 16; Supabase runs 17. The migrations are written to
work on both — nothing depends on `auth.jwt()` or any other Supabase-only
function. `app.current_org_id()` reads the same `request.jwt.claims` GUC that
Supabase Auth populates and that `set_config()` sets in the test suite, which is
why the RLS policies could be tested before auth existed.

Keep running `pnpm db:test` against local Postgres — it is faster and it proves
the migrations stay portable.

## Connecting the app

`apps/web` needs three values, and deliberately not a fourth:

```
NEXT_PUBLIC_SUPABASE_URL=https://hvheqbgkvwhlqutklwfh.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
DATABASE_URL=postgres://…                # a role that may `set role app_rw`
```

The publishable key is designed to be public and is used for one thing:
`supabase.auth.getUser()`, which says who is asking. Everything else goes through
`PostgresStore` as `app_rw` with the tenant's claims set transaction-locally
(ADR 0015).

**There is no `SUPABASE_SERVICE_ROLE_KEY` here.** The service-role key bypasses
RLS; it belongs in background jobs and nowhere near a request path. That is
invariant 6, and it is the one invariant the database cannot enforce for us, so
the way to keep it is to never need the key.

### The connecting role

`DATABASE_URL` must name a login role that can `set role app_rw` — not the
postgres superuser in production. On Supabase, create one and grant it the
membership:

```sql
create role recouple_app login noinherit password '…';
grant app_rw to recouple_app with inherit false, set true;
grant app_ro to recouple_app with inherit false, set true;
```

`noinherit` and `inherit false` are the point, and production is set up this
way. The login holds no privilege of its own and inherits none: it cannot read a
table, or even use schema `app`, until it says `set role`. So the app never runs
*as* that role: every unit of work opens a transaction, does
`set local role app_rw`, and sets the claims. The login role is a door, not a
permission set. A plain `grant app_rw to recouple_app` would inherit `app_rw`'s
privileges outright, and code that forgot to switch role would work locally and
nowhere else.

### How the operator commands connect

`pnpm link:retailer`, `pnpm link:provenance` and `pnpm link:qbo` use the same
`DATABASE_URL` as the app, which means the same login and never the owner
(ADR 0034). Each takes `--org <slug>` and `--as <member email>`, and has to turn
them into ids before it can act as that member. It cannot do that under RLS,
because the policies on `organizations` and `users` key on the org id it is
trying to learn. So it does exactly one thing outside them:

1. In one transaction, `set local role app_rw` with no claims, and call
   `app.member_for_link(slug, email)`. That definer function returns the org id,
   the user id and the role, and nothing else. It refuses any caller that
   carries a claim, so no request path can use it.
2. Refuse a `read_only` member.
3. Do everything else through `PostgresStore`, as `app_rw` with that member's
   claims, like the app.

Running one of them against the owner login is not needed and not supported.
`packages/store-postgres/test/operator-login.test.ts` creates a login shaped
like `recouple_app` and runs each command as it.

### Auth settings to check in the dashboard

- **Site URL and redirect URLs** must include the app's `/auth/callback`, or the
  magic link comes back to the wrong place.
- **Email confirmations** are what a magic link is; the built-in SMTP is
  rate-limited and fine for a handful of testers, not for customers.
- A person can only sign in if they were invited: a `users` row with their
  address and a `memberships` row for their tenant. Seed those as the owner —
  `app.link_auth_user()` refuses an address with no invitation, on purpose.

## Preview deployments have their own project

A Vercel preview is code nobody has merged, so it gets a Supabase project of its
own: **`mozart-preview`** (`jvbnqofmoamyhntjwjdn`, free tier, us-east-1), with
its own Auth and its own database. Until 2026-09-23 previews shared production's
`DATABASE_URL` and Inngest keys, and at 07:00 UTC that day the daily ledger sync
ran on PR #42's preview and wrote its run row into production. Inngest's
integration re-registers the app on every deployment, so whichever build was
deployed last received production's jobs.

What each environment gets on Vercel:

| Variable | Production | Preview |
| --- | --- | --- |
| `DATABASE_URL` | production, as `recouple_app` | `mozart-preview`, as its own `recouple_app` (same `noinherit` shape), transaction pooler, `sslmode=no-verify` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production | `mozart-preview` |
| `NEXT_PUBLIC_SITE_URL` | set | **unset**: a preview derives its branch URL (`apps/web/lib/env.ts`), so a magic link returns to that preview rather than to production |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | set | **none**: a preview's `/api/inngest` answers 503, so the sync Inngest attempts on each preview deploy is refused and production stays registered. Previews read inline |
| `ANTHROPIC_API_KEY`, `REDUCTO_API_KEY` | set | none: an upload on a preview is stored and scanned but not read. Add them to Preview deliberately if a preview needs to read, knowing it spends money |
| `QBO_*`, `QBO_TOKEN_KMS_KEY_ID`, `AWS_*` | set | never |
| `CLAMAV_SCAN_URL`, `CLAMAV_SCAN_TOKEN` | shared | shared (the scanner keeps nothing) |

`sslmode=no-verify` is there because this driver treats `require` as
`verify-full`, and the pooler's certificate is not signed by a public CA: the
connection is encrypted, the certificate is not checked. Acceptable for a
database of synthetic data; production's connection is its own decision.

The preview database carries every migration, applied through the Supabase
connector (so its recorded versions are apply times, not the filenames'
timestamps). A schema fingerprint compared it with production object by object
on 2026-09-23 — tables, constraints, indexes, policies, triggers, grants, views
and function logic identical; only comment text differs. **New migrations go
here first, then to production**: 0028 and 0029 were staged here before
production and read back as ADR 0037 and ADR 0038 claim.

It is seeded with one org, `recouple-preview` ("Recouple (preview)"), and the
same two members as production (owner and approver), so both can sign in to a
preview by magic link; Auth's redirect allow list holds
`https://*-parth7452s-projects.vercel.app/**`. A free project pauses after a
week without activity; unpause it from the dashboard.

## Sharing a project with Mozart

This project was empty, so recouple uses it rather than spending a second
project slot. If Mozart ever needs Supabase too, recouple should move to its own
project: ADR 0002 keeps these codebases separate, and sharing a database would
undo that. Moving is re-running the same migrations against a new ref.
