# PR 28 integration

Plan: reproduce the PR-to-main merge in an isolated checkout; retain main's
workspace UI and identity guardrails while integrating ADR 0028's remittance
cases; verify the merged result, then update the PR branch without merging it.

## Phase 1 — Resolve (iteration 1 of at most 4)
- Conflicts: case-list.tsx, pipeline steps.ts, store-postgres store.ts.
- Keep the current CaseTable and move invoice rendering into it.
- Keep observed upload source and identity matching; use the bounded printed
  invoice parser and include both sets of store imports.
- Expose the existing typecheck and web build through `npm run build`.

## Phase 2 — Verify
- Check conflict markers and whitespace.
- Run `npm run build`, migrations on disposable Postgres, `npm test`, and evals.
- Review the combined identity and remittance behavior and fix integration bugs.

## Phase 3 — Deliver
- Commit the integration, push to PR 28's branch, and verify GitHub mergeability
  and CI on the resulting commit. Do not merge the PR.

## Local verification results
- Iteration 2: updated main's presentation fixture for the required
  `discoveredVia` field. No assertions removed or weakened.
- `npm run build`: passed (typecheck and Next.js production build).
- `pnpm verify`: passed; migrations applied twice, all database invariant/RLS
  suites passed, 70 test files / 989 tests passed, no recorded eval regression.
- Recorded eval coverage is 39 documents; existing unrecorded suites remain
  skipped by the harness. No live model calls or baseline changes.
- Conflict-marker scan of tracked files and `git diff --check`: clean.
