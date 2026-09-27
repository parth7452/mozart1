# 06 — Build ADR 0060: QuickBooks write-back, gated and off

Branch: the session's branch (never a new one, never a PR). Migration **0037**,
SQL suite **33** (0036 / 32 are the latest locally; `git fetch` and check
`origin/main` and open PRs before taking either). Do sub-tasks 06.1 → 06.4 in
order, one commit each, `pnpm typecheck` + that sub-task's tests before each.

## Goal
Build `docs/adr/0060-a-deductions-accounting-is-posted-to-quickbooks.md` as far
as it can be built and tested with **no real QuickBooks call**: account map,
posting switch, write methods with idempotent request id and read-back, a
posting job, and the approve-and-post UI. It ships **inert**.

## Why
The journal drafts (`packages/core-domain/src/journal.ts`, plan 03) are shown
but booked by hand. ADR 0060 is *proposed*; the founder asked for it ready.

## How it stays inert (all three must hold; each is tested)
1. **Gate.** Nothing is sent unless a `writebacks` row exists — which the
   database admits only under an `approvals` row (`app.require_approval()`,
   migration 0005/0010; untouched). Write-offs likewise need a `writeoffs` row.
2. **Switch.** `accounting_connections.posting_enabled boolean not null default
   false`, true only while the connection has a map, writable only by an owner
   (`app.member_is_owner()`), one `audit_log` row per change. No code path sets
   it except the owner's explicit POST from Settings → QuickBooks. A moved
   connection is a new row, so it starts off.
3. **Deployment.** `qboPostingFromEnv` (shape of `scannerFromEnv`): without
   `QBO_POSTING=1` the job refuses before building a request and the switch is
   hidden. Nobody sets `QBO_POSTING` anywhere in this work — not Vercel, not
   `.env.example` defaults. Sandbox (`QBO_ENVIRONMENT=sandbox`) is the only
   place it is ever first turned on, by the founder, after acceptance.

## What exists today
- `writebacks` (migration 0005:37): `method in ('credit_memo_offset',
  'reversing_journal_entry', 'payment_adjustment')`, `status pending|succeeded|failed`,
  `qbo_txn_id`, `request_id text unique`. Immutable core in 0017 (`method`).
- `decisions.schema_id in ('A','B','C','D')` (0003:72). Human decisions are
  `HUMAN_SCHEMA_ID = 'B'` (`packages/store-postgres/src/workflow.ts:105`).
- `packages/qbo/src/client.ts`: read-only `QboClient` (`queryWindow`,
  `queryByIds`), sets a random `Request-Id` header per request (:223-227).
  `money.ts` has `qboAmountToCents` only. `tokens.ts:33`
  `QboTokenStore.withRefreshLock(realmId, work)`.
- Jobs: `apps/web/lib/inngest-ledger.ts` (`sync-ledger` acts as a member,
  asks `memberMayWrite`); alerts `apps/web/lib/alerts.ts` (ADR 0052).
- Case page actions under `apps/web/app/cases/[id]/` (`approve`, `outcome`,
  `decline`, …); settings under `apps/web/app/settings/quickbooks/`.

## Founder's decisions — defaults taken (ADR 0060 "What the founder decides")
1. Order: build now, inert (the founder's ask). Nothing turns on.
2. Recovery: apply the payer's **existing** Payment to our entry (recommended).
3. Moment 1 is **one button** writing `submit` + `writeback` approvals.
4. Settlement is a **schema `S` decision**; no new approval actions.
5. A declined case with no dispute decision books to `unclassified_writeoff`.
6. `QBO_POSTING` in Production: **not in this work**; the founder's call.

---

## 06.1 — Migration 0037 + SQL suite 33 (needs the DB)
Files: `supabase/migrations/20260928100000_0037_a_deductions_accounting_is_posted.sql`,
`supabase/tests/33_posting_is_gated_and_off.sql`. The branch carries ADR 0060,
so the PreToolUse hook allows the edit.

Build ADR §4 exactly:
- `ledger_account_maps(id, org_id, connection_id, seq bigserial, ar_account_id,
  deductions_receivable_account_id, writeoff_by_family jsonb,
  unclassified_writeoff text, created_by, created_at)`; composite FK
  `(org_id, connection_id)` (ADR 0025 §7 pattern, as `accounting_credentials`
  in 0025); check that `writeoff_by_family`'s keys equal `REASON_FAMILIES`
  (grep `core-domain/src/reason-codes.ts` for the list); `created_by =
  app.current_user_id()` trigger; RLS; INSERT policy `app.member_is_owner()`;
  append-only on 0004's pattern (revoke UPDATE/DELETE, `no_update_delete`,
  `no_truncate` on `app.block_mutations()`); `app_rw` SELECT+INSERT, `app_ro` SELECT.
- `writebacks` add `connection_id`, `account_map_id`, `amount_cents bigint`,
  `lines jsonb`; add them to 0017's immutable-core branch (restate the function
  in full — never edit 0017); widen `method` to add `journal_entry`,
  `payment_application`; `unique (decision_id, method)`; `succeeded` final and
  `qbo_txn_id` write-once (trigger). No new UPDATE grant beyond what `status`
  already has.
- `decisions.schema_id` admits `'S'` (drop/re-add the check by name).
- `accounting_connections.posting_enabled boolean not null default false` +
  trigger: true only if a map row exists for the connection; change only by an
  owner.
Suite 33 asserts: posting_enabled defaults false; a non-owner cannot set it
or insert a map; true refused without a map; maps refuse UPDATE/DELETE; a
`writebacks` insert with no approval still raises (gate intact); succeeded
cannot go back; `qbo_txn_id` cannot change; request roles hold nothing; every
new `app` function pinned. Count only the suite's own orgs' rows.

Verify: `env -u DATABASE_URL TEST_DATABASE_URL=postgres://tester:tester@127.0.0.1:5432/recouple_test RECOUPLE_TEST_DATABASE=1 pnpm db:test`
(start the cluster with `pg_ctlcluster 16 main start` if `pg_lsclusters` shows it down).

Acceptance: [ ] suites 01, 24, 33 green [ ] no UPDATE/DELETE grant on any
append-only table (suite 24) [ ] migration never applied remotely.

## 06.2 — Money formatter and QBO write methods (no DB)
Files: `packages/qbo/src/money.ts`, `packages/qbo/src/client.ts`,
`packages/qbo/src/posting.ts` (new), `packages/qbo/src/map.ts`,
tests under `packages/qbo/test/`.
- `centsToQboAmount(cents: Cents): string` — string maths, no float;
  property test round-trips with `qboAmountToCents`.
- `QboClient.post(entity: 'JournalEntry' | 'Payment', body, requestId: string)`
  and `QboClient.getById(entity, id)`; the caller's `requestId` (= writeback row
  id) is sent as **both** `requestid` query param and `Request-Id` header (the
  sandbox run settles which is honoured); reads keep `randomUUID()`.
- `posting.ts`: `buildFoundEntry`, `buildSettlementEntry`, `buildZeroPayment`
  from `draftEntries` output + map row only (no document text, memo = case id,
  canonical reason, our reference; `DocNumber`/`PaymentRefNum` stamped from the
  row id; date = approval day). `verifyReadBack(sent, got): 'match' | {mismatch: string[]}`
  compares customer, date, each line's account, side, cents, payment link.
- `map.ts`: a Payment line linked to a `JournalEntry` pairs as a credit, like
  ADR 0036's CreditMemo pairing (Consequences §1), else the sync throws
  `QboMalformedResponse` on our own zero Payment.
- Token refresh stays inside `withRefreshLock`; no new lock.
Tests: fake `FetchLike` only; hand-written fixtures under
`packages/qbo/test/fixtures/posting/` marked synthetic (no recording).
Assert request id reuse on retry, read-back mismatch, zero-Payment sync pairing.

## 06.3 — Store + posting job (needs the DB)
Files: `packages/store-postgres/src/posting.ts` (new) + `index.ts` export,
`packages/store-postgres/src/workflow.ts`, `packages/pipeline/src/posting-job.ts`,
`apps/web/lib/qbo-posting.ts` (`qboPostingFromEnv`), `apps/web/lib/inngest-posting.ts`,
`apps/web/lib/alerts.ts`.
- Store: `saveAccountMap` (reads accounts live, checks types AR / Other Current
  Asset / Expense|Other Expense), `setPostingEnabled` (owner, audit row),
  `prepareSettlementDecision` (schema `S`, `result = {outcome, recovered_cents,
  family, invoice_id, payment_id?}`), `insertWriteback` (row `pending`,
  `request_id = id`), `recordWritebackAttempt` (a `deduction_events` row +
  status), `mapAtApproval(approvedAt)`. Refuse a `writeoffs.amount_cents`
  different from the entry's expense debit. Narrow the latest-decision read in
  `workflow.ts` to `schema_id = 'B'`.
- Job `post-writeback` keyed on the writeback id, concurrency 1 per connection,
  `retries: 0` on the send step; as `app_rw` with the approver's claims,
  `memberMayWrite` first; refuse if `!qboPostingFromEnv()` or
  `!posting_enabled`. 2xx → read back → `succeeded`+`qbo_txn_id` or `failed
  readback_mismatch`; timeout/5xx → `failed`. Payment only after its entry
  verifies. Logs: ids, status, fault code only.
- Add `post-writeback` to `alert-on-failure`'s list.
Tests: `packages/store-postgres/test/posting.test.ts` (DB), `packages/pipeline/test/posting-job.test.ts`
(fake client), `apps/web/test/fail-closed.test.tsx` gains: no `QBO_POSTING` → no poster.

## 06.4 — UI: settings switch, approve-and-post, retry (web)
Files: `apps/web/app/settings/quickbooks/page.tsx`, new route
`apps/web/app/settings/quickbooks/posting/route.ts` (and `account-map/route.ts`),
case page `apps/web/app/cases/[id]/page.tsx`, `approve/route.ts`, new
`settle/` and `retry-writeback/` routes, views in `apps/web/components/`.
- Settings: map form + switch, owner only, hidden unless `QBO_POSTING`.
- Moment 1: when posting is on, the approve card's one button writes `submit`
  and `writeback` approvals in one transaction; label says both.
- Moment 2: outcome/decline prepares a schema `S` decision; another member
  approves (never the preparer; SoD unchanged) → `writeback` (+ `writeoff` when
  A − R > 0).
- "Check QuickBooks and retry" reads back by reference first.
Every POST refuses cross-site. Tests in `apps/web/test/`. Verify also
`env -u DATABASE_URL pnpm build:web` (no page and route at one path).

---

## Verification (every sub-task)
`pnpm typecheck`; DB: `env -u DATABASE_URL TEST_DATABASE_URL=postgres://tester:tester@127.0.0.1:5432/recouple_test RECOUPLE_TEST_DATABASE=1 pnpm db:test`
then the same prefix with `pnpm test`; web: `pnpm build:web`.

## Acceptance
- [ ] `posting_enabled` false on every existing and new connection; only an owner flips it.
- [ ] No request built without `QBO_POSTING` **and** the switch **and** an admitted row.
- [ ] Amounts only from `draftEntries`; no model; integer cents to a string.
- [ ] Request id = writeback id; a retry reuses it; no automatic resend.
- [ ] `require_approval` / `enforce_separation_of_duties` untouched.
- [ ] No test touches the network; no cassette recorded.

## Pitfalls
- `writebacks.status` is mutable today; `succeeded` must become final by trigger, not by grant.
- The memo must never carry `Payer reason as printed:` (invariant 4).
- Don't put `LocalTokenCipher` or fakes in production imports.
- A second press must hit `unique (decision_id, method)`, not create a row.
- Never back-date; never debit a cash account; never create a money Payment.

## Out of scope
Sandbox recording (founder, after acceptance); in-app reversal; void/delete in
QuickBooks; NetSuite/Xero; setting `QBO_POSTING` anywhere; accepting ADR 0060.

## Open questions (default used)
- Query param vs header for request id → send both.
- Invoice pick for non-ledger cases → preparer picks from a live read, stored in `result`; without one, no found posting.

## Depends on
Plan 03 (`journal.ts`), ADR 0039 (connect/lock), ADR 0052 (alerts).
