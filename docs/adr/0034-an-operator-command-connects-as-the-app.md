# 0034 — An operator command connects as the app

- Status: accepted
- Date: 2026-09-22

## Context

Three operator commands — `pnpm link:retailer` (ADR 0019), `pnpm link:provenance`
(ADR 0024) and `pnpm link:qbo` (ADR 0033) — begin the same way. Each takes an
org slug and a member's email, and before it can construct a `PostgresStore` it
has to turn those into an `org_id` and a `user_id`. Each did that on a raw `pg`
pool over `DATABASE_URL`, with no `set local role` and no claims:

```sql
select id from organizations where slug = $1;
select u.id, m.role from users u join memberships m on m.user_id = u.id
 where lower(u.email) = lower($1) and m.org_id = $2;
```

`docs/supabase.md` says `DATABASE_URL` names a login role such as
`recouple_app`, which is a member of `app_rw` and `app_ro` and has no privileges
of its own — "a door, not a permission set". On production with that login all
three commands fail at the first statement:

```
error: permission denied for schema app
```

The login has no USAGE on schema `app` (the RLS policies on `organizations` and
`users` call `app.current_org_id()`) and no SELECT on either table. Production's
catalogue says why precisely: `recouple_app` is `NOINHERIT`, and its memberships
in `app_rw` and `app_ro` are `inherit false, set true`. It holds nothing until it
runs `set role`. `docs/supabase.md`'s example said only `grant app_rw to
recouple_app`, which on Postgres 16 inherits by default, so a login made from
the docs would have hidden the bug. The docs now spell out the production
shape. The commands
only ever worked against the owner login, which the same document says not to
use. `link:retailer` went further and read `debtors` and counted `deductions`
on that pool too, outside RLS entirely.

## Decision

### 1. One definer function answers the one question, and nothing else

Migration 0026 adds `app.member_for_link(slug text, email text)`, returning at
most one row of `(org_id uuid, user_id uuid, role membership_role)`:

- no row when no organization has that slug;
- `org_id` with a null `user_id` and `role` when the org exists and the address
  is not one of its members;
- all three when it is.

That is exactly the distinction the commands already reported ("no organization
with slug …" and "… is not a member of …"), so their messages do not change. An
address that matches two users case-insensitively raises rather than picking
one. `users.email` is unique only case-sensitively, and an operator's change
attributed to whichever of two people the planner returned first is a wrong
`created_by` nobody would notice.

It is `security definer` with a pinned `search_path`, `revoke all … from
public`, and granted to `app_rw` only — the shape of `app.my_orgs()` (0012) and
`app.ledger_connections_to_sync()` (0024).

### 2. It refuses any caller that carries a claim

The function raises when `request.jwt.claims` carries an `org_id` or a `sub`.
The operator command sets neither, because it knows neither yet. Every request
path does carry at least one: `PostgresStore.withTenant` sets both, and a
Supabase PostgREST request as `authenticated` (a member of `app_rw`, 0006)
always carries `sub`. The one request-path caller with no claims at all is the
first statement of `resolveSession`, which calls `app.link_auth_user()` and not
this.

This is `ledger_connections_to_sync()`'s guard, widened from the org claim to
either claim, because this function takes caller-supplied arguments and that
one does not. It makes "use it from a request" something the database refuses
rather than something a reviewer has to spot.

### 3. What it exposes, said plainly

A caller that holds `DATABASE_URL`, sets `app_rw` and sets no claims can learn
whether a slug exists and whether an address is a member there, and at what
role. That is no new reach. `app.current_org_id()` reads a setting the caller
sets itself, so the same caller can already adopt any tenant's claims and read
that tenant's rows, which is strictly more (ADR 0031 §5 made the same argument).
What the function does not return is also deliberate: no name, no email and no
other member.

### 4. Everything after the lookup is the tenant's own policies

Once the ids are known, the command constructs `PostgresStore` exactly as
before, and every read and write goes through `withTenant` as `app_rw` with the
member's claims. `link:retailer`'s debtor lookup, its list of known retailer
keys and its dry-run count of unmatched cases move onto `PostgresStore` for
that reason. They were owner reads outside RLS, and a read outside RLS in an
operator command is still a read outside RLS.

The lookup itself lives in `@recouple/store-postgres` as `resolveOperator`,
next to `resolveSession` and `listConnectionsToSync`, so there is one copy of
it and a test can run it as the prescribed login.

## Options not taken

**(b) Run the lookup as `app_rw` under the member's claims.** This is circular.
The `organizations` policy is `id = app.current_org_id()` and the `users`
policy asks for a membership in `app.current_org_id()`. The row that says which
org a slug names is visible only to a caller that has already put that org's id
in its claims, and a user row is visible only once the org is known. The
command's whole job is to learn the ids those claims need. A caller could guess
the claims, but a guess that happens to be visible is not a lookup.

**Grant the login role SELECT on `organizations`, `users`, `memberships` and
USAGE on `app`.** That turns the door into a permission set and makes the login
role's own privileges something every request path also holds, because the web
app connects as the same login. It also reads three tables past RLS where one
function reads one answer.

**Keep using the owner login for operator commands.** That is a second
`DATABASE_URL` that bypasses RLS on every table, sitting in the same `.env` as
the first. It is the service role in all but name, and invariant 6 is the one
the database cannot enforce for us.

## Consequences

- The three commands work on the prescribed login and on no broader one. A
  test connects as a fresh login role that is only a member of `app_rw` and
  `app_ro`, as `docs/supabase.md` prescribes, and runs each command's lookup
  path; it also asserts that the old raw query fails on that login, so the test
  cannot pass against an owner connection by accident.
- No table, column, grant on a table, or policy changes. No append-only table is
  touched and no UPDATE or DELETE grant is added.
- `link:provenance` had the identical bug and gets the identical fix.

## Invariants

- **2 (append-only):** untouched. The migration adds one function and no table,
  grant on a table, trigger or policy.
- **6 (RLS, never the service role):** strengthened. The commands no longer need
  an owner connection, and every read after the lookup goes through the
  tenant's policies. The function bypasses RLS for one bounded question and
  refuses any caller that carries a claim.
- **1, 3, 4, 5, 7:** not engaged.
