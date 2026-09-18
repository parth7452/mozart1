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

  -- A view over RLS-protected tables is a second path to those rows, and it
  -- needs its own test: `document_state` read as its owner until it was made
  -- security_invoker, which the table-level tests could never have caught
  -- (ADR 0010).
  declare doc_a uuid;
  begin
    perform test.as_member(org_a, (a->>'analyst')::uuid);
    insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
      values (org_a, digest('tenant-a-doc', 'sha256'), 2048, 'application/pdf', 'storage://a/1')
      returning id into doc_a;
    insert into document_scans (org_id, document_id, status, scanner)
      values (org_a, doc_a, 'clean', 'clamav');
    perform test.ok((select count(*) from document_state) = 1,
      'a tenant sees its own document through the view');

    perform test.as_member(org_b, (b->>'analyst')::uuid);
    perform test.ok((select count(*) from document_state) = 0,
      'the view does not leak another tenant''s documents');
    perform test.ok(
      (select count(*) from document_state where document_id = doc_a) = 0,
      'naming another tenant''s document id through the view returns nothing');
  end;

  -- No claims at all (unauthenticated) means no rows.
  perform test.as_nobody();
  perform test.ok((select count(*) from deductions) = 0, 'no claims, no data');
  perform test.ok((select count(*) from organizations) = 0, 'no claims, no orgs');

  reset role;
end
$test$;
rollback;
