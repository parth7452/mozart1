# 0003 — A plain-SQL invariant suite instead of pgTAP

- Status: accepted
- Date: 2026-09-18

## Context

The plan specifies pgTAP for database invariant and RLS tests. pgTAP is an
extension: it has to be installed in every environment that runs the suite —
local Postgres, CI, and a Supabase branch, where the available extension set is
not ours to choose. The suite's job is to run everywhere, on every commit,
including the first commit before any infrastructure exists.

## Decision

Write the suites in plain SQL against a small harness
(`supabase/tests/_harness.sql`): `test.ok`, `test.expect_error`,
`test.as_member` and a `test.seed_org` fixture builder. Each suite runs inside
a transaction and rolls back. `scripts/db-test.sh` applies every migration to a
scratch database and then runs each suite with `ON_ERROR_STOP=1`, so any failed
assertion fails the command.

The tests deliberately assert both enforcement layers separately: that the
application role lacks the grant, and that the trigger still refuses the
operation for a role that *does* hold it (the owner, a service role, a future
migration). A test that only proved "permission denied" would pass even if
someone dropped the trigger.

## Consequences

Output is `NOTICE` lines rather than TAP, so no TAP consumer can parse it. If we
later want machine-readable results in CI, that is a wrapper, not a rewrite.

## Invariants touched

Invariants 1, 2, 6 and 7 — this ADR changes how they are *tested*, not what they
require. Coverage: `01_append_only.sql`, `02_approval_invariant.sql`,
`03_separation_of_duties.sql`, `04_rls.sql`, `05_threshold_direction.sql`.

## Rollback

Install pgTAP and port the suites; the assertions translate one for one.
