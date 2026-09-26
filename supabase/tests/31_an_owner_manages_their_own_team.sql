\echo '-- 31 an owner manages their own team (ADR 0051)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid;
  b jsonb; org_b uuid; analyst_b uuid;
  owner_a uuid; owner_b uuid; second_owner uuid; invited uuid;
  r record;
  was membership_role;
  n int;
  fn record;
begin
  a := test.seed_org('teama');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid; approver_a := (a->>'approver')::uuid;
  b := test.seed_org('teamb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  insert into users (email, full_name) values ('teama-owner@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('teamb-owner@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role) values (org_a, owner_a, 'owner'), (org_b, owner_b, 'owner');

  -- =========================================================================
  -- The catalogue: three definer doors for app_rw, two helpers for nobody
  -- =========================================================================
  for fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'app'
       and p.proname in ('invite_member', 'change_member_role', 'remove_member',
                         'team_owner_org', 'team_member_holds', 'membership_keeps_an_owner',
                         'invited_address', 'address_is_invited')
  loop
    perform test.ok(
      coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false),
      format('app.%s pins search_path', fn.proname));
    perform test.ok(not has_function_privilege('public', fn.oid, 'execute'),
      format('PUBLIC may not execute app.%s', fn.proname));
    perform test.ok(not has_function_privilege('app_ro', fn.oid, 'execute'),
      format('app_ro may not execute app.%s', fn.proname));
    perform test.ok(not has_function_privilege('anon', fn.oid, 'execute')
                and not has_function_privilege('authenticated', fn.oid, 'execute')
                and not has_function_privilege('service_role', fn.oid, 'execute'),
      format('no Supabase request role may execute app.%s', fn.proname));
    if fn.proname in ('invite_member', 'change_member_role', 'remove_member', 'address_is_invited') then
      perform test.ok(fn.prosecdef, format('app.%s is security definer', fn.proname));
      perform test.ok(has_function_privilege('app_rw', fn.oid, 'execute'),
        format('app_rw may execute app.%s', fn.proname));
    else
      perform test.ok(not fn.prosecdef, format('app.%s is not security definer', fn.proname));
      perform test.ok(not has_function_privilege('app_rw', fn.oid, 'execute'),
        format('app_rw may not execute the helper app.%s', fn.proname));
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app'
     and p.proname in ('invite_member', 'change_member_role', 'remove_member',
                       'team_owner_org', 'team_member_holds', 'membership_keeps_an_owner',
                       'invited_address', 'address_is_invited');
  perform test.ok(n = 8, format('exactly eight functions, no stray overload (saw %s)', n));

  -- No grant widened: audit_log is still insert-and-read for app_rw, and
  -- memberships/users hold what 0006 gave them.
  perform test.ok(not has_table_privilege('app_rw', 'audit_log', 'update')
              and not has_table_privilege('app_rw', 'audit_log', 'delete'),
    'app_rw still holds no UPDATE or DELETE on audit_log');
  perform test.ok(not has_table_privilege('app_ro', 'memberships', 'insert')
              and not has_table_privilege('app_ro', 'users', 'insert'),
    'app_ro still writes neither memberships nor users');

  set role app_rw;

  -- =========================================================================
  -- Refused: no claims, a subject alone, and anyone but an owner
  -- =========================================================================
  perform test.as_nobody();
  perform test.expect_error(
    $$select * from app.invite_member('x@example.test', 'X', 'analyst')$$,
    'needs both an org and a subject', 'invite is refused with no claims');
  perform set_config('request.jwt.claims', json_build_object('sub', owner_a::text)::text, true);
  perform test.expect_error(
    format('select app.remove_member(%L)', analyst_a),
    'needs both an org and a subject', 'remove is refused to a subject with no org');

  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    $$select * from app.invite_member('x@example.test', 'X', 'owner')$$,
    'only an owner', 'an analyst cannot invite (least of all an owner)');
  perform test.expect_error(
    format('select app.change_member_role(%L, %L)', analyst_a, 'owner'),
    'only an owner', 'an analyst cannot promote themselves');
  perform test.as_member(org_a, approver_a);
  perform test.expect_error(
    format('select app.remove_member(%L)', owner_a),
    'only an owner', 'an approver cannot remove an owner');
  -- A member of B naming A in its claim is not an owner of A.
  perform test.as_member(org_a, owner_b);
  perform test.expect_error(
    format('select app.remove_member(%L)', analyst_a),
    'only an owner', 'an owner of another workspace is not an owner here');

  -- =========================================================================
  -- Cross-tenant: an owner reaches only their own org's members
  -- =========================================================================
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format('select app.change_member_role(%L, %L)', analyst_b, 'read_only'),
    'not a member of this workspace', 'A''s owner cannot re-role B''s analyst');
  perform test.expect_error(
    format('select app.remove_member(%L)', analyst_b),
    'not a member of this workspace', 'nor remove them');
  reset role;
  select count(*) into n from memberships where org_id = org_b and user_id = analyst_b and role = 'analyst';
  perform test.ok(n = 1, 'B''s analyst is untouched');
  set role app_rw;
  perform test.as_member(org_a, owner_a);

  -- =========================================================================
  -- Invite: one users row per address, ignoring capitals
  -- =========================================================================
  select * into r from app.invite_member('  New.Person@Example.TEST ', ' New Person ', 'approver');
  perform test.ok(r.users_row_created,
    'a new address creates one users row');
  invited := r.member_user_id;
  reset role;
  select count(*) into n from users where lower(email) = 'new.person@example.test';
  perform test.ok(n = 1, 'exactly one users row for it');
  select count(*) into n from users where id = invited and email = 'New.Person@Example.TEST' and full_name = 'New Person';
  perform test.ok(n = 1, 'stored trimmed, as typed');
  set role app_rw;
  perform test.as_member(org_a, owner_a);

  -- B's analyst, invited to A in other capitals, is the same person.
  reset role;
  update users set auth_user_id = gen_random_uuid() where id = analyst_b;
  set role app_rw;
  perform test.as_member(org_a, owner_a);
  select * into r from app.invite_member('TEAMB-Analyst@Example.Test', 'Renamed?', 'analyst');
  perform test.ok(r.member_user_id = analyst_b and not r.users_row_created,
    'an address matching an existing row in other capitals reuses it');
  reset role;
  select count(*) into n from users where lower(email) = 'teamb-analyst@example.test';
  perform test.ok(n = 1, 'and no second row was made');
  select count(*) into n from users where id = analyst_b and full_name = 'Analyst';
  perform test.ok(n = 1, 'and another workspace''s person was not renamed');
  select count(*) into n from memberships
   where org_id = org_a and user_id = analyst_b and display_name = 'Renamed?';
  perform test.ok(n = 1, 'the name the owner typed is kept on their own membership');
  select count(*) into n from memberships
   where org_id = org_b and user_id = analyst_b and display_name is null;
  perform test.ok(n = 1, 'and the other workspace''s membership is untouched');
  set role app_rw;
  perform test.as_member(org_a, owner_a);

  perform test.expect_error(
    $$select * from app.invite_member('new.person@example.test', 'Again', 'analyst')$$,
    'already a member of this workspace as approver', 'inviting a member again is refused by name');
  perform test.expect_error(
    $$select * from app.invite_member('not-an-address', 'X', 'analyst')$$,
    'not an email address', 'an address that is not one is refused');
  perform test.expect_error(
    $$select * from app.invite_member('bad@example.test', 'X', 'superuser')$$,
    'invalid input value for enum', 'a role that is not a role is refused');
  perform test.expect_error(
    format('select * from app.invite_member(%L, %L, %L)', 'long@example.test', repeat('n', 201), 'analyst'),
    'at most 200', 'a name over 200 characters is refused');

  reset role;
  insert into users (email) values ('twin@example.test'), ('TWIN@example.test');
  set role app_rw;
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    $$select * from app.invite_member('Twin@Example.Test', 'Twin', 'analyst')$$,
    'more than one user answers', 'an address two rows answer to is refused, not picked between');

  -- =========================================================================
  -- A workspace always has an owner
  -- =========================================================================
  perform test.expect_error(
    format('select app.change_member_role(%L, %L)', owner_a, 'approver'),
    'that would leave teama with no owner', 'the last owner cannot demote themselves');
  perform test.expect_error(
    format('select app.remove_member(%L)', owner_a),
    'that would leave teama with no owner', 'nor remove themselves');
  -- Nor by a raw write, which the policy alone would allow an owner.
  perform test.expect_error(
    format('update memberships set role = %L where org_id = %L and user_id = %L', 'analyst', org_a, owner_a),
    'no owner', 'a raw demotion of the last owner is refused by the trigger');
  perform test.expect_error(
    format('delete from memberships where org_id = %L and user_id = %L', org_a, owner_a),
    'no owner', 'and a raw delete of them');
  reset role;
  perform test.expect_error(
    format('delete from memberships where org_id = %L and role = %L', org_a, 'owner'),
    'no owner', 'even the table owner cannot leave a workspace without one');
  set role app_rw;
  perform test.as_member(org_a, owner_a);

  -- With a second owner, the first may step down.
  was := app.change_member_role(approver_a, 'owner');
  perform test.ok(was = 'approver', 'promoting returns the role it was');
  second_owner := approver_a;
  was := app.change_member_role(owner_a, 'approver');
  perform test.ok(was = 'owner', 'with another owner, an owner may step down');
  perform test.as_member(org_a, second_owner);
  was := app.change_member_role(owner_a, 'owner');
  perform test.ok(was = 'approver', 'and be made owner again by the other');
  was := app.change_member_role(owner_a, 'owner');
  perform test.ok(was = 'owner', 'an unchanged role is a no-op');

  -- =========================================================================
  -- What acts as a person, and two writers
  -- =========================================================================
  reset role;
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_a, 'qbo', 'realm-team-a', second_owner);
  set role app_rw;
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format('select app.change_member_role(%L, %L)', second_owner, 'approver'),
    'QuickBooks connection', 'the member a ledger connection runs as cannot be demoted below owner');
  perform test.expect_error(
    format('select app.remove_member(%L)', second_owner),
    'QuickBooks connection', 'nor removed');
  reset role;
  update accounting_connections set enabled = false where org_id = org_a;
  set role app_rw;
  perform test.as_member(org_a, owner_a);

  perform test.as_member(org_a, second_owner);
  insert into inbound_addresses (org_id, created_by) values (org_a, second_owner);
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format('select app.change_member_role(%L, %L)', second_owner, 'read_only'),
    'live email address acts as', 'the member an email address acts as cannot lose writing');
  was := app.change_member_role(second_owner, 'analyst');
  perform test.ok(was = 'owner', 'but may become another writer');
  perform test.expect_error(
    format('select app.remove_member(%L)', second_owner),
    'live email address acts as', 'and cannot be removed');

  -- A: owner_a (owner), second_owner (analyst), analyst_a, invited (approver),
  -- analyst_b (analyst). Remove down to two writers, then the floor holds.
  was := app.remove_member(analyst_b);
  perform test.ok(was = 'analyst', 'removing returns the role held');
  was := app.remove_member(invited);
  perform test.ok(was = 'approver', 'another removal');
  was := app.remove_member(analyst_a);
  perform test.ok(was = 'analyst', 'down to two writers');
  insert into inbound_address_retirements (org_id, address_id, retired_by)
    select org_a, id, owner_a from inbound_addresses where org_id = org_a;
  perform test.expect_error(
    format('select app.change_member_role(%L, %L)', second_owner, 'read_only'),
    'fewer than two people who can write', 'the second writer cannot be demoted to reading');
  perform test.expect_error(
    format('select app.remove_member(%L)', second_owner),
    'fewer than two people who can write', 'nor removed');

  reset role;
  select count(*) into n from users where id in (analyst_b, invited, analyst_a);
  perform test.ok(n = 3, 'removal left every users row in place');
  select count(*) into n from memberships where org_id = org_b and user_id = analyst_b;
  perform test.ok(n = 1, 'and B''s membership of the person removed from A');

  -- =========================================================================
  -- Every act left one audit row naming who, and nothing for the refusals
  -- =========================================================================
  select count(*) into n from audit_log
   where org_id = org_a and action = 'membership.invited' and actor_id = owner_a;
  perform test.ok(n = 2, format('two invitations recorded as owner A (saw %s)', n));
  select count(*) into n from audit_log
   where org_id = org_a and action = 'membership.invited' and subject_id = invited::text
     and payload = jsonb_build_object('role', 'approver', 'users_row', 'created');
  perform test.ok(n = 1, 'the new person''s row says created');
  select count(*) into n from audit_log
   where org_id = org_a and action = 'membership.role_changed';
  perform test.ok(n = 4, format('four role changes, the no-op not among them (saw %s)', n));
  select count(*) into n from audit_log
   where org_id = org_a and action = 'membership.role_changed' and actor_id = second_owner
     and subject_id = owner_a::text and payload = '{"from": "approver", "to": "owner"}'::jsonb;
  perform test.ok(n = 1, 'the re-promotion names the second owner as actor');
  select count(*) into n from audit_log where org_id = org_a and action = 'membership.removed';
  perform test.ok(n = 3, format('three removals (saw %s)', n));
  select count(*) into n from audit_log where org_id = org_b and action like 'membership.%';
  perform test.ok(n = 0, 'nothing was recorded in B');

  -- =========================================================================
  -- Is this address invited? — the sign-in form's one bit (ADR 0051 §6)
  -- =========================================================================
  insert into users (email) values ('lonely-31@example.test');
  insert into memberships (org_id, user_id, role)
    select org_b, id, 'read_only' from users where email = 'twin@example.test';
  set role app_rw;

  perform set_config('request.jwt.claims', json_build_object('sub', owner_a::text)::text, true);
  perform test.expect_error(
    $$select app.address_is_invited('teama-owner@example.test')$$,
    'takes no claims', 'the invited-address question is refused to a subject');
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    $$select app.address_is_invited('teama-owner@example.test')$$,
    'takes no claims', 'and to a member acting for a tenant');

  perform test.as_nobody();
  perform test.ok(app.address_is_invited('teama-owner@example.test'),
    'with no claims: a member''s address is invited');
  perform test.ok(app.address_is_invited('  TeamA-Owner@Example.TEST '),
    'ignoring capitals and surrounding spaces');
  perform test.ok(not app.address_is_invited('teamb-analyst@example.test'),
    'a person who has already signed in is not: their account exists, and another could never link');
  perform test.ok(not app.address_is_invited('new.person@example.test'),
    'a person removed from their only workspace is not');
  perform test.ok(not app.address_is_invited('lonely-31@example.test'),
    'a users row with no membership is not an invitation');
  perform test.ok(not app.address_is_invited('twin@example.test'),
    'an address two rows answer to is not, even when one has a membership');
  perform test.ok(not app.address_is_invited('stranger-31@example.test'),
    'a stranger is not');
  perform test.ok(not app.address_is_invited('') and not app.address_is_invited(null),
    'nor is nothing');
  reset role;

  -- =========================================================================
  -- The provider's hook asks the same question, as supabase_auth_admin
  -- =========================================================================
  perform test.ok(has_function_privilege('supabase_auth_admin',
      'hooks.before_user_created(jsonb)', 'execute')
    and has_schema_privilege('supabase_auth_admin', 'hooks', 'usage'),
    'supabase_auth_admin may call the hook');
  perform test.ok(not has_schema_privilege('supabase_auth_admin', 'app', 'usage'),
    'and has no usage on app');
  perform test.ok(not has_function_privilege('app_rw', 'hooks.before_user_created(jsonb)', 'execute')
    and not has_function_privilege('app_ro', 'hooks.before_user_created(jsonb)', 'execute')
    and not has_function_privilege('public', 'hooks.before_user_created(jsonb)', 'execute'),
    'the app roles and PUBLIC may not');
  perform test.ok(not has_schema_privilege('anon', 'hooks', 'usage')
    and not has_schema_privilege('authenticated', 'hooks', 'usage')
    and not has_schema_privilege('service_role', 'hooks', 'usage'),
    'no request role can reach the hooks schema');

  -- The harness is a schema of its own; lend it to the provider's role for this
  -- transaction only (rolled back with everything else).
  grant usage on schema test to supabase_auth_admin;
  grant execute on all functions in schema test to supabase_auth_admin;
  perform test.as_nobody();
  set role supabase_auth_admin;
  perform test.ok(
    hooks.before_user_created('{"metadata": {"name": "before-user-created"},
                                "user": {"email": "teama-owner@example.test"}}'::jsonb) = '{}'::jsonb,
    'an invited address: {} lets the provider create the account');
  perform test.ok(
    hooks.before_user_created('{"user": {"email": "TEAMA-OWNER@example.test"}}'::jsonb) = '{}'::jsonb,
    'in any capitals');
  perform test.ok(
    hooks.before_user_created('{"user": {"email": "stranger-31@example.test"}}'::jsonb)
      = '{"error": {"http_code": 403, "message": "Accounts are created by invitation only."}}'::jsonb,
    'a stranger: an error with a message, which the provider answers with 403');
  perform test.ok(
    hooks.before_user_created('{"user": {"email": "lonely-31@example.test"}}'::jsonb) ? 'error'
    and hooks.before_user_created('{"user": {"email": "twin@example.test"}}'::jsonb) ? 'error'
    and hooks.before_user_created('{"user": {"email": "new.person@example.test"}}'::jsonb) ? 'error',
    'no membership, two rows, or removed from their only workspace: refused');
  perform test.ok(
    hooks.before_user_created('{"user": {"phone": "15555550100"}}'::jsonb) ? 'error'
    and hooks.before_user_created('{"user": {}}'::jsonb) ? 'error'
    and hooks.before_user_created('{}'::jsonb) ? 'error',
    'no email at all (a phone, anonymous, an empty event): refused');
  perform test.expect_error(
    $$select app.address_is_invited('teama-owner@example.test')$$,
    'permission denied', 'supabase_auth_admin cannot ask app''s own functions');
  perform set_config('request.jwt.claims', json_build_object('sub', owner_a::text)::text, true);
  perform test.expect_error(
    $$select hooks.before_user_created('{"user": {"email": "teama-owner@example.test"}}'::jsonb)$$,
    'takes no claims', 'and the hook refuses a caller carrying a claim');
  reset role;

  set role app_rw;
  perform test.as_nobody();
  perform test.expect_error(
    $$select hooks.before_user_created('{"user": {"email": "teama-owner@example.test"}}'::jsonb)$$,
    'permission denied', 'app_rw cannot call the hook');
  reset role;
end
$test$;
rollback;
