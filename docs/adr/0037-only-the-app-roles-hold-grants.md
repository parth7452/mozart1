# 0037 — Only the app roles hold grants, and invariant 7's guard is pinned again

- Status: accepted
- Date: 2026-09-22

## Context

Two things in the schema are not what the ADRs say they are.

**Invariant 7's guard resolves names through its caller's search path.**
Migration 0008 pinned every `app.*` function to
`search_path = pg_catalog, public, extensions` (ADR 0010), because an unpinned
function lets whoever calls it decide what the unqualified names in its body
mean. Migration 0022 then replaced `app.guard_threshold_direction()` — the
trigger behind invariant 7 — with `create or replace` and no `set` clause, and
`create or replace` assigns every property from the command that runs it. The
pin went with the old body. Read back from the catalogue after every migration
on a scratch database, it is the only function in `app` with no `proconfig`.
It is not the first near-miss. 0010 had to pin `guard_immutable_core` and
`member_may_write` by hand because they arrived after 0008's loop had run, and
when 0017 replaced `guard_immutable_core` it restated the pin in its own
definition — which is why suite 12 asks about that one function. A suite that
asks about one function at a time asks about the one somebody remembered.

**Supabase's request roles hold grants nothing here uses.** On Supabase, three
roles stand behind the Data API (PostgREST at `/rest/v1`, and pg_graphql):
`anon` for the publishable key, `authenticated` for a signed-in user's token,
`service_role` for the service-role key. `authenticator` is the login PostgREST
connects as; it holds each of the three and `set role`s to whichever one a
JWT's `role` claim names. The shape, as the catalogue reports it:

| Role | Attributes | Memberships |
| --- | --- | --- |
| `anon` | nologin noinherit | — |
| `authenticated` | nologin noinherit | holds `app_rw`, **inherit true, set true** (migration 0006) |
| `service_role` | nologin noinherit bypassrls | — |
| `authenticator` | login noinherit | holds all three |

Supabase's default privileges grant the three ALL on every table, sequence and
function created in `public`. Migration 0006 revoked it from `anon` once —
`revoke all on all tables in schema public from anon` — which is a snapshot of
the tables that existed that day; every table created since is created under
the same defaults. And 0006 granted `app_rw` to `authenticated` on purpose,
reasoning that "on Supabase the request role is `authenticated`". Exactly which
grants production holds today is what the pre-apply snapshot query in
docs/supabase.md lists; what follows is what those defaults and that membership
give, which is what 0028 is written against.

It is not, and has not been since ADR 0015. Evidence gathered from production
on 2026-09-22:

- **No code reads data through supabase-js.** `@supabase/*` is imported in two
  files, `apps/web/proxy.ts` and `apps/web/lib/supabase.ts`, both with the
  publishable key and both for Auth only. There are no edge functions.
- **Every database path logs in as `recouple_app`**, whose memberships in
  `app_rw` and `app_ro` are direct (`inherit_option false`,
  `set_option true`) — the shape docs/supabase.md prescribes — and do not pass
  through `authenticated`.
- **Nothing calls the Data API.** The edge logs for the last 24 hours show
  `/auth/v1` traffic and Supabase's own health checks, and not one `/rest/v1`
  table read.
- **`authenticated` holds `app_rw` with inherit true and set true.**
- **Sign-ups are open.** A signup verification appears in the auth logs, and
  the login page calls `signInWithOtp` without `shouldCreateUser: false`. Anyone
  can obtain an `authenticated` token, so for this question `authenticated` is
  the public internet.

What that reach amounts to today, stated at its actual size:

- **Rows: none, by RLS, for `anon` and `authenticated`.** Every policy keys on
  `app.current_org_id()`, which reads a top-level `org_id` claim. A Supabase
  Auth token carries none and a user cannot set one (`user_metadata` is
  nested), so every read through the Data API returns no rows and every write
  fails its `with check`.
- **`service_role` is not held back by RLS at all.** It has BYPASSRLS, and the
  defaults give it ALL on the tables in `public`. The service-role key is not
  used anywhere in this codebase (invariant 6, ADR 0015), but whoever holds it
  can read every tenant's rows through the Data API, and the defaults give it
  UPDATE, DELETE and TRUNCATE on the append-only tables — invariant 2 says no
  role may hold those grants; the triggers are what refuse them.
- **The JWT secret is a key to the application role.** `authenticator` can
  `set role authenticated`, and `authenticated` can `set role app_rw`, so
  PostgREST will switch to `app_rw` for any validly signed token whose `role`
  claim says `app_rw` — with whatever `org_id` claim the token also carries.
  Holding the JWT secret therefore meant reading any tenant *as the
  application*, through policies that trust exactly that claim.
- **`authenticated` inherits `app_rw`**, because production's membership row
  says inherit true: USAGE on schema `app` and EXECUTE on the definer functions
  in it. Two of those answer a caller that has a `sub` and no `org_id` — the
  exact shape of a Data API request — beyond its own tenant:
  `app.ledger_connections_to_sync()` refuses only a caller *with* an `org_id`,
  and `app.link_auth_user(auth_id, claimed_email)` takes the identity as an
  argument. Neither is reachable while `app` is not an exposed schema, which is
  a dashboard setting no migration can see.
- **TRUNCATE, REFERENCES and TRIGGER are not bounded by RLS**, and ALL
  includes them. None of them can be expressed through the Data API, and none
  of the three roles can log in; `authenticator` can, with a password only
  Supabase holds.

None of this has been exploited or is exploitable without a secret we do not
hold or a setting nobody has changed. It is still a set of doors that are
closed by conditions rather than by grants, and the one that matters most — the
JWT secret opening `app_rw` — exists only because of a grant made for a design
that ADR 0015 replaced.

## Decision

Migration 0028. Every statement is a REVOKE, an `alter function … set`, or an
`alter default privileges … revoke`, and each is a no-op the second time.
Nothing is granted to anyone.

### 1. The guard is pinned again, by `alter function`

```sql
alter function app.guard_threshold_direction()
  set search_path = pg_catalog, public, extensions;
```

Not a third `create or replace` of invariant 7's body, which would be one more
copy to drift from when one property needs to change. The body, trigger and
comment are untouched.

### 2. The three request roles lose every privilege on our objects

For whichever of `anon`, `authenticated` and `service_role` exist: all
privileges on every table, view, sequence and routine in `public` and in `app`,
CREATE on `public`, and everything on schema `app`. `service_role` is included
— the founder's decision (Yes to "should service_role lose its grants too").
Nothing here uses the service-role key, and a key that reaches nothing is a key
whose leak costs nothing.

USAGE on schema `public` is left alone. With no privilege on any object in it,
it grants nothing but the ability to be told "permission denied" for a named
object rather than for the schema, and changing it would reach into how
Supabase's own tooling introspects the database for no gain here.

PUBLIC's own grants are left alone too. Several `app.*` functions keep the
EXECUTE that Postgres gives PUBLIC by default (`app.jwt()`,
`app.current_org_id()`, the trigger functions); what fences them is USAGE on
schema `app`, which only `app_rw` and `app_ro` hold. That is why suite 24 asks,
of each request role, that it cannot use schema `app` — the question that
matters for those functions — rather than whether it can execute them.

### 3. …and do not get them back with the next table

Every `pg_default_acl` row for `public`, `app` or every schema (the global
row), for tables, sequences or functions, whose ACL names one of the three, is
revoked with `alter default privileges for role <its role> … revoke all … from`
the three. A global row is included because a per-schema revoke cannot remove
what a global row grants.

A role whose default privileges the migrating role may not change — on
Supabase, `supabase_admin` when the migration runs as `postgres` — is skipped
with a NOTICE naming it rather than failing the migration. Nothing in this
schema is created as `supabase_admin`, so its defaults never touch our objects;
suite 24's enumeration of the objects themselves, and the post-apply grants
query in docs/supabase.md, are what would say otherwise.

### 4. `authenticated` stops being a member of `app_rw`

Every `pg_auth_members` row making one of the three a member of `app_rw` or
`app_ro` is revoked, `granted by` the grantor the catalogue recorded, so a
grant made under another role is found rather than reported with a warning.
This is the grant 0006 made. Nothing depends on it — the evidence above — and
it is the grant behind both the JWT-secret path and `authenticated`'s reach
into `app`.

### 5. The migration checks its own work and aborts rather than warns

REVOKE by a role that is not the grantor, on Supabase, is a WARNING and
nothing else. So after revoking, the migration re-reads the catalogue — every
ACL entry on a relation, column, routine or schema in `public` and `app` that
still names one of the three, any membership in `app_rw` or `app_ro` by any
path, and any default-privilege row it did not have to skip — and raises an
exception naming what survived. The revokes are one statement, so the grants
half is all or nothing.

**The lock-out tripwire watches the application's logins, and only those.**
Before revoking, it records which logins can `set role app_rw` (and `app_ro`)
and are either named `recouple_app` or hold a *direct* membership with SET.
Afterwards each must still be able to; if one cannot, the migration aborts and
says that the application's login is meant to hold `app_rw` directly —
`grant app_rw to recouple_app with inherit false, set true`, as
docs/supabase.md prescribes. It deliberately does not watch every login with
SET: `authenticator` has SET on `app_rw` today through `authenticated`, and
losing it is the point. A tripwire that watched it would fire on every apply,
and a message telling the operator to grant `app_rw` back to whichever role
tripped would reopen the hole this closes. In production the watched set is
`recouple_app`, whose memberships are direct, so it holds.

`db:test` applies 0028 on every run but has no `recouple_app`, so it can never
reach the refusal. `packages/store-postgres/test/only-the-app-roles-hold-grants.test.ts`
does: inside a transaction it rolls back, it builds a `recouple_app` that
reaches `app_rw` only through `authenticated`, applies 0028's own text, and
expects the refusal, its hint, and the membership still in place afterwards;
then it builds one with the direct grant and expects the migration to go
through, `recouple_app` to keep its door and `authenticator` to lose its own.

### 6. CI reproduces the platform it is protecting

`postgres:16` has none of Supabase's roles, so 0006's `grant app_rw to
authenticated` has never run in CI and 0028 would pass there by having nothing
to revoke. `scripts/db-test.sh` now runs `supabase/tests/_supabase_shape.sql`
once, before the migrations: it creates the four roles with the attributes and
memberships in the table above (only where absent) and gives the three request
roles ALL on new objects in `public` by default. Every migration then builds the
production pathology — 0006 grants the membership, every table is born with the
grants — and 0028 has to repair it, on both passes.

One difference is known and does not matter. On Postgres 16 a GRANT's inherit
option defaults to the member's `rolinherit`, so 0006's grant to a NOINHERIT
`authenticated` gets inherit false in CI where production's row says true.
0028 removes the row whatever its options, and suite 24 asks about membership by
any path, so both answer the same question.

### 7. Suite 24 asks the catalogue, not a list

Modelled on suite 15. It enumerates rather than names:

- every function in `app` pins its search path, and invariant 7's guard still
  refuses a loosening when the caller has put a schema with its own
  `array_length(text[], integer)` ahead of `pg_catalog`;
- every view in `public` is `security_invoker`;
- every function in `public` belongs to an extension;
- the app roles can create nothing — no schema, and nothing in any schema;
- the three request roles hold no privilege on any table, view, sequence or
  column in `public` or `app`, and no ACL entry on any routine or schema there;
- none of them is a member of either app role, none can use schema `app`, and
  `authenticator` cannot `set role` to either;
- a login shaped like `recouple_app` still can, and a login that reaches the
  app roles only through `authenticated` cannot;
- no default-privilege row names them, and a table, sequence and function
  created inside the suite give them nothing;
- **invariant 2's grant half, for every role:** for each table with an
  `app.block_mutations()` trigger, the privileges its triggers' events refuse
  (decoded from `tgtype`: DELETE 8, UPDATE 16, TRUNCATE 32) are held by no role
  but a superuser, the owner and the predefined `pg_*` roles. Derived rather
  than assumed, because submissions, writebacks and writeoffs refuse only
  DELETE and TRUNCATE and `app_rw` updates their lifecycle columns on purpose.

### 8. The Data API switch is the founder's, and comes after

Turning off Supabase's Data API (Project Settings → Data API) would be a second,
independent lock: if a later migration forgot a revoke, or someone exposed the
`app` schema, nothing would become reachable. It is a dashboard setting, not
code, and it is the founder's to flip. It happens **only after** 0028 is
applied in production, the scheduled ledger sync has run afterwards, and both
members have signed in and opened a case — so that anything that did depend on
a revoked grant has shown itself while the change that caused it is the only
change. Auth (magic links) is a separate service and keeps working. Studio's
table editor and SQL editor connect as `postgres` and keep working; Studio's
"impersonate role: authenticated" view will show permission denied, which is
this decision working.

## Consequences

**What this makes true by construction.** ADR 0015's "PostgREST is unavailable
to this app by construction" was true by convention; it is now true by grants.
A leaked service-role key or publishable key reaches nothing in `public`; a
leaked JWT secret can no longer mint the application role. Invariant 2's "no
UPDATE/DELETE grant on an append-only table" holds for every role rather than
for `app_rw`, and suite 24 fails the day it stops. Every future
`create or replace` of an `app.*` function that forgets `set search_path` fails
CI and names the function.

**What it costs.** Anyone who later wants the Data API gets "permission
denied". That is intended: the way back is a superseding ADR with per-object
grants, never a revert. A server-side job that one day wants the service-role
key through the Data API fails loudly and needs the same ADR. Invariant 6's
sentence in CLAUDE.md stays as written — it is a rule about where the key may be
used, and it is still the rule; what changes is that there is nothing left for
the key to use even where the rule allows it.

`db:test` now creates four roles — three NOLOGIN, and `authenticator`, a LOGIN
role with no password — in whatever cluster `DATABASE_URL` points at, as
migration 0001 already does for the app roles. Roles and their memberships are
cluster-wide, so two `db:test` runs against two databases in one cluster share
them: a run of a branch without 0028 re-grants `app_rw` to `authenticated` for
the whole cluster until 0028 runs again. CI has a cluster per job; a shared
development cluster is where this can make suite 24 fail for a reason that is
not in the branch under test.

**The operator's own verification channel may change.** The Supabase SQL editor
and the MCP `execute_sql` channel connect as `postgres`. If `postgres` can
`set role app_rw` today only through `authenticated`, it cannot after 0028, and
the "verify as `app_rw`" read-backs earlier migrations used will need another
route. That is accepted rather than patched here: the route is the hole. The
pre-apply query in docs/supabase.md lists every role that can reach `app_rw`
and the path it takes, so this is known before the apply rather than found
after it. If `postgres` turns out to need a direct membership, that is one
`grant app_rw to postgres with inherit false, set true`, and it is a separate,
reviewed decision rather than something bundled into a migration whose every
statement is a revoke.

**Comments that are now wrong and cannot be fixed.** Migration 0006's "let
[authenticated] inherit exactly the app_rw privilege set" and migration 0024's
"`authenticated` is a member of `app_rw` (migration 0006)" are in merged
migrations and stay as written. The same reasoning in suite 20 and in
`ledger-connections.test.ts` is corrected in place (comments only; the
assertions stand, and the guard they test is still right as defence in depth).
On pass 2 of `db:test`, 0006 grants the membership again and 0022 unpins the
guard again, and 0028 repairs both again — which is the proof that the repair
holds whatever ran before it.

**Not closed here, and named so it is not forgotten:**

*(Status, 2026-09-23: all four are closed. The first two by
[ADR 0045](./0045-sign-in-and-the-fan-out-refuse-callers-they-were-not-written-for.md),
the third in CLAUDE.md, the fourth by the apply. The items are kept as they
were written.)*

- Sign-ups are open. Closing them means invitations create auth users first.
  **Closed by ADR 0045 §1 and §4**: the login form sends
  `shouldCreateUser: false`, and an invitation creates the auth user from the
  dashboard.
- `app.ledger_connections_to_sync()` refuses a caller with an `org_id` but not
  one with a `sub`. After 0028 no request role can reach it; refusing a `sub`
  too, as `app.member_for_link` does, is defence in depth and a function-body
  change with its own `set search_path`. **Closed by ADR 0045 §3** (migration
  0033), which also gives `app.link_auth_user()` the same guard.
- CLAUDE.md says `app.link_auth_user()` takes the identity "from the claims
  rather than an argument". It takes `auth_id` as an argument
  (`packages/store-postgres/src/session.ts` passes the verified one).
  **Closed**: CLAUDE.md now says it takes the subject and email as arguments.
- Production does not carry 0028. Until it is applied, the Context above is
  still production's state. Migrations are applied in order, so no later table
  can reach production ahead of it. **Closed**: production carries 0028 since
  2026-09-23, and the Data API has been off since the same afternoon.

## Invariants touched

- **1 (approval gate).** Untouched. No trigger, table or grant on the gated
  tables is added; only the request roles' grants are removed from them.
- **2 (append-only).** Strengthened: no role but the owner holds a privilege an
  append-only trigger refuses. Enforced by the triggers as before, and now by
  suite 24's trigger-derived enumeration for every role. No UPDATE or DELETE
  grant is added anywhere.
- **3, 4, 5.** Untouched.
- **6 (RLS; the service-role key).** Strengthened: the request roles hold
  nothing in `public` or `app`, so RLS is no longer the only thing between the
  Data API and a tenant's rows, and the service-role key reaches nothing.
  Enforced by 0028's own end-state check and suite 24.
- **7 (thresholds auto-tighten only).** Restored: the guard's name resolution
  is no longer its caller's choice. Enforced by suite 24's enumeration and its
  shadowing probe, alongside suite 05.

## Rollback

There is no reason to undo the pin, and undoing it is `alter function
app.guard_threshold_direction() reset search_path`.

For the grants: before applying, save the output of the snapshot query in
docs/supabase.md ("Before applying 0028"), which lists every ACL entry, default
privilege and membership the three request roles hold. Rolling back is
re-issuing those grants from that list. It should not be needed — nothing uses
them — and if something turns out to, the answer is a superseding ADR that
grants that one thing to that one role, not the list back.
