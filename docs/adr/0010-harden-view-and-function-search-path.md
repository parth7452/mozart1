# 0010 — A view that bypassed RLS, and functions with a mutable search_path

- Status: accepted
- Date: 2026-09-18

## Context

Deploying the schema to a live Supabase project and running its database linter
turned up two things the local suite had passed clean.

**`document_state` bypassed row-level security.** A Postgres view runs with the
permissions of its *owner* unless it is declared `security_invoker`. The view
selects from `documents`, `document_scans` and `document_classifications` — all
three RLS-protected and tenant-scoped — so as written it read those tables as its
owner, and the `tenant_isolation` policies did not apply to whoever queried it.
That is a cross-tenant read path in a codebase whose sixth invariant is "RLS on
every table". It is an ERROR-level finding and it is correct.

The local suite missed it because `04_rls.sql` tests the tables directly and
`01_append_only.sql` only queries the view within a single tenant. Nothing ever
asked the view for another tenant's rows.

**Eleven `app.*` functions had a mutable `search_path`.** A function without a
pinned search path resolves unqualified names using the *caller's* path, so a
caller who puts a schema of their own in front can decide which `digest` or which
table the function body sees. Two of the eleven are `app.block_mutations` and
`app.require_approval` — the functions that enforce append-only storage and the
approval gate. Those are exactly the functions where an attacker-chosen
resolution order would be worth having.

## Decision

`document_state` is declared `security_invoker = true`, so it reads with the
permissions and policies of whoever queries it. The RLS suite gains a
cross-tenant read through the view, so the gap that hid this is closed by a test
rather than by remembering.

Every `app.*` function pins `search_path = pg_catalog, public, extensions`.
`extensions` is where Supabase installs pgcrypto; locally pgcrypto lands in
`public` and the missing `extensions` schema is simply ignored, so one setting is
correct on both.

## Consequences

Anything querying `document_state` now needs its own select privilege and its own
tenant claim. That is the intent: the view was a convenience wrapper, never a
reason to see more than the tables behind it.

Pinning a search path means a function that later wants a new schema must say so.
That is a good trade for the functions that hold the invariants up.

## What this says about the local suite

The invariants were enforced correctly and tested against the wrong surface. A
policy on a table is not a policy on every path to that table, and a test that
only ever reads its own tenant's rows cannot tell the difference. Worth
remembering the next time a view, a function or a materialised view is added over
an RLS-protected table: each one is a new path, and each one needs its own
cross-tenant test.

## Invariants touched

**6**, restored. RLS now applies through the view as well as to the tables, and
the functions enforcing invariants 1, 2 and 7 can no longer have their name
resolution chosen by a caller.

## Rollback

Reverting either change re-opens the finding. Neither has a legitimate reason to
be reverted.
