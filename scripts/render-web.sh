#!/usr/bin/env bash
# Renders the web app's views to standalone HTML from a real database.
#
# Bundled first rather than run through tsx: the views live under apps/web, whose
# tsconfig is Next's, and this render needs `next/link` swapped for a plain
# anchor since a file on disk has no router.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi
: "${DATABASE_URL:?set DATABASE_URL to the database the preview should read}"

ESBUILD="$(ls "$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)"
OUT="$ROOT/apps/web/.cache/render-web-views.mjs"
mkdir -p "$(dirname "$OUT")" "$ROOT/apps/web/preview"

# Only this script and the views are bundled, so that the JSX is compiled and
# `next/link` is swapped. The workspace packages stay external: they are
# TypeScript source that resolves paths against its own location, and bundling
# them would move the fixture corpus out from under them. tsx then runs the
# bundle and transpiles those imports as usual.
"$ESBUILD" "$ROOT/scripts/render-web-views.tsx" \
  --bundle --platform=node --format=esm --jsx=automatic --target=node20 \
  --external:pg --external:react --external:react-dom "--external:@recouple/*" \
  --alias:next/link="$ROOT/scripts/preview/next-link.tsx" \
  --log-level=warning --outfile="$OUT"

npx tsx "$OUT"
