#!/usr/bin/env bash
# Applies every migration to a scratch database, then runs the invariant, RLS
# and separation-of-duties suites. Any failure exits non-zero, so this is safe
# as a CI gate.
#
#   TEST_DATABASE_URL=postgres://…/recouple_test RECOUPLE_TEST_DATABASE=1 ./scripts/db-test.sh
#
# The connection must own the schema (it creates roles and triggers). It reads
# TEST_DATABASE_URL, never DATABASE_URL — that is the operator scripts' and the
# app's, and on 2026-09-25 the integration tests reached production through it
# (docs/audits/tests-against-production/). The suites roll back; the migrations
# and `_supabase_shape.sql` do not.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The test-database guard (scripts/test-database.ts), before anything is
# applied: it takes TEST_DATABASE_URL and RECOUPLE_TEST_DATABASE from the
# environment, else from .env and nothing else there, refuses a Supabase host or
# a database carrying recouple_app, supabase_admin or applied Supabase
# migrations, and prints the URL it checked. A refusal exits here.
TEST_DATABASE_URL="$("$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/check-test-database.ts")"

psql_run() { psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q --no-psqlrc -f "$1"; }

# Supabase's request roles and the default privileges it grants them, before
# any migration runs. Production has both and `postgres:16` has neither, so
# without this the grant-bearing half of migration 0006 has never run here and
# migration 0028's revokes would pass by having nothing to revoke (ADR 0037).
# Once, not per pass: it is the platform the migrations are applied to, not a
# migration, and it is idempotent anyway.
echo "== supabase shape (request roles and their default privileges)"
psql_run "$ROOT/supabase/tests/_supabase_shape.sql"

# Every migration is applied twice, in order, and the second pass has to be a
# no-op. Re-running is not a hypothetical: the suites are gated on a database
# that already carries the schema, Supabase re-applies against a branch, and
# `create or replace` / `if not exists` is what every migration here is written
# with. A migration that is only safe the first time now fails on the spot
# rather than the next time somebody points db:test at a database that has it.
echo "== migrations (applied twice: they are idempotent, and this is where that is proved)"
for pass in 1 2; do
  echo "-- pass $pass"
  for f in "$ROOT"/supabase/migrations/*.sql; do
    echo "--   $(basename "$f")"
    psql_run "$f"
  done
done

echo "== harness"
psql_run "$ROOT/supabase/tests/_harness.sql"

echo "== suites"
for f in "$ROOT"/supabase/tests/[0-9]*.sql; do
  psql_run "$f"
done

echo
echo "database invariants: all suites passed"
