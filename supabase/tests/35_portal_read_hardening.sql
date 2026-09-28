\echo '-- 35 portal read hardening: a held connection stays off, a capture is its run''s (ADR 0064, migration 0039)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid;
  b jsonb; org_b uuid;
  owner_a uuid; owner_a2 uuid; owner_b uuid;
  -- One-per-account is across every org, and a used database keeps rows.
  digits text := lpad((floor(random() * 1e11))::bigint::text, 11, '0');
  effective date := (now() at time zone 'utc')::date - 1;
  conn uuid; conn_none uuid; conn_turned uuid; conn_b uuid;
  cred_1 uuid; cred_2 uuid;
  ver uuid; ver_b uuid;
  run uuid; run_ended uuid; run_other uuid; run_b uuid;
  upl uuid; doc uuid;
  sha text := encode(digest('portal-hardening', 'sha256'), 'hex');
  n int;
  recipe jsonb;
  ins_cred constant text :=
    'insert into portal_credentials (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
       sign_in_origin, sign_in_paths, hosts_hash, created_by)
     values (%L, %L, ''aws-kms+aes-256-gcm'', ''arn:aws:kms:us-east-1:1:key/portal'', ''d3JhcHBlZA=='',
             ''c2VhbGVk'', ''https://service.ariba.com'', array[''/sign-in''], %L, %L)
     returning id';
  ins_cap constant text :=
    'insert into portal_captures (org_id, run_id, recipe_version_id, document_id, kind, step_name,
       page_path, snapshot_rule_version, sha256, captured_at)
     values (%L, %L, %L, %L, ''page_snapshot'', %L, ''/dashboard'', 1, %L, now())';
  hosts text := encode(digest('service.ariba.com', 'sha256'), 'hex');
begin
  a := test.seed_org('portalharda');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  b := test.seed_org('portalhardb');
  org_b := (b->>'org')::uuid;
  insert into users (email, full_name) values ('portalharda-owner@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('portalharda-owner2@example.test', 'Owner A2')
    returning id into owner_a2;
  insert into users (email, full_name) values ('portalhardb-owner@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role) values
    (org_a, owner_a, 'owner'), (org_a, owner_a2, 'owner'), (org_b, owner_b, 'owner');
  recipe := jsonb_build_object('portalKey', 'sap_business_network', 'version', 1,
                               'effectiveFrom', to_char(effective, 'YYYY-MM-DD'),
                               'provenance', jsonb_build_object(
                                 'draftedBy', jsonb_build_object('kind', 'person', 'id', 'founder')));

  set role app_rw;
  perform test.as_member(org_a, owner_a);

  -- =========================================================================
  -- A. A held connection stays off until a newer credential is stored (§8)
  -- =========================================================================
  insert into portal_connections (org_id, portal_key, label, account_id, created_by)
    values (org_a, 'sap_business_network', 'Held', 'AN' || digits || '-H1', owner_a)
    returning id into conn;
  execute format(ins_cred, org_a, conn, hosts, owner_a) into cred_1;

  -- The job's refused sign-in: off, with the audit row naming the credential.
  update portal_connections set enabled = false where id = conn;
  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org_a, owner_a, 'portal_connection.disabled', 'portal_connections', conn::text,
            jsonb_build_object('reason', 'credential_rejected', 'credential_id', cred_1::text));

  perform test.expect_error(format('update portal_connections set enabled = true where id = %L', conn),
    'portal connection enable blocked', 'an owner cannot turn a connection on whose credential was refused');
  update portal_connections set label = 'Held, relabelled' where id = conn;
  perform test.ok((select label = 'Held, relabelled' and not enabled from portal_connections where id = conn),
    'a held connection can still be relabelled, and stays off');

  -- A later turn-off holds nothing and lifts nothing.
  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org_a, owner_a, 'portal_connection.disabled', 'portal_connections', conn::text,
            jsonb_build_object('reason', 'turned_off'));
  perform test.expect_error(format('update portal_connections set enabled = true where id = %L', conn),
    'portal connection enable blocked', 'a turn-off recorded after a refusal does not hide the hold');

  reset role;
  perform test.expect_error(format('update portal_connections set enabled = true where id = %L', conn),
    'portal connection enable blocked', 'nor can the table owner, with no claims: the trigger answers for every role');
  set role app_rw;
  perform test.as_member(org_a, owner_a);

  -- Only a newer credential lifts it.
  execute format(ins_cred, org_a, conn, hosts, owner_a) into cred_2;
  update portal_connections set enabled = true where id = conn;
  perform test.ok((select enabled from portal_connections where id = conn),
    'a newer credential lifts the hold, and the owner turns the connection back on');
  update portal_connections set enabled = false where id = conn;
  update portal_connections set enabled = true where id = conn;
  perform test.ok((select enabled from portal_connections where id = conn),
    'turning a connection off and on with no hold on its credential is not refused');

  -- A removal while no credential was ever stored names none, and holds.
  insert into portal_connections (org_id, portal_key, label, account_id, created_by, enabled)
    values (org_a, 'sap_business_network', 'None stored', 'AN' || digits || '-H2', owner_a, false)
    returning id into conn_none;
  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org_a, owner_a, 'portal_connection.disabled', 'portal_connections', conn_none::text,
            jsonb_build_object('reason', 'credential_removed'));
  perform test.expect_error(format('update portal_connections set enabled = true where id = %L', conn_none),
    'portal connection enable blocked', 'a removal with nothing stored holds the connection off too');
  execute format(ins_cred, org_a, conn_none, hosts, owner_a) into cred_1;
  update portal_connections set enabled = true where id = conn_none;
  perform test.ok((select enabled from portal_connections where id = conn_none),
    'and the first credential stored lifts it');

  -- A plain turn-off holds nothing.
  insert into portal_connections (org_id, portal_key, label, account_id, created_by, enabled)
    values (org_a, 'sap_business_network', 'Turned off', 'AN' || digits || '-H3', owner_a, false)
    returning id into conn_turned;
  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org_a, owner_a, 'portal_connection.disabled', 'portal_connections', conn_turned::text,
            jsonb_build_object('reason', 'turned_off'));
  update portal_connections set enabled = true where id = conn_turned;
  perform test.ok((select enabled from portal_connections where id = conn_turned),
    'a connection an owner only turned off is turned back on');

  -- Another tenant's hold, naming this connection's id, is not this tenant's.
  perform test.as_member(org_b, owner_b);
  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
    values (org_b, owner_b, 'portal_connection.disabled', 'portal_connections', conn_turned::text,
            jsonb_build_object('reason', 'credential_removed'));
  perform test.as_member(org_a, owner_a);
  update portal_connections set enabled = false where id = conn_turned;
  update portal_connections set enabled = true where id = conn_turned;
  perform test.ok((select enabled from portal_connections where id = conn_turned),
    'an audit row in another org holds nothing here');

  -- =========================================================================
  -- B. A capture is written by its run, while it runs (§15)
  -- =========================================================================
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_a, 'sap_business_network', 1, effective, recipe, owner_a)
    returning id into ver;
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer)
    values (org_a, ver, 'promoted', owner_a);

  run := gen_random_uuid();
  perform app.record_portal_read_start(run, org_a, conn, ver, false, owner_a);
  insert into uploads (org_id, source) values (org_a, 'portal_fetch') returning id into upl;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org_a, upl, digest('portal-hardening', 'sha256'), 16, 'text/html', 'portal/hardening')
    returning id into doc;

  -- Another owner of the org, and a writer, are not the member the run acts as.
  perform test.as_member(org_a, owner_a2);
  perform test.expect_error(format(ins_cap, org_a, run, ver, doc, 'landing', sha),
    'row-level security', 'another owner of the workspace writes no capture for a run it did not start');
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(format(ins_cap, org_a, run, ver, doc, 'landing', sha),
    'row-level security', 'nor does a writer of the workspace');

  perform test.as_member(org_a, owner_a);
  execute format(ins_cap, org_a, run, ver, doc, 'landing', sha);
  perform test.ok(true, 'the member the run acts as writes its capture while it runs');
  perform test.expect_error(format(ins_cap, org_a, gen_random_uuid(), ver, doc, 'landing', sha),
    'row-level security', 'a capture naming no run is refused');

  perform app.record_portal_read_run(run, org_a, 'completed', null, null, null, 1, 1, 1, 0, 0,
                                     '[{"step": "landing", "passed": true}]'::jsonb);
  perform test.expect_error(format(ins_cap, org_a, run, ver, doc, 'landing_again', sha),
    'row-level security', 'a run that has ended takes no further capture');
  select count(*) into n from portal_captures where run_id = run;
  perform test.ok(n = 1, format('the ended run keeps the one capture it wrote (saw %s)', n));

  -- The consistency trigger still answers first-class refusals by name.
  run_other := gen_random_uuid();
  perform app.record_portal_read_start(run_other, org_a, conn, ver, true, owner_a);
  perform test.expect_error(format(ins_cap, org_a, run_other, ver, doc, 'landing', sha),
    'dry run captures nothing', 'a dry run still captures nothing');

  -- Another tenant's run is not this tenant's to capture for.
  perform test.as_member(org_b, owner_b);
  insert into portal_connections (org_id, portal_key, label, account_id, created_by)
    values (org_b, 'sap_business_network', 'B', 'AN' || digits || '-HB', owner_b)
    returning id into conn_b;
  insert into portal_recipe_versions (org_id, portal_key, version, effective_from, recipe, created_by)
    values (org_b, 'sap_business_network', 1, effective, recipe, owner_b)
    returning id into ver_b;
  insert into portal_recipe_reviews (org_id, recipe_version_id, verdict, reviewer)
    values (org_b, ver_b, 'promoted', owner_b);
  run_b := gen_random_uuid();
  perform app.record_portal_read_start(run_b, org_b, conn_b, ver_b, false, owner_b);
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(format(ins_cap, org_a, run_b, ver, doc, 'landing', sha),
    'row-level security', 'a capture for another workspace''s run is refused');

  -- =========================================================================
  -- C. The catalogue
  -- =========================================================================
  reset role;
  perform test.ok(
    (select proconfig @> array['search_path=pg_catalog, public, extensions'] and not prosecdef
       from pg_proc where oid = 'app.portal_connection_enable_is_not_held()'::regprocedure),
    'the hold trigger''s function is pinned and runs as its caller');
  perform test.ok(not has_function_privilege('public', 'app.portal_connection_enable_is_not_held()', 'EXECUTE'),
    'and PUBLIC may not execute it');
  perform test.ok(
    not has_any_column_privilege('app_rw', 'portal_captures', 'UPDATE')
    and not has_table_privilege('app_rw', 'portal_captures', 'DELETE')
    and not has_table_privilege('app_rw', 'portal_captures', 'TRUNCATE'),
    'portal_captures is still append-only for app_rw');
end
$test$;
rollback;
