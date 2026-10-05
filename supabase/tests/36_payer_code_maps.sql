\echo '-- 36 a payer''s reason code maps to ours as data (ADR 0067)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; debtor_a uuid;
  b jsonb; org_b uuid; approver_b uuid; debtor_b uuid;
  m1 uuid; got text; n int; r text;
begin
  a := test.seed_org('pcma');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  approver_a := (a->>'approver')::uuid; debtor_a := (a->>'debtor')::uuid;
  b := test.seed_org('pcmb');
  org_b := (b->>'org')::uuid; approver_b := (b->>'approver')::uuid;
  debtor_b := (b->>'debtor')::uuid;

  -- The end state, read back from the catalogue.
  perform test.ok((select relrowsecurity from pg_class where oid = 'payer_code_maps'::regclass),
    'RLS is on');
  perform test.ok(
    (select count(*) from pg_trigger where tgrelid = 'payer_code_maps'::regclass
        and tgname in ('no_update_delete', 'no_truncate', 'payer_code_map_names_its_recorder')) = 3,
    'no_update_delete, no_truncate and the authorship trigger are present');
  perform test.ok(
    has_table_privilege('app_rw', 'payer_code_maps', 'SELECT')
    and has_table_privilege('app_rw', 'payer_code_maps', 'INSERT')
    and not has_table_privilege('app_rw', 'payer_code_maps', 'UPDATE')
    and not has_table_privilege('app_rw', 'payer_code_maps', 'DELETE')
    and not has_table_privilege('app_rw', 'payer_code_maps', 'TRUNCATE'),
    'app_rw holds SELECT and INSERT only');
  perform test.ok(
    has_table_privilege('app_ro', 'payer_code_maps', 'SELECT')
    and not has_table_privilege('app_ro', 'payer_code_maps', 'INSERT')
    and not has_table_privilege('app_ro', 'payer_code_maps', 'UPDATE')
    and not has_table_privilege('app_ro', 'payer_code_maps', 'DELETE'),
    'app_ro holds SELECT only');
  perform test.ok(
    has_table_privilege('app_rw', 'payer_code_maps_current', 'SELECT')
    and has_table_privilege('app_ro', 'payer_code_maps_current', 'SELECT')
    and not has_table_privilege('app_rw', 'payer_code_maps_current', 'INSERT'),
    'the view is readable by the app roles and writable by neither');
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      perform test.ok(
        not has_table_privilege(r, 'payer_code_maps', 'SELECT')
        and not has_table_privilege(r, 'payer_code_maps', 'INSERT')
        and not has_table_privilege(r, 'payer_code_maps', 'UPDATE')
        and not has_table_privilege(r, 'payer_code_maps', 'DELETE')
        and not has_table_privilege(r, 'payer_code_maps_current', 'SELECT')
        and not has_function_privilege(r, 'app.payer_code_maps_as_of(date)', 'EXECUTE')
        and not has_function_privilege(r, 'app.member_is_owner_or_approver()', 'EXECUTE'),
        format('request role %s holds nothing', r));
    end if;
  end loop;
  perform test.ok(
    (select c.reloptions @> array['security_invoker=true'] from pg_class c
      where c.oid = 'payer_code_maps_current'::regclass),
    'payer_code_maps_current is security_invoker');
  perform test.ok(
    not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname = 'app'
                   and p.proname in ('member_is_owner_or_approver',
                                     'payer_code_map_names_its_recorder', 'payer_code_maps_as_of')
                   and (p.prosecdef or not coalesce(
                     p.proconfig @> array['search_path=pg_catalog, public, extensions'], false))),
    'the three functions are pinned and none is definer');

  -- The owner with no session cannot write a row naming someone.
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'recorded_by', 'the table owner with no session cannot write a mapping naming someone');

  set role app_rw;

  -- An analyst is a writer and still may not add a mapping.
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, analyst_a),
    'row-level security', 'an analyst cannot add a mapping');

  perform test.as_member(org_a, approver_a);

  -- Authorship: a row naming someone else is refused.
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, analyst_a),
    'recorded_by', 'an approver cannot write a mapping naming another member');

  -- A wrong canonical code is refused.
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'premium_noauth', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'payer_code_maps_canonical_code_check', 'a code outside the taxonomy is refused');

  -- A code that could not have come out of the normaliser is refused.
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'cb-203', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'payer_code_check', 'a lowercase payer code is refused');
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, ' CB  203', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'payer_code_check', 'a payer code with stray spaces is refused');

  -- A source, a confidence and a range outside the lists are refused.
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'price_discrepancy', '2026-01-01', 'a_model', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'source_check', 'an unknown source is refused');
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      effective_to, source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'price_discrepancy', '2026-02-01', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'payer_code_maps_effective_range', 'a range that ends before it starts is refused');

  -- Cross-tenant debtor: the composite key refuses it.
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_b, approver_a),
    'payer_code_maps_same_org_debtor', 'a mapping cannot name another tenant''s debtor');

  -- The rows the rule is asked about.
  insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
    source, source_note, confidence, recorded_by)
  values (org_a, debtor_a, 'CB-203', 'price_discrepancy', '2026-01-01', 'customer_confirmed',
          'AP lead, by phone', 'high', approver_a)
  returning id into m1;
  insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
    effective_to, source, confidence, recorded_by)
  values (org_a, debtor_a, 'CB-203', 'unauthorised_deduction_no_basis', '2026-03-01',
          '2026-03-31', 'operator', 'medium', approver_a);
  insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
    source, confidence, recorded_by)
  values (org_a, debtor_a, 'CB-203', 'promo_not_agreed', '2026-06-01', 'payer_guide_url',
          'low', approver_a);

  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'CB-203', 'shortage_carton', '2026-06-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'payer_code_maps_one_per_start', 'one row per (debtor, code, effective_from)');

  perform test.ok((select count(*) from app.payer_code_maps_as_of('2025-12-31')) = 0,
    'before the first effective_from nothing applies');
  select canonical_code into got from app.payer_code_maps_as_of('2026-02-15');
  perform test.ok(got = 'price_discrepancy', 'the first row applies from its start');
  select canonical_code into got from app.payer_code_maps_as_of('2026-03-31');
  perform test.ok(got = 'unauthorised_deduction_no_basis',
    'a later row wins on its last day');
  select canonical_code into got from app.payer_code_maps_as_of('2026-04-01');
  perform test.ok(got = 'price_discrepancy',
    'an expired row never wins: the open-ended row before it applies again');
  select canonical_code into got from app.payer_code_maps_as_of('2026-06-01');
  perform test.ok(got = 'promo_not_agreed', 'the latest effective row wins');
  select count(*) into n from payer_code_maps_current;
  perform test.ok(n = 1, 'the view answers one row per (debtor, code)');
  select canonical_code into got from payer_code_maps_current;
  perform test.ok(got = (select canonical_code from app.payer_code_maps_as_of(current_date)),
    'the view is the function at current_date');

  -- Append-only.
  perform test.expect_error(format(
    'update payer_code_maps set canonical_code = ''shortage_carton'' where id = %L', m1),
    'denied', 'no UPDATE on payer_code_maps');
  perform test.expect_error(format('delete from payer_code_maps where id = %L', m1),
    'denied', 'no DELETE on payer_code_maps');
  perform test.expect_error('truncate payer_code_maps', 'denied', 'no TRUNCATE on payer_code_maps');

  -- app_ro reads and cannot write.
  reset role;
  set role app_ro;
  perform test.as_member(org_a, approver_a);
  perform test.ok((select count(*) from payer_code_maps) = 3, 'app_ro reads the tenant''s rows');
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'X1', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'denied', 'app_ro cannot insert');

  reset role;
  perform test.expect_error(format(
    'update payer_code_maps set canonical_code = ''shortage_carton'' where id = %L', m1),
    'append-only', 'the trigger refuses UPDATE for the owner');
  perform test.expect_error(format('delete from payer_code_maps where id = %L', m1),
    'append-only', 'the trigger refuses DELETE for the owner');
  perform test.expect_error('truncate payer_code_maps', 'append-only',
    'the trigger refuses TRUNCATE for the owner');

  -- Another tenant sees none of it, through the table, the function or the view.
  set role app_rw;
  perform test.as_member(org_b, approver_b);
  perform test.ok((select count(*) from payer_code_maps) = 0, 'B sees no mapping of A''s');
  perform test.ok((select count(*) from app.payer_code_maps_as_of('2026-06-01')) = 0,
    'B sees none through the function');
  perform test.ok((select count(*) from payer_code_maps_current) = 0,
    'B sees none through the view');
  perform test.expect_error(format($s$
    insert into payer_code_maps (org_id, debtor_id, payer_code, canonical_code, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 'X1', 'price_discrepancy', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_b),
    'row-level security', 'B cannot write a mapping into A');
  reset role;
end
$test$;
rollback;
