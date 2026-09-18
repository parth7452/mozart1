\echo '-- 05 thresholds auto-tighten, never auto-loosen'
begin;
do $test$
declare ids jsonb; org uuid;
begin
  ids := test.seed_org('thresholds');
  org := (ids->>'org')::uuid;

  set role app_rw;
  perform test.as_member(org, (ids->>'analyst')::uuid);

  -- Tightening is always allowed.
  update org_settings set auto_dispute_ceiling_cents = 25000,
                          min_decision_confidence = 0.980
    where org_id = org;
  perform test.ok((select auto_dispute_ceiling_cents = 25000 and min_decision_confidence = 0.980
                     from org_settings where org_id = org),
    'tightening a ceiling or raising a confidence floor needs no ceremony');

  perform test.expect_error(format(
    'update org_settings set auto_dispute_ceiling_cents = 500000 where org_id = %L', org),
    'threshold loosening blocked', 'raising an auto ceiling is blocked');
  perform test.expect_error(format(
    'update org_settings set min_decision_confidence = 0.500 where org_id = %L', org),
    'threshold loosening blocked', 'lowering a confidence floor is blocked');
  perform test.expect_error(format(
    'update org_settings set auto_writeoff_ceiling_cents = 100000 where org_id = %L', org),
    'threshold loosening blocked', 'raising the write-off ceiling is blocked');

  -- Loosening is possible, but only by naming the ADR that authorises it.
  perform set_config('app.threshold_loosening_adr', 'ADR-0042', true);
  update org_settings set auto_dispute_ceiling_cents = 100000 where org_id = org;
  perform test.ok((select auto_dispute_ceiling_cents = 100000 from org_settings where org_id = org),
    'loosening succeeds when an authorising ADR is named');
  perform set_config('app.threshold_loosening_adr', '', true);

  reset role;
end
$test$;
rollback;
