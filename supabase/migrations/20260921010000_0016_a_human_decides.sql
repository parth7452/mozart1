-- 0016 — A human decides, and the gate is exercised (ADR 0020).
--
-- Phase 3 is built before Phases 1.5 and 2, with the dispute decision made by a
-- person rather than by Jev, so that a customer can run one case end to end and
-- a recovery rate becomes measurable. Nothing here weakens the approval gate,
-- the append-only tables or RLS. The gate is *used* for the first time.
--
-- Four changes, and nothing else:
--
--   1. `decisions.provider` admits 'human', and a human row must name whoever
--      prepared it — because that is the column the separation-of-duties
--      trigger reads. A human decision with a null `prepared_by` would let the
--      person who decided approve their own decision. It must name the *caller*
--      as that preparer, which `app.human_decision_names_its_author()` enforces:
--      a non-null `prepared_by` naming somebody else is a forged authorship, and
--      separation of duties reads the forged column.
--   2. `packets`: append-only, content-hashed, one row per (decision, contents),
--      and a packet's decision must be the same tenant's and the same case's,
--      which `app.packet_matches_its_decision()` enforces.
--      `approvals` gains `packet_hash` so an approval names the exact packet it
--      approved — as a foreign key onto `packets (decision_id, content_hash)`,
--      so "approved" names something that was really assembled.
--      `submissions.packet_hash` has existed since 0005.
--   3. Nothing for outcomes. An outcome is an `outcome.recorded` row in
--      `deduction_events` plus the case state, which is the projection.
--
-- What is deliberately NOT here: any change to `app.require_approval()`, to
-- `app.enforce_separation_of_duties()`, or to any grant on an append-only
-- table. The rule that a submission's packet hash must equal its approval's
-- lives in the store, not in the trigger — widening the gate's function to
-- carry a second rule is how a gate stops being provable (ADR 0020 §2).
--
-- Idempotent throughout: `if not exists`, and drop-then-add for constraints,
-- because `pnpm db:test` applies every migration to a database that may already
-- carry them.

-- ---------------------------------------------------------------------------
-- 1. A human decision is a decisions row
-- ---------------------------------------------------------------------------
do $$
begin
  alter table decisions drop constraint if exists decisions_provider_check;
  alter table decisions add constraint decisions_provider_check check (
    provider in (
      'jev',               -- primary decision provider (invariant 5)
      'claude-structured', -- structured-output fallback
      'human'              -- an analyst decided; there was no model (ADR 0020)
    )
  );

  -- `prepared_by` is nullable in general: a model decision made by a scheduled
  -- job has no human preparer. For a human row it is the whole point —
  -- app.enforce_separation_of_duties() reads exactly this column to refuse a
  -- preparer approving their own decision, and a null here would pass it.
  alter table decisions drop constraint if exists decisions_human_names_its_preparer;
  alter table decisions add constraint decisions_human_names_its_preparer check (
    provider <> 'human' or prepared_by is not null
  );
end
$$;

comment on constraint decisions_human_names_its_preparer on decisions is
  'A human decision must name the analyst who prepared it, because '
  'app.enforce_separation_of_duties() reads prepared_by to refuse a preparer '
  'approving their own decision (ADR 0020).';

-- Not-null is only half of it. A human decision that names *somebody else* as
-- its preparer is a forged authorship, and it is forged in exactly the column
-- separation of duties reads: write `prepared_by = <the approver>` and the
-- approver is locked out of their own case; write `prepared_by = <a colleague>`
-- and the author can then approve their own decision themselves. Neither is
-- something a store-level check should be the only thing standing in the way
-- of, because the store is code on the near side of the gate.
--
-- So the database enforces authorship too: a human decision is written by the
-- person it names, in their own session, or it is not written. `app.jwt()`
-- carries the claims Supabase set from a verified session, and
-- app.current_user_id() is the `sub` inside them — the same identity every RLS
-- policy and app.member_may_write() already key on.
--
-- A *null* `prepared_by` is deliberately left to decisions_human_names_its_preparer
-- above. Row-level BEFORE triggers run ahead of check constraints, so raising
-- here would take that constraint's own refusal away from it and leave the
-- not-null rule proved only indirectly. Each rule keeps its own name in the
-- error a caller sees.
create or replace function app.human_decision_names_its_author() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  if new.provider <> 'human' or new.prepared_by is null then
    return new;
  end if;

  if new.prepared_by is distinct from app.current_user_id() then
    raise exception
      'human decision blocked: prepared_by % is not the caller %',
      new.prepared_by, coalesce(app.current_user_id()::text, '(no session)')
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

comment on function app.human_decision_names_its_author() is
  'A decisions row with provider = ''human'' is written by the person it names '
  'as prepared_by, in their own session. Authorship is what '
  'app.enforce_separation_of_duties() reads, so the database enforces it '
  'rather than trusting the store (ADR 0020 §1).';

drop trigger if exists human_decision_names_its_author on decisions;
create trigger human_decision_names_its_author before insert on decisions
  for each row execute function app.human_decision_names_its_author();

-- ---------------------------------------------------------------------------
-- 2. The packet, recorded and hashed
-- ---------------------------------------------------------------------------
-- A packet is the case's notice, the evidence documents attached to it, and a
-- cover narrative our code builds deterministically from extracted fields — no
-- model call, so the hash is a pure function of the case (ADR 0020 §2).
--
-- Append-only for the same reason `decisions` and `approvals` are (ADR 0004): a
-- packet is what a human was shown when they approved. A packet you can rewrite
-- after the fact is not evidence of what was approved.
create table if not exists packets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id),
  deduction_id      uuid not null references deductions(id),
  decision_id       uuid not null references decisions(id),
  -- sha256 over the packet's canonical contents: the narrative, the ordered
  -- document ids and those documents' own hashes. An approval names this value
  -- and a submission repeats it, so substituting a document after approval
  -- produces a mismatch the store refuses.
  content_hash      bytea not null check (octet_length(content_hash) = 32),
  narrative         text not null check (length(narrative) between 1 and 20000),
  -- An *ordered* list, which is why it is an array and not a join table. No
  -- foreign key is possible on array elements; that is accepted rather than
  -- overlooked — `documents` is append-only and nothing deletes from it, and
  -- these ids are inside the hashed contents, so a dangling or substituted id
  -- changes the hash (ADR 0020 §2).
  file_document_ids uuid[] not null check (cardinality(file_document_ids) >= 1),
  assembled_by      uuid not null references users(id),
  created_at        timestamptz not null default now(),
  -- Re-assembling identical contents is refused by the database rather than by
  -- a convention. Assembling *different* contents for the same decision is a
  -- distinct row, which is how the two are told apart.
  unique (decision_id, content_hash)
);

comment on table packets is
  'The assembled dispute packet, content-hashed. Append-only: this is what a '
  'human was shown when they approved (ADR 0020).';

create index if not exists packets_org_deduction_idx
  on packets (org_id, deduction_id, created_at desc);
create index if not exists packets_decision_idx on packets (org_id, decision_id);

alter table packets enable row level security;

-- One policy per command, the pattern from ADR 0012: a single policy's USING
-- clause governs reads and the row-selection half of writes alike, so a role
-- predicate there would have blocked reading too.
do $$
begin
  execute 'drop policy if exists tenant_isolation on packets';
  execute 'drop policy if exists tenant_read on packets';
  execute 'drop policy if exists tenant_insert on packets';
  execute 'drop policy if exists tenant_update on packets';
  execute 'drop policy if exists tenant_delete on packets';

  execute 'create policy tenant_read on packets for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on packets for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on packets for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on packets for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

-- Insert and select only. The update/delete policies above exist so that a
-- future grant cannot silently arrive without one; the grant itself is revoked
-- and the trigger refuses regardless of role.
grant select, insert on packets to app_rw;
grant select on packets to app_ro;
revoke update, delete, truncate on packets from app_rw;
revoke update, delete, truncate on packets from app_ro;

drop trigger if exists no_update_delete on packets;
create trigger no_update_delete before update or delete on packets
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on packets;
create trigger no_truncate before truncate on packets
  for each statement execute function app.block_mutations();

-- Three foreign keys on `packets` say the org, the deduction and the decision
-- each exist. None of them says they are the *same case*: a row naming this
-- tenant's org and deduction alongside another tenant's decision satisfies all
-- three, and RLS does not catch it either — RLS asks whether `org_id` is mine,
-- not whether `decision_id` is. app.enforce_separation_of_duties() would still
-- refuse the approval that followed, so this is not a route through the gate;
-- it is a stored record of what a human was shown, hung off a decision another
-- tenant made, and a defence that rests entirely on the next trigger is one
-- trigger deep.
--
-- So the same check `app.enforce_separation_of_duties()` makes for an approval
-- ("this decision belongs to your org") is made here for a packet, plus the
-- case: a packet is assembled for one decision on one deduction, and the
-- decision's own `deduction_id` is the referee.
--
-- Definer, which the SoD trigger is not, and the difference is deliberate. RLS
-- on `decisions` would hide another tenant's decision from this lookup, and an
-- invisible row reads identically to a deleted one — the trigger would refuse
-- with "no such decision" and would refuse a same-tenant row that merely broke
-- RLS with the same words. Reading the two columns as definer lets each rule
-- give its own answer: this trigger refuses a cross-tenant *reference*, and RLS
-- still refuses a cross-tenant *write* on its own terms. The function reads
-- exactly two columns of one row the caller already named, and returns nothing.
create or replace function app.packet_matches_its_decision() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  decision_org uuid;
  decision_deduction uuid;
begin
  select d.org_id, d.deduction_id into decision_org, decision_deduction
    from decisions d where d.id = new.decision_id;

  if decision_org is null then
    raise exception 'packet blocked: decision % does not exist', new.decision_id
      using errcode = 'restrict_violation';
  end if;

  if decision_org <> new.org_id then
    raise exception 'packet blocked: decision % belongs to another org',
      new.decision_id
      using errcode = 'restrict_violation';
  end if;

  if decision_deduction <> new.deduction_id then
    raise exception
      'packet blocked: decision % is for deduction %, not %',
      new.decision_id, decision_deduction, new.deduction_id
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

comment on function app.packet_matches_its_decision() is
  'A packet is assembled for one decision on one deduction in one org. The '
  'foreign keys say each id exists; this says they are the same case '
  '(ADR 0020 §2).';

-- The pattern migration 0012 set for every definer function: nobody holds
-- EXECUTE on it. Firing a trigger does not check EXECUTE, so the function still
-- runs on every insert — this only takes away the ability to call it by hand,
-- which nothing has a reason to do and a definer function should never leave
-- lying around.
revoke all on function app.packet_matches_its_decision() from public;

drop trigger if exists packet_matches_its_decision on packets;
create trigger packet_matches_its_decision before insert on packets
  for each row execute function app.packet_matches_its_decision();

-- An approval names the exact packet it approved. Nullable: a 'writeoff' or
-- 'writeback' approval has no packet, and approvals predate this column.
--
-- Adding a nullable column is DDL. It changes no grant, and it fires no row
-- trigger, so the no_update_delete trigger on approvals is untouched by it.
alter table approvals
  add column if not exists packet_hash bytea;

do $$
begin
  alter table approvals drop constraint if exists approvals_packet_hash_is_sha256;
  alter table approvals add constraint approvals_packet_hash_is_sha256 check (
    packet_hash is null or octet_length(packet_hash) = 32
  );
end
$$;

-- A hash column alone only says "32 bytes". It does not say the bytes are a
-- packet's, so `approvals` could name a hash nothing was ever assembled under
-- and the approval would read as authorising a packet that does not exist.
-- The composite key is the whole point: the approval must name a packet
-- assembled *for that decision*, not merely some packet somewhere.
--
-- MATCH SIMPLE — the default — is what keeps a null `packet_hash` valid: a
-- 'writeoff' or 'writeback' approval has no packet, and approvals written
-- before this column have none either. With any column of the key null, the
-- constraint is satisfied without a lookup, which is exactly the behaviour
-- wanted here and the reason not to write MATCH FULL.
--
-- This is not the gate and does not touch it. `app.require_approval()` is
-- unchanged, still reads only (decision_id, action_type, org_id) and still
-- carries one rule. This constraint is declarative referential integrity on
-- the row the gate looks for, which is the opposite of widening the function.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'approvals_packet_is_a_real_packet'
       and conrelid = 'approvals'::regclass
  ) then
    alter table approvals add constraint approvals_packet_is_a_real_packet
      foreign key (decision_id, packet_hash)
      references packets (decision_id, content_hash);
  end if;
end
$$;

comment on constraint approvals_packet_is_a_real_packet on approvals is
  'An approval''s packet hash names a packet that was really assembled for '
  'that decision, or is null. MATCH SIMPLE, so a writeoff or writeback '
  'approval with no packet stays valid (ADR 0020 §2).';

comment on column approvals.packet_hash is
  'The content hash of the packet this approval authorised, or null for an '
  'approval with no packet. A foreign key onto packets (decision_id, '
  'content_hash) makes it name a packet that exists. The store refuses a '
  'submission whose packet hash differs from this; that check is deliberately '
  'not in the approval trigger, which carries one rule and only one (ADR 0020).';
