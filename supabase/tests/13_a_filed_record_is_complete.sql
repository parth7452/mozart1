\echo '-- 13 a filed record is complete when written, and the gate still answers first'
begin;
do $test$
declare
  ids jsonb; org uuid; ded uuid; dec uuid; analyst uuid; approver uuid;
  second_dec uuid; unapproved_dec uuid;
  sub uuid; emailed uuid; capped uuid;
  hash bytea := digest('the packet that was filed', 'sha256');
  filed_at timestamptz := now() - interval '1 day';
  at_the_cap text := repeat('A', 120);
  over_the_cap text := repeat('A', 121);
  named integer;
begin
  ids := test.seed_org('filedcomplete');
  org := (ids->>'org')::uuid; ded := (ids->>'deduction')::uuid; dec := (ids->>'decision')::uuid;
  analyst := (ids->>'analyst')::uuid; approver := (ids->>'approver')::uuid;

  -- A second approved decision on the same deduction, because
  -- `unique (decision_id, channel)` means each accepted manual filing below
  -- needs a decision of its own — and one nobody approved, so the gate has
  -- something to refuse.
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, ded, 'B', '1.0.0', 'jev', 'jev-latest', digest('second', 'sha256'),
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.93, 10, analyst)
    returning id into second_dec;
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org, ded, 'B', '1.0.0', 'jev', 'jev-latest', digest('unapproved', 'sha256'),
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.51, 10, analyst)
    returning id into unapproved_dec;

  -- Inserted as the owner, because separation of duties refuses an approval by
  -- the analyst who prepared the decision (migration 0005). What this suite is
  -- about is the shape of the row a legitimately approved filing may leave.
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org, dec, approver, 'submit'), (org, second_dec, approver, 'submit');

  set role app_rw;
  perform test.as_member(org, analyst);

  -- -------------------------------------------------------------------------
  -- 1. A manual filing may not be written blank (ADR 0023).
  -- -------------------------------------------------------------------------
  -- Migration 0017 froze these three columns, so a row inserted without one of
  -- them could never acquire it: the only statement that would is the update
  -- the guard refuses. Each is refused by name, so a caller learns which rule
  -- answered rather than reading three unrelated messages for one rule.
  perform test.expect_error(format(
    $q$insert into submissions (org_id, deduction_id, decision_id, channel,
                                confirmation_number, submitted_at)
       values (%L, %L, %L, 'manual_portal', 'APDP-41007', %L)$q$,
    org, ded, dec, filed_at),
    'submissions_manual_filing_is_complete',
    'a manual filing that names no packet hash is refused, by name');

  perform test.expect_error(format(
    $q$insert into submissions (org_id, deduction_id, decision_id, channel,
                                packet_hash, submitted_at)
       values (%L, %L, %L, 'manual_portal', %L, %L)$q$,
    org, ded, dec, hash, filed_at),
    'submissions_manual_filing_is_complete',
    'a manual filing with no confirmation number is refused, by name');

  perform test.expect_error(format(
    $q$insert into submissions (org_id, deduction_id, decision_id, channel,
                                packet_hash, confirmation_number)
       values (%L, %L, %L, 'manual_portal', %L, 'APDP-41007')$q$,
    org, ded, dec, hash),
    'submissions_manual_filing_is_complete',
    'a manual filing with no date is refused, by name');

  -- All three missing at once is the row the review was actually about: a
  -- submission that says a dispute was filed and nothing whatever about what
  -- was filed, permanently.
  perform test.expect_error(format(
    $q$insert into submissions (org_id, deduction_id, decision_id, channel)
       values (%L, %L, %L, 'manual_portal')$q$, org, ded, dec),
    'submissions_manual_filing_is_complete',
    'and a wholly blank manual filing is refused rather than frozen blank');

  perform test.ok(
    (select count(*) from submissions s where s.decision_id = dec) = 0,
    'none of which left a row behind');

  -- -------------------------------------------------------------------------
  -- 2. A complete one is recorded, exactly as recordSubmission writes it.
  -- -------------------------------------------------------------------------
  insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                           confirmation_number, submitted_at)
    values (org, ded, dec, 'manual_portal', hash, 'APDP-41007', filed_at)
    returning id into sub;
  perform test.ok(sub is not null,
    'a manual filing that says what went out, under what reference and when, is recorded');
  perform test.ok(
    (select s.status from submissions s where s.id = sub) = 'recorded',
    'and arrives in the one status a filing starts in');

  -- What happens to it afterwards is suite 12's: these three columns are frozen
  -- from here, which is precisely why they had to be supplied above.

  -- -------------------------------------------------------------------------
  -- 3. Another channel is still free to answer for itself.
  -- -------------------------------------------------------------------------
  -- ADR 0022 flags that an email dispute may be sent and learn its reference a
  -- week later, and ADR 0023 deliberately does not decide that here: a NOT NULL
  -- would force the email channel to insert a placeholder, which 0017 freezes
  -- exactly as it freezes a real reference. So the permissive case is asserted
  -- too — the day somebody tightens it they are changing an assertion rather
  -- than discovering an assumption.
  insert into submissions (org_id, deduction_id, decision_id, channel)
    values (org, ded, dec, 'email') returning id into emailed;
  perform test.ok(emailed is not null,
    'an email filing with nothing recorded yet is still accepted, on purpose');
  perform test.ok(
    (select s.confirmation_number is null and s.packet_hash is null
            and s.submitted_at is null from submissions s where s.id = emailed),
    'and is stored as not-known rather than as a placeholder');

  -- -------------------------------------------------------------------------
  -- 4. A confirmation number is bounded, and the database is what bounds it.
  -- -------------------------------------------------------------------------
  -- 120 is CONFIRMATION_MAX_LENGTH in apps/web/lib/notices.ts, which the submit
  -- route refuses past rather than truncating. The boundary is asserted at both
  -- sides of itself, because a cap the database enforces one character
  -- differently from the app is a refusal the reviewer meets with the wrong
  -- sentence.
  perform test.expect_error(format(
    $q$insert into submissions (org_id, deduction_id, decision_id, channel,
                                packet_hash, confirmation_number, submitted_at)
       values (%L, %L, %L, 'manual_portal', %L, %L, %L)$q$,
    org, ded, second_dec, hash, over_the_cap, filed_at),
    'submissions_confirmation_number_length',
    'a 121-character confirmation number is refused, by name');

  insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                           confirmation_number, submitted_at)
    values (org, ded, second_dec, 'manual_portal', hash, at_the_cap, filed_at)
    returning id into capped;
  perform test.ok(
    (select length(s.confirmation_number) from submissions s where s.id = capped) = 120,
    'and one of exactly 120 is stored whole, not cut to fit');

  -- -------------------------------------------------------------------------
  -- 5. The approval gate still runs, and runs first.
  -- -------------------------------------------------------------------------
  -- Row-level BEFORE triggers run ahead of check constraints, so a row that is
  -- both unapproved and incomplete is refused by the gate in the gate's own
  -- words. Adding a constraint beside invariant 1 must not have displaced it,
  -- and must not have given a caller a different reason for the same refusal.
  perform test.expect_error(format(
    $q$insert into submissions (org_id, deduction_id, decision_id, channel)
       values (%L, %L, %L, 'manual_portal')$q$, org, ded, unapproved_dec),
    'no submit approval row',
    'a blank filing against an unapproved decision is refused by the gate, first');
  perform test.expect_error(format(
    $q$insert into submissions (org_id, deduction_id, decision_id, channel,
                                packet_hash, confirmation_number, submitted_at)
       values (%L, %L, %L, 'manual_portal', %L, 'APDP-99999', %L)$q$,
    org, ded, unapproved_dec, hash, filed_at),
    'no submit approval row',
    'and a complete one against an unapproved decision is refused by the gate too');

  perform test.expect_error(format('delete from submissions where id = %L', sub),
    'denied', 'while app_rw still holds no DELETE on a record of an outbound act');

  -- -------------------------------------------------------------------------
  -- 6. Applying the migration twice leaves one of each constraint.
  -- -------------------------------------------------------------------------
  -- scripts/db-test.sh applies every migration twice in one run, so by the time
  -- this suite executes 0018 has been applied to a database that already
  -- carried it. Drop-then-add is what makes that a no-op; this is where it is
  -- read back rather than assumed, because a second `add constraint` under a
  -- generated name would leave two rules with one meaning and only one of them
  -- named in an error.
  reset role;
  select count(*) into named from pg_constraint
   where conrelid = 'submissions'::regclass
     and conname in ('submissions_manual_filing_is_complete',
                     'submissions_confirmation_number_length');
  perform test.ok(named = 2,
    'both constraints exist exactly once after the migration was applied twice');
  perform test.ok(
    (select bool_and(c.convalidated) from pg_constraint c
      where c.conrelid = 'submissions'::regclass
        and c.conname in ('submissions_manual_filing_is_complete',
                          'submissions_confirmation_number_length')),
    'and both are validated, so they bind the rows already there as well as the next one');
end
$test$;
rollback;
