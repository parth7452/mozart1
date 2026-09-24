\echo '-- 20 a ledger sync is scheduled: the registry holds no secrets, the run log is append-only'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid;
  b jsonb; org_b uuid; analyst_b uuid;
  reader uuid; owner_a uuid; owner_b uuid;
  conn_a uuid; conn_a2 uuid; conn_b uuid;
  run_a uuid; run_reader uuid;
  n int; secretish int; fn_result text;
  win_from date := (current_date - 34);
  win_to date := current_date;
begin
  a := test.seed_org('ledgersynca');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  b := test.seed_org('ledgersyncb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  -- A member of org A who may NOT write. The refusal path below is the whole
  -- reason app.record_ledger_sync_run() is definer: the row that most needs
  -- writing is the one whose acting member may no longer write.
  insert into users (email, full_name) values ('ledgersync-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org_a, reader, 'read_only');

  -- Since ADR 0039 only an owner connects a ledger, and the seed has none. Added
  -- as the table owner, because who is an owner is now an owner's decision.
  insert into users (email, full_name) values ('ledgersync-owner-a@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('ledgersync-owner-b@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role)
    values (org_a, owner_a, 'owner'), (org_b, owner_b, 'owner');

  -- =========================================================================
  -- accounting_connections holds no credential of any kind (ADR 0031 §1)
  -- =========================================================================
  -- Asked of the catalogue rather than of a list, so a later migration that
  -- adds a token column fails here on the day it is written. CLAUDE.md puts
  -- credentials in KMS-backed storage; Intuit's refresh tokens rotate on every
  -- use, so a column anybody can select is a live credential leaked and a
  -- column anybody can update is a connection stranded.
  select count(*) into secretish
    from information_schema.columns
   where table_schema = 'public' and table_name = 'accounting_connections'
     and (column_name ilike '%token%' or column_name ilike '%secret%'
          or column_name ilike '%credential%' or column_name ilike '%refresh%'
          or column_name ilike '%password%');
  perform test.ok(secretish = 0,
    format('accounting_connections carries no token/secret/credential column (%s found)', secretish));

  set role app_rw;

  -- =========================================================================
  -- The registry: writable by an owner, within its own tenant only
  -- =========================================================================
  -- A writer is not enough any more: connecting a ledger makes that person the
  -- identity every nightly sync acts as (ADR 0039 §8).
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''realm-a-1'', %L)', org_a, analyst_a),
    'policy', 'an analyst may not connect a ledger');

  perform test.as_member(org_a, owner_a);
  -- `updated_at` is supplied deliberately stale, so the trigger below has
  -- something to move. `now()` is fixed for a transaction, so a row inserted
  -- and updated in one would otherwise show the same instant either way and the
  -- assertion would pass whether or not the trigger fired at all.
  insert into accounting_connections (org_id, provider, provider_account_id, created_by, updated_at)
    values (org_a, 'qbo', 'realm-a-1', owner_a, '2020-01-01T00:00:00Z')
    returning id into conn_a;
  perform test.ok(conn_a is not null, 'an owner may connect a ledger for their own org');

  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''realm-b-stolen'', %L)', org_b, owner_a),
    'policy', 'and cannot connect a ledger for another org');

  -- The provider list is a check constraint that can grow. A provider this
  -- build has no AccountingSource for is refused by the database rather than
  -- discovered at the vendor.
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''xero'', ''realm-a-2'', %L)', org_a, owner_a),
    'check', 'provider is constrained: xero is refused until a migration adds it');

  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''   '', %L)', org_a, owner_a),
    'check', 'and a blank provider account id is refused');

  -- One enabled connection per company, and one row per member (ADR 0039 §6,
  -- §7): a second connection to the same books would double every case the
  -- ledger discovers.
  perform test.expect_error(
    format('insert into accounting_connections (org_id, provider, provider_account_id, created_by)
              values (%L, ''qbo'', ''realm-a-1'', %L)', org_a, owner_a),
    'unique', 'the same company cannot be connected twice');

  -- =========================================================================
  -- It is mutable where it has to be, and immutable where it must be
  -- =========================================================================
  update accounting_connections set enabled = false where id = conn_a;
  perform test.ok(
    (select not enabled from accounting_connections where id = conn_a),
    'a connection can be disabled — this is the one table here that is not append-only');

  perform test.ok(
    (select updated_at > '2020-01-02T00:00:00Z'::timestamptz
       from accounting_connections where id = conn_a),
    'and the update stamps updated_at, whatever the caller supplied');

  perform test.expect_error(
    format('update accounting_connections set provider_account_id = ''realm-elsewhere'' where id = %L', conn_a),
    'immutable', 'but the books it points at are immutable: a different company is a different connection');

  perform test.expect_error(
    format('update accounting_connections set org_id = %L where id = %L', org_b, conn_a),
    'immutable', 'and so is the tenant');

  -- Deleting is not the verb: a connection that synced is named by every run
  -- row it produced, so disabling is how one goes away.
  perform test.ok(not has_table_privilege('app_rw', 'accounting_connections', 'DELETE'),
    'app_rw holds no DELETE on accounting_connections — disabling is the verb');
  perform test.ok(has_table_privilege('app_rw', 'accounting_connections', 'UPDATE'),
    'and does hold UPDATE, which is what `enabled` is for');

  update accounting_connections set enabled = true where id = conn_a;

  -- =========================================================================
  -- RLS isolation across two orgs
  -- =========================================================================
  perform test.as_member(org_b, owner_b);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_b, 'qbo', 'realm-b-1', owner_b) returning id into conn_b;

  select count(*) into n from accounting_connections;
  perform test.ok(n = 1, format('org B sees only its own connection (saw %s)', n));

  perform test.as_member(org_a, analyst_a);
  select count(*) into n from accounting_connections;
  perform test.ok(n = 1, format('and org A only its own (saw %s)', n));

  -- =========================================================================
  -- The fan-out's list: every enabled connection, across every org, ids only
  -- =========================================================================
  -- Definer on purpose, and this is what that buys: the cron has to know which
  -- orgs to fan out to before it can adopt any org's claims (ADR 0031 §5). It
  -- returns four id-shaped columns — never provider_account_id.
  --
  -- And it is refused to a caller that *has* a tenant. Migration 0006 made
  -- `authenticated` a member of `app_rw`, which put this within reach of a
  -- signed-in request; 0028 revoked that (ADR 0037, suite 24), and the refusal
  -- stays as defence in depth, because this is the one function here whose
  -- answer is not bounded by the caller's claims. A tenant reads the table
  -- through RLS.
  perform test.expect_error(
    'select count(*) from app.ledger_connections_to_sync()',
    'untenanted', 'the fan-out query is refused to a caller acting for a tenant');

  -- Counted for this suite's two orgs: the fan-out answers for the whole
  -- deployment by design, and a database other suites or the Vitest tests have
  -- used holds other orgs' connections.
  perform test.as_nobody();
  select count(*) into n from app.ledger_connections_to_sync() where org_id in (org_a, org_b);
  perform test.ok(n = 2,
    format('app.ledger_connections_to_sync() lists both orgs'' enabled connections (saw %s)', n));

  -- Asked of the catalogue, because this is the one query in the schema that
  -- crosses a tenant boundary: what it returns is the whole of its blast
  -- radius, and `provider_account_id` appearing here would turn a list of ids
  -- into a list of everybody's books.
  select pg_get_function_result(p.oid) into fn_result
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'app' and p.proname = 'ledger_connections_to_sync';
  perform test.ok(
    fn_result like 'TABLE(%'
      and position('provider_account_id' in fn_result) = 0
      and array_length(string_to_array(fn_result, ','), 1) = 4,
    format('and returns four id-shaped columns, none of them the provider account id (%s)',
           fn_result));

  -- A disabled connection is not a connection to sync. Written as a member,
  -- because a write still goes through RLS; read back untenanted, because the
  -- fan-out's query is the untenanted one.
  perform test.as_member(org_a, owner_a);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by, enabled)
    values (org_a, 'qbo', 'realm-a-disabled', owner_a, false) returning id into conn_a2;

  perform test.as_nobody();
  select count(*) into n from app.ledger_connections_to_sync() where org_id in (org_a, org_b);
  perform test.ok(n = 2, format('a disabled connection is not listed (saw %s)', n));
  perform test.ok(
    not exists (select 1 from app.ledger_connections_to_sync() where connection_id = conn_a2),
    'by name');
  perform test.as_member(org_a, analyst_a);

  -- =========================================================================
  -- The run log: one door in, and it is not an INSERT
  -- =========================================================================
  perform test.ok(not has_table_privilege('app_rw', 'ledger_sync_runs', 'INSERT'),
    'app_rw holds no INSERT on ledger_sync_runs: every row goes through the function');
  perform test.ok(has_table_privilege('app_rw', 'ledger_sync_runs', 'SELECT'),
    'it may read its own runs');

  perform test.expect_error(
    format('insert into ledger_sync_runs
              (org_id, connection_id, window_from, window_to, started_at, finished_at,
               outcome, requested_by)
            values (%L, %L, %L, %L, now(), now(), ''completed'', %L)',
           org_a, conn_a, win_from, win_to, analyst_a),
    'denied', 'and a direct insert is refused');

  run_a := app.record_ledger_sync_run(
    org_a, conn_a, analyst_a, win_from, win_to, now() - interval '20 seconds', now(),
    'completed', 120, 3, 7, 11, 1, null);
  perform test.ok(run_a is not null, 'a completed run records its window and its counts');
  perform test.ok(
    (select invoices_examined = 120 and opened_count = 3 and skipped_count = 7
        and declined_count = 11 and anomaly_count = 1 and error_class is null
       from ledger_sync_runs where id = run_a),
    'with the counts it was given, and no error class');

  -- =========================================================================
  -- The refusal can record itself. This is why the function is definer.
  -- =========================================================================
  perform test.as_member(org_a, reader);
  perform test.ok(not app.member_may_write(),
    'the read_only member may not write in org A');
  run_reader := app.record_ledger_sync_run(
    org_a, conn_a, reader, win_from, win_to, now(), now(),
    'refused', 0, 0, 0, 0, 0, 'LedgerSyncRefusedError');
  perform test.ok(
    (select outcome = 'refused' and error_class = 'LedgerSyncRefusedError'
        and requested_by = reader and invoices_examined = 0
       from ledger_sync_runs where id = run_reader),
    'and the run refused on their account still records that it was refused');

  -- =========================================================================
  -- ...and it reaches no further than its caller
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);

  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''completed'', 0, 0, 0, 0, 0, null)',
           org_b, conn_b, analyst_a, win_from, win_to),
    'not the tenant', 'the function refuses an org that is not the caller''s own claim');

  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''completed'', 0, 0, 0, 0, 0, null)',
           org_a, conn_a, analyst_b, win_from, win_to),
    'acted as', 'and a requested_by that is not the caller''s own subject');

  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''completed'', 0, 0, 0, 0, 0, null)',
           org_a, conn_b, analyst_a, win_from, win_to),
    'another org', 'and a connection belonging to another org');

  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''completed'', 0, 0, 0, 0, 0, null)',
           org_a, gen_random_uuid(), analyst_a, win_from, win_to),
    'does not exist', 'and a connection that does not exist');

  perform test.as_nobody();
  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''completed'', 0, 0, 0, 0, 0, null)',
           org_a, conn_a, analyst_a, win_from, win_to),
    'never as nobody', 'and a caller with no claims at all');
  perform test.as_member(org_a, analyst_a);

  -- =========================================================================
  -- The run log's own constraints
  -- =========================================================================
  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''succeeded'', 0, 0, 0, 0, 0, null)',
           org_a, conn_a, analyst_a, win_from, win_to),
    'check', 'outcome is one of four constants');

  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''completed'', 0, 0, 0, 0, 0, ''SomeError'')',
           org_a, conn_a, analyst_a, win_from, win_to),
    'check', 'a completed run cannot also carry an error class');

  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now(),
                     ''completed'', 0, 0, 0, 0, 0, null)',
           org_a, conn_a, analyst_a, win_to + 1, win_to),
    'check', 'and a window cannot run backwards');

  perform test.expect_error(
    format('select app.record_ledger_sync_run(%L, %L, %L, %L, %L, now(), now() - interval ''1 hour'',
                     ''failed'', 0, 0, 0, 0, 0, ''QboRequestFailed'')',
           org_a, conn_a, analyst_a, win_from, win_to),
    'check', 'nor can a run finish before it started');

  -- =========================================================================
  -- Append-only, in both layers (0004's pattern, suite 01's shape)
  -- =========================================================================
  perform test.expect_error(
    format('update ledger_sync_runs set opened_count = 999 where id = %L', run_a),
    'denied', 'app_rw holds no UPDATE privilege on ledger_sync_runs');
  perform test.expect_error(
    format('delete from ledger_sync_runs where id = %L', run_a),
    'denied', 'app_rw holds no DELETE privilege on ledger_sync_runs');
  perform test.expect_error(
    'truncate ledger_sync_runs', 'denied', 'app_rw holds no TRUNCATE privilege');

  -- And the trigger, which is what answers for the owner — the role migrations
  -- run as, the role a Supabase SQL-editor session runs as, and anybody with
  -- the database password. The grant answers for app_rw; this is the backstop
  -- 0004 pairs with it.
  reset role;
  perform test.expect_error(
    format('update ledger_sync_runs set opened_count = 999 where id = %L', run_a),
    'append-only', 'and the trigger refuses the owner too');
  perform test.expect_error(
    format('delete from ledger_sync_runs where id = %L', run_a),
    'append-only', 'for a delete as well');
  -- Since migration 0027 `ledger_sync_anomalies` references this table, so a
  -- plain truncate is refused by that foreign key before any statement trigger
  -- fires — a real refusal, but somebody else's rule. Suite 14's pattern: assert
  -- that, then assert the CASCADE that would get past it is stopped by the
  -- trigger, by name, so this still tests the trigger rather than the key.
  perform test.expect_error(
    'truncate ledger_sync_runs', 'referenced in a foreign key constraint',
    'a plain truncate is stopped by the reference from ledger_sync_anomalies');
  perform test.expect_error(
    'truncate ledger_sync_runs cascade', 'append-only',
    'and the cascade that would get past that is stopped by the trigger');

  -- =========================================================================
  -- RLS isolation on the run log
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_b, analyst_b);
  select count(*) into n from ledger_sync_runs;
  perform test.ok(n = 0, format('org B sees none of org A''s sync runs (saw %s)', n));

  perform test.as_member(org_a, analyst_a);
  select count(*) into n from ledger_sync_runs;
  perform test.ok(n = 2, format('and org A sees both of its own (saw %s)', n));

  reset role;
end
$test$;
rollback;
