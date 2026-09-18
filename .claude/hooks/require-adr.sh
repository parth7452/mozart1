#!/usr/bin/env bash
# PreToolUse guard: edits to the migrations or the invariant modules are only
# allowed on a branch that carries a numbered ADR.
#
# Reads the hook payload on stdin, exits 2 to block (stderr goes back to Claude).
set -euo pipefail

payload="$(cat)"

file_path="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
ti = data.get("tool_input") or {}
print(ti.get("file_path") or ti.get("path") or "")
')"

[ -n "$file_path" ] || exit 0

case "$file_path" in
  *supabase/migrations/*|*/src/invariants/*) ;;
  *) exit 0 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 0
# Not every checkout has origin/HEAD set; fall back rather than aborting, since
# aborting here would let the edit through.
default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
default_branch="${default_branch#origin/}"
default_branch="${default_branch:-main}"

# An ADR counts if this branch added one, or if one is sitting uncommitted.
adrs_on_branch="$(git diff --name-only "origin/${default_branch}...HEAD" -- docs/adr 2>/dev/null || true)"
adrs_uncommitted="$(git status --porcelain -- docs/adr 2>/dev/null || true)"

if [ -z "$adrs_on_branch" ] && [ -z "$adrs_uncommitted" ]; then
  cat >&2 <<MSG
Blocked: $file_path is invariant-bearing.

Migrations and invariant modules change only alongside a numbered ADR. Add
docs/adr/NNNN-<slug>.md on this branch first — Context / Decision /
Consequences / Invariants touched / Rollback — then make the edit.

If a merged migration is what you were about to edit: don't. Add a new one.
MSG
  exit 2
fi
exit 0
