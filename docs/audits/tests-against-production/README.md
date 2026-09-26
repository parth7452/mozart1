# The integration tests ran against production

*Incident note, 2026-09-26. What happened on 2026-09-25 at 22:46 UTC, what it
left, and what now stops it happening again. Nothing here deletes anything.*

## What happened

Between 22:46:04 and 22:46:35 UTC on 2026-09-25, the Postgres integration tests
(Vitest: `packages/store-postgres/test/*.test.ts` and the others that read the
database URL) ran against the **production** database, Supabase project
`hvheqbgkvwhlqutklwfh`, connected as its owner role `postgres`.

Production's Postgres logs for that window show:

- 125 × `permission denied to set role "app_rw"`. Since migration 0028 (ADR
  0037), `postgres` cannot `set role app_rw`, so most tests failed straight after
  their fixture setup, which runs as the owner.
- From `operator-login.test.ts`: `create role rc_link_a9e6232f login …`,
  `grant app_rw … with inherit false, set true` and `drop role if exists
  rc_link_a9e6232f`.
- From `ledger-connections.test.ts`: `alter table accounting_connections drop
  constraint accounting_connections_provider_check`, then re-adding
  `check (provider in ('qbo'))`.

Checked afterwards: the constraint matches migration 0024 again and the role is
gone. No row in the real workspace (`recouple`) was touched, and no model call
was made.

## What it left

The fixture setup that did succeed wrote, permanently:

| Table | Rows |
| --- | --- |
| `organizations` | 72 (slugs such as `wf-contract-1-c7f58546`, `led-54e54bdb`, `seal-b734b47a`) |
| `users` | 103, every one `@example.test` |
| `deductions` | 507 |
| `documents` | 19 |
| `debtors` | 17 |
| `accounting_connections` | 7, 6 of them enabled |

The founder disabled the six enabled connections by hand at about 01:10 UTC on
2026-09-26, so the daily ledger sync does not fan out to them.

**The rows stay.** Most of these tables are append-only by design (CLAUDE.md
invariant 2): no role holds UPDATE or DELETE, and a trigger refuses the owner
too. That is the property that makes a packet survive a post-audit, and it is
not relaxed for a cleanup. They sit in their own 72 organizations under RLS, so
no member of a real tenant can see them, but any count taken across the whole
fleet (organizations, users, cases) includes them. A cleanup, if one is ever
wanted, needs its own ADR first.

## How it happened

The most likely mechanism, from the repository as it stood:

1. `.claude/settings.json` has a **Stop hook** that runs
   `pnpm typecheck && pnpm test` after every Claude Code turn.
2. `vitest.setup.ts` did `import 'dotenv/config'`, loading all of the
   repository's `.env` into every test worker.
3. The operator commands (`pnpm link:retailer`, `pnpm sweep:inbound` and the
   rest) read `DATABASE_URL` from that same `.env`. It is meant to name the
   `recouple_app` login; in the clone that ran, it named production as
   `postgres`.
4. The integration tests read `DATABASE_URL` too, and skipped only when it was
   unset. Nothing asked whether it named a throwaway. `scripts/db-test.sh` said
   so in a comment, and one test (`only-the-app-roles-hold-grants.test.ts`)
   refused a cluster with a `recouple_app` role, but that test was one of many,
   not a gate in front of them.

So in that clone every Claude Code turn ran the integration suite against
production.

## What stops it now

- **The tests have their own variable.** Every integration test reads
  `TEST_DATABASE_URL`. `DATABASE_URL` belongs to the app and the operator
  commands, and no test reads it.
- **A test run takes two variables from `.env` and no others**:
  `TEST_DATABASE_URL` and `RECOUPLE_TEST_DATABASE`. Not `DATABASE_URL`, and no
  vendor key (`vitest.setup.ts`, `scripts/db-test.sh`).
- **The test-database guard** (`scripts/test-database.ts`) runs once before any
  test file loads (`vitest.global-setup.ts`), and again before `pnpm db:test`
  applies anything (`scripts/check-test-database.ts`). A refusal fails the run
  and names the guard. It refuses:
  - a Vitest process whose environment holds `DATABASE_URL`, whatever it names,
    because product code under test reads it;
  - a `TEST_DATABASE_URL` without `RECOUPLE_TEST_DATABASE=1`, and the opt-in
    without a URL (in CI, that would quietly skip every integration test);
  - a Supabase host (`*.supabase.co`, `*.supabase.com`, which covers the
    pooler), decided from the URL before anything connects;
  - a database that, asked in one read-only transaction, has a `recouple_app`
    login, a `supabase_admin` role or applied migrations in
    `supabase_migrations.schema_migrations`. `pnpm db:test`'s scratch database
    has none of the three; every Supabase cluster has `supabase_admin`, and
    production and `mozart-preview` both have `recouple_app`;
  - a database it cannot reach to ask.

  There is no override.
- **The Stop hook** runs `env -u DATABASE_URL pnpm --silent test`: the
  operator's variable is removed from its environment, and the guard still
  covers whatever `TEST_DATABASE_URL` names. With this incident's `.env` (a
  production `DATABASE_URL` and nothing else), the hook now runs the unit tests
  and skips the Postgres ones.
- **CI** sets `TEST_DATABASE_URL` and `RECOUPLE_TEST_DATABASE=1` for its
  `postgres:16` service, and no `DATABASE_URL`.
- `scripts/test/test-database.test.ts` pins what the guard refuses without
  connecting, and what it takes from `.env`.

## What it does not stop

- An operator command run against production. That is what those commands are
  for, and they connect as `recouple_app`, never the owner (ADR 0034).
- A test that builds its own connection from a hard-coded URL instead of
  `TEST_DATABASE_URL`. None does today.
- A real database that is not on Supabase and carries none of the three
  catalogue signals. For that, the opt-in is the only check: set
  `RECOUPLE_TEST_DATABASE=1` only next to a URL for a database you are willing
  to fill with rows that can never be deleted.
