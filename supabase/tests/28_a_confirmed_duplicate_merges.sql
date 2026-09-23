\echo '-- 28 a confirmed duplicate merges: one row, checked and projected by the database, undone once'
begin;

-- Asserts that `stmt` fails with this SQLSTATE and, when given, this HINT. The
-- merge's refusals are told apart by code and reason key, never by wording.
create or replace function test.expect_state(stmt text, state text, hint text, label text)
  returns void language plpgsql as $$
declare got_state text; got_hint text; msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate,
                            got_hint = pg_exception_hint,
                            msg = message_text;
    if got_state <> state or (hint is not null and got_hint is distinct from hint) then
      raise exception 'FAIL: % — expected % (%), got % (%): %',
        label, state, coalesce(hint, '-'), got_state, coalesce(got_hint, '-'), msg
        using errcode = 'assert_failure';
    end if;
    raise notice '  ok — % (% %)', label, got_state, coalesce(got_hint, '');
    return;
  end;
  raise exception 'FAIL: % — statement succeeded but should have been refused: %', label, stmt
    using errcode = 'assert_failure';
end
$$;

-- "Same deduction", the way the store writes it: one event on each case.
create or replace function test.confirm_pair(org uuid, a uuid, b uuid, who uuid)
  returns void language plpgsql as $$
begin
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org, a, 'case.duplicate_confirmed',
            jsonb_build_object('of', b, 'verdict', 'same', 'recorded_by', who), now(), who);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org, b, 'case.duplicate_confirmed',
            jsonb_build_object('of', a, 'verdict', 'same', 'recorded_by', who), now(), who);
end
$$;

create or replace function test.standing_verdict(a uuid, b uuid) returns bigint
  language sql as $$
  select v.event_id from duplicate_pair_verdicts v
   where v.low_id in (a::text, b::text) and v.high_id in (a::text, b::text);
$$;

-- A case with a notice that arrived through `source`, opened at `opened`.
create or replace function test.noticed_case(org uuid, source text, opened timestamptz,
                                              amount bigint, claim text)
  returns uuid language plpgsql as $$
declare up uuid; doc uuid; d uuid;
begin
  insert into uploads (org_id, source) values (org, source) returning id into up;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref, created_at)
    values (org, up, digest('notice ' || claim, 'sha256'), 4096, 'application/pdf', 'db://blob', opened)
    returning id into doc;
  insert into deductions (org_id, claim_id, deduction_amount_cents, state, created_at)
    values (org, claim, amount, 'classified', opened) returning id into d;
  insert into deduction_documents (org_id, deduction_id, document_id, role)
    values (org, d, doc, 'notice');
  return d;
end
$$;

-- Decided, approved and filed, through the gate, as the two people it takes.
create or replace function test.file_case(org uuid, d uuid, analyst uuid, approver uuid)
  returns void language plpgsql as $$
declare dec uuid;
begin
  perform test.as_member(org, analyst);
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, d, 'B', '1.0.0', 'jev', 'jev-latest', digest(d::text, 'sha256'),
            '{"validity":"choice"}'::jsonb, '{"validity":"invalid_deduction"}'::jsonb,
            '{"validity":{"invalid_deduction":0.9,"valid":0.1}}'::jsonb, 0.9, 100, analyst)
    returning id into dec;
  perform test.as_member(org, approver);
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit');
  insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                           confirmation_number, submitted_at)
    values (org, d, dec, 'manual_portal', digest('filed ' || d::text, 'sha256'),
            'MERGE-' || left(d::text, 8), now());
end
$$;

grant execute on all functions in schema test to app_rw, app_ro;

do $test$
declare
  a jsonb; org uuid; analyst uuid; approver uuid; filed_seed uuid;
  b jsonb; org_b uuid; analyst_b uuid; other_tenant_case uuid;
  reader uuid;
  july timestamptz := date_trunc('month', now()) - interval '2 months';
  august timestamptz := date_trunc('month', now()) - interval '1 month';
  case_a uuid; case_b uuid; case_c uuid; case_d uuid; case_f uuid;
  case_g uuid; case_h uuid; case_x uuid; case_y uuid; case_small uuid;
  verdict_id bigint; cents bigint; before_cents bigint; cols text[];
begin
  a := test.seed_org('mergea');
  org := (a->>'org')::uuid; analyst := (a->>'analyst')::uuid;
  approver := (a->>'approver')::uuid; filed_seed := (a->>'deduction')::uuid;
  b := test.seed_org('mergeb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;
  other_tenant_case := (b->>'deduction')::uuid;

  insert into users (email, full_name) values ('mergea-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org, reader, 'read_only');

  -- A: uploaded in July. B: the same deduction, emailed in August.
  case_a := test.noticed_case(org, 'web_upload', july, 100000, 'MRG-A');
  case_b := test.noticed_case(org, 'email_in', august, 100000, 'MRG-B');

  -- =========================================================================
  -- The catalogue
  -- =========================================================================
  perform test.ok(
    pg_get_constraintdef((select oid from pg_constraint
                           where conrelid = 'deductions'::regclass
                             and conname = 'deductions_state_check')) like '%''merged''%',
    'deductions_state_check admits merged');
  perform test.ok(
    (select count(*) from pg_constraint
      where conrelid = 'deductions'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%''evidence_pending''%') = 1,
    'and it is the only check on state');

  perform test.ok(
    (select relrowsecurity from pg_class where oid = 'deduction_merges'::regclass),
    'deduction_merges has RLS on');
  perform test.ok(
    not has_table_privilege('app_rw', 'deduction_merges', 'update')
      and not has_table_privilege('app_rw', 'deduction_merges', 'delete')
      and not has_table_privilege('app_rw', 'deduction_merges', 'truncate')
      and has_table_privilege('app_rw', 'deduction_merges', 'insert')
      and has_table_privilege('app_ro', 'deduction_merges', 'select')
      and not has_table_privilege('app_ro', 'deduction_merges', 'insert'),
    'app_rw may read and insert a merge and nothing else; app_ro may read');
  perform test.ok(
    (select count(*) from pg_trigger
      where tgrelid = 'deduction_merges'::regclass
        and tgname in ('no_update_delete', 'no_truncate')) = 2,
    'and the owner is held to append-only by block_mutations');
  perform test.ok(
    (select count(*) from pg_constraint
      where conrelid = 'deduction_merges'::regclass
        and conname in ('deduction_merges_merged_same_org', 'deduction_merges_surviving_same_org')
        and confrelid = 'deductions'::regclass
        and array_length(conkey, 1) = 2) = 2,
    'both sides are tied to the row''s tenant by a composite foreign key');

  perform test.ok(
    (select count(*) from pg_trigger t
      where t.tgname = 'refuse_work_on_merged_case'
        and t.tgfoid = 'app.refuse_work_on_merged_case()'::regprocedure
        and t.tgrelid in ('decisions'::regclass, 'packets'::regclass, 'submissions'::regclass,
                          'writeoffs'::regclass, 'writebacks'::regclass,
                          'declined_candidates'::regclass, 'deduction_documents'::regclass,
                          'deduction_identifiers'::regclass)) = 8,
    'the work refusal is on all eight tables that hang work on a case');

  perform test.ok(not has_function_privilege('public', 'app.merge_refusal(uuid, uuid)', 'execute')
      and has_function_privilege('app_rw', 'app.merge_refusal(uuid, uuid)', 'execute'),
    'the merge rules are app_rw''s to ask and not PUBLIC''s');
  perform test.ok(
    not exists (select 1 from pg_proc p
                 where p.pronamespace = 'app'::regnamespace
                   and p.proname in ('merge_work_rank', 'merge_survivor', 'merge_refusal',
                                     'check_deduction_merge', 'project_deduction_merge',
                                     'merged_state_is_a_projection', 'refuse_work_on_merged_case')
                   and p.prosecdef),
    'none of the merge functions is security definer: each reads the caller''s own tenant');

  select array_agg(column_name::text order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'coverage_by_period_by_source';
  perform test.ok(cols = array['org_id', 'period', 'discovered_from', 'opened_count',
                               'opened_cents', 'filed_count', 'filed_cents', 'declined_count',
                               'declined_cents', 'discovered_cents', 'coverage_of_discovered'],
    format('coverage_by_period_by_source keeps its columns (%s)', cols));

  -- =========================================================================
  -- Nothing merges without a person saying "same"
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org, analyst);

  perform test.ok(app.merge_refusal(case_a, case_b) = 'not_confirmed',
    'an unanswered pair is not_confirmed');
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''classified'', 100000, 1, %L)',
           org, case_b, case_a, analyst),
    'RCM02', 'not_confirmed', 'and the database refuses to merge it');

  perform test.confirm_pair(org, case_b, case_a, analyst);
  verdict_id := test.standing_verdict(case_a, case_b);
  perform test.ok(verdict_id is not null
      and (select v.verdict from duplicate_pair_verdicts v where v.event_id = verdict_id) = 'same',
    'a confirmation is the verdict standing on the pair');
  perform test.ok(app.merge_refusal(case_a, case_b) is null, 'and the pair may now be merged');
  perform test.ok(app.merge_survivor(case_a, case_b) = case_a,
    'neither was worked on, so the older one survives');

  -- =========================================================================
  -- The row must say what the database would
  -- =========================================================================
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''classified'', 100000, %s, %L)',
           org, case_b, case_a, verdict_id, approver),
    'RCM02', 'not_the_caller', 'a merge recorded in somebody else''s name is refused');
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''classified'', 100000, %s, %L)',
           org, case_a, case_b, verdict_id, analyst),
    'RCM02', 'wrong_survivor', 'the newer, unworked case does not survive');
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''decided'', 100000, %s, %L)',
           org, case_b, case_a, verdict_id, analyst),
    'RCM02', 'stale_state', 'the state it would restore must be the state it is in');
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''classified'', 99999, %s, %L)',
           org, case_b, case_a, verdict_id, analyst),
    'RCM02', 'amounts_disagree', 'the amount must be the amount, to the cent');
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''classified'', 100000, %s, %L)',
           org, case_b, case_a, verdict_id - 1, analyst),
    'RCM02', 'stale_verdict', 'and it must rest on the verdict standing on the pair');

  -- =========================================================================
  -- The state cannot move without the ledger
  -- =========================================================================
  perform test.expect_state(
    format('update deductions set state = ''merged'' where id = %L', case_b),
    'RCM03', null, 'a case cannot be moved to merged by hand');
  perform test.expect_state(
    format('insert into deductions (org_id, claim_id, deduction_amount_cents, state)
            values (%L, ''BORN-MERGED'', 100, ''merged'')', org),
    'RCM03', null, 'and a case cannot be opened merged');

  -- A read-only member reads the pair but cannot merge it.
  perform test.as_member(org, reader);
  perform test.expect_error(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''classified'', 100000, %s, %L)',
           org, case_b, case_a, verdict_id, reader),
    'row-level security', 'a read_only member may not merge');

  -- =========================================================================
  -- A merge: one row, and the database does the rest
  -- =========================================================================
  -- Coverage before: two deductions, under two channels, in two months.
  perform test.as_member(org, analyst);
  select opened_cents into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'email_in' and period = august;
  perform test.ok(cents = 100000, 'before the merge, the August email is counted under email_in');

  insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id, action,
                                state_before, amount_cents, verdict_event_id, recorded_by)
    values (org, case_b, case_a, 'merge', 'classified', 100000, verdict_id, analyst);

  perform test.ok((select state from deductions where id = case_b) = 'merged',
    'the loser is merged — moved by the database, not the caller');
  perform test.ok((select state from deductions where id = case_a) = 'classified',
    'and the survivor is where it was');
  perform test.ok(
    (select count(*) from deduction_events
      where deduction_id = case_b and event_type = 'case.merged_into'
        and payload->>'into' = case_a::text and created_by = analyst) = 1
    and (select count(*) from deduction_events
      where deduction_id = case_a and event_type = 'case.absorbed'
        and payload->>'from' = case_b::text and created_by = analyst) = 1,
    'both timelines say so, in the merging person''s name');
  perform test.ok(
    (select count(*) from deduction_merges_current
      where merged_deduction_id = case_b and surviving_deduction_id = case_a) = 1,
    'and the merge is current');

  select coalesce(sum(opened_cents), 0) into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'email_in' and period = august;
  perform test.ok(cents = 0, 'the copy leaves coverage');
  select opened_cents into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = july;
  perform test.ok(cents = 100000,
    'and the deduction is counted once, under the channel and month that found it first');
  select coalesce(sum(discovered_cents), 0) into cents from coverage_by_period_totals
   where org_id = org and period in (july, august);
  perform test.ok(cents = 100000, 'the totals count it once too');

  -- =========================================================================
  -- Nothing is hung on a merged-away case, and nothing moves it but an undo
  -- =========================================================================
  perform test.expect_state(
    format('insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
              model_version, input_state_hash, questions, result, raw_probabilities,
              confidence, latency_ms, prepared_by)
            values (%L, %L, ''B'', ''1.0.0'', ''jev'', ''jev-latest'', digest(''x'', ''sha256''),
                    ''{}''::jsonb, ''{}''::jsonb, ''{}''::jsonb, 0.5, 1, %L)',
           org, case_b, analyst),
    'RCM01', 'decisions', 'no decision on a merged-away case');
  perform test.expect_state(
    format('insert into declined_candidates (org_id, deduction_id, discovered_from, reason,
              estimated_recoverable_cents, decided_by, decided_by_version)
            values (%L, %L, ''email_in'', ''deduction_valid'', 100000, ''x'', ''human'')',
           org, case_b),
    'RCM01', 'declined_candidates', 'no decline');
  perform test.expect_state(
    format('insert into deduction_documents (org_id, deduction_id, document_id, role)
            select %L, %L, dd.document_id, ''evidence'' from deduction_documents dd
             where dd.deduction_id = %L limit 1', org, case_b, case_a),
    'RCM01', 'deduction_documents', 'no document');
  perform test.expect_state(
    format('insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
            values (%L, %L, ''web_upload'', ''claim_id'', ''MRG-B-LATE'')', org, case_b),
    'RCM01', 'deduction_identifiers', 'no identifier');
  perform test.expect_error(
    format('insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
              confirmation_number, submitted_at)
            select %L, %L, id, ''manual_portal'', digest(''m'', ''sha256''), ''M-1'', now()
              from decisions where deduction_id = %L limit 1', org, case_b, filed_seed),
    'blocked', 'a filing is refused by the approval gate first, in the gate''s own words');
  perform test.ok(
    (select count(*) from deduction_identifiers where deduction_id = case_a) = 0,
    '(the survivor is untouched by all of that)');

  perform test.expect_state(
    format('update deductions set state = ''classified'' where id = %L', case_b),
    'RCM03', null, 'a merged case cannot be moved out of merged by hand');

  -- One level only: a merged-away case cannot be merged again, and a case that
  -- absorbed another cannot be merged away until that is undone.
  case_x := test.noticed_case(org, 'web_upload', july - interval '1 month', 100000, 'MRG-X');
  case_y := test.noticed_case(org, 'email_body', august, 100000, 'MRG-Y');
  perform test.confirm_pair(org, case_x, case_a, analyst);
  perform test.confirm_pair(org, case_y, case_b, analyst);
  perform test.ok(app.merge_refusal(case_b, case_y) = 'already_merged',
    'a merged-away case cannot be merged into anything else');
  perform test.ok(app.merge_refusal(case_a, case_x) = 'absorbs_another',
    'and a case that absorbed another cannot itself be merged away');
  perform test.ok(app.merge_refusal(case_a, case_b) = 'already_merged',
    'nor can the same pair be merged twice');

  -- =========================================================================
  -- Other tenants
  -- =========================================================================
  perform test.ok(app.merge_refusal(case_a, other_tenant_case) = 'not_visible',
    'a pair reaching into another tenant is not visible');
  perform test.as_member(org_b, analyst_b);
  perform test.ok((select count(*) from deduction_merges) = 0,
    'another tenant sees none of this tenant''s merges');
  perform test.ok((select count(*) from deduction_merges_current) = 0,
    'nor which of its cases are merged');

  -- =========================================================================
  -- The undo: once, back where it was, and the verdict goes with it
  -- =========================================================================
  perform test.as_member(org, approver);
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, recorded_by) values (%L, %L, %L, ''unmerge'', %L)',
           org, case_a, case_b, approver),
    'RCM02', 'not_merged', 'an undo names the merge it undoes, the right way round');

  insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id, action,
                                recorded_by)
    values (org, case_b, case_a, 'unmerge', approver);

  perform test.ok((select state from deductions where id = case_b) = 'classified',
    'an undo puts the case back exactly where it was — any writer may do it');
  perform test.ok(
    (select count(*) from deduction_events
      where deduction_id in (case_a, case_b) and event_type = 'case.merge_undone') = 2
    and (select count(*) from deduction_events
      where deduction_id in (case_a, case_b)
        and event_type = 'case.duplicate_verdict_withdrawn'
        and payload->>'because' = 'merge_undone') = 2,
    'both timelines record the undo and the withdrawn verdict');
  perform test.ok(
    (select v.verdict from duplicate_pair_verdicts v
      where v.low_id in (case_a::text, case_b::text)
        and v.high_id in (case_a::text, case_b::text)) is null,
    'so the pair is an open question again rather than stuck');
  perform test.ok(not exists (select 1 from deduction_merges_current where merged_deduction_id = case_b),
    'and nothing is merged');

  select opened_cents into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'email_in' and period = august;
  perform test.ok(cents = 100000, 'coverage counts the two again');

  insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
    values (org, case_b, 'email_in', 'claim_id', 'MRG-B');
  perform test.ok(true, 'and work may be hung on it again');

  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, recorded_by) values (%L, %L, %L, ''unmerge'', %L)',
           org, case_b, case_a, approver),
    'RCM02', 'not_merged', 'a second undo is refused');

  -- Answered "same" again: the verdict stands, and the pair stays unmerged.
  perform test.confirm_pair(org, case_a, case_b, approver);
  perform test.ok(app.merge_refusal(case_a, case_b) = 'merged_before',
    'a pair is merged at most once, so it cannot flip back and forth');
  perform test.ok(app.merge_refusal(case_b, case_a) = 'merged_before',
    'whichever way round it is asked');
  perform test.expect_state(
    format('insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id,
              action, state_before, amount_cents, verdict_event_id, recorded_by)
            values (%L, %L, %L, ''merge'', ''classified'', 100000, %s, %L)',
           org, case_b, case_a, test.standing_verdict(case_a, case_b), approver),
    'RCM02', 'merged_before', 'and the database refuses the second merge');

  -- =========================================================================
  -- The survivor is the one somebody worked on; coverage credits the first copy
  -- =========================================================================
  perform test.as_member(org, analyst);
  reset role;
  case_c := test.noticed_case(org, 'email_in', july, 50000, 'MRG-C');
  case_d := test.noticed_case(org, 'web_upload', august, 50000, 'MRG-D');
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, case_d, 'B', '1.0.0', 'jev', 'jev-latest', digest('d', 'sha256'),
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.5, 1, analyst);
  update deductions set state = 'analyst_review' where id = case_d;
  set role app_rw;
  perform test.as_member(org, analyst);
  perform test.confirm_pair(org, case_c, case_d, analyst);

  perform test.ok(app.merge_survivor(case_c, case_d) = case_d,
    'the newer case survives when only it was worked on');
  select coalesce(sum(opened_cents), 0) into before_cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = august;
  insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id, action,
                                state_before, amount_cents, verdict_event_id, recorded_by)
    values (org, case_c, case_d, 'merge', 'classified', 50000,
            test.standing_verdict(case_c, case_d), analyst);
  perform test.ok((select state from deductions where id = case_d) = 'analyst_review',
    'the worked-on survivor keeps its state and its decision');
  select coalesce(sum(opened_cents), 0) into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'web_upload' and period = august;
  perform test.ok(before_cents - cents = 50000,
    'the survivor''s own August upload stops being credited with it');
  select opened_cents into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'email_in' and period = july;
  perform test.ok(cents = 50000,
    'it is counted under the first copy''s channel and month instead (ADR 0042 §8)');

  -- A filed case may absorb a copy, and the copy's decline leaves coverage.
  reset role;
  perform test.file_case(org, filed_seed, analyst, approver);
  case_f := test.noticed_case(org, 'email_in', august, 312000, 'MRG-F');
  perform test.as_member(org, analyst);
  insert into declined_candidates (org_id, deduction_id, discovered_from, provenance_kind,
                                   reason, estimated_recoverable_cents, decided_by,
                                   decided_by_version)
    values (org, case_f, 'email_in', 'observed', 'deduction_valid', 312000,
            'mergea-analyst@example.test', 'human');
  set role app_rw;
  perform test.confirm_pair(org, filed_seed, case_f, analyst);
  perform test.ok(app.merge_survivor(filed_seed, case_f) = filed_seed,
    'a filed case outranks a declined one');
  select coalesce(sum(declined_cents), 0) into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'email_in';
  perform test.ok(cents = 312000, 'before the merge, the copy''s decline is counted');
  insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id, action,
                                state_before, amount_cents, verdict_event_id, recorded_by)
    values (org, case_f, filed_seed, 'merge', 'classified', 312000,
            test.standing_verdict(filed_seed, case_f), analyst);
  perform test.ok((select state from deductions where id = case_f) = 'merged',
    'a declined copy merges into a filed survivor, and the survivor may be at any stage');
  select coalesce(sum(declined_cents), 0) into cents from coverage_by_period_by_source
   where org_id = org and discovered_from = 'email_in';
  perform test.ok(cents = 0, 'and its decline leaves coverage with it');

  -- Two filings: two disputes are live at the retailer, and only a person there
  -- can withdraw one.
  reset role;
  case_g := test.noticed_case(org, 'web_upload', august, 7000, 'MRG-G');
  case_h := test.noticed_case(org, 'web_upload', august, 7000, 'MRG-H');
  perform test.file_case(org, case_g, analyst, approver);
  perform test.file_case(org, case_h, analyst, approver);
  set role app_rw;
  perform test.as_member(org, analyst);
  perform test.confirm_pair(org, case_g, case_h, analyst);
  perform test.ok(app.merge_survivor(case_g, case_h) is null, 'two filed cases have no survivor');
  perform test.ok(app.merge_refusal(case_g, case_h) = 'both_filed', 'so the pair is refused as both_filed');

  -- Different amounts are two deductions until shown otherwise.
  case_small := test.noticed_case(org, 'web_upload', august, 99999, 'MRG-SMALL');
  perform test.confirm_pair(org, case_small, case_x, analyst);
  perform test.ok(app.merge_refusal(case_small, case_x) = 'amounts_disagree',
    'amounts one cent apart are refused as amounts_disagree');

  -- =========================================================================
  -- Append-only, for the owner too
  -- =========================================================================
  reset role;
  perform test.expect_error(
    format('update deduction_merges set action = ''unmerge'' where merged_deduction_id = %L', case_c),
    'append-only', 'the owner cannot edit a merge');
  perform test.expect_error(
    format('delete from deduction_merges where merged_deduction_id = %L', case_c),
    'append-only', 'or delete one');

  perform test.as_nobody();
end
$test$;
rollback;
