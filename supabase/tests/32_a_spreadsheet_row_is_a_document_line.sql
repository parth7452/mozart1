\echo '-- 32 a spreadsheet row is a document line (ADR 0056)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; debtor_a uuid; ded_a uuid;
  b jsonb; org_b uuid; debtor_b uuid;
  up uuid; doc uuid; er bigint; m1 uuid; latest int;
  codes text[];
begin
  a := test.seed_org('sheeta');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  approver_a := (a->>'approver')::uuid; debtor_a := (a->>'debtor')::uuid;
  ded_a := (a->>'deduction')::uuid;
  b := test.seed_org('sheetb');
  org_b := (b->>'org')::uuid; debtor_b := (b->>'debtor')::uuid;

  insert into uploads (org_id, source, created_by) values (org_a, 'web_upload', analyst_a)
    returning id into up;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org_a, up, digest('sheet-a', 'sha256'), 10, 'text/csv', 'x/sheet')
    returning id into doc;

  -- unique (org_id, id) on the three tables the new keys reference.
  perform test.ok(
    (select count(*) from pg_constraint c
      where c.conrelid in ('extraction_results'::regclass, 'debtors'::regclass, 'documents'::regclass)
        and c.contype in ('u', 'p')
        and (select array_agg(att.attname::text order by att.attname) from pg_attribute att
              where att.attrelid = c.conrelid and att.attnum = any (c.conkey)) = array['id', 'org_id']) >= 3,
    'extraction_results, debtors and documents each have unique (org_id, id)');

  -- Only one outcome check, naming all 22 codes.
  perform test.ok(
    (select count(*) from pg_constraint where conrelid = 'inbound_message_parts'::regclass
        and contype = 'c' and pg_get_constraintdef(oid) like '%outcome%' and pg_get_constraintdef(oid) like '%malformed_pdf%') = 1,
    'inbound_message_parts has exactly one outcome check');
  select array_agg(m[1] order by m[1]) into codes
    from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') m
   where c.conrelid = 'inbound_message_parts'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%malformed_pdf%';
  perform test.ok(codes = (select array_agg(x order by x) from unnest(array[
      'stored', 'already_held', 'over_daily_budget', 'not_clean',
      'inline_image', 'too_many_parts', 'not_base64',
      'empty_file', 'body_too_short', 'too_large', 'type_not_allowed',
      'content_does_not_match_type', 'encrypted_pdf',
      'active_content_pdf', 'decompression_bomb', 'malformed_pdf',
      'macro_enabled_spreadsheet', 'active_content_spreadsheet',
      'legacy_or_encrypted_office', 'xml_dtd_refused',
      'malformed_spreadsheet', 'spreadsheet_too_large']) x),
    'the outcome check names the 16 codes of 0034 and the six spreadsheet ones');

  -- A mapping is written by the person it names, even by the owner.
  perform test.expect_error(format($s$
    insert into sheet_mappings (org_id, debtor_id, version, effective_from, header_row, sheet_name,
      header_fingerprint, shape, columns, non_line_rule, sign, currency, date_order, confirmed_by)
    values (%L, %L, 1, '2026-09-01', 1, 'Sheet1', array['Invoice','Amount'], 'remittance',
      '{"invoice_number":1}', '{"blankColumn":1}', 'deductions_positive', 'USD', 'mdy', %L)$s$,
      org_a, debtor_a, analyst_a),
    'confirmed_by', 'the owner with no session cannot write a mapping naming someone');

  set role app_rw;
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(format($s$
    insert into sheet_mappings (org_id, debtor_id, version, effective_from, header_row, sheet_name,
      header_fingerprint, shape, columns, non_line_rule, sign, currency, date_order, confirmed_by)
    values (%L, %L, 1, '2026-09-01', 1, 'Sheet1', array['Invoice','Amount'], 'remittance',
      '{"invoice_number":1}', '{"blankColumn":1}', 'deductions_positive', 'USD', 'mdy', %L)$s$,
      org_a, debtor_a, approver_a),
    'confirmed_by', 'a member cannot write a mapping naming another member');

  insert into sheet_mappings (org_id, debtor_id, version, effective_from, header_row, sheet_name,
    header_fingerprint, shape, columns, non_line_rule, sign, currency, date_order,
    source_document_id, confirmed_by)
  values (org_a, debtor_a, 1, '2026-09-01', 1, 'Sheet1', array['Invoice','Amount'], 'remittance',
    '{"invoice_number":1}', '{"blankColumn":1}', 'deductions_positive', 'USD', 'mdy', doc, analyst_a)
  returning id into m1;
  insert into sheet_mappings (org_id, debtor_id, version, effective_from, header_row, sheet_name,
    header_fingerprint, shape, columns, non_line_rule, sign, currency, date_order, confirmed_by)
  values (org_a, debtor_a, 2, '2026-09-20', 1, 'Sheet1', array['Invoice','Amount'], 'remittance',
    '{"invoice_number":1,"deduction_amount":2}', '{"blankColumn":1}', 'deductions_positive',
    'USD', 'mdy', analyst_a);

  select version into latest from sheet_mappings
   where org_id = org_a and header_fingerprint = array['Invoice','Amount']
     and effective_from <= '2026-09-27' order by version desc limit 1;
  perform test.ok(latest = 2, 'the latest effective version is found');
  select version into latest from sheet_mappings
   where org_id = org_a and header_fingerprint = array['Invoice','Amount']
     and effective_from <= '2026-09-10' order by version desc limit 1;
  perform test.ok(latest = 1, 'a version not yet effective is not found');

  perform test.expect_error(format($s$
    insert into sheet_mappings (org_id, debtor_id, version, effective_from, header_row, sheet_name,
      header_fingerprint, shape, columns, non_line_rule, sign, currency, date_order, confirmed_by)
    values (%L, %L, 3, '2026-09-01', 1, 'Sheet1', array['X'], 'remittance',
      '{}', '{"blankColumn":1}', 'deductions_positive', 'USD', 'mdy', %L)$s$,
      org_a, debtor_b, analyst_a),
    'violates', 'a mapping cannot name another tenant''s debtor');

  insert into extraction_results (org_id, document_id, field_path, value_json, confidence,
                                  source_page, source_quote, quote_verified,
                                  extractor, model_version, schema_version)
    values (org_a, doc, 'lines[0].deduction_amount', '"500.00"'::jsonb, 1, 1, '500.00',
            true, 'sheet', 'none', '1.0.0')
    returning id into er;
  insert into extraction_result_cells (extraction_result_id, org_id, sheet_name, row_number,
    column_number, cell_ref, cell_type, number_format, was_formula)
  values (er, org_a, 'Sheet1', 2, 2, 'B2', 'number', null, false);

  perform test.expect_error(format(
    'update sheet_mappings set version = 9 where id = %L', m1), 'denied', 'no UPDATE on sheet_mappings');
  perform test.expect_error(format(
    'delete from sheet_mappings where id = %L', m1), 'denied', 'no DELETE on sheet_mappings');
  perform test.expect_error('truncate sheet_mappings', 'denied', 'no TRUNCATE on sheet_mappings');
  perform test.expect_error(format(
    'update extraction_result_cells set row_number = 9 where extraction_result_id = %L', er),
    'denied', 'no UPDATE on extraction_result_cells');
  perform test.expect_error(format(
    'delete from extraction_result_cells where extraction_result_id = %L', er),
    'denied', 'no DELETE on extraction_result_cells');
  perform test.expect_error('truncate extraction_result_cells', 'denied',
    'no TRUNCATE on extraction_result_cells');

  reset role;
  perform test.expect_error(format(
    'update sheet_mappings set version = 9 where id = %L', m1), 'append-only',
    'the trigger refuses UPDATE for the owner');
  perform test.expect_error('truncate extraction_result_cells', 'append-only',
    'the trigger refuses TRUNCATE for the owner');

  -- report_row is a way a case is discovered.
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents, state, discovered_via)
    values (org_a, debtor_a, 'ROW-1', 50000, 'discovered', 'report_row');
  perform test.ok(true, 'report_row is accepted');

  -- The new outcome codes are accepted (checked against the constraint itself).
  perform test.ok(
    (select pg_get_constraintdef(oid) like '%xml_dtd_refused%' from pg_constraint
      where conrelid = 'inbound_message_parts'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%outcome%' and pg_get_constraintdef(oid) like '%malformed_pdf%'),
    'a spreadsheet refusal is an outcome');

  -- Another tenant sees none of it.
  set role app_rw;
  perform test.as_member(org_b, (b->>'analyst')::uuid);
  perform test.ok((select count(*) from sheet_mappings) = 0, 'B sees no mapping of A''s');
  perform test.ok((select count(*) from extraction_result_cells) = 0, 'B sees no cell of A''s');
  perform test.expect_error(format($s$
    insert into extraction_result_cells (extraction_result_id, org_id, sheet_name, row_number,
      column_number, cell_ref, cell_type, was_formula)
    values (%L, %L, 'Sheet1', 3, 1, 'A3', 'number', false)$s$, er, org_a),
    'row-level security', 'B cannot write a cell into A');
  reset role;
end
$test$;
rollback;
