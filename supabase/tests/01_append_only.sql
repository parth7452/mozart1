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

-- The portal tables (migration 0038, ADR 0057 §15): six append-only tables,
-- the run-start table among them, each with a row in it, refused an UPDATE, a
-- DELETE and a TRUNCATE by app_rw's grants and, for the owner, by the trigger.
-- The registry, portal_connections, is not one of them: `enabled` flips.
do $portal$
declare
  ids jsonb; org uuid; owner_id uuid;
  conn uuid; ver uuid; run uuid; upl uuid; doc uuid;
  -- One-per-account is across every org, and a used database keeps rows.
  account text := 'AN' || lpad((floor(random() * 1e11))::bigint::text, 11, '0') || '-T';
  effective date := (now() at time zone 'utc')::date - 1;
  t text;
  n int;
  six constant text[] := array[
    'portal_credentials', 'portal_recipe_versions', 'portal_recipe_reviews',
    'portal_read_starts', 'portal_read_runs', 'portal_captures'];
begin
  ids := test.seed_org('appendonlyportal');
  org := (ids->>'org')::uuid;
  insert into users (email, full_name) values ('appendonlyportal-owner@example.test', 'Owner')
    returning id into owner_id;
  insert into memberships (org_id, user_id, role) values (org, owner_id, 'owner');

  set role app_rw;
  perform test.as_member(org, owner_id);

  insert into portal_connections (org_id, portal_key, label, account_id, created_by)
    values (org, 'sap_business_network', 'Append-only', account, owner_id)
    returning id into conn;
  insert into portal_credentials
    (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
     sign_in_origin, sign_in_paths, hosts_hash, created_by)
    values (org, conn, 'aws-kms+aes-256-gcm', 'arn:aws:kms:us-east-1:1:key/portal', 'd3JhcHBlZA==',
            'c2VhbGVk', 'https://service.ariba.com', array['/sign-in'],
            encode(digest('service.ariba.com', 'sha256'), 'hex'), owner_id);
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org, 'sap_business_network', 1, effective,
            jsonb_build_object('portalKey', 'sap_business_network', 'version', 1,
                               'effectiveFrom', to_char(effective, 'YYYY-MM-DD'),
                               'provenance', jsonb_build_object(
                                 'draftedBy', jsonb_build_object('kind', 'person', 'id', 'founder'))),
            owner_id)
    returning id into ver;
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer)
    values (org, ver, 'promoted', owner_id);
  run := gen_random_uuid();
  perform app.record_portal_read_start(run, org, conn, ver, false, owner_id);
  insert into uploads (org_id, source) values (org, 'portal_fetch') returning id into upl;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org, upl, digest('append-only-portal', 'sha256'), 10, 'text/html', 'portal/append-only')
    returning id into doc;
  insert into portal_captures (org_id, run_id, recipe_version_id, document_id, kind, step_name,
                               page_path, snapshot_rule_version, sha256, captured_at)
    values (org, run, ver, doc, 'page_snapshot', 'capture_landing', '/dashboard', 1,
            encode(digest('append-only-portal', 'sha256'), 'hex'), now());
  perform app.record_portal_read_run(run, org, 'completed', null, null, null, 1, 1, 1, 0, 0,
                                     '[{"step": "capture_landing", "passed": true}]'::jsonb);

  foreach t in array six loop
    perform test.expect_error(format('update %I set org_id = org_id', t), 'denied',
      format('app_rw holds no UPDATE privilege on %s', t));
    perform test.expect_error(format('delete from %I', t), 'denied',
      format('app_rw holds no DELETE privilege on %s', t));
    perform test.expect_error(format('truncate %I', t), 'denied',
      format('app_rw holds no TRUNCATE privilege on %s', t));
  end loop;

  reset role;

  foreach t in array six loop
    perform test.expect_error(format('update %I set org_id = org_id where org_id = %L', t, org),
      'append-only', format('the trigger rejects UPDATE on %s even for the table owner', t));
    perform test.expect_error(format('delete from %I where org_id = %L', t, org),
      'append-only', format('the trigger rejects DELETE on %s even for the table owner', t));
    -- CASCADE, because several of these are referenced, and a plain truncate
    -- of a referenced table is refused by the foreign key before any trigger
    -- fires (suite 14's reasoning).
    perform test.expect_error(format('truncate %I cascade', t),
      'append-only', format('TRUNCATE of %s is blocked even for the table owner', t));
    execute format('select count(*) from %I where org_id = %L', t, org) into n;
    perform test.ok(n = 1, format('and the row in %s is still there (saw %s)', t, n));
  end loop;
end
$portal$;
rollback;
