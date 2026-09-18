# 0002 — recouple lives in the Mozart repository, as a self-contained monorepo

- Status: superseded by [0017](./0017-recouple-has-its-own-repository.md) on 2026-09-18
- Date: 2026-09-18

## Context

The build plan is explicit: recouple is "a standalone monorepo (`recouple/`) with
its own auth, tenancy, billing, UI, and deployment. Do not embed inside
'Mozart.' Reuse stack conventions, not code."

The session that started this build has write access to exactly one repository,
`parth7452/mozart`. Creating a new GitHub repository is the owner's call, not
something to do unilaterally. The alternatives were: stop and build nothing
until a repository exists, or build the standalone monorepo in a subdirectory
and keep it extractable.

## Decision

Build under `recouple/` in the Mozart repository, as a genuinely separate
project: its own pnpm workspace, its own `package.json`, `tsconfig`, `.env.example`,
CI workflow, `CLAUDE.md` and `.claude/` configuration. It shares no code, no
dependency tree and no database with Mozart, and imports nothing from `src/`.

Extraction into its own repository is one command and keeps the history:

```bash
git subtree split --prefix=recouple -b recouple-only
# then push that branch to the new repository's main
```

The plan's intent — separate auth, tenancy, billing, UI, deployment — is honoured.
Only the git remote differs, and only until someone creates one.

## Consequences

`recouple/.github/workflows/ci.yml` does not run while it sits here: GitHub only
reads workflows from the repository root. Until extraction, CI for this project
is `pnpm verify`, run locally or wired up by adding a root-level workflow that
sets `working-directory: recouple`.

Two `node_modules` trees and two test commands live in one checkout. Nobody
should run Mozart's `npm test` expecting recouple's suites, or vice versa.

## Invariants touched

None. Every invariant is enforced inside recouple's own database and packages.

## Rollback

Run the subtree split above and delete `recouple/` from Mozart.
