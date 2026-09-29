#!/usr/bin/env bash
# Tests for .claude/hooks/stop-verify.sh: the three ways it must exit 0 without
# running anything, and that a real failure is exit 2 with the log on stderr.
# Run it directly: bash .claude/hooks/test/stop-verify.test.sh
set -uo pipefail
HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/stop-verify.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
pass=0; fail=0
check() { # want-exit name stdin-json
  local want="$1" name="$2" input="$3" got
  printf '%s' "$input" | CLAUDE_PROJECT_DIR="$TMP/repo" bash "$HOOK" >/dev/null 2>"$TMP/err"; got=$?
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $name: exit $got, want $want"; cat "$TMP/err"; fi
}
# A fake repo whose pnpm is a stub we control through $TMP/pnpm-exit.
mkdir -p "$TMP/repo/node_modules/.bin" "$TMP/repo/.claude" "$TMP/bin"
( cd "$TMP/repo" && git init -q -b main && git -c commit.gpgsign=false commit -q --allow-empty -m init )
printf '#!/bin/sh\nexit $(cat "%s/pnpm-exit")\n' "$TMP" > "$TMP/bin/pnpm"; chmod +x "$TMP/bin/pnpm"
export PATH="$TMP/bin:$PATH"; echo 0 > "$TMP/pnpm-exit"

check 0 "stop_hook_active skips" '{"stop_hook_active":true}'
check 0 "no vitest skips" '{}'
grep -q 'did NOT run' "$TMP/err" || { fail=$((fail+1)); echo "FAIL: skip did not say the checks did not run"; }
touch "$TMP/repo/node_modules/.bin/vitest"; chmod +x "$TMP/repo/node_modules/.bin/vitest"
check 0 "passing run" '{}'
[ -f "$TMP/repo/.claude/.stop-verify-ok" ] || { fail=$((fail+1)); echo "FAIL: no stamp after a pass"; }
echo 1 > "$TMP/pnpm-exit"
check 0 "unchanged tree is not re-run" '{}'
echo changed > "$TMP/repo/file.txt"
check 2 "failure after a change blocks" '{}'
grep -q 'stop-verify: typecheck or tests failed' "$TMP/err" || { fail=$((fail+1)); echo "FAIL: failure not reported on stderr"; }
echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
