\echo '-- 09 signing in resolves a tenant, and only their own'
begin;
do $test$
declare
  ids jsonb; other_ids jsonb;
  org uuid; analyst uuid; other_org uuid; other_analyst uuid;
  auth_a uuid := gen_random_uuid();
  auth_b uuid := gen_random_uuid();
  auth_thief uuid := gen_random_uuid();
  resolved uuid;
  n int;
begin
  ids := test.seed_org('signin');
  org := (ids->>'org')::uuid; analyst := (ids->>'analyst')::uuid;
  other_ids := test.seed_org('signinother');
  other_org := (other_ids->>'org')::uuid;
  other_analyst := (other_ids->>'analyst')::uuid;

  set role app_rw;

  -- First sign-in links the invited row. Claims are irrelevant here: the server
  -- has verified a session but does not yet know who this is in our terms.
  perform test.as_nobody();
  resolved := app.link_auth_user(auth_a, 'signin-analyst@example.test');
  perform test.ok(resolved = analyst, 'first sign-in links the invited user');

  -- Idempotent: the common path signs in again and nothing changes.
  resolved := app.link_auth_user(auth_a, 'signin-analyst@example.test');
  perform test.ok(resolved = analyst, 'signing in again resolves to the same user');

  -- The address is not the identity. A second subject asserting the same address
  -- would be taking over the account.
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', auth_thief, 'signin-analyst@example.test'),
    'already linked to another identity',
    'a second identity cannot claim an account that is already linked');

  -- An authenticated stranger is still a stranger: no invitation, no tenant.
  perform test.expect_error(
    format('select app.link_auth_user(%L, %L)', auth_b, 'nobody-invited@example.test'),
    'no invitation',
    'a verified session with no invitation resolves to nothing');

  -- Case-insensitive on the address, because mail is.
  resolved := app.link_auth_user(auth_b, 'SIGNINOTHER-ANALYST@EXAMPLE.TEST');
  perform test.ok(resolved = other_analyst, 'the invited address matches case-insensitively');

  -- The bootstrap case, and the whole reason my_orgs() is a definer function:
  -- a session that has verified a subject but does not yet know the tenant. The
  -- read policy on memberships is `org_id = app.current_org_id()`, which is the
  -- value we are asking for, so an invoker function returns nothing here and the
  -- app can never get past the login screen.
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', analyst::text)::text, false);
  select count(*) into n from app.my_orgs();
  perform test.ok(n = 1, 'a subject with no tenant claim yet can still find their tenant');
  perform test.ok(
    (select o.org_id from app.my_orgs() o) = org,
    'and it is the right one, before any org claim is set');
  select count(*) into n from memberships;
  perform test.ok(n = 0,
    'while memberships itself still reads as nothing without an org claim');

  -- my_orgs() answers for whoever the claims name, and for nobody else.
  perform test.as_member(org, analyst);
  select count(*) into n from app.my_orgs();
  perform test.ok(n = 1, 'a member sees exactly their own tenant');
  perform test.ok(
    (select o.org_id from app.my_orgs() o) = org,
    'and it is the right one');
  perform test.ok(
    (select o.role from app.my_orgs() o) = 'analyst',
    'with the role that decides what they may do');

  -- The point of taking no argument: the other tenant's analyst is not
  -- enumerable from this session, whatever it asks.
  perform test.as_member(other_org, other_analyst);
  perform test.ok(
    (select o.org_id from app.my_orgs() o) = other_org,
    'another member sees their own tenant, not the first');

  -- A session with no subject at all gets nothing, rather than everything —
  -- a definer function with a missing claim is how that goes wrong.
  perform test.as_nobody();
  select count(*) into n from app.my_orgs();
  perform test.ok(n = 0, 'a session with no subject sees no tenants');

  -- And the definer functions have not made the tables themselves readable.
  perform test.as_member(org, analyst);
  select count(*) into n from memberships;
  perform test.ok(n = 2, 'memberships is still tenant-scoped (the seed has two)');

  reset role;
end
$test$;
rollback;
