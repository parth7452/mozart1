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

## Connecting an app

Get the project URL and the publishable (anon) key from the Supabase dashboard,
or the CLI, and put them in `.env`:

```
SUPABASE_URL=https://hvheqbgkvwhlqutklwfh.supabase.co
SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…      # server-side jobs only (invariant 6)
```

The service-role key bypasses RLS. It belongs in background jobs and nowhere
near a request path — that is invariant 6, and it is the one invariant the
database cannot enforce for us.

## Sharing a project with Mozart

This project was empty, so recouple uses it rather than spending a second
project slot. If Mozart ever needs Supabase too, recouple should move to its own
project: ADR 0002 keeps these codebases separate, and sharing a database would
undo that. Moving is re-running the same migrations against a new ref.
