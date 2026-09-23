\echo '-- 27 an approval is written by the person it names'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; dec uuid; analyst uuid; approver uuid;
  second_approver uuid; owner_id uuid; reader uuid;
  own_dec uuid; approval uuid; sub uuid;
  names text[];
begin
  ids := test.seed_org('writtenbyapprover');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid; dec := (ids->>'decision')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;

  -- seed_org gives the analyst who prepared `dec` and one approver. The rule is
  -- about any caller naming anyone else, so there is a second approver, an
  -- owner and a read_only member to name.
  insert into users (email, full_name)
    values ('writtenbyapprover-approver2@example.test', 'Second Approver')
    returning id into second_approver;
  insert into memberships (org_id, user_id, role) values (org, second_approver, 'approver');
  insert into users (email, full_name)
    values ('writtenbyapprover-owner@example.test', 'Owner')
    returning id into owner_id;
  insert into memberships (org_id, user_id, role) values (org, owner_id, 'owner');
  insert into users (email, full_name)
    values ('writtenbyapprover-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org, reader, 'read_only');

  set role app_rw;

  -- -------------------------------------------------------------------------
  -- The hole (ADR 0040): the analyst who prepared the decision writes an
  -- approval in an approver's name. SoD checks the name, the name is an
  -- approver's and not the preparer's, and tenant_insert admits an analyst.
  -- -------------------------------------------------------------------------
  perform test.as_member(org, analyst);

  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, approver),
    'is not the caller',
    'the analyst who prepared a decision cannot approve it in an approver''s name');

  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, owner_id),
    'is not the caller',
    'nor in the owner''s');

  perform test.ok((select count(*) from approvals where decision_id = dec) = 0,
    'and neither attempt left an approval row behind');

  -- The rest of the attack: with no forged approval, the same analyst's
  -- submission meets the gate exactly as before.
  perform test.expect_error(format(
    'insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                              confirmation_number, submitted_at)
       values (%L, %L, %L, ''manual_portal'', %L, ''FORGED-1'', now())',
    org, ded, dec, digest('filed packet', 'sha256')),
    'no submit approval row',
    'so the preparer cannot file it either');

  -- Order, pinned: a row that is forged *and* names somebody SoD would refuse
  -- is reported as forged. Every check SoD makes is about the named person,
  -- and when that is not the caller they describe the wrong one.
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, reader),
    'is not the caller',
    'a forged approval is refused as forged before separation of duties judges the name');

  -- -------------------------------------------------------------------------
  -- It is about the caller, not about analysts: an approver may not approve
  -- in a colleague's name either.
  -- -------------------------------------------------------------------------
  perform test.as_member(org, second_approver);
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, approver),
    'is not the caller',
    'an approver cannot record an approval in another approver''s name');

  -- -------------------------------------------------------------------------
  -- No session, no approval — whatever the database role.
  -- -------------------------------------------------------------------------
  perform test.as_nobody();
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, approver),
    '(no session)',
    'app_rw with no claims cannot write an approval');

  reset role;
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, approver),
    '(no session)',
    'nor can the table owner, which RLS does not stop but the trigger does');

  perform test.as_member(org, analyst);
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, dec, approver),
    'is not the caller',
    'and the owner acting under the analyst''s claims is refused like the analyst');
  set role app_rw;

  -- -------------------------------------------------------------------------
  -- Together with separation of duties: the only approval a preparer can
  -- write is one in their own name, and that is the one SoD refuses. An
  -- approver who decides is a preparer like any other (ADR 0020 §5).
  -- -------------------------------------------------------------------------
  perform test.as_member(org, second_approver);
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, cost_micros,
                         prepared_by)
    values (org, ded, 'B', 'human-1', 'human', 'human', digest('own state', 'sha256'),
            '{"dispute_reason":"choice"}'::jsonb,
            '{"dispute_reason":"shortage_never_received"}'::jsonb,
            '{}'::jsonb, 1.0000, 0, 0, second_approver)
    returning id into own_dec;
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, own_dec, second_approver),
    'cannot approve their own decision',
    'an approver who prepared a decision, approving in their own name, is refused by SoD');
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type)
       values (%L, %L, %L, ''submit'')', org, own_dec, approver),
    'is not the caller',
    'and cannot get round it by naming the other approver');

  -- -------------------------------------------------------------------------
  -- The legitimate path is unchanged: the approver, in their own session.
  -- -------------------------------------------------------------------------
  perform test.as_member(org, approver);
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit')
    returning id into approval;
  perform test.ok(approval is not null,
    'an approver who did not prepare the decision approves it in their own session');
  perform test.ok(
    (select a.approver_id from approvals a where a.id = approval) = approver,
    'and the row names the caller who wrote it');

  -- And the owner, who is also an approver of the org, likewise.
  perform test.as_member(org, owner_id);
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, own_dec, owner_id, 'submit');
  perform test.ok(
    (select a.approver_id from approvals a
      where a.decision_id = own_dec and a.action_type = 'submit') = owner_id,
    'an owner approves another member''s decision in their own name');

  -- Anyone who may write may then file; the gate asks for the approval, and
  -- now the approval is a real one.
  perform test.as_member(org, analyst);
  insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                           confirmation_number, submitted_at)
    values (org, ded, dec, 'manual_portal', digest('filed packet', 'sha256'),
            'APDP-27001', now())
    returning id into sub;
  perform test.ok(sub is not null, 'and the submission it authorises is accepted');

  reset role;

  -- -------------------------------------------------------------------------
  -- The catalogue says the same: one before-insert row trigger, ahead of
  -- SoD's in name order, on a pinned, non-definer function — and nothing
  -- about approvals' grants moved.
  -- -------------------------------------------------------------------------
  perform test.ok(exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'approvals'::regclass
       and t.tgname = 'approval_names_its_approver'
       and t.tgfoid = 'app.approval_names_its_approver()'::regprocedure
       and t.tgenabled = 'O'
       -- ROW (1) | BEFORE (2) | INSERT (4), and no UPDATE, DELETE or TRUNCATE.
       and t.tgtype = (1 | 2 | 4)),
    'approvals carries approval_names_its_approver as a before-insert row trigger');

  select array_agg(t.tgname::text order by t.tgname) into names
    from pg_trigger t
   where t.tgrelid = 'approvals'::regclass
     and not t.tgisinternal
     and t.tgtype & 2 = 2 and t.tgtype & 4 = 4;
  perform test.ok(
    names = array['approval_names_its_approver', 'enforce_separation_of_duties'],
    format('the before-insert triggers on approvals, in firing order: %s', names));

  perform test.ok(
    (select not p.prosecdef
            and p.proconfig @> array['search_path=pg_catalog, public, extensions']
       from pg_proc p where p.oid = 'app.approval_names_its_approver()'::regprocedure),
    'the function is security invoker with a pinned search_path');

  perform test.ok(has_table_privilege('app_rw', 'approvals', 'INSERT')
              and has_table_privilege('app_rw', 'approvals', 'SELECT')
              and not has_table_privilege('app_rw', 'approvals', 'UPDATE')
              and not has_table_privilege('app_rw', 'approvals', 'DELETE')
              and not has_table_privilege('app_rw', 'approvals', 'TRUNCATE'),
    'app_rw still holds exactly select and insert on approvals');
end
$test$;
rollback;
