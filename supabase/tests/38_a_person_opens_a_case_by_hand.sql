\echo '-- 38 a person opens a case by hand (ADR 0070)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; upl uuid; t text; def text;
begin
  a := test.seed_org('manual');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;

  -- The three lists of sources are one list, and each admits manual_entry.
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'uploads'::regclass and conname = 'uploads_source_check')
      like '%manual_entry%',
    'uploads.source admits manual_entry');
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'deduction_identifiers'::regclass
        and conname = 'deduction_identifiers_source_check')
      like '%manual_entry%',
    'deduction_identifiers.source admits manual_entry');
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'declined_candidates'::regclass
        and conname = 'declined_candidates_discovered_from_check')
      like '%manual_entry%',
    'declined_candidates.discovered_from admits manual_entry');
  perform test.ok(
    (select count(*) from pg_constraint
      where conrelid in ('deduction_identifiers'::regclass, 'declined_candidates'::regclass)
        and contype = 'c' and pg_get_constraintdef(oid) like '%erp_sync%') = 2,
    'the inline checks were replaced, not joined by a second one');
  perform test.ok(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'deductions'::regclass and conname = 'deductions_discovered_via_check')
      like '%''manual''%',
    'deductions.discovered_via admits manual');

  -- document_arrivals keeps refusing manual_entry: its channel rule is the
  -- trigger function, and no check on the table names one.
  select prosrc into def from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'app' and p.proname = 'arrival_only_when_unknown';
  perform test.ok(def like '%''web_upload'', ''email_in'', ''email_body''%'
                  and def not like '%manual_entry%',
    'app.arrival_only_when_unknown() still admits only the three old doors');
  perform test.ok(
    not exists (select 1 from pg_constraint where conrelid = 'document_arrivals'::regclass
                   and contype = 'c' and pg_get_constraintdef(oid) like '%manual_entry%'),
    'no check on document_arrivals admits manual_entry');

  -- Still append-only.
  foreach t in array array['uploads', 'deduction_identifiers', 'declined_candidates'] loop
    perform test.ok(
      not has_table_privilege('app_rw', t, 'UPDATE')
      and not has_table_privilege('app_rw', t, 'DELETE'),
      format('app_rw holds no UPDATE or DELETE on %s', t));
  end loop;

  -- An analyst records a manual entry's arrival as themselves.
  set role app_rw;
  perform test.as_member(org_a, analyst_a);
  insert into uploads (org_id, source, created_by)
    values (org_a, 'manual_entry', analyst_a) returning id into upl;
  perform test.ok(upl is not null, 'an analyst inserts a manual_entry upload');
  reset role;
end
$test$;
rollback;
