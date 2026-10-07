-- 0045 — The books are kept with each sync (ADR 0074, proposed; ADR 0066 §4).
--
-- ADR 0066 built the Books page as a read-through: the chart, the trial balance
-- and the general ledger are read from QuickBooks in the request and gone when
-- the page closes. A month-end tie-out wants the books as they stood at close,
-- and a post-audit claim two years on is answered by what the customer's own
-- ledger said when the deduction was found. The founder approved keeping a
-- snapshot with each daily sync and answered ADR 0066 §4's three questions:
-- kept indefinitely, the deductions accounts and not the whole ledger, and
-- hash-chained per connection.
--
-- What this does, and nothing else:
--   1. `ledger_snapshots`: one row per completed sync run per connection — the
--      run's window, the trial balance's totals in cents, line counts, a
--      status (`complete` or `refused`, with a class name), and `sha256` over
--      the canonical JSON of its content plus `prev_sha256`, the previous
--      snapshot's hash for the same connection. Tied to the tenant through
--      composite foreign keys to the connection and the run (ADR 0025 §7).
--   2. `ledger_snapshot_lines`: the trial balance's rows and the general-ledger
--      postings on the receivable, posting and deductions accounts, in bigint
--      cents. No memo and no customer or vendor name.
--   3. Both append-only on 0004's pattern (revoke, `no_update_delete`,
--      `no_truncate` on `app.block_mutations()`), RLS on with `tenant_read`,
--      `app_rw` and `app_ro` SELECT only, nothing to a request role.
--   4. `app.record_ledger_snapshot()`: the only door, definer and bounded to
--      the caller's org claim and subject exactly as
--      `app.record_ledger_sync_run()` is. Under a lock on the connection it
--      refuses a `prev_sha256` that is not the chain's head, a snapshot whose
--      lines do not add up to its totals or match its counts, and one for a
--      run that is not the caller's completed run; then it writes the header
--      and every line in the caller's one transaction.
--   5. A closing read of the catalogue that aborts if any of it did not hold.
--
-- What is deliberately NOT here: any edit to an existing table, function,
-- trigger or policy (`app.block_mutations()` is used, not redefined); any
-- UPDATE or DELETE grant on any append-only table; any `numeric` or float
-- money column; any retention job (kept indefinitely, ADR 0074 §1). The
-- database does not recompute the hash: canonical JSON has one definition, in
-- core-domain, and the rows are enough for anyone to recompute it.
--
-- Idempotent throughout, because `scripts/db-test.sh` applies every migration
-- twice; `supabase/tests/41_the_books_are_kept.sql` reads the end state back.

-- 1 ---------------------------------------------------------------------------
create table if not exists ledger_snapshots (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations (id),
  connection_id            uuid not null,
  -- The completed sync run this snapshot was taken by. One snapshot per run.
  run_id                   uuid not null unique,
  -- The trial balance's as-of day: the run's last day, by the door's check.
  as_of                    date not null,
  -- The general ledger's window: the run's own, by the door's check.
  window_from              date not null,
  window_to                date not null,
  -- As the ledger reported them (`Accrual`/`Cash`, an ISO currency). Short
  -- labels, never free text.
  basis                    text check (basis is null
                                       or (btrim(basis) <> '' and length(basis) <= 32)),
  currency                 text check (currency is null or currency ~ '^[A-Z]{3}$'),
  status                   text not null check (status in ('complete', 'refused')),
  -- A class name and never a message (invariant 4), as ledger_sync_runs keeps.
  refusal_class            text check (refusal_class is null
                                       or refusal_class ~ '^[A-Za-z_$][A-Za-z0-9_$]{0,63}$'),
  -- The trial balance's own totals, in integer cents (invariant 3).
  total_debit_cents        bigint,
  total_credit_cents       bigint,
  trial_balance_line_count integer not null check (trial_balance_line_count >= 0),
  ledger_line_count        integer not null check (ledger_line_count >= 0),
  sha256                   text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  prev_sha256              text check (prev_sha256 is null or prev_sha256 ~ '^[0-9a-f]{64}$'),
  -- Orders the chain: `created_at` is fixed per transaction and cannot.
  seq                      bigserial not null,
  -- The member the run acted as; the door refuses anybody else.
  created_by               uuid not null references users (id),
  created_at               timestamptz not null default now(),

  constraint ledger_snapshots_window check (window_to >= window_from),
  -- Refused exactly when there is a class name, no totals and no lines.
  constraint ledger_snapshots_status_shape check (
    (status = 'complete'
       and refusal_class is null
       and total_debit_cents is not null and total_credit_cents is not null)
    or (status = 'refused'
       and refusal_class is not null
       and total_debit_cents is null and total_credit_cents is null
       and trial_balance_line_count = 0 and ledger_line_count = 0)),
  constraint ledger_snapshots_not_its_own_prev check (prev_sha256 is distinct from sha256),
  constraint ledger_snapshots_org_id_id_key unique (org_id, id),
  -- A fork is a constraint violation as well as a refusal: one snapshot per
  -- predecessor per connection, and one first snapshot.
  constraint ledger_snapshots_one_successor
    unique nulls not distinct (org_id, connection_id, prev_sha256),
  constraint ledger_snapshots_one_hash unique (org_id, connection_id, sha256),
  constraint ledger_snapshots_connection_same_org
    foreign key (org_id, connection_id) references accounting_connections (org_id, id),
  constraint ledger_snapshots_run_same_org
    foreign key (org_id, run_id) references ledger_sync_runs (org_id, id)
);

create index if not exists ledger_snapshots_connection_idx
  on ledger_snapshots (org_id, connection_id, seq desc);

comment on table ledger_snapshots is
  'The books as a completed ledger sync read them (ADR 0074, ADR 0066 §4): the '
  'trial balance''s totals and counts, a status, and sha256 over the canonical '
  'JSON of the content plus prev_sha256, the previous snapshot''s hash for the '
  'same connection. Append-only and kept indefinitely; written once, complete, '
  'through app.record_ledger_snapshot().';

-- 2 ---------------------------------------------------------------------------
create table if not exists ledger_snapshot_lines (
  org_id                  uuid not null references organizations (id),
  snapshot_id             uuid not null,
  kind                    text not null check (kind in ('trial_balance', 'ledger_posting')),
  -- 1.. per kind, in the order the ledger printed them; assigned by the door.
  line_no                 integer not null check (line_no >= 1),
  account_external_id     text check (account_external_id is null
                                      or (btrim(account_external_id) <> ''
                                          and length(account_external_id) <= 128)),
  account_name            text not null check (length(account_name) <= 500),
  debit_cents             bigint not null,
  credit_cents            bigint not null,
  -- A posting's own fields; null on a trial-balance row. Ids, a type and a
  -- document number — never a memo or a name off the ledger.
  txn_date                date,
  txn_type                text check (txn_type is null or length(txn_type) <= 64),
  transaction_external_id text check (transaction_external_id is null
                                      or (btrim(transaction_external_id) <> ''
                                          and length(transaction_external_id) <= 128)),
  doc_number              text check (doc_number is null or length(doc_number) <= 64),

  primary key (snapshot_id, kind, line_no),
  constraint ledger_snapshot_lines_kind_shape check (
    (kind = 'trial_balance'
       and txn_date is null and txn_type is null
       and transaction_external_id is null and doc_number is null)
    or (kind = 'ledger_posting' and txn_date is not null)),
  constraint ledger_snapshot_lines_snapshot_same_org
    foreign key (org_id, snapshot_id) references ledger_snapshots (org_id, id)
);

comment on table ledger_snapshot_lines is
  'A ledger snapshot''s lines (ADR 0074): the trial balance''s rows and the '
  'general-ledger postings on the receivable, posting and deductions accounts, '
  'in bigint cents. No memo and no customer or vendor name. Append-only; '
  'written with their snapshot, all or none.';

-- 3 ---------------------------------------------------------------------------
alter table ledger_snapshots enable row level security;
alter table ledger_snapshot_lines enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ledger_snapshots', 'ledger_snapshot_lines'] loop
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('drop policy if exists tenant_read on %I', t);
    execute format('drop policy if exists tenant_insert on %I', t);
    execute format('drop policy if exists tenant_update on %I', t);
    execute format('drop policy if exists tenant_delete on %I', t);
    execute format(
      'create policy tenant_read on %I for select using (org_id = app.current_org_id())', t);
    -- Present, and deliberately never reachable: app_rw holds no INSERT (below),
    -- so every row goes through app.record_ledger_snapshot(). The policies exist
    -- so a grant issued in a hurry lands on a rule rather than on nothing.
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

    execute format('revoke all on %I from app_rw, app_ro', t);
    execute format('grant select on %I to app_rw, app_ro', t);

    -- The grant answers for app_rw; the trigger answers for the owner (0004).
    execute format('drop trigger if exists no_update_delete on %I', t);
    execute format(
      'create trigger no_update_delete before update or delete on %I
         for each row execute function app.block_mutations()', t);
    execute format('drop trigger if exists no_truncate on %I', t);
    execute format(
      'create trigger no_truncate before truncate on %I
         for each statement execute function app.block_mutations()', t);
  end loop;

  -- Supabase's request roles, where the platform has them (0028's rule).
  foreach t in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = t) then
      execute format('revoke all on ledger_snapshots, ledger_snapshot_lines from %I', t);
    end if;
  end loop;
end
$$;

-- `seq`'s sequence: nothing but the door's insert needs it, and the door is
-- the owner's.
revoke all on sequence ledger_snapshots_seq_seq from app_rw, app_ro;

-- 4 ---------------------------------------------------------------------------
-- Definer for app.record_ledger_sync_run()'s reason — app_rw holds no INSERT
-- on either table — and bounded the same way: the header's org must be the
-- caller's org claim and its created_by the caller's subject, so it reaches no
-- further than its caller already reaches.
--
-- `p_header` is a json object of
--   {org_id, connection_id, run_id, created_by, as_of, window_from, window_to,
--    basis, currency, status, refusal_class, total_debit_cents,
--    total_credit_cents, trial_balance_line_count, ledger_line_count,
--    sha256, prev_sha256}
-- with cents as decimal strings. `p_trial_balance` is an array of
--   {account_external_id, account_name, debit_cents, credit_cents}
-- and `p_postings` an array of those plus
--   {txn_date, txn_type, transaction_external_id, doc_number}.
-- Nothing else is read out of them; line numbers are the arrays' order.
create or replace function app.record_ledger_snapshot(
  p_header        jsonb,
  p_trial_balance jsonb,
  p_postings      jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  caller_org uuid := app.current_org_id();
  caller_sub uuid := app.current_user_id();
  v_org uuid;
  v_connection uuid;
  v_run uuid;
  v_status text;
  v_prev text;
  v_tb_count integer;
  v_gl_count integer;
  v_debit bigint;
  v_credit bigint;
  run_org uuid;
  run_member uuid;
  run_connection uuid;
  run_outcome text;
  run_from date;
  run_to date;
  head text;
  sum_debit bigint;
  sum_credit bigint;
  new_id uuid;
begin
  if caller_org is null or caller_sub is null then
    raise exception
      'ledger snapshot blocked: no tenant claims are set; a snapshot is written '
      'as the member the sync acted as, never as nobody'
      using errcode = 'insufficient_privilege';
  end if;

  if p_header is null or jsonb_typeof(p_header) <> 'object'
     or p_trial_balance is null or jsonb_typeof(p_trial_balance) <> 'array'
     or p_postings is null or jsonb_typeof(p_postings) <> 'array' then
    raise exception
      'ledger snapshot blocked: expected a json header object and two json arrays'
      using errcode = 'invalid_parameter_value';
  end if;

  v_org := (p_header->>'org_id')::uuid;
  if v_org is distinct from caller_org then
    raise exception
      'ledger snapshot blocked: org % is not the tenant these claims are for', v_org
      using errcode = 'insufficient_privilege';
  end if;

  if (p_header->>'created_by')::uuid is distinct from caller_sub then
    raise exception
      'ledger snapshot blocked: a snapshot names the member its run acted as, and '
      'these claims are not that member'
      using errcode = 'insufficient_privilege';
  end if;

  v_connection := (p_header->>'connection_id')::uuid;
  v_run := (p_header->>'run_id')::uuid;
  v_status := p_header->>'status';
  v_prev := p_header->>'prev_sha256';
  v_tb_count := (p_header->>'trial_balance_line_count')::integer;
  v_gl_count := (p_header->>'ledger_line_count')::integer;
  v_debit := (p_header->>'total_debit_cents')::bigint;
  v_credit := (p_header->>'total_credit_cents')::bigint;

  select r.org_id, r.requested_by, r.connection_id, r.outcome, r.window_from, r.window_to
    into run_org, run_member, run_connection, run_outcome, run_from, run_to
    from ledger_sync_runs r where r.id = v_run;

  -- Another tenant's run reads exactly as a missing one: this function is
  -- definer and must not become a way to learn which run ids exist elsewhere.
  if run_org is null or run_org <> caller_org then
    raise exception 'ledger snapshot blocked: run % does not exist', v_run
      using errcode = 'restrict_violation';
  end if;

  if run_member is distinct from caller_sub then
    raise exception
      'ledger snapshot blocked: run % acted as another member; a snapshot is '
      'written as the member its run acted as', v_run
      using errcode = 'insufficient_privilege';
  end if;

  if run_connection is distinct from v_connection then
    raise exception
      'ledger snapshot blocked: run % read another connection', v_run
      using errcode = 'restrict_violation';
  end if;

  if run_outcome <> 'completed' then
    raise exception
      'ledger snapshot blocked: run % is %, and only a completed run takes a snapshot',
      v_run, run_outcome
      using errcode = 'restrict_violation';
  end if;

  if (p_header->>'window_from')::date is distinct from run_from
     or (p_header->>'window_to')::date is distinct from run_to
     or (p_header->>'as_of')::date is distinct from run_to then
    raise exception
      'ledger snapshot blocked: a snapshot covers its run''s window, as of its last day'
      using errcode = 'restrict_violation';
  end if;

  if v_status = 'refused' then
    if jsonb_array_length(p_trial_balance) <> 0 or jsonb_array_length(p_postings) <> 0 then
      raise exception
        'ledger snapshot blocked: a refused snapshot read nothing and has no lines'
        using errcode = 'restrict_violation';
    end if;
  elsif v_status = 'complete' then
    if v_tb_count is distinct from jsonb_array_length(p_trial_balance)
       or v_gl_count is distinct from jsonb_array_length(p_postings) then
      raise exception
        'ledger snapshot blocked: the counts say % and % lines and % and % were given; '
        'a partial snapshot is not the snapshot',
        v_tb_count, v_gl_count,
        jsonb_array_length(p_trial_balance), jsonb_array_length(p_postings)
        using errcode = 'restrict_violation';
    end if;
    select coalesce(sum((e->>'debit_cents')::bigint), 0),
           coalesce(sum((e->>'credit_cents')::bigint), 0)
      into sum_debit, sum_credit
      from jsonb_array_elements(p_trial_balance) as e;
    if sum_debit is distinct from v_debit or sum_credit is distinct from v_credit then
      raise exception
        'ledger snapshot blocked: the trial balance''s lines do not add up to its totals'
        using errcode = 'restrict_violation';
    end if;
  end if;
  -- Any other status is the table's check constraint's to refuse.

  -- The chain's head, under a lock on the connection (seed 6; 0–5 are taken —
  -- the document read, the invoice claim, the refresh lock, the inbound claim,
  -- the team locks, the posting-setup claim). Two runs racing on one connection
  -- queue here, and the second finds the first's hash as the head.
  perform pg_advisory_xact_lock(
    hashtextextended('ledger_snapshot:' || v_connection::text, 6));

  select s.sha256 into head
    from ledger_snapshots s
   where s.org_id = caller_org and s.connection_id = v_connection
   order by s.seq desc
   limit 1;

  if v_prev is distinct from head then
    raise exception
      'ledger snapshot blocked: prev_sha256 is not the chain''s head for connection %; '
      'a snapshot follows the latest one, and the chain does not fork', v_connection
      using errcode = 'restrict_violation';
  end if;

  if exists (select 1 from ledger_snapshots s where s.run_id = v_run) then
    raise exception
      'ledger snapshot blocked: run % already has its snapshot; it is written once', v_run
      using errcode = 'restrict_violation';
  end if;

  insert into ledger_snapshots
    (org_id, connection_id, run_id, as_of, window_from, window_to, basis, currency,
     status, refusal_class, total_debit_cents, total_credit_cents,
     trial_balance_line_count, ledger_line_count, sha256, prev_sha256, created_by)
  values
    (caller_org, v_connection, v_run, run_to, run_from, run_to,
     p_header->>'basis', p_header->>'currency', v_status, p_header->>'refusal_class',
     v_debit, v_credit, coalesce(v_tb_count, 0), coalesce(v_gl_count, 0),
     p_header->>'sha256', v_prev, caller_sub)
  returning id into new_id;

  insert into ledger_snapshot_lines
    (org_id, snapshot_id, kind, line_no, account_external_id, account_name,
     debit_cents, credit_cents)
  select caller_org, new_id, 'trial_balance', n::integer,
         e->>'account_external_id', e->>'account_name',
         (e->>'debit_cents')::bigint, (e->>'credit_cents')::bigint
    from jsonb_array_elements(p_trial_balance) with ordinality as x(e, n);

  insert into ledger_snapshot_lines
    (org_id, snapshot_id, kind, line_no, account_external_id, account_name,
     debit_cents, credit_cents, txn_date, txn_type, transaction_external_id, doc_number)
  select caller_org, new_id, 'ledger_posting', n::integer,
         e->>'account_external_id', e->>'account_name',
         (e->>'debit_cents')::bigint, (e->>'credit_cents')::bigint,
         (e->>'txn_date')::date, e->>'txn_type', e->>'transaction_external_id',
         e->>'doc_number'
    from jsonb_array_elements(p_postings) with ordinality as x(e, n);

  return new_id;
end
$$;

comment on function app.record_ledger_snapshot(jsonb, jsonb, jsonb) is
  'The only way a ledger_snapshots or ledger_snapshot_lines row is written (ADR '
  '0074). Definer and bounded to the caller''s own org claim and subject, like '
  'app.record_ledger_sync_run(); a completed run of the caller''s, its window, '
  'the chain''s head under a lock on the connection, lines that add up to the '
  'totals, and all of it in one transaction.';

revoke all on function app.record_ledger_snapshot(jsonb, jsonb, jsonb) from public;
grant execute on function app.record_ledger_snapshot(jsonb, jsonb, jsonb) to app_rw;

-- 5 ---------------------------------------------------------------------------
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['ledger_snapshots', 'ledger_snapshot_lines'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      raise exception '0045: RLS is off on %', t;
    end if;
    foreach r in array array['app_rw', 'app_ro'] loop
      if not has_table_privilege(r, t, 'SELECT') then
        raise exception '0045: % cannot read %', r, t;
      end if;
      if has_table_privilege(r, t, 'INSERT')
         or has_table_privilege(r, t, 'UPDATE')
         or has_table_privilege(r, t, 'DELETE')
         or has_table_privilege(r, t, 'TRUNCATE') then
        raise exception '0045: % holds a write privilege on %', r, t;
      end if;
    end loop;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r)
         and (has_table_privilege(r, t, 'SELECT')
              or has_table_privilege(r, t, 'INSERT')
              or has_table_privilege(r, t, 'UPDATE')
              or has_table_privilege(r, t, 'DELETE')) then
        raise exception '0045: request role % holds a privilege on %', r, t;
      end if;
    end loop;
    if (select count(*) from pg_trigger
         where tgrelid = t::regclass and not tgisinternal
           and tgname in ('no_update_delete', 'no_truncate')) <> 2 then
      raise exception '0045: % is missing an append-only trigger', t;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name in ('ledger_snapshots', 'ledger_snapshot_lines')
       and column_name like '%cents'
       and data_type <> 'bigint'
  ) then
    raise exception '0045: a cents column is not bigint';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name in ('ledger_snapshots', 'ledger_snapshot_lines')
       and (column_name ilike '%memo%' or column_name ilike '%message%'
            or column_name ilike '%customer%' or column_name ilike '%vendor%')
  ) then
    raise exception '0045: a snapshot keeps no memo, message or counterparty name';
  end if;

  foreach r in array array['anon', 'authenticated', 'service_role', 'app_ro'] loop
    if exists (select 1 from pg_roles where rolname = r)
       and has_function_privilege(r, 'app.record_ledger_snapshot(jsonb, jsonb, jsonb)', 'EXECUTE') then
      raise exception '0045: % may execute app.record_ledger_snapshot', r;
    end if;
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.proname = 'record_ledger_snapshot'
       and (not p.prosecdef
            or not coalesce(p.proconfig @> array['search_path=pg_catalog, public, extensions'], false))
  ) then
    raise exception '0045: app.record_ledger_snapshot is not definer, or not pinned';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.prokind = 'f'
       and not coalesce(
         exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'), false)
  ) then
    raise exception '0045: an app function has no pinned search_path';
  end if;
end
$$;
