-- 0041 — a settlement's journal lines are what the approver approves (ADR 0068)
--
-- Schema only. Three changes:
--   1. `unique (org_id, id)` on `decisions`, so the table below can carry the
--      tenancy tie as a composite foreign key (ADR 0025 §7).
--   2. `settlement_lines`: the journal lines a settlement decision (schema
--      'S', ADR 0060 §2) was prepared with. Append-only on 0004's pattern;
--      RLS; `app_rw` SELECT and INSERT, `app_ro` SELECT. A line names its
--      author, who is the decision's preparer, and is refused once the
--      decision has an approval.
--   3. `app.settlement_lines_are_whole()`, run at commit by two deferred
--      constraint triggers (one on `settlement_lines`, one on `decisions`):
--      a decision whose `result` carries no `line_count` has no lines; one
--      that does has exactly lines 1..line_count, and their debits equal
--      their credits. `decisions` is append-only, so the count is fixed, and
--      a line can be neither changed nor removed — the set an approver saw is
--      the set that exists.
--
-- What is deliberately NOT here: any change to `app.require_approval()`, to
-- `app.enforce_separation_of_duties()` or to the `enforce_approval` triggers,
-- any UPDATE or DELETE grant, and any change to `writebacks`.
--
-- Idempotent: `scripts/db-test.sh` applies every migration twice.

-- ---------------------------------------------------------------------------
-- 1. decisions (org_id, id) — implied by the primary key; one index
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'decisions'::regclass
       and conname = 'decisions_org_id_id_key'
  ) then
    alter table decisions add constraint decisions_org_id_id_key unique (org_id, id);
  end if;
end
$$;

comment on constraint decisions_org_id_id_key on decisions is
  'So a child row can name a decision of its own tenant as a composite foreign '
  'key (ADR 0025 §7; ADR 0068 §2). Additive: no column, grant or policy changes.';

-- ---------------------------------------------------------------------------
-- 2. The lines
-- ---------------------------------------------------------------------------
create table if not exists settlement_lines (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations(id),
  decision_id               uuid not null,
  line_no                   integer not null,
  -- The ledger's own id for the account, and its name and type as the chart
  -- of accounts reported them when the decision was prepared.
  account_external_id       text not null,
  account_name_as_reported  text not null,
  account_type_as_reported  text not null,
  -- Integer cents (invariant 3). One side per line.
  debit_cents               bigint not null default 0,
  credit_cents              bigint not null default 0,
  -- Typed by a person on the prepare form; never text off a document.
  memo                      text,
  created_by                uuid not null references users(id),
  created_at                timestamptz not null default now(),
  constraint settlement_lines_same_org
    foreign key (org_id, decision_id) references decisions (org_id, id),
  constraint settlement_lines_line_once unique (decision_id, line_no),
  constraint settlement_lines_line_no check (line_no between 1 and 20),
  constraint settlement_lines_account_id
    check (char_length(account_external_id) between 1 and 64),
  constraint settlement_lines_account_name
    check (char_length(account_name_as_reported) between 1 and 500),
  constraint settlement_lines_account_type
    check (char_length(account_type_as_reported) between 1 and 100),
  constraint settlement_lines_one_side check (
    debit_cents >= 0 and credit_cents >= 0
    and (debit_cents > 0) <> (credit_cents > 0)
  ),
  constraint settlement_lines_memo check (
    memo is null
    or (char_length(memo) between 1 and 500 and memo !~ '[[:cntrl:]]')
  )
);

comment on table settlement_lines is
  'The journal lines a settlement decision was prepared with (ADR 0068). '
  'Append-only: an edit is a new decision with its own lines. The decision''s '
  'result.line_count pins how many there are, and they balance, at commit.';
comment on column settlement_lines.memo is
  'Typed by a person. Reaches the accounting system as the line''s description '
  'and nothing else: never an event, an audit row or a log line (ADR 0068 §5).';

create index if not exists settlement_lines_decision_idx
  on settlement_lines (org_id, decision_id, line_no);

create or replace function app.settlement_line_is_its_preparers() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  d record;
begin
  -- No exception for the table owner or a session with no claims.
  if new.created_by is distinct from app.current_user_id() then
    raise exception
      'settlement line blocked: created_by % is not the caller %',
      new.created_by, coalesce(app.current_user_id()::text, '(no session)')
      using errcode = 'restrict_violation';
  end if;

  select schema_id, provider, prepared_by into d
    from decisions where id = new.decision_id and org_id = new.org_id;
  if not found then
    raise exception 'settlement line blocked: decision % is not this tenant''s',
      new.decision_id using errcode = 'restrict_violation';
  end if;
  if d.schema_id is distinct from 'S' or d.provider is distinct from 'human' then
    raise exception
      'settlement line blocked: decision % is not a person''s settlement decision',
      new.decision_id using errcode = 'restrict_violation';
  end if;
  if d.prepared_by is distinct from new.created_by then
    raise exception
      'settlement line blocked: decision % was prepared by someone else',
      new.decision_id using errcode = 'restrict_violation';
  end if;
  -- What was approved is not added to (ADR 0068 §2). The commit-time count
  -- below refuses it too; this says why, at the statement.
  if exists (select 1 from approvals a where a.decision_id = new.decision_id) then
    raise exception
      'settlement line blocked: decision % is already approved',
      new.decision_id using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
revoke all on function app.settlement_line_is_its_preparers() from public;

drop trigger if exists settlement_line_is_its_preparers on settlement_lines;
create trigger settlement_line_is_its_preparers before insert on settlement_lines
  for each row execute function app.settlement_line_is_its_preparers();

alter table settlement_lines enable row level security;

do $$
declare
  r text;
begin
  execute 'drop policy if exists tenant_read on settlement_lines';
  execute 'drop policy if exists tenant_insert on settlement_lines';
  execute 'create policy tenant_read on settlement_lines for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on settlement_lines for insert
             with check (org_id = app.current_org_id() and app.member_may_write()
                         and created_by = app.current_user_id())';

  execute 'revoke all on settlement_lines from public';
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on settlement_lines from %I', r);
    end if;
  end loop;
  execute 'revoke all on settlement_lines from app_rw';
  execute 'revoke all on settlement_lines from app_ro';
  execute 'grant select, insert on settlement_lines to app_rw';
  execute 'grant select on settlement_lines to app_ro';
end
$$;

drop trigger if exists no_update_delete on settlement_lines;
create trigger no_update_delete before update or delete on settlement_lines
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on settlement_lines;
create trigger no_truncate before truncate on settlement_lines
  for each statement execute function app.block_mutations();

-- ---------------------------------------------------------------------------
-- 3. Whole and balanced, at commit
-- ---------------------------------------------------------------------------
create or replace function app.settlement_lines_are_whole() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  -- One function for both tables: the row is read as jsonb because plpgsql
  -- resolves `new.<column>` for whichever table fired it.
  decision uuid := (to_jsonb(new) ->>
    case tg_table_name when 'decisions' then 'id' else 'decision_id' end)::uuid;
  pinned text;
  wanted integer;
  have integer;
  lowest integer;
  highest integer;
  debits numeric;
  credits numeric;
begin
  select d.result ->> 'line_count' into pinned from decisions d where d.id = decision;
  if not found then
    raise exception 'settlement lines blocked: decision % cannot be read', decision
      using errcode = 'restrict_violation';
  end if;

  select count(*)::integer, min(l.line_no), max(l.line_no),
         coalesce(sum(l.debit_cents), 0), coalesce(sum(l.credit_cents), 0)
    into have, lowest, highest, debits, credits
    from settlement_lines l where l.decision_id = decision;

  if pinned is null then
    -- A decision that pins no count has no lines, now or later.
    if have > 0 then
      raise exception
        'settlement lines blocked: decision % carries no line_count and has % line(s)',
        decision, have using errcode = 'check_violation';
    end if;
    return null;
  end if;

  if pinned !~ '^[0-9]{1,2}$' then
    raise exception 'settlement lines blocked: decision % has a line_count that is not a count',
      decision using errcode = 'check_violation';
  end if;
  wanted := pinned::integer;
  if wanted < 2 or wanted > 20 then
    raise exception 'settlement lines blocked: decision % pins % lines; an entry has 2 to 20',
      decision, wanted using errcode = 'check_violation';
  end if;
  -- `unique (decision_id, line_no)` makes count, lowest and highest together
  -- say "exactly 1..wanted".
  if have <> wanted or lowest <> 1 or highest <> wanted then
    raise exception
      'settlement lines blocked: decision % pins % lines and has % (numbered % to %)',
      decision, wanted, have, coalesce(lowest::text, 'none'), coalesce(highest::text, 'none')
      using errcode = 'check_violation';
  end if;
  if debits <> credits then
    raise exception
      'settlement lines blocked: decision % does not balance: % debit, % credit',
      decision, debits, credits using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke all on function app.settlement_lines_are_whole() from public;

comment on function app.settlement_lines_are_whole() is
  'Run at commit for a new settlement decision and for every decision a new '
  'settlement line names (ADR 0068 §2): no line_count means no lines; '
  'otherwise exactly lines 1..line_count, debits equal to credits.';

drop trigger if exists settlement_lines_are_whole on settlement_lines;
create constraint trigger settlement_lines_are_whole
  after insert on settlement_lines
  deferrable initially deferred
  for each row execute function app.settlement_lines_are_whole();

drop trigger if exists settlement_decision_is_whole on decisions;
create constraint trigger settlement_decision_is_whole
  after insert on decisions
  deferrable initially deferred
  for each row when (new.schema_id = 'S')
  execute function app.settlement_lines_are_whole();

-- ---------------------------------------------------------------------------
-- A closing read of the catalogue: abort rather than warn
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'settlement_lines'::regclass) then
    raise exception '0041: settlement_lines has no row level security';
  end if;
  if has_table_privilege('app_rw', 'settlement_lines', 'update')
     or has_table_privilege('app_rw', 'settlement_lines', 'delete')
     or has_table_privilege('app_rw', 'settlement_lines', 'truncate')
     or has_table_privilege('app_ro', 'settlement_lines', 'insert') then
    raise exception '0041: an app role holds more than it should on settlement_lines';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r)
       and has_table_privilege(r, 'settlement_lines',
             'select, insert, update, delete, truncate, references, trigger') then
      raise exception '0041: % holds a privilege on settlement_lines', r;
    end if;
  end loop;
  if (select count(*) from pg_trigger
       where not tgisinternal
         and ((tgrelid = 'settlement_lines'::regclass
               and tgname in ('no_update_delete', 'no_truncate',
                              'settlement_line_is_its_preparers',
                              'settlement_lines_are_whole'))
           or (tgrelid = 'decisions'::regclass
               and tgname = 'settlement_decision_is_whole'))) <> 5 then
    raise exception '0041: a settlement_lines trigger is missing';
  end if;
end
$$;
