\echo '-- 22 an operator command connects as the app: one bounded lookup, refused to anyone with a claim'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid;
  b jsonb; org_b uuid;
  r record; n int; secdef boolean; cfg text[]; public_exec boolean;
begin
  a := test.seed_org('operatorlinka');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  b := test.seed_org('operatorlinkb');
  org_b := (b->>'org')::uuid;

  -- =========================================================================
  -- Its shape, read from the catalogue
  -- =========================================================================
  select p.prosecdef, p.proconfig into secdef, cfg
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.proname = 'member_for_link';
  perform test.ok(secdef, 'app.member_for_link is security definer');
  perform test.ok(cfg is not null and exists (select 1 from unnest(cfg) c where c like 'search_path=%'),
    'and pins its search_path');

  select has_function_privilege('public', 'app.member_for_link(text, text)', 'execute')
    into public_exec;
  perform test.ok(not public_exec, 'PUBLIC may not execute it');
  perform test.ok(has_function_privilege('app_rw', 'app.member_for_link(text, text)', 'execute'),
    'app_rw may');
  perform test.ok(not has_function_privilege('app_ro', 'app.member_for_link(text, text)', 'execute'),
    'app_ro may not: the commands that need it all write');

  -- =========================================================================
  -- As app_rw with no claims: the three answers the commands tell apart
  -- =========================================================================
  set role app_rw;
  perform test.as_nobody();

  -- The circularity ADR 0034 option (b) names: with no claims, RLS shows the
  -- caller no organization at all, so the slug cannot be looked up that way.
  select count(*) into n from organizations where slug = 'operatorlinka';
  perform test.ok(n = 0, format('under RLS with no claims the org is invisible (saw %s)', n));

  select * into r from app.member_for_link('operatorlinka', 'OperatorLinkA-Analyst@Example.TEST');
  perform test.ok(r.org_id = org_a and r.user_id = analyst_a and r.role = 'analyst',
    'a member is found by slug and case-insensitive email, with their role');

  select count(*) into n from app.member_for_link('no-such-org', 'operatorlinka-analyst@example.test');
  perform test.ok(n = 0, 'an unknown slug returns no row');

  select * into r from app.member_for_link('operatorlinkb', 'operatorlinka-analyst@example.test');
  perform test.ok(r.org_id = org_b and r.user_id is null and r.role is null,
    'a member of another org is not a member here: org id, and no user');

  select * into r from app.member_for_link('operatorlinka', 'nobody@example.test');
  perform test.ok(r.org_id = org_a and r.user_id is null, 'an unknown address is no member');

  perform test.expect_error(
    $$select * from app.member_for_link('', 'x@example.test')$$,
    'needs a slug', 'a blank slug is refused');

  -- =========================================================================
  -- Two addresses that differ only in case are refused, not picked between
  -- =========================================================================
  reset role;
  insert into users (email, full_name) values ('OPERATORLINKA-ANALYST@example.test', 'Twin');
  insert into memberships (org_id, user_id, role)
    select org_a, id, 'read_only' from users where email = 'OPERATORLINKA-ANALYST@example.test';
  set role app_rw;
  perform test.as_nobody();
  perform test.expect_error(
    $$select * from app.member_for_link('operatorlinka', 'operatorlinka-analyst@example.test')$$,
    'more than one member', 'an address two members answer to is refused');

  -- =========================================================================
  -- Any claim at all is a request path, and is refused
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    $$select * from app.member_for_link('operatorlinkb', 'operatorlinkb-analyst@example.test')$$,
    'takes no claims', 'a caller acting for a tenant is refused');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', analyst_a::text)::text, false);
  perform test.expect_error(
    $$select * from app.member_for_link('operatorlinkb', 'operatorlinkb-analyst@example.test')$$,
    'takes no claims', 'and so is a signed-in subject with no org yet');

  perform test.as_nobody();
  reset role;
end
$test$;
rollback;
