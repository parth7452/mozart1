#!/usr/bin/env bash
# Tests for .claude/hooks/require-adr.sh — specifically that the guard judges
# the checkout the edited file is in, rather than the checkout the script lives
# in. Run it directly: bash .claude/hooks/test/require-adr.test.sh
#
# Every fixture repo is built from scratch under a temp dir: an "upstream" with
# a main branch, a clone (so origin/main and origin/HEAD exist, which is what
# the guard measures against), and worktrees off that clone. The clone itself
# stays on main and never carries an ADR, so a hook that resolved the repo from
# the wrong place fails these tests rather than passing them by accident.
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/require-adr.sh"
[ -f "$HOOK" ] || { echo "cannot find require-adr.sh next to this test" >&2; exit 1; }

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git() { command git -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }

pass=0
fail=0

# Runs the guard the way Claude Code does: the payload on stdin, nothing else.
# Returns the guard's exit code; stderr is kept for a failing test to print.
run_hook() {
  local file_path="$1" out
  out="$TMP/last-stderr"
  printf '{"tool_input":{"file_path":"%s"}}' "$file_path" \
    | bash "$HOOK" >/dev/null 2>"$out"
}

expect() {
  local want="$1" name="$2" got
  shift 2
  "$@"
  got=$?
  if [ "$got" = "$want" ]; then
    printf 'ok   %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (want exit %s, got %s)\n' "$name" "$want" "$got"
    sed 's/^/       /' "$TMP/last-stderr" >&2
    fail=$((fail + 1))
  fi
}

# --- fixture: upstream, a clone on main with no ADR, three worktrees ---------

UP="$TMP/upstream"
mkdir -p "$UP/docs/adr" "$UP/supabase/migrations" "$UP/packages/core-domain/src/invariants"
git init --quiet "$UP"
echo '# fixture' >"$UP/README.md"
echo '# ADR 0001' >"$UP/docs/adr/0001-base.md"
echo '-- 0001' >"$UP/supabase/migrations/0001_base.sql"
echo 'export {};' >"$UP/packages/core-domain/src/invariants/index.ts"
git -C "$UP" add -A
git -C "$UP" commit --quiet -m 'base'

MAIN="$TMP/main"
git clone --quiet "$UP" "$MAIN"

# with-adr: a branch whose ADR is committed
WT_ADR="$TMP/wt-adr"
git -C "$MAIN" worktree add --quiet -b with-adr "$WT_ADR" >/dev/null
echo '# ADR 0002' >"$WT_ADR/docs/adr/0002-thing.md"
git -C "$WT_ADR" add -A
git -C "$WT_ADR" commit --quiet -m 'ADR 0002'

# dirty-adr: a branch whose ADR exists only in the working tree
WT_DIRTY="$TMP/wt-dirty"
git -C "$MAIN" worktree add --quiet -b dirty-adr "$WT_DIRTY" >/dev/null
echo '# ADR 0003' >"$WT_DIRTY/docs/adr/0003-thing.md"

# no-adr: a branch that adds nothing under docs/adr
WT_NONE="$TMP/wt-none"
git -C "$MAIN" worktree add --quiet -b no-adr "$WT_NONE" >/dev/null
echo 'note' >"$WT_NONE/README.md"
git -C "$WT_NONE" add -A
git -C "$WT_NONE" commit --quiet -m 'unrelated'

# The premise of all of it: the main checkout carries no ADR, so any test that
# passes below passes because the guard looked at the worktree.
expect 2 'premise: same path in the main checkout is blocked' \
  run_hook "$MAIN/supabase/migrations/0002_thing.sql"

# --- the cases ---------------------------------------------------------------

expect 0 'worktree branch with a committed ADR' \
  run_hook "$WT_ADR/supabase/migrations/0002_thing.sql"

expect 0 'worktree branch with only an uncommitted ADR' \
  run_hook "$WT_DIRTY/supabase/migrations/0003_thing.sql"

expect 2 'worktree branch with no ADR' \
  run_hook "$WT_NONE/supabase/migrations/0004_thing.sql"

expect 0 'non-invariant path needs no ADR' \
  run_hook "$WT_NONE/README.md"

# A Write can create the directory as well as the file: packages/newpkg does
# not exist in any of these checkouts, so resolution has to walk up to one that
# does. Asserted both ways round, because "walked up too far" lands in the
# guard's own repo, which has no ADR either — and would look like a pass if
# only the blocking case were checked.
expect 0 'new invariants dir, directory does not exist yet, branch has an ADR' \
  run_hook "$WT_ADR/packages/newpkg/src/invariants/money.ts"

expect 2 'new invariants dir, directory does not exist yet, branch has no ADR' \
  run_hook "$WT_NONE/packages/newpkg/src/invariants/money.ts"

# A relative file_path is resolved against CLAUDE_PROJECT_DIR.
expect 0 'relative path with CLAUDE_PROJECT_DIR set' \
  env CLAUDE_PROJECT_DIR="$WT_ADR" \
  bash -c 'printf "{\"tool_input\":{\"file_path\":\"supabase/migrations/0002_thing.sql\"}}" | bash "$0" >/dev/null 2>"$1"' \
  "$HOOK" "$TMP/last-stderr"

expect 2 'relative path with CLAUDE_PROJECT_DIR pointing at a branch with no ADR' \
  env CLAUDE_PROJECT_DIR="$WT_NONE" \
  bash -c 'printf "{\"tool_input\":{\"file_path\":\"supabase/migrations/0004_thing.sql\"}}" | bash "$0" >/dev/null 2>"$1"' \
  "$HOOK" "$TMP/last-stderr"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
