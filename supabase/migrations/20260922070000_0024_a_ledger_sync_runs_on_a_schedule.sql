-- 0024 — A ledger sync runs on a schedule, as a member (ADR 0031).
--
-- ADR 0029 built `syncLedger` and said what it did not build: "no scheduler".
-- Nothing calls it, so the coverage thesis is measured at zero by construction
-- and ADR 0030's denominator has no ERP-discovered numerator. A scheduler needs
-- three things this database does not have: a list of which orgs have a ledger,
-- a way for a timer to act as somebody, and a record of what was walked.
--
-- Four things, and nothing else.
--
--   1. `accounting_connections` — which org has which provider account, whether
--      it is still wanted, and who connected it. **No tokens, no secrets, ever**
--      (CLAUDE.md: credentials belong in KMS-backed storage). Mutable, because
--      `enabled` flips: a customer revoking consent is a state, not an event.
--      SELECT/INSERT/UPDATE to app_rw and no DELETE — a connection that synced
--      is named by every run row it produced.
--
--   2. `ledger_sync_runs` — one row per finished run: window, timestamps,
--      counts, outcome, error class. Append-only on 0004's pattern exactly,
--      which forces ADR 0023's shape: written once, when the run finishes,
--      complete. There is no row to update.
--
--   3. `app.record_ledger_sync_run()` — the only door into that table, and
--      definer for one reason: the row that most needs writing is the one whose
--      acting member may no longer write (outcome `refused`), so
--      `app.member_may_write()` would refuse the record of its own refusal. It
--      escapes that check and nothing else: it refuses any org but the caller's
--      own claim and any `requested_by` but the caller's own subject, so it
--      reaches no further than its caller already reaches.
--
--   4. `app.ledger_connections_to_sync()` — ids only, across every org, for the
--      cron fan-out, which has no tenant because it has to decide which tenants
--      to adopt. `app.my_orgs()`'s shape (0012) with the claims removed. Never
--      the service role: this bypasses one policy on one table and hands back
--      ids, where the service role bypasses RLS on every table in a request
--      path (invariant 6).
--
-- What is deliberately NOT here: any edit to `app.require_approval()`,
-- `app.guard_immutable_core()`, `app.member_may_write()`,
-- `app.block_mutations()` or `app.guard_threshold_direction()` — the fourth is
-- *used*, not redefined, and the others are not touched at all. No UPDATE or
-- DELETE grant on any append-only table. No money column anywhere: the counts
-- here are row counts (invariant 3 is not engaged because nothing on this
-- migration is money).
--
-- Idempotent throughout: `create table if not exists`, `create or replace
-- function`, drop-then-create for every trigger and policy, `create index if
-- not exists`. `scripts/db-test.sh` applies every migration twice in one run,
-- and `supabase/tests/20_a_ledger_sync_is_scheduled.sql` reads the end state
-- back rather than assuming it.

-- ---------------------------------------------------------------------------
-- 1. accounting_connections — which ledger, whose, and still wanted?
-- ---------------------------------------------------------------------------
-- The one table here that is not append-only, and ADR 0031 §1 says why: a
-- connection's enabled-ness is a state a customer changes, not a sequence of
-- events. Everything *about a sync* is append-only; the switch is not.
create table if not exists accounting_connections (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id),
  -- A check constraint rather than an enum, so the next provider is one line in
  -- a migration rather than a type rewrite. NetSuite and Xero arrive behind the
  -- same `AccountingSource` port (CLAUDE.md build order), and each one adds its
  -- name here and to `ACCOUNTING_PROVIDERS` in `store-postgres` together.
  provider            text not null check (provider in ('qbo')),
  -- The provider's own key for the company: QBO's `realmId`. Not a secret and
  -- not a credential — it names which books to read, and proves nothing.
  provider_account_id text not null check (btrim(provider_account_id) <> ''),
  -- Whether the scheduler should still walk it. The fan-out lists only the
  -- enabled ones; a disabled connection keeps its history.
  enabled             boolean not null default true,
  -- The member the sync acts as (ADR 0031 §3). Not nullable: a scheduled write
  -- with no member behind it is the service role by another name, and invariant
  -- 6 has one line about that.
  created_by          uuid not null references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One row per company per provider per tenant. A second connection to the
  -- same books would double every case the ledger discovers.
  unique (org_id, provider, provider_account_id)
);

comment on table accounting_connections is
  'Which orgs have an accounting ledger to sync, which provider account, and '
  'who connected it (ADR 0031 §1). Deliberately NOT append-only: `enabled` '
  'flips when a customer revokes consent or an operator turns a connection '
  'off. It holds NO tokens, NO client secret and NO credential of any kind — '
  'those belong in KMS-backed storage (CLAUDE.md), and Intuit''s refresh '
  'tokens rotate on every use, so a row anybody can select is a live '
  'credential leaked and a row anybody can update is a connection stranded. '
  'supabase/tests/20 asserts the column list stays clean.';

comment on column accounting_connections.provider_account_id is
  'The provider''s key for the company being read — QBO''s realmId. It names '
  'which books, and authorises nothing.';

comment on column accounting_connections.created_by is
  'The member a scheduled sync of this connection acts as. Its claims are what '
  'the job sets transaction-locally, and app.member_may_write() is asked of '
  'them before anything is read; a member who can no longer write gets the run '
  'recorded as `refused` rather than a sync (ADR 0031 §3).';

create index if not exists accounting_connections_enabled_idx
  on accounting_connections (org_id, provider) where enabled;

alter table accounting_connections enable row level security;

-- One policy per command, the pattern from ADR 0012 and migration 0010: a
-- single policy's USING clause governs reads and the row-selection half of
-- writes alike, so a role predicate there would block reading too. A
-- `read_only` member is refused every write here before the grants are
-- consulted.
do $$
begin
  execute 'drop policy if exists tenant_isolation on accounting_connections';
  execute 'drop policy if exists tenant_read on accounting_connections';
  execute 'drop policy if exists tenant_insert on accounting_connections';
  execute 'drop policy if exists tenant_update on accounting_connections';
  execute 'drop policy if exists tenant_delete on accounting_connections';

  execute 'create policy tenant_read on accounting_connections for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on accounting_connections for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on accounting_connections for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  -- Present so a future grant cannot arrive without a policy behind it. The
  -- grant itself is revoked below: disabling is the verb, and a deleted
  -- connection would orphan the run rows that name it.
  execute 'create policy tenant_delete on accounting_connections for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

revoke all on accounting_connections from app_rw;
revoke all on accounting_connections from app_ro;
grant select, insert, update on accounting_connections to app_rw;
grant select on accounting_connections to app_ro;

-- `updated_at` is the one column a caller should not have to remember. Its own
-- trigger, so a row that changed always says when — and it is a BEFORE UPDATE
-- trigger on a mutable table, which is exactly what `app.block_mutations()` is
-- *not* doing here.
create or replace function app.touch_accounting_connection() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  new.updated_at := now();
  -- The tenant and the books are not editable. Re-pointing an existing
  -- connection at another org's books, or at another company, would silently
  -- re-attribute every case and run row already recorded against it. A
  -- different company is a different connection.
  if new.org_id <> old.org_id
     or new.provider <> old.provider
     or new.provider_account_id <> old.provider_account_id then
    raise exception
      'accounting_connections: org, provider and provider_account_id are '
      'immutable; add a connection rather than re-pointing this one'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function app.touch_accounting_connection() is
  'Keeps updated_at honest and holds the identity columns still: `enabled` is '
  'what an update is for (ADR 0031 §1).';

revoke all on function app.touch_accounting_connection() from public;

drop trigger if exists touch_accounting_connection on accounting_connections;
create trigger touch_accounting_connection before update on accounting_connections
  for each row execute function app.touch_accounting_connection();

-- ---------------------------------------------------------------------------
-- 2. ledger_sync_runs — what was walked, and how it went
-- ---------------------------------------------------------------------------
-- A sync that ran and left no row is invisible, and ADR 0030's coverage view
-- cannot tell a period where the ledger held no short-pays from a period
-- nothing ever walked. That distinction is the difference between a coverage
-- number and a guess.
--
-- Append-only, which forces ADR 0023's shape: the row is written when the run
-- *finishes*, with both timestamps and every count on it, because there is no
-- row to come back and update. A run killed mid-flight therefore leaves
-- nothing — stated in ADR 0031 §2, covered by the overlapping window of §6, and
-- visible in the runtime's own run history.
create table if not exists ledger_sync_runs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id),
  connection_id     uuid not null references accounting_connections(id),
  -- The window actually asked of the provider, inclusive, as calendar days.
  -- Consecutive daily runs overlap on purpose (ADR 0031 §6); this is what says
  -- which days a walk covered.
  window_from       date not null,
  window_to         date not null,
  started_at        timestamptz not null,
  finished_at       timestamptz not null,
  -- Row counts, not money. Integers with non-negative checks: invariant 3 is
  -- about cents and there are none here, which is why there are none here.
  invoices_examined integer not null default 0 check (invoices_examined >= 0),
  opened_count      integer not null default 0 check (opened_count >= 0),
  skipped_count     integer not null default 0 check (skipped_count >= 0),
  declined_count    integer not null default 0 check (declined_count >= 0),
  anomaly_count     integer not null default 0 check (anomaly_count >= 0),
  -- Four constants, and a run is exactly one of them.
  --   completed       — the window was read and every candidate recorded.
  --   not_configured  — no accounting source could be built for this
  --                     connection, so nothing was read and nothing was spent
  --                     (ADR 0031 §7).
  --   refused         — the connection's member may no longer write in this
  --                     org. Nothing was read (§3).
  --   failed          — it was attempted and it broke.
  outcome           text not null
                      check (outcome in ('completed', 'not_configured', 'refused', 'failed')),
  -- The error's **class name**, never its message. The rule `asJobFailure`
  -- follows in apps/web/lib/inngest.ts, for the same reason: a message off this
  -- path can quote a ledger's own text, and a run row is not a place to keep a
  -- third party's data (invariant 4).
  error_class       text,
  -- The member the run acted as: the connection's `created_by`, and the subject
  -- whose claims the job set. app.record_ledger_sync_run() refuses any other
  -- value, so this column cannot name somebody the run did not act as.
  requested_by      uuid not null references users(id),
  recorded_at       timestamptz not null default now(),

  check (window_to >= window_from),
  check (finished_at >= started_at),
  -- "It worked" and "here is what went wrong" cannot both be true of one row.
  check (outcome <> 'completed' or error_class is null)
);

comment on table ledger_sync_runs is
  'One row per finished ledger sync: the window walked, the counts, and how it '
  'ended (ADR 0031 §2). Append-only, so the row is written once when the run '
  'finishes rather than opened and updated — a run killed mid-flight leaves no '
  'row, which the next day''s overlapping window covers. This is what lets a '
  'coverage number say which periods a full walk actually covered rather than '
  'inferring it from the absence of erp_sync dollars (ADR 0030).';

comment on column ledger_sync_runs.error_class is
  'A class name and never a message (invariant 4). Null on a completed run, by '
  'check constraint.';

create index if not exists ledger_sync_runs_org_idx
  on ledger_sync_runs (org_id, started_at desc);
create index if not exists ledger_sync_runs_connection_idx
  on ledger_sync_runs (org_id, connection_id, started_at desc);
-- The question ADR 0030 asks of this table: which days did a completed walk
-- cover, for this tenant?
create index if not exists ledger_sync_runs_window_idx
  on ledger_sync_runs (org_id, window_from, window_to) where outcome = 'completed';

alter table ledger_sync_runs enable row level security;

do $$
begin
  execute 'drop policy if exists tenant_isolation on ledger_sync_runs';
  execute 'drop policy if exists tenant_read on ledger_sync_runs';
  execute 'drop policy if exists tenant_insert on ledger_sync_runs';
  execute 'drop policy if exists tenant_update on ledger_sync_runs';
  execute 'drop policy if exists tenant_delete on ledger_sync_runs';

  execute 'create policy tenant_read on ledger_sync_runs for select
             using (org_id = app.current_org_id())';
  -- Present, and deliberately never reachable: app_rw holds no INSERT on this
  -- table (below), so every row goes through app.record_ledger_sync_run().
  -- The policy exists so that a grant issued in a hurry lands on a rule rather
  -- than on nothing, and it is the same rule every other write in this schema
  -- follows.
  execute 'create policy tenant_insert on ledger_sync_runs for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on ledger_sync_runs for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on ledger_sync_runs for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

-- SELECT and nothing else. The revoke answers for app_rw and app_ro; it does
-- not answer for the table owner — the role migrations run as, the role a
-- Supabase SQL-editor session runs as, the role anybody with the database
-- password gets — which bypasses grants and RLS alike. 0004 pairs a revoke with
-- a trigger for exactly that reason, and the trigger is also what survives the
-- next `grant all` somebody writes in a hurry.
revoke all on ledger_sync_runs from app_rw;
revoke all on ledger_sync_runs from app_ro;
grant select on ledger_sync_runs to app_rw;
grant select on ledger_sync_runs to app_ro;

drop trigger if exists no_update_delete on ledger_sync_runs;
create trigger no_update_delete before update or delete on ledger_sync_runs
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on ledger_sync_runs;
create trigger no_truncate before truncate on ledger_sync_runs
  for each statement execute function app.block_mutations();

-- ---------------------------------------------------------------------------
-- 3. app.record_ledger_sync_run() — the one door, bounded by its caller
-- ---------------------------------------------------------------------------
-- Definer for exactly one reason: the row that most needs writing is the one
-- whose acting member may no longer write. When a connection's `created_by` has
-- been downgraded to `read_only` or removed from the org, `tenant_insert`'s
-- `app.member_may_write()` would refuse the record of that very refusal, and
-- ADR 0031 §3 is that the refusal is the thing worth recording.
--
-- It escapes that check and nothing else. Two guards keep its reach equal to
-- its caller's:
--
--   * p_org_id must equal app.current_org_id() — it cannot write outside the
--     tenant whose claims the caller already adopted, so it is not a
--     cross-tenant door and it is not the service role in a costume;
--   * p_requested_by must equal app.current_user_id() — a run row always names
--     the member the job actually acted as, and cannot be attributed to
--     somebody else.
--
-- Plus the consistency the foreign keys do not give: the connection exists and
-- belongs to that same org. It authorises nothing, touches no gate function,
-- and writes one append-only table.
create or replace function app.record_ledger_sync_run(
  p_org_id            uuid,
  p_connection_id     uuid,
  p_requested_by      uuid,
  p_window_from       date,
  p_window_to         date,
  p_started_at        timestamptz,
  p_finished_at       timestamptz,
  p_outcome           text,
  p_invoices_examined integer,
  p_opened_count      integer,
  p_skipped_count     integer,
  p_declined_count    integer,
  p_anomaly_count     integer,
  p_error_class       text
) returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  caller_org uuid := app.current_org_id();
  caller_sub uuid := app.current_user_id();
  conn_org uuid;
  new_id uuid;
begin
  if caller_org is null or caller_sub is null then
    raise exception
      'ledger sync run blocked: no tenant claims are set; this is written as '
      'the member the sync acted as, never as nobody'
      using errcode = 'insufficient_privilege';
  end if;

  if p_org_id is distinct from caller_org then
    raise exception
      'ledger sync run blocked: org % is not the tenant these claims are for',
      p_org_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_requested_by is distinct from caller_sub then
    raise exception
      'ledger sync run blocked: a run row names the member it acted as, and '
      'these claims are not %', p_requested_by
      using errcode = 'insufficient_privilege';
  end if;

  select c.org_id into conn_org
    from accounting_connections c where c.id = p_connection_id;

  if conn_org is null then
    raise exception 'ledger sync run blocked: connection % does not exist',
      p_connection_id
      using errcode = 'restrict_violation';
  end if;

  if conn_org <> p_org_id then
    raise exception
      'ledger sync run blocked: connection % belongs to another org',
      p_connection_id
      using errcode = 'restrict_violation';
  end if;

  insert into ledger_sync_runs
    (org_id, connection_id, window_from, window_to, started_at, finished_at,
     invoices_examined, opened_count, skipped_count, declined_count,
     anomaly_count, outcome, error_class, requested_by)
  values
    (p_org_id, p_connection_id, p_window_from, p_window_to, p_started_at,
     p_finished_at, coalesce(p_invoices_examined, 0), coalesce(p_opened_count, 0),
     coalesce(p_skipped_count, 0), coalesce(p_declined_count, 0),
     coalesce(p_anomaly_count, 0), p_outcome, p_error_class, p_requested_by)
  returning id into new_id;

  return new_id;
end
$$;

comment on function app.record_ledger_sync_run(uuid, uuid, uuid, date, date,
  timestamptz, timestamptz, text, integer, integer, integer, integer, integer, text) is
  'The only way a ledger_sync_runs row is written (ADR 0031 §4). Definer so '
  'that a run refused because its member may no longer write can still record '
  'that refusal — and bounded to the caller''s own org claim and own subject, '
  'so it reaches no further than its caller already does. Never the service '
  'role: it writes one append-only table and authorises nothing.';

revoke all on function app.record_ledger_sync_run(uuid, uuid, uuid, date, date,
  timestamptz, timestamptz, text, integer, integer, integer, integer, integer, text)
  from public;
grant execute on function app.record_ledger_sync_run(uuid, uuid, uuid, date, date,
  timestamptz, timestamptz, text, integer, integer, integer, integer, integer, text)
  to app_rw;

-- ---------------------------------------------------------------------------
-- 4. app.ledger_connections_to_sync() — ids, across every org, for the cron
-- ---------------------------------------------------------------------------
-- The fan-out has no tenant: it has to know which orgs to fan out to before it
-- can adopt any org's claims. `app.my_orgs()`'s shape (migration 0012) with the
-- claims removed rather than a new kind of thing — and it returns ids and one
-- closed-set string, never `provider_account_id`, never a name, never a row.
-- The handler reads the connection it was sent under that tenant's own claims,
-- through RLS, and that read is where the account id comes from.
--
-- Not the service role, and the difference is exact: the service-role key
-- bypasses RLS on every table for every caller that holds it, in a request
-- path. This bypasses one policy on one table and hands back ids. What it does
-- expose is said out loud in ADR 0031 §5 — an app_rw caller that sets no claims
-- can learn which org ids have an enabled connection — and that is no new
-- reach, because app.current_org_id() reads a session setting the caller sets
-- itself, so such a caller can already adopt any tenant's claims and read that
-- tenant's rows, which is strictly more.
--
-- It is callable only by a caller that has no tenant. That is not decoration:
-- `authenticated` is a member of `app_rw` (migration 0006), so anything granted
-- to `app_rw` is reachable by a signed-in request, and this is the one function
-- in the schema whose answer is not bounded by the caller's claims. A request
-- always carries `request.jwt.claims`; the fan-out sets `set local role app_rw`
-- and no claims at all, because it has none to set. Refusing a caller who has a
-- tenant therefore keeps this to exactly the one caller it is for, and makes
-- "use it from a request path" a thing the database says no to rather than a
-- thing a reviewer has to notice.
create or replace function app.ledger_connections_to_sync()
  returns table (connection_id uuid, org_id uuid, provider text, created_by uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public, extensions
as $$
begin
  if app.current_org_id() is not null then
    raise exception
      'ledger_connections_to_sync is the untenanted fan-out query: a caller '
      'acting for a tenant must read accounting_connections through RLS instead'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select c.id, c.org_id, c.provider, c.created_by
      from accounting_connections c
     where c.enabled
     order by c.org_id, c.id;
end
$$;

comment on function app.ledger_connections_to_sync() is
  'Every enabled accounting connection, as ids, across every org — for the '
  'cron fan-out, which has no tenant because it decides which tenants to adopt '
  '(ADR 0031 §5). Ids and a closed-set provider name only, and refused outright '
  'for a caller that has a tenant: those read the table through RLS.';

revoke all on function app.ledger_connections_to_sync() from public;
grant execute on function app.ledger_connections_to_sync() to app_rw;
