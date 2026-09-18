\echo '-- 01 append-only truth + hash chains'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; usr uuid;
  h1 bytea; h2 bytea; p2 bytea; ev1 bigint; ev2 bigint;
begin
  ids := test.seed_org('appendonly');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid; usr := (ids->>'analyst')::uuid;

  set role app_rw;
  perform test.as_member(org, usr);

  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org, ded, 'case.discovered', '{"source":"email_in"}'::jsonb, now(), usr)
    returning id, row_hash into ev1, h1;
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org, ded, 'case.classified', '{"canonical_reason_code":"shortage_quantity"}'::jsonb, now(), usr)
    returning id, prev_hash, row_hash into ev2, p2, h2;

  perform test.ok(h1 is not null and h2 is not null, 'events are hashed on insert');
  perform test.ok(p2 = h1, 'each event links to the previous hash');
  perform test.ok(
    h2 = app.row_hash(h1, '{"canonical_reason_code":"shortage_quantity"}'::jsonb),
    'row_hash = sha256(prev_hash || canonical(payload))');
  perform test.ok(
    (select prev_hash from deduction_events where id = ev1) is null,
    'the first event in a chain has no predecessor');

  -- Two layers, tested separately. The application role is stopped by the
  -- missing grant; the trigger is the backstop for any role that does hold
  -- UPDATE/DELETE (the owner, a service role, a future migration).
  perform test.expect_error(
    format('update deduction_events set payload = ''{"tampered":true}''::jsonb where id = %s', ev1),
    'denied', 'app_rw holds no UPDATE privilege on deduction_events');
  perform test.expect_error(
    format('delete from deduction_events where id = %s', ev1),
    'denied', 'app_rw holds no DELETE privilege on deduction_events');
  perform test.expect_error(
    'truncate deduction_events', 'denied', 'app_rw holds no TRUNCATE privilege');

  -- documents hold immutable byte facts; verdicts about them are new rows.
  declare doc uuid;
  begin
    insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
      values (org, digest('bytes', 'sha256'), 4096, 'application/pdf', 'storage://d/1')
      returning id into doc;
    perform test.expect_error(
      format('update documents set storage_ref = ''storage://elsewhere'' where id = %L', doc),
      'denied', 'app_rw cannot rewrite a document row');
    insert into document_scans (org_id, document_id, status, scanner)
      values (org, doc, 'clean', 'clamav');
    insert into document_classifications (org_id, document_id, doc_type, confidence)
      values (org, doc, 'deduction_notice', 0.99);
    perform test.ok(
      (select scan_status = 'clean' and doc_type = 'deduction_notice'
         from document_state where document_id = doc),
      'document_state projects the latest scan + classification');
  end;

  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org, usr, 'case.viewed', 'deductions', ded::text, '{}'::jsonb);
  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org, usr, 'case.viewed', 'deductions', ded::text, '{}'::jsonb);
  perform test.ok(
    (select count(*) from audit_log a where a.org_id = org and a.prev_hash is not null) = 1,
    'audit_log is hash-chained per org');
  perform test.expect_error(
    format('update audit_log set action = ''forged'' where org_id = %L', org),
    'denied', 'app_rw cannot rewrite the audit log');

  reset role;

  -- As the owner (and a superuser) the grants no longer bite, so what is left
  -- is the trigger. This is the layer that protects us from our own migrations
  -- and from a service-role job.
  perform test.expect_error(
    format('update deduction_events set payload = ''{"tampered":true}''::jsonb where id = %s', ev1),
    'append-only', 'the trigger rejects UPDATE even for the table owner');
  perform test.expect_error(
    format('delete from deduction_events where id = %s', ev1),
    'append-only', 'the trigger rejects DELETE even for the table owner');
  perform test.expect_error('truncate deduction_events', 'append-only',
    'TRUNCATE is blocked even for the table owner');
  perform test.expect_error(
    format('update audit_log set action = ''forged'' where org_id = %L', org),
    'append-only', 'the audit log cannot be rewritten by anyone');

  -- Decisions and approvals are written once (0006).
  perform test.expect_error(
    format('update decisions set confidence = 0.10 where id = %L', (ids->>'decision')::uuid),
    'append-only', 'decisions reject UPDATE');
  perform test.ok(
    (select count(*) from deduction_events where org_id = org) = 2,
    'every blocked mutation left the chain intact');
end
$test$;
rollback;
