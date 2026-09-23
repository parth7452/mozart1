\echo '-- 29 sign-in and the fan-out refuse callers they were not written for (ADR 0045)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid;
  b jsonb; org_b uuid; analyst_b uuid;
  auth_a uuid := gen_random_uuid();
  auth_b uuid := gen_random_uuid();
  auth_twin uuid := gen_random_uuid();
  resolved uuid;
  n int;
  fn record;
begin
  a := test.seed_org('refusestrangersa');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  b := test.seed_org('refusestrangersb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  -- One enabled connection per org, so the fan-out has something to list across
  -- the tenant boundary. Written as the table owner: who may connect a ledger
  -- is suite 26's question, not this one's.
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_a, 'qbo', 'realm-refuse-a', analyst_a),
           (org_b, 'qbo', 'realm-refuse-b', analyst_b);

  -- =========================================================================
  -- Their shape, from the catalogue: still definer, still pinned, same result,
  -- still EXECUTE for app_rw and nobody else it did not have before
  -- =========================================================================
  for fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig, p.provolatile,
           pg_get_function_result(p.oid) as result, l.lanname
      from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where s.nspname = 'app' and p.proname in ('ledger_connections_to_sync', 'link_auth_user')
  loop
    perform test.ok(fn.prosecdef, format('app.%s is still security definer', fn.proname));
    perform test.ok(
      coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false),
      format('app.%s still pins search_path = pg_catalog, public, extensions (%s)',
             fn.proname, fn.proconfig));
    perform test.ok(fn.lanname = 'plpgsql', format('app.%s is still plpgsql', fn.proname));
    perform test.ok(not has_function_privilege('public', fn.oid, 'execute'),
      format('PUBLIC still may not execute app.%s', fn.proname));
    perform test.ok(has_function_privilege('app_rw', fn.oid, 'execute'),
      format('app_rw still may execute app.%s', fn.proname));
    perform test.ok(not has_function_privilege('app_ro', fn.oid, 'execute'),
      format('app_ro still may not execute app.%s', fn.proname));
    if fn.proname = 'ledger_connections_to_sync' then
      perform test.ok(fn.provolatile = 's', 'the fan-out list is still stable');
      perform test.ok(
        fn.result = 'TABLE(connection_id uuid, org_id uuid, provider text, created_by uuid)',
        format('the fan-out list still returns its four id-shaped columns (%s)', fn.result));
    else
      perform test.ok(fn.provolatile = 'v', 'link_auth_user is still volatile: it writes');
      perform test.ok(fn.result = 'uuid', format('link_auth_user still returns a uuid (%s)', fn.result));
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.proname in ('ledger_connections_to_sync', 'link_auth_user');
  perform test.ok(n = 2, format('exactly one of each, no stray overload (saw %s)', n));

  set role app_rw;

  -- =========================================================================
  -- The fan-out list
  -- =========================================================================
  -- A subject with no org is the shape of a Supabase Data API request. Before
  -- 0033 this was the caller the guard let through.
  perform set_config('request.jwt.claims',
    json_build_object('sub', analyst_a::text)::text, true);
  perform test.expect_error(
    'select count(*) from app.ledger_connections_to_sync()',
    'untenanted', 'the fan-out list is refused to a subject with no org');

  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    'select count(*) from app.ledger_connections_to_sync()',
    'untenanted', 'and still to a caller acting for a tenant');

  -- An org claim with no subject is not a shape any path sets, and is refused
  -- all the same.
  perform set_config('request.jwt.claims',
    json_build_object('org_id', org_a::text)::text, true);
  perform test.expect_error(
    'select count(*) from app.ledger_connections_to_sync()',
    'untenanted', 'and to an org claim with no subject');

  -- The one caller it is for: no claims at all, the way the cron sets it up.
  perform test.as_nobody();
  select count(*) into n from app.ledger_connections_to_sync() c
   where c.org_id in (org_a, org_b);
  perform test.ok(n = 2,
    format('with no claims it still lists both orgs'' connections (saw %s)', n));

  -- The empty string is what a transaction-local claim leaves behind once its
  -- transaction ends, and what the store sets to clear one. It is no claim.
  perform set_config('request.jwt.claims', '', true);
  select count(*) into n from app.ledger_connections_to_sync() c
   where c.org_id in (org_a, org_b);
  perform test.ok(n = 2, format('and so with a cleared claim (saw %s)', n));

  -- =========================================================================
  -- First sign-in
  -- =========================================================================
  -- A subject with no org: a Data API caller trying to pair an invitation that
  -- has not been claimed yet with an identity of its choosing. The row must be
  -- left exactly as it was.
  perform set_config('request.jwt.claims',
    json_build_object('sub', analyst_b::text)::text, true);
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', auth_a, 'refusestrangersa-analyst@example.test'),
    'takes no claims', 'link_auth_user is refused to a subject with no org');

  perform test.as_member(org_b, analyst_b);
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', auth_a, 'refusestrangersa-analyst@example.test'),
    'takes no claims', 'and to a caller acting for a tenant');

  perform set_config('request.jwt.claims',
    json_build_object('org_id', org_b::text)::text, true);
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', auth_a, 'refusestrangersa-analyst@example.test'),
    'takes no claims', 'and to an org claim with no subject');

  reset role;
  select count(*) into n from users where id = analyst_a and auth_user_id is not null;
  perform test.ok(n = 0, 'none of the refused calls linked the invitation');
  set role app_rw;

  -- The one caller it is for: resolveSession, before it has set any claim.
  perform test.as_nobody();
  resolved := app.link_auth_user(auth_a, 'RefuseStrangersA-Analyst@Example.TEST');
  perform test.ok(resolved = analyst_a,
    'with no claims it still links the invited user, case-insensitively');
  resolved := app.link_auth_user(auth_a, 'refusestrangersa-analyst@example.test');
  perform test.ok(resolved = analyst_a, 'and signing in again still resolves to the same user');

  -- The messages the web app and the store tests key on are unchanged.
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', gen_random_uuid(), 'nobody-invited-29@example.test'),
    'no invitation for', 'a stranger is still refused as uninvited');
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', gen_random_uuid(), 'refusestrangersa-analyst@example.test'),
    'already linked to another identity', 'a second identity is still refused');

  -- =========================================================================
  -- Two addresses that differ only in case are refused, not picked between
  -- =========================================================================
  reset role;
  insert into users (email, full_name) values ('RefuseStrangersA-Approver@example.test', 'Twin');
  set role app_rw;
  perform test.as_nobody();
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', auth_twin, 'refusestrangersa-approver@example.test'),
    'more than one user answers to', 'an address two users answer to is refused');

  reset role;
  select count(*) into n from users
   where lower(email) = 'refusestrangersa-approver@example.test' and auth_user_id is not null;
  perform test.ok(n = 0, 'and neither of the two rows was linked');

  -- A person who has signed in before never reaches that check: the fast path
  -- is by auth_user_id, which is unique. Link org B's analyst while the address
  -- is unambiguous, then add a case-variant twin, and they still sign in.
  set role app_rw;
  perform test.as_nobody();
  resolved := app.link_auth_user(auth_b, 'refusestrangersb-analyst@example.test');
  perform test.ok(resolved = analyst_b, 'org B''s analyst links while the address is unambiguous');
  reset role;
  insert into users (email, full_name) values ('REFUSESTRANGERSB-ANALYST@example.test', 'Twin');
  set role app_rw;
  perform test.as_nobody();
  resolved := app.link_auth_user(auth_b, 'refusestrangersb-analyst@example.test');
  perform test.ok(resolved = analyst_b,
    'and once linked still signs in after a case-variant twin appears');

  reset role;
end
$test$;
rollback;
