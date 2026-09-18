-- 0005 — The one-way door (invariant 1).
--
-- No submission, accounting write-back or write-off may be inserted unless an
-- approvals row references that exact decision_id for that exact action. This
-- is enforced by a trigger that fails the transaction, never by app code.
-- Loosening this requires a human and an ADR.

create table if not exists approvals (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  decision_id  uuid not null references decisions(id),
  approver_id  uuid not null references users(id),
  action_type  text not null check (action_type in ('submit', 'writeoff', 'writeback')),
  note         text,
  approved_at  timestamptz not null default now(),
  -- One approval row per item per action: batch approval in the UI still writes
  -- one row each, never a blanket approval.
  unique (decision_id, action_type)
);

create table if not exists submissions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id),
  deduction_id        uuid not null references deductions(id),
  decision_id         uuid not null references decisions(id),
  channel             text not null check (channel in ('manual_portal', 'email', 'portal_agent')),
  status              text not null default 'recorded'
                        check (status in ('recorded', 'sent', 'accepted', 'rejected')),
  confirmation_number text,
  packet_hash         bytea,
  submitted_at        timestamptz,
  created_at          timestamptz not null default now(),
  -- Exactly-once per channel.
  unique (decision_id, channel)
);

create table if not exists writebacks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  deduction_id  uuid not null references deductions(id),
  decision_id   uuid not null references decisions(id),
  method        text not null check (method in
                  ('credit_memo_offset', 'reversing_journal_entry', 'payment_adjustment')),
  status        text not null default 'pending'
                  check (status in ('pending', 'succeeded', 'failed')),
  qbo_txn_id    text,
  request_id    text unique,   -- QBO idempotency key
  created_at    timestamptz not null default now(),
  unique (decision_id, method)
);

create table if not exists writeoffs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  deduction_id  uuid not null references deductions(id),
  decision_id   uuid not null references decisions(id),
  amount_cents  bigint not null check (amount_cents > 0),
  created_at    timestamptz not null default now(),
  unique (decision_id)
);

-- ---------------------------------------------------------------------------
-- The approval gate
-- ---------------------------------------------------------------------------
create or replace function app.require_approval() returns trigger
  language plpgsql as $$
declare
  required_action text := tg_argv[0];
begin
  if not exists (
    select 1
      from approvals a
      join decisions d on d.id = a.decision_id
     where a.decision_id = new.decision_id
       and a.action_type = required_action
       and a.org_id = new.org_id
       and d.org_id = new.org_id
       and d.deduction_id = new.deduction_id
  ) then
    raise exception
      '% blocked: no % approval row for decision % on deduction %',
      tg_table_name, required_action, new.decision_id, new.deduction_id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

drop trigger if exists enforce_approval on submissions;
create trigger enforce_approval before insert on submissions
  for each row execute function app.require_approval('submit');

drop trigger if exists enforce_approval on writebacks;
create trigger enforce_approval before insert on writebacks
  for each row execute function app.require_approval('writeback');

drop trigger if exists enforce_approval on writeoffs;
create trigger enforce_approval before insert on writeoffs
  for each row execute function app.require_approval('writeoff');

-- ---------------------------------------------------------------------------
-- Separation of duties: the analyst who prepared a decision cannot approve it,
-- and only owners/approvers may approve at all.
-- ---------------------------------------------------------------------------
create or replace function app.enforce_separation_of_duties() returns trigger
  language plpgsql as $$
declare
  prepared_by uuid;
  decision_org uuid;
begin
  select d.prepared_by, d.org_id into prepared_by, decision_org
    from decisions d where d.id = new.decision_id;

  if decision_org is null then
    raise exception 'approval blocked: decision % does not exist', new.decision_id
      using errcode = 'restrict_violation';
  end if;

  if decision_org <> new.org_id then
    raise exception 'approval blocked: decision % belongs to another org', new.decision_id
      using errcode = 'restrict_violation';
  end if;

  if prepared_by is not null and prepared_by = new.approver_id then
    raise exception
      'approval blocked: preparer % cannot approve their own decision %',
      new.approver_id, new.decision_id
      using errcode = 'restrict_violation';
  end if;

  if not exists (
    select 1 from memberships m
     where m.org_id = new.org_id
       and m.user_id = new.approver_id
       and m.role in ('owner', 'approver')
  ) then
    raise exception
      'approval blocked: user % is not an approver in org %', new.approver_id, new.org_id
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

drop trigger if exists enforce_separation_of_duties on approvals;
create trigger enforce_separation_of_duties before insert on approvals
  for each row execute function app.enforce_separation_of_duties();

-- ---------------------------------------------------------------------------
-- Thresholds auto-tighten, never auto-loosen (invariant 7). A loosening
-- transaction must first announce the ADR that authorises it:
--   select set_config('app.threshold_loosening_adr', 'ADR-0007', true);
-- ---------------------------------------------------------------------------
create or replace function app.guard_threshold_direction() returns trigger
  language plpgsql as $$
declare
  adr text := nullif(current_setting('app.threshold_loosening_adr', true), '');
  loosened text[] := '{}';
begin
  if new.auto_dispute_ceiling_cents > old.auto_dispute_ceiling_cents then
    loosened := loosened || 'auto_dispute_ceiling_cents'::text;
  end if;
  if new.auto_writeoff_ceiling_cents > old.auto_writeoff_ceiling_cents then
    loosened := loosened || 'auto_writeoff_ceiling_cents'::text;
  end if;
  if new.min_classification_confidence < old.min_classification_confidence then
    loosened := loosened || 'min_classification_confidence'::text;
  end if;
  if new.min_decision_confidence < old.min_decision_confidence then
    loosened := loosened || 'min_decision_confidence'::text;
  end if;

  if array_length(loosened, 1) is not null and adr is null then
    raise exception
      'threshold loosening blocked (%): set app.threshold_loosening_adr to the authorising ADR',
      array_to_string(loosened, ', ')
      using errcode = 'restrict_violation';
  end if;

  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists guard_threshold_direction on org_settings;
create trigger guard_threshold_direction before update on org_settings
  for each row execute function app.guard_threshold_direction();

create index if not exists approvals_org_decision_idx on approvals (org_id, decision_id);
create index if not exists submissions_org_deduction_idx on submissions (org_id, deduction_id);
create index if not exists writebacks_org_deduction_idx on writebacks (org_id, deduction_id);
create index if not exists writeoffs_org_deduction_idx on writeoffs (org_id, deduction_id);
