\echo '-- 03 separation of duties'
begin;
do $test$
declare
  ids jsonb; org uuid; dec uuid; analyst uuid; approver uuid; reader uuid;
begin
  ids := test.seed_org('sod');
  org := (ids->>'org')::uuid; dec := (ids->>'decision')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;

  insert into users (email, full_name) values ('sod-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org, reader, 'read_only');

  set role app_rw;
  perform test.as_member(org, analyst);

  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, analyst),
    'cannot approve their own decision',
    'the analyst who prepared a decision cannot approve it');

  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, reader),
    'is not an approver', 'a read_only member cannot approve');

  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit');
  perform test.ok((select count(*) from approvals where decision_id = dec) = 1,
    'an approver who did not prepare the decision may approve it');

  reset role;
end
$test$;
rollback;
