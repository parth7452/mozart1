# 0006 — Phase 0 tooling: no Turborepo, no app, yet

- Status: accepted
- Date: 2026-09-18

## Context

The plan's stack includes Turborepo for the monorepo and Next.js 15 on Vercel
for the app. Phase 0's deliverable is foundations: the invariants, the domain
maths, the contracts, CI. There is nothing to build (no compile step, no bundle)
and no page to render, so both tools would arrive as configuration with nothing
yet to configure.

## Decision

Phase 0 ships pnpm workspaces, `tsc --noEmit` for typecheck and Vitest for
tests, run from the workspace root. Turborepo arrives with the first real build
step or when task caching starts paying for itself. `apps/web` arrives with
Phase 1, which is when there is an upload surface and a case view to put in it,
and it brings Supabase Auth with it.

The packages are already shaped for both: each is a workspace package with its
own manifest, and `apps/*` is already in `pnpm-workspace.yaml`.

## Consequences

Phase 0 has no auth, which the plan lists under Phase 0. Nothing is reachable
over HTTP yet, so there is nothing to authenticate; the tenancy model auth will
attach to (`organizations`, `memberships`, roles, RLS policies keyed on JWT
claims) is in place and tested. Phase 1 must not ship a route before Supabase
Auth is wired in.

## Invariants touched

Invariant 6. RLS policies read `request.jwt.claims` via `app.current_org_id()`,
which is what Supabase Auth populates; the suite exercises them by setting the
same GUC, so the policies are tested before auth exists rather than after.

## Rollback

Add Turborepo and a Next.js app whenever either earns its place. Neither
decision constrains the other.
