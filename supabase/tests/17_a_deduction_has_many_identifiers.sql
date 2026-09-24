\echo '-- 17 a deduction has many identifiers and one row'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; analyst uuid;
  other_ids jsonb; other_org uuid; other_analyst uuid; other_ded uuid;
  second_ded uuid; third_ded uuid; row_id uuid; n int; inserted int;
  upl uuid; doc uuid; seeded_created_at timestamptz;
begin
  ids := test.seed_org('identifiers');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid;
  analyst := (ids->>'analyst')::uuid;

  set role app_rw;
  perform test.as_member(org, analyst);

  -- -------------------------------------------------------------------------
  -- An identifier is a source-qualified fact about one deduction.
  -- -------------------------------------------------------------------------
  insert into deduction_identifiers
    (org_id, deduction_id, source, identifier_kind, identifier)
    values (org, ded, 'erp_sync', 'credit_memo_id', 'CM-8812')
    returning id into row_id;
  perform test.ok(row_id is not null,
    'a deduction can be known by a name the accounting ledger gave it');

  -- Two sources printing the same string is the normal case — the portal's
  -- claim id is often the notice's — and it is evidence, not a collision.
  insert into deduction_identifiers
    (org_id, deduction_id, source, identifier_kind, identifier)
    values (org, ded, 'portal_fetch', 'portal_claim_id', 'CM-8812');
  perform test.ok(
    (select count(*) from deduction_identifiers where deduction_id = ded) = 2,
    'the same string from a second source is a second fact, not a duplicate');

  -- -------------------------------------------------------------------------
  -- One identifier resolves to one deduction, per tenant and per source.
  -- -------------------------------------------------------------------------
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents, state)
    values (org, null, 'CLAIM-SECOND', 45_000, 'discovered')
    returning id into second_ded;

  perform test.expect_error(format(
    'insert into deduction_identifiers
       (org_id, deduction_id, source, identifier_kind, identifier)
     values (%L, %L, ''erp_sync'', ''credit_memo_id'', ''CM-8812'')', org, second_ded),
    'unique constraint',
    'one source cannot hand the same identifier to two deductions');

  -- The kind is part of the key, because a portal claim id and a ledger invoice
  -- id are not comparable even when they read alike.
  insert into deduction_identifiers
    (org_id, deduction_id, source, identifier_kind, identifier)
    values (org, second_ded, 'erp_sync', 'ledger_invoice_id', 'CM-8812');
  perform test.ok(
    (select count(*) from deduction_identifiers where deduction_id = second_ded) = 1,
    'the same string of a different kind is a different identifier');

  -- -------------------------------------------------------------------------
  -- Untrusted text, bounded. Half an identifier is not an identifier.
  -- -------------------------------------------------------------------------
  perform test.expect_error(format(
    'insert into deduction_identifiers
       (org_id, deduction_id, source, identifier_kind, identifier)
     values (%L, %L, ''edi_812'', ''edi_812_reference'', ''   '')', org, second_ded),
    'check constraint', 'a blank identifier is absence, not a name');
  perform test.expect_error(format(
    'insert into deduction_identifiers
       (org_id, deduction_id, source, identifier_kind, identifier)
     values (%L, %L, ''edi_812'', ''edi_812_reference'', %L)',
    org, second_ded, repeat('X', 201)),
    'check constraint', 'an identifier longer than the column is refused, not truncated');

  -- The source list is 0014''s, and the kinds are this migration''s.
  perform test.expect_error(format(
    'insert into deduction_identifiers
       (org_id, deduction_id, source, identifier_kind, identifier)
     values (%L, %L, ''telepathy'', ''claim_id'', ''X-1'')', org, second_ded),
    'check constraint', 'an identifier cannot come from a source we have not thought about');
  perform test.expect_error(format(
    'insert into deduction_identifiers
       (org_id, deduction_id, source, identifier_kind, identifier)
     values (%L, %L, ''edi_812'', ''gut_feel'', ''X-1'')', org, second_ded),
    'check constraint', 'nor be a kind of name nobody defined');

  -- -------------------------------------------------------------------------
  -- Append-only (invariant 2), in the two layers 01 tests for the events.
  -- -------------------------------------------------------------------------
  perform test.expect_error(format(
    'update deduction_identifiers set identifier = ''CM-0001'' where id = %L', row_id),
    'denied', 'app_rw holds no UPDATE privilege on deduction_identifiers');
  perform test.expect_error(format(
    'delete from deduction_identifiers where id = %L', row_id),
    'denied', 'app_rw holds no DELETE privilege: an identity learned is not unlearned');
  perform test.expect_error(
    'truncate deduction_identifiers', 'denied', 'app_rw holds no TRUNCATE privilege');

  -- -------------------------------------------------------------------------
  -- The backfill: one row per claim id we already held (ADR 0025).
  -- -------------------------------------------------------------------------
  -- `test.seed_org` opened a case with a claim id after migration 0020 ran, so
  -- these rows stand in for the ones that predate it. The source is looked up
  -- from the notice document''s upload where the database can know it.
  select created_at into seeded_created_at from deductions where id = ded;

  insert into uploads (org_id, source) values (org, 'email_in') returning id into upl;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org, upl, digest('notice.pdf', 'sha256'), 20480, 'application/pdf',
            'storage://n/15')
    returning id into doc;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, ded, doc, 'notice');

  select app.backfill_claim_id_identifiers() into inserted;
  perform test.ok(inserted = 2,
    'the backfill wrote one identifier per deduction that carried a claim id');
  perform test.ok(
    (select count(*) from deduction_identifiers i
       where i.identifier_kind = 'claim_id')
    = (select count(*) from deductions d where d.claim_id is not null),
    'one row per pre-existing claim_id, and no more');
  perform test.ok(
    (select source from deduction_identifiers
      where deduction_id = ded and identifier_kind = 'claim_id') = 'email_in',
    'the source is the notice''s own upload, not an assumption');
  perform test.ok(
    (select source from deduction_identifiers
      where deduction_id = second_ded and identifier_kind = 'claim_id') = 'web_upload',
    'and web_upload only where no upload row can say otherwise');
  perform test.ok(
    (select identifier from deduction_identifiers
      where deduction_id = second_ded and identifier_kind = 'claim_id') = 'CLAIM-SECOND',
    'the claim id is carried across verbatim');
  perform test.ok(
    (select first_seen_at from deduction_identifiers
      where deduction_id = ded and identifier_kind = 'claim_id') = seeded_created_at,
    'first_seen_at is when the case was opened, not when the migration ran');

  select app.backfill_claim_id_identifiers() into inserted;
  perform test.ok(inserted = 0, 'running the backfill twice inserts nothing');

  -- Two cases for one claim id is the pair identity resolution exists to merge.
  -- The backfill reports it and does not choose between them: the older case
  -- keeps the identifier and the younger one gets none.
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents, state)
    values (org, null, 'CLAIM-SECOND', 45_000, 'discovered')
    returning id into third_ded;
  select app.backfill_claim_id_identifiers() into inserted;
  perform test.ok(inserted = 0,
    'a claim id another case already holds is reported, not reassigned');
  perform test.ok(
    (select count(*) from deduction_identifiers where deduction_id = third_ded) = 0,
    'and the second case is left without one rather than merged into the first');

  -- -------------------------------------------------------------------------
  -- Another tenant sees none of it, and cannot reach into this one.
  -- -------------------------------------------------------------------------
  reset role;
  other_ids := test.seed_org('identifiersother');
  other_org := (other_ids->>'org')::uuid;
  other_analyst := (other_ids->>'analyst')::uuid;
  other_ded := (other_ids->>'deduction')::uuid;

  set role app_rw;
  perform test.as_member(other_org, other_analyst);
  select count(*) into n from deduction_identifiers;
  perform test.ok(n = 0, 'another tenant sees no identifiers at all');

  -- org_id and deduction_id are each a foreign key; neither says they are the
  -- same tenant''s. `deduction_identifiers_same_org` is what says it — without
  -- it a writer could hang an identifier their own tenant can read onto another
  -- tenant''s deduction, and the matcher would resolve onto a case they cannot
  -- open (ADR 0025 §7).
  perform test.expect_error(format(
    'insert into deduction_identifiers
       (org_id, deduction_id, source, identifier_kind, identifier)
     values (%L, %L, ''erp_sync'', ''credit_memo_id'', ''CM-9999'')', other_org, ded),
    'foreign key', 'an identifier cannot point at another tenant''s deduction');

  -- And the same claim id in another tenant is a different deduction''s name:
  -- uniqueness is per tenant, which is what makes one contract out of many
  -- manufacturers'' cases.
  insert into deduction_identifiers
    (org_id, deduction_id, source, identifier_kind, identifier)
    values (other_org, other_ded, 'erp_sync', 'credit_memo_id', 'CM-8812');
  perform test.ok(
    (select count(*) from deduction_identifiers) = 1,
    'the same identifier in another tenant is that tenant''s own fact');

  -- -------------------------------------------------------------------------
  -- The trigger is the backstop for any role that does hold UPDATE or DELETE:
  -- the owner, a service role, a future migration.
  -- -------------------------------------------------------------------------
  reset role;
  perform test.expect_error(format(
    'update deduction_identifiers set identifier = ''CM-0001'' where id = %L', row_id),
    'append-only', 'the trigger rejects UPDATE even for the table owner');
  perform test.expect_error(format(
    'delete from deduction_identifiers where id = %L', row_id),
    'append-only', 'the trigger rejects DELETE even for the table owner');
  perform test.expect_error('truncate deduction_identifiers', 'append-only',
    'TRUNCATE is blocked even for the table owner');
  -- This suite's two tenants, not the table: the owner sees every tenant's
  -- rows, and a database the Vitest suites have used holds others. A TRUNCATE
  -- or DELETE that got through would still move this count.
  perform test.ok(
    (select count(*) from deduction_identifiers where org_id in (org, other_org)) = 6,
    'every blocked mutation left the identifiers intact');
end
$test$;
rollback;
