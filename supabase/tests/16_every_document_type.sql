\echo '-- 16 the database stores every document type the reader can answer with'
begin;
do $test$
declare
  ids jsonb; org uuid; usr uuid; doc uuid;
  named integer;
  admitted text[];
  t text;
  -- DOC_TYPES, packages/extraction/src/ports.ts, in its own order. Repeated
  -- here on purpose: this suite runs on a bare psql with no TypeScript in
  -- reach, so the pairing it can prove is "every one of these is storable and
  -- nothing else is". The *other* direction — that this list is still what the
  -- code says — is `packages/store-postgres/test/doc-types.test.ts`, which
  -- imports DOC_TYPES and reads this constraint back out of pg_constraint
  -- (ADR 0025). Neither test alone is the guard; the two together are.
  doc_types text[] := array[
    'deduction_notice', 'remittance_advice', 'invoice', 'po', 'bol', 'pod',
    'asn', 'correspondence', 'promo_agreement', 'price_agreement',
    'routing_guide', 'other'];
begin
  ids := test.seed_org('doctypes');
  org := (ids->>'org')::uuid; usr := (ids->>'analyst')::uuid;

  set role app_rw;
  perform test.as_member(org, usr);

  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org, digest('dispatch-note.jpg', 'sha256'), 81920, 'image/jpeg', 'storage://d/1')
    returning id into doc;

  -- -------------------------------------------------------------------------
  -- 1. The type production failed on
  -- -------------------------------------------------------------------------
  -- A dispatch-note JPEG classified `correspondence` cost two model calls and
  -- then could not be stored, four times over (ADR 0025). It stores now.
  insert into document_classifications (org_id, document_id, doc_type, confidence)
    values (org, doc, 'correspondence', 0.9100);
  perform test.ok(
    (select count(*) from document_classifications
      where document_id = doc and doc_type = 'correspondence') = 1,
    'a document classified correspondence is stored rather than refused');

  -- And the latest-verdict view answers with it, which is what the rest of the
  -- pipeline reads. A constraint that admits a value the view cannot surface
  -- would be half a fix.
  perform test.ok(
    (select doc_type from document_state where document_id = doc) = 'correspondence',
    'and document_state reports it as the document''s type');

  -- -------------------------------------------------------------------------
  -- 2. Every other type too
  -- -------------------------------------------------------------------------
  -- Each one inserted rather than the list being compared to the constraint's
  -- text: what matters is that an insert succeeds, and only an insert proves
  -- that.
  foreach t in array doc_types loop
    insert into document_classifications (org_id, document_id, doc_type, confidence)
      values (org, doc, t, 0.5000);
  end loop;
  perform test.ok(
    (select count(distinct doc_type) from document_classifications where document_id = doc)
      = array_length(doc_types, 1),
    'every one of the twelve DOC_TYPES is storable');

  -- -------------------------------------------------------------------------
  -- 3. And nothing else
  -- -------------------------------------------------------------------------
  -- The constraint is widened, not removed. A type nothing in this repository
  -- can produce is still a typo or a model answering off-schema, and it is
  -- refused rather than stored and read back later as if a classifier had said
  -- it.
  perform test.expect_error(format(
    'insert into document_classifications (org_id, document_id, doc_type, confidence)
     values (%L, %L, ''dispatch_note'', 0.99)', org, doc),
    'violates check constraint',
    'a doc type no classifier can answer with is still refused');
  perform test.expect_error(format(
    'insert into document_classifications (org_id, document_id, doc_type, confidence)
     values (%L, %L, ''Correspondence'', 0.99)', org, doc),
    'violates check constraint',
    'and the set is exact rather than case-insensitive');
  perform test.expect_error(format(
    'insert into document_classifications (org_id, document_id, doc_type, confidence)
     values (%L, %L, '''', 0.99)', org, doc),
    'violates check constraint',
    'and the empty string is not a document type');

  -- -------------------------------------------------------------------------
  -- 4. The table is no less append-only than it was
  -- -------------------------------------------------------------------------
  -- Migration 0020 adds no grant. Widening a CHECK says which rows may be
  -- inserted and nothing about whether a row may be changed once written, and
  -- this is where that is read back rather than asserted in a comment
  -- (invariant 2).
  perform test.expect_error(format(
    'update document_classifications set doc_type = ''other'' where document_id = %L', doc),
    'denied', 'a classification still cannot be edited: re-classifying writes a new row');
  perform test.expect_error(format(
    'delete from document_classifications where document_id = %L', doc),
    'denied', 'and app_rw still holds no DELETE on it');

  -- -------------------------------------------------------------------------
  -- 5. Applying the migration twice leaves one constraint
  -- -------------------------------------------------------------------------
  -- scripts/db-test.sh applies every migration twice in one run, so by the time
  -- this suite executes 0020 has been applied to a database that already
  -- carried it. Drop-then-add is what makes that a no-op; a second
  -- `add constraint` under a generated name would leave two rules with one
  -- meaning, and only one of them named in an error.
  reset role;
  select count(*) into named from pg_constraint
   where conrelid = 'document_classifications'::regclass
     and conname = 'document_classifications_doc_type_check';
  perform test.ok(named = 1,
    'the constraint exists exactly once after the migration was applied twice');
  perform test.ok(
    (select c.convalidated from pg_constraint c
      where c.conrelid = 'document_classifications'::regclass
        and c.conname = 'document_classifications_doc_type_check'),
    'and it is validated, so it binds the rows already there as well as the next one');

  -- The constraint admits exactly the twelve and no more — read off its own
  -- definition, which is the text the TypeScript test compares to DOC_TYPES.
  select array_agg(t.m[1] order by t.m[1]) into admitted
    from regexp_matches(
           pg_get_constraintdef((
             select oid from pg_constraint
              where conrelid = 'document_classifications'::regclass
                and conname = 'document_classifications_doc_type_check')),
           -- Digits too: `edi_812` is a channel today and a plausible type
           -- tomorrow, and a pattern that silently skipped it would read as a
           -- constraint that does not admit it.
           '''([a-z0-9_]+)''::text', 'g') as t(m);
  perform test.ok(
    admitted = (select array_agg(x order by x) from unnest(doc_types) as u(x)),
    'and the values it admits are exactly the twelve, read back from pg_constraint');
end
$test$;
rollback;
