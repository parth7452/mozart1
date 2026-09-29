#!/usr/bin/env bash
# SessionStart hook: install workspace dependencies in a Claude Code on the
# web container, so `pnpm typecheck` and `pnpm test` — and the Stop hook that
# runs them (stop-verify.sh) — have something to run. Does nothing on a laptop.
#
# Synchronous: the session starts once this has finished, so nothing races an
# install that is still going. Idempotent: a second run is a no-op install.
# The lockfile is respected (`--frozen-lockfile`), the same as CI.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# No browser download: the container has Chromium at /opt/pw-browsers.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
pnpm install --frozen-lockfile --prefer-offline
