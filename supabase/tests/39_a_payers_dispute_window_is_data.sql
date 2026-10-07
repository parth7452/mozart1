\echo '-- 39 a payer''s dispute window is data (ADR 0071)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; debtor_a uuid;
  b jsonb; org_b uuid; approver_b uuid; debtor_b uuid;
  w1 uuid; got int; n int; r text;
begin
  a := test.seed_org('pdwa');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  approver_a := (a->>'approver')::uuid; debtor_a := (a->>'debtor')::uuid;
  b := test.seed_org('pdwb');
  org_b := (b->>'org')::uuid; approver_b := (b->>'approver')::uuid;
  debtor_b := (b->>'debtor')::uuid;

  perform test.ok((select relrowsecurity from pg_class where oid = 'payer_dispute_windows'::regclass),
    'RLS is on');
  perform test.ok(
    (select count(*) from pg_trigger where tgrelid = 'payer_dispute_windows'::regclass
        and tgname in ('no_update_delete', 'no_truncate',
                       'payer_dispute_window_names_its_recorder')) = 3,
    'no_update_delete, no_truncate and the authorship trigger are present');
  perform test.ok(
    has_table_privilege('app_rw', 'payer_dispute_windows', 'SELECT')
    and has_table_privilege('app_rw', 'payer_dispute_windows', 'INSERT')
    and not has_table_privilege('app_rw', 'payer_dispute_windows', 'UPDATE')
    and not has_table_privilege('app_rw', 'payer_dispute_windows', 'DELETE')
    and not has_table_privilege('app_rw', 'payer_dispute_windows', 'TRUNCATE'),
    'app_rw holds SELECT and INSERT only');
  perform test.ok(
    has_table_privilege('app_ro', 'payer_dispute_windows', 'SELECT')
    and not has_table_privilege('app_ro', 'payer_dispute_windows', 'INSERT')
    and not has_table_privilege('app_ro', 'payer_dispute_windows', 'UPDATE')
    and not has_table_privilege('app_ro', 'payer_dispute_windows', 'DELETE'),
    'app_ro holds SELECT only');
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      perform test.ok(
        not has_table_privilege(r, 'payer_dispute_windows', 'SELECT')
        and not has_table_privilege(r, 'payer_dispute_windows', 'INSERT')
        and not has_function_privilege(r, 'app.payer_dispute_windows_as_of(date)', 'EXECUTE'),
        format('request role %s holds nothing', r));
    end if;
  end loop;
  perform test.ok(
    not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname = 'app'
                   and p.proname in ('payer_dispute_window_names_its_recorder',
                                     'payer_dispute_windows_as_of')
                   and (p.prosecdef or not coalesce(
                     p.proconfig @> array['search_path=pg_catalog, public, extensions'], false))),
    'both functions are pinned and neither is definer');

  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 30, '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'recorded_by', 'the table owner with no session cannot write a window naming someone');

  set role app_rw;

  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 30, '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, analyst_a),
    'row-level security', 'an analyst cannot add a window');

  perform test.as_member(org_a, approver_a);

  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 30, '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, analyst_a),
    'recorded_by', 'an approver cannot write a window naming another member');

  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 0, '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'window_days_check', 'a window of 0 days is refused');
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 731, '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'window_days_check', 'a window of 731 days is refused');
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, measured_from,
      effective_from, source, confidence, recorded_by)
    values (%L, %L, 30, 'invoice_date', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'measured_from_check', 'an anchor other than the deduction date is refused');
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 30, '2026-01-01', 'a_model', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'source_check', 'an unknown source is refused');
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      effective_to, source, confidence, recorded_by)
    values (%L, %L, 30, '2026-02-01', '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'payer_dispute_windows_effective_range', 'a range that ends before it starts is refused');
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 30, '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_b, approver_a),
    'payer_dispute_windows_same_org_debtor', 'a window cannot name another tenant''s debtor');

  insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
    source, source_note, confidence, recorded_by, created_at)
  values (org_a, debtor_a, 30, '2026-01-01', 'payer_guide_url', 'supplier guide §4', 'high',
          approver_a, '2026-01-01T00:00:00Z')
  returning id into w1;
  insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
    effective_to, source, confidence, recorded_by, created_at)
  values (org_a, debtor_a, 60, '2026-03-01', '2026-03-31', 'operator', 'medium', approver_a,
          '2026-01-02T00:00:00Z');
  -- A later recording for the same start replaces the first one's answer.
  insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
    source, confidence, recorded_by, created_at)
  values (org_a, debtor_a, 45, '2026-06-01', 'payer_guide_url', 'low', approver_a,
          '2026-05-01T00:00:00Z');
  insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
    source, confidence, recorded_by, created_at)
  values (org_a, debtor_a, 90, '2026-06-01', 'customer_confirmed', 'high', approver_a,
          '2026-05-02T00:00:00Z');

  perform test.ok((select count(*) from app.payer_dispute_windows_as_of('2025-12-31')) = 0,
    'before the first effective_from nothing applies');
  select window_days into got from app.payer_dispute_windows_as_of('2026-02-15');
  perform test.ok(got = 30, 'the first row applies from its start');
  select window_days into got from app.payer_dispute_windows_as_of('2026-03-31');
  perform test.ok(got = 60, 'a later row wins on its last day');
  select window_days into got from app.payer_dispute_windows_as_of('2026-04-01');
  perform test.ok(got = 30, 'an expired row never wins: the open-ended row before it applies again');
  select count(*) into n from app.payer_dispute_windows_as_of('2026-06-01');
  perform test.ok(n = 1, 'one row per debtor');
  select window_days into got from app.payer_dispute_windows_as_of('2026-06-01');
  perform test.ok(got = 90, 'a later recording of the same dates wins');

  perform test.expect_error(format(
    'update payer_dispute_windows set window_days = 1 where id = %L', w1),
    'denied', 'no UPDATE on payer_dispute_windows');
  perform test.expect_error(format('delete from payer_dispute_windows where id = %L', w1),
    'denied', 'no DELETE on payer_dispute_windows');
  perform test.expect_error('truncate payer_dispute_windows', 'denied',
    'no TRUNCATE on payer_dispute_windows');

  reset role;
  set role app_ro;
  perform test.as_member(org_a, approver_a);
  perform test.ok((select count(*) from payer_dispute_windows) = 4, 'app_ro reads the tenant''s rows');
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 30, '2027-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_a),
    'denied', 'app_ro cannot insert');

  reset role;
  perform test.expect_error(format(
    'update payer_dispute_windows set window_days = 1 where id = %L', w1),
    'append-only', 'the trigger refuses UPDATE for the owner');
  perform test.expect_error(format('delete from payer_dispute_windows where id = %L', w1),
    'append-only', 'the trigger refuses DELETE for the owner');
  perform test.expect_error('truncate payer_dispute_windows', 'append-only',
    'the trigger refuses TRUNCATE for the owner');

  set role app_rw;
  perform test.as_member(org_b, approver_b);
  perform test.ok((select count(*) from payer_dispute_windows) = 0, 'B sees no window of A''s');
  perform test.ok((select count(*) from app.payer_dispute_windows_as_of('2026-06-01')) = 0,
    'B sees none through the function');
  perform test.expect_error(format($s$
    insert into payer_dispute_windows (org_id, debtor_id, window_days, effective_from,
      source, confidence, recorded_by)
    values (%L, %L, 30, '2026-01-01', 'operator', 'low', %L)$s$,
      org_a, debtor_a, approver_b),
    'row-level security', 'B cannot write a window into A');
  reset role;
end
$test$;
rollback;
