# 0031 — A ledger sync runs on a schedule, as a member

- Status: accepted
- Date: 2026-09-22

## Context

ADR 0029 built `syncLedger` — one window of one org's accounting ledger in,
cases, skips and counterfactual-log rows out, as a pure function over two ports.
It ended with a sentence naming what it did not do: "no scheduler. `syncLedger`
is a function; what calls it on a timer is a later change, and it goes through
the same `runnerFromEnv` split as everything else."

Nothing calls it. In production the function is dead code, which means the
coverage thesis — the ~70% of deductions a supplier never surfaces (STRATEGY §5)
— is still measured at zero by construction, and ADR 0030's denominator has no
ERP-discovered numerator to divide into. Four questions have to be answered
together to change that, and each one constrains the next:

1. **Which orgs have a ledger at all?** `syncLedger` takes an `orgId` and a
   source. Nothing anywhere says which tenants have connected QuickBooks, which
   company (`realmId`) they connected, or whether that connection is still
   wanted. A scheduler cannot fan out over a list that does not exist.
2. **Who does a cron act as?** Every write in this system happens as `app_rw`
   with a member's claims set transaction-locally, and the write policies ask
   `app.member_may_write()` (migration 0010). A timer has no session. The
   service-role key is invariant 6's one-line prohibition, so "run it as the
   service role" is not one of the options.
3. **What proves a sync happened?** A sync that ran and left no row is
   invisible. ADR 0030's coverage view slices discovered dollars by channel and
   period; a period with no `erp_sync` dollars in it is either a period where
   the ledger held no short-pays or a period nothing ever walked, and the view
   cannot tell those apart. That distinction is the difference between a
   coverage number and a guess.
4. **What happens on the days the vendor is not configured?** There is no
   production `QboTokenStore` — ADR 0026 left it as a port whose only
   implementation is in-memory under `@recouple/qbo/testing`, out of reach of
   any production path — and the Intuit app credentials are set nowhere. A
   scheduler shipped today would find nothing it can build. It must say so, per
   connection, without taking the rest of the fleet down with it.

## Decision

### 1. A connection is a registry row, and it holds no secrets

`accounting_connections` (migration 0024): `org_id`, `provider` (a check
constraint, `'qbo'` today), `provider_account_id` (QBO's `realmId`), `enabled`,
`created_by`, and timestamps. One row per org per provider account, uniquely.

It is the only table in this change that is **not** append-only, and for one
reason: `enabled` flips. A customer revokes consent, an operator turns a noisy
connection off, and both are states rather than events. So `app_rw` holds
SELECT, INSERT and UPDATE on it. It holds no DELETE and no TRUNCATE: a
connection that synced is named by every `ledger_sync_runs` row it produced, and
deleting it would orphan the record of what it walked. Disabling is the verb.

**No tokens, ever.** Not an access token, not a refresh token, not a client
secret, not an encrypted blob of any of them. CLAUDE.md puts credentials in
KMS-backed storage and never in an application table, and Intuit's refresh
tokens make the rule bite harder than usual: they are replaced on every refresh
and the old one dies immediately, so a row somebody can `select *` is a row that
leaks a live credential and a row an `update` can strand. The table names a
company; what proves we may read it lives elsewhere. `supabase/tests/20` asserts
the column list carries nothing matching `%token%`, `%secret%`, `%credential%`
or `%refresh%`, so a later migration that adds one fails there rather than in
review.

### 2. A run is an append-only row, written once, complete

`ledger_sync_runs`: the org, the connection, the window (`window_from`,
`window_to`), `started_at` and `finished_at`, the five counts
(`invoices_examined`, `opened_count`, `skipped_count`, `declined_count`,
`anomaly_count`), an `outcome`, an `error_class`, and `requested_by`.

Append-only on migration 0004's pattern — revoke UPDATE/DELETE/TRUNCATE, plus
`no_update_delete` and `no_truncate` on `app.block_mutations()`, because a grant
answers for `app_rw` and the trigger is what answers for the owner.

Which forces the shape ADR 0023 already argued for on `submissions`: the row is
**written when the run finishes**, with both timestamps on it, rather than
opened at the start and updated at the end. There is no row to update. A run
that is killed mid-flight therefore leaves nothing — that is the honest failure
and it is stated here rather than hidden: the job records a row for every
outcome it can observe, including the ones it did not like, and only a process
that dies between the read and the insert leaves a window with no record. The
Inngest run history is what shows that case, and the next day's overlapping
window is what covers it (§6).

`outcome` is one of four constants: `completed`, `not_configured`, `refused`,
`failed`. `error_class` is a **class name and never a message** — the same rule
`asJobFailure` follows in `apps/web/lib/inngest.ts`, for the same reason: a
message off this path can quote a ledger's own text, and a run row is not a
place to keep a third party's data. A check constraint says a `completed` run
carries no `error_class`, so "it worked" and "here is what went wrong" cannot
both be true of one row.

### 3. The sync acts as the connection's `created_by`, and asks the database

The member who connected the ledger is the member the sync acts as. Their id
goes on the connection row, the fan-out puts it in the event, and the handler
builds `PostgresStore` and `PostgresDiscoveryStore` as `app_rw` with exactly
those claims — the same construction a request makes, transaction-locally, the
same one ADR 0021 chose for the read job. A cron is not a privileged context.

Before anything is read it asks `memberMayWrite` of the database, the way
`readDocumentJob` does and for the same reason ADR 0021 gives: an event is a
signed message naming an org and a user, and the signature says Inngest
delivered it, not that the pair is real. `tenant_read` is gated on the org claim
alone, so without that question a payload pairing one tenant's org with any user
id would be read and paid for at the vendor before the first write refused it.

If the answer is no — the member was downgraded to `read_only`, or removed from
the org — **nothing is read and the run is recorded as `refused`**. Not thrown:
a refusal is a fact about the connection, not a transient failure, and the row
is what makes it actionable ("this connection's owner can no longer write; move
it or disable it") instead of a retry three times an hour. Nothing is swallowed
either — the row exists, the handler logs it, and the counts are all zero.

Why the connecting member rather than a synthetic service member: a service
member is a writer nobody is, and separation of duties (invariant 1, migration
0016) only means anything while every row names a person. Every case this sync
opens is attributed to somebody who exists and whose rights the database
re-checks on every run. The cost is stated plainly: a connection outlives the
employment of the person who made it, and the answer to that is to move the
connection (a new row, `created_by` somebody current) rather than to invent an
identity. The `refused` outcome is what makes the stale case visible on the day
it happens.

### 4. The run row is written through one definer function, bounded by the caller's own claims

`app.record_ledger_sync_run(...)` is `security definer`, granted to `app_rw`,
revoked from `public`, and it is the **only** way a `ledger_sync_runs` row is
written: `app_rw` holds SELECT on that table and no INSERT at all.

It exists because §3 and §2 collide. The row that has to be written is precisely
the row whose acting member may no longer write: `tenant_insert` asks
`app.member_may_write()`, so the refusal could not record itself. Recording it
is the whole point.

It is definer to escape that one check, and nothing else. Two guards inside it
make it reach no further than its caller already reaches:

- `p_org_id` must equal `app.current_org_id()`. The function cannot write
  outside the tenant whose claims the caller is running under, so it is not a
  cross-tenant door and it is not the service role in a costume.
- `p_requested_by` must equal `app.current_user_id()`. A run row always names
  the member the job actually acted as, and cannot be attributed to somebody
  else.

Plus the ordinary consistency checks the foreign keys do not make: the
connection must exist and must belong to that same org, and the window must not
run backwards. RLS still applies to every other table on this path; this
function writes one append-only table, authorises nothing, and touches no gate
function.

### 5. The cron lists connections across every org, through ids only

The fan-out has no tenant: it has to know which orgs to fan out to before it can
adopt any org's claims. `app.ledger_connections_to_sync()` is `security definer`
and `stable`, granted to `app_rw`, revoked from `public`, and returns four
columns for each **enabled** connection: `connection_id`, `org_id`, `provider`,
`created_by`. Ids and a closed-set string. Not `provider_account_id`, not the
org's name, not a row of anything — the handler reads the connection row it was
sent, under that tenant's own claims, through RLS, and that read is where
`provider_account_id` comes from.

This is `app.my_orgs()`'s shape (migration 0012) with the claims removed rather
than a new kind of thing, and the reason it is not the service role is exact:
the service-role key bypasses RLS on every table for every caller that holds it,
in a request path, at the API layer. This bypasses one policy on one table and
hands back ids.

What it does expose, said out loud: any caller holding `app_rw` can learn which
org ids have an enabled connection and who owns it. That is no new reach —
`app.current_org_id()` reads a session setting the caller sets itself, so
anything holding the application's connection string can already adopt any
tenant's claims and read that tenant's rows. The application never calls this
function from a request path; only the fan-out does.

### 6. A trailing window, overlapping on purpose

`LEDGER_SYNC_WINDOW_DAYS = 35`, and the schedule is a named constant
(`LEDGER_SYNC_SCHEDULE`, daily). Each run walks `[today − 34, today]` in UTC, so
consecutive daily runs overlap by 34 days. The overlap is the design, not
slack: ADR 0026 §"window" says a caller walking month by month will see a
transaction dated on a boundary twice and that dedup is the caller's job, a
payment can be applied to an invoice days after either was dated, and a run that
is killed mid-flight leaves no row — an overlap is what covers all three
without anybody having to notice.

The overlap costs nothing because `syncLedger` is repeat-safe, and it is worth
saying exactly where, from reading it rather than from assuming:

- An invoice whose short-pay became a case on day 1 has its
  `ledger_invoice_id` in `deduction_identifiers` by day 2, so `resolveIdentity`
  answers `exact`, `triageCandidate` answers `skip_exact_match`, and the only
  write is `ensureIdentifiers` — no second case (ADR 0029 §3). This is the
  branch that carries the overlap.
- Even without that, `recordLedgerCase` hashes the canonical extract: unchanged
  ledger state produces the document already stored, and if that document is
  already a case's notice it returns that case with `reused: true` and writes
  nothing new.
- A candidate declined on day 1 is declined again on day 2 with
  `written: false`, because a decline is unique per invoice and policy version.

So a second pass over the same 34 days writes identifier rows that already
exist and nothing else. The counts on the run row reflect that — day 2's
`skipped_count` is day 1's `opened_count` — which is a feature: a run whose
skips suddenly fall to zero is a run that lost its identity rows.

`remittance_dedup_days` and the other per-tenant knobs stay where they are. The
window is a constant in code, not a threshold in `org_settings`, because
lengthening it is strictly more conservative and shortening it is a code change
with an ADR behind it — there is nothing here for
`app.guard_threshold_direction()` to guard.

### 7. Fail closed per connection: `not_configured` is an outcome, not an exception

`accountingSourceFromEnv` follows `scannerFromEnv` and `runnerFromEnv` exactly
(ADR 0018, ADR 0021): one place answers "can this deployment read a ledger", and
it answers with a typed value rather than by throwing or by building something
that throws on use.

It is configured only when `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, a
`QBO_ENVIRONMENT` of `sandbox` or `production`, **and** a token store are all
present. Today the last one is never present: `qboTokenStoreFromEnv` returns
nothing, because the only `QboTokenStore` in this repository is the in-memory
one under `@recouple/qbo/testing` and ADR 0026 put it there specifically so no
production path can reach it. So every connection today gets a run row with
outcome `not_configured` and a reason in the log, no vendor call, no exception,
and the next connection in the fleet is unaffected — each connection is its own
event and its own Inngest run.

Half-configured is configured wrong and says so: a `QBO_ENVIRONMENT` that is
neither `sandbox` nor `production` throws out of the factory rather than
defaulting, because ADR 0026 refused to default that value and production is not
a fallback for a missing one.

**The KMS token store is out of scope and named.** `QboTokenStore` is the port;
what is missing is an implementation that keeps `{accessToken, refreshToken,
accessExpiresAt, refreshExpiresAt}` per `realmId` in KMS-backed storage,
persists the rotated refresh token before the next API call (ADR 0026 step 3),
and is reachable from a server-side job but not from a request path. Until it
exists this scheduler runs end to end and records `not_configured`, which is a
scheduler that is proven to run rather than one that will be written later. The
OAuth consent flow that would create an `accounting_connections` row in the
first place is out of scope with it.

### 8. Two Inngest functions, keyed per request

`ledger-sync-fan-out` triggers on the cron; `sync-ledger` handles the event it
sends. The fan-out is two steps, and the split matters: the first lists the
enabled connections and mints a fresh `syncKey` (`randomUUID()`) per
connection, the second sends one `ledger/sync.requested` per connection. The
first step's result is memoized, so a retry of the second re-sends *the same*
keys and the idempotency window collapses them into one sync each. Minting the
keys inside the sending step would make every retry a fresh set of requests,
which is a duplicate sync per connection per retry.

The payload is ids and one key: `connectionId`, `orgId`, `userId`, `syncKey`.
Not one row of ledger content, for the reason ADR 0021 gives — the queue is a
third party and the payload is durable there. Every field is checked to be a
UUID before it becomes a tenant claim, and a malformed event is a
`NonRetriableError`: it will be just as malformed in thirty seconds.

Concurrency is one per org and two across the fleet, both well under
`INNGEST_PLAN_CONCURRENCY_LIMIT = 5` — a function asking for more than the plan
allows makes the whole app fail to sync, which is not a slower sync but no
deployed function at all. One per org because two concurrent syncs of one
ledger would race on identity: each would read `knownIdentifiers` before the
other wrote, and both would open a case for the same invoice.

`idempotency` is on `event.data.syncKey`, **not** on the org id. Keying on the
org would make the twenty-four-hour window swallow every deliberate re-run of a
tenant's sync for a day — the same mistake `event.data.documentId` was for the
read, where keying on the thing being recovered made the recovery
indistinguishable from it (ADR 0021). A fresh key per connection per firing
means the window catches only what it should: a literal redelivery of one
event.

## Consequences

- The ledger sync runs in production on a timer, and `pnpm db:test` proves the
  registry and the run log behave. What it does today is record
  `not_configured` for every connection, because there are no connections and no
  credentials. That is the scheduler being real and the vendor not being wired,
  in that order, which is the order that leaves a working seam behind.
- ADR 0030's coverage number gains the thing it was missing: `ledger_sync_runs`
  says which windows were actually walked, so a period with no `erp_sync`
  dollars can be read as "walked, nothing found" rather than "possibly never
  looked at".
- A run row is written at the end, so a process killed mid-run leaves none. The
  overlapping window covers the work; the Inngest run history is the only
  record that the attempt happened. Accepted, and stated in §2 rather than
  discovered.
- One new `security definer` function that writes (`app.record_ledger_sync_run`)
  and one that reads across tenants (`app.ledger_connections_to_sync`). Both are
  bounded in §4 and §5, both are revoked from `public`, and neither reads or
  writes anything but the two tables this migration adds.
- `accounting_connections` is mutable, which makes it the first table in a while
  that `app_rw` may UPDATE. No append-only table gains a grant: the migration
  issues UPDATE on that one table and nothing else, and suite 01 and suite 14
  still read the end state back.
- Nothing creates a connection yet. Until the consent flow exists, a row is
  written by hand or by a migration, and there is deliberately no UI and no API
  route that mints one.

## Invariants touched

- **1 (no submission without an approval).** Untouched. Nothing here inserts a
  `submissions`, `writebacks` or `writeoffs` row, and no gate function is read,
  replaced or referenced. The cases this sync opens enter at
  `analyst_review` like any other and reach money only through the same human
  approval.
- **2 (append-only).** Extended by one table. `ledger_sync_runs` joins the set
  on migration 0004's pattern and is named in this migration, per invariant 2's
  own rule that the list lives in the migrations rather than in prose. No
  existing append-only table gains an UPDATE or DELETE grant.
  `accounting_connections` is deliberately outside the set and §1 says why.
- **3 (money is integer cents).** Held. The run row's counts are row counts, not
  money, and are typed `integer` with non-negative checks; no cents column is
  added and no arithmetic is done on one. Every amount on this path is the
  integer cents `syncLedger` already produced.
- **4 (document content is untrusted).** Held. No model is constructed anywhere
  in this change, with or without tools. The event payload and the `error_class`
  column both carry ids and closed-set constants, never a message, a filename or
  a line of a ledger.
- **5 (Jev behind `DecisionProvider`).** Held by not being used. Triage v1 is
  deterministic rules; `syncLedger` refuses a `triageProvider` and this caller
  passes none.
- **6 (RLS on every table).** Held, and it is the invariant this change works
  hardest for. Both new tables have RLS enabled with per-command policies. Every
  read and every write happens as `app_rw` with the tenant's claims set
  transaction-locally. The service-role key appears nowhere in this change. The
  two definer functions are the stated exceptions and both are bounded by the
  caller's own claims (§4, §5).
- **7 (thresholds auto-tighten only).** Not engaged. No threshold is added to
  `org_settings` and no guarded column changes. The sync window is a code
  constant, and §6 says why that is the right home for it.

## Rollback

Drop `ledger_sync_runs`, then `accounting_connections`, then
`app.record_ledger_sync_run` and `app.ledger_connections_to_sync`, in a new
migration — never by editing 0024. Delete
`packages/store-postgres/src/connections.ts`,
`packages/pipeline/src/ledger-job.ts`, `apps/web/lib/ledger-sync.ts`,
`apps/web/lib/inngest-ledger.ts`, their tests, the two export lines and the two
functions in the `/api/inngest` route's function list. Removing the functions
from that list is by itself enough to stop the schedule: Inngest runs what the
app serves.

Cases a sync already opened stay, and stay readable without any of this code —
they are ordinary cases with ordinary notices, which is the property ADR 0029 §1
bought. Run rows are append-only history of a thing that happened; dropping the
table loses the record that those windows were walked, and a coverage number
computed afterwards must say so.
