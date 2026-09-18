# 0004 — Decisions and approvals are append-only too

- Status: accepted
- Date: 2026-09-18

## Context

The plan lists `*_events`, `documents` and `audit_log` as append-only. It does
not list `decisions` or `approvals`, but both are written exactly once and both
are evidence: a decision row is what we told the customer the model concluded,
and an approval row is the record of a human authorising money to move. An
approval that can be rewritten after the fact is not an approval, and the
repudiation threat in the plan's own threat model ("I didn't approve that") is
only answered if the row is immutable.

Two other tables were considered and deliberately left mutable: `deductions`
(its `state` column is a projection of the event stream) and `submissions`
(status and confirmation number arrive after the row is created).

## Decision

Apply the same `app.block_mutations()` trigger to `decisions` and `approvals`,
and grant the application role INSERT and SELECT only. A correction to a
decision is a new decision row with a new `input_state_hash`; a withdrawn
approval is a new event, not an edited row.

## Consequences

Any code that wanted to "fix up" a decision must write a new one, which is the
behaviour we want and slightly more work than an UPDATE. Reviewer-facing UI must
show the latest decision per deduction rather than assume one row per case.

## Invariants touched

Invariant 2, extended to two more tables. Enforcement: trigger plus revoked
grants in `20260918010500_0006_rls_and_grants.sql`; tested in
`01_append_only.sql`.

## Rollback

Drop the two triggers and restore UPDATE grants. Requires its own ADR, since it
loosens an invariant.
