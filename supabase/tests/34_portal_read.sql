\echo '-- 34 a portal is read with a sealed credential (ADR 0057 §15, migration 0038)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid;
  b jsonb; org_b uuid;
  owner_a uuid; owner_a2 uuid; owner_a3 uuid; owner_b uuid; reader_a uuid;
  -- Account ids no other run of this suite, and no Vitest fixture, will hold:
  -- one-per-account is across every org, and a used database keeps rows.
  digits text := lpad((floor(random() * 1e11))::bigint::text, 11, '0');
  acct text;
  acct_folded_twin text;
  acct_production text;
  today date := (now() at time zone 'utc')::date;
  past date;
  later date;
  conn_a uuid; conn_a2 uuid; conn_a3 uuid; conn_params uuid; conn_b uuid; conn_b_coupa uuid;
  cred_1 uuid; cred_2 uuid; latest uuid;
  paths text[] := array['/Authenticator.aw', '/mfa', '/sso/acs'];
  hosts_hex text := encode(digest('service.ariba.com', 'sha256'), 'hex');
  recipe_person jsonb;
  ver_1 uuid; ver_2 uuid; ver_3 uuid; ver_rejected uuid; ver_future uuid;
  ver_agent uuid; ver_agent_2 uuid; ver_other_portal uuid; ver_b uuid;
  run_live uuid; run_dry uuid; run_future_dry uuid; run_nc uuid; run_b uuid; run_a3 uuid; run_x uuid;
  got uuid; again uuid;
  upl uuid; upl_b uuid; doc_1 uuid; doc_b uuid;
  sha_1 text := encode(digest('portal-landing', 'sha256'), 'hex');
  sha_2 text := encode(digest('portal-export', 'sha256'), 'hex');
  n int; t text; r text; c text; why text; who text; privs text; def text;
  expected text[]; actual text[]; missing text; extra text;
  fn record;
  valid_step_log jsonb := '[{"step": "sign_in", "passed": true}, {"step": "expect_anid", "passed": false}]';
  seven constant text[] := array[
    'portal_connections', 'portal_credentials', 'portal_recipe_versions',
    'portal_recipe_reviews', 'portal_read_starts', 'portal_read_runs', 'portal_captures'];
  six constant text[] := array[
    'portal_credentials', 'portal_recipe_versions', 'portal_recipe_reviews',
    'portal_read_starts', 'portal_read_runs', 'portal_captures'];
  -- packages/portal/src/contracts.ts PORTAL_COLUMNS, verbatim and in order.
  contract_columns jsonb := jsonb_build_object(
    'portal_connections', jsonb_build_array(
      'id', 'org_id', 'portal_key', 'label', 'account_id', 'params', 'enabled',
      'created_by', 'created_at', 'updated_at'),
    'portal_credentials', jsonb_build_array(
      'id', 'seq', 'org_id', 'connection_id', 'label', 'cipher', 'key_id', 'wrapped_key',
      'ciphertext', 'sign_in_origin', 'sign_in_paths', 'hosts_hash', 'created_by', 'created_at'),
    'portal_recipe_versions', jsonb_build_array(
      'id', 'org_id', 'portal_key', 'version', 'effective_from', 'recipe', 'created_by',
      'agent_session_id', 'created_at'),
    'portal_recipe_reviews', jsonb_build_array(
      'id', 'org_id', 'recipe_version_id', 'verdict', 'reviewer', 'compared_with_version_id',
      'additions', 'created_at'),
    'portal_read_starts', jsonb_build_array(
      'id', 'org_id', 'connection_id', 'recipe_version_id', 'dry_run', 'requested_by', 'started_at'),
    'portal_read_runs', jsonb_build_array(
      'id', 'org_id', 'run_id', 'outcome', 'reason', 'error_class', 'at_step', 'page_count',
      'capture_count', 'new_document_count', 'deduplicated_count', 'refusal_count', 'step_log',
      'finished_at'),
    'portal_captures', jsonb_build_array(
      'id', 'org_id', 'run_id', 'recipe_version_id', 'document_id', 'refusal', 'kind',
      'step_name', 'page_path', 'snapshot_rule_version', 'sha256', 'captured_at', 'created_at'));
  ins_conn constant text :=
    'insert into portal_connections (org_id, portal_key, label, account_id, params, created_by, enabled)
     values (%L, %L, %L, %L, %L, %L, %L)';
  ins_cred constant text :=
    'insert into portal_credentials (org_id, connection_id, label, cipher, key_id, wrapped_key,
       ciphertext, sign_in_origin, sign_in_paths, hosts_hash, created_by)
     values (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)';
  ins_ver constant text :=
    'insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe,
       created_by, agent_session_id)
     values (%L, %L, %L, %L, %L, %L, %L)';
  ins_rev constant text :=
    'insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer,
       compared_with_version_id, additions)
     values (%L, %L, %L, %L, %L, %L)';
  start_fn constant text := 'select app.record_portal_read_start(%L, %L, %L, %L, %L, %L)';
  run_fn constant text :=
    'select app.record_portal_read_run(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)';
  ins_cap constant text :=
    'insert into portal_captures (org_id, run_id, recipe_version_id, document_id, refusal, kind,
       step_name, page_path, snapshot_rule_version, sha256, captured_at)
     values (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)';
begin
  acct := 'AN' || digits || '-T';
  acct_folded_twin := 'an ' || digits || ' t';
  acct_production := 'AN' || digits;
  past := today - 30;
  later := today + 30;

  a := test.seed_org('portalreada');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid; approver_a := (a->>'approver')::uuid;
  b := test.seed_org('portalreadb');
  org_b := (b->>'org')::uuid;

  -- Owners are added as the table owner: who is an owner is an owner's
  -- decision, and the seed has none to make it.
  insert into users (email, full_name) values ('portalreada-owner@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('portalreada-owner2@example.test', 'Owner A2')
    returning id into owner_a2;
  insert into users (email, full_name) values ('portalreada-owner3@example.test', 'Owner A3')
    returning id into owner_a3;
  insert into users (email, full_name) values ('portalreada-reader@example.test', 'Reader A')
    returning id into reader_a;
  insert into users (email, full_name) values ('portalreadb-owner@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role) values
    (org_a, owner_a, 'owner'), (org_a, owner_a2, 'owner'), (org_a, owner_a3, 'owner'),
    (org_a, reader_a, 'read_only'), (org_b, owner_b, 'owner');

  -- Another tenant's document, for the tenancy ties below. How a document is
  -- stored is ingest's question, not this suite's.
  insert into uploads (org_id, source) values (org_b, 'portal_fetch') returning id into upl_b;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org_b, upl_b, digest('portal-b', 'sha256'), 10, 'text/html', 'portal/b')
    returning id into doc_b;

  -- =========================================================================
  -- A. The catalogue: the contract's columns, in both directions and in order
  -- =========================================================================
  -- Asked of the catalogue rather than of a list of bad names (suite 21's
  -- rule): a column nobody decided on fails here the day it is written, and a
  -- credential column on any of these tables is not a naming slip but
  -- invariant 4 and ADR 0057 §7.
  for t in select k from jsonb_object_keys(contract_columns) k order by k loop
    expected := array(select e from jsonb_array_elements_text(contract_columns -> t)
                        with ordinality x(e, i) order by i);
    select array_agg(col.column_name::text order by col.ordinal_position) into actual
      from information_schema.columns col
     where col.table_schema = 'public' and col.table_name = t;
    select string_agg(e, ', ') into missing from unnest(expected) e
     where e <> all (coalesce(actual, '{}'::text[]));
    select string_agg(e, ', ') into extra from unnest(coalesce(actual, '{}'::text[])) e
     where e <> all (expected);
    perform test.ok(missing is null,
      format('%s has every column the contract names (missing: %s)', t, missing));
    perform test.ok(extra is null,
      format('%s has no column nobody decided on (unexpected: %s)', t, extra));
    perform test.ok(actual = expected,
      format('%s has them in the contract''s order (%s)', t, array_to_string(actual, ', ')));
  end loop;

  select string_agg(format('%s.%s', col.table_name, col.column_name), ', ') into def
    from information_schema.columns col
   where col.table_schema = 'public'
     and col.table_name = any (seven)
     and col.column_name ~ '(password|passwd|username|user_name|secret|otp|token|cookie|'
                           'plaintext|mfa|html|page_text|query)';
  perform test.ok(def is null, format(
    'no portal table has a column for a credential, a code, a cookie or page text (found: %s)', def));

  -- RLS on, and one policy per command (ADR 0057 §15).
  foreach t in array seven loop
    perform test.ok((select relrowsecurity from pg_class where oid = t::regclass),
      format('%s has RLS on', t));
    select string_agg(p.policyname || ':' || p.cmd, ',' order by p.policyname) into def
      from pg_policies p where p.schemaname = 'public' and p.tablename = t;
    perform test.ok(
      def = 'tenant_delete:DELETE,tenant_insert:INSERT,tenant_read:SELECT,tenant_update:UPDATE',
      format('%s has one policy per command (%s)', t, def));
    perform test.ok(
      (select bool_and(p.permissive = 'PERMISSIVE') from pg_policies p
        where p.schemaname = 'public' and p.tablename = t),
      format('%s''s policies are permissive rules, not restrictive filters', t));
    select p.qual into def from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.policyname = 'tenant_read';
    perform test.ok(def = '(org_id = app.current_org_id())',
      format('%s is read by its own tenant, read_only included (%s)', t, def));
  end loop;

  -- The owner-only INSERT policies ADR 0057 §15 names, read back as written.
  foreach t in array array['portal_connections', 'portal_credentials', 'portal_recipe_reviews'] loop
    select p.with_check into def from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.policyname = 'tenant_insert';
    perform test.ok(
      position('app.current_org_id()' in def) > 0
        and position('app.member_is_owner()' in def) > 0
        and position(case t when 'portal_recipe_reviews' then 'reviewer = app.current_user_id()'
                            else 'created_by = app.current_user_id()' end in def) > 0,
      format('%s: an owner inserts, as themselves (%s)', t, def));
  end loop;
  select p.with_check into def from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'portal_recipe_versions'
     and p.policyname = 'tenant_insert';
  perform test.ok(
    position('app.member_may_write()' in def) > 0
      and position('created_by = app.current_user_id()' in def) > 0
      and position('agent_session_id IS NULL' in def) > 0
      and position('app.member_is_owner()' in def) > 0,
    format('portal_recipe_versions: a writer adds a person''s version, an owner an agent''s (%s)', def));

  -- The grants, as equalities: `grant all` is one word, and a test that only
  -- asked about the privilege it was written for would not notice it.
  foreach t in array seven loop
    select string_agg(p, ',' order by p) into privs
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     where has_table_privilege('app_rw', t, p);
    perform test.ok(
      privs = case when t in ('portal_read_starts', 'portal_read_runs') then 'SELECT'
                   else 'INSERT,SELECT' end,
      format('app_rw holds exactly %s on %s (holds: %s)',
             case when t in ('portal_read_starts', 'portal_read_runs') then 'SELECT'
                  else 'INSERT and SELECT' end, t, privs));
    select string_agg(p, ',' order by p) into privs
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     where has_table_privilege('app_ro', t, p);
    perform test.ok(privs = 'SELECT', format('app_ro holds exactly SELECT on %s (holds: %s)', t, privs));

    -- Column grants beyond the table's: only the registry's two mutable columns.
    select string_agg(format('%s %s %s', role_name, a2.attname, p), ', '
                      order by role_name, a2.attname, p) into privs
      from unnest(array['app_rw', 'app_ro']) role_name
      cross join pg_attribute a2
      cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
     where a2.attrelid = t::regclass and a2.attnum > 0 and not a2.attisdropped
       and has_column_privilege(role_name, t, a2.attname::text, p)
       and not has_table_privilege(role_name, t, p);
    perform test.ok(
      privs is not distinct from case when t = 'portal_connections'
                                      then 'app_rw enabled UPDATE, app_rw label UPDATE' end,
      format(case when t = 'portal_connections'
                  then '%s: app_rw''s one column grant is UPDATE on the label and enabled (%s)'
                  else '%s has no column grant beyond its table grants (%s)' end,
             t, coalesce(privs, 'none')));
  end loop;

  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    select string_agg(t2, ', ') into privs from unnest(seven) t2
     where has_table_privilege(r, t2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        or has_any_column_privilege(r, t2, 'SELECT, INSERT, UPDATE, REFERENCES');
    perform test.ok(privs is null,
      format('%s holds nothing on any portal table (holds some on: %s)', r, coalesce(privs, 'none')));
  end loop;

  -- Append-only by trigger, for the owner the grants do not answer for.
  foreach t in array six loop
    perform test.ok(
      (select count(*) from pg_trigger
        where tgrelid = t::regclass and tgfoid = 'app.block_mutations'::regproc
          and tgname in ('no_update_delete', 'no_truncate')) = 2,
      format('%s carries no_update_delete and no_truncate', t));
  end loop;
  perform test.ok(
    not exists (select 1 from pg_trigger
                 where tgrelid = 'portal_connections'::regclass
                   and tgfoid = 'app.block_mutations'::regproc),
    'portal_connections is not append-only: enabled flips');

  -- An author column is the caller's, for every role (0031's rule).
  for fn in
    select c2.relname::text as rel, pg_get_triggerdef(tg.oid) as def
      from pg_trigger tg join pg_class c2 on c2.oid = tg.tgrelid
     where tg.tgname = 'names_its_author' and c2.relname = any (seven)
     order by c2.relname
  loop
    perform test.ok(
      position('BEFORE INSERT' in fn.def) > 0 and position('FOR EACH ROW' in fn.def) > 0
        and position(format('portal_row_names_its_author(''%s'')',
                            case fn.rel when 'portal_recipe_reviews' then 'reviewer'
                                        when 'portal_read_starts' then 'requested_by'
                                        else 'created_by' end) in fn.def) > 0,
      format('%s names its author by trigger (%s)', fn.rel, fn.def));
  end loop;
  select array_agg(c2.relname::text order by c2.relname) into actual
    from pg_trigger tg join pg_class c2 on c2.oid = tg.tgrelid
   where tg.tgname = 'names_its_author' and c2.relname = any (seven);
  perform test.ok(
    actual = array['portal_connections', 'portal_credentials', 'portal_read_starts',
                  'portal_recipe_reviews', 'portal_recipe_versions'],
    format('on the five tables with an author column (%s)', array_to_string(actual, ', ')));
  select array_agg(tg.tgname::text order by tg.tgname) into actual
    from pg_trigger tg
   where tg.tgrelid = 'portal_recipe_reviews'::regclass and not tg.tgisinternal
     and tg.tgtype & 2 = 2 and tg.tgtype & 4 = 4;
  perform test.ok(actual = array['names_its_author', 'review_is_consistent'],
    format('a review''s before-insert triggers, in firing order: a forged one is refused as forged (%s)',
           array_to_string(actual, ', ')));

  -- The names the store matches a refusal on (contracts.ts PORTAL_CONSTRAINTS).
  select pg_get_indexdef(i.indexrelid) into def
    from pg_index i
   where i.indexrelid = 'portal_connections_one_enabled_per_account'::regclass
     and i.indisunique and i.indpred is not null;
  perform test.ok(
    def is not null
      and position('(portal_key, lower(regexp_replace(account_id' in def) > 0
      and position('WHERE enabled' in def) > 0,
    format('one enabled connection per portal account is a partial unique index over the '
           'folded id (%s)', def));
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'portal_recipe_versions_one_per_number' and contype = 'u')
      = 'UNIQUE (org_id, portal_key, version)',
    'portal_recipe_versions_one_per_number is unique (org_id, portal_key, version)');
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'portal_recipe_reviews_one_per_version' and contype = 'u')
      = 'UNIQUE (recipe_version_id)',
    'portal_recipe_reviews_one_per_version is unique (recipe_version_id)');
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'portal_read_runs_one_per_run' and contype = 'u')
      = 'UNIQUE (run_id)',
    'portal_read_runs_one_per_run is unique (run_id)');

  -- The tenancy ties are composite (ADR 0025 §7): each id exists, and is this org's.
  select string_agg(format('%s: %s', conrelid::regclass, pg_get_constraintdef(oid)), '; '
                    order by conrelid::regclass::text, conname) into def
    from pg_constraint
   where contype = 'f' and conrelid = any (seven::regclass[])
     and cardinality(conkey) = 1
     and confrelid in ('portal_connections'::regclass, 'portal_recipe_versions'::regclass,
                       'portal_read_starts'::regclass, 'documents'::regclass);
  perform test.ok(def is null, format(
    'no portal table names a connection, version, run or document by its id alone (%s)',
    coalesce(def, 'none')));
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'portal_credentials_same_org')
      = 'FOREIGN KEY (org_id, connection_id) REFERENCES portal_connections(org_id, id)',
    'a credential keys on (org_id, connection_id)');
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'portal_captures_document_same_org')
      = 'FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id)',
    'and a capture on (org_id, document_id)');

  -- The three definer functions: the contract's parameters, pinned, app_rw alone.
  for fn in
    select p.oid, p.proname::text as proname, p.prosecdef, p.proconfig, p.provolatile, l.lanname,
           pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
      from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where s.nspname = 'app'
       and p.proname in ('record_portal_read_start', 'record_portal_read_run', 'portal_connections_to_read')
  loop
    perform test.ok(fn.prosecdef, format('app.%s is security definer', fn.proname));
    perform test.ok(
      coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false),
      format('app.%s pins search_path = pg_catalog, public, extensions', fn.proname));
    perform test.ok(fn.lanname = 'plpgsql', format('app.%s is plpgsql', fn.proname));
    perform test.ok(not has_function_privilege('public', fn.oid, 'execute'),
      format('PUBLIC may not execute app.%s', fn.proname));
    perform test.ok(has_function_privilege('app_rw', fn.oid, 'execute'),
      format('app_rw may execute app.%s', fn.proname));
    perform test.ok(not has_function_privilege('app_ro', fn.oid, 'execute'),
      format('app_ro may not execute app.%s', fn.proname));
    perform test.ok(
      fn.args = case fn.proname
        when 'record_portal_read_start' then
          'p_run_id uuid, p_org_id uuid, p_connection_id uuid, p_recipe_version_id uuid, '
          'p_dry_run boolean, p_requested_by uuid'
        when 'record_portal_read_run' then
          'p_run_id uuid, p_org_id uuid, p_outcome text, p_reason text, p_error_class text, '
          'p_at_step text, p_page_count integer, p_capture_count integer, '
          'p_new_document_count integer, p_deduplicated_count integer, p_refusal_count integer, '
          'p_step_log jsonb'
        else '' end,
      format('app.%s takes the contract''s parameters, in order (%s)', fn.proname, fn.args));
    perform test.ok(
      fn.result = case fn.proname
        when 'portal_connections_to_read' then
          'TABLE(connection_id uuid, org_id uuid, portal_key text, created_by uuid)'
        else 'uuid' end,
      format('app.%s returns what the contract says (%s)', fn.proname, fn.result));
    if fn.proname = 'portal_connections_to_read' then
      perform test.ok(fn.provolatile = 's', 'the fan-out list is stable');
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app'
     and p.proname in ('record_portal_read_start', 'record_portal_read_run', 'portal_connections_to_read');
  perform test.ok(n = 3, format('exactly one of each, no stray overload (saw %s)', n));

  -- The rest run as whoever calls them: pinned, never definer, and the four
  -- a CHECK calls executable by app_rw, which is who inserts.
  for fn in
    select p.oid, p.proname::text as proname, p.prosecdef, p.proconfig, p.provolatile
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'app'
       and p.proname in ('portal_run_params_are_valid', 'portal_sign_in_paths_are_canonical',
                         'portal_step_log_is_valid', 'portal_recipe_additions_are_valid',
                         'portal_row_names_its_author', 'touch_portal_connection',
                         'portal_review_is_consistent', 'portal_capture_is_consistent')
  loop
    perform test.ok(not fn.prosecdef, format('app.%s is not security definer', fn.proname));
    perform test.ok(
      coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false),
      format('app.%s pins its search_path', fn.proname));
    perform test.ok(not has_function_privilege('public', fn.oid, 'execute'),
      format('PUBLIC may not execute app.%s', fn.proname));
    if fn.proname like '%\_is\_valid' or fn.proname like '%\_are\_%' then
      perform test.ok(fn.provolatile = 'i' and has_function_privilege('app_rw', fn.oid, 'execute'),
        format('app.%s is immutable, and app_rw may execute it: a CHECK runs it as the inserter',
               fn.proname));
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app'
     and p.proname in ('portal_run_params_are_valid', 'portal_sign_in_paths_are_canonical',
                       'portal_step_log_is_valid', 'portal_recipe_additions_are_valid',
                       'portal_row_names_its_author', 'touch_portal_connection',
                       'portal_review_is_consistent', 'portal_capture_is_consistent');
  perform test.ok(n = 8, format('the eight helper and trigger functions are there (saw %s)', n));

  set role app_rw;

  -- =========================================================================
  -- B. The registry: an owner connects, as themselves, once per account
  -- =========================================================================
  foreach r in array array['analyst', 'approver', 'reader'] loop
    who := case r when 'analyst' then 'an analyst' when 'approver' then 'an approver'
                  else 'a read_only member' end;
    perform test.as_member(org_a, case r when 'analyst' then analyst_a
                                        when 'approver' then approver_a else reader_a end);
    perform test.expect_error(
      format(ins_conn, org_a, 'sap_business_network', 'SAP', acct, '{}',
             case r when 'analyst' then analyst_a when 'approver' then approver_a else reader_a end, true),
      'row-level security', format('%s may not connect a portal', who));
  end loop;

  perform test.as_member(org_a, owner_a);
  perform test.ok(app.member_is_owner(), 'owner A is an owner');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct, '{}', owner_a2, true),
    'is not the caller', 'an owner may not connect one in another owner''s name');
  perform test.expect_error(
    format(ins_conn, org_b, 'sap_business_network', 'SAP', acct, '{}', owner_a, true),
    'row-level security', 'nor for another org');

  -- `updated_at` is supplied stale, so the trigger has something to move:
  -- now() is fixed for a transaction.
  insert into portal_connections (org_id, portal_key, label, account_id, params, created_by, updated_at)
    values (org_a, 'sap_business_network', 'SAP Business Network (test account)', acct,
            '{"region": "us"}', owner_a, '2020-01-01T00:00:00Z')
    returning id into conn_a;
  perform test.ok(conn_a is not null, 'an owner connects a portal account as themselves');
  perform test.ok(
    (select enabled and created_by = owner_a and params = '{"region": "us"}'::jsonb
       from portal_connections where id = conn_a),
    'enabled, acting as the owner who connected it, with its parameters');

  -- What each column may hold (contracts.ts), each refused by its own name.
  -- Disabled, so one-per-account is not what answers.
  perform test.expect_error(format(ins_conn, org_a, 'SAP', 'SAP', acct, '{}', owner_a, false),
    'portal_connections_portal_key_check', 'a portal key is lower-case data');
  perform test.expect_error(format(ins_conn, org_a, '9sap', 'SAP', acct, '{}', owner_a, false),
    'portal_connections_portal_key_check', 'and starts with a letter');
  perform test.expect_error(format(ins_conn, org_a, 'sap_business_network', '', acct, '{}', owner_a, false),
    'portal_connections_label_check', 'a label is not empty');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', ' SAP', acct, '{}', owner_a, false),
    'portal_connections_label_check', 'nor starts with a space');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP ', acct, '{}', owner_a, false),
    'portal_connections_label_check', 'nor ends with one');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', E'SAP\u00a0', acct, '{}', owner_a, false),
    'portal_connections_label_check', 'nor with a no-break space, which trim() removes too');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', E'S\tAP', acct, '{}', owner_a, false),
    'portal_connections_label_check', 'nor carries a control character');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', repeat('x', 121), acct, '{}', owner_a, false),
    'portal_connections_label_check', 'and is at most 120 characters');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', '---', '{}', owner_a, false),
    'portal_connections_account_id_check',
    'an account id with no letter or digit is refused: one-per-account could not compare it');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', ' ' || acct, '{}', owner_a, false),
    'portal_connections_account_id_check', 'an account id is trimmed');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', repeat('9', 129), '{}', owner_a, false),
    'portal_connections_account_id_check', 'and at most 128 characters');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct, '[]', owner_a, false),
    'portal_connections_params_check', 'run parameters are an object');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct, '{"supplier": 7}', owner_a, false),
    'portal_connections_params_check', 'of strings');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct, '{"1supplier": "x"}', owner_a, false),
    'portal_connections_params_check', 'under names that start with a letter');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct, '{"__proto__": "x"}', owner_a, false),
    'portal_connections_params_check', 'so __proto__ is never a name');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct, '{"supplier": ""}', owner_a, false),
    'portal_connections_params_check', 'no parameter is empty');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct,
           jsonb_build_object('supplier', repeat('x', 257)), owner_a, false),
    'portal_connections_params_check', 'or longer than 256 characters');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct,
           jsonb_build_object('supplier', E'a\u0001b'), owner_a, false),
    'portal_connections_params_check', 'or carries a control character');
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'SAP', acct,
           (select jsonb_object_agg('p' || i, 'v'::text) from generate_series(1, 33) i), owner_a, false),
    'portal_connections_params_check', 'and there are at most 32');
  insert into portal_connections (org_id, portal_key, label, account_id, params, created_by, enabled)
    values (org_a, 'sap_business_network', 'Thirty-two parameters', 'AN' || digits || '-P',
            (select jsonb_object_agg('p' || i, 'v'::text) from generate_series(1, 32) i), owner_a, false)
    returning id into conn_params;
  perform test.ok(conn_params is not null, 'thirty-two parameters are allowed');

  -- It changes where it has to, and nowhere else.
  update portal_connections set label = 'SAP Business Network' where id = conn_a;
  perform test.ok(
    (select label = 'SAP Business Network' and updated_at > '2020-01-02T00:00:00Z'::timestamptz
       from portal_connections where id = conn_a),
    'an owner renames a connection, and updated_at moves whatever was supplied');
  update portal_connections set enabled = false where id = conn_a;
  perform test.ok((select not enabled from portal_connections where id = conn_a),
    'and turns it off: the registry is not append-only');
  update portal_connections set enabled = true where id = conn_a;

  foreach c in array array['account_id', 'portal_key', 'params', 'created_by', 'org_id',
                           'created_at', 'updated_at', 'id'] loop
    perform test.expect_error(
      format('update portal_connections set %I = %I where id = %L', c, c, conn_a),
      'permission denied',
      format('app_rw may not update portal_connections.%s: its UPDATE is the label and enabled', c));
  end loop;
  perform test.expect_error(format('delete from portal_connections where id = %L', conn_a),
    'permission denied', 'no DELETE: turning a connection off is the verb');
  perform test.expect_error('truncate portal_connections', 'permission denied', 'nor TRUNCATE');

  foreach r in array array['analyst', 'reader'] loop
    perform test.as_member(org_a, case r when 'analyst' then analyst_a else reader_a end);
    update portal_connections set enabled = false where id = conn_a;
    get diagnostics n = row_count;
    perform test.ok(n = 0, format('%s''s update of a connection touches no row',
                                  case r when 'analyst' then 'an analyst' else 'a read_only member' end));
  end loop;
  perform test.as_member(org_a, owner_a);
  perform test.ok((select enabled from portal_connections where id = conn_a), 'so it is still on');

  -- The owner of the table is held by the trigger, by column name.
  reset role;
  perform test.expect_error(
    format('update portal_connections set account_id = account_id || ''X'' where id = %L', conn_a),
    'account_id cannot change', 'even the table owner cannot re-point a connection at another account');
  perform test.expect_error(
    format('update portal_connections set params = ''{"region": "eu"}'' where id = %L', conn_a),
    'params cannot change', 'nor change the parameters the runner types into the portal');
  perform test.expect_error(
    format('update portal_connections set portal_key = ''coupa_supplier_portal'' where id = %L', conn_a),
    'portal_key cannot change', 'nor the portal');
  perform test.expect_error(
    format('update portal_connections set created_by = %L where id = %L', owner_a2, conn_a),
    'created_by cannot change', 'nor the member every run acts as');
  perform test.expect_error(
    format('update portal_connections set org_id = %L where id = %L', org_b, conn_a),
    'org_id cannot change', 'nor the tenant');
  perform test.expect_error(
    format('update portal_connections set created_at = created_at - interval ''1 day''
              where id = %L', conn_a),
    'created_at cannot change', 'nor when it was made');
  update portal_connections set updated_at = '2000-01-01T00:00:00Z' where id = conn_a;
  perform test.ok(
    (select updated_at > '2020-01-02T00:00:00Z'::timestamptz from portal_connections where id = conn_a),
    'updated_at is the trigger''s, whoever writes it');
  set role app_rw;

  -- One enabled connection per portal account, across the whole deployment.
  perform test.as_member(org_a, owner_a2);
  perform test.expect_error(
    format(ins_conn, org_a, 'sap_business_network', 'Again', acct_folded_twin, '{}', owner_a2, true),
    'portal_connections_one_enabled_per_account',
    'a second enabled connection to one account is refused, its id folded for case, spaces and punctuation');
  perform test.as_member(org_b, owner_b);
  perform test.expect_error(
    format(ins_conn, org_b, 'sap_business_network', 'Elsewhere', acct, '{}', owner_b, true),
    'portal_connections_one_enabled_per_account',
    'and another workspace cannot read the account one workspace holds');
  insert into portal_connections (org_id, portal_key, label, account_id, created_by)
    values (org_b, 'sap_business_network', 'SAP production', acct_production, owner_b)
    returning id into conn_b;
  perform test.ok(conn_b is not null, 'an ANID''s test twin (-T) is another account');
  insert into portal_connections (org_id, portal_key, label, account_id, created_by)
    values (org_b, 'coupa_supplier_portal', 'Coupa', acct, owner_b)
    returning id into conn_b_coupa;
  perform test.ok(conn_b_coupa is not null, 'and the same id on another portal is another account');

  perform test.as_member(org_a, owner_a2);
  insert into portal_connections (org_id, portal_key, label, account_id, created_by, enabled)
    values (org_a, 'sap_business_network', 'SAP (A2)', acct_folded_twin, owner_a2, false)
    returning id into conn_a2;
  perform test.ok(conn_a2 is not null, 'a disabled connection may sit beside the enabled one');
  perform test.as_member(org_a, owner_a);
  update portal_connections set enabled = false where id = conn_a;
  update portal_connections set enabled = true where id = conn_a2;
  perform test.ok(
    (select count(*) from portal_connections
      where id in (conn_a, conn_a2) and enabled) = 1
      and (select enabled from portal_connections where id = conn_a2),
    'a connection moves to another owner as a new row, once the old one is off');
  perform test.expect_error(format('update portal_connections set enabled = true where id = %L', conn_a),
    'portal_connections_one_enabled_per_account', 'and the old one cannot come back on beside it');
  update portal_connections set enabled = false where id = conn_a2;
  update portal_connections set enabled = true where id = conn_a;

  -- =========================================================================
  -- C. A credential is sealed, bound, owner-only, and append-only
  -- =========================================================================
  foreach r in array array['analyst', 'approver', 'reader'] loop
    who := case r when 'analyst' then 'an analyst' when 'approver' then 'an approver'
                  else 'a read_only member' end;
    perform test.as_member(org_a, case r when 'analyst' then analyst_a
                                        when 'approver' then approver_a else reader_a end);
    perform test.expect_error(
      format(ins_cred, org_a, conn_a, 'Test user', 'aws-kms+aes-256-gcm', 'arn:aws:kms:k',
             'd3JhcHBlZA==', 'c2VhbGVk', 'https://service.ariba.com', paths, hosts_hex,
             case r when 'analyst' then analyst_a when 'approver' then approver_a else reader_a end),
      'row-level security', format('%s may not store a portal credential', who));
  end loop;

  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, 'Test user', 'aws-kms+aes-256-gcm', 'arn:aws:kms:k',
           'd3JhcHBlZA==', 'c2VhbGVk', 'https://service.ariba.com', paths, hosts_hex, owner_a2),
    'is not the caller', 'an owner may not store one in another owner''s name');
  perform test.expect_error(
    format(ins_cred, org_b, conn_b, 'Test user', 'aws-kms+aes-256-gcm', 'arn:aws:kms:k',
           'd3JhcHBlZA==', 'c2VhbGVk', 'https://service.ariba.com', paths, hosts_hex, owner_a),
    'row-level security', 'nor for another org');
  perform test.expect_error(
    format(ins_cred, org_a, conn_b, 'Test user', 'aws-kms+aes-256-gcm', 'arn:aws:kms:k',
           'd3JhcHBlZA==', 'c2VhbGVk', 'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_same_org', 'nor hang one off another tenant''s connection');

  insert into portal_credentials
    (org_id, connection_id, label, cipher, key_id, wrapped_key, ciphertext,
     sign_in_origin, sign_in_paths, hosts_hash, created_by)
    values (org_a, conn_a, 'Founder test user', 'aws-kms+aes-256-gcm',
            'arn:aws:kms:us-east-1:111122223333:key/portal', 'd3JhcHBlZA==', 'c2VhbGVk',
            'https://service.ariba.com', paths, hosts_hex, owner_a)
    returning id into cred_1;
  perform test.ok(cred_1 is not null, 'an owner stores a sealed credential, as themselves');

  -- What a sealed row may hold, each refused by name.
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, '   ', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_cipher_check', 'a blank cipher name is refused');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, E'\t', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_cipher_check', 'whatever whitespace it is blank with');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', '', 'dw==', 'cw==',
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_key_id_check', 'and so is a missing key id');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', '', 'cw==',
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_wrapped_key_check', 'a wrapped key is there');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', repeat('c', 20001),
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_ciphertext_check', 'and ciphertext is bounded');
  foreach def in array array[
    'https://service.ariba.com/', 'https://Service.Ariba.com', 'ftp://service.ariba.com',
    'https://user@service.ariba.com', 'https://service.ariba.com?x=1',
    'https://service.ariba.com#top', 'https:// service.ariba.com', 'https://sérvice.ariba.com',
    'https://service.ariba.com/Authenticator.aw', 'service.ariba.com'] loop
    perform test.expect_error(
      format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==', def, paths, hosts_hex, owner_a),
      'portal_credentials_sign_in_origin_check',
      format('a sign-in origin is URL.origin''s form, so %s is refused', def));
  end loop;
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', '{}'::text[], hosts_hex, owner_a),
    'portal_credentials_sign_in_paths_check', 'a binding names at least one sign-in path');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', array['/sso/acs', '/Authenticator.aw'], hosts_hex, owner_a),
    'portal_credentials_sign_in_paths_check', 'sorted');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', array['/mfa', '/mfa'], hosts_hex, owner_a),
    'portal_credentials_sign_in_paths_check', 'with no duplicates');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', array['mfa'], hosts_hex, owner_a),
    'portal_credentials_sign_in_paths_check', 'each a path');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', array['/mfa', null], hosts_hex, owner_a),
    'portal_credentials_sign_in_paths_check', 'and none of them null');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==', 'https://service.ariba.com',
           array(select '/p' || lpad(i::text, 3, '0') from generate_series(1, 65) i), hosts_hex, owner_a),
    'portal_credentials_sign_in_paths_check', 'and at most 64 of them');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', paths, upper(hosts_hex), owner_a),
    'portal_credentials_hosts_hash_check', 'the hosts hash is lower-case hex');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', paths, left(hosts_hex, 63), owner_a),
    'portal_credentials_hosts_hash_check', 'and all of a SHA-256');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, ' Founder', 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_label_check', 'a credential''s label is trimmed');
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, '', 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'portal_credentials_label_check', 'and never empty: absent is null');

  -- Replacing one is a new row, and the latest by seq is current.
  insert into portal_credentials
    (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
     sign_in_origin, sign_in_paths, hosts_hash, created_by)
    values (org_a, conn_a, 'aws-kms+aes-256-gcm', 'arn:aws:kms:us-east-1:111122223333:key/portal',
            'd3JhcHBlZDI=', 'c2VhbGVkMg==', 'http://[::1]:8080', array['/login'], hosts_hex, owner_a)
    returning id into cred_2;
  select count(*) into n from portal_credentials where connection_id = conn_a;
  perform test.ok(n = 2, format('replacing a credential leaves both rows (saw %s)', n));
  select id into latest from portal_credentials where connection_id = conn_a order by seq desc limit 1;
  perform test.ok(latest = cred_2,
    'and the latest row by seq is the one written last, though both share created_at');

  -- The table owner too, without a session: whoever writes the row says whose it is.
  reset role;
  perform test.as_nobody();
  perform test.expect_error(
    format(ins_cred, org_a, conn_a, null, 'c', 'k', 'dw==', 'cw==',
           'https://service.ariba.com', paths, hosts_hex, owner_a),
    'is not the caller', 'even the table owner stores no credential without a session');
  set role app_rw;

  -- =========================================================================
  -- D. A recipe version is data its author writes, and the row is the recipe
  -- =========================================================================
  recipe_person := jsonb_build_object(
    'portalKey', 'sap_business_network',
    'version', 1,
    'effectiveFrom', to_char(past, 'YYYY-MM-DD'),
    'hostAllowlist', jsonb_build_array('service.ariba.com'),
    'provenance', jsonb_build_object(
      'draftedBy', jsonb_build_object('kind', 'person', 'id', 'founder'),
      'source', 'hand walk-through',
      'portalAdr', 'docs/adr/0062-sap-business-network-is-the-first-live-portal.md'),
    'steps', jsonb_build_array(jsonb_build_object('kind', 'sign_in')));

  perform test.as_member(org_a, reader_a);
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 1, past, recipe_person, reader_a, null),
    'row-level security', 'a read_only member may not add a recipe version');

  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 1, past, recipe_person, approver_a, null),
    'is not the caller', 'a version names its author, and that is whoever writes it');
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_a, 'sap_business_network', 1, past, recipe_person, analyst_a)
    returning id into ver_1;
  perform test.ok(ver_1 is not null, 'any writer adds a person''s recipe version, as themselves');

  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 1, past, recipe_person, analyst_a, null),
    'portal_recipe_versions_one_per_number', 'one version per number: a changed portal is a new version');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 2, past,
           recipe_person || '{"portalKey": "coupa_supplier_portal", "version": 2}', analyst_a, null),
    'portal_recipe_versions_recipe_is_its_row', 'the row''s portal is the recipe''s');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 2, past, recipe_person, analyst_a, null),
    'portal_recipe_versions_recipe_is_its_row', 'its version is the recipe''s');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 2, later,
           recipe_person || '{"version": 2}', analyst_a, null),
    'portal_recipe_versions_recipe_is_its_row', 'and its effective date is the recipe''s');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 2, past,
           recipe_person || '{"version": "2"}', analyst_a, null),
    'portal_recipe_versions_recipe_is_its_row', 'a version is a number, not a string that reads as one');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 2, past,
           (recipe_person || '{"version": 2}') - 'effectiveFrom', analyst_a, null),
    'portal_recipe_versions_recipe_is_its_row', 'a recipe without its effective date is refused');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 2, past, '[]', analyst_a, null),
    'violates check constraint', 'as is one that is not an object');
  perform test.expect_error(
    format(ins_ver, org_a, 'SAP', 2, past,
           recipe_person || '{"portalKey": "SAP", "version": 2}', analyst_a, null),
    'portal_recipe_versions_portal_key_check', 'a portal key is data of one shape');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 0, past,
           recipe_person || '{"version": 0}', analyst_a, null),
    'portal_recipe_versions_version_check', 'and versions start at 1');

  -- Who drafted it is on the row and in the recipe, and they agree. Asked as an
  -- owner: RLS answers before a CHECK, and a row naming a session is an owner's.
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 2, past,
           recipe_person || '{"version": 2}', owner_a, 'session-1'),
    'portal_recipe_versions_drafted_by', 'a person''s version names no agent session');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 5, past,
           jsonb_set(recipe_person || '{"version": 5}', '{provenance,draftedBy}',
                     '{"kind": "agent_session", "id": "session-1"}'), owner_a, null),
    'portal_recipe_versions_drafted_by',
    'an agent session''s draft cannot pass as a person''s by leaving the session off the row');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 5, past,
           jsonb_set(recipe_person || '{"version": 5}', '{provenance,draftedBy}',
                     '{"kind": "agent_session", "id": "session-1"}'), owner_a, 'session-2'),
    'portal_recipe_versions_drafted_by', 'nor name another session than the recipe does');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 5, past,
           (recipe_person || '{"version": 5}') #- '{provenance,draftedBy}', owner_a, null),
    'portal_recipe_versions_drafted_by', 'and a version that says nobody drafted it is refused');
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 5, past,
           jsonb_set(recipe_person || '{"version": 5}', '{provenance,draftedBy}',
                     '{"kind": "agent_session", "id": "  "}'), owner_a, '  '),
    'portal_recipe_versions_agent_session_id_check', 'an agent session id is not blank');

  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    format(ins_ver, org_a, 'sap_business_network', 5, past,
           jsonb_set(recipe_person || '{"version": 5}', '{provenance,draftedBy}',
                     '{"kind": "agent_session", "id": "session-1"}'), analyst_a, 'session-1'),
    'row-level security', 'an agent session''s draft is an owner''s: only an owner starts a session');

  perform test.as_member(org_a, owner_a);
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_a, 'sap_business_network', 2, past, recipe_person || '{"version": 2}', owner_a)
    returning id into ver_2;
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_a, 'sap_business_network', 3, past, recipe_person || '{"version": 3}', owner_a)
    returning id into ver_3;
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_a, 'sap_business_network', 4, past, recipe_person || '{"version": 4}', owner_a)
    returning id into ver_rejected;
  insert into portal_recipe_versions
    (org_id, portal_key, version, effective_from, recipe, created_by, agent_session_id)
    values (org_a, 'sap_business_network', 5, past,
            jsonb_set(recipe_person || '{"version": 5}', '{provenance,draftedBy}',
                      '{"kind": "agent_session", "id": "session-1"}'), owner_a, 'session-1')
    returning id into ver_agent;
  perform test.ok(ver_agent is not null, 'an owner stores an agent session''s draft, naming the session');
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_a, 'sap_business_network', 6, later,
            recipe_person || jsonb_build_object('version', 6, 'effectiveFrom', to_char(later, 'YYYY-MM-DD')),
            owner_a)
    returning id into ver_future;
  insert into portal_recipe_versions
    (org_id, portal_key, version, effective_from, recipe, created_by, agent_session_id)
    values (org_a, 'sap_business_network', 7, past,
            jsonb_set(recipe_person || '{"version": 7}', '{provenance,draftedBy}',
                      '{"kind": "agent_session", "id": "session-2"}'), owner_a, 'session-2')
    returning id into ver_agent_2;
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_a, 'coupa_supplier_portal', 1, past,
            recipe_person || '{"portalKey": "coupa_supplier_portal"}', owner_a)
    returning id into ver_other_portal;
  perform test.as_member(org_b, owner_b);
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_b, 'sap_business_network', 1, past, recipe_person, owner_b)
    returning id into ver_b;
  perform test.ok(ver_b is not null, 'another workspace numbers its own versions: a recipe is per tenant');

  -- =========================================================================
  -- E. A person promotes a version: owner-only, once, and never an agent's
  --    draft that widens what a run may reach
  -- =========================================================================
  foreach r in array array['analyst', 'approver'] loop
    who := case r when 'analyst' then 'an analyst' when 'approver' then 'an approver'
                  else 'a read_only member' end;
    perform test.as_member(org_a, case r when 'analyst' then analyst_a else approver_a end);
    perform test.expect_error(
      format(ins_rev, org_a, ver_1, 'promoted', case r when 'analyst' then analyst_a else approver_a end,
             null, '[]'),
      'row-level security', format('%s may not promote a recipe version', who));
  end loop;

  perform test.as_member(org_a, owner_a);
  perform test.expect_error(format(ins_rev, org_a, ver_1, 'promoted', owner_a2, null, '[]'),
    'is not the caller', 'a review is written by the reviewer it names');
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer)
    values (org_a, ver_1, 'promoted', owner_a);
  perform test.ok(true, 'an owner promotes a version, as themselves');
  perform test.expect_error(format(ins_rev, org_a, ver_1, 'rejected', owner_a, null, '[]'),
    'portal_recipe_reviews_one_per_version', 'one verdict per version, and it is final');
  perform test.expect_error(format(ins_rev, org_a, ver_2, 'approved', owner_a, ver_1, '[]'),
    'portal_recipe_reviews_verdict_check', 'a verdict is promoted or rejected');

  foreach def in array array[
    '{}',
    '["host"]',
    '[{"kind": "host"}]',
    '[{"kind": "host", "host": 7}]',
    '[{"kind": "host", "host": "s1.ariba.com", "note": "x"}]',
    '[{"kind": "post_as_read", "step": "search", "path": "/graphql"}]',
    '[{"kind": "post_as_read", "step": "search", "path": "/graphql", '
      '"bodyDiscriminator": {"field": "operationName"}}]',
    '[{"kind": "post_as_read", "step": "search", "path": "/graphql", "bodyDiscriminator": "Q"}]',
    '[{"kind": "dismiss", "step": "cookies"}]',
    '[{"kind": "click", "step": "x"}]'] loop
    perform test.expect_error(format(ins_rev, org_a, ver_2, 'promoted', owner_a, ver_1, def),
      'portal_recipe_reviews_additions_check',
      format('additions are PortalRecipeAddition[], so %s is refused', def));
  end loop;

  perform test.expect_error(format(ins_rev, org_a, ver_2, 'promoted', owner_a, ver_2, '[]'),
    'portal_recipe_reviews_not_compared_with_itself', 'a version is not compared with itself');
  perform test.expect_error(format(ins_rev, org_a, ver_2, 'promoted', owner_a, ver_3, '[]'),
    'never promoted', 'additions are counted against a promoted version');
  perform test.expect_error(format(ins_rev, org_a, ver_2, 'promoted', owner_a, ver_b, '[]'),
    'portal_recipe_reviews_compared_same_org', 'of this workspace');
  perform test.expect_error(format(ins_rev, org_a, ver_b, 'promoted', owner_a, null, '[]'),
    'portal_recipe_reviews_version_same_org', 'and a review is of this workspace''s version');

  insert into portal_recipe_reviews
    (org_id, recipe_version_id, verdict, reviewer, compared_with_version_id, additions)
    values (org_a, ver_2, 'promoted', owner_a, ver_1,
            '[{"kind": "host", "host": "s1.ariba.com"},
              {"kind": "post_as_read", "step": "search", "path": "/graphql",
               "bodyDiscriminator": {"field": "operationName", "equals": "Deductions"}},
              {"kind": "post_as_read", "step": "export", "path": "/export", "bodyDiscriminator": null},
              {"kind": "dismiss", "step": "cookies", "label": "Accept"}]');
  perform test.ok(true, 'a person''s version may add a host, a POST-as-read entry and a dismiss, each named');
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer)
    values (org_a, ver_other_portal, 'promoted', owner_a);
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer, compared_with_version_id)
    values (org_a, ver_rejected, 'rejected', owner_a, ver_2);
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer, compared_with_version_id)
    values (org_a, ver_future, 'promoted', owner_a, ver_2);

  perform test.expect_error(
    format(ins_rev, org_a, ver_agent, 'promoted', owner_a, ver_2,
           '[{"kind": "host", "host": "evil.example"}]'),
    'drafted by an agent session', 'an agent session''s draft that adds a host is never promoted');
  perform test.expect_error(
    format(ins_rev, org_a, ver_agent, 'promoted', owner_a, ver_other_portal, '[]'),
    'another portal', 'and additions are counted against a version of the same portal');
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer, compared_with_version_id)
    values (org_a, ver_agent, 'promoted', owner_a, ver_2);
  perform test.ok(true, 'an agent session''s draft that adds nothing may be promoted');
  insert into portal_recipe_reviews
    (org_id, recipe_version_id, verdict, reviewer, compared_with_version_id, additions)
    values (org_a, ver_agent_2, 'rejected', owner_a, ver_2, '[{"kind": "host", "host": "evil.example"}]');
  perform test.ok(true, 'and a rejection may name what it refused');

  -- =========================================================================
  -- F. A run's start: one door, as the member the connection acts as
  -- =========================================================================
  perform test.expect_error(
    format('insert into portal_read_starts (id, org_id, connection_id, dry_run, requested_by)
              values (%L, %L, %L, true, %L)', gen_random_uuid(), org_a, conn_a, owner_a),
    'permission denied', 'app_rw may not insert a start: the function is the only door');

  perform test.as_nobody();
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_1, false, owner_a),
    'never as nobody', 'a caller with no claims records no start');
  perform set_config('request.jwt.claims', json_build_object('sub', owner_a::text)::text, true);
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_1, false, owner_a),
    'never as nobody', 'nor a subject with no org');
  perform set_config('request.jwt.claims', json_build_object('org_id', org_a::text)::text, true);
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_1, false, owner_a),
    'never as nobody', 'nor an org with no subject');

  perform test.as_member(org_a, owner_a);
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_b, conn_b, null, false, owner_a),
    'not the tenant', 'it writes only in the caller''s own org');
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_1, false, owner_a2),
    'these claims are not', 'and names the caller as the member the run acts as');
  perform test.expect_error(format(start_fn, null, org_a, conn_a, ver_1, false, owner_a),
    'are all required', 'a start has a run id');
  perform test.expect_error(
    format(start_fn, gen_random_uuid(), org_a, gen_random_uuid(), null, false, owner_a),
    'does not exist', 'and a connection that exists');
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_b, null, false, owner_a),
    'belongs to another org', 'of this org');
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_b, true, owner_a),
    'belongs to another org', 'and a version of this org');
  perform test.expect_error(
    format(start_fn, gen_random_uuid(), org_a, conn_a, ver_other_portal, true, owner_a),
    'is for portal', 'of the connection''s portal');
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_3, false, owner_a),
    'is not promoted', 'a read runs only a promoted version');
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_rejected, false, owner_a),
    'is not promoted', 'never a rejected one');
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_future, false, owner_a),
    'is not in effect until', 'and only once it is in effect');

  perform test.as_member(org_a, owner_a2);
  perform test.expect_error(format(start_fn, gen_random_uuid(), org_a, conn_a, ver_1, false, owner_a2),
    'acts as the member who connected it', 'another owner''s claims do not start a run of this connection');
  perform test.as_member(org_a, owner_a);

  run_dry := gen_random_uuid();
  got := app.record_portal_read_start(run_dry, org_a, conn_a, ver_3, true, owner_a);
  perform test.ok(got = run_dry, 'a dry run may run a version no owner has promoted yet');
  run_future_dry := gen_random_uuid();
  got := app.record_portal_read_start(run_future_dry, org_a, conn_a, ver_future, true, owner_a);
  perform test.ok(got = run_future_dry, 'or one whose date has not come');
  run_live := gen_random_uuid();
  got := app.record_portal_read_start(run_live, org_a, conn_a, ver_1, false, owner_a);
  perform test.ok(got = run_live, 'a read runs a promoted version in effect');
  run_nc := gen_random_uuid();
  got := app.record_portal_read_start(run_nc, org_a, conn_a, null, false, owner_a);
  perform test.ok(got = run_nc, 'and a run that found no version to run still has a start');
  perform test.ok(
    (select connection_id = conn_a and recipe_version_id = ver_1 and not dry_run
        and requested_by = owner_a and org_id = org_a
       from portal_read_starts where id = run_live),
    'the start names its connection, version, kind and member');

  again := app.record_portal_read_start(run_live, org_a, conn_a, ver_1, false, owner_a);
  select count(*) into n from portal_read_starts where id = run_live;
  perform test.ok(again = run_live and n = 1, 'a replay of the same start writes nothing and answers its id');
  perform test.expect_error(format(start_fn, run_live, org_a, conn_a, ver_1, true, owner_a),
    'already recorded with other arguments', 'a replay that differs is refused');
  perform test.expect_error(format(start_fn, run_live, org_a, conn_a, ver_2, false, owner_a),
    'already recorded with other arguments', 'whichever argument differs');

  perform test.as_member(org_b, owner_b);
  perform test.expect_error(format(start_fn, run_live, org_b, conn_b, null, false, owner_b),
    'already recorded with other arguments', 'a run id names one start, across every org');
  run_b := gen_random_uuid();
  perform app.record_portal_read_start(run_b, org_b, conn_b, null, false, owner_b);

  -- =========================================================================
  -- G. A run's outcome: once, complete, as the member its start names
  -- =========================================================================
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format('insert into portal_read_runs (org_id, run_id, outcome) values (%L, %L, ''completed'')',
           org_a, run_live),
    'permission denied', 'app_rw may not insert an outcome: the function is the only door');

  perform test.as_nobody();
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'completed', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'never as nobody', 'a caller with no claims records no outcome');
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format(run_fn, run_b, org_b, 'completed', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'not the tenant', 'it writes only in the caller''s own org');
  perform test.expect_error(
    format(run_fn, gen_random_uuid(), org_a, 'completed', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'has no start row', 'an outcome needs its start');
  perform test.expect_error(
    format(run_fn, run_b, org_a, 'completed', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'belongs to another org', 'of this org');
  perform test.as_member(org_a, owner_a2);
  perform test.expect_error(
    format(run_fn, run_live, org_a, 'completed', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'acted as', 'and is recorded as the member the run acted as');
  perform test.as_member(org_a, owner_a);

  -- What an outcome may say (contracts.ts PortalRunEnd), each refused by name.
  perform test.expect_error(format(run_fn, run_nc, org_a, 'succeeded', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_outcome_check', 'an outcome is one of five');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'completed', 'challenge', null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_reason_fits_outcome', 'a completed run carries no reason');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'completed', null, 'SomeError', null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_fits_outcome', 'nor an error class');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'needs_attention', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_reason_fits_outcome', 'a run that needs a person says why');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'needs_attention', 'guard_refused', null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_reason_fits_outcome', 'with a needs-attention reason');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'needs_attention', 'charge_back', null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_reason_fits_outcome', 'from the closed list');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'needs_attention', 'challenge', 'SomeError', null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_fits_outcome', 'and no error class: its reason says it all');
  perform test.expect_error(format(run_fn, run_nc, org_a, 'failed', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_reason_fits_outcome', 'a failed run says how');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'mfa_unanswerable', null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_reason_fits_outcome', 'with a failed reason');
  perform test.expect_error(format(run_fn, run_nc, org_a, 'failed', 'error', null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_fits_outcome', 'an error is named by its class');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'guard_refused', 'SomeError', null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_fits_outcome', 'and a runner''s stop by its reason alone');
  perform test.expect_error(format(run_fn, run_nc, org_a, 'refused', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_fits_outcome', 'a refused run names the refusal it met');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'not_configured', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_fits_outcome', 'and a run not configured what it lacked');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'refused', 'challenge', 'Refused', null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_reason_fits_outcome', 'by class, not by reason');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'error', 'Some error', null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_check', 'an error class is a class name, never a message');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'error', 'Error: page said x', null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_check', 'which could quote a page');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'error', repeat('E', 101), null, 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_error_class_check', 'and is at most 100 characters');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'guard_refused', null, '', 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_at_step_check', 'the step a run stopped at is named, or null');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'guard_refused', null, E'open\nnext', 0, 0, 0, 0, 0, '[]'),
    'portal_read_runs_at_step_check', 'with no control characters');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'guard_refused', null, 'open', -1, 0, 0, 0, 0, '[]'),
    'portal_read_runs_page_count_check', 'counts are not negative');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'guard_refused', null, 'open', 0, 0, 0, 0, -1, '[]'),
    'portal_read_runs_refusal_count_check', 'any of them');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'failed', 'guard_refused', null, 'open', null, 0, 0, 0, 0, '[]'),
    'not-null', 'and every count is given');
  foreach def in array array[
    '{}',
    '["open"]',
    '[{"step": "open"}]',
    '[{"step": "open", "passed": "yes"}]',
    '[{"step": "open", "passed": true, "detail": "Welcome, Jane"}]',
    '[{"step": "", "passed": true}]',
    '[{"step": "open", "passed": true}, {"step": "open", "passed": false}]'] loop
    perform test.expect_error(
      format(run_fn, run_nc, org_a, 'failed', 'guard_refused', null, 'open', 0, 0, 0, 0, 0, def),
      'portal_read_runs_step_log_check',
      format('a step log is names and pass or fail only, so %s is refused', def));
  end loop;
  perform test.expect_error(
    format(run_fn, run_dry, org_a, 'completed', null, null, null, 3, 1, 1, 0, 0, valid_step_log),
    'a dry run captures nothing', 'a dry run records no capture');

  -- Every outcome, and every reason each takes, is recordable.
  foreach why in array array['mfa_unanswerable', 'challenge', 'page_changed', 'terms_prompt',
                                'credential_rejected', 'session_expired', 'account_mismatch',
                                'binding_mismatch', 'capture_refused'] loop
    run_x := gen_random_uuid();
    perform app.record_portal_read_start(run_x, org_a, conn_a, ver_3, true, owner_a);
    got := app.record_portal_read_run(run_x, org_a, 'needs_attention', why, null, 'sign_in',
                                      1, 0, 0, 0, 0, valid_step_log);
    perform test.ok(got is not null, format('needs_attention records %s', why));
  end loop;
  foreach why in array array['guard_refused', 'never_click', 'file_input', 'cap_exceeded',
                                'sign_in_form_refused'] loop
    run_x := gen_random_uuid();
    perform app.record_portal_read_start(run_x, org_a, conn_a, ver_3, true, owner_a);
    got := app.record_portal_read_run(run_x, org_a, 'failed', why, null, 'open',
                                      1, 0, 0, 0, 2, valid_step_log);
    perform test.ok(got is not null, format('failed records %s', why));
  end loop;
  run_x := gen_random_uuid();
  perform app.record_portal_read_start(run_x, org_a, conn_a, ver_3, true, owner_a);
  perform test.ok(
    app.record_portal_read_run(run_x, org_a, 'failed', 'error', 'TimeoutError', null,
                               0, 0, 0, 0, 0, '[]') is not null,
    'failed records an error by its class name');
  run_x := gen_random_uuid();
  perform app.record_portal_read_start(run_x, org_a, conn_a, ver_3, true, owner_a);
  perform test.ok(
    app.record_portal_read_run(run_x, org_a, 'refused', null, 'PortalTermsNotAllowed', null,
                               0, 0, 0, 0, 0, '[]') is not null,
    'refused records the refusal it met');
  perform test.ok(
    app.record_portal_read_run(run_dry, org_a, 'completed', null, null, null,
                               3, 0, 0, 0, 0, valid_step_log) is not null,
    'completed records a dry run''s step log');

  got := app.record_portal_read_run(run_nc, org_a, 'not_configured', null, 'RecipeVersionMissing', null,
                                    0, 0, 0, 0, 0, '[]');
  again := app.record_portal_read_run(run_nc, org_a, 'not_configured', null, 'RecipeVersionMissing', null,
                                      0, 0, 0, 0, 0, '[]');
  select count(*) into n from portal_read_runs where run_id = run_nc;
  perform test.ok(got is not null and again = got and n = 1,
    'a replay of the same outcome writes nothing and answers its id');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'not_configured', null, 'PortalWorkerMissing', null, 0, 0, 0, 0, 0, '[]'),
    'already has an outcome', 'a replay that differs is refused');
  perform test.expect_error(
    format(run_fn, run_nc, org_a, 'completed', null, null, null, 0, 0, 0, 0, 0, '[]'),
    'already has an outcome', 'and a run ends once');

  -- =========================================================================
  -- H. What a run captured: the trail from a stored page to its run
  -- =========================================================================
  insert into uploads (org_id, source) values (org_a, 'portal_fetch') returning id into upl;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org_a, upl, digest('portal-landing', 'sha256'), 512, 'text/html', 'portal/landing')
    returning id into doc_1;

  insert into portal_captures (org_id, run_id, recipe_version_id, document_id, kind, step_name,
                               page_path, snapshot_rule_version, sha256, captured_at)
    values (org_a, run_live, ver_1, doc_1, 'page_snapshot', 'capture_landing', '/dashboard/main',
            1, sha_1, now());
  perform test.ok(true, 'a stored snapshot names its document, run, version, step, path and rule');
  insert into portal_captures (org_id, run_id, recipe_version_id, document_id, kind, step_name,
                               page_path, snapshot_rule_version, sha256, captured_at)
    values (org_a, run_live, ver_1, doc_1, 'page_snapshot', 'capture_again', '/dashboard/main',
            1, sha_1, now());
  perform test.ok(true, 'bytes the tenant already held are captured again against the same document');
  insert into portal_captures (org_id, run_id, recipe_version_id, refusal, kind, step_name,
                               page_path, sha256, captured_at)
    values (org_a, run_live, ver_1, 'type_not_allowed', 'download', 'download_export',
            '/export/deductions', sha_2, now());
  perform test.ok(true, 'a refused download is recorded by the door''s code, with no document');

  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, 'type_not_allowed', 'download', 'x', '/x', null,
           sha_1, now()),
    'portal_captures_stored_or_refused', 'a capture is stored or refused, not both');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, null, null, 'download', 'x', '/x', null, sha_1, now()),
    'portal_captures_stored_or_refused', 'nor neither');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, null, 'looked_odd', 'download', 'x', '/x', null, sha_1, now()),
    'portal_captures_refusal_check', 'a refusal is one of the door''s codes');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'screenshot', 'x', '/x', null, sha_1, now()),
    'portal_captures_kind_check', 'a capture is a snapshot or a download: never a screenshot');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'page_snapshot', 'x', '/x', null, sha_1, now()),
    'portal_captures_snapshot_names_its_rule', 'a snapshot names its serialiser''s rule version');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'download', 'x', '/x', 1, sha_1, now()),
    'portal_captures_snapshot_names_its_rule', 'and a download has none');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'page_snapshot', 'x', '/x', 0, sha_1, now()),
    'portal_captures_snapshot_rule_version_check', 'a rule version starts at 1');
  foreach def in array array['/deductions?from=2026-01-01', '/deductions#list', '/deductions;jsessionid=abc',
                             '/(S(abc123))/deductions', '/app/(F(ticket))/list', 'deductions', '',
                             E'/deduc\ttions'] loop
    perform test.expect_error(
      format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'page_snapshot', 'x', def, 1, sha_1, now()),
      'portal_captures_page_path_check',
      format('a page path is a path and only a path, so %s is refused', def));
  end loop;
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'page_snapshot', '', '/x', 1, sha_1, now()),
    'portal_captures_step_name_check', 'a capture names its step');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, null, 'too_large', 'download', 'x', '/x', null,
           upper(sha_2), now()),
    'portal_captures_sha256_check', 'its hash is lower-case hex');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'page_snapshot', 'x', '/x', 1, sha_2, now()),
    'its bytes are not document', 'a stored capture carries its document''s own hash');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_2, doc_1, null, 'page_snapshot', 'x', '/x', 1, sha_1, now()),
    'did not run version', 'and names the version its run ran');
  perform test.expect_error(
    format(ins_cap, org_a, run_dry, ver_3, doc_1, null, 'page_snapshot', 'x', '/x', 1, sha_1, now()),
    'dry run captures nothing', 'a dry run captures nothing');
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_b, null, 'page_snapshot', 'x', '/x', 1,
           encode(digest('portal-b', 'sha256'), 'hex'), now()),
    'portal_captures_document_same_org', 'a capture names this workspace''s document');
  -- As the table owner, past RLS: since migration 0039 the insert policy
  -- refuses another workspace's run for app_rw first (suite 35), and this
  -- asks the composite tie itself, which answers for every role.
  reset role;
  perform test.expect_error(
    format(ins_cap, org_a, run_b, ver_1, null, 'too_large', 'download', 'x', '/x', null, sha_2, now()),
    'portal_captures_start_same_org', 'and this workspace''s run');
  set role app_rw;
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'page_snapshot', 'x', '/x', 1, sha_1, null),
    'not-null', 'and when it was captured');
  perform test.as_member(org_a, reader_a);
  perform test.expect_error(
    format(ins_cap, org_a, run_live, ver_1, doc_1, null, 'page_snapshot', 'x', '/x', 1, sha_1, now()),
    'row-level security', 'a read_only member records no capture');
  perform test.as_member(org_a, owner_a);

  got := app.record_portal_read_run(run_live, org_a, 'completed', null, null, null,
                                    4, 3, 1, 1, 0, valid_step_log);
  perform test.ok(
    (select outcome = 'completed' and page_count = 4 and capture_count = 3 and new_document_count = 1
        and deduplicated_count = 1 and step_log = valid_step_log
       from portal_read_runs where id = got),
    'the run ends complete, with its counts and its step log');
  select count(*) into n from portal_captures where run_id = run_live;
  perform test.ok(n = 3, format('and every capture names its start (saw %s)', n));

  -- =========================================================================
  -- I. The fan-out: every enabled connection, ids only, for no one in particular
  -- =========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', owner_a::text)::text, true);
  perform test.expect_error('select count(*) from app.portal_connections_to_read()',
    'untenanted', 'the fan-out list is refused to a subject with no org');
  perform set_config('request.jwt.claims', json_build_object('org_id', org_a::text)::text, true);
  perform test.expect_error('select count(*) from app.portal_connections_to_read()',
    'untenanted', 'and to an org with no subject');
  perform test.as_member(org_a, owner_a);
  perform test.expect_error('select count(*) from app.portal_connections_to_read()',
    'untenanted', 'and to a member acting for a tenant');

  perform test.as_nobody();
  select count(*) into n from app.portal_connections_to_read() l where l.org_id in (org_a, org_b);
  perform test.ok(n = 3, format('with no claims it lists both orgs'' enabled connections (saw %s)', n));
  perform test.ok(
    not exists (select 1 from app.portal_connections_to_read() l
                 where l.connection_id in (conn_a2, conn_params)),
    'and not a disabled one');
  perform test.ok(
    exists (select 1 from app.portal_connections_to_read() l
             where l.connection_id = conn_a and l.org_id = org_a
               and l.portal_key = 'sap_business_network' and l.created_by = owner_a),
    'each with its org, its portal and the member it acts as');
  perform set_config('request.jwt.claims', '', true);
  select count(*) into n from app.portal_connections_to_read() l where l.org_id in (org_a, org_b);
  perform test.ok(n = 3, format('and so with a cleared claim (saw %s)', n));

  -- =========================================================================
  -- J. A tenant's rows are the tenant's
  -- =========================================================================
  perform test.as_member(org_b, owner_b);
  foreach t in array seven loop
    execute format('select count(*) from %I where org_id = %L', t, org_a) into n;
    perform test.ok(n = 0, format('org B sees none of org A''s %s (saw %s)', t, n));
  end loop;
  perform test.as_nobody();
  foreach t in array seven loop
    execute format('select count(*) from %I', t) into n;
    perform test.ok(n = 0, format('a caller with no claims sees no %s (saw %s)', t, n));
  end loop;
  perform test.as_member(org_a, reader_a);
  foreach t in array seven loop
    execute format('select count(*) from %I', t) into n;
    perform test.ok(n > 0, format('a read_only member reads its own %s (saw %s)', t, n));
  end loop;
  reset role;
  set role app_ro;
  perform test.as_member(org_a, reader_a);
  foreach t in array seven loop
    execute format('select count(*) from %I', t) into n;
    perform test.ok(n > 0, format('and app_ro reads %s (saw %s)', t, n));
  end loop;
  reset role;

  -- =========================================================================
  -- K. Append-only: the grants answer for app_rw, the triggers for the owner
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_a, owner_a);
  foreach t in array six loop
    perform test.expect_error(format('update %I set org_id = org_id', t), 'permission denied',
      format('app_rw cannot UPDATE %s', t));
    perform test.expect_error(format('delete from %I', t), 'permission denied',
      format('app_rw cannot DELETE from %s', t));
    perform test.expect_error(format('truncate %I', t), 'permission denied',
      format('app_rw cannot TRUNCATE %s', t));
  end loop;
  reset role;
  foreach t in array six loop
    perform test.expect_error(format('update %I set org_id = org_id where org_id = %L', t, org_a),
      'append-only', format('even the table owner cannot UPDATE %s', t));
    perform test.expect_error(format('delete from %I where org_id = %L', t, org_a),
      'append-only', format('even the table owner cannot DELETE from %s', t));
    perform test.expect_error(format('truncate %I cascade', t),
      'append-only', format('even the table owner cannot TRUNCATE %s', t));
  end loop;

  -- =========================================================================
  -- L. The refusal records itself: why the two run functions are definer
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_a, owner_a3);
  insert into portal_connections (org_id, portal_key, label, account_id, created_by)
    values (org_a, 'coupa_supplier_portal', 'Coupa (A3)', 'CSP-' || digits, owner_a3)
    returning id into conn_a3;
  reset role;
  update memberships set role = 'read_only' where org_id = org_a and user_id = owner_a3;
  set role app_rw;
  perform test.as_member(org_a, owner_a3);
  perform test.ok(not app.member_may_write(), 'the member a connection acts as may no longer write');
  run_a3 := gen_random_uuid();
  got := app.record_portal_read_start(run_a3, org_a, conn_a3, null, false, owner_a3);
  perform test.ok(got = run_a3,
    'and a run of it still records its start: the functions escape member_may_write and nothing else');
  got := app.record_portal_read_run(run_a3, org_a, 'refused', null, 'PortalMemberMayNotWrite', null,
                                    0, 0, 0, 0, 0, '[]');
  perform test.ok(
    (select outcome = 'refused' and error_class = 'PortalMemberMayNotWrite'
       from portal_read_runs where id = got),
    'and the refusal it met');
  update portal_connections set enabled = false where id = conn_a3;
  get diagnostics n = row_count;
  perform test.ok(n = 0, 'but it writes nothing else: its update of the connection touches no row');
  reset role;
end
$test$;
rollback;
