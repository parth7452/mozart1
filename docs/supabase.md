# Supabase

The schema is deployed to a live Supabase project and every invariant was
verified there, not only against local Postgres.

| | |
| --- | --- |
| Project ref | `hvheqbgkvwhlqutklwfh` |
| Region | `us-east-1` |
| Postgres | 17.6 (local tests run on 16 — see below) |
| Applied | migrations 0001–0029, as named migrations matching the filenames in `supabase/migrations/` (CLAUDE.md, "Current state", records each apply) |

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

### The Data API reaches nothing (ADR 0037)

Supabase puts three request roles behind its Data API — `anon` (the
publishable key), `authenticated` (a signed-in user's token) and
`service_role` (the service-role key) — and its default privileges grant them
everything created in `public`. Nothing here reads through that API: the app
signs people in with Supabase Auth and reads through `DATABASE_URL` as
`recouple_app` → `app_rw` (ADR 0015). Migration 0028 therefore revokes every
privilege the three hold on tables, views, sequences and routines in `public`
and `app`, the default privileges that would give them the next table, and
migration 0006's `grant app_rw to authenticated`. USAGE on schema `public` is
left alone; with nothing in it granted, it grants nothing.

The consequence to know about: `set role app_rw` works only for a role that
holds `app_rw` directly, as `recouple_app` does. A role that reached it through
`authenticated` — `authenticator`, which PostgREST logs in as, and possibly
`postgres` in the SQL editor — no longer can. That is the point for
`authenticator`. For `postgres` it is accepted (ADR 0037, Consequences); giving
it a direct membership is a separate decision.

Apply 0028 as **`postgres`**, the role that owns the schema's objects and
whose default privileges it cleans (`select current_user` in the same
channel). It aborts rather than warns if anything survives, and it aborts if
`recouple_app` would lose `set role app_rw`.

**Before applying 0028** — read-only, in the SQL editor:

```sql
-- 1. Every role that can reach an app role, and by what path. recouple_app's
--    row must read `recouple_app → app_rw` with can_set_role true; a row that
--    passes through authenticated is what 0028 removes.
with recursive paths as (
  select am.member, am.roleid, am.set_option, am.inherit_option,
         array[pg_get_userbyid(am.member)::text, pg_get_userbyid(am.roleid)::text] as path
    from pg_auth_members am
   where am.roleid in ('app_rw'::regrole, 'app_ro'::regrole)
  union all
  select am.member, p.roleid, am.set_option and p.set_option,
         am.inherit_option and p.inherit_option,
         pg_get_userbyid(am.member)::text || p.path
    from pg_auth_members am
    join paths p on am.roleid = p.member
   where not (pg_get_userbyid(am.member)::text = any (p.path))
)
select pg_get_userbyid(roleid) as app_role, array_to_string(path, ' → ') as path,
       set_option as can_set_role, inherit_option as inherits
  from paths
 order by 1, 2;

-- 2. What the request roles hold — the list 0028 revokes. Save the output with
--    the PR: re-issuing these grants is the rollback, and the only record of
--    them once they are gone.
select 'relation' as kind, c.oid::regclass::text as object,
       pg_get_userbyid(a.grantee) as grantee, a.privilege_type as privilege
  from pg_class c cross join lateral aclexplode(c.relacl) a
 where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace)
   and pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role')
union all
select 'routine', p.oid::regprocedure::text, pg_get_userbyid(a.grantee), a.privilege_type
  from pg_proc p cross join lateral aclexplode(p.proacl) a
 where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
   and pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role')
union all
select 'schema', n.nspname, pg_get_userbyid(a.grantee), a.privilege_type
  from pg_namespace n cross join lateral aclexplode(n.nspacl) a
 where pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role')
   and (n.nspname = 'app' or (n.nspname = 'public' and a.privilege_type = 'CREATE'))
union all
select 'default ' || d.defaclobjtype::text,
       pg_get_userbyid(d.defaclrole) || ' in '
         || coalesce(nullif(d.defaclnamespace, 0)::regnamespace::text, 'every schema'),
       pg_get_userbyid(a.grantee), a.privilege_type
  from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
 where pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role')
   -- The schemas 0028 cleans: public, app and every-schema rows. Supabase's own
   -- defaults in storage, graphql and graphql_public are not ours and stay.
   and d.defaclnamespace in (0::oid, 'public'::regnamespace::oid, 'app'::regnamespace::oid)
union all
select 'membership', pg_get_userbyid(am.roleid), pg_get_userbyid(am.member),
       format('inherit %s, set %s, granted by %s',
              am.inherit_option, am.set_option, pg_get_userbyid(am.grantor))
  from pg_auth_members am
 where am.roleid in ('app_rw'::regrole, 'app_ro'::regrole)
   and pg_get_userbyid(am.member) in ('anon', 'authenticated', 'service_role')
 order by 1, 2, 3, 4;

-- 3. Who owns what is in public. Anything not owned by postgres is something
--    0028, applied as postgres, may be unable to revoke — and will say so.
select c.oid::regclass as object, c.relkind, pg_get_userbyid(c.relowner) as owner
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
   and pg_get_userbyid(c.relowner) <> 'postgres';
```

**After applying 0028:** query 2 returns no rows, except default-privilege rows
for a role 0028 reported (in a NOTICE) that it could not act as —
`supabase_admin` is the expected one, and nothing here is created as it. Rerun
the Security Advisor. Then sign in with a magic link, open a case, and have the
second member do the same.

This is what the preview project (`jvbnqofmoamyhntjwjdn`) returned when 0028
and 0029 were staged there first on 2026-09-23: only `supabase_admin in public`
default-privilege rows (one per privilege, for tables, sequences and functions,
for each request role) and nothing else; zero
security lints; `recouple_app` still able to `set role` to both app roles. The
Supabase MCP connector and the SQL editor connect as `postgres`, which there
held `app_rw` only through `authenticated`, so after 0028 they can no longer
`set role app_rw` — ADR 0037's accepted cost. Read-only checks as `postgres`
are unaffected.

**The Data API switch comes last.** Production's has been off since
2026-09-23, after all three conditions below held. Turning off the Data API
(Project Settings → Data API) is a second lock that no migration can set. It is the founder's to
flip, and only after 0028 is applied, the scheduled ledger sync has run once
since, and both members have signed in — so anything that did depend on a
revoked grant has shown itself while 0028 is the only change. Auth keeps
working; Studio's table and SQL editors keep working (they connect as
`postgres`); Studio's "impersonate role: authenticated" view shows permission
denied, which is correct.

`pnpm db:test` reproduces all of this locally: `supabase/tests/_supabase_shape.sql`
creates the four Supabase roles and their default privileges before the
migrations run, and suite 24 reads the end state back.

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
