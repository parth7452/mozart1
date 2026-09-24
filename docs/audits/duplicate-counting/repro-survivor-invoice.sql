\set ON_ERROR_STOP 1
begin;
create or replace function pg_temp.noticed_case(org uuid, source text, amount bigint, claim text,
                                                opened timestamptz default now())
  returns uuid language plpgsql as $$
declare up uuid; doc uuid; d uuid;
begin
  insert into uploads (org_id, source) values (org, source) returning id into up;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref, created_at)
    values (org, up, digest(claim || clock_timestamp()::text, 'sha256'), 4096, 'application/pdf', 'db://blob', opened)
    returning id into doc;
  insert into deductions (org_id, claim_id, deduction_amount_cents, deduction_date, state, created_at)
    values (org, claim, amount, date '2026-09-01', 'classified', opened) returning id into d;
  insert into deduction_documents (org_id, deduction_id, document_id, role) values (org, d, doc, 'notice');
  return d;
end $$;

do $$
declare s jsonb; org uuid; analyst uuid; a uuid; b uuid; v bigint; n int; rec record;
begin
  s := test.seed_org('dupa10'); org := (s->>'org')::uuid; analyst := (s->>'analyst')::uuid;
  perform test.as_member(org, analyst);
  a := pg_temp.noticed_case(org, 'web_upload', 50000, 'A-10', now() - interval '1 minute');
  -- recordIdentifiers for A
  insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
  values (org, a, 'web_upload', 'claim_id', 'A-10'), (org, a, 'web_upload', 'invoice_number', 'INV-3');
  b := pg_temp.noticed_case(org, 'web_upload', 50000, 'B-10');
  -- recordIdentifiers for B: invoice_number collides on (org, web_upload, invoice_number, INV-3) -> skipped
  insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
  select org, b, 'web_upload', k, i from (values ('claim_id','B-10'), ('invoice_number','INV-3')) t(k,i)
  on conflict (org_id, source, identifier_kind, identifier) do nothing;
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
  values (org, b, 'case.possible_duplicate', jsonb_build_object('of', a, 'basis', '[]'::jsonb), now());
  -- B is worked on (a human decision), so B outranks A and survives
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider, model_version,
                         input_state_hash, questions, result, raw_probabilities, confidence, latency_ms, prepared_by)
  values (org, b, 'B', '1.0.0', 'human', 'human', digest(b::text, 'sha256'), '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, 1, 0, analyst);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by) values
   (org, a, 'case.duplicate_confirmed', jsonb_build_object('of', b, 'verdict', 'same', 'newer_deduction_id', b), now(), analyst),
   (org, b, 'case.duplicate_confirmed', jsonb_build_object('of', a, 'verdict', 'same', 'newer_deduction_id', b), now(), analyst);
  raise notice 'S10 survivor = B: %', app.merge_survivor(a, b) = b;
  select event_id into v from duplicate_pair_verdicts where low_id in (a::text,b::text) and high_id in (a::text,b::text);
  insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id, action, state_before,
                                amount_cents, verdict_event_id, recorded_by)
  values (org, a, b, 'merge', 'classified', 50000, v, analyst);
  -- store.ts knownOpenDeductions, verbatim: the probable candidates a new notice for INV-3 is matched against
  for rec in
    select d.id, d.deduction_amount_cents,
           (select i.identifier from deduction_identifiers i
             where i.org_id = d.org_id and i.deduction_id = d.id and i.identifier_kind = 'invoice_number'
             order by i.first_seen_at asc, i.id asc limit 1) as invoice_number
      from deductions d
     where d.org_id = org and d.state <> all (array['won','lost','partial','written_off','merged'])
       and d.id in (a, b)
  loop
    raise notice 'S10 probable candidate % amount=% invoice_number=%', case when rec.id = b then 'B(survivor)' else 'A' end,
      rec.deduction_amount_cents, coalesce(rec.invoice_number, '<none>');
  end loop;
end $$;
rollback;
