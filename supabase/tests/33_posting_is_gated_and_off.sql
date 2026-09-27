\echo '-- 33 posting to QuickBooks is gated and off (ADR 0060 §4, migration 0037)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; ded_a uuid; dec_a uuid;
  b jsonb; org_b uuid;
  owner_a uuid; conn_a uuid; map_a uuid; wb uuid;
  fams jsonb := '{"shortage":"80","pricing":"80","compliance":"81","duplicate":"80",
                  "returns":"82","promotion":"83","freight":"84","quality":"85",
                  "post_audit":"86","other":"87"}';
  n int;
  fn record;
  r text;
begin
  a := test.seed_org('posta');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  approver_a := (a->>'approver')::uuid; ded_a := (a->>'deduction')::uuid;
  dec_a := (a->>'decision')::uuid;
  b := test.seed_org('postb');
  org_b := (b->>'org')::uuid;

  insert into users (email, full_name) values ('posta-owner@example.test', 'Owner A')
    returning id into owner_a;
  insert into memberships (org_id, user_id, role) values (org_a, owner_a, 'owner');

  -- =========================================================================
  -- The catalogue
  -- =========================================================================
  for fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'app'
       and p.proname in ('map_names_its_author', 'writeback_outcome_is_final',
                         'posting_switch_is_guarded', 'guard_immutable_core')
  loop
    perform test.ok(
      coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false),
      format('app.%s pins search_path', fn.proname));
    perform test.ok(not fn.prosecdef, format('app.%s is not security definer', fn.proname));
  end loop;

  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform test.ok(
      not has_table_privilege(r, 'ledger_account_maps', 'select, insert, update, delete, truncate, references, trigger'),
      format('%s holds nothing on ledger_account_maps', r));
  end loop;
  perform test.ok(not has_table_privilege('app_rw', 'ledger_account_maps', 'update')
              and not has_table_privilege('app_rw', 'ledger_account_maps', 'delete')
              and not has_table_privilege('app_ro', 'ledger_account_maps', 'insert'),
    'app_rw holds no UPDATE or DELETE on ledger_account_maps, app_ro no INSERT');

  -- =========================================================================
  -- The switch is off, and a map is an owner's
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_a, owner_a);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_a, 'qbo', 'realm-posta', owner_a) returning id into conn_a;
  perform test.ok((select posting_enabled from accounting_connections where id = conn_a) = false,
    'posting_enabled defaults to false');

  perform test.expect_error(format(
    'update accounting_connections set posting_enabled = true where id = %L', conn_a),
    'needs an account map', 'posting cannot be turned on without a map');

  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(format(
    'insert into ledger_account_maps (org_id, connection_id, ar_account_id,
       deductions_receivable_account_id, writeoff_by_family, unclassified_writeoff, created_by)
     values (%L, %L, ''1'', ''2'', %L, ''88'', %L)', org_a, conn_a, fams, analyst_a),
    'policy', 'a non-owner cannot insert a map');

  perform test.as_member(org_a, owner_a);
  perform test.expect_error(format(
    'insert into ledger_account_maps (org_id, connection_id, ar_account_id,
       deductions_receivable_account_id, writeoff_by_family, unclassified_writeoff, created_by)
     values (%L, %L, ''1'', ''2'', %L, ''88'', %L)', org_a, conn_a,
     fams - 'post_audit', owner_a),
    'ledger_account_maps_families', 'a map missing a reason family is refused');
  perform test.expect_error(format(
    'insert into ledger_account_maps (org_id, connection_id, ar_account_id,
       deductions_receivable_account_id, writeoff_by_family, unclassified_writeoff, created_by)
     values (%L, %L, ''1'', ''2'', %L, ''88'', %L)', org_a, conn_a,
     fams || '{"slotting":"89"}'::jsonb, owner_a),
    'ledger_account_maps_families', 'a map naming a family that does not exist is refused');
  perform test.expect_error(format(
    'insert into ledger_account_maps (org_id, connection_id, ar_account_id,
       deductions_receivable_account_id, writeoff_by_family, unclassified_writeoff, created_by)
     values (%L, %L, ''1'', ''2'', %L, ''88'', %L)', org_b, conn_a, fams, owner_a),
    'policy', 'an owner cannot insert a map for another org');

  insert into ledger_account_maps (org_id, connection_id, ar_account_id,
    deductions_receivable_account_id, writeoff_by_family, unclassified_writeoff, created_by)
    values (org_a, conn_a, '1', '2', fams, '88', owner_a) returning id into map_a;
  perform test.ok(map_a is not null, 'an owner may insert a map for their connection');

  perform test.expect_error(format(
    'update ledger_account_maps set ar_account_id = ''9'' where id = %L', map_a),
    'permission denied', 'app_rw cannot update a map');
  perform test.expect_error(format('delete from ledger_account_maps where id = %L', map_a),
    'permission denied', 'app_rw cannot delete a map');

  -- A non-owner's update is filtered by RLS; the switch stays off.
  perform test.as_member(org_a, analyst_a);
  update accounting_connections set posting_enabled = true where id = conn_a;
  perform test.as_member(org_a, owner_a);
  perform test.ok((select posting_enabled from accounting_connections where id = conn_a) = false,
    'a non-owner cannot turn posting on');

  update accounting_connections set posting_enabled = true where id = conn_a;
  perform test.ok((select posting_enabled from accounting_connections where id = conn_a),
    'an owner may turn posting on once a map exists');

  -- =========================================================================
  -- The owner of the table: the triggers answer where grants and RLS do not
  -- =========================================================================
  reset role;
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(format(
    'update accounting_connections set posting_enabled = false where id = %L', conn_a),
    'only an owner', 'the trigger refuses a non-owner even past RLS');
  perform test.expect_error(format(
    'update ledger_account_maps set ar_account_id = ''9'' where id = %L', map_a),
    'append-only', 'a map refuses UPDATE even for the table owner');
  perform test.expect_error(format('delete from ledger_account_maps where id = %L', map_a),
    'append-only', 'a map refuses DELETE even for the table owner');
  perform test.expect_error(format(
    'insert into ledger_account_maps (org_id, connection_id, ar_account_id,
       deductions_receivable_account_id, writeoff_by_family, unclassified_writeoff, created_by)
     values (%L, %L, ''1'', ''2'', %L, ''88'', %L)', org_a, conn_a, fams, owner_a),
    'must be the caller', 'a map names its author');
  set role app_rw;

  -- =========================================================================
  -- writebacks: the gate is intact, and an outcome is final
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(format(
    'insert into writebacks (org_id, deduction_id, decision_id, method, connection_id,
       account_map_id, amount_cents, lines)
     values (%L, %L, %L, ''journal_entry'', %L, %L, 312000, ''[]'')',
     org_a, ded_a, dec_a, conn_a, map_a),
    'no writeback approval row', 'a writeback with no approval still raises');

  perform test.as_member(org_a, approver_a);
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org_a, dec_a, approver_a, 'writeback');
  perform test.as_member(org_a, analyst_a);
  insert into writebacks (org_id, deduction_id, decision_id, method, connection_id,
                          account_map_id, amount_cents, lines, request_id)
    values (org_a, ded_a, dec_a, 'journal_entry', conn_a, map_a, 312000,
            '[{"account":"2","side":"debit","cents":312000}]', 'req-posta-1')
    returning id into wb;
  perform test.ok(wb is not null, 'an approved journal_entry writeback is accepted');

  perform test.expect_error(format(
    'insert into writebacks (org_id, deduction_id, decision_id, method)
     values (%L, %L, %L, ''journal_entry'')', org_a, ded_a, dec_a),
    'duplicate key', 'one writeback per decision and method');

  perform test.expect_error(format(
    'update writebacks set amount_cents = 1 where id = %L', wb),
    'immutable', 'amount_cents is immutable');
  perform test.expect_error(format(
    'update writebacks set lines = ''[]'' where id = %L', wb),
    'immutable', 'lines are immutable');

  update writebacks set status = 'succeeded', qbo_txn_id = 'JE-1' where id = wb;
  perform test.expect_error(format(
    'update writebacks set status = ''failed'' where id = %L', wb),
    'final', 'succeeded cannot go back');
  perform test.expect_error(format(
    'update writebacks set qbo_txn_id = ''JE-2'' where id = %L', wb),
    'written once', 'qbo_txn_id cannot change');

  -- =========================================================================
  -- decisions admit schema 'S'
  -- =========================================================================
  reset role;
  perform test.ok(pg_get_constraintdef((select oid from pg_constraint
      where conname = 'decisions_schema_id_check')) like '%''S''%',
    'decisions.schema_id admits S');

  select count(*) into n from ledger_account_maps where org_id in (org_a, org_b);
  perform test.ok(n = 1, 'exactly the one map this suite wrote');
end
$test$;
rollback;
