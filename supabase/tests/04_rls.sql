\echo '-- 04 tenant isolation (RLS is the authorisation layer)'
begin;
do $test$
declare
  a jsonb; b jsonb; org_a uuid; org_b uuid;
begin
  a := test.seed_org('tenant-a');
  b := test.seed_org('tenant-b');
  org_a := (a->>'org')::uuid; org_b := (b->>'org')::uuid;

  set role app_rw;

  perform test.as_member(org_a, (a->>'analyst')::uuid);
  perform test.ok((select count(*) from deductions) = 1, 'a tenant sees only its own deductions');
  perform test.ok((select count(*) from deductions where org_id = org_b) = 0,
    'naming another org_id explicitly still returns nothing');
  perform test.ok((select count(*) from decisions) = 1, 'decisions are tenant-scoped');
  perform test.ok((select count(*) from organizations) = 1, 'organizations are self-scoped');
  perform test.ok((select count(*) from users) = 2, 'users are visible only through shared membership');

  -- WITH CHECK stops a tenant writing into another tenant's rows.
  perform test.expect_error(format(
    'insert into deductions (org_id, claim_id, deduction_amount_cents)
       values (%L, ''SMUGGLED'', 1000)', org_b),
    'row-level security', 'a tenant cannot insert rows owned by another tenant');

  perform test.expect_error(format(
    'insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values (%L, %L, ''case.discovered'', ''{}''::jsonb, now())',
    org_b, (b->>'deduction')::uuid),
    'row-level security', 'append-only tables are tenant-scoped too');

  perform test.as_member(org_b, (b->>'analyst')::uuid);
  perform test.ok((select count(*) from deductions) = 1, 'the other tenant sees only its own row');
  perform test.ok((select claim_id from deductions) = 'CLAIM-tenant-b', 'and it is the right row');

  -- No claims at all (unauthenticated) means no rows.
  perform test.as_nobody();
  perform test.ok((select count(*) from deductions) = 0, 'no claims, no data');
  perform test.ok((select count(*) from organizations) = 0, 'no claims, no orgs');

  reset role;
end
$test$;
rollback;
