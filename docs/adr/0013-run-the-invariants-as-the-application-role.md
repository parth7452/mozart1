# 0013 — Run the invariants as the application role, on the real deployment

- Status: accepted
- Date: 2026-09-18

## Context

Verifying migration 0010 against the live Supabase project, every hash-chained
write failed the moment the transaction dropped into `app_rw`:

```
insert into deduction_events … → function digest(bytea, unknown) does not exist
```

`app.row_hash()` calls `digest()`. pgcrypto lives in `public` on local Postgres
and in `extensions` on Supabase, so ADR 0010 pinned the function search paths to
`pg_catalog, public, extensions` — one setting for both. That was necessary and
not sufficient: **a schema in the search path is still invisible to a role
without USAGE on it**, and neither `app_rw` nor `app_ro` had USAGE on
`extensions`. On the live project the application could not append a deduction
event or an audit-log row at all. Invariant 1 depends on those rows existing.

Two things hid it:

- **Locally, pgcrypto is in `public`**, a schema every role may use. The
  behavioural test passes on local Postgres whether or not the grant exists, so
  it could never have caught this.
- **The first live verification ran as the owner**, which has USAGE on
  everything. It asserted the right properties as the wrong principal.

The second is the real mistake. The owner is not a principal the application
ever uses; a check that passes only because it ran with more privilege than
production has is not a check.

## Decision

**Migration 0011** grants USAGE on pgcrypto's schema, and EXECUTE on `digest`,
to `app_rw` and `app_ro`. It reads the schema from `pg_extension` rather than
naming one, so the same migration is correct on either Postgres and stays
correct if pgcrypto moves. The alternative — making `app.row_hash()` and the
chaining triggers `security definer` — would hand the application role the
owner's reach to compute a hash, and ADR 0010 chose invoker deliberately.

**Suite 08** asserts the privilege rather than only the behaviour:
`has_schema_privilege(app_rw, <pgcrypto's schema>, 'usage')` and
`has_function_privilege(app_rw, 'digest(bytea, text)', 'execute')`. This is the
form of the invariant that travels between the two Postgreses; the behavioural
append in the same suite is kept, and is honestly labelled as passing locally
either way.

**Every live verification runs as `app_rw` or `app_ro`, never as the owner**,
except for the seeding a tenant cannot do for itself and the two checks whose
whole point is that the owner is also refused (invariant 6). The 15-check pass
recorded in `docs/supabase.md` follows this rule.

## Consequences

The app roles can now call `digest` directly. That is not a privilege worth
withholding — the hash chain's integrity comes from the append-only triggers and
the advisory-locked chaining, not from the application being unable to compute a
SHA-256.

A deeper consequence: the local suite and the live check are not the same test
and neither replaces the other. The local suite proves the migrations are
portable and runs in two seconds. The live check proves the deployment is
actually usable by the roles that will use it. Every migration that touches
grants, roles, search paths or extension functions gets both, and the live one
gets the application's own privileges.

## Invariants touched

**1**, repaired on the live project: the chained rows the gate reasons about
could not be written there at all.

## Rollback

Revoking the grant restores a deployment where the application cannot write.
There is no reason to revert this.
