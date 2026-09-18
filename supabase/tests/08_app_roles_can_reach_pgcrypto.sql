\echo '-- 08 the application roles can reach pgcrypto, wherever it lives'
begin;
do $test$
declare
  pgcrypto_schema text;
  org uuid; analyst uuid; ids jsonb; ded uuid;
begin
  select n.nspname into pgcrypto_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';
  perform test.ok(pgcrypto_schema is not null, 'pgcrypto is installed');

  -- This is the portable form of a bug that only appears on Supabase: there
  -- pgcrypto lives in `extensions`, a schema the app roles had no USAGE on, so
  -- app.row_hash() could not resolve digest() and no hash-chained row could be
  -- written by the application at all. Locally pgcrypto is in `public`, which
  -- every role may use, so the behavioural test below passes either way — this
  -- privilege assertion is what carries the invariant across both.
  perform test.ok(
    has_schema_privilege('app_rw', pgcrypto_schema, 'usage'),
    format('app_rw may use %I, where pgcrypto lives', pgcrypto_schema));
  perform test.ok(
    has_schema_privilege('app_ro', pgcrypto_schema, 'usage'),
    format('app_ro may use %I', pgcrypto_schema));
  perform test.ok(
    has_function_privilege('app_rw', format('%I.digest(bytea, text)', pgcrypto_schema), 'execute'),
    'app_rw may call digest(bytea, text) — what row_hash() needs');
  perform test.ok(
    has_function_privilege('app_ro', format('%I.digest(bytea, text)', pgcrypto_schema), 'execute'),
    'app_ro may call it too: verifying a chain is a read');

  -- And the thing itself: a hash-chained append, as the application role.
  ids := test.seed_org('pgcryptoreach');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid;
  analyst := (ids->>'analyst')::uuid;

  set role app_rw;
  perform test.as_member(org, analyst);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
    values (org, ded, 'note_added', '{"note":"reach"}'::jsonb, now());
  perform test.ok(
    (select count(*) from deduction_events
      where deduction_id = ded and event_type = 'note_added') = 1,
    'the application role can append a hash-chained event');
  reset role;
end
$test$;
rollback;
