-- 0029 — Coverage counts each deduction once (ADR 0038).
--
-- Migration 0023 defined the denominator as `opened + declined`, which is
-- right only while the two are disjoint. They are not: `declineCase` writes a
-- `declined_candidates` row carrying the case's own `deduction_id` and its full
-- amount, and the case stays in `deductions`. So a case that was opened and
-- then declined was counted twice in `discovered_cents` — once as opened, once
-- as declined — inflating its channel's denominator by exactly its amount.
-- Production has recorded no declines, so no published number moved.
--
-- The fix, and only the fix:
--
--   discovered_cents = opened_cents + (declined dollars of candidates with no case)
--
-- A declined case stays in `opened`: it was opened, in the month it was found,
-- and a later decision not to fight it moves nothing in any month's
-- denominator. `declined_count` and `declined_cents` keep counting every
-- decline, case or no case, because `coverage_by_period_totals.coverage_of_seen`
-- is computed from them as migration 0014's number and narrowing them would
-- make that ratio rise whenever a case is declined (ADR 0038 §2). The row
-- therefore no longer adds up across its own columns — `opened + declined` is
-- at least `discovered`, and equal only when no case was declined — and
-- `discovered_cents` is the number that says what was found.
--
-- Same columns, same names, same order, same types: `create or replace view`
-- cannot drop, rename or retype a column, the totals view reads this one by
-- column, and on db:test's second pass migration 0023 re-creates the old body
-- before this file replaces it again. `security_invoker` is restated because
-- `create or replace view` replaces the options with whatever the command says.
-- `coverage_by_period_totals` needs no change: it sums `discovered_cents`, so
-- it is corrected by this statement, and its `coverage_of_seen` reads
-- `declined_cents`, which is unchanged. `coverage_by_period` (0014) is not
-- touched. No table, grant, policy or trigger changes.

create or replace view coverage_by_period_by_source
with (security_invoker = true) as
with case_source as (
  -- Unchanged from migration 0023: a case's channel is derived from its own
  -- earliest notice — `uploads.source` where ingest recorded the arrival,
  -- otherwise the `document_arrivals` row an operator asserted — and is
  -- 'unknown' where neither answers, never guessed (ADR 0030 §3).
  select d.org_id,
         d.id                                    as deduction_id,
         date_trunc('month', d.created_at)       as period,
         d.deduction_amount_cents,
         coalesce(notice.observed_from, notice.asserted_from, 'unknown') as discovered_from
    from deductions d
    left join lateral (
      select u.source  as observed_from,
             au.source as asserted_from
        from deduction_documents dd
        join documents doc on doc.id = dd.document_id
        left join uploads u on u.id = doc.upload_id
        left join document_arrivals da on da.document_id = doc.id
        left join uploads au on au.id = da.upload_id
       where dd.deduction_id = d.id and dd.role = 'notice'
       order by doc.created_at asc, doc.id asc
       limit 1
    ) notice on true
),
opened as (
  -- Every case we opened, in the month we found it — including a case that was
  -- declined afterwards. It was opened; declining it later is a disposition,
  -- like filing it, and moves nothing here (ADR 0038 §1).
  select org_id, period, discovered_from,
         count(*)                                       as opened_count,
         coalesce(sum(deduction_amount_cents), 0)::bigint as opened_cents
    from case_source
   group by 1, 2, 3
),
filed as (
  -- Unchanged: the deduction amount of every case with a submission, in the
  -- month it was filed.
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
  -- Every decline, in the month it was decided — reported in full, because
  -- that is what `declined_count` and `declined_cents` have always meant and
  -- `coverage_of_seen` is computed from them.
  --
  -- `uncased_cents` is the part of it that belongs in the denominator: the
  -- candidates that never became a case (`deduction_id is null` — migration
  -- 0014 made the column nullable for exactly these). A decline that names a
  -- case is that case's dollars, already in `opened`.
  select org_id,
         date_trunc('month', decided_at)                as period,
         discovered_from,
         count(*)                                       as declined_count,
         coalesce(sum(estimated_recoverable_cents), 0)::bigint as declined_cents,
         coalesce(sum(estimated_recoverable_cents) filter (where deduction_id is null), 0)::bigint
                                                        as uncased_cents
    from declined_candidates
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
       -- Each deduction once: every case opened, plus every candidate declined
       -- without one. Not `opened_cents + declined_cents`.
       (coalesce(o.opened_cents, 0) + coalesce(dc.uncased_cents, 0))::bigint
                                                        as discovered_cents,
       -- Still the only division on this path, still in the database
       -- (invariant 3), still not clamped (ADR 0030 §4).
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
  'without ever becoming a case (ADR 0038). A case opened and later declined '
  'stays in opened_cents and also appears in declined_cents, so opened plus '
  'declined is not discovered — read discovered_cents. A case''s channel is '
  'derived from its own earliest notice document and is ''unknown'' when '
  'nothing recorded how it arrived — never guessed. security_invoker: RLS on '
  'the underlying tables answers, so this view is per tenant. It measures '
  'coverage of the candidates we examined, NOT of every disputable dollar that '
  'exists — see ADR 0030 §5 for what is still missing.';

comment on column coverage_by_period_by_source.opened_cents is
  'Every case opened in the month, from this channel — including cases declined '
  'afterwards, which stay here (ADR 0038 §1).';
comment on column coverage_by_period_by_source.declined_count is
  'Every decline decided in the month for this channel, whether or not it named '
  'a case (ADR 0038 §2).';
comment on column coverage_by_period_by_source.declined_cents is
  'The dollars of every decline decided in the month, case or no case. The part '
  'that never became a case is discovered_cents minus opened_cents; the rest is '
  'already in some month''s opened_cents (ADR 0038 §2).';
comment on column coverage_by_period_by_source.discovered_cents is
  'Each deduction once: opened_cents plus the declines that never became a case. '
  'Not opened_cents + declined_cents (ADR 0038).';
