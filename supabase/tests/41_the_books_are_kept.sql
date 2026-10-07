\echo '-- 41 the books are kept: a snapshot per completed run, hash-chained, append-only (ADR 0074)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; owner_a uuid;
  b jsonb; org_b uuid; analyst_b uuid; owner_b uuid;
  conn_a uuid; conn_b uuid;
  run_one uuid; run_two uuid; run_three uuid; run_refused uuid; run_b uuid;
  snap_one uuid; snap_two uuid;
  sha_one text := encode(digest('snapshot one', 'sha256'), 'hex');
  sha_two text := encode(digest('snapshot two', 'sha256'), 'hex');
  sha_three text := encode(digest('snapshot three', 'sha256'), 'hex');
  n int;
  win_from date := (current_date - 34);
  win_to date := current_date;
  tb jsonb := '[
    {"account_external_id": "84", "account_name": "Accounts Receivable", "debit_cents": "1250000", "credit_cents": "0"},
    {"account_external_id": "79", "account_name": "Sales", "debit_cents": "0", "credit_cents": "1000000"},
    {"account_external_id": "91", "account_name": "Promotional Allowances", "debit_cents": "0", "credit_cents": "250000"}
  ]';
  gl jsonb := '[
    {"account_external_id": "84", "account_name": "Accounts Receivable", "debit_cents": "0", "credit_cents": "92000",
     "txn_date": "2026-09-10", "txn_type": "Payment", "transaction_external_id": "128", "doc_number": null}
  ]';
begin
  a := test.seed_org('booksketa');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid; approver_a := (a->>'approver')::uuid;
  b := test.seed_org('booksketb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  insert into users (email, full_name) values ('bookskept-owner-a@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('bookskept-owner-b@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role)
    values (org_a, owner_a, 'owner'), (org_b, owner_b, 'owner');

  -- =========================================================================
  -- The end state, read back from the catalogue
  -- =========================================================================
  perform test.ok((select relrowsecurity from pg_class where oid = 'ledger_snapshots'::regclass),
    'RLS is on for ledger_snapshots');
  perform test.ok((select relrowsecurity from pg_class where oid = 'ledger_snapshot_lines'::regclass),
    'and for ledger_snapshot_lines');
  perform test.ok(
    (select count(*) = 4 from pg_trigger
      where tgrelid in ('ledger_snapshots'::regclass, 'ledger_snapshot_lines'::regclass)
        and tgname in ('no_update_delete', 'no_truncate')),
    'both tables carry no_update_delete and no_truncate');
  perform test.ok(
    has_table_privilege('app_rw', 'ledger_snapshots', 'SELECT')
    and has_table_privilege('app_ro', 'ledger_snapshots', 'SELECT')
    and has_table_privilege('app_rw', 'ledger_snapshot_lines', 'SELECT')
    and has_table_privilege('app_ro', 'ledger_snapshot_lines', 'SELECT'),
    'app_rw and app_ro may read both');
  perform test.ok(
    not exists (
      select 1
        from unnest(array['app_rw', 'app_ro']) r,
             unnest(array['ledger_snapshots', 'ledger_snapshot_lines']) t,
             unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
       where has_table_privilege(r, t, p)),
    'and hold SELECT and nothing else on either');
  perform test.ok(
    not exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name in ('ledger_snapshots', 'ledger_snapshot_lines')
         and column_name like '%cents' and data_type <> 'bigint'),
    'every cents column is bigint');
  perform test.ok(
    not exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name in ('ledger_snapshots', 'ledger_snapshot_lines')
         and (column_name ilike '%memo%' or column_name ilike '%customer%'
              or column_name ilike '%vendor%' or column_name ilike '%message%')),
    'no memo, message or counterparty name is kept');
  perform test.ok(
    (select p.prosecdef
            and p.proconfig @> array['search_path=pg_catalog, public, extensions']
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'app' and p.proname = 'record_ledger_snapshot'),
    'the door is definer with a pinned search_path');
  perform test.ok(
    not has_function_privilege('app_ro', 'app.record_ledger_snapshot(jsonb, jsonb, jsonb)', 'EXECUTE')
    and has_function_privilege('app_rw', 'app.record_ledger_snapshot(jsonb, jsonb, jsonb)', 'EXECUTE'),
    'app_rw may call the door and app_ro may not');

  -- =========================================================================
  -- Runs to hang snapshots on
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_a, owner_a);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_a, 'qbo', 'realm-kept-a', owner_a) returning id into conn_a;
  perform test.as_member(org_a, analyst_a);
  run_one := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now() - interval '5 seconds', now(), 'completed', 3, 0, 0, 0, 0, null);
  run_two := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now() - interval '5 seconds', now(), 'completed', 3, 0, 0, 0, 0, null);
  run_three := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now() - interval '5 seconds', now(), 'completed', 3, 0, 0, 0, 0, null);
  run_refused := app.record_ledger_sync_run(org_a, conn_a, analyst_a, win_from, win_to,
    now(), now(), 'refused', 0, 0, 0, 0, 0, 'LedgerSyncRefusedError');

  -- =========================================================================
  -- One door in, and it is not an INSERT
  -- =========================================================================
  perform test.expect_error(
    format('insert into ledger_snapshots (org_id, connection_id, run_id, as_of, window_from,
              window_to, status, total_debit_cents, total_credit_cents,
              trial_balance_line_count, ledger_line_count, sha256, created_by)
            values (%L, %L, %L, %L, %L, %L, ''complete'', 0, 0, 0, 0, %L, %L)',
           org_a, conn_a, run_one, win_to, win_from, win_to, sha_one, analyst_a),
    'denied', 'a direct insert into ledger_snapshots is refused');

  -- A line that does not add up to the totals.
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_one,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'basis', 'Accrual', 'currency', 'USD', 'status', 'complete',
        'total_debit_cents', '1250000', 'total_credit_cents', '1250001',
        'trial_balance_line_count', 3, 'ledger_line_count', 1,
        'sha256', sha_one, 'prev_sha256', null), tb, gl),
    'do not add up', 'a trial balance whose lines do not sum to its totals is refused');

  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_one,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'complete', 'total_debit_cents', '1250000', 'total_credit_cents', '1250000',
        'trial_balance_line_count', 3, 'ledger_line_count', 2,
        'sha256', sha_one, 'prev_sha256', null), tb, gl),
    'partial snapshot', 'counts that disagree with the lines given are refused');

  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_one,
        'created_by', analyst_a, 'as_of', win_to - 1, 'window_from', win_from, 'window_to', win_to,
        'status', 'complete', 'total_debit_cents', '1250000', 'total_credit_cents', '1250000',
        'trial_balance_line_count', 3, 'ledger_line_count', 1,
        'sha256', sha_one, 'prev_sha256', null), tb, gl),
    'run''s window', 'a snapshot is as of its run''s last day');

  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_refused,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboReportTooLarge',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_one, 'prev_sha256', null), '[]', '[]'),
    'only a completed run', 'a run that was refused takes no snapshot');

  -- =========================================================================
  -- A valid first snapshot, and a second chained to it
  -- =========================================================================
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_one,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'complete', 'total_debit_cents', '1250000', 'total_credit_cents', '1250000',
        'trial_balance_line_count', 3, 'ledger_line_count', 1,
        'sha256', sha_one, 'prev_sha256', sha_two), tb, gl),
    'chain''s head', 'a first snapshot names no predecessor');

  snap_one := app.record_ledger_snapshot(
    jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_one,
      'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
      'basis', 'Accrual', 'currency', 'USD', 'status', 'complete',
      'total_debit_cents', '1250000', 'total_credit_cents', '1250000',
      'trial_balance_line_count', 3, 'ledger_line_count', 1,
      'sha256', sha_one, 'prev_sha256', null), tb, gl);
  perform test.ok(snap_one is not null, 'a valid first snapshot is accepted');
  perform test.ok(
    (select count(*) = 3 from ledger_snapshot_lines
      where snapshot_id = snap_one and kind = 'trial_balance')
    and (select count(*) = 1 from ledger_snapshot_lines
      where snapshot_id = snap_one and kind = 'ledger_posting'
        and txn_date = '2026-09-10' and credit_cents = 92000 and doc_number is null),
    'with its three trial-balance rows and its posting, in cents');
  perform test.ok(
    (select string_agg(account_external_id, ',' order by line_no) = '84,79,91'
       from ledger_snapshot_lines where snapshot_id = snap_one and kind = 'trial_balance'),
    'numbered in the order they were given');

  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_one,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboMalformedResponse',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_two, 'prev_sha256', sha_one), '[]', '[]'),
    'already has its snapshot', 'a run takes one snapshot');

  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_two,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboMalformedResponse',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_two, 'prev_sha256', null), '[]', '[]'),
    'chain''s head', 'a second snapshot that does not follow the first would fork the chain');

  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_two,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboMalformedResponse',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_two, 'prev_sha256', sha_one), '[]', gl),
    'has no lines', 'a refused snapshot carries no lines');

  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_two,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'the report was too large: 20001 lines',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_two, 'prev_sha256', sha_one), '[]', '[]'),
    'check', 'a refusal is a class name, never a message');

  snap_two := app.record_ledger_snapshot(
    jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_two,
      'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
      'status', 'refused', 'refusal_class', 'QboReportTooLarge',
      'trial_balance_line_count', 0, 'ledger_line_count', 0,
      'sha256', sha_two, 'prev_sha256', sha_one), '[]', '[]');
  perform test.ok(
    (select status = 'refused' and prev_sha256 = sha_one and total_debit_cents is null
       from ledger_snapshots where id = snap_two),
    'a refused second snapshot is accepted, and still chains to the first');

  -- =========================================================================
  -- It reaches no further than its caller
  -- =========================================================================
  perform test.as_member(org_a, approver_a);
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_three,
        'created_by', approver_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboReportTooLarge',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_three, 'prev_sha256', sha_two), '[]', '[]'),
    'another member', 'a snapshot is written as the member its run acted as');
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_three,
        'created_by', analyst_a, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboReportTooLarge',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_three, 'prev_sha256', sha_two), '[]', '[]'),
    'not that member', 'and cannot be attributed to somebody else');

  perform test.as_member(org_b, owner_b);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_b, 'qbo', 'realm-kept-b', owner_b) returning id into conn_b;
  perform test.as_member(org_b, analyst_b);
  run_b := app.record_ledger_sync_run(org_b, conn_b, analyst_b, win_from, win_to,
    now(), now(), 'completed', 0, 0, 0, 0, 0, null);
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_a, 'connection_id', conn_a, 'run_id', run_three,
        'created_by', analyst_b, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboReportTooLarge',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_three, 'prev_sha256', sha_two), '[]', '[]'),
    'not the tenant', 'org B cannot write a snapshot under org A''s id');
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_b, 'connection_id', conn_a, 'run_id', run_three,
        'created_by', analyst_b, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboReportTooLarge',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_three, 'prev_sha256', sha_two), '[]', '[]'),
    'does not exist', 'or hang one off org A''s run, or learn that it exists');
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_b, 'connection_id', conn_a, 'run_id', run_b,
        'created_by', analyst_b, 'as_of', win_to, 'window_from', win_from, 'window_to', win_to,
        'status', 'refused', 'refusal_class', 'QboReportTooLarge',
        'trial_balance_line_count', 0, 'ledger_line_count', 0,
        'sha256', sha_three, 'prev_sha256', null), '[]', '[]'),
    'another connection', 'or name org A''s connection on its own run');

  perform test.as_nobody();
  perform test.expect_error(
    format('select app.record_ledger_snapshot(%L::jsonb, %L::jsonb, %L::jsonb)',
      jsonb_build_object('org_id', org_b, 'connection_id', conn_b, 'run_id', run_b),
      '[]', '[]'),
    'never as nobody', 'a caller with no claims is refused');

  -- RLS isolation.
  perform test.as_member(org_b, analyst_b);
  select count(*) into n from ledger_snapshots;
  perform test.ok(n = 0, format('org B sees none of org A''s snapshots (saw %s)', n));
  select count(*) into n from ledger_snapshot_lines;
  perform test.ok(n = 0, format('or their lines (saw %s)', n));
  perform test.as_member(org_a, analyst_a);
  select count(*) into n from ledger_snapshots;
  perform test.ok(n = 2, format('org A sees its own two (saw %s)', n));

  -- =========================================================================
  -- Append-only, in both layers (0004's pattern)
  -- =========================================================================
  perform test.expect_error(
    format('update ledger_snapshots set basis = ''Cash'' where id = %L', snap_one),
    'denied', 'app_rw holds no UPDATE on ledger_snapshots');
  perform test.expect_error(
    format('delete from ledger_snapshots where id = %L', snap_one),
    'denied', 'or DELETE');
  perform test.expect_error(
    format('update ledger_snapshot_lines set debit_cents = 1 where snapshot_id = %L', snap_one),
    'denied', 'app_rw holds no UPDATE on ledger_snapshot_lines');
  perform test.expect_error(
    format('delete from ledger_snapshot_lines where snapshot_id = %L', snap_one),
    'denied', 'or DELETE');
  perform test.expect_error('truncate ledger_snapshot_lines', 'denied', 'or TRUNCATE');

  reset role;
  perform test.expect_error(
    format('update ledger_snapshots set basis = ''Cash'' where id = %L', snap_one),
    'append-only', 'and the trigger refuses the owner an update');
  perform test.expect_error(
    format('delete from ledger_snapshots where id = %L', snap_one),
    'append-only', 'a delete');
  perform test.expect_error(
    format('update ledger_snapshot_lines set debit_cents = 1 where snapshot_id = %L', snap_one),
    'append-only', 'an update of a line');
  perform test.expect_error(
    format('delete from ledger_snapshot_lines where snapshot_id = %L', snap_one),
    'append-only', 'a delete of a line');
  perform test.expect_error('truncate ledger_snapshot_lines', 'append-only', 'and a truncate');

  -- =========================================================================
  -- The structure holds even for the owner, who bypasses grants and RLS
  -- =========================================================================
  perform test.expect_error(
    format('insert into ledger_snapshots (org_id, connection_id, run_id, as_of, window_from,
              window_to, status, refusal_class, trial_balance_line_count, ledger_line_count,
              sha256, prev_sha256, created_by)
            values (%L, %L, %L, %L, %L, %L, ''refused'', ''X'', 0, 0, %L, %L, %L)',
           org_a, conn_a, run_three, win_to, win_from, win_to, sha_three, sha_one, analyst_a),
    'ledger_snapshots_one_successor', 'a fork is a constraint violation, not only a refusal');
  perform test.expect_error(
    format('insert into ledger_snapshots (org_id, connection_id, run_id, as_of, window_from,
              window_to, status, refusal_class, trial_balance_line_count, ledger_line_count,
              sha256, prev_sha256, created_by)
            values (%L, %L, %L, %L, %L, %L, ''refused'', ''X'', 0, 0, %L, %L, %L)',
           org_b, conn_a, run_b, win_to, win_from, win_to, sha_three, sha_two, analyst_b),
    'ledger_snapshots_connection_same_org', 'a snapshot cannot name another org''s connection');
  perform test.expect_error(
    format('insert into ledger_snapshot_lines (org_id, snapshot_id, kind, line_no,
              account_name, debit_cents, credit_cents)
            values (%L, %L, ''trial_balance'', 9, ''x'', 0, 0)', org_b, snap_one),
    'ledger_snapshot_lines_snapshot_same_org', 'a line cannot hang off another org''s snapshot');
  perform test.expect_error(
    format('insert into ledger_snapshot_lines (org_id, snapshot_id, kind, line_no,
              account_name, debit_cents, credit_cents)
            values (%L, %L, ''ledger_posting'', 9, ''x'', 0, 0)', org_a, snap_one),
    'ledger_snapshot_lines_kind_shape', 'a posting has a date');
end
$test$;
rollback;
