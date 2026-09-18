-- 0006 — RLS is the authorisation layer (invariant 6), plus role grants.
--
-- Every reachable table carries a policy keyed on org_id, and every policy
-- column is indexed. Nothing in app code says "where org_id = …" for safety;
-- that is the database's job.

-- Decisions and approvals are written once and never edited: an approval you
-- can rewrite is not an approval. Same immutability machinery as 0004.
do $$
declare t text;
begin
  foreach t in array array['decisions', 'approvals']
  loop
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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  append_only text[] := array['documents', 'document_scans', 'document_classifications',
                              'deduction_events', 'audit_log', 'decisions', 'approvals'];
  mutable text[] := array['organizations', 'users', 'memberships', 'org_settings',
                          'debtors', 'debtor_aliases', 'uploads', 'deductions',
                          'submissions', 'writebacks', 'writeoffs'];
begin
  foreach t in array append_only loop
    execute format('revoke all on %I from app_rw, app_ro', t);
    execute format('grant insert, select on %I to app_rw', t);
    execute format('grant select on %I to app_ro', t);
  end loop;

  foreach t in array mutable loop
    execute format('revoke all on %I from app_rw, app_ro', t);
    execute format('grant select, insert, update, delete on %I to app_rw', t);
    execute format('grant select on %I to app_ro', t);
  end loop;
end
$$;

grant usage, select on all sequences in schema public to app_rw;
grant select on document_state to app_rw, app_ro;

-- On Supabase the request role is `authenticated`; let it inherit exactly the
-- app_rw privilege set rather than maintaining two grant lists.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant app_rw to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  org_scoped text[] := array['memberships', 'org_settings', 'debtors', 'debtor_aliases',
                             'uploads', 'documents', 'document_scans',
                             'document_classifications', 'deductions', 'deduction_events',
                             'decisions', 'approvals', 'submissions', 'writebacks',
                             'writeoffs', 'audit_log'];
begin
  foreach t in array org_scoped loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I
         using (org_id = app.current_org_id())
         with check (org_id = app.current_org_id())', t);
  end loop;
end
$$;

alter table organizations enable row level security;
drop policy if exists tenant_isolation on organizations;
create policy tenant_isolation on organizations
  using (id = app.current_org_id())
  with check (id = app.current_org_id());

-- A user row is visible to members of an org that user belongs to.
alter table users enable row level security;
drop policy if exists tenant_isolation on users;
create policy tenant_isolation on users
  using (exists (
    select 1 from memberships m
     where m.user_id = users.id and m.org_id = app.current_org_id()))
  with check (exists (
    select 1 from memberships m
     where m.user_id = users.id and m.org_id = app.current_org_id()));

-- Index every policy column (org_id is already covered by the composite
-- indexes in 0003/0004/0005; these fill the gaps).
create index if not exists org_settings_org_idx on org_settings (org_id);
create index if not exists memberships_org_idx on memberships (org_id);
create index if not exists debtors_org_idx on debtors (org_id);
create index if not exists uploads_org_idx on uploads (org_id);
