\echo '-- 14 an arrival is a fact: uploads is append-only, and a pre-provenance document has one way back'
begin;
do $test$
declare
  ids jsonb; org uuid; analyst uuid; reader uuid;
  other_ids jsonb; other_org uuid;
  ingested uuid; emailed uuid; other_upload uuid; fresh uuid; asserted_upload uuid;
  doc_known uuid; doc_unknown uuid; doc_unknown_2 uuid; other_doc uuid;
  arrival uuid;
  named integer;
  privs text;
begin
  ids := test.seed_org('arrivalfact');
  org := (ids->>'org')::uuid; analyst := (ids->>'analyst')::uuid;
  other_ids := test.seed_org('arrivalother');
  other_org := (other_ids->>'org')::uuid;

  -- A member who may read and not write, so the RLS half of every refusal below
  -- has somebody to refuse. The grants are one answer and the policy is
  -- another; a suite that only had a writer would prove the wrong one.
  insert into users (email, full_name) values ('arrivalfact-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org, reader, 'read_only');

  -- Two arrivals and three documents, inserted as the owner so this starts from
  -- a database holding both kinds of document: one whose arrival ingest
  -- recorded, and one stored before ingest recorded any.
  insert into uploads (org_id, source, created_by) values (org, 'web_upload', analyst)
    returning id into ingested;
  insert into uploads (org_id, source, created_by) values (org, 'email_in', null)
    returning id into emailed;
  insert into uploads (org_id, source) values (other_org, 'web_upload')
    returning id into other_upload;

  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref, upload_id)
    values (org, digest('known', 'sha256'), 1024, 'application/pdf', 'doc/known', ingested)
    returning id into doc_known;
  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org, digest('unknown', 'sha256'), 1024, 'application/pdf', 'doc/unknown')
    returning id into doc_unknown;
  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org, digest('unknown2', 'sha256'), 1024, 'application/pdf', 'doc/unknown2')
    returning id into doc_unknown_2;
  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (other_org, digest('other', 'sha256'), 1024, 'application/pdf', 'doc/other')
    returning id into other_doc;

  -- =========================================================================
  -- 1. An arrival can still be recorded. That is the only thing that changed.
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org, analyst);

  insert into uploads (org_id, source, created_by) values (org, 'web_upload', analyst)
    returning id into fresh;
  perform test.ok(fresh is not null,
    'a writer still records an arrival: INSERT is what this table is for');

  -- =========================================================================
  -- 2. And nothing can rewrite one.
  -- =========================================================================
  -- `source` specifically, because that is the column with a number hanging off
  -- it: `declined_candidates.discovered_from` is derived from it, the declined
  -- row is append-only, and `coverage_by_period` groups by it. An UPDATE here
  -- re-labels which channel found a deduction after the declines attributed to
  -- it were counted (ADR 0024).
  perform test.expect_error(format(
    'update uploads set source = ''erp_sync'' where id = %L', ingested),
    'denied', 'app_rw holds no UPDATE on uploads, so it cannot re-label a channel');
  perform test.expect_error(format(
    'update uploads set created_by = %L where id = %L', analyst, emailed),
    'denied', 'nor move an arrival between people');
  perform test.expect_error(format(
    'delete from uploads where id = %L', fresh),
    'denied', 'nor delete the arrival it just recorded');
  perform test.expect_error('truncate uploads',
    'denied', 'nor truncate the table');

  perform test.ok(
    (select u.source from uploads u where u.id = ingested) = 'web_upload',
    'and the channel still says what it said');

  -- The grants answer for app_rw and app_ro. They do not answer for the role
  -- that owns the table — which is the role migrations run as, the role a
  -- Supabase SQL-editor session runs as, and the role anybody with the database
  -- password gets, all of which bypass grants and RLS alike. 0004's pattern is a
  -- revoke *and* a trigger for exactly that reason, and this is where the second
  -- half is read back rather than assumed.
  reset role;
  perform test.expect_error(format(
    'update uploads set source = ''erp_sync'' where id = %L', ingested),
    'append-only table uploads',
    'and the owner is refused by the trigger, in the trigger''s own words');
  perform test.expect_error(format(
    'delete from uploads where id = %L', ingested),
    'append-only table uploads', 'the owner cannot delete one either');
  -- `truncate uploads` on its own never reaches the trigger: `documents.upload_id`
  -- references it, and Postgres refuses a truncate of a referenced table before
  -- any statement trigger fires. That is a real refusal but it is somebody
  -- else's rule, and a suite that stopped there would be asserting the foreign
  -- key while claiming to assert the trigger. CASCADE is the form that gets
  -- past it, and it is the form somebody clearing a database would reach for.
  perform test.expect_error('truncate uploads',
    'referenced in a foreign key constraint',
    'a plain truncate is stopped by the reference from documents, before any trigger');
  perform test.expect_error('truncate uploads cascade',
    'append-only table uploads',
    'and the cascade that would get past that is stopped by the trigger, by name');

  -- =========================================================================
  -- 3. The grants are exactly the two an append-only table gets.
  -- =========================================================================
  -- Asserted as an equality rather than as "no UPDATE", because the failure this
  -- guards against is a later migration handing something back: `grant all` is a
  -- single word, and a test that only checked the privilege it was written about
  -- would not notice.
  select string_agg(p, ',' order by p) into privs
    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                      'REFERENCES', 'TRIGGER']) as p
   where has_table_privilege('app_rw', 'uploads', p);
  perform test.ok(privs = 'INSERT,SELECT',
    format('app_rw holds exactly INSERT and SELECT on uploads (holds: %s)', privs));

  select string_agg(p, ',' order by p) into privs
    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                      'REFERENCES', 'TRIGGER']) as p
   where has_table_privilege('app_ro', 'uploads', p);
  perform test.ok(privs = 'SELECT',
    format('and app_ro holds exactly SELECT (holds: %s)', privs));

  -- =========================================================================
  -- 4. RLS still decides who may record one at all.
  -- =========================================================================
  -- Freezing the table must not have made writing to it any easier. A read_only
  -- member is refused by `tenant_insert` (migration 0010), before the grants are
  -- reached — and that is a different refusal from the four above, so it is
  -- asserted separately rather than folded into them.
  set role app_rw;
  perform test.as_member(org, reader);
  perform test.expect_error(format(
    'insert into uploads (org_id, source) values (%L, ''web_upload'')', org),
    'row-level security',
    'a read_only member still cannot record an arrival at all');

  perform test.as_member(other_org, analyst);
  perform test.expect_error(format(
    'insert into uploads (org_id, source) values (%L, ''web_upload'')', org),
    'row-level security',
    'and nobody records an arrival into a tenant whose claims they do not carry');

  -- =========================================================================
  -- 5. document_arrivals: one way back for a document stored before provenance.
  -- =========================================================================
  perform test.as_member(org, reader);
  perform test.expect_error(format(
    $q$insert into document_arrivals (org_id, document_id, upload_id, recorded_by)
       values (%L, %L, %L, %L)$q$, org, doc_unknown, fresh, reader),
    'row-level security',
    'a read_only member cannot assert an arrival either');

  perform test.as_member(org, analyst);

  -- The whole point of the table: a document ingest recorded nothing about gets
  -- an arrival, asserted by a named person.
  insert into document_arrivals (org_id, document_id, upload_id, recorded_by, detail)
    values (org, doc_unknown, fresh, analyst, 'ADR 0024: pre-provenance, web upload')
    returning id into arrival;
  perform test.ok(arrival is not null,
    'a pre-provenance document records the arrival it came from, with a name on it');

  -- Written once. A second assertion about the same document is refused, not
  -- stacked — and with the append-only triggers below, that makes the first the
  -- only one.
  insert into uploads (org_id, source, created_by) values (org, 'email_in', analyst)
    returning id into asserted_upload;
  perform test.expect_error(format(
    $q$insert into document_arrivals (org_id, document_id, upload_id, recorded_by)
       values (%L, %L, %L, %L)$q$, org, doc_unknown, asserted_upload, analyst),
    'duplicate key',
    'and a second assertion about the same document is refused, not stacked');

  -- Never an override. What ingest observed stays the only answer wherever
  -- ingest observed anything, which is what keeps this table an assertion about
  -- the unknown rather than a way round §2 of the ADR.
  perform test.expect_error(format(
    $q$insert into document_arrivals (org_id, document_id, upload_id, recorded_by)
       values (%L, %L, %L, %L)$q$, org, doc_known, asserted_upload, analyst),
    'already records arrival',
    'a document whose arrival ingest recorded cannot have it overwritten');

  -- The foreign keys say each id exists. They do not say they are one tenant's.
  perform test.expect_error(format(
    $q$insert into document_arrivals (org_id, document_id, upload_id, recorded_by)
       values (%L, %L, %L, %L)$q$, org, other_doc, asserted_upload, analyst),
    'belongs to another org',
    'an arrival may not be asserted onto another tenant''s document');
  perform test.expect_error(format(
    $q$insert into document_arrivals (org_id, document_id, upload_id, recorded_by)
       values (%L, %L, %L, %L)$q$, org, doc_unknown_2, other_upload, analyst),
    'belongs to another org',
    'nor point at another tenant''s arrival');

  -- =========================================================================
  -- 6. And the mapping is append-only too, for the same reason uploads is.
  -- =========================================================================
  perform test.expect_error(format(
    'update document_arrivals set upload_id = %L where id = %L', asserted_upload, arrival),
    'denied', 'app_rw holds no UPDATE on document_arrivals');
  perform test.expect_error(format(
    'delete from document_arrivals where id = %L', arrival),
    'denied', 'nor DELETE');
  perform test.expect_error('truncate document_arrivals', 'denied', 'nor TRUNCATE');

  reset role;
  perform test.expect_error(format(
    'update document_arrivals set recorded_by = %L where id = %L', analyst, arrival),
    'append-only table document_arrivals',
    'and the owner is refused by the trigger there as well');
  perform test.expect_error(format(
    'delete from document_arrivals where id = %L', arrival),
    'append-only table document_arrivals', 'including a delete');
  -- Nothing references this table, so the plain form reaches the trigger here.
  perform test.expect_error('truncate document_arrivals',
    'append-only table document_arrivals', 'and a truncate of it, by name');

  select string_agg(p, ',' order by p) into privs
    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                      'REFERENCES', 'TRIGGER']) as p
   where has_table_privilege('app_rw', 'document_arrivals', p);
  perform test.ok(privs = 'INSERT,SELECT',
    format('app_rw holds exactly INSERT and SELECT on document_arrivals (holds: %s)', privs));

  -- =========================================================================
  -- 7. Applying the migration twice leaves one of everything.
  -- =========================================================================
  -- scripts/db-test.sh applies every migration twice in one run, so by the time
  -- this suite executes 0019 has been applied to a database that already carried
  -- it. Drop-then-create is what makes that a no-op; this is where it is read
  -- back rather than assumed, because two triggers with one meaning is two
  -- error messages for one rule.
  select count(*) into named from pg_trigger
   where tgrelid in ('uploads'::regclass, 'document_arrivals'::regclass)
     and not tgisinternal
     and tgname in ('no_update_delete', 'no_truncate', 'arrival_only_when_unknown');
  perform test.ok(named = 5,
    format('five triggers across the two tables, no duplicates (found %s)', named));

  -- The pin, because `create or replace function` assigns every property from
  -- the command: a later replacement that omitted it would silently drop it,
  -- and this function decides whether a write is allowed (ADR 0010 §4, 0022).
  perform test.ok(
    (select 'search_path=pg_catalog, public, extensions' = any(p.proconfig)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'arrival_only_when_unknown'),
    'and the guard''s search_path is pinned');
  perform test.ok(
    (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'arrival_only_when_unknown'),
    'and it reads as definer, so a cross-tenant reference and a missing row give different answers');
end
$test$;
rollback;
