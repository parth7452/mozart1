-- 0010 — The approval gate covers every statement, and writing needs a writer.
--
-- Found by security review: require_approval() was `before insert` only while
-- app_rw held update and delete on the same tables, so a row could be filed
-- against an approved decision and then repointed at an unapproved one, or
-- deleted outright. And tenant_isolation keyed only on org_id, so a read_only
-- member could write whatever their tenant could write (ADR 0012).

-- ---------------------------------------------------------------------------
-- 1. A record of an outbound act cannot be deleted.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['submissions', 'writebacks', 'writeoffs']
  loop
    execute format('revoke delete, truncate on %I from app_rw', t);
    execute format('drop trigger if exists no_delete on %I', t);
    execute format(
      'create trigger no_delete before delete on %I
         for each row execute function app.block_mutations()', t);
    execute format('drop trigger if exists no_truncate on %I', t);
    execute format(
      'create trigger no_truncate before truncate on %I
         for each statement execute function app.block_mutations()', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Only the lifecycle columns may change, and never the ones that decide
--    what was authorised.
-- ---------------------------------------------------------------------------
-- One function for three tables, so the column list is data rather than three
-- near-identical functions. Compared through to_jsonb: plpgsql resolves a record
-- field even inside a guarded branch, so `new.method` raises on a table that has
-- no such column.
create or replace function app.guard_immutable_core() returns trigger
  language plpgsql as $$
declare
  immutable_cols text[] := array['id', 'org_id', 'deduction_id', 'decision_id'] ||
    case tg_table_name
      when 'submissions' then array['channel']
      when 'writebacks' then array['method']
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

do $$
declare
  t text;
  action text;
begin
  foreach t in array array['submissions', 'writebacks', 'writeoffs']
  loop
    action := case t when 'submissions' then 'submit'
                     when 'writebacks' then 'writeback'
                     else 'writeoff' end;

    execute format('drop trigger if exists guard_immutable_core on %I', t);
    execute format(
      'create trigger guard_immutable_core before update on %I
         for each row execute function app.guard_immutable_core()', t);

    -- The gate again on UPDATE: a row may never come to rest against a
    -- decision nobody approved, however it got there.
    execute format('drop trigger if exists enforce_approval_on_update on %I', t);
    execute format(
      'create trigger enforce_approval_on_update before update on %I
         for each row execute function app.require_approval(%L)', t, action);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Writing needs a writer.
-- ---------------------------------------------------------------------------
create or replace function app.member_may_write() returns boolean
  language sql stable as $$
  select exists (
    select 1 from memberships m
     where m.org_id = app.current_org_id()
       and m.user_id = app.current_user_id()
       and m.role in ('owner', 'approver', 'analyst')
  );
$$;

grant execute on function app.member_may_write() to app_rw, app_ro;

-- One policy per command: a single policy's USING clause governs reads and the
-- row-selection half of writes alike, so a role predicate there would have
-- blocked reading too.
do $$
declare
  t text;
  org_scoped text[] := array['memberships', 'org_settings', 'debtors', 'debtor_aliases',
                             'uploads', 'documents', 'document_scans',
                             'document_classifications', 'deductions', 'deduction_events',
                             'decisions', 'approvals', 'submissions', 'writebacks',
                             'writeoffs', 'audit_log', 'deduction_documents',
                             'document_pages', 'extraction_results', 'model_calls'];
begin
  foreach t in array org_scoped loop
    -- Migrations re-run against an existing database (that is how the suites
    -- are gated), so every policy is dropped before it is recreated.
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('drop policy if exists tenant_read on %I', t);
    execute format('drop policy if exists tenant_insert on %I', t);
    execute format('drop policy if exists tenant_update on %I', t);
    execute format('drop policy if exists tenant_delete on %I', t);

    execute format(
      'create policy tenant_read on %I for select
         using (org_id = app.current_org_id())', t);
    execute format(
      'create policy tenant_insert on %I for insert
         with check (org_id = app.current_org_id() and app.member_may_write())', t);
    execute format(
      'create policy tenant_update on %I for update
         using (org_id = app.current_org_id() and app.member_may_write())
         with check (org_id = app.current_org_id() and app.member_may_write())', t);
    execute format(
      'create policy tenant_delete on %I for delete
         using (org_id = app.current_org_id() and app.member_may_write())', t);
  end loop;
end
$$;

-- organizations and users are keyed differently; reads stay tenant-scoped and
-- neither is written from a request path.
drop policy if exists tenant_isolation on organizations;
drop policy if exists tenant_read on organizations;
create policy tenant_read on organizations for select
  using (id = app.current_org_id());

drop policy if exists tenant_isolation on users;
drop policy if exists tenant_read on users;
create policy tenant_read on users for select
  using (exists (
    select 1 from memberships m
     where m.user_id = users.id and m.org_id = app.current_org_id()));
