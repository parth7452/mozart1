-- 0027 — A ledger anomaly names its invoice (ADR 0035 §5).
--
-- `ledger_sync_runs` records `anomaly_count` and nothing else about them. The
-- first production run (2026-09-22) recorded eight, and eight is a number nobody
-- can act on: which invoices, which payments, what kind. The detector knew; the
-- database was told a count.
--
-- Three things, and nothing else.
--
--   1. `unique (org_id, id)` on `ledger_sync_runs`, so the table below can key on
--      `(org_id, run_id)` and get the tenancy tie with it — ADR 0025 §7's
--      pattern, the one 0025 used for credentials. A constraint, not a grant:
--      the table stays exactly as append-only as 0024 made it.
--
--   2. `ledger_sync_anomalies` — one row per anomaly of a completed run: a kind
--      from the detector's closed set of four and the ledger's own ids. **No
--      detail column**: the detector's detail quotes invoice numbers and renders
--      amounts as text, and a run's children are no more a place for a third
--      party's data than the run row is (ADR 0031 §2, invariant 4) — nor for
--      money that is not integer cents (invariant 3). Append-only on 0004's
--      pattern exactly.
--
--   3. `app.record_ledger_sync_anomalies()` — the only door into it, a sibling of
--      `app.record_ledger_sync_run()` and bounded the same way (the caller's own
--      org claim, the run's own member), plus written-once-complete: the run
--      must be `completed`, carry no anomaly rows yet, and the array must hold
--      exactly `anomaly_count` of them. All of a run's anomalies or none.
--
-- What is deliberately NOT here: any edit to `app.record_ledger_sync_run()`,
-- `app.require_approval()`, `app.guard_immutable_core()`,
-- `app.member_may_write()`, `app.block_mutations()` (used, not redefined) or
-- `app.guard_threshold_direction()`. No UPDATE or DELETE grant on any
-- append-only table. No money column.
--
-- Idempotent throughout, because `scripts/db-test.sh` applies every migration
-- twice; `supabase/tests/23_a_ledger_anomaly_names_its_invoice.sql` reads the
-- end state back.

-- ---------------------------------------------------------------------------
-- 1. ledger_sync_runs (org_id, id) — so a child can carry the tenancy tie
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'ledger_sync_runs'::regclass
       and conname = 'ledger_sync_runs_org_id_id_key'
  ) then
    alter table ledger_sync_runs
      add constraint ledger_sync_runs_org_id_id_key unique (org_id, id);
  end if;
end
$$;

comment on constraint ledger_sync_runs_org_id_id_key on ledger_sync_runs is
  'Lets ledger_sync_anomalies key on (org_id, run_id) and get the tenancy tie '
  'with it, rather than trusting two independent foreign keys (ADR 0035 §5, '
  'ADR 0025 §7).';

-- ---------------------------------------------------------------------------
-- 2. ledger_sync_anomalies — which invoices a run could not reason about
-- ---------------------------------------------------------------------------
create table if not exists ledger_sync_anomalies (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id),
  run_id                  uuid not null references ledger_sync_runs(id),
  -- The detector's four kinds (`LEDGER_ANOMALY_KINDS` in core-domain), asserted
  -- equal in both directions by packages/store-postgres/test/ledger-anomalies.
  kind                    text not null
                            check (kind in ('overapplied', 'application_to_unknown_invoice',
                                            'negative_amount', 'currency_mismatch')),
  -- The ledger's own id for the invoice the anomaly is about. An id, never a
  -- number a customer sees: that is the detail this table does not keep.
  invoice_external_id     text not null
                            check (btrim(invoice_external_id) <> ''
                                   and length(invoice_external_id) <= 128),
  -- The payment or credit whose application raised it. Null for an anomaly
  -- about the invoice itself (a negative total, a currency, overapplication).
  transaction_external_id text
                            check (transaction_external_id is null
                                   or (btrim(transaction_external_id) <> ''
                                       and length(transaction_external_id) <= 128)),
  recorded_at             timestamptz not null default now(),

  -- The tenancy tie: `run_id`'s own foreign key says the run exists, this says
  -- it is this org's.
  constraint ledger_sync_anomalies_run_same_org
    foreign key (org_id, run_id) references ledger_sync_runs (org_id, id)
);

comment on table ledger_sync_anomalies is
  'Which invoices a completed ledger sync could not reason about, as a kind and '
  'the ledger''s own ids (ADR 0035 §5). Append-only, written once per run and '
  'complete — exactly anomaly_count rows — through '
  'app.record_ledger_sync_anomalies(). Deliberately no detail text: the '
  'detector''s detail quotes the ledger and renders money as text.';

create index if not exists ledger_sync_anomalies_run_idx
  on ledger_sync_anomalies (org_id, run_id);
create index if not exists ledger_sync_anomalies_invoice_idx
  on ledger_sync_anomalies (org_id, invoice_external_id);

alter table ledger_sync_anomalies enable row level security;

do $$
begin
  execute 'drop policy if exists tenant_isolation on ledger_sync_anomalies';
  execute 'drop policy if exists tenant_read on ledger_sync_anomalies';
  execute 'drop policy if exists tenant_insert on ledger_sync_anomalies';
  execute 'drop policy if exists tenant_update on ledger_sync_anomalies';
  execute 'drop policy if exists tenant_delete on ledger_sync_anomalies';

  execute 'create policy tenant_read on ledger_sync_anomalies for select
             using (org_id = app.current_org_id())';
  -- Present, and deliberately never reachable: app_rw holds no INSERT (below),
  -- so every row goes through app.record_ledger_sync_anomalies(). The policies
  -- exist so a grant issued in a hurry lands on a rule rather than on nothing.
  execute 'create policy tenant_insert on ledger_sync_anomalies for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on ledger_sync_anomalies for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on ledger_sync_anomalies for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

revoke all on ledger_sync_anomalies from app_rw;
revoke all on ledger_sync_anomalies from app_ro;
grant select on ledger_sync_anomalies to app_rw;
grant select on ledger_sync_anomalies to app_ro;

-- The grant answers for app_rw; the trigger answers for the owner (0004).
drop trigger if exists no_update_delete on ledger_sync_anomalies;
create trigger no_update_delete before update or delete on ledger_sync_anomalies
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on ledger_sync_anomalies;
create trigger no_truncate before truncate on ledger_sync_anomalies
  for each statement execute function app.block_mutations();

-- ---------------------------------------------------------------------------
-- 3. app.record_ledger_sync_anomalies() — the one door, written once, complete
-- ---------------------------------------------------------------------------
-- Definer for app.record_ledger_sync_run()'s reason and bounded the same way:
-- it reaches no further than its caller. Plus the shape ADR 0023 argued for —
-- a run's anomalies are all written at once or not at all:
--
--   * the run must be the caller's org's and name the caller as requested_by;
--   * the run must be `completed` (a refused or failed run read nothing);
--   * the run must carry no anomaly rows yet (they cannot be appended to later);
--   * the array must hold exactly the run's anomaly_count elements.
--
-- `p_anomalies` is a jsonb array of
--   {"kind": text, "invoice_external_id": text, "transaction_external_id": text|null}
-- and nothing else is read out of it.
create or replace function app.record_ledger_sync_anomalies(
  p_run_id    uuid,
  p_anomalies jsonb
) returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  caller_org uuid := app.current_org_id();
  caller_sub uuid := app.current_user_id();
  run_org uuid;
  run_member uuid;
  run_outcome text;
  run_count integer;
  given integer;
  inserted integer;
begin
  if caller_org is null or caller_sub is null then
    raise exception
      'ledger sync anomalies blocked: no tenant claims are set; these are written '
      'as the member the sync acted as, never as nobody'
      using errcode = 'insufficient_privilege';
  end if;

  select r.org_id, r.requested_by, r.outcome, r.anomaly_count
    into run_org, run_member, run_outcome, run_count
    from ledger_sync_runs r where r.id = p_run_id;

  -- Another tenant's run is reported exactly as a missing one: this function is
  -- definer and must not become a way to learn which run ids exist elsewhere.
  if run_org is null or run_org <> caller_org then
    raise exception 'ledger sync anomalies blocked: run % does not exist', p_run_id
      using errcode = 'restrict_violation';
  end if;

  if run_member is distinct from caller_sub then
    raise exception
      'ledger sync anomalies blocked: a run''s anomalies are written as the member '
      'it acted as, and these claims are not that member'
      using errcode = 'insufficient_privilege';
  end if;

  if run_outcome <> 'completed' then
    raise exception
      'ledger sync anomalies blocked: run % is %, and only a completed run examined '
      'anything', p_run_id, run_outcome
      using errcode = 'restrict_violation';
  end if;

  if exists (select 1 from ledger_sync_anomalies a where a.run_id = p_run_id) then
    raise exception
      'ledger sync anomalies blocked: run % already has its anomalies; they are '
      'written once, complete', p_run_id
      using errcode = 'restrict_violation';
  end if;

  if p_anomalies is null or jsonb_typeof(p_anomalies) <> 'array' then
    raise exception 'ledger sync anomalies blocked: expected a json array'
      using errcode = 'invalid_parameter_value';
  end if;

  given := jsonb_array_length(p_anomalies);
  if given <> run_count then
    raise exception
      'ledger sync anomalies blocked: run % counted % anomalies and % were given; '
      'a partial list is not the list', p_run_id, run_count, given
      using errcode = 'restrict_violation';
  end if;

  if given = 0 then
    return 0;
  end if;

  insert into ledger_sync_anomalies
    (org_id, run_id, kind, invoice_external_id, transaction_external_id)
  select caller_org, p_run_id,
         e->>'kind', e->>'invoice_external_id', nullif(e->>'transaction_external_id', '')
    from jsonb_array_elements(p_anomalies) as e;

  get diagnostics inserted = row_count;
  return inserted;
end
$$;

comment on function app.record_ledger_sync_anomalies(uuid, jsonb) is
  'The only way a ledger_sync_anomalies row is written (ADR 0035 §5). Definer '
  'and bounded to the caller''s own org claim and to the run''s own member, '
  'like app.record_ledger_sync_run(); and written once, complete: a completed '
  'run, no rows yet, exactly anomaly_count of them.';

revoke all on function app.record_ledger_sync_anomalies(uuid, jsonb) from public;
grant execute on function app.record_ledger_sync_anomalies(uuid, jsonb) to app_rw;
