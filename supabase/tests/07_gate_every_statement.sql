\echo '-- 07 the approval gate covers every statement, and writing needs a writer'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; dec uuid; approver uuid; analyst uuid; reader uuid;
  other_dec uuid; sub uuid;
begin
  ids := test.seed_org('everystatement');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid; dec := (ids->>'decision')::uuid;
  approver := (ids->>'approver')::uuid; analyst := (ids->>'analyst')::uuid;

  -- A second decision on the same deduction that nobody ever approved.
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, ded, 'B', '1.0.0', 'jev', 'jev-latest', digest('other', 'sha256'),
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.51, 10, analyst)
    returning id into other_dec;

  insert into users (email, full_name) values ('everystatement-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org, reader, 'read_only');

  set role app_rw;
  perform test.as_member(org, analyst);

  -- A properly approved submission, filed the legitimate way.
  reset role;
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit');
  set role app_rw;
  perform test.as_member(org, analyst);

  insert into submissions (org_id, deduction_id, decision_id, channel)
    values (org, ded, dec, 'manual_portal') returning id into sub;
  perform test.ok(sub is not null, 'an approved submission is filed');

  -- The hole this suite exists for: the gate used to cover INSERT only, so a
  -- row filed against an approved decision could be repointed at an unapproved
  -- one. Two layers now stop that, and both are asserted.
  perform test.expect_error(format(
    'update submissions set decision_id = %L where id = %L', other_dec, sub),
    'no submit approval row',
    'repointing at an unapproved decision is caught by the approval gate');

  -- Even when the other decision IS approved, the core stays immutable: a
  -- submission records what went out, not what could have.
  declare unused uuid;
  begin
    reset role;
    insert into approvals (org_id, decision_id, approver_id, action_type)
      values (org, other_dec, approver, 'submit');
    set role app_rw;
    perform test.as_member(org, analyst);
    perform test.expect_error(format(
      'update submissions set decision_id = %L where id = %L', other_dec, sub),
      'immutable once written',
      'and repointing at an approved one is caught by the immutability guard');
  end;

  declare second_ded uuid;
  begin
    insert into deductions (org_id, claim_id, deduction_amount_cents)
      values (org, 'SECOND-CLAIM', 5000) returning id into second_ded;
    -- The approval row names a (decision, deduction) pair, so moving the
    -- submission to another deduction invalidates the pair and the approval
    -- gate refuses it before the immutability guard is reached. Both would.
    perform test.expect_error(format(
      'update submissions set deduction_id = %L where id = %L', second_ded, sub),
      'no submit approval row', 'the deduction a submission names is immutable');
  end;

  perform test.expect_error(format(
    'update submissions set channel = ''email'' where id = %L', sub),
    'immutable once written', 'the channel a submission went out on is immutable');

  perform test.expect_error(format('delete from submissions where id = %L', sub),
    'denied', 'a member holds no DELETE on a record of an outbound act');

  -- The lifecycle a submission legitimately has.
  update submissions
     set status = 'accepted', confirmation_number = 'APDP-99812', submitted_at = now()
   where id = sub;
  perform test.ok(
    (select confirmation_number from submissions where id = sub) = 'APDP-99812',
    'a confirmation number can still be recorded after filing');

  -- Write-offs: the approved amount and the recorded amount stay the same thing.
  declare wo uuid;
  begin
    reset role;
    insert into approvals (org_id, decision_id, approver_id, action_type)
      values (org, dec, approver, 'writeoff');
    set role app_rw;
    perform test.as_member(org, analyst);

    insert into writeoffs (org_id, deduction_id, decision_id, amount_cents)
      values (org, ded, dec, 100) returning id into wo;
    perform test.expect_error(format(
      'update writeoffs set amount_cents = 31200000 where id = %L', wo),
      'immutable once written',
      'a write-off cannot be inflated after it was approved');
  end;

  -- Writing needs a writer: read_only may read and nothing else.
  perform test.as_member(org, reader);
  perform test.ok((select count(*) from submissions) = 1,
    'a read_only member can read their tenant''s submissions');
  perform test.ok((select count(*) from deductions) >= 1,
    'a read_only member can read their tenant''s cases');

  perform test.expect_error(format(
    'insert into deductions (org_id, claim_id, deduction_amount_cents)
       values (%L, ''READONLY-1'', 1000)', org),
    'row-level security', 'a read_only member cannot open a case');

  -- An UPDATE whose USING clause excludes the row does not raise: it matches
  -- nothing. The security property is that nothing changed, so that is what is
  -- asserted — an error would be a nicer message, not a stronger guarantee.
  update deductions set state = 'submitted' where id = ded;
  perform test.ok((select state from deductions where id = ded) <> 'submitted',
    'a read_only member cannot advance a case');

  update org_settings set fee_pct_bps = 1 where org_id = org;
  perform test.ok((select fee_pct_bps from org_settings where org_id = org) <> 1,
    'a read_only member cannot rewrite the contract terms');

  delete from deductions where id = ded;
  perform test.ok((select count(*) from deductions where id = ded) = 1,
    'a read_only member cannot delete a case');

  perform test.expect_error(format(
    'insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values (%L, %L, ''forged'', ''{}''::jsonb, now())', org, ded),
    'row-level security', 'a read_only member cannot append events');

  -- An analyst still can, or the tenant could do no work at all.
  perform test.as_member(org, analyst);
  insert into deductions (org_id, claim_id, deduction_amount_cents)
    values (org, 'ANALYST-1', 1000);
  perform test.ok(true, 'an analyst can still do the tenant''s work');

  reset role;
end
$test$;
rollback;
