#!/usr/bin/env bash
# Runs the onboarding runbook's SQL against a scratch database, so the runbook
# cannot drift from the migrations it writes into: the create block from
# docs/onboarding/create-workspace.sql, and every other block from
# docs/ONBOARDING.md. `pnpm db:test` runs it last, so CI and `pnpm verify` do.
#
#   TEST_DATABASE_URL=postgres://…/recouple_test RECOUPLE_TEST_DATABASE=1 ./scripts/check-onboarding-sql.sh
#
# The database must already carry the schema: `pnpm db:test` applies it first.
# It reads TEST_DATABASE_URL, never DATABASE_URL — that is the operator
# scripts' and the app's — and runs the test-database guard
# (scripts/test-database.ts) before it connects, as scripts/db-test.sh does.
# Every check runs inside a transaction that is rolled back, so nothing is left
# behind. A block in ONBOARDING.md is found by its first line,
# `-- onboarding:<name>`; blocks marked `-- onboarding:supabase-only …` read
# auth.users and are skipped.
#
# What it proves:
#   * the create block runs, and a second run creates nothing;
#   * every read-back row is `ok`;
#   * each refusal the runbook promises actually refuses;
#   * the role-change, removal and daily queries run against the schema.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$ROOT/docs/ONBOARDING.md"
CREATE_FILE="$ROOT/docs/onboarding/create-workspace.sql"

# The test-database guard, before anything connects: TEST_DATABASE_URL and
# RECOUPLE_TEST_DATABASE=1 from the environment, else from .env and nothing
# else there, and a Supabase host or a database carrying recouple_app,
# supabase_admin or applied Supabase migrations is refused. It prints the URL
# it checked. A refusal exits here.
TEST_DATABASE_URL="$("$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/check-test-database.ts")"

fail() { echo "FAIL: $*" >&2; exit 1; }

# The body of the one ```sql block whose first line is exactly `-- onboarding:$1`.
block() {
  local out
  out="$(awk -v tag="-- onboarding:$1" '
    /^```sql[[:space:]]*$/ { inblock = 1; first = 1; buf = ""; next }
    /^```[[:space:]]*$/ && inblock { if (keep) { printf "%s", buf; n++ } inblock = 0; keep = 0; next }
    inblock { if (first) { keep = ($0 == tag); first = 0 } buf = buf $0 "\n" }
    END { if (n != 1) exit 3 }' "$DOC")" || fail "expected exactly one block tagged -- onboarding:$1 in docs/ONBOARDING.md"
  printf '%s\n' "$out"
}

# Every tagged block must be one this script knows, so a new block cannot go untested.
# `create` is not among them: it is its own file, and a second copy here would
# be one nothing tests.
known=" readback readback-people unmatched-payers change-role remove-member "
while IFS= read -r tag; do
  case "$tag" in supabase-only*) continue ;; esac
  [[ "$known" == *" $tag "* ]] || fail "block -- onboarding:$tag is not exercised by this script"
done < <(awk '/^```sql[[:space:]]*$/ { getline; if ($0 ~ /^-- onboarding:/) { sub(/^-- onboarding:/, ""); print } }' "$DOC")

psql_tx() { psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --no-psqlrc "$@"; }

psql_tx -tAc "select to_regclass('public.inbound_addresses') is not null" | grep -qx t \
  || fail "the database has no schema: run pnpm db:test against it first"

# The create block is a file of its own so that it can be pasted whole: pasted
# out of the markdown, it arrived cut short twice (VERIFY-CHECKLIST §4,
# 2026-09-26). Its first line is its tag, and its last is the line the runbook
# tells the founder to look for before pressing Run.
[ -f "$CREATE_FILE" ] || fail "missing docs/onboarding/create-workspace.sql"
[ "$(head -n 1 "$CREATE_FILE")" = "-- onboarding:create" ] \
  || fail "the first line of docs/onboarding/create-workspace.sql must be -- onboarding:create"
[ "$(tail -n 1 "$CREATE_FILE")" = "\$onboard\$;" ] \
  || fail "the last line of docs/onboarding/create-workspace.sql must be \$onboard\$; (the runbook's sign that a paste arrived whole)"
CREATE="$(cat "$CREATE_FILE")"
READBACK="$(block readback)"

# Replaces the create block's `people` list with $1 (a JSON array literal).
with_people() {
  PEOPLE="$1" perl -0pe 's/\$people\$\[.*?\]\$people\$/"\$people\$" . $ENV{PEOPLE} . "\$people\$"/se' <<<"$CREATE"
}

# Runs SQL that must fail, and checks the error names $1.
expect_refusal() {
  local why="$1" sql="$2" out
  if out="$(printf 'begin;\n%s\nrollback;\n' "$sql" | psql_tx 2>&1)"; then
    fail "expected a refusal ($why), but it succeeded"
  fi
  grep -q -- "$why" <<<"$out" || fail "expected a refusal naming \"$why\", got: $out"
  echo "ok   refuses: $why"
}

echo "== create twice, then read back"
out="$(printf 'begin;\n%s\n%s\n\\pset format unaligned\n\\pset tuples_only on\n%s\nrollback;\n' \
  "$CREATE" "$CREATE" "$READBACK" | psql_tx 2>&1)" \
  || fail "create/read-back failed: $out"
notices="$(grep 'NOTICE:  onboard ' <<<"$out")" || fail "no onboarding notice: $out"
[ "$(wc -l <<<"$notices")" -eq 2 ] || fail "expected two notices, got: $notices"
first="$(sed -n 1p <<<"$notices")"; second="$(sed -n 2p <<<"$notices")"
grep -q 'organization created; users created 3, reused 0; memberships created 3; payers created 4' <<<"$first" \
  || fail "first run: $first"
grep -q 'organization existed; users created 0, reused 3; memberships created 0; payers created 0' <<<"$second" \
  || fail "second run is not a no-op: $second"
echo "ok   first run:  ${first#*NOTICE:  }"
echo "ok   second run: ${second#*NOTICE:  }"
readback_rows="$(grep -E '\|(t|f)$' <<<"$out" || true)"
[ "$(wc -l <<<"$readback_rows")" -eq 6 ] || fail "expected six read-back rows, got: $readback_rows"
if grep -q '|f$' <<<"$readback_rows"; then fail "a read-back row is not ok: $readback_rows"; fi
echo "ok   read-back: all six rows ok"
out="$(printf 'begin;\n%s\n\\pset format unaligned\n\\pset tuples_only on\n%s\n%s\nrollback;\n' \
  "$CREATE" "$(block readback-people)" "$(block unmatched-payers)" | psql_tx 2>&1)" || fail "$out"
[ "$(grep -c '@' <<<"$out")" -eq 3 ] || fail "expected three people, got: $out"
echo "ok   people and unmatched-payers queries run"

echo "== an address already stored in other capitals is reused, not duplicated"
out="$(printf "begin;\ninsert into users (email) values ('Controller@ACME-Foods.example');\n%s\n\\pset format unaligned\n\\pset tuples_only on\nselect count(*) from users where lower(email) = 'controller@acme-foods.example';\nrollback;\n" \
  "$CREATE" | psql_tx 2>&1)" || fail "$out"
grep -q 'users created 2, reused 1' <<<"$out" || fail "expected the stored address to be reused: $out"
grep -qx '1' <<<"$out" || fail "a second row was created for the same address: $out"
echo "ok   reused, one row"

echo "== refusals"
expect_refusal "already belongs to workspace" \
  "insert into organizations (slug, name) values ('acme-foods', 'Someone Else');
$CREATE"
expect_refusal "in different capitals (VERIFY-CHECKLIST R4)" \
  "insert into users (email) values ('AP.Lead@acme-foods.example'), ('ap.lead@ACME-foods.example');
$CREATE"
expect_refusal "is listed twice in people" "$(with_people '[
  {"email": "controller@acme-foods.example", "role": "owner"},
  {"email": "Controller@acme-foods.example", "role": "analyst"}]')"
expect_refusal "at least two people who can write" "$(with_people '[
  {"email": "controller@acme-foods.example", "role": "owner"},
  {"email": "viewer@acme-foods.example", "role": "read_only"}]')"
expect_refusal "would have no owner" "$(with_people '[
  {"email": "ap.lead@acme-foods.example", "role": "approver"},
  {"email": "analyst@ourfirm.example", "role": "analyst"}]')"
expect_refusal "is not one of owner" "$(with_people '[
  {"email": "controller@acme-foods.example", "role": "admin"}]')"
expect_refusal "not an email address" "$(with_people '[
  {"email": "controller at acme", "role": "owner"}]')"
expect_refusal "change a role with runbook" \
  "$CREATE
update memberships set role = 'read_only'
 where user_id = (select id from users where email = 'ap.lead@acme-foods.example');
$CREATE"
expect_refusal "already has fee_pct_bps" \
  "$CREATE
update org_settings set fee_pct_bps = 2000
 where org_id = (select id from organizations where slug = 'acme-foods');
$CREATE"
expect_refusal "is already \"Sysco Corporation\"" \
  "$CREATE
update debtors set display_name = 'Sysco Corporation' where retailer_key = 'sysco'
   and org_id = (select id from organizations where slug = 'acme-foods');
$CREATE"

echo "== change a role, remove someone"
out="$(printf 'begin;\n%s\n%s\nrollback;\n' "$CREATE" "$(block change-role)" | psql_tx 2>&1)" || fail "$out"
grep -q 'ap.lead@acme-foods.example in acme-foods: approver -> analyst' <<<"$out" || fail "$out"
echo "ok   change-role"
out="$(printf 'begin;\n%s\n%s\nrollback;\n' "$CREATE" "$(block remove-member)" | psql_tx 2>&1)" || fail "$out"
grep -q 'removed ap.lead@acme-foods.example (approver) from acme-foods' <<<"$out" || fail "$out"
echo "ok   remove-member"

# The example's approver is the one the two blocks name; point them at others.
CHANGE_OWNER="$(block change-role | sed "s/'ap.lead@acme-foods.example'/'controller@acme-foods.example'/; s/:= 'analyst';/:= 'approver';/")"
REMOVE_OWNER="$(block remove-member | sed "s/'ap.lead@acme-foods.example'/'controller@acme-foods.example'/")"
REMOVE_ANALYST="$(block remove-member | sed "s/'ap.lead@acme-foods.example'/'analyst@ourfirm.example'/")"
expect_refusal "that would leave acme-foods with no owner" "$CREATE
$CHANGE_OWNER"
expect_refusal "that would leave acme-foods with no owner" "$CREATE
$REMOVE_OWNER"
expect_refusal "fewer than two people who can write" "$CREATE
$(block remove-member)
$REMOVE_ANALYST"

# The QuickBooks connection and a live email address each act as a person.
CONNECT_AS_APPROVER="insert into accounting_connections (org_id, provider, provider_account_id, created_by)
select o.id, 'qbo', 'onboarding-check-' || gen_random_uuid(), u.id
  from organizations o, users u
 where o.slug = 'acme-foods' and u.email = 'ap.lead@acme-foods.example';"
ADDRESS_AS_APPROVER="insert into inbound_addresses (org_id, created_by)
select o.id, u.id
  from organizations o, users u
 where o.slug = 'acme-foods' and u.email = 'ap.lead@acme-foods.example';"
expect_refusal "holds this workspace's QuickBooks connection" "$CREATE
$CONNECT_AS_APPROVER
$(block remove-member)"
expect_refusal "a live email address acts as" "$CREATE
$ADDRESS_AS_APPROVER
$(block remove-member)"
expect_refusal "a live email address acts as" "$CREATE
$ADDRESS_AS_APPROVER
$(block change-role | sed "s/:= 'analyst';/:= 'read_only';/")"

echo
echo "onboarding runbook SQL: every block ran as documented"
