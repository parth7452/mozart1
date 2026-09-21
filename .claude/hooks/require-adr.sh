#!/usr/bin/env bash
# PreToolUse guard: edits to the migrations or the invariant modules are only
# allowed on a branch that carries a numbered ADR.
#
# Reads the hook payload on stdin, exits 2 to block (stderr goes back to Claude).
#
# The guard blocks on three different answers, and says which one it got. "This
# branch adds no ADR" and "this checkout cannot tell" are not the same fact, and
# reporting the second as the first sends whoever hit it off to write an ADR
# that already exists.
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

# Judge the checkout the *edit* is in, not the one this script lives in.
#
# The hook command is `$CLAUDE_PROJECT_DIR/.claude/hooks/require-adr.sh`, and in
# a git worktree that path is the main checkout's copy while the file being
# edited sits in the worktree. Resolving the repo from the script's own location
# therefore measured a worktree's migration against the main checkout's branch,
# which carries no ADR — a correct edit, blocked, with a message telling you to
# write an ADR you had already written.
#
# So the root comes from the file. A Write may be creating the file *and* its
# directory (`supabase/migrations/` exists, but a new package's
# `src/invariants/` may not), so walk up to the first directory that exists
# before asking git. A relative file_path is resolved against the project dir
# the hook was invoked for, falling back to $PWD. If none of that finds a repo —
# an edit outside any checkout — fall back to this script's own repo, which is
# what the guard did before and still fails closed.
resolve_root() {
  local dir
  case "$1" in
    /*) dir="$(dirname "$1")" ;;
    *)  dir="$(dirname "${CLAUDE_PROJECT_DIR:-$PWD}/$1")" ;;
  esac

  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ ! -d "$dir" ]; do
    dir="$(dirname "$dir")"
  done
  [ -d "$dir" ] || return 1

  git -C "$dir" rev-parse --show-toplevel 2>/dev/null
}

root="$(resolve_root "$file_path" || true)"
[ -n "$root" ] || root="$(dirname "${BASH_SOURCE[0]}")/../.."

cd "$root" || exit 0

# An uncommitted ADR counts, and detecting one needs no base ref — so this runs
# first, before anything that can fail for want of a ref.
if [ -n "$(git status --porcelain -- docs/adr 2>/dev/null || true)" ]; then
  exit 0
fi

# Not every checkout has origin/HEAD set — a single-branch clone has no such
# ref. Where it is missing the default branch's *name* is unknown too, so the
# candidates below are probed rather than one of them being assumed: assuming
# "main" in a repo whose default is "master" is the same class of bug as
# assuming an absent ref means an absent ADR.
default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
default_branch="${default_branch#origin/}"

if [ -n "$default_branch" ]; then
  candidates="origin/${default_branch} refs/heads/${default_branch}"
  fetch_hint="git fetch origin ${default_branch}:refs/remotes/origin/${default_branch}"
else
  candidates="origin/main origin/master refs/heads/main refs/heads/master"
  fetch_hint="git fetch origin main:refs/remotes/origin/main   # or master, whichever this repo uses"
fi

undetermined() {
  cat >&2 <<MSG
Blocked: $file_path is invariant-bearing, and this checkout cannot prove an ADR
covers it.

$1

This is not "you have no ADR" — it is "this guard could not look", and it does
not guess either way. Fix the checkout:

  ${fetch_hint}

then make the edit again. If the ADR genuinely is not written yet, write it
first: docs/adr/NNNN-<slug>.md — Context / Decision / Consequences / Invariants
touched / Rollback.
MSG
  exit 2
}

# The ref this branch is measured against. A session that cloned a single branch
# — a cloud session, a CI checkout — often has no default branch at all, and a
# `git diff` against a ref that does not exist fails rather than returning
# nothing. Left as `|| true` that failure reads exactly like "no ADR on this
# branch", which is how a branch carrying its ADR gets told to go write one.
base_ref=""
for candidate in $candidates; do
  if git rev-parse --verify --quiet "${candidate}^{commit}" >/dev/null 2>&1; then
    base_ref="$candidate"
    break
  fi
done

if [ -z "$base_ref" ]; then
  undetermined "This clone has no default-branch ref to compare against."
fi

# A ref that exists but shares no history with HEAD gives an empty diff for the
# same reason: nothing was compared.
if ! git merge-base "$base_ref" HEAD >/dev/null 2>&1; then
  undetermined "${base_ref} and HEAD share no common ancestor, so there is nothing to diff."
fi

if [ -n "$(git diff --name-only "${base_ref}...HEAD" -- docs/adr 2>/dev/null || true)" ]; then
  exit 0
fi

cat >&2 <<MSG
Blocked: $file_path is invariant-bearing.

Migrations and invariant modules change only alongside a numbered ADR. Add
docs/adr/NNNN-<slug>.md on this branch first — Context / Decision /
Consequences / Invariants touched / Rollback — then make the edit.

Checked against ${base_ref}; this branch adds no ADR.

If a merged migration is what you were about to edit: don't. Add a new one.
MSG
exit 2
