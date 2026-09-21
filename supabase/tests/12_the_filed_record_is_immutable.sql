\echo '-- 12 the record of what was filed is immutable, and the gate still runs on update'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; dec uuid; analyst uuid; approver uuid;
  sub uuid; unapproved_dec uuid; wb uuid; wo uuid;
  hash bytea := digest('the packet that was filed', 'sha256');
  other_hash bytea := digest('some other packet', 'sha256');
  filed_at timestamptz := now() - interval '2 days';
  pinned text[];
begin
  ids := test.seed_org('filedrecord');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid; dec := (ids->>'decision')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;

  -- A second decision on the same deduction that nobody ever approved, so the
  -- gate has something to refuse on UPDATE.
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, ded, 'B', '1.0.0', 'jev', 'jev-latest', digest('unapproved', 'sha256'),
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.51, 10, analyst)
    returning id into unapproved_dec;

  -- The approvals that let the three gated tables be written at all. Inserted
  -- as the owner because separation of duties refuses an approval by the
  -- analyst who prepared the decision (migration 0005) — what this suite is
  -- about is what happens *after* a legitimately approved row exists.
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit'), (org, dec, approver, 'writeback'),
           (org, dec, approver, 'writeoff');

  set role app_rw;
  perform test.as_member(org, analyst);

  insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                           confirmation_number, submitted_at)
    values (org, ded, dec, 'manual_portal', hash, 'APDP-41007', filed_at)
    returning id into sub;
  perform test.ok(sub is not null, 'a dispute is filed and recorded, once');

  -- -------------------------------------------------------------------------
  -- 1. What was filed cannot be rewritten (ADR 0022).
  -- -------------------------------------------------------------------------
  -- The packet hash is the contents that went out. The store compares it with
  -- the approval's once, at insert (ADR 0020 §2); a column that can be
  -- rewritten afterwards makes that comparison a formality and leaves the row
  -- reading as evidence that a human approved contents nobody approved.
  perform test.expect_error(format(
    'update submissions set packet_hash = %L where id = %L', other_hash, sub),
    'immutable once written',
    'the packet hash a submission says went out cannot be rewritten');
  perform test.ok(
    (select s.packet_hash from submissions s where s.id = sub) = hash,
    'and the hash on the row is still the one that was filed');

  -- The confirmation number is the only handle anybody has on a dispute sitting
  -- in a retailer's portal. The submit route refuses one that is too long
  -- rather than cutting it; one that can be rewritten later is the same failure
  -- with a longer fuse.
  perform test.expect_error(format(
    'update submissions set confirmation_number = ''APDP-00000'' where id = %L', sub),
    'immutable once written',
    'the confirmation number a retailer gave back cannot be rewritten');
  perform test.ok(
    (select s.confirmation_number from submissions s where s.id = sub) = 'APDP-41007',
    'and the reference on the row is still the one the portal gave');

  -- submitted_at is what a dispute deadline and every follow-up are counted
  -- from, and what Phase 4 will attribute a contingency fee against.
  perform test.expect_error(format(
    'update submissions set submitted_at = now() where id = %L', sub),
    'immutable once written',
    'the date a dispute was filed on cannot be moved');
  perform test.ok(
    (select s.submitted_at from submissions s where s.id = sub) = filed_at,
    'and the filing date on the row is still the one that was recorded');

  -- Nulling one out is a change like any other: the guard compares values, so
  -- erasing the record is refused by the same rule that refuses replacing it.
  perform test.expect_error(format(
    'update submissions set confirmation_number = null where id = %L', sub),
    'immutable once written',
    'nor can the reference be erased rather than replaced');

  -- All three at once, and the refusal names every column that moved — a
  -- reviewer reading the error learns what the statement would have done.
  perform test.expect_error(format(
    'update submissions set packet_hash = %L, confirmation_number = ''X'',
        submitted_at = now() where id = %L', other_hash, sub),
    'packet_hash, confirmation_number, submitted_at',
    'and a statement that rewrites all three is refused naming all three');

  -- -------------------------------------------------------------------------
  -- 2. status is still the one legitimate update.
  -- -------------------------------------------------------------------------
  -- recorded → sent → accepted → rejected says where a filing got to, not what
  -- was filed, and `unique (decision_id, channel)` means a retailer's answer
  -- cannot be recorded as a second row instead.
  update submissions set status = 'sent' where id = sub;
  perform test.ok((select s.status from submissions s where s.id = sub) = 'sent',
    'a filing can still be marked as sent');
  update submissions set status = 'accepted' where id = sub;
  perform test.ok((select s.status from submissions s where s.id = sub) = 'accepted',
    'and accepted when the retailer answers');
  update submissions set status = 'rejected' where id = sub;
  perform test.ok((select s.status from submissions s where s.id = sub) = 'rejected',
    'and rejected when they answer the other way');

  -- Writing a frozen column its own value back is not a change: the guard is
  -- `is distinct from`, so an UPDATE that names every column still passes as
  -- long as only `status` differs.
  update submissions
     set status = 'accepted', confirmation_number = 'APDP-41007', packet_hash = hash,
         submitted_at = filed_at
   where id = sub;
  perform test.ok((select s.status from submissions s where s.id = sub) = 'accepted',
    'an update that repeats the filed record unchanged moves the status alone');

  -- -------------------------------------------------------------------------
  -- 3. The approval gate still runs on update, and runs first.
  -- -------------------------------------------------------------------------
  -- The hole migration 0010 closed: a row filed against an approved decision
  -- must not come to rest against an unapproved one, however it got there.
  -- Extending the guard beside the gate must not have displaced it — and the
  -- gate is what answers, because `enforce_approval_on_update` sorts before
  -- `guard_immutable_core`.
  perform test.expect_error(format(
    'update submissions set decision_id = %L where id = %L', unapproved_dec, sub),
    'no submit approval row',
    'the approval gate still refuses an update onto an unapproved decision');
  perform test.expect_error(format(
    'update submissions set status = ''sent'', decision_id = %L where id = %L',
    unapproved_dec, sub),
    'no submit approval row',
    'and a legitimate status change carried alongside one does not smuggle it past');

  perform test.expect_error(format('delete from submissions where id = %L', sub),
    'denied', 'and app_rw still holds no DELETE on a record of an outbound act');

  -- -------------------------------------------------------------------------
  -- 4. The guard's other branches survived the replacement.
  -- -------------------------------------------------------------------------
  -- Migration 0017 replaces the function all three tables share, so this suite
  -- checks the two branches it did not touch as well as the one it did: a
  -- create-or-replace that lost a branch would otherwise be found by nothing.
  perform test.expect_error(format(
    'update submissions set channel = ''email'' where id = %L', sub),
    'immutable once written', 'the channel a submission went out on is still immutable');

  insert into writebacks (org_id, deduction_id, decision_id, method)
    values (org, ded, dec, 'credit_memo_offset') returning id into wb;
  perform test.expect_error(format(
    'update writebacks set method = ''reversing_journal_entry'' where id = %L', wb),
    'immutable once written', 'a write-back''s method is still immutable');
  update writebacks set status = 'succeeded' where id = wb;
  perform test.ok((select w.status from writebacks w where w.id = wb) = 'succeeded',
    'while a write-back''s status still moves');

  insert into writeoffs (org_id, deduction_id, decision_id, amount_cents)
    values (org, ded, dec, 100) returning id into wo;
  perform test.expect_error(format(
    'update writeoffs set amount_cents = 31200000 where id = %L', wo),
    'immutable once written',
    'and a write-off still cannot be inflated after it was approved');

  -- -------------------------------------------------------------------------
  -- 5. The trigger refuses the table owner too, and the pin is still on.
  -- -------------------------------------------------------------------------
  -- A guard that only a grant enforces is a guard the next `grant` undoes, so
  -- the owner — who bypasses RLS and every table privilege — is refused by the
  -- trigger itself.
  reset role;
  perform test.expect_error(format(
    'update submissions set packet_hash = %L where id = %L', other_hash, sub),
    'immutable once written', 'the table owner cannot rewrite the packet hash either');
  perform test.expect_error(format(
    'update submissions set confirmation_number = ''OWNER-1'' where id = %L', sub),
    'immutable once written', 'nor the confirmation number');
  perform test.expect_error(format(
    'update submissions set submitted_at = now() where id = %L', sub),
    'immutable once written', 'nor the filing date');
  update submissions set status = 'sent' where id = sub;
  perform test.ok((select s.status from submissions s where s.id = sub) = 'sent',
    'while the owner, like a member, may still record where the filing got to');

  -- CREATE OR REPLACE assigns every property from the command, so a replacement
  -- that omitted `set search_path` would silently drop the pin 0008 and 0010 §4
  -- put on this function — and this function decides whether a write is allowed.
  select p.proconfig into pinned
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'guard_immutable_core';
  perform test.ok(
    pinned @> array['search_path=pg_catalog, public, extensions'],
    'and the guard''s search_path is still pinned after the replacement');
end
$test$;
rollback;
