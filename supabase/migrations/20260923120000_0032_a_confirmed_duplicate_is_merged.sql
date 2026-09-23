-- 0032 — A confirmed duplicate is merged without destroying either row (ADR 0042).
--
-- ADR 0032 let a person say two cases are one deduction and changed nothing
-- else: both stayed live, both counted in coverage, and an arrival matching
-- both halves was held as ambiguous. This is the merge. One append-only row in
-- `deduction_merges` records it; the database checks that row, moves the
-- merged-away case (the loser) to a new `merged` state, and writes the events.
-- An undo is a second row, which puts the case back exactly where it was and
-- withdraws the verdict so the pair can be answered again.
--
-- What changes:
--
--   1. `deductions.state` admits `merged`.
--   2. `duplicate_pair_verdicts`: the verdict standing on each pair, where a
--      withdrawal answers "none".
--   3. `deduction_merges` (append-only) and `deduction_merges_current`.
--   4. `app.merge_work_rank`, `app.merge_survivor`, `app.merge_refusal`: the
--      rules, once, used by the check below and by the store alike.
--   5. The check on a merge row, and the projection that follows from it.
--   6. The state cannot move into or out of `merged` without the ledger.
--   7. Nothing more is hung on a merged-away case.
--   8. `coverage_by_period_by_source` counts a merged pair once, under the
--      channel that brought the first copy.
--
-- What does not: no UPDATE, DELETE or TRUNCATE is granted to anybody; the
-- approval gate's triggers and functions are untouched (the new refusal fires
-- after `enforce_approval`, alphabetically, and only refuses more); no existing
-- table loses a column or a check. Every statement is safe to run twice.
--
-- Refusals carry SQLSTATEs of their own, in class `RC` (unused by Postgres):
--   RCM01  work on a case that is merged away   (DETAIL = the case id)
--   RCM02  a merge or an undo refused            (HINT   = the reason key)
--   RCM03  a state move the ledger does not back

-- ---------------------------------------------------------------------------
-- 1. `merged` is a state
-- ---------------------------------------------------------------------------
-- Closed, not terminal: its way out is an undo. The list is CASE_STATES in
-- packages/core-domain/src/state-machine.ts; case-states.test.ts reads this
-- constraint back and asserts the two are equal in both directions.
alter table deductions drop constraint if exists deductions_state_check;
alter table deductions add constraint deductions_state_check check (state in (
  'discovered', 'classified', 'evidence_pending', 'evidence_complete', 'decided',
  'auto_dispute_queued', 'analyst_review', 'auto_writeoff_queued',
  'awaiting_approval', 'submitted', 'won', 'lost', 'partial', 'written_off',
  'merged'));

-- The constraint above is the only check on `state`. Migration 0003 declared
-- it inline, so it was named by Postgres; if that name was ever anything else,
-- the old list would still be here refusing `merged`, and this says so now
-- rather than at the first merge.
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

-- ---------------------------------------------------------------------------
-- 2. The verdict standing on each pair
-- ---------------------------------------------------------------------------
-- ADR 0032 wrote a verdict as one event on each case, naming the other in
-- `of`. ADR 0042 adds the one sanctioned reversal, `case.duplicate_verdict_withdrawn`,
-- which an undo writes. The standing verdict is the latest of the three per
-- unordered pair, and `verdict` is null when that latest is a withdrawal — the
-- pair is then an open question again.
--
-- Pairs are keyed as text, the way ADR 0032's reads key them: `payload->>'of'`
-- is text, and casting it would fail the whole read on one malformed value.
create or replace view duplicate_pair_verdicts
with (security_invoker = true) as
select distinct on (e.org_id,
                    least(e.deduction_id::text, lower(e.payload->>'of')),
                    greatest(e.deduction_id::text, lower(e.payload->>'of')))
       e.org_id,
       least(e.deduction_id::text, lower(e.payload->>'of'))    as low_id,
       greatest(e.deduction_id::text, lower(e.payload->>'of')) as high_id,
       case e.event_type
         when 'case.duplicate_confirmed' then 'same'
         when 'case.duplicate_dismissed' then 'different'
       end                                                     as verdict,
       e.id                                                    as event_id,
       e.event_time,
       e.created_by                                            as recorded_by
  from deduction_events e
 where e.event_type in ('case.duplicate_confirmed',
                        'case.duplicate_dismissed',
                        'case.duplicate_verdict_withdrawn')
   and e.payload->>'of' is not null
 order by e.org_id,
          least(e.deduction_id::text, lower(e.payload->>'of')),
          greatest(e.deduction_id::text, lower(e.payload->>'of')),
          e.id desc;

grant select on duplicate_pair_verdicts to app_rw, app_ro;

comment on view duplicate_pair_verdicts is
  'The verdict standing on each possible-duplicate pair (ADR 0032, ADR 0042 §5): '
  'the latest confirmed, dismissed or withdrawn event per unordered pair, keyed as '
  'text. verdict is null when the latest is a withdrawal, which only an undone '
  'merge writes. security_invoker: RLS on deduction_events answers.';

-- ---------------------------------------------------------------------------
-- 3. The record
-- ---------------------------------------------------------------------------
create table if not exists deduction_merges (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id),
  -- The loser: the case that stops being the deduction.
  merged_deduction_id     uuid not null,
  surviving_deduction_id  uuid not null,
  action                  text not null check (action in ('merge', 'unmerge')),
  -- The loser's state when it was merged, which an undo restores. MERGEABLE_STATES
  -- in state-machine.ts: every state before a filing.
  state_before            text check (state_before in (
                            'discovered', 'classified', 'evidence_pending',
                            'evidence_complete', 'decided', 'auto_dispute_queued',
                            'analyst_review', 'auto_writeoff_queued',
                            'awaiting_approval')),
  -- The amount both cases agreed on, to the cent (ADR 0042 §3). Integer cents.
  amount_cents            bigint check (amount_cents > 0),
  -- The confirmation this merge rests on. No foreign key: the check trigger
  -- requires it to be the verdict standing on the pair, which is stronger, and
  -- a key into `deduction_events` would make Postgres refuse a TRUNCATE there
  -- on the key before `block_mutations` could refuse it in its own words.
  verdict_event_id        bigint,
  recorded_by             uuid not null references users(id),
  created_at              timestamptz not null default now(),
  constraint deduction_merges_two_cases
    check (merged_deduction_id <> surviving_deduction_id),
  -- A merge says what it rests on and what it would restore; an undo says
  -- neither, because it is the merge row's to say.
  constraint deduction_merges_shape check (
    case action
      when 'merge' then state_before is not null and amount_cents is not null
                        and verdict_event_id is not null
      else state_before is null and amount_cents is null and verdict_event_id is null
    end),
  -- Both sides are this row's tenant's (ADR 0025 §7), declaratively.
  constraint deduction_merges_merged_same_org
    foreign key (org_id, merged_deduction_id) references deductions (org_id, id),
  constraint deduction_merges_surviving_same_org
    foreign key (org_id, surviving_deduction_id) references deductions (org_id, id)
);

-- Merged at most once and undone at most once, per pair, whichever way round
-- (ADR 0042 §5): a merge cannot flip back and forth.
create unique index if not exists deduction_merges_once_per_pair
  on deduction_merges (org_id,
                       least(merged_deduction_id, surviving_deduction_id),
                       greatest(merged_deduction_id, surviving_deduction_id),
                       action);
create index if not exists deduction_merges_merged_idx
  on deduction_merges (org_id, merged_deduction_id);
create index if not exists deduction_merges_surviving_idx
  on deduction_merges (org_id, surviving_deduction_id);

alter table deduction_merges enable row level security;

do $$
begin
  execute 'drop policy if exists tenant_read on deduction_merges';
  execute 'drop policy if exists tenant_insert on deduction_merges';
  execute 'drop policy if exists tenant_update on deduction_merges';
  execute 'drop policy if exists tenant_delete on deduction_merges';

  execute 'create policy tenant_read on deduction_merges for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on deduction_merges for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  -- Present so a grant issued in a hurry lands on a rule; app_rw holds neither.
  execute 'create policy tenant_update on deduction_merges for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on deduction_merges for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

revoke all on deduction_merges from app_rw;
revoke all on deduction_merges from app_ro;
grant select, insert on deduction_merges to app_rw;
grant select on deduction_merges to app_ro;

-- The grant answers for app_rw; the trigger answers for the owner (0004).
drop trigger if exists no_update_delete on deduction_merges;
create trigger no_update_delete before update or delete on deduction_merges
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on deduction_merges;
create trigger no_truncate before truncate on deduction_merges
  for each statement execute function app.block_mutations();

comment on table deduction_merges is
  'One row per merge of a confirmed duplicate and one per undo (ADR 0042). '
  'Append-only: a merge is undone by an unmerge row, never by an edit. The '
  'database checks each row and moves deductions.state from it; nothing else '
  'may move a case into or out of merged.';

-- Merges with no undo. Every reader that maps a merged-away case onto its
-- survivor reads this, and nothing else (ADR 0042 §10).
create or replace view deduction_merges_current
with (security_invoker = true) as
select m.org_id,
       m.merged_deduction_id,
       m.surviving_deduction_id,
       m.id          as merge_id,
       m.state_before,
       m.created_at  as merged_at,
       m.recorded_by
  from deduction_merges m
 where m.action = 'merge'
   and not exists (
     select 1 from deduction_merges u
      where u.org_id = m.org_id
        and u.action = 'unmerge'
        and u.merged_deduction_id = m.merged_deduction_id
        and u.surviving_deduction_id = m.surviving_deduction_id);

grant select on deduction_merges_current to app_rw, app_ro;

comment on view deduction_merges_current is
  'Merges not undone: which cases are merged away right now, and into what '
  '(ADR 0042). security_invoker: RLS on deduction_merges answers.';

-- ---------------------------------------------------------------------------
-- 4. The rules, once
-- ---------------------------------------------------------------------------
-- Not security definer: each reads the caller's own tenant through RLS, which
-- is the only tenant a merge may touch.

-- How much has been done on a case: 2 filed, 1 decided or declined, 0 neither.
create or replace function app.merge_work_rank(p_deduction uuid) returns integer
  language sql
  stable
  set search_path = pg_catalog, public, extensions
as $$
  select case
    when exists (select 1 from submissions s where s.deduction_id = p_deduction)
      or exists (select 1 from writeoffs w where w.deduction_id = p_deduction)
      or exists (select 1 from writebacks b where b.deduction_id = p_deduction) then 2
    when exists (select 1 from decisions c where c.deduction_id = p_deduction)
      or exists (select 1 from declined_candidates k where k.deduction_id = p_deduction) then 1
    else 0
  end;
$$;

-- Which of two cases survives (ADR 0042 §2): the one worked on further, else
-- the older by (created_at, id). Null when both are filed, or when the caller
-- cannot see both.
create or replace function app.merge_survivor(p_a uuid, p_b uuid) returns uuid
  language sql
  stable
  set search_path = pg_catalog, public, extensions
as $$
  with ranked as (
    select d.id, d.created_at, app.merge_work_rank(d.id) as work
      from deductions d
     where d.id in (p_a, p_b) and p_a <> p_b
  )
  select case
    when (select count(*) from ranked) <> 2 then null
    when (select min(work) from ranked) = 2 then null
    else (select r.id from ranked r order by r.work desc, r.created_at asc, r.id asc limit 1)
  end;
$$;

-- Why two cases cannot be merged right now, or null when they can. The check
-- trigger raises this; the case page shows it. One list of reasons, so the page
-- never says a pair is mergeable that the database would refuse.
create or replace function app.merge_refusal(p_a uuid, p_b uuid) returns text
  language plpgsql
  stable
  set search_path = pg_catalog, public, extensions
as $$
declare
  seen integer;
  standing text;
  survivor uuid;
  loser uuid;
  loser_state text;
  amounts integer;
begin
  select count(*) into seen from deductions d where d.id in (p_a, p_b) and p_a <> p_b;
  if seen <> 2 then
    return 'not_visible';
  end if;

  select v.verdict into standing
    from duplicate_pair_verdicts v
   where v.low_id in (p_a::text, p_b::text)
     and v.high_id in (p_a::text, p_b::text);
  if standing is distinct from 'same' then
    return 'not_confirmed';
  end if;

  if exists (select 1 from deduction_merges_current c
              where c.merged_deduction_id in (p_a, p_b)) then
    return 'already_merged';
  end if;

  if exists (select 1 from deduction_merges m
              where m.action = 'merge'
                and least(m.merged_deduction_id, m.surviving_deduction_id) = least(p_a, p_b)
                and greatest(m.merged_deduction_id, m.surviving_deduction_id) = greatest(p_a, p_b)) then
    return 'merged_before';
  end if;

  survivor := app.merge_survivor(p_a, p_b);
  if survivor is null then
    return 'both_filed';
  end if;
  loser := case when survivor = p_a then p_b else p_a end;

  if exists (select 1 from deduction_merges_current c
              where c.surviving_deduction_id = loser) then
    return 'absorbs_another';
  end if;

  select d.state into loser_state from deductions d where d.id = loser;
  if loser_state not in ('discovered', 'classified', 'evidence_pending',
                         'evidence_complete', 'decided', 'auto_dispute_queued',
                         'analyst_review', 'auto_writeoff_queued',
                         'awaiting_approval') then
    return 'not_mergeable_state';
  end if;

  select count(distinct d.deduction_amount_cents) into amounts
    from deductions d where d.id in (p_a, p_b);
  if amounts <> 1 then
    return 'amounts_disagree';
  end if;

  return null;
end
$$;

revoke all on function app.merge_work_rank(uuid) from public;
revoke all on function app.merge_survivor(uuid, uuid) from public;
revoke all on function app.merge_refusal(uuid, uuid) from public;
grant execute on function app.merge_work_rank(uuid) to app_rw, app_ro;
grant execute on function app.merge_survivor(uuid, uuid) to app_rw, app_ro;
grant execute on function app.merge_refusal(uuid, uuid) to app_rw, app_ro;

-- ---------------------------------------------------------------------------
-- 5. A merge row is checked before it lands, and projected after
-- ---------------------------------------------------------------------------
create or replace function app.check_deduction_merge() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  reason text;
  loser_state text;
  loser_amount bigint;
  standing bigint;
begin
  if new.recorded_by is distinct from app.current_user_id() then
    raise exception 'merge refused: a merge is recorded by the person making it'
      using errcode = 'RCM02', hint = 'not_the_caller';
  end if;

  -- Both cases, held until commit, in id order so two merges over overlapping
  -- pairs cannot deadlock; the store takes the same locks in the same order.
  perform 1 from deductions d
    where d.id in (new.merged_deduction_id, new.surviving_deduction_id)
    order by d.id
    for update;

  if new.action = 'unmerge' then
    if not exists (select 1 from deduction_merges_current c
                    where c.merged_deduction_id = new.merged_deduction_id
                      and c.surviving_deduction_id = new.surviving_deduction_id) then
      raise exception 'undo refused: case % is not merged into case %',
        new.merged_deduction_id, new.surviving_deduction_id
        using errcode = 'RCM02', hint = 'not_merged';
    end if;
    return new;
  end if;

  reason := app.merge_refusal(new.merged_deduction_id, new.surviving_deduction_id);
  if reason is not null then
    raise exception 'merge refused: case % and case % cannot be merged (%)',
      new.merged_deduction_id, new.surviving_deduction_id, reason
      using errcode = 'RCM02', hint = reason;
  end if;

  -- The row must say what the database would: which one survives, the state it
  -- would restore, the amount, and the verdict it rests on.
  if app.merge_survivor(new.merged_deduction_id, new.surviving_deduction_id)
       is distinct from new.surviving_deduction_id then
    raise exception 'merge refused: case % is not the one that survives', new.surviving_deduction_id
      using errcode = 'RCM02', hint = 'wrong_survivor';
  end if;

  select d.state, d.deduction_amount_cents into loser_state, loser_amount
    from deductions d where d.id = new.merged_deduction_id;
  if new.state_before is distinct from loser_state then
    raise exception 'merge refused: case % is %, not %',
      new.merged_deduction_id, loser_state, new.state_before
      using errcode = 'RCM02', hint = 'stale_state';
  end if;
  if new.amount_cents is distinct from loser_amount then
    raise exception 'merge refused: the amount recorded is not the amount on case %',
      new.merged_deduction_id
      using errcode = 'RCM02', hint = 'amounts_disagree';
  end if;

  select v.event_id into standing
    from duplicate_pair_verdicts v
   where v.low_id in (new.merged_deduction_id::text, new.surviving_deduction_id::text)
     and v.high_id in (new.merged_deduction_id::text, new.surviving_deduction_id::text);
  if new.verdict_event_id is distinct from standing then
    raise exception 'merge refused: verdict % is not the one standing on this pair',
      new.verdict_event_id
      using errcode = 'RCM02', hint = 'stale_verdict';
  end if;

  return new;
end
$$;

-- The projection: the row is the fact, and the state and the events follow
-- from it in the same statement, so a merge row cannot exist without them.
create or replace function app.project_deduction_merge() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  merge_row deduction_merges%rowtype;
begin
  if new.action = 'merge' then
    update deductions set state = 'merged', updated_at = now()
     where id = new.merged_deduction_id;

    insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (new.org_id, new.merged_deduction_id, 'case.merged_into',
            jsonb_build_object(
              'into', new.surviving_deduction_id,
              'merge_id', new.id,
              'state_before', new.state_before,
              'verdict_event_id', new.verdict_event_id,
              'recorded_by', new.recorded_by),
            now(), new.recorded_by);
    insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
    values (new.org_id, new.surviving_deduction_id, 'case.absorbed',
            jsonb_build_object(
              'from', new.merged_deduction_id,
              'merge_id', new.id,
              'recorded_by', new.recorded_by),
            now(), new.recorded_by);
    return null;
  end if;

  select m.* into merge_row
    from deduction_merges m
   where m.action = 'merge'
     and m.merged_deduction_id = new.merged_deduction_id
     and m.surviving_deduction_id = new.surviving_deduction_id;

  update deductions set state = merge_row.state_before, updated_at = now()
   where id = new.merged_deduction_id;

  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
  values (new.org_id, new.merged_deduction_id, 'case.merge_undone',
          jsonb_build_object(
            'into', new.surviving_deduction_id,
            'merge_id', merge_row.id,
            'unmerge_id', new.id,
            'restored_state', merge_row.state_before,
            'recorded_by', new.recorded_by),
          now(), new.recorded_by);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
  values (new.org_id, new.surviving_deduction_id, 'case.merge_undone',
          jsonb_build_object(
            'from', new.merged_deduction_id,
            'merge_id', merge_row.id,
            'unmerge_id', new.id,
            'recorded_by', new.recorded_by),
          now(), new.recorded_by);

  -- The verdict goes with the merge (ADR 0042 §5), on both cases, each naming
  -- the other as the verdict did, so the pair is an open question again.
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
  values (new.org_id, new.merged_deduction_id, 'case.duplicate_verdict_withdrawn',
          jsonb_build_object(
            'of', new.surviving_deduction_id,
            'because', 'merge_undone',
            'withdrawn_event_id', merge_row.verdict_event_id,
            'unmerge_id', new.id,
            'recorded_by', new.recorded_by),
          now(), new.recorded_by);
  insert into deduction_events (org_id, deduction_id, event_type, payload, event_time, created_by)
  values (new.org_id, new.surviving_deduction_id, 'case.duplicate_verdict_withdrawn',
          jsonb_build_object(
            'of', new.merged_deduction_id,
            'because', 'merge_undone',
            'withdrawn_event_id', merge_row.verdict_event_id,
            'unmerge_id', new.id,
            'recorded_by', new.recorded_by),
          now(), new.recorded_by);
  return null;
end
$$;

revoke all on function app.check_deduction_merge() from public;
revoke all on function app.project_deduction_merge() from public;

drop trigger if exists check_deduction_merge on deduction_merges;
create trigger check_deduction_merge before insert on deduction_merges
  for each row execute function app.check_deduction_merge();
drop trigger if exists project_deduction_merge on deduction_merges;
create trigger project_deduction_merge after insert on deduction_merges
  for each row execute function app.project_deduction_merge();

-- ---------------------------------------------------------------------------
-- 6. The state is the ledger's projection, and nothing else moves it
-- ---------------------------------------------------------------------------
create or replace function app.merged_state_is_a_projection() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  restored text;
begin
  if tg_op = 'INSERT' then
    if new.state = 'merged' then
      raise exception 'a case is not opened merged: a merge is a deduction_merges row'
        using errcode = 'RCM03';
    end if;
    return new;
  end if;

  if new.state is not distinct from old.state then
    return new;
  end if;

  if new.state = 'merged' then
    if not exists (select 1 from deduction_merges_current c
                    where c.merged_deduction_id = new.id
                      and c.state_before = old.state) then
      raise exception 'case % cannot become merged: no merge of it is recorded', new.id
        using errcode = 'RCM03';
    end if;
    return new;
  end if;

  if old.state = 'merged' then
    if exists (select 1 from deduction_merges_current c where c.merged_deduction_id = new.id) then
      raise exception 'case % is still merged: undo the merge to move it', new.id
        using errcode = 'RCM03';
    end if;
    select m.state_before into restored
      from deduction_merges u
      join deduction_merges m
        on m.action = 'merge'
       and m.merged_deduction_id = u.merged_deduction_id
       and m.surviving_deduction_id = u.surviving_deduction_id
     where u.action = 'unmerge' and u.merged_deduction_id = new.id
     order by u.created_at desc, u.id desc
     limit 1;
    if restored is distinct from new.state then
      raise exception 'case % returns from merged only to %, not %', new.id, restored, new.state
        using errcode = 'RCM03';
    end if;
  end if;

  return new;
end
$$;

revoke all on function app.merged_state_is_a_projection() from public;

drop trigger if exists merged_state_is_a_projection on deductions;
create trigger merged_state_is_a_projection before insert or update of state on deductions
  for each row execute function app.merged_state_is_a_projection();

-- ---------------------------------------------------------------------------
-- 7. Nothing more is hung on a merged-away case
-- ---------------------------------------------------------------------------
-- A decision, a packet, a filing, a decline, a document or an identifier on a
-- loser is work done on a case that is not the deduction. The row lock first:
-- a BEFORE trigger runs before the foreign key's own KEY SHARE, so without it
-- an insert that started while a merge was in flight would read no merge,
-- commit after it, and land on the loser.
--
-- Named so it sorts after `enforce_approval`, `human_decision_names_its_author`
-- and `packet_matches_its_decision`: same-timing triggers fire alphabetically,
-- and those keep their own words for what they refuse.
create or replace function app.refuse_work_on_merged_case() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  if new.deduction_id is null then
    return new;
  end if;

  perform 1 from deductions d where d.id = new.deduction_id for key share;

  if exists (select 1 from deduction_merges_current c
              where c.merged_deduction_id = new.deduction_id) then
    raise exception 'case % was merged into another case: record this on the case it was merged into',
      new.deduction_id
      using errcode = 'RCM01', detail = new.deduction_id::text, hint = tg_table_name;
  end if;
  return new;
end
$$;

revoke all on function app.refuse_work_on_merged_case() from public;

do $$
declare t text;
begin
  foreach t in array array['decisions', 'packets', 'submissions', 'writeoffs', 'writebacks',
                           'declined_candidates', 'deduction_documents', 'deduction_identifiers']
  loop
    execute format('drop trigger if exists refuse_work_on_merged_case on %I', t);
    execute format(
      'create trigger refuse_work_on_merged_case before insert on %I
         for each row execute function app.refuse_work_on_merged_case()', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Coverage counts a merged pair once, under the first copy's channel
-- ---------------------------------------------------------------------------
-- Migration 0029's view, with three changes and no others (ADR 0042 §8):
--
--   * a case merged away leaves `opened`;
--   * a surviving case is counted in the month, and under the channel, of the
--     earliest notice across itself and every case merged into it — ADR 0024's
--     "the first arrival is how it reached us", for a group;
--   * a decline on a merged-away case leaves `declined_*`.
--
-- Same columns, names, order and types: `create or replace view` cannot change
-- them, the totals view reads this one by column, and on db:test's second pass
-- 0023 and 0029 re-create their bodies before this file replaces them again.
-- `coverage_by_period_totals` inherits all of it. `coverage_by_period` (0014) is
-- not touched.
create or replace view coverage_by_period_by_source
with (security_invoker = true) as
with merged_away as (
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
      or not exists (select 1 from merged_away m where m.merged_deduction_id = k.deduction_id)
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
  'deduction of its own: it leaves every column, and its survivor is counted in '
  'the month and under the channel of the earliest notice across the two '
  '(ADR 0042). A case opened and later declined stays in opened_cents and also '
  'appears in declined_cents, so opened plus declined is not discovered — read '
  'discovered_cents. A case''s channel is derived from its earliest notice '
  'document and is ''unknown'' when nothing recorded how it arrived — never '
  'guessed. security_invoker: RLS on the underlying tables answers, so this view '
  'is per tenant. It measures coverage of the candidates we examined, NOT of every '
  'disputable dollar that exists — see ADR 0030 §5 for what is still missing.';
