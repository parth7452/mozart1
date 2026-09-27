#!/usr/bin/env bash
# Tests for .claude/hooks/dashboard-guard.py: the dashboard-builder subagent may
# touch .dashboard/ and its own memory folder, and run `date` to read the clock,
# and nothing else. Run it directly: bash .claude/hooks/test/dashboard-guard.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dashboard-guard.py"
[ -f "$HOOK" ] || { echo "cannot find dashboard-guard.py next to this test" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PROJ="$TMP/proj"
mkdir -p "$PROJ/.dashboard" "$PROJ/.claude/agent-memory/dashboard-builder" "$PROJ/src"

pass=0
fail=0

# Runs the guard the way Claude Code does: the payload on stdin.
run() {
  local tool="$1" input="$2"
  printf '{"tool_name":"%s","tool_input":%s}' "$tool" "$input" \
    | CLAUDE_PROJECT_DIR="$PROJ" python3 "$HOOK" >/dev/null 2>"$TMP/last-stderr"
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

# --- files -------------------------------------------------------------------
expect 0 "write the dashboard"           run Write "{\"file_path\":\"$PROJ/.dashboard/index.html\",\"content\":\"x\"}"
expect 0 "write relative dashboard path" run Write '{"file_path":".dashboard/state.json","content":"x"}'
expect 0 "edit its memory"               run Edit "{\"file_path\":\"$PROJ/.claude/agent-memory/dashboard-builder/MEMORY.md\"}"
expect 0 "read its memory"               run Read "{\"file_path\":\"$PROJ/.claude/agent-memory/dashboard-builder/MEMORY.md\"}"
expect 2 "write source code"             run Write "{\"file_path\":\"$PROJ/src/index.ts\",\"content\":\"x\"}"
expect 2 "read CLAUDE.md"                run Read "{\"file_path\":\"$PROJ/CLAUDE.md\"}"
expect 2 "escape with .."                run Write "{\"file_path\":\"$PROJ/.dashboard/../src/x.ts\",\"content\":\"x\"}"
expect 2 "a folder named like it"        run Write "{\"file_path\":\"$PROJ/.dashboard-evil/x\",\"content\":\"x\"}"
expect 2 "another agent's memory"        run Write "{\"file_path\":\"$PROJ/.claude/agent-memory/other/x.md\",\"content\":\"x\"}"
expect 2 "home directory"                run Read '{"file_path":"~/.ssh/id_rsa"}'
expect 2 "no path at all"                run Write '{"content":"x"}'
ln -s "$PROJ/src" "$PROJ/.dashboard/link"
expect 2 "symlink out of .dashboard"     run Write "{\"file_path\":\"$PROJ/.dashboard/link/x.ts\",\"content\":\"x\"}"

# --- glob --------------------------------------------------------------------
expect 0 "glob inside .dashboard"        run Glob "{\"pattern\":\"*.html\",\"path\":\"$PROJ/.dashboard\"}"
expect 2 "glob with no path"             run Glob '{"pattern":"**/*.ts"}'
expect 2 "glob climbing out"             run Glob "{\"pattern\":\"../**\",\"path\":\"$PROJ/.dashboard\"}"
expect 2 "glob absolute pattern"         run Glob "{\"pattern\":\"/etc/*\",\"path\":\"$PROJ/.dashboard\"}"

# --- bash ----------------------------------------------------------------------
expect 0 "date"                          run Bash '{"command":"date"}'
expect 0 "date in UTC, ISO format"       run Bash '{"command":"date -u +%Y-%m-%dT%H:%M:%SZ"}'
expect 0 "date -Iseconds"                run Bash '{"command":"date -Iseconds"}'
expect 0 "date with a quoted format"     run Bash '{"command":"date \"+%H:%M %Z\""}'
expect 2 "setting the clock"             run Bash '{"command":"date -s 2020-01-01"}'
expect 2 "date --set"                    run Bash '{"command":"date --set=2020-01-01"}'
expect 2 "date reading a file"           run Bash '{"command":"date -r /etc/passwd"}'
expect 2 "date then something else"      run Bash '{"command":"date; rm -rf /"}'
expect 2 "date piped"                    run Bash '{"command":"date | tee x"}'
expect 2 "command substitution"          run Bash '{"command":"date +$(id)"}'
expect 2 "any other command"             run Bash '{"command":"ls"}'

# --- everything else -----------------------------------------------------------
expect 2 "another tool"                  run WebFetch '{"url":"https://example.com"}'
expect 2 "garbage payload" bash -c "echo 'not json' | CLAUDE_PROJECT_DIR='$PROJ' python3 '$HOOK' >/dev/null 2>'$TMP/last-stderr'"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
