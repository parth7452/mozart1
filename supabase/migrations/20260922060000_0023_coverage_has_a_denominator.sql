-- 0023 — Coverage has a denominator (ADR 0030, STRATEGY §2 and ADD-2).
--
-- Migration 0014 could only compute half of §2's coverage rate. Its denominator
-- is filed plus declined — *what reached us* — and its own comment says so: a
-- deduction could only enter the system if the supplier already knew about it
-- and sent it to us. A rate computed that way improves when you look at less,
-- which is the exact failure §2 levels at a win rate.
--
-- ADR 0029 changed what the database can see. Every ledger candidate triage
-- examines now leaves a row: an opened case whose notice arrived through
-- `uploads.source = 'erp_sync'`, or a `declined_candidates` row with
-- `discovered_from = 'erp_sync'`. So "disputable dollars this source put in
-- front of us" is computable per period, per channel:
--
--   discovered_cents       = opened_cents + declined_cents
--   coverage_of_discovered = filed_cents / discovered_cents
--
-- Two NEW views, and nothing else: no table, no column, no change to any
-- existing view (`coverage_by_period` is left exactly as migration 0014 wrote
-- it, for the reason spelled out below the second view), no change to any
-- append-only table, and no grant beyond `select` on the two views to the two
-- roles that already read the old one. Both are `security_invoker`, so RLS on the underlying
-- tables (deductions, submissions, declined_candidates, documents, uploads,
-- document_arrivals) applies to whoever is asking and the views answer per
-- tenant through the same policies as their tables (ADR 0010) — there is no
-- `security_definer` surface here to harden.
--
-- Idempotent: `create or replace view` throughout, which is what makes
-- `scripts/db-test.sh` applying every migration twice a no-op on the second
-- pass.

-- ---------------------------------------------------------------------------
-- Coverage, by the channel that found the money.
-- ---------------------------------------------------------------------------
-- Never blended into one rate. A single coverage number moves when the *mix* of
-- sources moves, so a tenant turning on an ERP sync would read as the product
-- getting better — the same reason the eval suites are scored separately and
-- never averaged.
create or replace view coverage_by_period_by_source
with (security_invoker = true) as
with case_source as (
  -- A case's channel is derived from its own earliest notice, exactly as
  -- `declineCase` derives it (packages/store-postgres/src/store.ts — not edited
  -- by this change; this is the same derivation, not a second set of rules):
  -- `uploads.source` through `documents.upload_id` where ingest recorded the
  -- arrival, and otherwise through the `document_arrivals` row an operator
  -- asserted (ADR 0024 §3). The database refuses an arrival row for a document
  -- that already has an `upload_id`, so at most one of the two is ever non-null
  -- and this reads whichever answered rather than choosing between them.
  --
  -- `'unknown'` where neither answers — a case with no notice, or a notice
  -- stored before provenance was recorded. Never guessed into a channel, which
  -- would move that channel's rate with dollars it did not find, and never
  -- dropped, which would flatter every rate at once. It is a bucket a person
  -- can see and an operator can empty with `pnpm link:provenance`. It is
  -- deliberately not a value `uploads.source` admits: it is not a channel, it
  -- is the absence of one.
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
  -- Every case we opened: the dollars we judged worth fighting for.
  select org_id, period, discovered_from,
         count(*)                                       as opened_count,
         coalesce(sum(deduction_amount_cents), 0)::bigint as opened_cents
    from case_source
   group by 1, 2, 3
),
filed as (
  -- The numerator, with migration 0014's meaning unchanged: the deduction
  -- amount of every case that has a submission, bucketed by when it was filed.
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
  -- The other half of the denominator: what we looked at and decided against,
  -- including the candidates that never became cases at all (ADD-1). This one
  -- carries its channel on the row — `declineCase` and `declineCandidate` both
  -- derive it rather than taking it from a caller (ADR 0024 §1).
  select org_id,
         date_trunc('month', decided_at)                as period,
         discovered_from,
         count(*)                                       as declined_count,
         coalesce(sum(estimated_recoverable_cents), 0)::bigint as declined_cents
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
       (coalesce(o.opened_cents, 0) + coalesce(dc.declined_cents, 0))::bigint
                                                        as discovered_cents,
       -- The only division anywhere on this path, and it is in the database:
       -- money is integer cents (invariant 3) and a ratio computed in
       -- TypeScript over two bigints is where that stops being true.
       --
       -- Not clamped. A period whose filings were for cases opened earlier can
       -- report above 1, and that is the period skew being visible rather than
       -- hidden (ADR 0030 §4).
       case
         when coalesce(o.opened_cents, 0) + coalesce(dc.declined_cents, 0) = 0 then null
         else round(
           coalesce(f.filed_cents, 0)::numeric
           / (coalesce(o.opened_cents, 0) + coalesce(dc.declined_cents, 0)),
           4)
       end                                              as coverage_of_discovered
  from keys k
  left join opened o
    on o.org_id = k.org_id and o.period = k.period and o.discovered_from = k.discovered_from
  left join filed f
    on f.org_id = k.org_id and f.period = k.period and f.discovered_from = k.discovered_from
  left join declined dc
    on dc.org_id = k.org_id and dc.period = k.period and dc.discovered_from = k.discovered_from;

grant select on coverage_by_period_by_source to app_rw, app_ro;

comment on view coverage_by_period_by_source is
  'Coverage per (org, month, discovered_from): filed dollars over discovered '
  'dollars, where discovered is opened-case dollars plus declined-candidate '
  'dollars for that channel (ADR 0030, STRATEGY ADD-2). A case''s channel is '
  'derived from its own earliest notice document and is ''unknown'' when '
  'nothing recorded how it arrived — never guessed. security_invoker: RLS on '
  'the underlying tables answers, so this view is per tenant. It measures '
  'coverage of the candidates we examined, NOT of every disputable dollar that '
  'exists — see ADR 0030 §5 for what is still missing.';

-- ---------------------------------------------------------------------------
-- The tenant total, as a view of its own.
-- ---------------------------------------------------------------------------
-- `coverage_by_period` (migration 0014) is deliberately NOT touched, and this
-- is not a preference. `scripts/db-test.sh` applies every migration twice in
-- file order, so 0014's own `create or replace view coverage_by_period` runs
-- again on the second pass — before this file does — and `create or replace
-- view` cannot drop columns. Adding two columns to that view therefore makes
-- 0014 fail on the second pass, and 0014 is merged and may not be edited
-- (CLAUDE.md). A new view is what is left, and it is the smaller change
-- anyway: nothing that reads `coverage_by_period` sees anything different, and
-- `coverage_of_seen` keeps its old name, its old meaning and its old view.
--
-- The rows differ from `coverage_by_period` in one way worth knowing about: a
-- period in which cases were opened but nothing was filed and nothing declined
-- has a row here and none there. That is the point of the change. A
-- denominator that disappears exactly when the numerator is zero is a coverage
-- number that flatters itself.
--
-- Read the per-source view, not this one, when the question is a rate: a
-- blended rate moves whenever the mix of sources moves.
create or replace view coverage_by_period_totals
with (security_invoker = true) as
select org_id,
       period,
       sum(opened_count)::bigint    as opened_count,
       sum(opened_cents)::bigint    as opened_cents,
       sum(filed_count)::bigint     as filed_count,
       sum(filed_cents)::bigint     as filed_cents,
       sum(declined_count)::bigint  as declined_count,
       sum(declined_cents)::bigint  as declined_cents,
       sum(discovered_cents)::bigint as discovered_cents,
       -- Migration 0014's number, recomputed here to the same definition so
       -- the old question and the new one can be read off one row: filed over
       -- filed plus declined, which is coverage of what reached us.
       case
         when sum(filed_cents) + sum(declined_cents) = 0 then null
         else round(sum(filed_cents)::numeric / (sum(filed_cents) + sum(declined_cents)), 4)
       end                          as coverage_of_seen,
       case
         when sum(discovered_cents) = 0 then null
         else round(sum(filed_cents)::numeric / sum(discovered_cents), 4)
       end                          as coverage_of_discovered
  from coverage_by_period_by_source
 group by org_id, period;

grant select on coverage_by_period_totals to app_rw, app_ro;

comment on view coverage_by_period_totals is
  'coverage_by_period_by_source summed across sources, plus the discovered '
  'denominator (ADR 0030). coverage_of_seen is migration 0014''s number to the '
  'same definition, kept so the two questions can be compared on one row; '
  'coverage_by_period itself is untouched. A blended coverage rate moves '
  'whenever the source mix moves, so read the per-source view when the '
  'question is a rate. security_invoker, like the view it is built on.';
