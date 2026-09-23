\echo '-- 19 coverage has a denominator, and it says which channel each dollar came from'
begin;
do $test$
declare
  ids jsonb; org uuid; debtor uuid; analyst uuid; approver uuid;
  unknown_ded uuid;
  other_ids jsonb; other_org uuid; other_analyst uuid;
  erp_upload uuid; erp_doc uuid; erp_ded uuid; erp_dec uuid;
  web_upload_id uuid; web_doc uuid; web_ded uuid;
  n int; c numeric; cents_text text;
begin
  ids := test.seed_org('coveragedenominator');
  org := (ids->>'org')::uuid; debtor := (ids->>'debtor')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;
  -- seed_org's own case has no notice document at all. That is not a gap in the
  -- fixture: it is the third bucket this view has to have, and it is seeded
  -- first so the assertions below cannot accidentally pass by never meeting one.
  unknown_ded := (ids->>'deduction')::uuid;

  -- A case the ledger found and nobody had surfaced (ADR 0029): the arrival
  -- first, then the bytes, then the case, then the link that makes those bytes
  -- its notice. The channel is never passed to anything — it is on the uploads
  -- row and the view derives it back off the case's own notice.
  insert into uploads (org_id, source) values (org, 'erp_sync') returning id into erp_upload;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org, erp_upload, digest('ledger extract bytes', 'sha256'), 2048,
            'application/json', 'db://blob')
    returning id into erp_doc;
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, dispute_deadline, state)
    values (org, debtor, 'CLAIM-ERP-1', 500000, current_date - 20, current_date + 60,
            'awaiting_approval')
    returning id into erp_ded;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, erp_ded, erp_doc, 'notice');

  -- And one a person uploaded, so the two channels can be told apart rather
  -- than summed into a number that moves when the mix does.
  insert into uploads (org_id, source, created_by)
    values (org, 'web_upload', analyst) returning id into web_upload_id;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org, web_upload_id, digest('a scanned notice', 'sha256'), 4096,
            'application/pdf', 'db://blob')
    returning id into web_doc;
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, dispute_deadline, state)
    values (org, debtor, 'CLAIM-WEB-1', 250000, current_date - 5, current_date + 75,
            'analyst_review')
    returning id into web_ded;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, web_ded, web_doc, 'notice');

  -- A ledger candidate we declined that never became a case: deduction_id null,
  -- which is the shape triage produces in volume and the half of the
  -- denominator migration 0014 built (ADD-1).
  insert into declined_candidates
    (org_id, deduction_id, discovered_from, reason, estimated_recoverable_cents,
     external_ids, decided_by, decided_by_version)
  values (org, null, 'erp_sync', 'below_economic_floor', 4200,
          '{"ledger_invoice_id": "inv-tiny"}'::jsonb, 'triage-rules', 'triage-rules/v1');

  -- File the ERP case. The gate is exercised, not routed around: a decision
  -- prepared by the analyst, an approval by somebody else (separation of
  -- duties), and only then a submission — which is complete when written
  -- (ADR 0023, migration 0018).
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, erp_ded, 'B', '1.0.0', 'jev', 'jev-latest',
            digest('erp state', 'sha256'), '{"validity":"choice"}'::jsonb,
            '{"validity":"invalid_deduction"}'::jsonb,
            '{"validity":{"invalid_deduction":0.96,"valid":0.04}}'::jsonb,
            0.96, 180, analyst)
    returning id into erp_dec;
  -- The approver's own session: an approval in anybody else's name, or in
  -- nobody's, is refused (ADR 0040).
  perform test.as_member(org, approver);
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, erp_dec, approver, 'submit');
  perform test.as_nobody();
  insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                           confirmation_number, submitted_at)
    values (org, erp_ded, erp_dec, 'manual_portal', digest('filed packet', 'sha256'),
            'ERP-20001', now());

  -- Everything below reads as the application role, under the tenant's claims:
  -- both views are security_invoker, so this is the only way to read what a
  -- tenant would actually see.
  set role app_rw;
  perform test.as_member(org, analyst);

  select count(*) into n from coverage_by_period_by_source where org_id = org;
  perform test.ok(n = 3,
    'three channels answered: the ledger, a person, and the one nothing recorded');

  -- The ERP slice. Opened plus declined is the denominator; filed is the
  -- numerator; and the ratio is the view''s, not arithmetic done afterwards.
  -- (Here the only decline never became a case. A case opened and then
  -- declined is counted once, in opened — migration 0029, ADR 0038, suite 25.)
  select opened_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'erp_sync';
  perform test.ok(cents_text = '500000', 'the ledger case''s dollars are attributed to erp_sync');
  select declined_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'erp_sync';
  perform test.ok(cents_text = '4200',
    'and so are the dollars of a candidate that never became a case');
  select discovered_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'erp_sync';
  perform test.ok(cents_text = '504200', 'discovered is opened plus declined, exactly');
  select filed_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'erp_sync';
  perform test.ok(cents_text = '500000', 'filed is the deduction amount of the case we submitted');
  select coverage_of_discovered into c from coverage_by_period_by_source
   where org_id = org and discovered_from = 'erp_sync';
  perform test.ok(c = round(500000::numeric / 504200, 4),
    'and coverage of discovered is filed over discovered, to four places');

  -- The web slice: found, not fought. A channel with nothing filed reads zero
  -- rather than reading nothing, which is the whole difference this makes.
  select opened_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload';
  perform test.ok(cents_text = '250000', 'the uploaded case is its own channel''s dollars');
  select coverage_of_discovered into c from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload';
  perform test.ok(c = 0, 'a channel that found dollars and filed none reads zero, not null');

  -- The case with no notice document. Never guessed into a channel — a coverage
  -- number credited to a source that did not find the money reads exactly like
  -- one that did.
  select opened_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'unknown';
  perform test.ok(cents_text = '312000',
    'a case whose notice nothing recorded is reported under unknown');
  perform test.ok(
    (select count(*) from coverage_by_period_by_source
      where org_id = org and discovered_from = 'unknown') = 1,
    'as one bucket, not as a guess spread over the channels');

  -- The summed view agrees with the per-source view, column for column. If it
  -- ever does not, one of the two numbers is being published wrongly and there
  -- is no way to tell which from the outside.
  perform test.ok(
    (select discovered_cents from coverage_by_period_totals where org_id = org)
      = (select sum(discovered_cents) from coverage_by_period_by_source where org_id = org),
    'the tenant total is the sum of its channels');
  select discovered_cents::text into cents_text from coverage_by_period_totals where org_id = org;
  perform test.ok(cents_text = '1066200', 'which is every dollar we looked at this month');
  select coverage_of_discovered into c from coverage_by_period_totals where org_id = org;
  perform test.ok(c = round(500000::numeric / 1066200, 4),
    'and the blended rate is filed over all of it');

  -- Migration 0014''s view is untouched, and its number keeps its old meaning:
  -- filed over filed plus declined, which is coverage of what reached us and a
  -- different question. The totals view recomputes it to the same definition,
  -- so the two questions can be read off one row and compared.
  select coverage_of_seen into c from coverage_by_period where org_id = org;
  perform test.ok(c = round(500000::numeric / 504200, 4),
    'coverage_of_seen keeps its old meaning, which is why it keeps its old name');
  perform test.ok(
    c = (select coverage_of_seen from coverage_by_period_totals where org_id = org),
    'and the totals view agrees with it, to the digit');
  perform test.ok(
    c > (select coverage_of_discovered from coverage_by_period_totals where org_id = org),
    'while reading higher than the real one, which is the reason for this migration');
  perform test.ok(
    (select count(*) from information_schema.columns
      where table_name = 'coverage_by_period') = 7,
    'and migration 0014''s view still has exactly the seven columns it published');

  -- Another tenant sees none of these dollars. Both views are security_invoker,
  -- so this is RLS on deductions, submissions and declined_candidates answering
  -- through them.
  reset role;
  other_ids := test.seed_org('coveragedenominatorother');
  other_org := (other_ids->>'org')::uuid;
  other_analyst := (other_ids->>'analyst')::uuid;
  set role app_rw;
  perform test.as_member(other_org, other_analyst);

  select count(*) into n from coverage_by_period_by_source where org_id = org;
  perform test.ok(n = 0, 'another tenant sees no row of ours, per source');
  select count(*) into n from coverage_by_period_totals where org_id = org;
  perform test.ok(n = 0, 'nor summed');
  perform test.ok(
    (select coalesce(sum(filed_cents), 0) + coalesce(sum(declined_cents), 0)
       from coverage_by_period_totals) = 0,
    'and none of our filed or declined dollars reach their totals');
  -- What they do see is their own seeded case, under unknown — the view reads
  -- as the caller, and it reads for them too.
  perform test.ok(
    (select discovered_cents from coverage_by_period_by_source
      where org_id = other_org and discovered_from = 'unknown') = 312000,
    'they see their own, and only their own');

  reset role;
end
$test$;
rollback;
