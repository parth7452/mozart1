-- 0040 — a payer's reason code maps to ours as data (ADR 0066, proposed).
--
-- What this does, and nothing else:
--   1. payer_code_maps: one row says that, for one tenant and one debtor, a
--      payer's printed code means one canonical reason code from a date on.
--      Append-only; superseding a mapping is a new row with a later
--      effective_from. Every row is a tenant's: org_id and debtor_id are not
--      null, and (org_id, debtor_id) is a composite foreign key (ADR 0025 §7).
--   2. The canonical list as a check constraint, dropped and re-added so it is
--      the list in this file whatever ran before.
--      packages/store-postgres/test/payer-code-maps.test.ts holds it equal to
--      CANONICAL_REASON_CODES in both directions.
--   3. app.member_is_owner_or_approver(), in app.member_is_owner()'s shape.
--   4. app.payer_code_map_names_its_recorder(): recorded_by is the caller
--      (0031's rule for approvals, 0036's for sheet mappings).
--   5. RLS: tenant_read; tenant_insert for an owner or approver writing as
--      themselves. Grants: app_rw SELECT+INSERT, app_ro SELECT, nothing to a
--      request role. no_update_delete and no_truncate.
--   6. app.payer_code_maps_as_of(date) and the view payer_code_maps_current:
--      the one statement of which row applies on a date.
--   7. A closing read of the catalogue that aborts if any of it did not hold.
--
-- Not here: any UPDATE or DELETE grant, any money column, any change to an
-- existing table, function, trigger or policy. Safe to run twice.

-- 1 ---------------------------------------------------------------------------
create table if not exists payer_code_maps (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id),
  debtor_id       uuid not null,
  -- As printed, normalised by normalisePayerCode (core-domain): trimmed,
  -- whitespace runs collapsed to one space, uppercased. The check refuses what
  -- could not have come out of that rule; it does not re-implement it.
  payer_code      text not null check (
                    length(payer_code) between 1 and 64
                    and payer_code = btrim(payer_code, ' ')
                    and payer_code !~ '  '
                    and payer_code !~ '[a-z]'
                    and payer_code !~ '[\t\n\r\f\v]'),
  canonical_code  text not null,
  effective_from  date not null,
  effective_to    date,
  source          text not null check (source in (
                    'payer_guide_url',     -- the payer's own published guide
                    'customer_confirmed',  -- the customer said so
                    'glimpse_guide',       -- a competitor's published guide
                    'operator')),          -- one of us, on the customer's behalf
  source_note     text check (source_note is null or length(source_note) between 1 and 500),
  confidence      text not null check (confidence in ('low', 'medium', 'high')),
  recorded_by     uuid not null references users (id),
  created_at      timestamptz not null default now(),
  constraint payer_code_maps_effective_range
    check (effective_to is null or effective_to >= effective_from),
  constraint payer_code_maps_one_per_start
    unique (org_id, debtor_id, payer_code, effective_from),
  constraint payer_code_maps_same_org_debtor
    foreign key (org_id, debtor_id) references debtors (org_id, id)
);

comment on table payer_code_maps is
  'A payer''s printed reason code mapped to a canonical one, per tenant and '
  'debtor, effective-dated, with its source and confidence (ADR 0066). '
  'Append-only: a correction is a new row with a later effective_from. '
  'app.payer_code_maps_as_of() says which row applies on a date.';

-- 2 ---------------------------------------------------------------------------
do $$
begin
  alter table payer_code_maps drop constraint if exists payer_code_maps_canonical_code_check;
  alter table payer_code_maps add constraint payer_code_maps_canonical_code_check check (
    canonical_code in (
      'shortage_quantity', 'shortage_carton', 'shortage_concealed',
      'shortage_never_received', 'shortage_pallet', 'price_discrepancy',
      'price_unauthorised_change', 'cost_increase_not_honoured', 'unauthorised_deduction_no_basis',
      'substitution_price', 'compliance_otif', 'compliance_late_delivery',
      'compliance_early_delivery', 'compliance_asn_missing', 'compliance_asn_inaccurate',
      'compliance_label_barcode', 'compliance_packaging', 'compliance_routing_guide',
      'compliance_appointment_missed', 'compliance_pallet_spec', 'duplicate_payment',
      'duplicate_claim', 'duplicate_invoice_deduction', 'return_unsaleable',
      'return_authorised', 'return_unauthorised', 'return_handling_fee',
      'promo_allowance_claimed', 'promo_not_agreed', 'promo_duplicate_allowance',
      'promo_rate_mismatch', 'markdown_allowance', 'coop_advertising',
      'new_store_allowance', 'freight_prepaid_billed', 'freight_rate_mismatch',
      'freight_unauthorised_carrier', 'detention_or_layover', 'quality_damaged_in_transit',
      'quality_expired_short_dated', 'quality_spec_mismatch', 'post_audit_pricing',
      'post_audit_allowance', 'post_audit_freight', 'unknown_uncoded',
      'administrative_fee', 'tax_adjustment'
    )
  );
end
$$;

-- 3 ---------------------------------------------------------------------------
create or replace function app.member_is_owner_or_approver() returns boolean
  language sql
  stable
  set search_path = pg_catalog, public, extensions
as $$
  select exists (
    select 1 from memberships m
     where m.org_id = app.current_org_id()
       and m.user_id = app.current_user_id()
       and m.role in ('owner', 'approver')
  );
$$;

comment on function app.member_is_owner_or_approver() is
  'Whether the caller is an owner or approver of the org their claims name. '
  'Adding a payer code mapping is theirs (ADR 0066 §6). Not security definer: '
  'it reads the caller''s own membership under RLS, like app.member_is_owner().';

revoke all on function app.member_is_owner_or_approver() from public;
grant execute on function app.member_is_owner_or_approver() to app_rw, app_ro;

-- 4 ---------------------------------------------------------------------------
create or replace function app.payer_code_map_names_its_recorder() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  -- A mapping decides which reason a later case is offered by default; the
  -- person who recorded it writes it, in their own session. No exception for
  -- the table owner or a session with no claims.
  if new.recorded_by is distinct from app.current_user_id() then
    raise exception
      'payer code map blocked: recorded_by % is not the caller %',
      new.recorded_by, coalesce(app.current_user_id()::text, '(no session)')
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

revoke all on function app.payer_code_map_names_its_recorder() from public;

drop trigger if exists payer_code_map_names_its_recorder on payer_code_maps;
create trigger payer_code_map_names_its_recorder before insert on payer_code_maps
  for each row execute function app.payer_code_map_names_its_recorder();

-- 5 ---------------------------------------------------------------------------
alter table payer_code_maps enable row level security;

do $$
declare
  r text;
begin
  drop policy if exists tenant_read on payer_code_maps;
  drop policy if exists tenant_insert on payer_code_maps;
  create policy tenant_read on payer_code_maps for select
    using (org_id = app.current_org_id());
  create policy tenant_insert on payer_code_maps for insert
    with check (org_id = app.current_org_id()
                and app.member_is_owner_or_approver()
                and recorded_by = app.current_user_id());

  revoke all on payer_code_maps from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on payer_code_maps from %I', r);
    end if;
  end loop;
  revoke all on payer_code_maps from app_rw;
  revoke all on payer_code_maps from app_ro;
  grant select, insert on payer_code_maps to app_rw;
  grant select on payer_code_maps to app_ro;

  drop trigger if exists no_update_delete on payer_code_maps;
  create trigger no_update_delete before update or delete on payer_code_maps
    for each row execute function app.block_mutations();
  drop trigger if exists no_truncate on payer_code_maps;
  create trigger no_truncate before truncate on payer_code_maps
    for each statement execute function app.block_mutations();
end
$$;

-- 6 ---------------------------------------------------------------------------
-- Which row applies on a date, said once: per (org, debtor, payer code), the
-- latest effective_from on or before the date, among rows whose effective_to
-- is null or on or after it. Not definer, so RLS applies to the caller.
-- packages/core-domain/src/payer-code-map.ts states the same rule as a pure
-- function, and payer-code-maps.test.ts holds the two to one answer.
create or replace function app.payer_code_maps_as_of(as_of date)
  returns setof public.payer_code_maps
  language sql
  stable
  set search_path = pg_catalog, public, extensions
as $$
  select distinct on (m.org_id, m.debtor_id, m.payer_code) m.*
    from public.payer_code_maps m
   where m.effective_from <= as_of
     and (m.effective_to is null or m.effective_to >= as_of)
   order by m.org_id, m.debtor_id, m.payer_code, m.effective_from desc;
$$;

comment on function app.payer_code_maps_as_of(date) is
  'The payer code mappings in force on a date (ADR 0066 §4). Not security '
  'definer: the caller''s RLS decides whose rows these are.';

revoke all on function app.payer_code_maps_as_of(date) from public;
grant execute on function app.payer_code_maps_as_of(date) to app_rw, app_ro;

create or replace view payer_code_maps_current
  with (security_invoker = true) as
  select id, org_id, debtor_id, payer_code, canonical_code, effective_from, effective_to,
         source, source_note, confidence, recorded_by, created_at
    from app.payer_code_maps_as_of(current_date);

comment on view payer_code_maps_current is
  'app.payer_code_maps_as_of(current_date): the mappings in force today. '
  'security_invoker, so the caller''s RLS applies.';

do $$
declare
  r text;
begin
  revoke all on payer_code_maps_current from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on payer_code_maps_current from %I', r);
      execute format('revoke all on function app.payer_code_maps_as_of(date) from %I', r);
      execute format('revoke all on function app.member_is_owner_or_approver() from %I', r);
      execute format('revoke all on function app.payer_code_map_names_its_recorder() from %I', r);
    end if;
  end loop;
  revoke all on payer_code_maps_current from app_rw;
  revoke all on payer_code_maps_current from app_ro;
  grant select on payer_code_maps_current to app_rw, app_ro;
end
$$;

-- 7 ---------------------------------------------------------------------------
do $$
declare
  r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'payer_code_maps'::regclass) then
    raise exception '0040: RLS is off on payer_code_maps';
  end if;
  foreach r in array array['app_rw', 'app_ro'] loop
    if has_table_privilege(r, 'payer_code_maps', 'UPDATE')
       or has_table_privilege(r, 'payer_code_maps', 'DELETE')
       or has_table_privilege(r, 'payer_code_maps', 'TRUNCATE') then
      raise exception '0040: % holds UPDATE, DELETE or TRUNCATE on payer_code_maps', r;
    end if;
  end loop;
  if has_table_privilege('app_ro', 'payer_code_maps', 'INSERT') then
    raise exception '0040: app_ro holds INSERT on payer_code_maps';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r)
       and (has_table_privilege(r, 'payer_code_maps', 'SELECT')
            or has_table_privilege(r, 'payer_code_maps', 'INSERT')
            or has_table_privilege(r, 'payer_code_maps', 'UPDATE')
            or has_table_privilege(r, 'payer_code_maps', 'DELETE')
            or has_table_privilege(r, 'payer_code_maps_current', 'SELECT')) then
      raise exception '0040: request role % holds a privilege on payer_code_maps', r;
    end if;
  end loop;
  if (select count(*) from pg_trigger
       where tgrelid = 'payer_code_maps'::regclass
         and tgname in ('no_update_delete', 'no_truncate', 'payer_code_map_names_its_recorder')) <> 3 then
    raise exception '0040: payer_code_maps is missing a trigger';
  end if;
  if not coalesce((select c.reloptions @> array['security_invoker=true']
                     from pg_class c where c.oid = 'payer_code_maps_current'::regclass), false) then
    raise exception '0040: payer_code_maps_current is not security_invoker';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.proname in ('member_is_owner_or_approver', 'payer_code_map_names_its_recorder',
                         'payer_code_maps_as_of')
       and (p.prosecdef
            or not coalesce(p.proconfig @> array['search_path=pg_catalog, public, extensions'], false))
  ) then
    raise exception '0040: a function is definer or has no pinned search_path';
  end if;
end
$$;
