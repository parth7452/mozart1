-- 0044 — A case opened in error is removed, not deleted (ADR 0072, proposed).
--
-- What this does, and nothing else:
--   1. `deductions.state` admits `removed`: closed, never left.
--   2. app.removal_is_guarded(), BEFORE UPDATE OF state ON deductions: a move
--      into `removed` only by an owner or approver, only from the nine states
--      before a filing (0032's state_before), only once a `case.removed` event
--      for the case is recorded, and never for the survivor of a standing
--      merge; a move out of `removed` never.
--   3. coverage_by_period_by_source (0032's body) and coverage_by_period
--      (0014's body) leave a removed case out of every column. Same columns,
--      same order, security_invoker.
--   4. A closing read of the catalogue that aborts if any of it did not hold.
--
-- Not here: any UPDATE or DELETE grant, any new table or column, any change to
-- the approval gate. Safe to run twice.
--
-- Refusals carry SQLSTATE RCR01 (class `RC`, as 0032's RCM0x), with the
-- message `case removal refused: <reason>` and the reason key as HINT:
--   not_owner_or_approver, not_removable_state, no_event, survivor_of_merge,
--   irreversible.

-- 1 ---------------------------------------------------------------------------
-- The list is CASE_STATES in packages/core-domain/src/state-machine.ts;
-- case-states.test.ts reads this constraint back.
alter table deductions drop constraint if exists deductions_state_check;
alter table deductions add constraint deductions_state_check check (state in (
  'discovered', 'classified', 'evidence_pending', 'evidence_complete', 'decided',
  'auto_dispute_queued', 'analyst_review', 'auto_writeoff_queued',
  'awaiting_approval', 'submitted', 'won', 'lost', 'partial', 'written_off',
  'merged', 'removed'));

do $$
declare stray text;
begin
  select string_agg(conname, ', ') into stray
    from pg_constraint
   where conrelid = 'deductions'::regclass
     and contype = 'c'
     and conname <> 'deductions_state_check'
     and pg_get_constraintdef(oid) like '%''evidence_pending''%';
  if stray is not null then
    raise exception 'deductions carries another state check (%): drop it by name first', stray;
  end if;
end
$$;

-- 2 ---------------------------------------------------------------------------
create or replace function app.removal_is_guarded() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  reason text;
begin
  if new.state is not distinct from old.state then
    return new;
  end if;

  if old.state = 'removed' then
    reason := 'irreversible';
  elsif new.state = 'removed' then
    if not app.member_is_owner_or_approver() then
      reason := 'not_owner_or_approver';
    elsif old.state not in ('discovered', 'classified', 'evidence_pending',
                            'evidence_complete', 'decided', 'auto_dispute_queued',
                            'analyst_review', 'auto_writeoff_queued',
                            'awaiting_approval') then
      reason := 'not_removable_state';
    elsif exists (select 1 from deduction_merges_current c
                   where c.surviving_deduction_id = new.id) then
      reason := 'survivor_of_merge';
    elsif not exists (select 1 from deduction_events e
                       where e.deduction_id = new.id
                         and e.event_type = 'case.removed') then
      reason := 'no_event';
    end if;
  end if;

  if reason is not null then
    raise exception 'case removal refused: %', reason
      using errcode = 'RCR01', detail = new.id::text, hint = reason;
  end if;
  return new;
end
$$;

comment on function app.removal_is_guarded() is
  'A case enters removed only by an owner or approver, from a state before a '
  'filing, after its case.removed event, and never as a merge survivor; it '
  'never leaves removed (ADR 0072). Not security definer.';

revoke all on function app.removal_is_guarded() from public;

drop trigger if exists removal_is_guarded on deductions;
create trigger removal_is_guarded before update of state on deductions
  for each row execute function app.removal_is_guarded();

-- 3 ---------------------------------------------------------------------------
-- 0032's body, with a removed case left out of case_group, case_source and the
-- declines. On db:test's second pass 0023, 0029 and 0032 re-create earlier
-- bodies before this file replaces them again.
create or replace view coverage_by_period_by_source
with (security_invoker = true) as
with removed as (
  select d.id from deductions d where d.state = 'removed'
),
merged_away as (
  select c.merged_deduction_id, c.surviving_deduction_id
    from deduction_merges_current c
),
case_group as (
  -- Each case that is the deduction, with every case that counts as it: itself,
  -- and whatever is merged into it. A chain is refused (ADR 0042 §9), so one
  -- level is all there is.
  select d.id as deduction_id, d.id as member_id
    from deductions d
   where not exists (select 1 from merged_away m where m.merged_deduction_id = d.id)
     and d.state <> 'removed'
  union all
  select m.surviving_deduction_id, m.merged_deduction_id
    from merged_away m
),
case_source as (
  select d.org_id,
         d.id                                    as deduction_id,
         (select date_trunc('month', min(member.created_at))
            from case_group g
            join deductions member on member.id = g.member_id
           where g.deduction_id = d.id)          as period,
         d.deduction_amount_cents,
         coalesce(notice.observed_from, notice.asserted_from, 'unknown') as discovered_from
    from deductions d
    left join lateral (
      select u.source  as observed_from,
             au.source as asserted_from
        from case_group g
        join deduction_documents dd on dd.deduction_id = g.member_id
        join documents doc on doc.id = dd.document_id
        left join uploads u on u.id = doc.upload_id
        left join document_arrivals da on da.document_id = doc.id
        left join uploads au on au.id = da.upload_id
       where g.deduction_id = d.id and dd.role = 'notice'
       order by doc.created_at asc, doc.id asc
       limit 1
    ) notice on true
   where not exists (select 1 from merged_away m where m.merged_deduction_id = d.id)
     and d.state <> 'removed'
),
opened as (
  select org_id, period, discovered_from,
         count(*)                                       as opened_count,
         coalesce(sum(deduction_amount_cents), 0)::bigint as opened_cents
    from case_source
   group by 1, 2, 3
),
filed as (
  select cs.org_id,
         date_trunc('month', s.created_at)              as period,
         cs.discovered_from,
         count(*)                                       as filed_count,
         coalesce(sum(cs.deduction_amount_cents), 0)::bigint as filed_cents
    from submissions s
    join case_source cs on cs.deduction_id = s.deduction_id
   group by 1, 2, 3
),
declined as (
  select k.org_id,
         date_trunc('month', k.decided_at)              as period,
         k.discovered_from,
         count(*)                                       as declined_count,
         coalesce(sum(k.estimated_recoverable_cents), 0)::bigint as declined_cents,
         coalesce(sum(k.estimated_recoverable_cents) filter (where k.deduction_id is null), 0)::bigint
                                                        as uncased_cents
    from declined_candidates k
   where k.deduction_id is null
      or (not exists (select 1 from merged_away m where m.merged_deduction_id = k.deduction_id)
          and not exists (select 1 from removed r where r.id = k.deduction_id))
   group by 1, 2, 3
),
keys as (
  select org_id, period, discovered_from from opened
  union
  select org_id, period, discovered_from from filed
  union
  select org_id, period, discovered_from from declined
)
select k.org_id,
       k.period,
       k.discovered_from,
       coalesce(o.opened_count, 0)                      as opened_count,
       coalesce(o.opened_cents, 0)::bigint              as opened_cents,
       coalesce(f.filed_count, 0)                       as filed_count,
       coalesce(f.filed_cents, 0)::bigint               as filed_cents,
       coalesce(dc.declined_count, 0)                   as declined_count,
       coalesce(dc.declined_cents, 0)::bigint           as declined_cents,
       (coalesce(o.opened_cents, 0) + coalesce(dc.uncased_cents, 0))::bigint
                                                        as discovered_cents,
       case
         when coalesce(o.opened_cents, 0) + coalesce(dc.uncased_cents, 0) = 0 then null
         else round(
           coalesce(f.filed_cents, 0)::numeric
           / (coalesce(o.opened_cents, 0) + coalesce(dc.uncased_cents, 0)),
           4)
       end                                              as coverage_of_discovered
  from keys k
  left join opened o
    on o.org_id = k.org_id and o.period = k.period and o.discovered_from = k.discovered_from
  left join filed f
    on f.org_id = k.org_id and f.period = k.period and f.discovered_from = k.discovered_from
  left join declined dc
    on dc.org_id = k.org_id and dc.period = k.period and dc.discovered_from = k.discovered_from;

comment on view coverage_by_period_by_source is
  'Coverage per (org, month, discovered_from): filed dollars over discovered '
  'dollars (ADR 0030, STRATEGY ADD-2). Discovered counts each deduction once: '
  'every case opened, in the month it was opened, plus every candidate declined '
  'without ever becoming a case (ADR 0038). A case merged into another is not a '
  'deduction of its own (ADR 0042), and a case removed as opened in error is '
  'counted nowhere (ADR 0072). A case opened and later declined stays in '
  'opened_cents and also appears in declined_cents, so opened plus declined is '
  'not discovered — read discovered_cents. security_invoker: RLS on the '
  'underlying tables answers, so this view is per tenant.';

-- 0014's body, with a removed case's declines (and, for completeness, filings,
-- which a removed case cannot have) left out.
create or replace view coverage_by_period
with (security_invoker = true) as
with filed as (
  select d.org_id,
         date_trunc('month', s.created_at) as period,
         count(*) as filed_count,
         coalesce(sum(d.deduction_amount_cents), 0)::bigint as filed_cents
    from submissions s
    join deductions d on d.id = s.deduction_id
   where d.state <> 'removed'
   group by 1, 2
),
declined as (
  select org_id,
         date_trunc('month', decided_at) as period,
         count(*) as declined_count,
         coalesce(sum(estimated_recoverable_cents), 0)::bigint as declined_cents
    from declined_candidates k
   where k.deduction_id is null
      or not exists (select 1 from deductions d
                      where d.id = k.deduction_id and d.state = 'removed')
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

-- 4 ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'deductions'::regclass
                    and conname = 'deductions_state_check'
                    and pg_get_constraintdef(oid) like '%''removed''%') then
    raise exception '0044: deductions_state_check does not admit removed';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'deductions'::regclass
                    and tgname = 'removal_is_guarded' and not tgisinternal) then
    raise exception '0044: the removal_is_guarded trigger is missing';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'removal_is_guarded'
       and (p.prosecdef
            or not coalesce(p.proconfig @> array['search_path=pg_catalog, public, extensions'], false))
  ) then
    raise exception '0044: app.removal_is_guarded is definer or has no pinned search_path';
  end if;
  if not exists (select 1 from pg_class
                  where oid = 'coverage_by_period_by_source'::regclass
                    and reloptions @> array['security_invoker=true']) then
    raise exception '0044: coverage_by_period_by_source is not security_invoker';
  end if;
end
$$;
