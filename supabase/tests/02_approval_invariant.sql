\echo '-- 02 the one-way door: no outbound or write-back without an approval'
begin;
do $test$
declare
  a jsonb; b jsonb; org uuid; ded uuid; dec uuid; approver uuid; analyst uuid;
begin
  a := test.seed_org('onewaydoor');
  b := test.seed_org('otherorg');
  org := (a->>'org')::uuid; ded := (a->>'deduction')::uuid; dec := (a->>'decision')::uuid;
  approver := (a->>'approver')::uuid; analyst := (a->>'analyst')::uuid;

  set role app_rw;
  perform test.as_member(org, analyst);

  perform test.expect_error(format(
    'insert into submissions (org_id, deduction_id, decision_id, channel)
       values (%L, %L, %L, ''manual_portal'')', org, ded, dec),
    'no submit approval row', 'submission without an approval fails at the DB');
  perform test.expect_error(format(
    'insert into writebacks (org_id, deduction_id, decision_id, method)
       values (%L, %L, %L, ''credit_memo_offset'')', org, ded, dec),
    'no writeback approval row', 'QBO write-back without an approval fails at the DB');
  perform test.expect_error(format(
    'insert into writeoffs (org_id, deduction_id, decision_id, amount_cents)
       values (%L, %L, %L, 312000)', org, ded, dec),
    'no writeoff approval row', 'write-off without an approval fails at the DB');

  -- A submit approval unlocks submission only, and only for this decision.
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit');

  insert into submissions (org_id, deduction_id, decision_id, channel, confirmation_number, submitted_at)
    values (org, ded, dec, 'manual_portal', 'APDP-99812', now());
  perform test.ok((select count(*) from submissions where decision_id = dec) = 1,
    'submission is accepted once its approval row exists');

  perform test.expect_error(format(
    'insert into writebacks (org_id, deduction_id, decision_id, method)
       values (%L, %L, %L, ''credit_memo_offset'')', org, ded, dec),
    'no writeback approval row', 'a submit approval does not authorise a write-back');

  perform test.expect_error(format(
    'insert into submissions (org_id, deduction_id, decision_id, channel)
       values (%L, %L, %L, ''manual_portal'')', org, ded, dec),
    'duplicate key', 'the same decision cannot be submitted twice on one channel');

  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, approver),
    'duplicate key', 'one approval row per decision per action');

  -- An approval must match the deduction the submission names.
  declare other_ded uuid;
  begin
    perform test.as_member(org, analyst);
    select id into other_ded from deductions
      where org_id = org and id <> ded limit 1;
    if other_ded is null then
      insert into deductions (org_id, claim_id, deduction_amount_cents, state)
        values (org, 'CLAIM-SECOND', 45000, 'awaiting_approval') returning id into other_ded;
    end if;
    perform test.expect_error(format(
      'insert into submissions (org_id, deduction_id, decision_id, channel)
         values (%L, %L, %L, ''email'')', org, other_ded, dec),
      'no submit approval row',
      'an approval for one deduction does not authorise another');
  end;

  -- Cross-tenant: org B cannot use org A's approval, and RLS hides it anyway.
  perform test.as_member((b->>'org')::uuid, (b->>'analyst')::uuid);
  perform test.expect_error(format(
    'insert into submissions (org_id, deduction_id, decision_id, channel)
       values (%L, %L, %L, ''email'')', (b->>'org')::uuid, (b->>'deduction')::uuid, dec),
    'no submit approval row', 'an approval never crosses a tenant boundary');

  reset role;
end
$test$;
rollback;
