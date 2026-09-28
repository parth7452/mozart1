-- 0039 — Portal read hardening (ADR 0064; ADR 0057 §8, §15).
--
-- Three follow-ups from PR #129's review, each moving a rule the store kept
-- into the database, and one correction to 0038's header:
--
--   1. `app.portal_connection_enable_is_not_held()` — a BEFORE UPDATE trigger
--      on `portal_connections` refusing `enabled` false → true while the
--      connection is held: a `portal_connection.disabled` audit row with
--      reason `credential_rejected` or `credential_removed` names the
--      connection's latest credential by `seq` (or, with none stored, names
--      none). `PostgresPortalStore.enableConnection` asks the same question
--      first and answers by name; this is the backstop for every other path,
--      so the password a portal refused is never typed again (§8). Only a
--      newer credential lifts a hold. Invoker, pinned: the caller whose UPDATE
--      passes RLS is a member of the row's org, and `audit_log`'s read policy
--      shows that org's rows, so the question is asked of every row it needs.
--   2. `portal_captures`' `tenant_insert` policy — a capture row is written
--      only for a run the caller's own claims started (`requested_by` is the
--      caller; a run acts as its connection's member, §13) and that has no
--      outcome row yet. 0038 admitted any writer of the org. The consistency
--      trigger (`capture_is_consistent`) is unchanged.
--   3. Nothing else: no table, no column, no grant.
--
-- A correction to 0038's header, which is merged and applied and so is not
-- edited: where it says a read that is not a dry run names a promoted version
-- in effect "or none and ends not_configured", a start with no version can
-- also end `refused` — a member who may no longer write, a connection turned
-- off, terms not allowed — since the job records a refusal before it looks for
-- a version. `app.record_portal_read_run()` has always accepted both.
--
-- The SQLSTATE a caller can newly meet:
--   23514  `portal connection enable blocked`: the connection is held
--   42501  RLS on a capture for a run that is not the caller's, or that ended
--
-- Idempotent throughout: `create or replace function`, drop-then-create for the
-- trigger and the policy. scripts/db-test.sh applies it twice, and
-- supabase/tests/35_portal_read_hardening.sql reads the end state back.

-- ---------------------------------------------------------------------------
-- 1. A held connection stays off until a newer credential is stored
-- ---------------------------------------------------------------------------
create or replace function app.portal_connection_enable_is_not_held() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  latest uuid;
  held text;
begin
  if old.enabled or not new.enabled then
    return new;
  end if;

  select c.id into latest
    from portal_credentials c
   where c.org_id = new.org_id and c.connection_id = new.id
   order by c.seq desc
   limit 1;

  select a.payload->>'reason' into held
    from audit_log a
   where a.org_id = new.org_id
     and a.subject_table = 'portal_connections'
     and a.subject_id = new.id::text
     and a.action = 'portal_connection.disabled'
     and a.payload->>'reason' in ('credential_rejected', 'credential_removed')
     and a.payload->>'credential_id' is not distinct from latest::text
   order by a.id desc
   limit 1;

  if held is not null then
    raise exception
      'portal connection enable blocked: connection % is held off (%) until a newer '
      'credential is stored (ADR 0057 §8, ADR 0064)', new.id, held
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

comment on function app.portal_connection_enable_is_not_held() is
  'Refuses turning a portal connection back on while a credential_rejected or '
  'credential_removed disable names its latest credential (or, with none '
  'stored, names none): only a newer credential lifts the hold (ADR 0057 §8, '
  'ADR 0064).';

revoke all on function app.portal_connection_enable_is_not_held() from public;

drop trigger if exists enable_is_not_held on portal_connections;
create trigger enable_is_not_held before update of enabled on portal_connections
  for each row execute function app.portal_connection_enable_is_not_held();

-- ---------------------------------------------------------------------------
-- 2. A capture is written by its run, while it runs
-- ---------------------------------------------------------------------------
drop policy if exists tenant_insert on portal_captures;
create policy tenant_insert on portal_captures for insert
  with check (
    org_id = app.current_org_id()
    and app.member_may_write()
    and exists (
      select 1 from portal_read_starts s
       where s.org_id = portal_captures.org_id
         and s.id = portal_captures.run_id
         and s.requested_by = app.current_user_id()
    )
    and not exists (
      select 1 from portal_read_runs r
       where r.org_id = portal_captures.org_id
         and r.run_id = portal_captures.run_id
    )
  );

-- ---------------------------------------------------------------------------
-- 3. The end state, re-read. Abort, do not warn.
-- ---------------------------------------------------------------------------
do $$
declare
  f constant text := 'app.portal_connection_enable_is_not_held()';
  q text;
begin
  if not coalesce((select proconfig @> array['search_path=pg_catalog, public, extensions']
                     from pg_proc where oid = f::regprocedure), false) then
    raise exception '0039: % does not pin its search_path', f;
  end if;
  if (select prosecdef from pg_proc where oid = f::regprocedure) then
    raise exception '0039: % must not be security definer', f;
  end if;
  if has_function_privilege('public', f, 'EXECUTE') then
    raise exception '0039: PUBLIC may execute %', f;
  end if;

  if not exists (select 1 from pg_trigger
                  where tgname = 'enable_is_not_held'
                    and tgrelid = 'portal_connections'::regclass
                    and tgfoid = f::regprocedure
                    and not tgisinternal
                    and tgenabled = 'O') then
    raise exception '0039: the hold trigger is missing on portal_connections';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'capture_is_consistent'
                    and tgrelid = 'portal_captures'::regclass
                    and tgfoid = 'app.portal_capture_is_consistent'::regproc) then
    raise exception '0039: the capture consistency trigger is gone';
  end if;

  select pg_get_expr(p.polwithcheck, p.polrelid) into q
    from pg_policy p
   where p.polrelid = 'portal_captures'::regclass and p.polname = 'tenant_insert'
     and p.polcmd = 'a';
  if q is null
     or position('portal_read_starts' in q) = 0
     or position('requested_by = app.current_user_id()' in q) = 0
     or position('portal_read_runs' in q) = 0
     or position('member_may_write' in q) = 0 then
    raise exception '0039: portal_captures.tenant_insert is not the run''s own: %', q;
  end if;
  if (select count(*) from pg_policy
       where polrelid = 'portal_captures'::regclass
         and polname in ('tenant_read', 'tenant_insert', 'tenant_update', 'tenant_delete')) <> 4 then
    raise exception '0039: portal_captures lacks one of its four policies';
  end if;

  -- Nothing this migration touches may have loosened a grant.
  if has_any_column_privilege('app_rw', 'portal_captures', 'UPDATE')
     or has_table_privilege('app_rw', 'portal_captures', 'DELETE')
     or has_table_privilege('app_rw', 'portal_captures', 'TRUNCATE') then
    raise exception '0039: app_rw holds a write it must not on portal_captures';
  end if;
  if (select count(*) from pg_trigger
       where tgrelid = 'portal_captures'::regclass and tgname in ('no_update_delete', 'no_truncate')
         and tgfoid = 'app.block_mutations'::regproc) <> 2 then
    raise exception '0039: portal_captures is missing an append-only trigger';
  end if;
end
$$;
