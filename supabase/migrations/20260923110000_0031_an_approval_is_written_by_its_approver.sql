-- 0031 — An approval is written by the person it names (ADR 0040).
--
-- app.enforce_separation_of_duties() (migration 0005) reads the name on the
-- row: `approver_id` is not the decision's `prepared_by`, and `approver_id` is
-- an owner or approver of the org. It never asks who is writing the row, and
-- `tenant_insert` on approvals admits any writer, analysts included (migration
-- 0010). So an analyst who prepared a decision could insert an approval naming
-- an approver, pass every trigger, and then file the submission the gate now
-- let through. Only the store's `requireCaller` stood in the way — code on the
-- near side of the gate.
--
-- Migration 0016 closed the same hole on the other column separation of duties
-- reads, `decisions.prepared_by`, with app.human_decision_names_its_author().
-- This is its counterpart for `approvals.approver_id`, and nothing else:
--
--   * app.require_approval() is not touched. The gate still carries one rule.
--   * app.enforce_separation_of_duties() is not touched — not its body, its
--     trigger or its messages. It now judges the real caller, because the
--     caller is the only person an approval may name.
--   * No grant changes. approvals stays append-only: app_rw holds select and
--     insert, and no_update_delete / no_truncate are as 0004 left them.
--
-- Idempotent: `create or replace` and drop-then-create, because `pnpm db:test`
-- applies every migration twice.

create or replace function app.approval_names_its_approver() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  -- app.current_user_id() is the `sub` in the claims the store sets
  -- transaction-locally from a verified session: the identity every RLS policy,
  -- app.member_may_write() and app.human_decision_names_its_author() key on.
  --
  -- No session means no caller, and every row is refused — including the table
  -- owner's. An approval is one person's act; whoever writes one has to say
  -- whose, in the claim the policies read.
  --
  -- No special case for a null approver_id: the column is not null, SoD's
  -- membership check refuses a null too, and `is distinct from` refuses it here.
  if new.approver_id is distinct from app.current_user_id() then
    raise exception
      'approval blocked: approver_id % is not the caller %',
      new.approver_id, coalesce(app.current_user_id()::text, '(no session)')
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

comment on function app.approval_names_its_approver() is
  'An approvals row is written by the person it names as approver_id, in their '
  'own session. approver_id is what app.enforce_separation_of_duties() judges, '
  'so the database enforces it rather than trusting the store (ADR 0040).';

-- Row-level BEFORE triggers fire in name order, so this runs ahead of
-- enforce_separation_of_duties. Deliberately: every check SoD makes is about
-- the person the row names, and when that is not the caller those answers are
-- about the wrong person. A forged approval is reported as forged
-- (supabase/tests/27 pins the order).
drop trigger if exists approval_names_its_approver on approvals;
create trigger approval_names_its_approver before insert on approvals
  for each row execute function app.approval_names_its_approver();
