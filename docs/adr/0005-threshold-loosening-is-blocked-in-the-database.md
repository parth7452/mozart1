# 0005 — Threshold loosening is blocked in the database, not in review

- Status: accepted
- Date: 2026-09-18

## Context

Invariant 7 says thresholds auto-tighten and never auto-loosen: raising an
auto-dispute ceiling or lowering a confidence floor takes a human and an ADR.
Stated as prose, this is exactly the kind of rule that erodes — a plausible
one-line change during an incident, and nobody notices for a quarter. The
learning loop is also designed to adjust thresholds automatically, so the
constraint has to hold against our own code, not just against a careless human.

## Decision

`app.guard_threshold_direction()` on `org_settings` fails any UPDATE that raises
a ceiling or lowers a confidence floor, unless the transaction first names the
authorising ADR:

```sql
select set_config('app.threshold_loosening_adr', 'ADR-0042', true);
```

Tightening needs nothing. `assertThresholdDirection()` in
`packages/core-domain/src/invariants` mirrors the rule in TypeScript so the UI
can explain the refusal before a request is sent; the database remains the
authority.

## Consequences

Raising a ceiling is a two-step operation with a paper trail, including for
automated tuning — which is the intent. The GUC is transaction-scoped, so it
cannot leak into the next statement on a pooled connection.

A GUC is a declaration, not an authorisation: anything that can execute SQL can
set it. It stops the accidental loosening it was built to stop, and leaves a
named ADR in the audit trail; it is not a defence against a hostile insider.

## Invariants touched

Invariant 7, now enforced rather than described. Tested in
`05_threshold_direction.sql` and `invariants.test.ts`.

## Rollback

Drop the trigger. That is itself a loosening, so it needs an ADR of its own.
