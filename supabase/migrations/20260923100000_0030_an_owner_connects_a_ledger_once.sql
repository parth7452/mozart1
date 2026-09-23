-- 0030 — An owner connects a ledger, once (ADR 0039).
--
-- Nothing but an operator had ever made an `accounting_connections` row, so the
-- rules around one were never decided. A customer's owner is about to be able
-- to press Connect, and the rules a button needs are these:
--
--   1. One row per member per company per org, and **at most one enabled
--      connection per company across the deployment**. Migration 0024's
--      `unique (org_id, provider, provider_account_id)` goes: it is what made
--      ADR 0031 §3's "move a connection to somebody current" impossible, and it
--      stopped nothing across tenants. Two workspaces reading one company would
--      open, dispute and bill the same short-pays twice.
--   2. `created_by` is frozen, like the org and the company already are: it is
--      the member every nightly sync acts as, so a different member is a
--      different connection (a new row), never an edit.
--   3. `app.member_is_owner()`, and only an owner inserts, updates or deletes a
--      connection — inserting only as themselves (`created_by` = the caller).
--   4. Only an owner changes `memberships`. Migration 0010 gave it the generic
--      writer policies, so any analyst could promote themselves to owner, and
--      "owner only" would have been only as strong as that.
--   5. A credential row and an audit row name the caller: `created_by` and
--      `actor_id` must be `app.current_user_id()`.
--
-- Every change to a policy is a tightening, and nothing is granted to anyone.
-- No UPDATE, DELETE or TRUNCATE grant is added; `accounting_credentials` and
-- `audit_log` keep their append-only triggers and gain a narrower INSERT
-- policy and nothing else. No gate function is touched:
-- `app.require_approval()`, `app.member_may_write()`, `app.block_mutations()`
-- and `app.guard_threshold_direction()` are as they were.
--
-- Idempotent: `scripts/db-test.sh` applies every migration twice, and on the
-- second pass 0010, 0024 and 0025 recreate their generic policies before this
-- file narrows them again — which is the proof that the narrowing holds
-- whatever ran before it. `supabase/tests/26_an_owner_connects_a_ledger_once.sql`
-- reads the end state back.

-- ---------------------------------------------------------------------------
-- 1. Which rows may exist
-- ---------------------------------------------------------------------------
-- The per-org unique, found by its column list rather than its generated name,
-- so a database where it was named differently is handled the same. The
-- `(org_id, id)` unique that `accounting_credentials` keys on (0025) is a
-- different column list and is not touched.
do $$
declare
  per_org text;
begin
  select c.conname into per_org
    from pg_constraint c
   where c.conrelid = 'accounting_connections'::regclass
     and c.contype = 'u'
     and (select array_agg(a.attname::text order by a.attname::text)
            from unnest(c.conkey) as k(attnum)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
         = array['org_id', 'provider', 'provider_account_id'];
  if per_org is not null then
    execute format('alter table accounting_connections drop constraint %I', per_org);
    raise notice '0030: dropped % — a connection now moves by a new row (ADR 0039 §6)', per_org;
  end if;
end
$$;

-- Before the index, so a database that already breaks the rule says which rule
-- rather than failing on an index name. Production holds one connection.
do $$
begin
  if exists (
    select 1 from accounting_connections
     where enabled
     group by provider, provider_account_id
    having count(*) > 1
  ) then
    raise exception
      '0030: more than one enabled connection names the same company. Disable all but '
      'one — which workspace keeps it is a decision for a person — then apply this again'
      using errcode = 'unique_violation';
  end if;
end
$$;

create unique index if not exists accounting_connections_one_enabled_per_account
  on accounting_connections (provider, provider_account_id)
  where enabled;

comment on index accounting_connections_one_enabled_per_account is
  'At most one enabled connection to a given set of books across the whole '
  'deployment (ADR 0039 §7): two workspaces reading one company would open, '
  'dispute and bill the same short-pays twice. The name is pinned by a test — '
  'connectQboCompany maps a 23505 on it to AccountConnectedElsewhereError.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'accounting_connections'::regclass
       and conname = 'accounting_connections_one_per_member'
  ) then
    alter table accounting_connections
      add constraint accounting_connections_one_per_member
      unique (org_id, provider, provider_account_id, created_by);
  end if;
end
$$;

comment on constraint accounting_connections_one_per_member on accounting_connections is
  'One row per member per company per org, so "this member''s connection" is '
  'unambiguous: a reconnect reuses it, and a move is a new row created by '
  'somebody else (ADR 0039 §6, ADR 0031 §3).';

-- ---------------------------------------------------------------------------
-- 2. The member a connection acts as is not editable
-- ---------------------------------------------------------------------------
-- `create or replace` restates the whole function, `set search_path` included:
-- a replacement without the `set` clause drops the pin, which is how 0022 lost
-- it on the guard (ADR 0037 §1).
create or replace function app.touch_accounting_connection() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  new.updated_at := now();
  -- The tenant, the books and the member are not editable. Re-pointing an
  -- existing connection at another org's books, another company or another
  -- member would silently re-attribute every case and run row already recorded
  -- against it. A different one of any of them is a different connection.
  if new.org_id <> old.org_id
     or new.provider <> old.provider
     or new.provider_account_id <> old.provider_account_id
     or new.created_by <> old.created_by then
    raise exception
      'accounting_connections: org, provider, provider_account_id and created_by '
      'are immutable; add a connection rather than re-pointing this one'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function app.touch_accounting_connection() is
  'Keeps updated_at honest and holds the identity columns still — the org, the '
  'company and, since ADR 0039, the member the sync acts as. `enabled` is what '
  'an update is for (ADR 0031 §1).';

revoke all on function app.touch_accounting_connection() from public;

-- ---------------------------------------------------------------------------
-- 3. Who is an owner
-- ---------------------------------------------------------------------------
-- `app.member_may_write()`'s shape exactly: not security definer — it reads the
-- caller's own membership through the same RLS every query does — and pinned,
-- because it decides a write.
create or replace function app.member_is_owner() returns boolean
  language sql
  stable
  set search_path = pg_catalog, public, extensions
as $$
  select exists (
    select 1 from memberships m
     where m.org_id = app.current_org_id()
       and m.user_id = app.current_user_id()
       and m.role = 'owner'
  );
$$;

comment on function app.member_is_owner() is
  'Whether the caller is an owner of the org their claims name. Connecting, '
  'moving or disconnecting a ledger and changing a membership are an owner''s '
  'acts (ADR 0039 §8). Not security definer: it reads the caller''s own '
  'membership under RLS, like app.member_may_write().';

revoke all on function app.member_is_owner() from public;
grant execute on function app.member_is_owner() to app_rw, app_ro;

-- ---------------------------------------------------------------------------
-- 4. The policies
-- ---------------------------------------------------------------------------
-- One policy per command, dropped and recreated (0010's pattern). Reads are
-- untouched everywhere: tenant_read on each table is exactly what it was.
do $$
begin
  -- accounting_connections: an owner, acting as themselves.
  execute 'drop policy if exists tenant_insert on accounting_connections';
  execute 'drop policy if exists tenant_update on accounting_connections';
  execute 'drop policy if exists tenant_delete on accounting_connections';
  execute 'create policy tenant_insert on accounting_connections for insert
             with check (org_id = app.current_org_id()
                         and app.member_is_owner()
                         and created_by = app.current_user_id())';
  execute 'create policy tenant_update on accounting_connections for update
             using (org_id = app.current_org_id() and app.member_is_owner())
             with check (org_id = app.current_org_id() and app.member_is_owner())';
  -- Present so a future grant lands on a rule; app_rw holds no DELETE here.
  execute 'create policy tenant_delete on accounting_connections for delete
             using (org_id = app.current_org_id() and app.member_is_owner())';

  -- memberships: who is an owner is an owner's decision.
  execute 'drop policy if exists tenant_insert on memberships';
  execute 'drop policy if exists tenant_update on memberships';
  execute 'drop policy if exists tenant_delete on memberships';
  execute 'create policy tenant_insert on memberships for insert
             with check (org_id = app.current_org_id() and app.member_is_owner())';
  execute 'create policy tenant_update on memberships for update
             using (org_id = app.current_org_id() and app.member_is_owner())
             with check (org_id = app.current_org_id() and app.member_is_owner())';
  execute 'create policy tenant_delete on memberships for delete
             using (org_id = app.current_org_id() and app.member_is_owner())';

  -- accounting_credentials: any writer still stores a rotation — the sync acts
  -- as a connection's member, who may since have become an analyst — but only
  -- as themselves.
  execute 'drop policy if exists tenant_insert on accounting_credentials';
  execute 'create policy tenant_insert on accounting_credentials for insert
             with check (org_id = app.current_org_id()
                         and app.member_may_write()
                         and created_by = app.current_user_id())';

  -- audit_log: a row names who acted, and that is whoever is writing it.
  execute 'drop policy if exists tenant_insert on audit_log';
  execute 'create policy tenant_insert on audit_log for insert
             with check (org_id = app.current_org_id()
                         and app.member_may_write()
                         and actor_id = app.current_user_id())';
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The end state, re-read. Abort, do not warn.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'accounting_connections'::regclass
       and c.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname::text)
              from unnest(c.conkey) as k(attnum)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
           = array['org_id', 'provider', 'provider_account_id']
  ) then
    raise exception '0030: the per-org unique on accounting_connections survived';
  end if;

  if not exists (
    select 1 from pg_index i
     where i.indexrelid = 'accounting_connections_one_enabled_per_account'::regclass
       and i.indisunique
       and i.indpred is not null
  ) then
    raise exception '0030: accounting_connections_one_enabled_per_account is not a partial unique index';
  end if;
end
$$;
