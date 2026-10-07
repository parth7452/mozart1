-- 0043 — a payer's dispute window is data, and fills in a deadline (ADR 0071,
-- proposed).
--
-- What this does, and nothing else:
--   1. payer_dispute_windows: one row says that, for one tenant and one
--      debtor, a deduction may be disputed within N calendar days of its
--      deduction date, from a date on. Append-only; a correction is a new row
--      with a later effective_from, or a later recording for the same dates.
--      Every row is a tenant's: (org_id, debtor_id) is a composite foreign key
--      (ADR 0025 §7).
--   2. app.payer_dispute_window_names_its_recorder(): recorded_by is the
--      caller (0040's rule for code maps).
--   3. RLS: tenant_read; tenant_insert for an owner or approver writing as
--      themselves (app.member_is_owner_or_approver(), from 0040, reused).
--      Grants: app_rw SELECT+INSERT, app_ro SELECT, nothing to a request
--      role. no_update_delete and no_truncate.
--   4. app.payer_dispute_windows_as_of(date): the one statement of which row
--      applies on a date, one per debtor.
--   5. A closing read of the catalogue that aborts if any of it did not hold.
--
-- Not here: any UPDATE or DELETE grant, any money column, any change to an
-- existing table, function, trigger or policy. Safe to run twice.

-- 1 ---------------------------------------------------------------------------
create table if not exists payer_dispute_windows (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id),
  debtor_id       uuid not null,
  window_days     integer not null check (window_days between 1 and 730),
  measured_from   text not null default 'deduction_date'
                    check (measured_from in ('deduction_date')),
  effective_from  date not null,
  effective_to    date,
  source          text not null check (source in (
                    'payer_guide_url', 'customer_confirmed', 'glimpse_guide', 'operator')),
  source_note     text check (source_note is null or length(source_note) between 1 and 500),
  confidence      text not null check (confidence in ('low', 'medium', 'high')),
  recorded_by     uuid not null references users (id),
  created_at      timestamptz not null default now(),
  constraint payer_dispute_windows_effective_range
    check (effective_to is null or effective_to >= effective_from),
  constraint payer_dispute_windows_same_org_debtor
    foreign key (org_id, debtor_id) references debtors (org_id, id)
);

create index if not exists payer_dispute_windows_debtor_from
  on payer_dispute_windows (org_id, debtor_id, effective_from);

comment on table payer_dispute_windows is
  'How many calendar days a payer gives to dispute a deduction, per tenant and '
  'debtor, effective-dated, with its source and confidence (ADR 0071). '
  'Append-only. app.payer_dispute_windows_as_of() says which row applies on a date.';

-- 2 ---------------------------------------------------------------------------
create or replace function app.payer_dispute_window_names_its_recorder() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  -- A window fills in the deadline of every later case for its payer; the
  -- person who recorded it writes it, in their own session. No exception for
  -- the table owner or a session with no claims.
  if new.recorded_by is distinct from app.current_user_id() then
    raise exception
      'payer dispute window blocked: recorded_by % is not the caller %',
      new.recorded_by, coalesce(app.current_user_id()::text, '(no session)')
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

revoke all on function app.payer_dispute_window_names_its_recorder() from public;

drop trigger if exists payer_dispute_window_names_its_recorder on payer_dispute_windows;
create trigger payer_dispute_window_names_its_recorder before insert on payer_dispute_windows
  for each row execute function app.payer_dispute_window_names_its_recorder();

-- 3 ---------------------------------------------------------------------------
alter table payer_dispute_windows enable row level security;

do $$
declare
  r text;
begin
  drop policy if exists tenant_read on payer_dispute_windows;
  drop policy if exists tenant_insert on payer_dispute_windows;
  create policy tenant_read on payer_dispute_windows for select
    using (org_id = app.current_org_id());
  create policy tenant_insert on payer_dispute_windows for insert
    with check (org_id = app.current_org_id()
                and app.member_is_owner_or_approver()
                and recorded_by = app.current_user_id());

  revoke all on payer_dispute_windows from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on payer_dispute_windows from %I', r);
    end if;
  end loop;
  revoke all on payer_dispute_windows from app_rw;
  revoke all on payer_dispute_windows from app_ro;
  grant select, insert on payer_dispute_windows to app_rw;
  grant select on payer_dispute_windows to app_ro;

  drop trigger if exists no_update_delete on payer_dispute_windows;
  create trigger no_update_delete before update or delete on payer_dispute_windows
    for each row execute function app.block_mutations();
  drop trigger if exists no_truncate on payer_dispute_windows;
  create trigger no_truncate before truncate on payer_dispute_windows
    for each statement execute function app.block_mutations();
end
$$;

-- 4 ---------------------------------------------------------------------------
-- Which row applies on a date, said once: per (org, debtor), among rows whose
-- range covers the date, the latest effective_from, then the latest recording
-- (created_at, then id). Not definer, so RLS applies to the caller.
-- packages/core-domain/src/dispute-windows.ts states the same rule as a pure
-- function, and dispute-windows.test.ts holds the two to one answer.
create or replace function app.payer_dispute_windows_as_of(as_of date)
  returns setof public.payer_dispute_windows
  language sql
  stable
  security invoker
  set search_path = pg_catalog, public, extensions
as $$
  select distinct on (w.org_id, w.debtor_id) w.*
    from public.payer_dispute_windows w
   where w.effective_from <= as_of
     and (w.effective_to is null or w.effective_to >= as_of)
   order by w.org_id, w.debtor_id, w.effective_from desc, w.created_at desc, w.id desc;
$$;

comment on function app.payer_dispute_windows_as_of(date) is
  'The payer dispute windows in force on a date, one per debtor (ADR 0071 §2). '
  'Not security definer: the caller''s RLS decides whose rows these are.';

do $$
declare
  r text;
begin
  revoke all on function app.payer_dispute_windows_as_of(date) from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function app.payer_dispute_windows_as_of(date) from %I', r);
      execute format('revoke all on function app.payer_dispute_window_names_its_recorder() from %I', r);
    end if;
  end loop;
  grant execute on function app.payer_dispute_windows_as_of(date) to app_rw, app_ro;
end
$$;

-- 5 ---------------------------------------------------------------------------
do $$
declare
  r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'payer_dispute_windows'::regclass) then
    raise exception '0043: RLS is off on payer_dispute_windows';
  end if;
  foreach r in array array['app_rw', 'app_ro'] loop
    if has_table_privilege(r, 'payer_dispute_windows', 'UPDATE')
       or has_table_privilege(r, 'payer_dispute_windows', 'DELETE')
       or has_table_privilege(r, 'payer_dispute_windows', 'TRUNCATE') then
      raise exception '0043: % holds UPDATE, DELETE or TRUNCATE on payer_dispute_windows', r;
    end if;
  end loop;
  if has_table_privilege('app_ro', 'payer_dispute_windows', 'INSERT') then
    raise exception '0043: app_ro holds INSERT on payer_dispute_windows';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r)
       and (has_table_privilege(r, 'payer_dispute_windows', 'SELECT')
            or has_table_privilege(r, 'payer_dispute_windows', 'INSERT')
            or has_table_privilege(r, 'payer_dispute_windows', 'UPDATE')
            or has_table_privilege(r, 'payer_dispute_windows', 'DELETE')
            or has_function_privilege(r, 'app.payer_dispute_windows_as_of(date)', 'EXECUTE')) then
      raise exception '0043: request role % holds a privilege on payer_dispute_windows', r;
    end if;
  end loop;
  if (select count(*) from pg_trigger
       where tgrelid = 'payer_dispute_windows'::regclass
         and tgname in ('no_update_delete', 'no_truncate',
                        'payer_dispute_window_names_its_recorder')) <> 3 then
    raise exception '0043: payer_dispute_windows is missing a trigger';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.proname in ('payer_dispute_window_names_its_recorder', 'payer_dispute_windows_as_of')
       and (p.prosecdef
            or not coalesce(p.proconfig @> array['search_path=pg_catalog, public, extensions'], false))
  ) then
    raise exception '0043: a function is definer or has no pinned search_path';
  end if;
end
$$;
