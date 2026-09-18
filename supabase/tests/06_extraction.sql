\echo '-- 06 ingest + extraction tables (Phase 1)'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; usr uuid; doc uuid;
begin
  ids := test.seed_org('extraction');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid; usr := (ids->>'analyst')::uuid;

  set role app_rw;
  perform test.as_member(org, usr);

  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org, digest('notice.pdf', 'sha256'), 20480, 'application/pdf', 'storage://n/1')
    returning id into doc;
  insert into document_scans (org_id, document_id, status, scanner)
    values (org, doc, 'clean', 'clamav');
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, ded, doc, 'notice');
  insert into document_pages (org_id, document_id, page_number, width_px, height_px, text_layer)
    values (org, doc, 1, 1275, 1650, 'Walmart APDP claim 24 shortage 5 cartons');

  -- A field we can point at in the document.
  insert into extraction_results (org_id, document_id, deduction_id, field_path, value_json,
                                  confidence, source_page, source_quote, source_bbox,
                                  quote_verified, extractor, model_version, schema_version)
    values (org, doc, ded, 'lines[0].deduction_amount_cents', '312000'::jsonb, 0.97, 1,
            'Total deduction: $3,120.00', array[0.10, 0.42, 0.55, 0.46]::numeric(6,5)[],
            true, 'claude-vision', 'claude-sonnet-5', '1.0.0');
  perform test.ok((select count(*) from extraction_results where document_id = doc) = 1,
    'an extracted field is stored with its page, quote and box');

  -- A box is optional; a page and a quote are not.
  insert into extraction_results (org_id, document_id, field_path, value_json, confidence,
                                  source_page, source_quote, quote_verified,
                                  extractor, model_version, schema_version)
    values (org, doc, 'claim_id', '"APDP-99812"'::jsonb, 0.99, 1, 'Claim ID APDP-99812',
            true, 'claude-vision', 'claude-sonnet-5', '1.0.0');
  perform test.ok(
    (select source_bbox is null from extraction_results where field_path = 'claim_id'),
    'a field with no bounding box is still a valid extraction');

  perform test.expect_error(format(
    'insert into extraction_results (org_id, document_id, field_path, value_json, confidence,
        source_page, source_quote, extractor, model_version, schema_version)
     values (%L, %L, ''claim_id'', ''"X"''::jsonb, 0.9, 1, '''', ''e'', ''m'', ''1'')', org, doc),
    'violates check constraint', 'an extraction with no quote is rejected');

  perform test.expect_error(format(
    'insert into extraction_results (org_id, document_id, field_path, value_json, confidence,
        source_page, source_quote, extractor, model_version, schema_version)
     values (%L, %L, ''claim_id'', ''"X"''::jsonb, 0.9, 0, ''q'', ''e'', ''m'', ''1'')', org, doc),
    'violates check constraint', 'page numbers are 1-indexed, so 0 is rejected');

  perform test.expect_error(format(
    'insert into extraction_results (org_id, document_id, field_path, value_json, confidence,
        source_page, source_quote, source_bbox, extractor, model_version, schema_version)
     values (%L, %L, ''claim_id'', ''"X"''::jsonb, 0.9, 1, ''q'',
             array[0.9, 0.2, 0.1, 0.4]::numeric(6,5)[], ''e'', ''m'', ''1'')', org, doc),
    'violates check constraint', 'a box whose corners are inverted is rejected');

  perform test.expect_error(format(
    'insert into extraction_results (org_id, document_id, field_path, value_json, confidence,
        source_page, source_quote, source_bbox, extractor, model_version, schema_version)
     values (%L, %L, ''claim_id'', ''"X"''::jsonb, 0.9, 1, ''q'',
             array[0.1, 0.2, 0.3]::numeric(6,5)[], ''e'', ''m'', ''1'')', org, doc),
    'violates check constraint', 'a box without four corners is rejected');

  perform test.expect_error(format(
    'update extraction_results set value_json = ''999''::jsonb where document_id = %L', doc),
    'denied', 'an extraction cannot be edited: re-extracting writes a new row');

  -- Cost and latency are recorded for every call, not only decisions.
  insert into model_calls (org_id, purpose, provider, model_version, document_id, deduction_id,
                           input_tokens, output_tokens, cost_micros, latency_ms, outcome)
    values (org, 'extract', 'anthropic', 'claude-sonnet-5', doc, ded, 4210, 890, 12_700, 5400, 'ok');
  insert into model_calls (org_id, purpose, provider, model_version, document_id,
                           input_tokens, output_tokens, cost_micros, latency_ms, outcome)
    values (org, 'classify', 'anthropic', 'claude-haiku-4-5', doc, 1180, 24, 1_300, 900, 'ok');
  perform test.ok((select count(*) from model_calls where org_id = org) = 2,
    'every model call is recorded with its tokens, cost and latency');
  perform test.ok(
    (select sum(cost_micros) from model_calls where org_id = org) = 14_000,
    'per-case cost is a sum over model_calls');

  perform test.expect_error(format(
    'insert into model_calls (org_id, purpose, provider, model_version, latency_ms, outcome)
       values (%L, ''extract'', ''openai'', ''gpt'', 10, ''ok'')', org),
    'violates check constraint', 'an unknown provider cannot be recorded');

  -- Tenant isolation on the new tables.
  declare other jsonb;
  begin
    reset role;
    other := test.seed_org('extraction-other');
    set role app_rw;
    perform test.as_member((other->>'org')::uuid, (other->>'analyst')::uuid);
    perform test.ok((select count(*) from extraction_results) = 0,
      'extractions are invisible across tenants');
    perform test.ok((select count(*) from model_calls) = 0,
      'model calls are invisible across tenants');
    perform test.expect_error(format(
      'insert into document_pages (org_id, document_id, page_number) values (%L, %L, 2)',
      org, doc),
      'row-level security', 'a tenant cannot add pages to another tenant''s document');
  end;

  reset role;
end
$test$;
rollback;
