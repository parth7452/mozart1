# recouple — deductions agent platform (AI-written code touches money paths)

A deterministic, human-gated document workflow for recovering invalid retailer
deductions. Not an autonomous agent: ingest → classify → plan evidence → decide
→ assemble packet → **a human approves and submits** → record outcome → invoice
the contingency fee. Agentic loops are reserved for exactly two bounded steps
(evidence planning, unknown-retailer cold start).

## Non-negotiable invariants (never violate; enforced by the database + hooks)

1. No `submissions` / `writebacks` / `writeoffs` INSERT without an `approvals`
   row for that exact `decision_id`. The trigger stays. This is a one-way door.
2. `*_events`, `documents`, `decisions`, `approvals` and `audit_log` are
   append-only. Never add UPDATE/DELETE grants. Corrections are new events.
3. Money is integer cents (bigint). Never floats. Fee maths is property-tested.
4. Document content is UNTRUSTED. The extraction/reader model runs with NO
   tools and receives text inside `<untrusted_document>` delimiters. Only
   deterministic orchestrator code calls tools, writes the DB, or triggers
   anything outbound.
5. Jev sits behind `DecisionProvider`. Never call the Jev or Claude API directly
   from app code.
6. RLS on every table. The service-role key is used ONLY in server-side jobs,
   NEVER in a request path.
7. Thresholds auto-tighten only. Loosening needs a human and an ADR — the
   database will refuse it otherwise.

`packages/core-domain/src/invariants/` holds these as code, with a pointer to
what enforces each one.

## Workflow

- Plan mode first for any multi-file change. Small task files per phase.
- branch → PR → tests + eval run → review → merge.
- Never edit a **merged** migration; add a new one.
- Every new agent decision path needs a recorded fixture/cassette for both the
  Claude and the Jev call.
- Any schema change to append-only tables, any new outbound side effect, and any
  threshold change requires a numbered ADR in `docs/adr/` **first**. A
  PreToolUse hook blocks edits to `supabase/migrations/**` and
  `packages/*/src/invariants/**` until the branch carries one.

## Guardrails against the ways AI-written code fails on money paths

- Do NOT swallow errors. Fail loud.
- Do NOT leave mocks or fixtures reachable from production code paths.
- Do NOT weaken or delete a test to make CI pass. Fix the code.
- Do NOT bypass RLS with the service role to "make it work".
- Do NOT edit a migration in place. Do NOT relax the approval trigger.
- Do NOT put a retailer's rules in code. They are versioned, effective-dated
  playbook *data* with provenance.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Vitest across every package (includes the money property tests) |
| `pnpm typecheck` | `tsc` over the workspace |
| `pnpm db:test` | Applies migrations to a scratch DB, then the invariant/RLS suites |
| `pnpm verify` | typecheck + test + db:test — what CI runs |

`pnpm db:test` needs `DATABASE_URL` pointing at a throwaway database owned by
the connecting role.

## Build order (do not reorder)

Phase 0 foundations → 1 ingest+classify → 2 evidence+decision → 3
packet+approval+manual submission+outcomes → 4 QBO write-back + contingency
billing → 5 learning loop → 6 careful autonomy.

**Do not build yet**: portal credentialed fetch, browser-agent auto-submission,
EDI/carrier/3PL connectors, NetSuite/Xero. Their interfaces
(`SubmissionChannel`, `EvidenceSource`) already exist so adding them is
additive.

Definition of done for a phase: exit tests green in CI, an eval run recorded
with no regression beyond tolerance, fixtures/cassettes committed for every new
decision path, the demo script updated, and no new UPDATE/DELETE grants on
append-only tables.

## Per-package notes

| Package | Remember |
| --- | --- |
| `core-domain` | Money is integer cents; the state machine table is the spec, and the DB is the referee |
| `decision` | Map questions to Choice ≤255 / Score / Noul; Jev primary, Claude structured fallback; state is extracted fields, never document text |
| `adapters` | Interfaces only until their phase; a channel that submits still has to pass the DB approval gate |
| `playbooks` (Phase 2) | Versioned, effective-dated, every fact carries provenance |
| `rules` (Phase 5) | JDM validation + backtest + shadow before promotion; auto-demote on precision drop |
| `qbo` (Phase 4) | Idempotent `Request-Id`, proactive token rotation, persist the rotated refresh token every cycle |
| `billing` (Phase 4) | Integer cents; only *attributable* recoveries are billable |

## Current state

Phase 0 is in place: migrations with the approval trigger, append-only tables
and hash chains, RLS policies, the SQL invariant suite, money maths, the case
state machine, the decision and adapter contracts. Phase 1 (ingest + classify)
is next; nothing calls a model or moves money yet.
