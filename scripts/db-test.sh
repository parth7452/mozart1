#!/usr/bin/env bash
# Applies every migration to a scratch database, then runs the invariant, RLS
# and separation-of-duties suites. Any failure exits non-zero, so this is safe
# as a CI gate and as the `on-Stop` hook for Claude Code.
#
#   DATABASE_URL=postgres://…/recouple_test ./scripts/db-test.sh
#
# The connection must own the schema (it creates roles and triggers). Point it
# at a throwaway database — the suites roll back, but the migrations do not.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Local convenience: fall back to .env when DATABASE_URL is not already set.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

: "${DATABASE_URL:?set DATABASE_URL to a scratch Postgres database owned by the connecting role}"

psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q --no-psqlrc -f "$1"; }

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
