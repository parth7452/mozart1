\echo '-- 23 a ledger anomaly names its invoice: kind and ids, written once and complete, append-only'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid;
  b jsonb; org_b uuid; analyst_b uuid;
  owner_a uuid; owner_b uuid;
  conn_a uuid; conn_b uuid;
  run_two uuid; run_three uuid; run_zero uuid; run_refused uuid; run_b uuid;
  n int; textish int;
  win_from date := (current_date - 34);
  win_to date := current_date;
  two jsonb := '[
    {"kind": "application_to_unknown_invoice", "invoice_external_id": "96", "transaction_external_id": "128"},
    {"kind": "overapplied", "invoice_external_id": "71", "transaction_external_id": null}
  ]';
begin
  a := test.seed_org('ledgeranoma');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid; approver_a := (a->>'approver')::uuid;
  b := test.seed_org('ledgeranomb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  -- Only an owner connects a ledger (ADR 0039 §8). The runs below still act as
  -- the analyst: a run names whoever it acted as, whoever made the connection.
  insert into users (email, full_name) values ('ledgeranom-owner-a@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('ledgeranom-owner-b@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role)
    values (org_a, owner_a, 'owner'), (org_b, owner_b, 'owner');

  -- =========================================================================
  -- The table keeps a kind and ids, and no ledger text (ADR 0035 §5)
  -- =========================================================================
  -- Asked of the catalogue so a later migration that adds a detail column fails
  -- here. The detector's detail quotes invoice numbers and renders money as
  -- text: not a third party's data to keep, and not integer cents.
  select count(*) into textish
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ledger_sync_anomalies'
     and (column_name ilike '%detail%' or column_name ilike '%message%'
          or column_name ilike '%memo%' or column_name ilike '%amount%'
          or column_name ilike '%number%' or column_name ilike '%name%');
  perform test.ok(textish = 0,
    format('ledger_sync_anomalies carries no detail, memo, amount, number or name column (%s found)', textish));

  set role app_rw;
  perform test.as_member(org_a, owner_a);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_a, 'qbo', 'realm-anom-a', owner_a) returning id into conn_a;
  perform test.as_member(org_a, analyst_a);

  run_two := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now() - interval '5 seconds', now(), 'completed', 12, 0, 0, 0, 2, null);
  run_three := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now() - interval '5 seconds', now(), 'completed', 12, 0, 0, 0, 3, null);
  run_zero := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now() - interval '5 seconds', now(), 'completed', 4, 1, 0, 0, 0, null);
  run_refused := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now(), now(), 'refused', 0, 0, 0, 0, 0, 'LedgerSyncRefusedError');

  -- =========================================================================
  -- One door in, and it is not an INSERT
  -- =========================================================================
  perform test.ok(not has_table_privilege('app_rw', 'ledger_sync_anomalies', 'INSERT'),
    'app_rw holds no INSERT on ledger_sync_anomalies: every row goes through the function');
  perform test.ok(has_table_privilege('app_rw', 'ledger_sync_anomalies', 'SELECT'),
    'it may read its own');
  perform test.expect_error(
    format('insert into ledger_sync_anomalies (org_id, run_id, kind, invoice_external_id)
              values (%L, %L, ''overapplied'', ''1'')', org_a, run_two),
    'denied', 'and a direct insert is refused');

  n := app.record_ledger_sync_anomalies(run_two, two);
  perform test.ok(n = 2, format('a completed run records its anomalies (wrote %s)', n));
  perform test.ok(
    (select count(*) = 2
       from ledger_sync_anomalies
      where run_id = run_two and org_id = org_a
        and ((kind = 'application_to_unknown_invoice' and invoice_external_id = '96'
              and transaction_external_id = '128')
          or (kind = 'overapplied' and invoice_external_id = '71'
              and transaction_external_id is null))),
    'as kinds and ledger ids, with no transaction for an invoice-level anomaly');

  perform test.ok(app.record_ledger_sync_anomalies(run_zero, '[]'::jsonb) = 0,
    'a run with no anomalies records none, and that is not an error');

  -- =========================================================================
  -- Written once, complete: all of a run's anomalies or none of them
  -- =========================================================================
  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_two, two),
    'written once', 'a run''s anomalies cannot be appended to after they are written');

  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_three, two),
    'partial list', 'a run that counted three cannot record two');
  perform test.ok(
    (select count(*) = 0 from ledger_sync_anomalies where run_id = run_three),
    'and the refusal wrote none of them');

  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_refused, '[]'),
    'only a completed run', 'a refused run read nothing and has no anomalies to record');

  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_three, '{"kind": "overapplied"}'),
    'json array', 'the payload is an array, nothing else');

  -- =========================================================================
  -- The column constraints still answer under the definer
  -- =========================================================================
  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_three,
      '[{"kind": "overapplied", "invoice_external_id": "1"},
        {"kind": "overapplied", "invoice_external_id": "2"},
        {"kind": "surprising", "invoice_external_id": "3"}]'),
    'check', 'kind is one of the detector''s four');

  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_three,
      '[{"kind": "overapplied", "invoice_external_id": "1"},
        {"kind": "overapplied", "invoice_external_id": "2"},
        {"kind": "overapplied", "invoice_external_id": "  "}]'),
    'check', 'and an anomaly names an invoice');

  perform test.ok(
    (select count(*) = 0 from ledger_sync_anomalies where run_id = run_three),
    'and a refused element writes none of its siblings');

  -- =========================================================================
  -- It reaches no further than its caller
  -- =========================================================================
  -- Another member of the same org, who may write: still not the member the
  -- run acted as.
  perform test.as_member(org_a, approver_a);
  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_three,
      '[{"kind": "overapplied", "invoice_external_id": "1"},
        {"kind": "overapplied", "invoice_external_id": "2"},
        {"kind": "overapplied", "invoice_external_id": "3"}]'),
    'not that member', 'a run''s anomalies are written as the member it acted as');

  -- Another tenant sees another tenant's run as not existing at all.
  perform test.as_member(org_b, owner_b);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_b, 'qbo', 'realm-anom-b', owner_b) returning id into conn_b;
  perform test.as_member(org_b, analyst_b);
  run_b := app.record_ledger_sync_run(org_b, conn_b, analyst_b, win_from, win_to,
    now(), now(), 'completed', 1, 0, 0, 0, 1, null);
  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_three,
      '[{"kind": "overapplied", "invoice_external_id": "1"},
        {"kind": "overapplied", "invoice_external_id": "2"},
        {"kind": "overapplied", "invoice_external_id": "3"}]'),
    'does not exist', 'org B cannot write org A''s anomalies, or learn that the run exists');
  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', gen_random_uuid(), '[]'),
    'does not exist', 'and a run that does not exist reads the same');

  perform test.as_nobody();
  perform test.expect_error(
    format('select app.record_ledger_sync_anomalies(%L, %L::jsonb)', run_b, '[]'),
    'never as nobody', 'and a caller with no claims at all is refused');

  -- =========================================================================
  -- RLS isolation
  -- =========================================================================
  perform test.as_member(org_b, analyst_b);
  select count(*) into n from ledger_sync_anomalies;
  perform test.ok(n = 0, format('org B sees none of org A''s anomalies (saw %s)', n));
  perform test.as_member(org_a, analyst_a);
  select count(*) into n from ledger_sync_anomalies;
  perform test.ok(n = 2, format('and org A sees its own two (saw %s)', n));

  -- =========================================================================
  -- Append-only, in both layers (0004's pattern)
  -- =========================================================================
  perform test.expect_error(
    format('update ledger_sync_anomalies set kind = ''overapplied'' where run_id = %L', run_two),
    'denied', 'app_rw holds no UPDATE privilege on ledger_sync_anomalies');
  perform test.expect_error(
    format('delete from ledger_sync_anomalies where run_id = %L', run_two),
    'denied', 'app_rw holds no DELETE privilege on ledger_sync_anomalies');
  perform test.expect_error(
    'truncate ledger_sync_anomalies', 'denied', 'app_rw holds no TRUNCATE privilege');

  reset role;
  perform test.expect_error(
    format('update ledger_sync_anomalies set kind = ''overapplied'' where run_id = %L', run_two),
    'append-only', 'and the trigger refuses the owner too');
  perform test.expect_error(
    format('delete from ledger_sync_anomalies where run_id = %L', run_two),
    'append-only', 'for a delete as well');
  perform test.expect_error(
    'truncate ledger_sync_anomalies', 'append-only', 'and a truncate');

  -- The run log is no less append-only for having gained a unique constraint.
  perform test.ok(not has_table_privilege('app_rw', 'ledger_sync_runs', 'UPDATE'),
    'ledger_sync_runs still grants app_rw no UPDATE');
  perform test.expect_error(
    format('update ledger_sync_runs set anomaly_count = 99 where id = %L', run_two),
    'append-only', 'and its trigger still refuses the owner');

  -- =========================================================================
  -- The tenancy tie: an anomaly cannot hang off another tenant's run
  -- =========================================================================
  -- Even the owner, who bypasses grants and RLS: the composite foreign key on
  -- (org_id, run_id) is what says the run is this org's, not only that it exists.
  perform test.expect_error(
    format('insert into ledger_sync_anomalies (org_id, run_id, kind, invoice_external_id)
              values (%L, %L, ''overapplied'', ''1'')', org_b, run_two),
    'ledger_sync_anomalies_run_same_org', 'an anomaly cannot name another org''s run');
end
$test$;
rollback;
