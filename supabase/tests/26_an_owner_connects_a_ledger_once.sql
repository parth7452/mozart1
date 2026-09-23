\echo '-- 26 an owner connects a ledger, once: one enabled connection per company, owners only, identities frozen'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid;
  b jsonb; org_b uuid; analyst_b uuid;
  owner_a uuid; owner_a2 uuid; owner_b uuid;
  row_1 uuid; row_2 uuid; row_b uuid;
  n int; fn record; idx record; cred uuid;
begin
  a := test.seed_org('ownconna');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  approver_a := (a->>'approver')::uuid;
  b := test.seed_org('ownconnb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  -- The seed makes an analyst and an approver. Owners are added here, as the
  -- table owner, because who is an owner is now an owner's decision and there
  -- is no owner yet to make it.
  insert into users (email, full_name) values ('ownconn-owner-a@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('ownconn-owner-a2@example.test', 'Owner A2')
    returning id into owner_a2;
  insert into users (email, full_name) values ('ownconn-owner-b@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role)
    values (org_a, owner_a, 'owner'), (org_a, owner_a2, 'owner'), (org_b, owner_b, 'owner');

  -- =========================================================================
  -- The catalogue: which rows may exist
  -- =========================================================================
  perform test.ok(
    not exists (
      select 1 from pg_constraint c
       where c.conrelid = 'accounting_connections'::regclass and c.contype = 'u'
         and (select array_agg(att.attname::text order by att.attname::text)
                from unnest(c.conkey) as k(attnum)
                join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k.attnum)
             = array['org_id', 'provider', 'provider_account_id']),
    'the per-org unique that made a move impossible is gone (ADR 0039 §6)');

  select i.indisunique, i.indpred is not null as partial,
         pg_get_indexdef(i.indexrelid) as def
    into idx
    from pg_index i
   where i.indexrelid = 'accounting_connections_one_enabled_per_account'::regclass;
  perform test.ok(idx.indisunique and idx.partial,
    'one enabled connection per company is a partial unique index, by that name');
  perform test.ok(
    position('(provider, provider_account_id)' in idx.def) > 0
      and position('WHERE enabled' in idx.def) > 0,
    format('over (provider, provider_account_id) where enabled — across every org (%s)', idx.def));

  perform test.ok(
    exists (select 1 from pg_constraint
             where conrelid = 'accounting_connections'::regclass
               and conname = 'accounting_connections_one_per_member'),
    'one row per member per company per org');
  perform test.ok(
    exists (select 1 from pg_constraint
             where conrelid = 'accounting_connections'::regclass
               and conname = 'accounting_connections_org_id_id_key'),
    'and the (org_id, id) unique the credential table keys on is untouched');

  select p.prosecdef, p.proconfig into fn
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'app' and p.proname = 'member_is_owner';
  perform test.ok(not fn.prosecdef,
    'app.member_is_owner() is not security definer: it reads the caller''s own membership under RLS');
  perform test.ok(fn.proconfig is not null
      and exists (select 1 from unnest(fn.proconfig) c where c like 'search_path=%'),
    'and its search_path is pinned, because it decides a write');
  perform test.ok(has_function_privilege('app_rw', 'app.member_is_owner()', 'execute')
      and has_function_privilege('app_ro', 'app.member_is_owner()', 'execute'),
    'app_rw and app_ro may ask it');
  -- Asked of the privilege, not of the ACL: an ACL that is still null is the
  -- default, and the default gives PUBLIC execute.
  perform test.ok(not has_function_privilege('public', 'app.member_is_owner()', 'execute'),
    'and PUBLIC holds nothing on it');

  select p.proconfig into fn
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'app' and p.proname = 'touch_accounting_connection';
  perform test.ok(fn.proconfig is not null,
    'the connection trigger function kept its pinned search_path through create or replace');

  set role app_rw;

  -- =========================================================================
  -- Only an owner connects, and only as themselves
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  perform test.ok(not app.member_is_owner(), 'an analyst is not an owner');
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''own-realm-x'', %L)', org_a, analyst_a),
    'policy', 'an analyst may not connect a ledger');

  perform test.as_member(org_a, approver_a);
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''own-realm-x'', %L)', org_a, approver_a),
    'policy', 'nor may an approver');

  perform test.as_member(org_a, owner_a);
  perform test.ok(app.member_is_owner(), 'an owner is one');
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''own-realm-x'', %L)', org_a, analyst_a),
    'policy', 'an owner may not connect one in somebody else''s name: created_by is the caller');

  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_a, 'qbo', 'own-realm-x', owner_a) returning id into row_1;
  perform test.ok(row_1 is not null, 'an owner connects a ledger as themselves');

  -- =========================================================================
  -- Nobody but an owner changes one, and nobody changes who it acts as
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  update accounting_connections set enabled = false where id = row_1;
  get diagnostics n = row_count;
  perform test.ok(n = 0, 'an analyst''s update of a connection touches no row');

  perform test.as_member(org_a, owner_a);
  perform test.ok((select enabled from accounting_connections where id = row_1),
    'so it is still enabled');
  perform test.expect_error(
    format('update accounting_connections set created_by = %L where id = %L', owner_a2, row_1),
    'immutable', 'the member a connection acts as cannot be edited — a move is a new row');

  -- =========================================================================
  -- One enabled connection per company, across the whole deployment
  -- =========================================================================
  perform test.as_member(org_b, owner_b);
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''own-realm-x'', %L)', org_b, owner_b),
    'accounting_connections_one_enabled_per_account',
    'another workspace cannot connect a company one workspace already holds');

  perform test.as_member(org_a, owner_a2);
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''own-realm-x'', %L)', org_a, owner_a2),
    'accounting_connections_one_enabled_per_account',
    'and nor can a second owner in the same workspace while the first is enabled');

  -- The move, as the claim does it: the old one off, then the new one on.
  insert into accounting_connections (org_id, provider, provider_account_id, created_by, enabled)
    values (org_a, 'qbo', 'own-realm-x', owner_a2, false) returning id into row_2;
  update accounting_connections set enabled = false where id = row_1;
  update accounting_connections set enabled = true where id = row_2;
  perform test.ok(
    (select count(*) from accounting_connections
      where provider_account_id = 'own-realm-x' and enabled) = 1
      and (select enabled from accounting_connections where id = row_2),
    'a connection moves to another owner as a new row, once the first is off (ADR 0031 §3)');

  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by, enabled)
              values (%L, ''qbo'', ''own-realm-x'', %L, false)', org_a, owner_a2),
    'accounting_connections_one_per_member',
    'one row per member per company: a reconnect reuses it');

  -- Released by its holder, it may be connected elsewhere.
  update accounting_connections set enabled = false where id = row_2;
  perform test.as_member(org_b, owner_b);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_b, 'qbo', 'own-realm-x', owner_b) returning id into row_b;
  perform test.ok(row_b is not null,
    'once workspace A disconnects, workspace B may connect the same company');

  perform test.as_nobody();
  select count(*) into n from app.ledger_connections_to_sync() where connection_id in (row_1, row_2, row_b);
  perform test.ok(n = 1, format('and the fan-out lists that company once (saw %s)', n));

  -- =========================================================================
  -- Still no DELETE, and still no credential column
  -- =========================================================================
  perform test.ok(not has_table_privilege('app_rw', 'accounting_connections', 'DELETE'),
    'app_rw still holds no DELETE on accounting_connections');
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'accounting_connections'
     and (column_name ilike '%token%' or column_name ilike '%secret%'
          or column_name ilike '%credential%' or column_name ilike '%refresh%'
          or column_name ilike '%password%');
  perform test.ok(n = 0, format('accounting_connections carries no credential column (%s found)', n));

  -- =========================================================================
  -- A credential row names who stored it; any writer may store a rotation
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  insert into accounting_credentials
    (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext, refresh_expires_at, created_by)
    values (org_a, row_1, 'c', 'k', 'dw==', 'cw==', now() + interval '100 days', analyst_a)
    returning id into cred;
  perform test.ok(cred is not null,
    'an analyst may store a rotation as themselves — the sync acts as a member who may have been demoted');
  perform test.expect_error(
    format('insert into accounting_credentials
              (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext, refresh_expires_at, created_by)
            values (%L, %L, ''c'', ''k'', ''dw=='', ''cw=='', now() + interval ''1 day'', %L)',
           org_a, row_1, owner_a),
    'policy', 'but not in somebody else''s name');

  -- =========================================================================
  -- An audit row names who acted
  -- =========================================================================
  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org_a, analyst_a, 'test.acted', 'accounting_connections', row_1::text, '{}'::jsonb);
  perform test.ok(true, 'a writer may record their own act');
  perform test.expect_error(
    format('insert into audit_log (org_id, actor_id, action, subject_table) values (%L, %L, ''test.forged'', ''x'')',
           org_a, owner_a),
    'policy', 'but not attribute one to somebody else');
  perform test.expect_error(
    format('insert into audit_log (org_id, actor_id, action, subject_table) values (%L, null, ''test.nobody'', ''x'')',
           org_a),
    'policy', 'nor to nobody');

  -- =========================================================================
  -- Who is an owner is an owner's decision
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  update memberships set role = 'owner' where org_id = org_a and user_id = analyst_a;
  get diagnostics n = row_count;
  perform test.ok(n = 0, 'an analyst cannot promote themselves: the update touches no row');
  perform test.ok(
    (select role = 'analyst' from memberships where org_id = org_a and user_id = analyst_a),
    'and is still an analyst');
  perform test.expect_error(
    format('insert into memberships (org_id, user_id, role) values (%L, %L, ''owner'')', org_a, analyst_b),
    'policy', 'nor add a member');

  perform test.as_member(org_a, owner_a);
  update memberships set role = 'approver' where org_id = org_a and user_id = analyst_a;
  get diagnostics n = row_count;
  perform test.ok(n = 1, 'an owner can change a member''s role');
  update memberships set role = 'analyst' where org_id = org_a and user_id = analyst_a;

  reset role;
end
$test$;
rollback;
