\echo '-- 11 a human decides, and the gate still refuses everything it refused before'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; analyst uuid; approver uuid;
  other_ids jsonb; other_org uuid; other_analyst uuid;
  doc uuid; human_dec uuid; packet uuid; n int;
  hash bytea := digest('packet-canonical-contents', 'sha256');
  other_hash bytea := digest('a different packet', 'sha256');
begin
  ids := test.seed_org('humandecides');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;

  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org, digest('notice bytes', 'sha256'), 4096, 'application/pdf', 'db://blob')
    returning id into doc;

  set role app_rw;
  perform test.as_member(org, analyst);

  -- -------------------------------------------------------------------------
  -- A human decision is a decisions row, and it must name its preparer.
  -- -------------------------------------------------------------------------
  perform test.expect_error(format(
    'insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
       model_version, input_state_hash, questions, result, raw_probabilities,
       confidence, latency_ms, cost_micros)
     values (%L, %L, ''B'', ''human-1'', ''human'', ''human'', %L,
             ''{"dispute_reason":"choice"}''::jsonb,
             ''{"dispute_reason":"shortage_never_received"}''::jsonb,
             ''{}''::jsonb, 1.0000, 0, 0)', org, ded, digest('state', 'sha256')),
    'decisions_human_names_its_preparer',
    'a human decision with no prepared_by is refused, because the SoD trigger reads it');

  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, cost_micros,
                         prepared_by)
    values (org, ded, 'B', 'human-1', 'human', 'human', digest('state', 'sha256'),
            '{"dispute_reason":"choice","rationale":"text"}'::jsonb,
            '{"dispute_reason":"shortage_never_received","rationale":"POD signed for full quantity"}'::jsonb,
            '{}'::jsonb, 1.0000, 0, 0, analyst)
    returning id into human_dec;
  perform test.ok(human_dec is not null,
    'a human decision naming its preparer is an ordinary decisions row');

  perform test.expect_error(format(
    'insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
       model_version, input_state_hash, questions, result, raw_probabilities,
       confidence, latency_ms, prepared_by)
     values (%L, %L, ''B'', ''human-1'', ''telepath'', ''human'', %L,
             ''{}''::jsonb, ''{}''::jsonb, ''{}''::jsonb, 1.0000, 0, %L)',
    org, ded, digest('state', 'sha256'), analyst),
    'decisions_provider_check',
    'and a provider we have not thought about is still refused');

  -- -------------------------------------------------------------------------
  -- The packet: recorded, hashed, append-only.
  -- -------------------------------------------------------------------------
  insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
                       file_document_ids, assembled_by)
    values (org, ded, human_dec, hash, 'Claim CLAIM-humandecides is disputed in full.',
            array[doc], analyst)
    returning id into packet;
  perform test.ok(packet is not null, 'a packet is recorded against its decision');

  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''same contents again'', array[%L::uuid], %L)',
    org, ded, human_dec, hash, doc, analyst),
    'duplicate key',
    'assembling the same contents twice is refused by the database, not by a convention');

  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''no documents'', ''{}''::uuid[], %L)',
    org, ded, human_dec, other_hash, analyst),
    'check constraint', 'a packet with no documents in it is refused');

  -- -------------------------------------------------------------------------
  -- The gate is unchanged: no submission without an approval for that decision.
  -- -------------------------------------------------------------------------
  perform test.expect_error(format(
    'insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash)
       values (%L, %L, %L, ''manual_portal'', %L)', org, ded, human_dec, hash),
    'no submit approval row',
    'a human decision with a packet still cannot be submitted without an approval');

  -- -------------------------------------------------------------------------
  -- Separation of duties applies to a human decision exactly as it does to a
  -- model one. This is what prepared_by being not null buys.
  -- -------------------------------------------------------------------------
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
       values (%L, %L, %L, ''submit'', %L)', org, human_dec, analyst, hash),
    'cannot approve their own decision',
    'the analyst who decided cannot approve their own human decision');

  insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
    values (org, human_dec, approver, 'submit', hash);
  perform test.ok(
    (select a.packet_hash from approvals a where a.decision_id = human_dec) = hash,
    'an approval names the exact packet it approved');

  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
       values (%L, %L, %L, ''submit'', ''\x00''::bytea)', org, human_dec, approver),
    'approvals_packet_hash_is_sha256',
    'and a packet hash that is not a sha256 is refused');

  insert into submissions (org_id, deduction_id, decision_id, channel,
                           packet_hash, confirmation_number, submitted_at)
    values (org, ded, human_dec, 'manual_portal', hash, 'APDP-41007', now());
  perform test.ok((select count(*) from submissions where decision_id = human_dec) = 1,
    'and the submission is accepted once that approval exists');

  -- The outcome is an event and a state, not a table.
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (org, ded, 'outcome.recorded',
            jsonb_build_object('outcome', 'partial', 'recovered_cents', 180000,
                               'recorded_by', approver),
            now(), approver);
  update deductions set state = 'partial' where id = ded;
  perform test.ok((select state from deductions where id = ded) = 'partial',
    'an outcome is an append-only event plus the case-state projection');

  -- -------------------------------------------------------------------------
  -- packets is append-only, and app_rw holds nothing that could change one.
  -- -------------------------------------------------------------------------
  perform test.expect_error(format(
    'update packets set narrative = ''rewritten'' where id = %L', packet),
    'denied', 'app_rw cannot rewrite a packet');
  perform test.expect_error(format(
    'delete from packets where id = %L', packet),
    'denied', 'nor delete one');

  perform test.ok(not has_table_privilege('app_rw', 'packets', 'UPDATE'),
    'app_rw holds no UPDATE on packets');
  perform test.ok(not has_table_privilege('app_rw', 'packets', 'DELETE'),
    'app_rw holds no DELETE on packets');
  perform test.ok(not has_table_privilege('app_rw', 'approvals', 'UPDATE'),
    'app_rw holds no UPDATE on approvals');
  perform test.ok(not has_table_privilege('app_rw', 'approvals', 'DELETE'),
    'app_rw holds no DELETE on approvals');
  perform test.ok(has_table_privilege('app_rw', 'packets', 'INSERT')
              and has_table_privilege('app_rw', 'packets', 'SELECT'),
    'app_rw holds exactly insert and select on packets');

  -- The grants are the outer wall; the trigger is the inner one, and it does
  -- not care who is asking. The owner of the table is refused too.
  reset role;
  perform test.expect_error(format(
    'update packets set narrative = ''rewritten by the owner'' where id = %L', packet),
    'append-only table packets',
    'and the table owner is refused by the trigger, not merely by a grant');
  perform test.expect_error(format(
    'delete from packets where id = %L', packet),
    'append-only table packets', 'on delete as well');
  perform test.expect_error(
    'truncate packets', 'append-only table packets', 'and on truncate');

  -- -------------------------------------------------------------------------
  -- Another tenant sees none of it.
  -- -------------------------------------------------------------------------
  other_ids := test.seed_org('humandecidesother');
  other_org := (other_ids->>'org')::uuid;
  other_analyst := (other_ids->>'analyst')::uuid;
  set role app_rw;
  perform test.as_member(other_org, other_analyst);
  select count(*) into n from packets;
  perform test.ok(n = 0, 'another tenant sees no packets');
  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''poached'', array[%L::uuid], %L)',
    org, ded, human_dec, other_hash, doc, other_analyst),
    'row-level security', 'and cannot write a packet into someone else''s tenant');

  reset role;
end
$test$;
rollback;
