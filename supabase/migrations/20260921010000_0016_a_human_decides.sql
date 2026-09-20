-- 0016 — A human decides, and the gate is exercised (ADR 0020).
--
-- Phase 3 is built before Phases 1.5 and 2, with the dispute decision made by a
-- person rather than by Jev, so that a customer can run one case end to end and
-- a recovery rate becomes measurable. Nothing here weakens the approval gate,
-- the append-only tables or RLS. The gate is *used* for the first time.
--
-- Three changes, and nothing else:
--
--   1. `decisions.provider` admits 'human', and a human row must name whoever
--      prepared it — because that is the column the separation-of-duties
--      trigger reads. A human decision with a null `prepared_by` would let the
--      person who decided approve their own decision.
--   2. `packets`: append-only, content-hashed, one row per (decision, contents).
--      `approvals` gains `packet_hash` so an approval names the exact packet it
--      approved. `submissions.packet_hash` has existed since 0005.
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

comment on column approvals.packet_hash is
  'The content hash of the packet this approval authorised, or null for an '
  'approval with no packet. The store refuses a submission whose packet hash '
  'differs from this; that check is deliberately not in the approval trigger, '
  'which carries one rule and only one (ADR 0020).';
