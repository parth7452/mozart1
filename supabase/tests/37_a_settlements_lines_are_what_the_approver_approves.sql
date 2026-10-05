\echo '-- 37 a settlement''s lines are what the approver approves (ADR 0068, migration 0041)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; ded_a uuid; dec_b_schema uuid;
  b jsonb; org_b uuid; analyst_b uuid;
  dec_ok uuid; dec_plain uuid; dec_tmp uuid;
  n int;
  fn record;
  r text;
  -- A person's settlement decision pinning `%s` lines; `%L`s are org, case, preparer.
  ins_decision constant text :=
    'insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                            model_version, input_state_hash, questions, result,
                            raw_probabilities, confidence, latency_ms, prepared_by)
     values (%L, %L, ''S'', ''settlement-1'', ''human'', ''human'', digest(''s'', ''sha256''),
             ''{}''::jsonb, %L::jsonb, ''{}''::jsonb, 1, 0, %L) returning id';
  ins_line constant text :=
    'insert into settlement_lines (org_id, decision_id, line_no, account_external_id,
                                   account_name_as_reported, account_type_as_reported,
                                   debit_cents, credit_cents, memo, created_by)
     values (%L, %L, %s, %L, %L, %L, %s, %s, %L, %L)';
begin
  a := test.seed_org('sla');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  approver_a := (a->>'approver')::uuid; ded_a := (a->>'deduction')::uuid;
  dec_b_schema := (a->>'decision')::uuid;
  b := test.seed_org('slb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  -- =========================================================================
  -- The catalogue
  -- =========================================================================
  for fn in
    select p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'app'
       and p.proname in ('settlement_line_is_its_preparers', 'settlement_lines_are_whole')
  loop
    perform test.ok(
      coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false),
      format('app.%s pins search_path', fn.proname));
    perform test.ok(not fn.prosecdef, format('app.%s is not security definer', fn.proname));
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app'
     and p.proname in ('settlement_line_is_its_preparers', 'settlement_lines_are_whole');
  perform test.ok(n = 2, 'both settlement functions exist');

  perform test.ok((select relrowsecurity from pg_class where oid = 'settlement_lines'::regclass),
    'settlement_lines has row level security');
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform test.ok(
      not has_table_privilege(r, 'settlement_lines',
            'select, insert, update, delete, truncate, references, trigger'),
      format('%s holds nothing on settlement_lines', r));
  end loop;
  perform test.ok(has_table_privilege('app_rw', 'settlement_lines', 'select')
              and has_table_privilege('app_rw', 'settlement_lines', 'insert')
              and has_table_privilege('app_ro', 'settlement_lines', 'select'),
    'app_rw holds SELECT and INSERT on settlement_lines, app_ro SELECT');
  perform test.ok(not has_table_privilege('app_rw', 'settlement_lines', 'update')
              and not has_table_privilege('app_rw', 'settlement_lines', 'delete')
              and not has_table_privilege('app_rw', 'settlement_lines', 'truncate')
              and not has_table_privilege('app_ro', 'settlement_lines', 'insert'),
    'app_rw holds no UPDATE, DELETE or TRUNCATE on settlement_lines, app_ro no INSERT');

  perform test.ok(
    (select array_agg(att.attname::text order by att.attname)
       from pg_constraint c
       join unnest(c.conkey) k on true
       join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k
      where c.conname = 'settlement_lines_same_org') = array['decision_id', 'org_id']
    and (select confrelid from pg_constraint where conname = 'settlement_lines_same_org')
        = 'decisions'::regclass,
    'settlement_lines names its decision by (org_id, decision_id)');

  perform test.ok(
    (select t.tgdeferrable and t.tginitdeferred from pg_trigger t
      where t.tgrelid = 'settlement_lines'::regclass and t.tgname = 'settlement_lines_are_whole')
    and (select t.tgdeferrable and t.tginitdeferred from pg_trigger t
          where t.tgrelid = 'decisions'::regclass and t.tgname = 'settlement_decision_is_whole'),
    'both whole-and-balanced triggers are constraint triggers, deferred to commit');

  -- The gate's own functions are the ones 0041 found: it restates neither.
  perform test.ok(
    (select count(*) from pg_trigger
      where tgrelid = 'decisions'::regclass and not tgisinternal
        and tgname = 'settlement_decision_is_whole') = 1,
    'decisions gained exactly the one trigger');

  -- =========================================================================
  -- A decision with its lines: whole and balanced at commit
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_a, analyst_a);

  execute format(ins_decision, org_a, ded_a,
    '{"outcome":"lost","recovered_cents":0,"family":null,"invoice_id":"71","line_count":2}',
    analyst_a) into dec_ok;
  execute format(ins_line, org_a, dec_ok, 1, '95', 'Customer Deductions', 'Expense',
                 312000, 0, 'Agreed with the buyer', analyst_a);
  execute format(ins_line, org_a, dec_ok, 2, '90', 'Deductions Receivable',
                 'Other Current Asset', 0, 312000, null, analyst_a);
  -- What COMMIT would run, run now.
  set constraints all immediate;
  set constraints all deferred;
  select count(*) into n from settlement_lines where decision_id = dec_ok;
  perform test.ok(n = 2, 'a balanced settlement decision and its two lines are accepted');

  -- =========================================================================
  -- Append-only
  -- =========================================================================
  perform test.expect_error(format(
    'update settlement_lines set memo = ''x'' where decision_id = %L', dec_ok),
    'permission denied', 'app_rw cannot update a settlement line');
  perform test.expect_error(format(
    'delete from settlement_lines where decision_id = %L', dec_ok),
    'permission denied', 'app_rw cannot delete a settlement line');

  -- =========================================================================
  -- The set is fixed once it is whole
  -- =========================================================================
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'Customer Deductions', 'Expense',
           100, 0, null, analyst_a) || '; set constraints all immediate',
    'pins 2 lines and has 3', 'a third line on a two-line decision is refused');
  set constraints all deferred;
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 1, '95', 'Customer Deductions', 'Expense',
           312000, 0, null, analyst_a),
    'settlement_lines_line_once', 'a line number is used once per decision');

  -- A decision that pins a count and brings no lines.
  perform test.expect_error(
    format(ins_decision, org_a, ded_a,
      '{"outcome":"lost","recovered_cents":0,"family":null,"invoice_id":"71","line_count":2}',
      analyst_a) || '; set constraints all immediate',
    'pins 2 lines and has 0', 'a decision cannot pin lines it does not bring');
  set constraints all deferred;

  -- A count that is not one, and one out of range.
  perform test.expect_error(
    format(ins_decision, org_a, ded_a,
      '{"outcome":"lost","recovered_cents":0,"family":null,"invoice_id":"71","line_count":"two"}',
      analyst_a) || '; set constraints all immediate',
    'not a count', 'a line_count that is not a number is refused');
  set constraints all deferred;
  perform test.expect_error(
    format(ins_decision, org_a, ded_a,
      '{"outcome":"lost","recovered_cents":0,"family":null,"invoice_id":"71","line_count":21}',
      analyst_a) || '; set constraints all immediate',
    'an entry has 2 to 20', 'more than twenty lines are refused');
  set constraints all deferred;
  perform test.expect_error(
    format(ins_decision, org_a, ded_a,
      '{"outcome":"lost","recovered_cents":0,"family":null,"invoice_id":"71","line_count":1}',
      analyst_a) || '; set constraints all immediate',
    'an entry has 2 to 20', 'a one-line entry is refused');
  set constraints all deferred;

  -- A decision that pins no count — one prepared before this migration — is
  -- accepted as it always was, and never gains a line.
  execute format(ins_decision, org_a, ded_a,
    '{"outcome":"lost","recovered_cents":0,"family":null,"invoice_id":"71"}', analyst_a)
    into dec_plain;
  set constraints all immediate;
  set constraints all deferred;
  perform test.ok(dec_plain is not null, 'a settlement decision with no line_count is accepted');
  perform test.expect_error(
    format(ins_line, org_a, dec_plain, 1, '95', 'Customer Deductions', 'Expense',
           100, 0, null, analyst_a) || '; set constraints all immediate',
    'carries no line_count', 'a decision that pins no count never gains a line');
  set constraints all deferred;

  -- =========================================================================
  -- Unbalanced is refused at commit
  -- =========================================================================
  execute format(ins_decision, org_a, ded_a,
    '{"outcome":"lost","recovered_cents":0,"family":null,"invoice_id":"71","line_count":2}',
    analyst_a) into dec_tmp;
  execute format(ins_line, org_a, dec_tmp, 1, '95', 'Customer Deductions', 'Expense',
                 312000, 0, null, analyst_a);
  perform test.expect_error(
    format(ins_line, org_a, dec_tmp, 2, '90', 'Deductions Receivable', 'Other Current Asset',
           0, 311999, null, analyst_a) || '; set constraints all immediate',
    'does not balance', 'lines whose debits and credits differ by a cent are refused');
  set constraints all deferred;
  -- Numbered 1 and 3: two lines, not lines 1..2.
  perform test.expect_error(
    format(ins_line, org_a, dec_tmp, 3, '90', 'Deductions Receivable', 'Other Current Asset',
           0, 312000, null, analyst_a) || '; set constraints all immediate',
    'pins 2 lines and has 2 (numbered 1 to 3)', 'lines must be numbered 1..line_count');
  set constraints all deferred;
  -- Leave dec_tmp whole, so this transaction's own deferred checks pass.
  execute format(ins_line, org_a, dec_tmp, 2, '90', 'Deductions Receivable',
                 'Other Current Asset', 0, 312000, null, analyst_a);
  set constraints all immediate;
  set constraints all deferred;

  -- =========================================================================
  -- A line's own shape
  -- =========================================================================
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 100, null, analyst_a),
    'settlement_lines_one_side', 'a line with both sides is refused');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 0, 0, null, analyst_a),
    'settlement_lines_one_side', 'a line with neither side is refused');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', -100, 0, null, analyst_a),
    'settlement_lines_one_side', 'a negative amount is refused');
  perform test.ok(
    (select format_type(atttypid, atttypmod) from pg_attribute
      where attrelid = 'settlement_lines'::regclass and attname = 'debit_cents') = 'bigint'
    and (select format_type(atttypid, atttypmod) from pg_attribute
          where attrelid = 'settlement_lines'::regclass and attname = 'credit_cents') = 'bigint',
    'both sides are bigint cents');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 21, '95', 'X', 'Expense', 100, 0, null, analyst_a),
    'settlement_lines_line_no', 'line 21 is refused');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '', 'X', 'Expense', 100, 0, null, analyst_a),
    'settlement_lines_account_id', 'a line names an account');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 0, repeat('m', 501), analyst_a),
    'settlement_lines_memo', 'a memo past 500 characters is refused');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 0, '', analyst_a),
    'settlement_lines_memo', 'an empty memo is null, not empty text');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 0,
           'one' || chr(10) || 'two', analyst_a),
    'settlement_lines_memo', 'a memo with a control character is refused');

  -- =========================================================================
  -- Whose lines they are
  -- =========================================================================
  perform test.expect_error(
    format(ins_line, org_a, dec_b_schema, 1, '95', 'X', 'Expense', 100, 0, null, analyst_a),
    'not a person''s settlement decision', 'a dispute decision carries no settlement lines');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 0, null, approver_a),
    'is not the caller', 'a line names its author');
  perform test.as_member(org_a, approver_a);
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 0, null, approver_a),
    'prepared by someone else', 'only the preparer writes a decision''s lines');

  -- Another tenant: by its own org it cannot name the decision; by ours, RLS.
  perform test.as_member(org_b, analyst_b);
  perform test.expect_error(
    format(ins_line, org_b, dec_ok, 3, '95', 'X', 'Expense', 100, 0, null, analyst_b),
    'not this tenant''s', 'another tenant cannot hang a line on our decision');
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 0, null, analyst_b),
    'not this tenant''s', 'nor by claiming our org');
  select count(*) into n from settlement_lines;
  perform test.ok(n = 0, 'another tenant reads none of our lines');

  -- =========================================================================
  -- What was approved is not added to
  -- =========================================================================
  perform test.as_member(org_a, approver_a);
  insert into approvals (org_id, decision_id, approver_id, action_type)
    values (org_a, dec_ok, approver_a, 'writeback');
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    format(ins_line, org_a, dec_ok, 3, '95', 'X', 'Expense', 100, 0, null, analyst_a),
    'already approved', 'an approved decision takes no more lines');

  -- =========================================================================
  -- The owner of the table: the triggers answer where grants and RLS do not
  -- =========================================================================
  reset role;
  perform test.expect_error(format(
    'update settlement_lines set debit_cents = 1 where decision_id = %L', dec_ok),
    'append-only', 'a settlement line refuses UPDATE even for the table owner');
  perform test.expect_error(format(
    'delete from settlement_lines where decision_id = %L', dec_ok),
    'append-only', 'a settlement line refuses DELETE even for the table owner');
  perform test.expect_error('truncate settlement_lines',
    'append-only', 'settlement_lines refuses TRUNCATE');
  perform test.as_nobody();
  perform test.expect_error(
    format(ins_line, org_a, dec_tmp, 3, '95', 'X', 'Expense', 100, 0, null, analyst_a),
    'is not the caller', 'the table owner with no session writes no line');

  select count(*) into n from settlement_lines where org_id in (org_a, org_b);
  perform test.ok(n = 4, 'exactly the four lines this suite wrote');
end
$test$;
rollback;
