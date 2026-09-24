-- Double-count audit repros. Runs in one transaction and rolls back.
\set ON_ERROR_STOP 1
begin;

create or replace function pg_temp.noticed_case(org uuid, source text, amount bigint, claim text,
                                                via text default 'notice', opened timestamptz default now())
  returns uuid language plpgsql as $$
declare up uuid; doc uuid; d uuid;
begin
  insert into uploads (org_id, source) values (org, source) returning id into up;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref, created_at)
    values (org, up, digest('notice ' || coalesce(claim, gen_random_uuid()::text) || clock_timestamp()::text, 'sha256'), 4096,
            'application/pdf', 'db://blob', opened)
    returning id into doc;
  insert into deductions (org_id, claim_id, deduction_amount_cents, state, discovered_via, created_at)
    values (org, claim, amount, 'classified', via, opened) returning id into d;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, d, doc, 'notice');
  return d;
end $$;

create or replace function pg_temp.ident(org uuid, d uuid, src text, kind text, ident text)
  returns void language sql as $$
  insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
  values (org, d, src, kind, ident);
$$;

-- What openCase / recordLedgerCase write for a probable match.
create or replace function pg_temp.pair_named(org uuid, newer uuid, older uuid)
  returns void language sql as $$
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
  values (org, newer, 'case.possible_duplicate',
          jsonb_build_object('of', older, 'basis', '["invoice_number","amount_cents","deduction_date"]'::jsonb), now());
$$;

-- What recordDuplicateVerdict writes for "same".
create or replace function pg_temp.confirm(org uuid, older uuid, newer uuid, who uuid)
  returns void language plpgsql as $$
begin
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
  values (org, older, 'case.duplicate_confirmed',
          jsonb_build_object('of', newer, 'verdict', 'same', 'older_deduction_id', older,
                             'newer_deduction_id', newer, 'surviving_deduction_id', older,
                             'recorded_by', who), now(), who);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
  values (org, newer, 'case.duplicate_confirmed',
          jsonb_build_object('of', older, 'verdict', 'same', 'older_deduction_id', older,
                             'newer_deduction_id', newer, 'surviving_deduction_id', older,
                             'recorded_by', who), now(), who);
end $$;

create or replace function pg_temp.merge(org uuid, a uuid, b uuid, who uuid)
  returns text language plpgsql as $$
declare surv uuid; loser uuid; st text; amt bigint; v bigint; why text;
begin
  why := app.merge_refusal(a, b);
  if why is not null then return 'refused: ' || why; end if;
  surv := app.merge_survivor(a, b);
  loser := case when surv = a then b else a end;
  select state, deduction_amount_cents into st, amt from deductions where id = loser;
  select event_id into v from duplicate_pair_verdicts
   where low_id in (a::text, b::text) and high_id in (a::text, b::text);
  insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id, action,
                                state_before, amount_cents, verdict_event_id, recorded_by)
  values (org, loser, surv, 'merge', st, amt, v, who);
  return 'merged ' || left(loser::text, 8) || ' into ' || left(surv::text, 8);
end $$;

-- coverage view, one org, summed over months
create or replace function pg_temp.cov(org uuid)
  returns table (discovered_from text, opened_count bigint, opened_cents bigint,
                 declined_count bigint, declined_cents bigint, discovered_cents bigint)
  language sql as $$
  select discovered_from, sum(opened_count)::bigint, sum(opened_cents)::bigint,
         sum(declined_count)::bigint, sum(declined_cents)::bigint, sum(discovered_cents)::bigint
    from coverage_by_period_by_source where org_id = org
   group by discovered_from order by discovered_from;
$$;

-- coverage.ts NEWER_HALVES, verbatim apart from the window filter
create or replace function pg_temp.counted_twice(org uuid)
  returns table (id uuid, amount bigint) language sql as $$
  with standing as (
    select v.event_id from duplicate_pair_verdicts v
     where v.org_id = org and v.verdict = 'same'
       and not exists (select 1 from deduction_merges_current c
                        where c.merged_deduction_id::text in (v.low_id, v.high_id))),
  newer as (
    select distinct (e.payload->>'newer_deduction_id')::uuid as deduction_id
      from standing s join deduction_events e on e.id = s.event_id
     where e.payload ? 'newer_deduction_id')
  select d.id, d.deduction_amount_cents from newer n join deductions d on d.id = n.deduction_id;
$$;

-- workflow.ts possibleDuplicates' `named` + filters, pairs touching `d`
create or replace function pg_temp.pairs_listed(org uuid, d uuid)
  returns bigint language sql as $$
  with named as (
    select e.deduction_id::text as side_a, lower(e.payload->>'of') as side_b
      from deduction_events e
     where e.org_id = org and e.event_type = 'case.possible_duplicate' and e.payload->>'of' is not null)
  select count(*) from named n
   where (n.side_a = d::text or n.side_b = d::text)
     and not exists (select 1 from duplicate_pair_verdicts v where v.verdict is not null
                      and v.low_id in (n.side_a, n.side_b) and v.high_id in (n.side_a, n.side_b))
     and not exists (select 1 from deduction_merges_current m
                      where m.merged_deduction_id::text in (n.side_a, n.side_b));
$$;

do $$
declare
  s jsonb; org uuid; analyst uuid; approver uuid;
  n uuid; r uuid; a uuid; b uuid; c uuid; x uuid; y uuid; l uuid;
  r_line uuid; msg text; rec record;
begin
  -- ===================== S1/S2: remittance-probable pair (d) + ledger ambiguous ============
  s := test.seed_org('dupa1'); org := (s->>'org')::uuid;
  analyst := (s->>'analyst')::uuid; approver := (s->>'approver')::uuid;
  perform test.as_member(org, analyst);

  n := pg_temp.noticed_case(org, 'web_upload', 100000, 'N-1');
  perform pg_temp.ident(org, n, 'web_upload', 'claim_id', 'N-1');
  perform pg_temp.ident(org, n, 'web_upload', 'invoice_number', 'INV-1');
  -- remittance line: openCaseForLine writes claim_id + invoice_number and records the
  -- probable match ONLY as case.discovered.probable_duplicate_of (steps.ts:1739-1748)
  r := pg_temp.noticed_case(org, 'email_in', 100000, 'PAY9:INV-1', 'remittance_line');
  perform pg_temp.ident(org, r, 'email_in', 'claim_id', 'PAY9:INV-1');
  perform pg_temp.ident(org, r, 'email_in', 'invoice_number', 'INV-1');
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
  values (org, r, 'case.discovered',
          jsonb_build_object('discovered_via', 'remittance_line',
                             'probable_duplicate_of', jsonb_build_array(n)), now());

  raise notice 'S1 (d) pairs listed for R: %, merge_refusal(N,R): %, counted_twice rows: %',
    pg_temp.pairs_listed(org, r), app.merge_refusal(n, r),
    (select count(*) from pg_temp.counted_twice(org));

  -- ledger sync for INV-1: arrival identifiers ledger_invoice_id=71, invoice_number=INV-1
  -- exact-match N and R on invoice_number -> ambiguous -> declineCandidate(duplicate_of_other),
  -- deduction_id null, estimated = gap (discovery.ts:620-634)
  insert into declined_candidates (org_id, deduction_id, discovered_from, reason,
     estimated_recoverable_cents, external_ids, decided_by, decided_by_version, detail)
  values (org, null, 'erp_sync', 'duplicate_of_other', 100000,
          '{"ledger_invoice_id":"71","invoice_number":"INV-1"}', 'triage-rules', 'triage-rules/v1',
          'matches more than one deduction we already hold');

  for rec in select * from pg_temp.cov(org) loop
    raise notice 'S1/S2 cov % opened=%/% declined=%/% discovered=%', rec.discovered_from,
      rec.opened_count, rec.opened_cents, rec.declined_count, rec.declined_cents, rec.discovered_cents;
  end loop;

  -- ===================== S3: below-tolerance remittance line + ledger case (e) ============
  s := test.seed_org('dupa3'); org := (s->>'org')::uuid;
  analyst := (s->>'analyst')::uuid;
  perform test.as_member(org, analyst);
  -- $30 short on a $10,000 invoice: under 50 bps -> recordDeclinedLine (store.ts:2317), no identifiers
  insert into declined_candidates (org_id, deduction_id, discovered_from, provenance_kind, reason,
     estimated_recoverable_cents, external_ids, decided_by, decided_by_version, missing_evidence, detail)
  values (org, null, 'email_in', 'observed', 'below_economic_floor', 3000,
          '{"invoice_number":"INV-2","payment_reference":"PAY7"}', 'remittance_tolerance', '500c/50bps', '{}', 'under floor');
  -- ledger: gap 3000 >= 2500 floor, no identifier anywhere names INV-2 -> none -> opens erp_sync case
  l := pg_temp.noticed_case(org, 'erp_sync', 3000, null, 'notice');
  perform pg_temp.ident(org, l, 'erp_sync', 'ledger_invoice_id', '88');
  perform pg_temp.ident(org, l, 'erp_sync', 'invoice_number', 'INV-2');
  -- the same advice arrives again as different bytes (scan / re-send): declined again, no dedup
  insert into declined_candidates (org_id, deduction_id, discovered_from, provenance_kind, reason,
     estimated_recoverable_cents, external_ids, decided_by, decided_by_version, missing_evidence, detail)
  values (org, null, 'web_upload', 'observed', 'below_economic_floor', 3000,
          '{"invoice_number":"INV-2","payment_reference":"PAY7"}', 'remittance_tolerance', '500c/50bps', '{}', 'under floor');
  for rec in select * from pg_temp.cov(org) loop
    raise notice 'S3 cov % opened=%/% declined=%/% discovered=%', rec.discovered_from,
      rec.opened_count, rec.opened_cents, rec.declined_count, rec.declined_cents, rec.discovered_cents;
  end loop;

  -- ===================== S5: transitive chain A-B merged, B-C confirmed (b) ===============
  s := test.seed_org('dupa5'); org := (s->>'org')::uuid;
  analyst := (s->>'analyst')::uuid;
  perform test.as_member(org, analyst);
  a := pg_temp.noticed_case(org, 'web_upload', 50000, 'A-1', 'notice', now() - interval '10 minutes');
  b := pg_temp.noticed_case(org, 'email_in',   50000, 'B-1', 'notice', now() - interval '5 minutes');
  c := pg_temp.noticed_case(org, 'erp_sync',   50000, null,  'notice', now());
  perform pg_temp.pair_named(org, b, a);
  perform pg_temp.pair_named(org, c, b);
  perform pg_temp.confirm(org, a, b, analyst);
  raise notice 'S5 merge A,B: %', pg_temp.merge(org, a, b, analyst);
  perform pg_temp.confirm(org, b, c, analyst);   -- "same" on B-C (or confirmed before the merge)
  raise notice 'S5 merge B,C: % | merge A,C: % | pairs listed for C: % | counted_twice rows: %',
    pg_temp.merge(org, b, c, analyst), app.merge_refusal(a, c),
    pg_temp.pairs_listed(org, c), (select count(*) from pg_temp.counted_twice(org));
  for rec in select * from pg_temp.cov(org) loop
    raise notice 'S5 cov % opened=%/% discovered=%', rec.discovered_from,
      rec.opened_count, rec.opened_cents, rec.discovered_cents;
  end loop;

  -- ===================== S7: confirmed, not merged (amounts_disagree) -> shown ===========
  s := test.seed_org('dupa7'); org := (s->>'org')::uuid;
  analyst := (s->>'analyst')::uuid;
  perform test.as_member(org, analyst);
  x := pg_temp.noticed_case(org, 'web_upload', 70000, 'X-1', 'notice', now() - interval '1 minute');
  y := pg_temp.noticed_case(org, 'email_in',   70001, 'Y-1');
  perform pg_temp.pair_named(org, y, x);
  perform pg_temp.confirm(org, x, y, analyst);
  raise notice 'S7 merge: % | counted_twice: %', pg_temp.merge(org, x, y, analyst),
    (select string_agg(amount::text, ',') from pg_temp.counted_twice(org));

  -- ===================== S8: decline-as-duplicate, then merge ============================
  s := test.seed_org('dupa8'); org := (s->>'org')::uuid;
  analyst := (s->>'analyst')::uuid;
  perform test.as_member(org, analyst);
  x := pg_temp.noticed_case(org, 'web_upload', 40000, 'P-1', 'notice', now() - interval '1 minute');
  y := pg_temp.noticed_case(org, 'email_in',   40000, 'Q-1');
  perform pg_temp.pair_named(org, y, x);
  -- reviewer uses the decline reason "Same deduction, already handled" on the newer copy
  insert into declined_candidates (org_id, deduction_id, discovered_from, provenance_kind, reason,
     estimated_recoverable_cents, decided_by, decided_by_version, missing_evidence)
  values (org, y, 'email_in', 'observed', 'duplicate_of_other', 40000, analyst::text, 'human/v1', '{}');
  for rec in select * from pg_temp.cov(org) loop
    raise notice 'S8 after decline cov % opened=%/% declined=%/% discovered=%', rec.discovered_from,
      rec.opened_count, rec.opened_cents, rec.declined_count, rec.declined_cents, rec.discovered_cents;
  end loop;
  perform pg_temp.confirm(org, x, y, analyst);
  raise notice 'S8 survivor is the declined copy: % | %',
    app.merge_survivor(x, y) = y, pg_temp.merge(org, x, y, analyst);
  raise notice 'S8 queued after merge (not closed, not declined): %',
    (select count(*) from deductions d where d.org_id = org and d.state not in
       ('submitted','won','lost','partial','written_off','merged')
       and not exists (select 1 from declined_candidates k where k.deduction_id = d.id)
       and d.claim_id in ('P-1','Q-1'));
  raise notice 'S8 0014 coverage_by_period declined (org): % | 0032 view declined: %',
    (select sum(declined_cents) from coverage_by_period where org_id = org),
    (select sum(declined_cents) from coverage_by_period_by_source where org_id = org);
end $$;

-- S9: 0014's coverage_by_period still counts a merged-away case's pre-merge decline
do $$
declare s jsonb; org uuid; analyst uuid; x uuid; y uuid;
begin
  s := test.seed_org('dupa9'); org := (s->>'org')::uuid; analyst := (s->>'analyst')::uuid;
  perform test.as_member(org, analyst);
  x := pg_temp.noticed_case(org, 'web_upload', 20000, 'S9-A', 'notice', now() - interval '1 minute');
  y := pg_temp.noticed_case(org, 'email_in',   20000, 'S9-B');
  perform pg_temp.pair_named(org, y, x);
  insert into declined_candidates (org_id, deduction_id, discovered_from, reason, estimated_recoverable_cents,
     decided_by, decided_by_version) values
    (org, x, 'web_upload', 'deadline_passed', 20000, analyst::text, 'human/v1'),
    (org, y, 'email_in', 'duplicate_of_other', 20000, analyst::text, 'human/v1');
  perform pg_temp.confirm(org, x, y, analyst);
  raise notice 'S9 %', pg_temp.merge(org, x, y, analyst);
  raise notice 'S9 0014 coverage_by_period.declined_cents=% | 0032 view declined_cents=% (loser excluded)',
    (select sum(declined_cents) from coverage_by_period where org_id = org),
    (select sum(declined_cents) from coverage_by_period_by_source where org_id = org);
end $$;

rollback;
