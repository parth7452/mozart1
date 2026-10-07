\echo '-- 40 a case opened in error is removed (ADR 0072)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; debtor_a uuid; case_a uuid;
  filed uuid; fresh uuid; before_cents bigint; after_cents bigint;
begin
  a := test.seed_org('rmva');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  approver_a := (a->>'approver')::uuid; debtor_a := (a->>'debtor')::uuid;
  case_a := (a->>'deduction')::uuid;

  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents, state)
    values (org_a, debtor_a, 'RMV-FILED', 5000, 'submitted') returning id into filed;
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents, state)
    values (org_a, debtor_a, 'RMV-FRESH', 7000, 'classified') returning id into fresh;

  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'deductions'::regclass and conname = 'deductions_state_check')
      like '%''removed''%',
    'deductions_state_check admits removed');
  perform test.ok(
    exists (select 1 from pg_trigger where tgrelid = 'deductions'::regclass
             and tgname = 'removal_is_guarded' and not tgisinternal),
    'the removal_is_guarded trigger is present');
  perform test.ok(
    not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname = 'app' and p.proname = 'removal_is_guarded'
                   and (p.prosecdef or not coalesce(
                     p.proconfig @> array['search_path=pg_catalog, public, extensions'], false))),
    'app.removal_is_guarded is pinned and not definer');

  set role app_rw;
  perform test.as_member(org_a, approver_a);
  select coalesce(sum(opened_cents), 0) into before_cents
    from coverage_by_period_by_source where org_id = org_a;

  -- No event first: refused.
  perform test.expect_error(format(
    'update deductions set state = ''removed'' where id = %L', fresh),
    'case removal refused: no_event', 'a removal with no case.removed event is refused');

  -- An analyst, even with the event: refused.
  perform test.as_member(org_a, analyst_a);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org_a, fresh, 'case.removed', jsonb_build_object('state_before', 'classified'),
            now(), analyst_a);
  perform test.expect_error(format(
    'update deductions set state = ''removed'' where id = %L', fresh),
    'case removal refused: not_owner_or_approver', 'an analyst cannot remove a case');

  -- The approver, event first: ok.
  perform test.as_member(org_a, approver_a);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org_a, case_a, 'case.removed', jsonb_build_object('state_before', 'awaiting_approval'),
            now(), approver_a);
  update deductions set state = 'removed' where id = case_a;
  perform test.ok((select state from deductions where id = case_a) = 'removed',
    'an approver removes a case once its event is recorded');

  -- A filed case: refused.
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org_a, filed, 'case.removed', jsonb_build_object('state_before', 'submitted'),
            now(), approver_a);
  perform test.expect_error(format(
    'update deductions set state = ''removed'' where id = %L', filed),
    'case removal refused: not_removable_state', 'a submitted case cannot be removed');

  -- Out of removed: refused, whatever the target.
  perform test.expect_error(format(
    'update deductions set state = ''classified'' where id = %L', case_a),
    'case removal refused: irreversible', 'a removed case never leaves removed');

  -- Coverage counts it nowhere.
  select coalesce(sum(opened_cents), 0) into after_cents
    from coverage_by_period_by_source where org_id = org_a;
  perform test.ok(before_cents - after_cents = 312000,
    'coverage_by_period_by_source no longer counts the removed case');
  reset role;

  -- Even the table owner cannot bring it back.
  perform test.expect_error(format(
    'update deductions set state = ''classified'' where id = %L', case_a),
    'case removal refused: irreversible', 'the owner cannot move a case out of removed either');
end
$test$;
rollback;
