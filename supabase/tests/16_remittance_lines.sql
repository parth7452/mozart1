\echo '-- 16 a short-paid remittance line is a discovered deduction'
begin;
do $test$
declare
  ids jsonb; org uuid; analyst uuid; debtor uuid; ded uuid;
  n int; via text;
begin
  ids := test.seed_org('remittance');
  org := (ids->>'org')::uuid;
  analyst := (ids->>'analyst')::uuid;
  debtor := (ids->>'debtor')::uuid;

  -- ---------------------------------------------------------------------
  -- The columns exist, with the defaults that back-fill every existing row
  -- with what is true of it.
  -- ---------------------------------------------------------------------
  perform test.ok(
    (select column_default like '''notice''%' and is_nullable = 'NO'
       from information_schema.columns
      where table_name = 'deductions' and column_name = 'discovered_via'),
    'deductions.discovered_via is not null and defaults to notice — which is '
    'what every case opened before ADR 0026 was');

  perform test.ok(
    (select discovered_via from deductions where id = (ids->>'deduction')::uuid) = 'notice',
    'and the seeded case, opened without naming it, reads as notice-discovered');

  perform test.ok(
    (select count(*) from information_schema.columns
      where table_name = 'deductions'
        and column_name in ('invoice_number', 'reason_code_as_printed')
        and is_nullable = 'YES') = 2,
    'the invoice number and the printed reason code are nullable: most documents '
    'print neither, and an absent one must not be a stored empty string');

  perform test.ok(
    (select count(*) from pg_indexes
      where tablename = 'deductions' and indexname = 'deductions_org_invoice_idx') = 1,
    'and the dedup read has its partial index on (org_id, invoice_number)');

  perform test.ok(
    (select count(*) from information_schema.columns
      where table_name = 'org_settings'
        and column_name in ('remittance_tolerance_cents', 'remittance_tolerance_bps',
                            'remittance_dedup_days')) = 3,
    'org_settings carries the tolerance and the dedup window');

  perform test.ok(
    (select remittance_tolerance_cents = 500
        and remittance_tolerance_bps = 50
        and remittance_dedup_days = 30
       from org_settings where org_id = org),
    'a tenant that has never been configured gets $5.00 / 50bps / 30 days');

  set role app_rw;
  perform test.as_member(org, analyst);

  -- ---------------------------------------------------------------------
  -- discovered_via is a closed set. A case is named by a notice or by a
  -- remittance line; anything else is a value nothing counts.
  -- ---------------------------------------------------------------------
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, discovered_via, invoice_number,
                          reason_code_as_printed, retailer_name_as_printed)
  values (org, debtor, 'ACH-CW-880412:INV-271003', 80_000, current_date - 3,
          'remittance_line', 'INV-271003', 'OT-UNAUTH', 'Crosswind Grocery Distribution')
  returning id into ded;
  perform test.ok(ded is not null,
    'a case can be opened from a remittance line, with the invoice and the code as printed');

  perform test.expect_error(format(
    'insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                             discovered_via)
     values (%L, %L, ''X-1'', 1000, ''remittance_parse'')', org, debtor),
    'deductions_discovered_via_check',
    'and nothing else: remittance_parse is a channel-shaped answer to a '
    'document-kind question, and the check refuses it');

  -- The caps are why a pathological extraction cannot store a page in a column
  -- a view renders. The same argument migration 0015 made for the retailer name.
  perform test.expect_error(format(
    'insert into deductions (org_id, claim_id, deduction_amount_cents, invoice_number)
     values (%L, ''X-2'', 1000, repeat(''9'', 201))', org),
    'deductions_invoice_number_len',
    'an invoice number longer than the column stores is refused, never truncated');
  perform test.expect_error(format(
    'insert into deductions (org_id, claim_id, deduction_amount_cents,
                             reason_code_as_printed)
     values (%L, ''X-3'', 1000, repeat(''9'', 201))', org),
    'deductions_reason_code_as_printed_len',
    'and so is a reason code that is really a paragraph');

  -- ---------------------------------------------------------------------
  -- Invariant 7, in the direction ADR 0026 §3 argues for: a tolerance is a
  -- floor under what counts as a deduction at all, so LOWERING it files more
  -- cases and is the tightening. Raising it skips more short-pays silently.
  -- ---------------------------------------------------------------------
  update org_settings set remittance_tolerance_cents = 100,
                          remittance_tolerance_bps = 10
    where org_id = org;
  perform test.ok(
    (select remittance_tolerance_cents = 100 and remittance_tolerance_bps = 10
       from org_settings where org_id = org),
    'lowering a remittance tolerance opens more cases and needs no ceremony');

  perform test.expect_error(format(
    'update org_settings set remittance_tolerance_cents = 5000 where org_id = %L', org),
    'threshold loosening blocked',
    'raising the absolute tolerance is blocked: it stops cases being filed, '
    'and does it silently');
  perform test.expect_error(format(
    'update org_settings set remittance_tolerance_bps = 500 where org_id = %L', org),
    'threshold loosening blocked',
    'and so is raising the proportional one');

  -- Both at once, and the message names both rather than the first it met.
  perform test.expect_error(format(
    'update org_settings set remittance_tolerance_cents = 5000,
                             remittance_tolerance_bps = 500 where org_id = %L', org),
    'remittance_tolerance_cents, remittance_tolerance_bps',
    'a loosening of both names both, so nobody fixes one and re-runs into the other');

  -- The four the guard already had are untouched by 0021's replacement of it.
  perform test.expect_error(format(
    'update org_settings set auto_dispute_ceiling_cents = 500000 where org_id = %L', org),
    'threshold loosening blocked',
    'and replacing the function kept every comparison migration 0005 wrote');

  -- Loosening is possible, and only by naming the ADR that authorises it.
  perform set_config('app.threshold_loosening_adr', 'ADR-0026', true);
  update org_settings set remittance_tolerance_cents = 5000,
                          remittance_tolerance_bps = 500
    where org_id = org;
  perform test.ok(
    (select remittance_tolerance_cents = 5000 and remittance_tolerance_bps = 500
       from org_settings where org_id = org),
    'raising a tolerance succeeds when an authorising ADR is named');
  perform set_config('app.threshold_loosening_adr', '', true);

  -- ---------------------------------------------------------------------
  -- The dedup window is deliberately NOT in the guard (ADR 0026 §4): neither
  -- direction is the conservative one, and a guard that asserts a direction
  -- the mechanism does not have is worse than no guard. Both ways, no ADR.
  -- ---------------------------------------------------------------------
  update org_settings set remittance_dedup_days = 90 where org_id = org;
  perform test.ok((select remittance_dedup_days = 90 from org_settings where org_id = org),
    'lengthening the dedup window is not a threshold change');
  update org_settings set remittance_dedup_days = 7 where org_id = org;
  perform test.ok((select remittance_dedup_days = 7 from org_settings where org_id = org),
    'and neither is shortening it: it has no conservative direction to guard');

  -- ---------------------------------------------------------------------
  -- Nothing about `deductions` became append-only, and nothing about it lost
  -- a grant. It is a mutable projection of the event stream and stays one.
  -- ---------------------------------------------------------------------
  update deductions set state = 'classified' where id = ded;
  perform test.ok((select state from deductions where id = ded) = 'classified',
    'a remittance-originated case walks the same state machine as any other');

  -- The dedup query itself, as the store issues it: same org, same invoice,
  -- same exact amount, inside the window. The exactness is the point — a
  -- notice for $800 and a line for $150 on one invoice are two deductions.
  select count(*) into n from deductions
   where org_id = org and invoice_number = 'INV-271003'
     and deduction_amount_cents = 80_000
     and created_at >= now() - (30 * interval '1 day');
  perform test.ok(n = 1, 'the dedup read finds the case a second document would merge into');

  select count(*) into n from deductions
   where org_id = org and invoice_number = 'INV-271003'
     and deduction_amount_cents = 15_000
     and created_at >= now() - (30 * interval '1 day');
  perform test.ok(n = 0,
    'and does not find it for a different amount on the same invoice: those are '
    'two deductions, and merging them would drop one from the book');

  -- ---------------------------------------------------------------------
  -- A below-tolerance line is a decline with no case, which is the shape
  -- migration 0014 left room for on purpose (deduction_id is nullable).
  -- ---------------------------------------------------------------------
  insert into declined_candidates
    (org_id, discovered_from, reason, estimated_recoverable_cents,
     external_ids, decided_by, decided_by_version)
  values (org, 'web_upload', 'below_economic_floor', 312,
          '{"invoice_number": "INV-271041", "payment_reference": "ACH-CW-880412"}'::jsonb,
          'remittance_tolerance', '500c/50bps');
  perform test.ok(
    (select count(*) from declined_candidates
      where org_id = org and decided_by = 'remittance_tolerance') = 1,
    'a line under the floor is recorded with what it was worth: coverage has no '
    'numerator without it');

  reset role;
end
$test$;
rollback;
