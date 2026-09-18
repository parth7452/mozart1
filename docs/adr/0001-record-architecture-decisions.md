# 0001 — Record architecture decisions

- Status: accepted
- Date: 2026-09-18

## Context

This codebase writes to accounting systems and bills customers a share of money
it recovers. Most of it will be written by an AI agent working from a build
plan. The failure mode that matters is not a bug but a quiet erosion: a guard
relaxed to make a test pass, a migration edited in place, a threshold nudged
because a case looked safe. Those changes are individually defensible and
collectively fatal.

## Decision

Every deviation from the build plan, every schema change to an append-only or
bitemporal table, every new outbound side effect, and every threshold change
gets a numbered ADR in `docs/adr/NNNN-<slug>.md` **before** the code, using
`0000-template.md`.

A PreToolUse hook (`.claude/hooks/require-adr.sh`) blocks edits to
`supabase/migrations/**` and `packages/*/src/invariants/**` on a branch that
carries no ADR. The hook is a reminder, not the authority: the reviewer is.

## Consequences

Small changes to guarded files cost a paragraph of writing. That is the point —
the cost is what makes the change deliberate. Unguarded files are unaffected.

## Invariants touched

None directly. This is the mechanism by which the other seven are allowed to
change at all.

## Rollback

Delete the hook from `.claude/settings.json`. The ADR history stays useful
regardless.
