-- 0037 — a deduction's accounting is posted to QuickBooks (ADR 0060 §4)
--
-- Schema only, and inert. Four changes:
--   1. `ledger_account_maps`: which QuickBooks accounts a tenant's postings go
--      to, per connection. Append-only on 0004's pattern — a change is a new
--      row — and only an owner, as themselves, may insert one.
--   2. `writebacks` gains the connection, the map, the amount and the lines it
--      posted; all four join 0017's immutable core. `method` admits
--      `journal_entry` and `payment_application`. `succeeded` is final and
--      `qbo_txn_id` is written once.
--   3. `decisions.schema_id` admits 'S'.
--   4. `accounting_connections.posting_enabled`, default false, true only while
--      the connection has a map, and changed only by an owner.
--
-- What is deliberately NOT here: any change to `app.require_approval()` or to
-- the `enforce_approval` triggers — a `writebacks` row still needs its
-- approval — and no new UPDATE or DELETE grant on any table.
--
-- Idempotent: `scripts/db-test.sh` applies every migration twice.

-- ---------------------------------------------------------------------------
-- 1. The account map
-- ---------------------------------------------------------------------------
create table if not exists ledger_account_maps (
  id                               uuid primary key default gen_random_uuid(),
  org_id                           uuid not null references organizations(id),
  connection_id                    uuid not null references accounting_connections(id),
  -- Breaks the created_at tie `now()` leaves inside one transaction; the
  -- current map is the latest row for the connection (as in 0025).
  seq                              bigserial not null,
  ar_account_id                    text not null check (length(ar_account_id) > 0),
  deductions_receivable_account_id text not null
                                     check (length(deductions_receivable_account_id) > 0),
  -- One expense account per reason family, and exactly the families of
  -- `REASON_FAMILIES` (packages/core-domain/src/reason-codes.ts).
  writeoff_by_family               jsonb not null,
  unclassified_writeoff            text not null check (length(unclassified_writeoff) > 0),
  created_by                       uuid not null references users(id),
  created_at                       timestamptz not null default now(),
  constraint ledger_account_maps_families check (
    jsonb_typeof(writeoff_by_family) = 'object'
    and writeoff_by_family ?& array['shortage', 'pricing', 'compliance', 'duplicate',
                                    'returns', 'promotion', 'freight', 'quality',
                                    'post_audit', 'other']
    and (writeoff_by_family - array['shortage', 'pricing', 'compliance', 'duplicate',
                                    'returns', 'promotion', 'freight', 'quality',
                                    'post_audit', 'other']) = '{}'::jsonb
  ),
  -- The tenancy tie, ADR 0025 §7.
  constraint ledger_account_maps_same_org
    foreign key (org_id, connection_id) references accounting_connections (org_id, id),
  -- So a writeback can name a map of its own org and its own connection.
  constraint ledger_account_maps_org_conn_id_key unique (org_id, connection_id, id)
);

comment on table ledger_account_maps is
  'Which QuickBooks accounts a connection''s postings go to (ADR 0060 §4). '
  'Append-only: a change is a new row, and a posting uses the row that was '
  'latest when its decision was approved. Only an owner inserts one.';

create index if not exists ledger_account_maps_latest_idx
  on ledger_account_maps (org_id, connection_id, seq desc);

create or replace function app.map_names_its_author() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  if new.created_by is distinct from app.current_user_id() then
    raise exception 'ledger_account_maps: created_by must be the caller'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
revoke all on function app.map_names_its_author() from public;

drop trigger if exists map_names_its_author on ledger_account_maps;
create trigger map_names_its_author before insert on ledger_account_maps
  for each row execute function app.map_names_its_author();

alter table ledger_account_maps enable row level security;

do $$
begin
  execute 'drop policy if exists tenant_read on ledger_account_maps';
  execute 'drop policy if exists tenant_insert on ledger_account_maps';
  execute 'drop policy if exists tenant_update on ledger_account_maps';
  execute 'drop policy if exists tenant_delete on ledger_account_maps';
  execute 'create policy tenant_read on ledger_account_maps for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on ledger_account_maps for insert
             with check (org_id = app.current_org_id() and app.member_is_owner()
                         and created_by = app.current_user_id())';
  -- Present so a future grant cannot arrive without a policy behind it.
  execute 'create policy tenant_update on ledger_account_maps for update
             using (org_id = app.current_org_id() and app.member_is_owner())
             with check (org_id = app.current_org_id() and app.member_is_owner())';
  execute 'create policy tenant_delete on ledger_account_maps for delete
             using (org_id = app.current_org_id() and app.member_is_owner())';
end
$$;

revoke all on ledger_account_maps from app_rw;
revoke all on ledger_account_maps from app_ro;
grant select, insert on ledger_account_maps to app_rw;
grant select on ledger_account_maps to app_ro;
grant usage on sequence ledger_account_maps_seq_seq to app_rw;

drop trigger if exists no_update_delete on ledger_account_maps;
create trigger no_update_delete before update or delete on ledger_account_maps
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on ledger_account_maps;
create trigger no_truncate before truncate on ledger_account_maps
  for each statement execute function app.block_mutations();

-- ---------------------------------------------------------------------------
-- 2. writebacks: what was posted, where, and that a success is final
-- ---------------------------------------------------------------------------
alter table writebacks add column if not exists connection_id uuid;
alter table writebacks add column if not exists account_map_id uuid;
alter table writebacks add column if not exists amount_cents bigint;
-- Account ids, sides and cents only — never a name or a memo.
alter table writebacks add column if not exists lines jsonb;

alter table writebacks drop constraint if exists writebacks_amount_positive;
alter table writebacks add constraint writebacks_amount_positive
  check (amount_cents is null or amount_cents > 0);

alter table writebacks drop constraint if exists writebacks_same_org_connection;
alter table writebacks add constraint writebacks_same_org_connection
  foreign key (org_id, connection_id) references accounting_connections (org_id, id);
alter table writebacks drop constraint if exists writebacks_same_org_map;
alter table writebacks add constraint writebacks_same_org_map
  foreign key (org_id, connection_id, account_map_id)
  references ledger_account_maps (org_id, connection_id, id);

alter table writebacks drop constraint if exists writebacks_method_check;
alter table writebacks add constraint writebacks_method_check check (method in
  ('credit_memo_offset', 'reversing_journal_entry', 'payment_adjustment',
   'journal_entry', 'payment_application'));

-- `unique (decision_id, method)` is 0005's already; restated only if missing.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'writebacks'::regclass and c.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(c.conkey) k join pg_attribute a
                on a.attrelid = c.conrelid and a.attnum = k)
           = array['decision_id', 'method']) then
    alter table writebacks add constraint writebacks_decision_id_method_key
      unique (decision_id, method);
  end if;
end
$$;

-- 0017's guard, restated in full (never edit 0017); the only change is the
-- writebacks branch, four columns longer.
create or replace function app.guard_immutable_core() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  immutable_cols text[] := array['id', 'org_id', 'deduction_id', 'decision_id'] ||
    case tg_table_name
      when 'submissions' then array['channel', 'packet_hash', 'confirmation_number',
                                    'submitted_at']
      when 'writebacks' then array['method', 'connection_id', 'account_map_id',
                                   'amount_cents', 'lines']
      when 'writeoffs' then array['amount_cents']
      else '{}'::text[]
    end;
  before_row jsonb := to_jsonb(old);
  after_row jsonb := to_jsonb(new);
  changed text[] := '{}';
  col text;
begin
  foreach col in array immutable_cols loop
    if before_row -> col is distinct from after_row -> col then
      changed := changed || col;
    end if;
  end loop;

  if array_length(changed, 1) is not null then
    raise exception
      '% is immutable once written (%): record a new fact, do not rewrite the old one',
      tg_table_name, array_to_string(changed, ', ')
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function app.guard_immutable_core() is
  'Refuses an update to the columns that say what was authorised and, on '
  'submissions, what was filed; on writebacks, what was posted and where '
  '(ADR 0060 §4). `status` stays mutable (ADR 0022).';

create or replace function app.writeback_outcome_is_final() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  if old.status = 'succeeded' and new.status is distinct from 'succeeded' then
    raise exception 'writebacks: a succeeded posting is final'
      using errcode = 'restrict_violation';
  end if;
  if old.qbo_txn_id is not null and new.qbo_txn_id is distinct from old.qbo_txn_id then
    raise exception 'writebacks: qbo_txn_id is written once'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
revoke all on function app.writeback_outcome_is_final() from public;

drop trigger if exists writeback_outcome_is_final on writebacks;
create trigger writeback_outcome_is_final before update on writebacks
  for each row execute function app.writeback_outcome_is_final();

-- ---------------------------------------------------------------------------
-- 3. A decision may be schema 'S'
-- ---------------------------------------------------------------------------
alter table decisions drop constraint if exists decisions_schema_id_check;
alter table decisions add constraint decisions_schema_id_check
  check (schema_id in ('A', 'B', 'C', 'D', 'S'));

-- ---------------------------------------------------------------------------
-- 4. The posting switch, off
-- ---------------------------------------------------------------------------
alter table accounting_connections
  add column if not exists posting_enabled boolean not null default false;

create or replace function app.posting_switch_is_guarded() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  was boolean := case when tg_op = 'UPDATE' then old.posting_enabled else false end;
begin
  if new.posting_enabled is distinct from was then
    if not app.member_is_owner() then
      raise exception 'accounting_connections: only an owner changes posting_enabled'
        using errcode = 'insufficient_privilege';
    end if;
    if new.posting_enabled and not exists (
      select 1 from ledger_account_maps m
       where m.org_id = new.org_id and m.connection_id = new.id) then
      raise exception 'accounting_connections: posting_enabled needs an account map'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
revoke all on function app.posting_switch_is_guarded() from public;

drop trigger if exists posting_switch_is_guarded on accounting_connections;
create trigger posting_switch_is_guarded before insert or update on accounting_connections
  for each row execute function app.posting_switch_is_guarded();

comment on column accounting_connections.posting_enabled is
  'Whether approved postings may go to QuickBooks for this connection (ADR 0060 '
  '§5). Off by default; true only while a map exists; changed only by an owner.';
