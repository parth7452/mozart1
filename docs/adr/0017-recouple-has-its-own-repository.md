# 0017 — recouple has its own repository

- Status: accepted
- Date: 2026-09-18
- Supersedes: [0002](./0002-recouple-lives-in-the-mozart-repository.md)

## Context

[ADR 0002](./0002-recouple-lives-in-the-mozart-repository.md) put this project in
a subdirectory of `parth7452/Mozart`, because the session building it had write
access to exactly one repository and creating a new one is the owner's call. It
recorded the extraction as one command and listed what the arrangement cost.

Both costs came due at once. Vercel builds a project from a repository's
production branch, and everything here lived on a feature branch of a repository
whose `main` holds a different application — so a Vercel import found no
`apps/web` at all. And `.github/workflows/ci.yml` had never run a single time,
because GitHub reads workflows only from the repository root.

The owner created the repository. The extraction is the command ADR 0002 wrote
down.

## Decision

```bash
git subtree split --prefix=recouple -b recouple-only
# push that branch to the new repository's main
```

History is preserved rather than squashed. Twenty-two commits, each of which
names a defect and the test that catches it, are the record of how this thing
was built — a fresh "initial import" would throw away the part of the repository
that is hardest to reconstruct and most useful to read.

`main` is the production branch, so the Vercel root directory is `apps/web`
rather than `recouple/apps/web`.

## Consequences

**CI runs now.** `.github/workflows/ci.yml` sits at the root and does what it
always said it did: typecheck, apply every migration to a scratch Postgres and
run the invariant suites, then the unit and integration tests, then the evals
against recorded cassettes, then build the app. It has been correct and inert
since Phase 0; this is the first time it is load-bearing. Expect the first run to
find something, because a gate that has never run is a gate nobody has tested.

**The Mozart repository still has its copy** under `recouple/`, now a fork in the
road rather than the source of truth. It should be deleted once this repository
is confirmed working, or the two will drift and the drift will be discovered at
the worst moment.

**The plan's original instruction is now literally satisfied.** It said "a
standalone monorepo (`recouple/`) … do not embed inside 'Mozart'". ADR 0002
honoured the intent while breaking the letter; this honours both.

## Invariants touched

None. Every invariant is enforced inside this project's own database and
packages, and none of them knew where the git remote pointed.

## Rollback

There is nothing to roll back to that is better. The Mozart copy exists until
someone deletes it.
