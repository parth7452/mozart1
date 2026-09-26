# Workspace presentation polish

Base: `origin/main` at `708dfc1`. Worktree: `/Users/parthpahuja/.codex/worktrees/ui-review-polish/mozart1` on `codex/ui-review-polish-20260925`.

## Scope

Reorder and clarify the existing deductions workspace and case review without changing queries, workflow actions, forms, money/date calculations, or permissions. Preserve the current multi-upload flow and workspace controls from the fresh base.

## Phases

1. Put the review queue first, compact the header and metrics, add a displayed-queue unknown-deadline count, and strengthen case-row hierarchy.
2. Group existing document tools on the same page with shorter guidance and accurate counts.
3. Clarify case identity and navigation, make narrow document previews easier to move past, and polish scoped styles.

## Validation

Add focused presentation tests for counts, labels, fallbacks, permissions, and form contracts. Review fictional fixture pages at desktop and mobile breakpoints. Run typecheck, scratch-database db:test before test, eval, and web build. Create a PR; do not merge or deploy.

## Results

- `pnpm typecheck`, `pnpm db:test`, `pnpm test` (138 files, 2,038 tests), `pnpm eval` (no baseline regression), and `pnpm build:web` passed.
- `pnpm render:web` rendered fictional fixtures from a fresh local PostgreSQL cluster on a dedicated port. Chromium checked 1440 × 1000, 1024 × 768, 761 × 900, 759 × 900, and 390 × 844 for page-level overflow, duplicate IDs, broken same-page anchors, and nested forms. All checks passed.
- Keyboard activation reached the four deductions links and three case review links on desktop and mobile. The document embed cannot authenticate from a file-based preview; the existing document route and new link were checked as markup.
- No routes, queries, authorization decisions, form contracts, or backend files changed. No backend-dependent work was needed.
