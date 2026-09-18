-- 0014 — Where a deduction can come from, and what we declined to fight.
--
-- Two changes from the strategy addendum (docs/STRATEGY.md), CH-4 and ADD-1.
--
-- CH-4: `uploads.source` allowed only ('web_upload', 'email_in'), which encodes
-- an assumption the coverage thesis rejects — that a deduction enters the system
-- only when the supplier already knows about it and sends it to us. The sources
-- that find the ones they never surface (ERP sync, portal fetch, EDI 812) had
-- nowhere to say so.
--
-- ADD-1: a write-off is a terminal state with no analytic residue. Nothing
-- records that we looked at a deduction and decided not to fight it, what it was
-- worth, why, or what evidence was missing. Three things depend on this and only
-- this: coverage rate has no numerator without it (so recovery rate is
-- unprovable), the tail is untrainable because the skipped cases are exactly the
-- ones a model needs, and "here is what your previous process left on the table"
-- is the sales artifact.
--
-- A declined candidate is a fact, not a discard.

-- ---------------------------------------------------------------------------
-- CH-4 — the sources a deduction can arrive from
-- ---------------------------------------------------------------------------
do $$
begin
  alter table uploads drop constraint if exists uploads_source_check;
  alter table uploads add constraint uploads_source_check check (
    source in (
      'web_upload',   -- a person added it
      'email_in',     -- an attachment on an inbound email
      'email_body',   -- the message itself was the notice (ADR 0016)
      'erp_sync',     -- found in the accounting ledger, never surfaced by anyone
      'portal_fetch', -- pulled from the retailer's own portal
      'edi_812'       -- the debit advice, which is the deduction document itself
    )
  );
end
$$;

-- ---------------------------------------------------------------------------
-- ADD-1 — the counterfactual log
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'decline_reason') then
    create type decline_reason as enum (
      'below_economic_floor',   -- the dispute costs more than it returns
      'deadline_passed',        -- the window closed before we saw it
      'evidence_unavailable',   -- what would prove it cannot be got
      'deduction_valid',        -- they were right; there is nothing to recover
      'duplicate_of_other',     -- the same deduction, already handled elsewhere
      'below_confidence_floor', -- we could not read it well enough to act
      'tenant_declined',        -- the customer said not to
      'other'
    );
  end if;
end
$$;

-- Append-only, like every other record of a decision here. A declined candidate
-- can be declined again later for a different reason — that is a second row, and
-- the pair is the history.
create table if not exists declined_candidates (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id),
  -- Null when the candidate never became a case: ERP triage will decline
  -- thousands of short-pay lines that never reach extraction, and those are the
  -- rows coverage is measured against.
  deduction_id          uuid references deductions(id),
  -- Which source found it, so coverage can be attributed.
  discovered_from       text not null check (
    discovered_from in ('web_upload', 'email_in', 'email_body',
                        'erp_sync', 'portal_fetch', 'edi_812')
  ),
  reason                decline_reason not null,
  -- What it was worth. This is the whole point: a decline with no number
  -- attached cannot be added up, and coverage is a ratio of dollars.
  estimated_recoverable_cents bigint not null check (estimated_recoverable_cents >= 0),
  -- The external identifiers we had, so a later source can be matched to it.
  external_ids          jsonb not null default '{}'::jsonb,
  -- What decided. A policy or a model version, so a later change can be
  -- evaluated against what the old one declined.
  decided_by            text not null,
  decided_by_version    text not null,
  -- The evidence that would have changed the answer, as canonical evidence
  -- types. This is what makes the tail trainable rather than merely countable.
  missing_evidence      text[] not null default '{}',
  detail                text,
  decided_at            timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create index if not exists declined_candidates_org_idx
  on declined_candidates (org_id, decided_at desc);
create index if not exists declined_candidates_deduction_idx
  on declined_candidates (deduction_id) where deduction_id is not null;
create index if not exists declined_candidates_reason_idx
  on declined_candidates (org_id, reason);

alter table declined_candidates enable row level security;

do $$
begin
  execute 'drop policy if exists tenant_read on declined_candidates';
  execute 'drop policy if exists tenant_insert on declined_candidates';
  execute 'drop policy if exists tenant_update on declined_candidates';
  execute 'drop policy if exists tenant_delete on declined_candidates';

  execute 'create policy tenant_read on declined_candidates for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on declined_candidates for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on declined_candidates for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on declined_candidates for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

grant select, insert on declined_candidates to app_rw;
grant select on declined_candidates to app_ro;
revoke update, delete, truncate on declined_candidates from app_rw;

drop trigger if exists no_update_delete on declined_candidates;
create trigger no_update_delete before update or delete on declined_candidates
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on declined_candidates;
create trigger no_truncate before truncate on declined_candidates
  for each statement execute function app.block_mutations();

-- ---------------------------------------------------------------------------
-- Coverage, as far as it can be computed today.
-- ---------------------------------------------------------------------------
-- The denominator is filed dollars plus declined dollars: everything we saw.
-- It is not yet *disputable dollars existing* — that needs the ERP ledger
-- (ADD-2), and until then this reads as "of what reached us, how much did we
-- fight for". The view is security_invoker so it answers per tenant, through
-- the same policies as its tables (ADR 0010).
create or replace view coverage_by_period
with (security_invoker = true) as
with filed as (
  select d.org_id,
         date_trunc('month', s.created_at) as period,
         count(*) as filed_count,
         coalesce(sum(d.deduction_amount_cents), 0)::bigint as filed_cents
    from submissions s
    join deductions d on d.id = s.deduction_id
   group by 1, 2
),
declined as (
  select org_id,
         date_trunc('month', decided_at) as period,
         count(*) as declined_count,
         coalesce(sum(estimated_recoverable_cents), 0)::bigint as declined_cents
    from declined_candidates
   group by 1, 2
)
select coalesce(f.org_id, dc.org_id)          as org_id,
       coalesce(f.period, dc.period)          as period,
       coalesce(f.filed_count, 0)             as filed_count,
       coalesce(f.filed_cents, 0)             as filed_cents,
       coalesce(dc.declined_count, 0)         as declined_count,
       coalesce(dc.declined_cents, 0)         as declined_cents,
       case
         when coalesce(f.filed_cents, 0) + coalesce(dc.declined_cents, 0) = 0 then null
         else round(
           coalesce(f.filed_cents, 0)::numeric
           / (coalesce(f.filed_cents, 0) + coalesce(dc.declined_cents, 0)),
           4)
       end                                     as coverage_of_seen
  from filed f
  full outer join declined dc
    on dc.org_id = f.org_id and dc.period = f.period;

grant select on coverage_by_period to app_rw, app_ro;
