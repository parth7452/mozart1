\echo '-- 10 a declined candidate is a fact, not a discard'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; dec uuid; approver uuid; analyst uuid; reader uuid;
  other_ids jsonb; other_org uuid; other_analyst uuid;
  row_id uuid; n int; coverage numeric;
begin
  ids := test.seed_org('counterfactual');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid; dec := (ids->>'decision')::uuid;
  approver := (ids->>'approver')::uuid; analyst := (ids->>'analyst')::uuid;

  insert into users (email, full_name) values ('counterfactual-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org, reader, 'read_only');

  set role app_rw;
  perform test.as_member(org, analyst);

  -- A candidate that never became a case at all: the shape ERP triage produces,
  -- and the rows coverage is actually measured against.
  insert into declined_candidates
    (org_id, discovered_from, reason, estimated_recoverable_cents,
     external_ids, decided_by, decided_by_version, missing_evidence, detail)
  values (org, 'erp_sync', 'below_economic_floor', 4_200,
          '{"erp_credit_memo": "CM-8812"}'::jsonb, 'triage', 'v1', '{}',
          'under the tenant floor')
  returning id into row_id;
  perform test.ok(row_id is not null, 'a candidate that never became a case can be recorded');

  -- One that did, with the evidence that would have changed the answer.
  insert into declined_candidates
    (org_id, deduction_id, discovered_from, reason, estimated_recoverable_cents,
     decided_by, decided_by_version, missing_evidence)
  values (org, ded, 'email_in', 'evidence_unavailable', 312_000,
          'policy', '2026.09', array['signed_pod', 'carrier_bol']);
  perform test.ok(
    (select cardinality(missing_evidence) from declined_candidates
      where deduction_id = ded) = 2,
    'what was missing is recorded, which is what makes the tail trainable');

  -- Append-only, like every other record of a decision here. Declining again for
  -- a different reason is a second row; the pair is the history.
  perform test.expect_error(format(
    'update declined_candidates set reason = ''deduction_valid'' where id = %L', row_id),
    'denied', 'a decline cannot be rewritten after the fact');
  perform test.expect_error(format(
    'delete from declined_candidates where id = %L', row_id),
    'denied', 'nor deleted, which is how a coverage number would be flattered');

  -- Amounts are the point: a decline with no number cannot be added up.
  perform test.expect_error(format(
    'insert into declined_candidates (org_id, discovered_from, reason,
       estimated_recoverable_cents, decided_by, decided_by_version)
     values (%L, ''erp_sync'', ''other'', -1, ''x'', ''1'')', org),
    'check constraint', 'a negative recoverable amount is refused');

  -- The sources a deduction may be discovered from now include the ones that
  -- find what nobody surfaced (CH-4).
  insert into uploads (org_id, source) values (org, 'erp_sync'), (org, 'portal_fetch'),
    (org, 'edi_812'), (org, 'email_body');
  perform test.ok((select count(*) from uploads where org_id = org) = 4,
    'a deduction can be discovered from the ERP, a portal, EDI or a message body');
  perform test.expect_error(format(
    'insert into uploads (org_id, source) values (%L, ''telepathy'')', org),
    'check constraint', 'and not from somewhere we have not thought about');

  -- Coverage: filed over everything we saw. With nothing filed yet it is 0.
  select coverage_of_seen into coverage from coverage_by_period where org_id = org;
  perform test.ok(coverage = 0,
    'coverage reads zero when everything seen was declined');

  -- File one, and coverage moves.
  reset role;
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit');
  set role app_rw;
  perform test.as_member(org, analyst);
  insert into submissions (org_id, deduction_id, decision_id, channel)
    values (org, ded, dec, 'manual_portal');

  select coverage_of_seen into coverage from coverage_by_period where org_id = org;
  perform test.ok(coverage > 0 and coverage < 1,
    'and moves once something is filed, without reaching 1 while a decline stands');

  -- A read_only member can read the log — it is what the customer-facing
  -- "what your process left on the table" is built from — and cannot write it.
  perform test.as_member(org, reader);
  perform test.ok((select count(*) from declined_candidates) = 2,
    'a read_only member can read the counterfactual log');
  perform test.expect_error(format(
    'insert into declined_candidates (org_id, discovered_from, reason,
       estimated_recoverable_cents, decided_by, decided_by_version)
     values (%L, ''erp_sync'', ''other'', 1, ''x'', ''1'')', org),
    'row-level security', 'and cannot add to it');

  -- And another tenant sees none of it, log and coverage alike. Seeded as the
  -- owner, because a tenant cannot create itself under RLS.
  reset role;
  other_ids := test.seed_org('counterfactualother');
  other_org := (other_ids->>'org')::uuid;
  other_analyst := (other_ids->>'analyst')::uuid;
  set role app_rw;
  perform test.as_member(other_org, other_analyst);
  select count(*) into n from declined_candidates;
  perform test.ok(n = 0, 'another tenant sees no declines');
  select count(*) into n from coverage_by_period;
  perform test.ok(n = 0, 'and no coverage rows, because the view reads as the caller');

  reset role;
end
$test$;
rollback;
