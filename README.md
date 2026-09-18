# recouple

Deductions recovery for CPG suppliers and their retail customers. A supplier
ships to a retailer, the retailer short-pays the invoice with a coded reason, and
somewhere between 5% and 15% of gross sales leaks out this way — most of it never
challenged because challenging it is slow, deadline-bound paperwork.

recouple is the paperwork, automated: ingest the notice → classify it → plan the
evidence → decide → assemble a packet in the retailer's required format → **a
human approves and files it** → detect the recovery → bill a share of what was
actually recovered.

It is a deterministic, human-gated workflow, not an autonomous agent. Genuine
agentic loops are reserved for two bounded steps: planning evidence, and
cold-starting an unknown retailer.

## The invariants

Seven rules the code is not allowed to break, enforced by the database rather
than by good intentions. In full in [CLAUDE.md](./CLAUDE.md); the two that shape
everything else:

- **Nothing goes out and nothing is written back to accounting without an
  approval row for that exact decision.** A Postgres trigger fails the
  transaction. There is no application-level path around it.
- **Truth is append-only.** Events, documents, decisions, approvals and the audit
  log take INSERT and SELECT only, hash-chained for tamper evidence. Corrections
  are new rows.

## Quickstart

Requires Node 20+, pnpm 10+, and a Postgres 16 you can throw away.

```bash
pnpm install
cp .env.example .env            # only DATABASE_URL matters for Phase 0

pnpm typecheck
pnpm test                       # 54 unit + property tests
pnpm db:test                    # migrations + 45 database invariant assertions
pnpm verify                     # all three, in the order CI runs them
```

`pnpm db:test` applies every migration to the database in `DATABASE_URL` and then
runs the invariant suites. Point it at a scratch database — the suites roll back,
the migrations do not.

Expected tail of `pnpm db:test`:

```
  ok — submission without an approval fails at the DB (blocked: submissions blocked: no submit approval row for decision …)
  ok — the trigger rejects UPDATE even for the table owner (blocked: append-only table deduction_events: UPDATE is not allowed)
  ok — a tenant cannot insert rows owned by another tenant (blocked: new row violates row-level security policy …)
database invariants: all suites passed
```

## Layout

```
recouple/
├─ packages/
│  ├─ core-domain/      money (integer cents), case state machine, reason codes, invariants
│  ├─ decision/         DecisionProvider contract, schemas A–D, state hashing
│  └─ adapters/         SubmissionChannel + EvidenceSource contracts
├─ supabase/
│  ├─ migrations/       append-only DDL, approval trigger, RLS policies
│  └─ tests/            invariant, RLS and separation-of-duties suites
├─ scripts/db-test.sh   applies migrations to a scratch DB, runs the suites
├─ docs/adr/            architecture decision records
└─ .claude/             hooks, slash commands (CLAUDE.md is at the root)
```

## Where the build is

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Foundations: append-only DDL, approval trigger, RLS, roles, money maths, state machine, contracts, CI | **done** |
| 1 | Ingest + classify: upload/email-in, malware scan, doc-type, extraction with source spans, case view | next |
| 2 | Evidence + decision: playbooks, cold start, Jev + Claude providers, confidence gates, calibration | — |
| 3 | Packet + approval + manual submission + outcomes | — |
| 4 | QBO write-back, attribution, Stripe contingency billing | — |
| 5 | Learning loop: override capture, candidate rules, backtest, shadow, promotion | — |
| 6 | Careful autonomy — only where per-tenant ECE < 0.10 is sustained | — |

Deliberately not built, by design rather than by omission: retailer portal
credentialed fetch, browser-agent auto-submission, EDI/carrier/3PL connectors,
NetSuite and Xero. Their interfaces exist (`SubmissionChannel`,
`EvidenceSource`), so each is a new implementation rather than a refactor.

### What Phase 0 does not do

No model is called, no money moves, no vendor API is contacted, and nothing is
reachable over HTTP. Phase 0 is the floor the rest is allowed to stand on:
tenancy, the approval gate, immutability, tenant isolation, exact money maths,
and the contracts the later phases implement.

## Working on it

Read [CLAUDE.md](./CLAUDE.md) first — it is the operating manual, and the hooks
in `.claude/` enforce part of it. Changes to `supabase/migrations/**` or to
`packages/*/src/invariants/**` need a numbered ADR in `docs/adr/` on the branch
before the edit; see [0001](./docs/adr/0001-record-architecture-decisions.md).

Why this project sits inside the Mozart repository, and how to extract it into
its own: [ADR 0002](./docs/adr/0002-recouple-lives-in-the-mozart-repository.md).
