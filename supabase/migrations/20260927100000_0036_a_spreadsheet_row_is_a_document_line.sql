-- 0036 — a spreadsheet row is a document line (ADR 0056).
--
-- What this does, and nothing else:
--   1. `unique (org_id, id)` on extraction_results, debtors and documents where
--      no unique constraint on exactly those columns exists yet, so the new
--      tables can tie their tenancy with composite foreign keys (ADR 0025 §7).
--   2. sheet_mappings: a person-confirmed, versioned column mapping per tenant
--      and debtor, append-only; a new version is a new row. A row names the
--      person who confirmed it, and app.sheet_mapping_names_its_confirmer()
--      requires that to be the caller (0031's rule for approvals).
--   3. extraction_result_cells: the cell each field read from a spreadsheet
--      came from — its provenance in place of a page and a box. Append-only.
--   4. RLS, tenant_read/tenant_insert, grants (app_rw SELECT+INSERT, app_ro
--      SELECT), no request-role privilege, no_update_delete and no_truncate.
--   5. deductions.discovered_via admits 'report_row'.
--   6. inbound_message_parts.outcome admits the six spreadsheet refusals.
--   7. A closing read of the catalogue that aborts if any of it did not hold.
--
-- Not here: any UPDATE or DELETE grant, any money column, any change to an
-- existing function or trigger. Safe to run twice.

-- 1 ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['extraction_results', 'debtors', 'documents'] loop
    if not exists (
      select 1
        from pg_constraint c
       where c.conrelid = t::regclass
         and c.contype in ('u', 'p')
         and (select array_agg(a.attname::text order by a.attname)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any (c.conkey))
             = array['id', 'org_id']
    ) then
      execute format('alter table %I add constraint %I unique (org_id, id)', t, t || '_org_id_id_key');
    end if;
  end loop;
end
$$;

-- 2 ---------------------------------------------------------------------------
create table if not exists sheet_mappings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  debtor_id           uuid not null,
  version             integer not null check (version > 0),
  effective_from      date not null,
  header_row          integer not null check (header_row > 0),
  sheet_name          text not null check (sheet_name <> ''),
  header_fingerprint  text[] not null check (cardinality(header_fingerprint) > 0),
  shape               text not null check (shape in ('remittance', 'deduction_list')),
  columns             jsonb not null check (jsonb_typeof(columns) = 'object'),
  non_line_rule       jsonb not null check (jsonb_typeof(non_line_rule) = 'object'),
  sign                text not null check (sign in ('deductions_positive', 'deductions_negative')),
  currency            char(3) not null,
  date_order          text not null check (date_order in ('mdy', 'dmy', 'ymd')),
  source_document_id  uuid,
  confirmed_by        uuid not null references users (id),
  created_at          timestamptz not null default now(),
  unique (org_id, debtor_id, header_fingerprint, version),
  foreign key (org_id, debtor_id) references debtors (org_id, id),
  foreign key (org_id, source_document_id) references documents (org_id, id)
);

create or replace function app.sheet_mapping_names_its_confirmer() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  -- A mapping decides how every later sheet from this debtor is read; the
  -- person who confirmed it writes it, in their own session. No exception for
  -- the table owner or a session with no claims.
  if new.confirmed_by is distinct from app.current_user_id() then
    raise exception
      'sheet mapping blocked: confirmed_by % is not the caller %',
      new.confirmed_by, coalesce(app.current_user_id()::text, '(no session)')
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

drop trigger if exists sheet_mapping_names_its_confirmer on sheet_mappings;
create trigger sheet_mapping_names_its_confirmer before insert on sheet_mappings
  for each row execute function app.sheet_mapping_names_its_confirmer();

-- 3 ---------------------------------------------------------------------------
create table if not exists extraction_result_cells (
  extraction_result_id  bigint primary key,  -- extraction_results.id is bigint
  org_id                uuid not null,
  sheet_name            text not null,
  row_number            integer not null check (row_number > 0),
  column_number         integer not null check (column_number > 0),
  cell_ref              text not null,
  cell_type             text not null check (cell_type in (
                          'shared_string', 'inline_string', 'number', 'boolean',
                          'date_serial', 'csv_field')),
  number_format         text,
  was_formula           boolean not null,
  foreign key (org_id, extraction_result_id) references extraction_results (org_id, id)
);

-- 4 ---------------------------------------------------------------------------
alter table sheet_mappings enable row level security;
alter table extraction_result_cells enable row level security;

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['sheet_mappings', 'extraction_result_cells'] loop
    execute format('drop policy if exists tenant_read on %I', t);
    execute format('drop policy if exists tenant_insert on %I', t);
    execute format(
      'create policy tenant_read on %I for select using (org_id = app.current_org_id())', t);
    execute format(
      'create policy tenant_insert on %I for insert with check (org_id = app.current_org_id())', t);

    execute format('revoke all on %I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', t, r);
      end if;
    end loop;
    execute format('revoke all on %I from app_rw', t);
    execute format('revoke all on %I from app_ro', t);
    execute format('grant select, insert on %I to app_rw', t);
    execute format('grant select on %I to app_ro', t);

    execute format('drop trigger if exists no_update_delete on %I', t);
    execute format(
      'create trigger no_update_delete before update or delete on %I
         for each row execute function app.block_mutations()', t);
    execute format('drop trigger if exists no_truncate on %I', t);
    execute format(
      'create trigger no_truncate before truncate on %I
         for each statement execute function app.block_mutations()', t);
  end loop;
end
$$;

-- 5 ---------------------------------------------------------------------------
do $$
begin
  alter table deductions drop constraint if exists deductions_discovered_via_check;
  alter table deductions add constraint deductions_discovered_via_check check (
    discovered_via in (
      'notice',           -- a deduction_notice named it
      'remittance_line',  -- a line on a remittance advice paid the invoice short
      'report_row'        -- a row of a spreadsheet, read through a sheet mapping
    )
  );
end
$$;

-- 6 ---------------------------------------------------------------------------
do $$
declare
  name text;
begin
  select conname into name
    from pg_constraint
   where conrelid = 'inbound_message_parts'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%outcome%' and pg_get_constraintdef(oid) like '%malformed_pdf%';
  name := coalesce(name, 'inbound_message_parts_outcome_check');
  execute format('alter table inbound_message_parts drop constraint if exists %I', name);
  execute format($f$
    alter table inbound_message_parts add constraint %I check (outcome in (
      'stored', 'already_held', 'over_daily_budget', 'not_clean',
      'inline_image', 'too_many_parts', 'not_base64',
      'empty_file', 'body_too_short', 'too_large', 'type_not_allowed',
      'content_does_not_match_type', 'encrypted_pdf',
      'active_content_pdf', 'decompression_bomb', 'malformed_pdf',
      'macro_enabled_spreadsheet', 'active_content_spreadsheet',
      'legacy_or_encrypted_office', 'xml_dtd_refused',
      'malformed_spreadsheet', 'spreadsheet_too_large'))$f$, name);
end
$$;

-- 7 ---------------------------------------------------------------------------
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['sheet_mappings', 'extraction_result_cells'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      raise exception '0036: RLS is off on %', t;
    end if;
    foreach r in array array['app_rw', 'app_ro'] loop
      if has_table_privilege(r, t, 'UPDATE') or has_table_privilege(r, t, 'DELETE')
         or has_table_privilege(r, t, 'TRUNCATE') then
        raise exception '0036: % holds UPDATE, DELETE or TRUNCATE on %', r, t;
      end if;
    end loop;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r)
         and (has_table_privilege(r, t, 'SELECT') or has_table_privilege(r, t, 'INSERT')
              or has_table_privilege(r, t, 'UPDATE') or has_table_privilege(r, t, 'DELETE')) then
        raise exception '0036: request role % holds a privilege on %', r, t;
      end if;
    end loop;
    if (select count(*) from pg_trigger
         where tgrelid = t::regclass and tgname in ('no_update_delete', 'no_truncate')) <> 2 then
      raise exception '0036: % is missing an append-only trigger', t;
    end if;
  end loop;
end
$$;
