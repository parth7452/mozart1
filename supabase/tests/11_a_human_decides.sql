\echo '-- 11 a human decides, and the gate still refuses everything it refused before'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; analyst uuid; approver uuid; debtor uuid;
  other_ids jsonb; other_org uuid; other_analyst uuid; other_ded uuid;
  second_analyst uuid; onlooker uuid; second_ded uuid; second_dec uuid;
  doc uuid; evidence_doc uuid; human_dec uuid; packet uuid; second_packet uuid;
  n int;
  hash bytea := digest('packet-canonical-contents', 'sha256');
  other_hash bytea := digest('a different packet', 'sha256');
begin
  ids := test.seed_org('humandecides');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;
  debtor := (ids->>'debtor')::uuid;

  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org, digest('notice bytes', 'sha256'), 4096, 'application/pdf', 'db://blob')
    returning id into doc;
  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org, digest('signed pod bytes', 'sha256'), 8192, 'application/pdf', 'db://blob')
    returning id into evidence_doc;

  -- A second analyst (who prepares nothing) and a read_only member. seed_org
  -- gives one of each of the two roles that matter to the gate; these are the
  -- two people the gate has to refuse for reasons other than "you prepared it".
  insert into users (email, full_name)
    values ('humandecides-analyst2@example.test', 'Second Analyst')
    returning id into second_analyst;
  insert into memberships (org_id, user_id, role) values (org, second_analyst, 'analyst');
  insert into users (email, full_name)
    values ('humandecides-readonly@example.test', 'Onlooker')
    returning id into onlooker;
  insert into memberships (org_id, user_id, role) values (org, onlooker, 'read_only');

  -- A second case in the same tenant, so "this packet is for that case" can be
  -- told apart from "this packet is for that tenant".
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, dispute_deadline, state)
    values (org, debtor, 'CLAIM-humandecides-2', 91500, current_date - 3,
            current_date + 87, 'classified')
    returning id into second_ded;

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

  -- Not-null is only half the rule. A human decision that names somebody else
  -- is a forged authorship in the one column separation of duties reads: name
  -- the approver and they are locked out of their own case; name a colleague
  -- and the real author may then approve their own decision. The database
  -- refuses it rather than leaving it to the store, which is code on the near
  -- side of the gate (ADR 0020 §1).
  perform test.expect_error(format(
    'insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
       model_version, input_state_hash, questions, result, raw_probabilities,
       confidence, latency_ms, cost_micros, prepared_by)
     values (%L, %L, ''B'', ''human-1'', ''human'', ''human'', %L,
             ''{}''::jsonb, ''{}''::jsonb, ''{}''::jsonb, 1.0000, 0, 0, %L)',
    org, ded, digest('state', 'sha256'), approver),
    'is not the caller',
    'an analyst cannot write a human decision naming somebody else as its preparer');

  perform test.expect_error(format(
    'insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
       model_version, input_state_hash, questions, result, raw_probabilities,
       confidence, latency_ms, cost_micros, prepared_by)
     values (%L, %L, ''B'', ''human-1'', ''human'', ''human'', %L,
             ''{}''::jsonb, ''{}''::jsonb, ''{}''::jsonb, 1.0000, 0, 0, %L)',
    org, ded, digest('state', 'sha256'), second_analyst),
    'is not the caller',
    'nor naming a colleague who could then be made to look like the author');

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
  perform test.ok(
    (select d.prepared_by from decisions d where d.id = human_dec) = analyst,
    'and the preparer it names is the caller who wrote it');

  -- The authorship trigger is scoped to human rows. A model decision made by a
  -- scheduled job has no caller to match, and pinning one here would break
  -- every provider row that is not a person.
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, second_ded, 'B', '1.0.0', 'jev', 'jev-latest',
            digest('state', 'sha256'), '{"validity":"choice"}'::jsonb,
            '{"validity":"invalid_deduction"}'::jsonb,
            '{"validity":{"invalid_deduction":0.97,"valid":0.03}}'::jsonb,
            0.97, 210, second_analyst)
    returning id into second_dec;
  perform test.ok(second_dec is not null,
    'a model decision may still name a preparer who is not the caller');

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

  -- The other half of `unique (decision_id, content_hash)`: identical contents
  -- are one packet, different contents are two. Re-assembling after the
  -- reviewer attaches another document has to be a new row, or there is no way
  -- to say which of them a later approval named.
  insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
                       file_document_ids, assembled_by)
    values (org, ded, human_dec, other_hash,
            'Claim CLAIM-humandecides is disputed in full; POD attached.',
            array[doc, evidence_doc], analyst)
    returning id into second_packet;
  perform test.ok(second_packet is not null and second_packet <> packet,
    'different contents for the same decision are a second packet, not a conflict');
  perform test.ok((select count(*) from packets where decision_id = human_dec) = 2,
    'and both of them are on the record');

  -- -------------------------------------------------------------------------
  -- A packet names one decision, on one deduction, in one org. The three
  -- foreign keys each say an id exists; none of them says they are the same
  -- case, and RLS asks only whether org_id is mine (ADR 0020 §2).
  -- -------------------------------------------------------------------------
  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''wrong case'', array[%L::uuid], %L)',
    org, second_ded, human_dec, digest('for the other case', 'sha256'), doc, analyst),
    'is for deduction',
    'a packet cannot hang a decision off a different case in the same tenant');

  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''no such decision'', array[%L::uuid], %L)',
    org, ded, gen_random_uuid(), digest('nothing decided this', 'sha256'), doc, analyst),
    'does not exist',
    'nor name a decision that does not exist');

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

  -- Nor can a colleague who prepared nothing. Separation of duties is two
  -- rules, and this is the one prepared_by does not cover: only owner and
  -- approver may approve at all. The colleague tries in their own name, because
  -- an approval naming anybody but its caller is refused before SoD sees it
  -- (ADR 0041, suite 27).
  perform test.as_member(org, second_analyst);
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
       values (%L, %L, %L, ''submit'', %L)', org, human_dec, second_analyst, hash),
    'is not an approver in org',
    'and an analyst who prepared nothing is still not an approver');

  -- Everything below is the approver, in their own session: the packet-hash
  -- refusals are a foreign key and a check constraint, which run after every
  -- before-insert trigger, so the row has to pass the caller check to reach
  -- them.
  perform test.as_member(org, approver);

  -- A packet_hash that names no packet is refused. Without the foreign key,
  -- 32 arbitrary bytes would read as an approval authorising a packet that was
  -- never assembled — a record of a human authorising nothing in particular.
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
       values (%L, %L, %L, ''submit'', %L)',
    org, human_dec, approver, digest('a packet nobody assembled', 'sha256')),
    'approvals_packet_is_a_real_packet',
    'an approval cannot name a packet hash no packet has');

  -- And not a packet assembled for some *other* decision either: the key is
  -- (decision_id, content_hash), not the hash on its own.
  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
       values (%L, %L, %L, ''submit'', %L)', org, second_dec, approver, hash),
    'approvals_packet_is_a_real_packet',
    'nor a packet that belongs to a different decision');

  insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
    values (org, human_dec, approver, 'submit', hash);
  perform test.ok(
    (select a.packet_hash from approvals a
      where a.decision_id = human_dec and a.action_type = 'submit') = hash,
    'an approval names the exact packet it approved');

  -- Null stays valid, which is why the foreign key is MATCH SIMPLE: a writeoff
  -- or writeback approval has no packet to name, and approvals written before
  -- migration 0016 have none either.
  insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
    values (org, human_dec, approver, 'writeoff', null);
  perform test.ok(
    (select a.packet_hash is null from approvals a
      where a.decision_id = human_dec and a.action_type = 'writeoff'),
    'an approval with no packet at all is still accepted');

  perform test.expect_error(format(
    'insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
       values (%L, %L, %L, ''writeback'', ''\x00''::bytea)', org, human_dec, approver),
    'approvals_packet_hash_is_sha256',
    'and a packet hash that is not a sha256 is refused');

  perform test.as_member(org, analyst);
  insert into submissions (org_id, deduction_id, decision_id, channel,
                           packet_hash, confirmation_number, submitted_at)
    values (org, ded, human_dec, 'manual_portal', hash, 'APDP-41007', now());
  perform test.ok((select count(*) from submissions where decision_id = human_dec) = 1,
    'and the submission is accepted once that approval exists');

  -- The database deliberately does NOT hold submissions.packet_hash equal to
  -- the approval's. `second_packet` was assembled for this decision and never
  -- approved, and a submission may name it: the gate's one rule is that an
  -- approval exists for this decision, and widening the trigger to compare
  -- hashes would put a second rule inside the function every invariant test is
  -- written against (ADR 0020 §2). The store is what refuses this, and this
  -- assertion is here so that the day the trigger grows the check, someone has
  -- to come and delete a test that says it was on purpose.
  insert into submissions (org_id, deduction_id, decision_id, channel,
                           packet_hash, confirmation_number, submitted_at)
    values (org, ded, human_dec, 'email', other_hash, 'APDP-41008', now());
  perform test.ok(
    (select s.packet_hash from submissions s
      where s.decision_id = human_dec and s.channel = 'email')
    <> (select a.packet_hash from approvals a
         where a.decision_id = human_dec and a.action_type = 'submit'),
    'the database permits a submission naming a packet the approval did not — the store refuses it');

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

  -- -------------------------------------------------------------------------
  -- Writing needs a writer, on packets as on everything else (ADR 0012). The
  -- grant is on the role the whole application shares, so the membership role
  -- is the only thing between a read_only member and an assembled packet.
  -- -------------------------------------------------------------------------
  perform test.as_member(org, onlooker);
  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''assembled by a spectator'', array[%L::uuid], %L)',
    org, ded, human_dec, digest('read_only tried', 'sha256'), doc, onlooker),
    'row-level security', 'a read_only member cannot assemble a packet');
  select count(*) into n from packets;
  perform test.ok(n = 2, 'though they can read the ones their tenant has');

  set role app_ro;
  perform test.as_member(org, analyst);
  select count(*) into n from packets;
  perform test.ok(n = 2, 'and app_ro reads packets under the same tenant policy');
  perform test.ok(not has_table_privilege('app_ro', 'packets', 'INSERT'),
    'while app_ro holds no INSERT on packets at all');
  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''read-only role'', array[%L::uuid], %L)',
    org, ded, human_dec, digest('app_ro tried', 'sha256'), doc, analyst),
    'denied', 'and is refused by the grant before any policy is consulted');

  set role app_rw;
  perform test.as_member(org, analyst);

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
  -- Truncating packets on its own no longer even reaches the trigger: since
  -- approvals.packet_hash became a foreign key onto this table, Postgres
  -- refuses to empty a table something still references. That is a second
  -- wall, not a replacement for the first, so the trigger is proved by
  -- naming both tables — which is the only way to get past the reference
  -- check, and still does not get past the trigger.
  perform test.expect_error(
    'truncate packets', 'referenced in a foreign key constraint',
    'and truncate is refused outright while an approval may reference a packet');
  perform test.expect_error(
    'truncate packets, approvals', 'append-only table packets',
    'and on truncate, by the trigger, even with the reference taken along');

  -- -------------------------------------------------------------------------
  -- Another tenant sees none of it.
  -- -------------------------------------------------------------------------
  other_ids := test.seed_org('humandecidesother');
  other_org := (other_ids->>'org')::uuid;
  other_analyst := (other_ids->>'analyst')::uuid;
  other_ded := (other_ids->>'deduction')::uuid;
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

  -- The one RLS does not catch, and the reason the trigger exists: every id
  -- here is this tenant's except the decision. `org_id` is mine, so the insert
  -- policy is satisfied; what comes out the far side would be an approval and a
  -- submission hung off a decision in a tenant that never made one.
  perform test.expect_error(format(
    'insert into packets (org_id, deduction_id, decision_id, content_hash, narrative,
       file_document_ids, assembled_by)
     values (%L, %L, %L, %L, ''someone else''''s decision'', array[%L::uuid], %L)',
    other_org, other_ded, human_dec, digest('borrowed decision', 'sha256'), doc,
    other_analyst),
    'belongs to another org',
    'and cannot assemble a packet in its own tenant against another tenant''s decision');

  reset role;
end
$test$;
rollback;
