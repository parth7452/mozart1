\echo '-- 25 coverage counts each deduction once: a declined case is found once, not twice'
begin;
do $test$
declare
  ids jsonb; org uuid; debtor uuid; analyst uuid; approver uuid;
  web_upload_id uuid; web_doc uuid; declined_case uuid;
  late_doc uuid; late_case uuid;
  erp_upload uuid; erp_doc uuid; erp_case uuid; erp_dec uuid;
  july timestamptz := date_trunc('month', now()) - interval '2 months';
  august timestamptz := date_trunc('month', now()) - interval '1 month';
  n int; c numeric; cents_text text;
begin
  ids := test.seed_org('coverageonce');
  org := (ids->>'org')::uuid; debtor := (ids->>'debtor')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;

  -- The case the bug was about: a person uploads a notice, a case opens, and a
  -- reviewer declines it. `declineCase` writes exactly this row — the case's
  -- own deduction_id and its full amount — and the case stays in deductions,
  -- because a decline is a fact about a case, not the removal of one.
  insert into uploads (org_id, source, created_by)
    values (org, 'web_upload', analyst) returning id into web_upload_id;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org, web_upload_id, digest('a notice we will not fight', 'sha256'), 4096,
            'application/pdf', 'db://blob')
    returning id into web_doc;
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, dispute_deadline, state)
    values (org, debtor, 'CLAIM-DECLINED-1', 250000, current_date - 5, current_date + 75,
            'analyst_review')
    returning id into declined_case;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, declined_case, web_doc, 'notice');
  insert into declined_candidates
    (org_id, deduction_id, discovered_from, provenance_kind, reason,
     estimated_recoverable_cents, decided_by, decided_by_version)
  values (org, declined_case, 'web_upload', 'observed', 'deduction_valid', 250000,
          'coverageonce-analyst@example.test', 'human');

  -- A ledger candidate declined at triage, which never became a case: this one
  -- IS part of the denominator, and must stay so.
  insert into declined_candidates
    (org_id, deduction_id, discovered_from, reason, estimated_recoverable_cents,
     external_ids, decided_by, decided_by_version)
  values (org, null, 'erp_sync', 'below_economic_floor', 4200,
          '{"ledger_invoice_id": "inv-tiny"}'::jsonb, 'triage-rules', 'triage-rules/v1');

  -- And a ledger case that was filed, through the gate, so the ratio has a
  -- numerator to be wrong about.
  insert into uploads (org_id, source) values (org, 'erp_sync') returning id into erp_upload;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org, erp_upload, digest('ledger extract, once', 'sha256'), 2048,
            'application/json', 'db://blob')
    returning id into erp_doc;
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, dispute_deadline, state)
    values (org, debtor, 'CLAIM-ERP-ONCE', 500000, current_date - 20, current_date + 60,
            'awaiting_approval')
    returning id into erp_case;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, erp_case, erp_doc, 'notice');
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, erp_case, 'B', '1.0.0', 'jev', 'jev-latest',
            digest('erp once state', 'sha256'), '{"validity":"choice"}'::jsonb,
            '{"validity":"invalid_deduction"}'::jsonb,
            '{"validity":{"invalid_deduction":0.96,"valid":0.04}}'::jsonb,
            0.96, 180, analyst)
    returning id into erp_dec;
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, erp_dec, approver, 'submit');
  insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                           confirmation_number, submitted_at)
    values (org, erp_case, erp_dec, 'manual_portal', digest('filed once', 'sha256'),
            'ONCE-1', now());

  -- A web case opened two months ago and declined last month: the clocks.
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org, web_upload_id, digest('an older notice', 'sha256'), 4096,
            'application/pdf', 'db://blob')
    returning id into late_doc;
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, dispute_deadline, state, created_at)
    values (org, debtor, 'CLAIM-DECLINED-LATER', 70000, (july + interval '3 days')::date,
            current_date + 30, 'analyst_review', july + interval '14 days')
    returning id into late_case;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, late_case, late_doc, 'notice');
  insert into declined_candidates
    (org_id, deduction_id, discovered_from, provenance_kind, reason,
     estimated_recoverable_cents, decided_by, decided_by_version, decided_at)
  values (org, late_case, 'web_upload', 'observed', 'evidence_unavailable', 70000,
          'coverageonce-analyst@example.test', 'human', august + interval '9 days');

  set role app_rw;
  perform test.as_member(org, analyst);

  -- =========================================================================
  -- The declined case is found once.
  -- =========================================================================
  select opened_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = date_trunc('month', now());
  perform test.ok(cents_text = '250000',
    'a case that was opened and then declined stays in opened — it was opened');
  select declined_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = date_trunc('month', now());
  perform test.ok(cents_text = '250000',
    'and its decline is still reported in declined — the counterfactual log does not lose it');
  select declined_count into n from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = date_trunc('month', now());
  perform test.ok(n = 1, 'counted as one decline');
  select discovered_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = date_trunc('month', now());
  perform test.ok(cents_text = '250000',
    format('but its dollars are discovered exactly once (saw %s; migration 0023 said 500000)',
           cents_text));
  select coverage_of_discovered into c from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = date_trunc('month', now());
  perform test.ok(c = 0, 'nothing filed from it, so coverage reads zero');

  -- =========================================================================
  -- A candidate that never became a case is still found.
  -- =========================================================================
  select discovered_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'erp_sync';
  perform test.ok(cents_text = '504200',
    'the ledger channel''s denominator is its case plus the candidate it declined at triage');
  select coverage_of_discovered into c from coverage_by_period_by_source
   where org_id = org and discovered_from = 'erp_sync';
  perform test.ok(c = round(500000::numeric / 504200, 4),
    'and its rate is filed over that, to four places, in the database');

  -- The rule, on every row: what was found beyond the cases opened is exactly
  -- the declines that never became a case. Asked of the view against the
  -- tables it reads, so a later body that drifts from it fails here.
  select count(*) into n
    from coverage_by_period_by_source v
   where v.org_id = org
     and v.discovered_cents - v.opened_cents
         <> coalesce((select sum(dc.estimated_recoverable_cents)
                        from declined_candidates dc
                       where dc.org_id = v.org_id
                         and dc.deduction_id is null
                         and dc.discovered_from = v.discovered_from
                         and date_trunc('month', dc.decided_at) = v.period), 0);
  perform test.ok(n = 0,
    'on every row, discovered minus opened is the declines that never became a case');

  -- =========================================================================
  -- The clocks: a later decline moves no month's denominator.
  -- =========================================================================
  select opened_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = july;
  perform test.ok(cents_text = '70000', 'the older case is found in the month it was opened');
  select discovered_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = july;
  perform test.ok(cents_text = '70000',
    'and that month''s denominator keeps it after the case is declined a month later');
  select declined_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = august;
  perform test.ok(cents_text = '70000', 'the decline is reported in the month it was decided');
  select discovered_cents::text into cents_text from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = august;
  perform test.ok(cents_text = '0',
    'and adds nothing to that month''s denominator: it was found in another');
  select coverage_of_discovered into c from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = august;
  perform test.ok(c is null, 'a month that found nothing has no rate, rather than a rate of zero');

  -- =========================================================================
  -- The totals follow, and coverage_of_seen keeps migration 0014's meaning.
  -- =========================================================================
  perform test.ok(
    (select discovered_cents from coverage_by_period_totals
      where org_id = org and period = date_trunc('month', now()))
      = (select sum(discovered_cents) from coverage_by_period_by_source
          where org_id = org and period = date_trunc('month', now())),
    'the tenant total is still the sum of its channels');
  -- 312000 (seed_org's case, no notice: unknown) + 250000 (declined, once)
  -- + 500000 (filed) + 4200 (declined at triage).
  select discovered_cents::text into cents_text from coverage_by_period_totals
   where org_id = org and period = date_trunc('month', now());
  perform test.ok(cents_text = '1066200', format(
    'which is every dollar found this month, each once (saw %s)', cents_text));

  -- Why declined_cents was not narrowed to the uncased declines (ADR 0038 §2):
  -- coverage_of_seen is computed from it, and declining a case must keep
  -- lowering it. Narrowed, this month would read 500000 / 504200.
  select coverage_of_seen into c from coverage_by_period_totals
   where org_id = org and period = date_trunc('month', now());
  perform test.ok(c = round(500000::numeric / (500000 + 250000 + 4200), 4), format(
    'coverage_of_seen still counts the declined case against what was fought (saw %s)', c));
  perform test.ok(
    c = (select coverage_of_seen from coverage_by_period
          where org_id = org and period = date_trunc('month', now())),
    'and agrees with migration 0014''s view to the digit, with a declined case present');
  perform test.ok(
    (select coverage_of_seen from coverage_by_period_totals where org_id = org and period = august)
      = (select coverage_of_seen from coverage_by_period where org_id = org and period = august),
    'including in a month whose only event is a case declined after it was found');

  reset role;

  -- =========================================================================
  -- The shape did not move.
  -- =========================================================================
  perform test.ok(
    (select array_agg(column_name::text || ':' || data_type::text order by ordinal_position)
       from information_schema.columns
      where table_schema = 'public' and table_name = 'coverage_by_period_by_source')
    = array['org_id:uuid', 'period:timestamp with time zone', 'discovered_from:text',
            'opened_count:bigint', 'opened_cents:bigint', 'filed_count:bigint',
            'filed_cents:bigint', 'declined_count:bigint', 'declined_cents:bigint',
            'discovered_cents:bigint', 'coverage_of_discovered:numeric'],
    'coverage_by_period_by_source has the columns, order and types migration 0023 published');
  perform test.ok(
    (select reloptions @> array['security_invoker=true'] from pg_class
      where oid = 'public.coverage_by_period_by_source'::regclass),
    'and still reads through the caller''s policies');
end
$test$;
rollback;
