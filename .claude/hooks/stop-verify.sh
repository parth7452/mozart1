#!/usr/bin/env bash
# Stop hook: typecheck and the Vitest suites before Claude ends a turn.
#
# Exits 2 (block the stop, stderr goes back to Claude) only on a real failure.
# Everything else exits 0 and says why on stderr, so a skipped run is never
# mistaken for a passing one:
#
#   - stop_hook_active in the payload: this stop was already caused by this
#     hook, so running it again would loop for ever. Exit 0.
#   - no node_modules/.bin/vitest: dependencies are not installed (cloud
#     containers with no setup script). The checks cannot run; say so, exit 0.
#   - the tree is byte-identical to the last run that passed: nothing to
#     re-verify. Exit 0.
#
# DATABASE_URL is unset for the run: no test may reach the app's database
# (docs/audits/tests-against-production/).
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$root" || exit 0
stamp="$root/.claude/.stop-verify-ok"

payload="$(cat 2>/dev/null || true)"
if printf '%s' "$payload" | python3 -c '
import json, sys
try:
    sys.exit(0 if json.load(sys.stdin).get("stop_hook_active") else 1)
except Exception:
    sys.exit(1)
'; then
  exit 0
fi

if [ ! -x node_modules/.bin/vitest ]; then
  echo "stop-verify: skipped — dependencies are not installed (run pnpm install); typecheck and tests did NOT run" >&2
  exit 0
fi

# What the tree looks like: HEAD plus every tracked and untracked change.
fingerprint="$( { git rev-parse HEAD 2>/dev/null; git status --porcelain=v1 --untracked-files=all 2>/dev/null | grep -v ".claude/.stop-verify-ok$"; git diff HEAD 2>/dev/null; } | sha256sum | cut -d' ' -f1)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$fingerprint" ]; then
  exit 0
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
if pnpm --silent typecheck >"$log" 2>&1 && env -u DATABASE_URL pnpm --silent test >>"$log" 2>&1; then
  printf '%s' "$fingerprint" >"$stamp"
  exit 0
fi

echo "stop-verify: typecheck or tests failed. Last 60 lines:" >&2
tail -n 60 "$log" >&2
exit 2
