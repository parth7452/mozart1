-- Test harness. Plain SQL so it runs on a bare Postgres 16, in CI, and against
-- a Supabase branch without installing an extension (see ADR 0003).
-- Loaded as the superuser/owner; the test files then `set role app_rw` so they
-- exercise the same grants and RLS policies the application gets.

create schema if not exists test;
grant usage on schema test to app_rw, app_ro;

create or replace function test.ok(cond boolean, label text) returns void
  language plpgsql as $$
begin
  if cond is not true then
    raise exception 'FAIL: %', label using errcode = 'assert_failure';
  end if;
  raise notice '  ok — %', label;
end
$$;

-- Asserts that `stmt` fails, and that the message mentions `expect`.
create or replace function test.expect_error(stmt text, expect text, label text) returns void
  language plpgsql as $$
declare msg text;
begin
  begin
    execute stmt;
  exception when others then
    msg := sqlerrm;
    if position(lower(expect) in lower(msg)) = 0 then
      raise exception 'FAIL: % — expected error containing %, got: %', label, quote_literal(expect), msg
        using errcode = 'assert_failure';
    end if;
    raise notice '  ok — % (blocked: %)', label, msg;
    return;
  end;
  raise exception 'FAIL: % — statement succeeded but should have been blocked: %', label, stmt
    using errcode = 'assert_failure';
end
$$;

-- Acts as a member of `org` for the rest of the transaction/session, exactly
-- the way Supabase presents request claims.
create or replace function test.as_member(org uuid, usr uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', usr::text, 'org_id', org::text)::text, false);
end
$$;

create or replace function test.as_nobody() returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', false);
end
$$;

-- A complete, minimal tenant: two users (analyst + approver), settings, a
-- debtor, one deduction and one decision prepared by the analyst.
create or replace function test.seed_org(slug text) returns jsonb
  language plpgsql as $$
declare
  org_id uuid; analyst uuid; approver uuid; debtor uuid; deduction uuid; decision uuid;
begin
  insert into organizations (slug, name) values (slug, initcap(slug))
    returning id into org_id;
  insert into users (email, full_name) values (slug || '-analyst@example.test', 'Analyst')
    returning id into analyst;
  insert into users (email, full_name) values (slug || '-approver@example.test', 'Approver')
    returning id into approver;
  insert into memberships (org_id, user_id, role) values (org_id, analyst, 'analyst');
  insert into memberships (org_id, user_id, role) values (org_id, approver, 'approver');
  insert into org_settings (org_id) values (org_id);
  insert into debtors (org_id, retailer_key, display_name)
    values (org_id, 'walmart_apdp', 'Walmart (APDP)') returning id into debtor;
  insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents,
                          deduction_date, dispute_deadline, state)
    values (org_id, debtor, 'CLAIM-' || slug, 312000, current_date - 10,
            current_date + 80, 'awaiting_approval')
    returning id into deduction;
  insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                         model_version, input_state_hash, questions, result,
                         raw_probabilities, confidence, latency_ms, prepared_by)
    values (org_id, deduction, 'B', '1.0.0', 'jev', 'jev-latest',
            digest('state', 'sha256'), '{"validity":"choice"}'::jsonb,
            '{"validity":"invalid_deduction"}'::jsonb,
            '{"validity":{"invalid_deduction":0.97,"valid":0.03}}'::jsonb,
            0.97, 210, analyst)
    returning id into decision;
  return jsonb_build_object('org', org_id, 'analyst', analyst, 'approver', approver,
                            'debtor', debtor, 'deduction', deduction, 'decision', decision);
end
$$;

grant execute on all functions in schema test to app_rw, app_ro;
