-- 0035 — An owner manages their own team (ADR 0051).
--
-- Until now every person in every workspace was a row an operator inserted as
-- the database owner (docs/ONBOARDING.md §1, §5). `users` has no write policy
-- and no tenant column, so no request could create one; `memberships` writes
-- were owner-only (0030) but nothing stopped the result being a workspace with
-- no owner at all.
--
-- This adds:
--
--   1. `app.membership_keeps_an_owner()`, an AFTER UPDATE OR DELETE row trigger
--      on `memberships`: no change may leave an org that lost an owner row with
--      none. Every path — the functions below, a raw write by an owner as
--      app_rw, the operator's SQL — meets it.
--   2. Three security definer functions, the only door a request has to its
--      team: `app.invite_member`, `app.change_member_role`,
--      `app.remove_member`. Each is bounded to the caller's own org claim,
--      refuses a caller who is not an owner there, and writes one `audit_log`
--      row naming the caller. EXECUTE: app_rw alone.
--
-- What is deliberately NOT here: any change to a table's grants or policies,
-- any new table, and anything on an append-only table but an `audit_log` INSERT
-- through the existing chain. `memberships` and `users` keep 0006's grants
-- exactly. No UPDATE or DELETE grant is added. `app.require_approval()`,
-- `app.member_may_write()`, `app.member_is_owner()`, `app.block_mutations()`,
-- `app.guard_threshold_direction()` and `app.link_auth_user()` are untouched.
-- Nothing here creates a Supabase Auth user (ADR 0051 §6).
--
-- Error codes, which the store maps to named refusals:
--   42501  the caller is not an owner of the org their claims name, or has none
--   22023  an address, name or role the function will not accept
--   21000  two users rows answer to the address in different capitals
--   RCT01  the person is already a member of this workspace
--   RCT02  the change would leave the workspace with no owner (the trigger)
--   RCT03  the user id is not a member of this workspace
--   RCT04  the member is who a QuickBooks connection or an email address acts as
--   RCT05  the change would leave fewer than two people who can write
--
-- Advisory locks are seed 4: 0 is a document read, 1 a remittance claim, 2 a
-- ledger refresh, 3 an inbound message. The org's team lock is always taken
-- before an address lock, so these functions cannot deadlock one another.
--
-- Idempotent: `create or replace`, `drop trigger if exists`, and re-runnable
-- revoke/grant pairs. scripts/db-test.sh applies it twice, and
-- supabase/tests/31_an_owner_manages_their_own_team.sql reads the end state.

-- ---------------------------------------------------------------------------
-- 1. A workspace always has an owner
-- ---------------------------------------------------------------------------
create or replace function app.membership_keeps_an_owner() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  v_slug text;
begin
  -- Only a change that took an owner row away can leave an org without one.
  if old.role <> 'owner' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner'
     and new.org_id = old.org_id and new.user_id = old.user_id then
    return null;
  end if;

  -- Two owners demoting each other at once: the second waits here, then
  -- counts with a fresh snapshot (READ COMMITTED) and sees the first.
  perform pg_advisory_xact_lock(hashtextextended('team:' || old.org_id::text, 4));

  if not exists (
    select 1 from memberships m
     where m.org_id = old.org_id and m.role = 'owner'
  ) then
    select o.slug into v_slug from organizations o where o.id = old.org_id;
    raise exception 'that would leave % with no owner', coalesce(v_slug, old.org_id::text)
      using errcode = 'RCT02',
            hint = 'Make someone else an owner first, then change or remove this one.';
  end if;
  return null;
end
$$;

comment on function app.membership_keeps_an_owner() is
  'AFTER UPDATE OR DELETE on memberships: refuses any change after which an org '
  'that lost an owner row has none (ADR 0051 §3). Not deferrable: promote first, '
  'then demote.';

revoke all on function app.membership_keeps_an_owner() from public;

drop trigger if exists membership_keeps_an_owner on memberships;
create trigger membership_keeps_an_owner
  after update or delete on memberships
  for each row execute function app.membership_keeps_an_owner();

-- ---------------------------------------------------------------------------
-- 2. Who may change a team: an owner, acting for their own org
-- ---------------------------------------------------------------------------
-- Not granted to anyone: only the three definer functions below call it, and
-- they run as its owner. It returns the org so no caller can name another.
create or replace function app.team_owner_org(act text) returns uuid
  language plpgsql
  stable
  set search_path = pg_catalog, public, extensions
as $$
begin
  if app.current_org_id() is null or app.current_user_id() is null then
    raise exception '% acts for a member of a workspace, and needs both an org and a subject claim', act
      using errcode = 'insufficient_privilege';
  end if;
  if not app.member_is_owner() then
    raise exception 'only an owner of this workspace can %', act
      using errcode = 'insufficient_privilege';
  end if;
  return app.current_org_id();
end
$$;

revoke all on function app.team_owner_org(text) from public;

-- Whether a member is who something acts as (ADR 0051 §4): an enabled ledger
-- connection runs as its `created_by`; a live email address acts as its latest
-- adopter, else its issuer (ADR 0047 §6). Not granted to anyone.
create or replace function app.team_member_holds(org uuid, member uuid, what text) returns boolean
  language sql
  stable
  set search_path = pg_catalog, public, extensions
as $$
  select case what
    when 'ledger' then exists (
      select 1 from accounting_connections c
       where c.org_id = org and c.enabled and c.created_by = member)
    when 'email' then exists (
      select 1 from inbound_addresses a
       where a.org_id = org
         and not exists (select 1 from inbound_address_retirements r where r.address_id = a.id)
         and coalesce((select ad.adopted_by from inbound_address_adoptions ad
                        where ad.address_id = a.id
                        order by ad.adopted_at desc, ad.id desc limit 1),
                      a.created_by) = member)
  end;
$$;

revoke all on function app.team_member_holds(uuid, uuid, text) from public;

-- ---------------------------------------------------------------------------
-- 3. Invite: a users row (reused ignoring capitals) and a membership
-- ---------------------------------------------------------------------------
create or replace function app.invite_member(
  member_email text,
  member_full_name text,
  member_role membership_role
)
  returns table (member_user_id uuid, users_row_created boolean, has_signed_in boolean)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  v_org     uuid := app.team_owner_org('invite a member');
  v_email   text := btrim(coalesce(member_email, ''));
  v_name    text := nullif(btrim(coalesce(member_full_name, '')), '');
  v_user    uuid;
  v_linked  uuid;
  v_count   int;
  v_have    membership_role;
  v_created boolean := false;
begin
  if member_role is null then
    raise exception 'a role is required' using errcode = 'invalid_parameter_value';
  end if;
  if length(v_email) > 254
     or v_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+\.[^@[:space:][:cntrl:]]+$' then
    raise exception 'not an email address' using errcode = 'invalid_parameter_value';
  end if;
  if v_name is not null and (length(v_name) > 200 or v_name ~ '[[:cntrl:]]') then
    raise exception 'a name is at most 200 characters, with no control characters'
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('team:' || v_org::text, 4));
  perform pg_advisory_xact_lock(hashtextextended('user:' || lower(v_email), 4));

  -- users.email is unique case-sensitively only. One person, one row: reuse
  -- the one that answers ignoring capitals, and refuse where two already do
  -- (ADR 0051 §2; link_auth_user refuses the same pair, 0033).
  select count(*) into v_count from users u where lower(u.email) = lower(v_email);
  if v_count > 1 then
    raise exception 'more than one user answers to that address, differing only in case: an operator must decide which one this person is'
      using errcode = 'cardinality_violation';
  elsif v_count = 1 then
    select u.id, u.auth_user_id into v_user, v_linked
      from users u where lower(u.email) = lower(v_email);
  else
    insert into users (email, full_name) values (v_email, v_name)
      returning id into v_user;
    v_created := true;
  end if;

  select m.role into v_have from memberships m
   where m.org_id = v_org and m.user_id = v_user;
  if v_have is not null then
    raise exception 'already a member of this workspace as %', v_have
      using errcode = 'RCT01',
            hint = 'A role is changed on its own, never by inviting again.';
  end if;

  insert into memberships (org_id, user_id, role) values (v_org, v_user, member_role);

  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
  values (v_org, app.current_user_id(), 'membership.invited', 'memberships', v_user::text,
          jsonb_build_object('role', member_role,
                             'users_row', case when v_created then 'created' else 'reused' end));

  return query select v_user, v_created, v_linked is not null;
end
$$;

comment on function app.invite_member(text, text, membership_role) is
  'An owner adds a person to their own workspace (ADR 0051): reuses the users '
  'row that answers to the address ignoring capitals, else creates one, then '
  'adds the membership and an audit row. Refuses a non-owner, an existing '
  'member, and an address two users rows answer to. Creates no sign-in.';

revoke all on function app.invite_member(text, text, membership_role) from public;
grant execute on function app.invite_member(text, text, membership_role) to app_rw;

-- ---------------------------------------------------------------------------
-- 4. Change a role
-- ---------------------------------------------------------------------------
create or replace function app.change_member_role(member_user_id uuid, new_role membership_role)
  returns membership_role
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  v_org  uuid := app.team_owner_org('change a role');
  v_was  membership_role;
begin
  if member_user_id is null or new_role is null then
    raise exception 'a member and a role are required' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('team:' || v_org::text, 4));

  select m.role into v_was from memberships m
   where m.org_id = v_org and m.user_id = member_user_id
     for update;
  if v_was is null then
    raise exception 'not a member of this workspace' using errcode = 'RCT03';
  end if;
  if v_was = new_role then
    return v_was;  -- nothing changed, and nothing is recorded
  end if;

  if new_role <> 'owner' and app.team_member_holds(v_org, member_user_id, 'ledger') then
    raise exception 'holds this workspace''s QuickBooks connection: another owner must press Connect QuickBooks first'
      using errcode = 'RCT04';
  end if;
  if new_role not in ('owner', 'approver', 'analyst')
     and app.team_member_holds(v_org, member_user_id, 'email') then
    raise exception 'a live email address acts as this member: another owner must Adopt it first'
      using errcode = 'RCT04';
  end if;

  update memberships m set role = new_role
   where m.org_id = v_org and m.user_id = member_user_id;

  if v_was in ('owner', 'approver', 'analyst')
     and new_role not in ('owner', 'approver', 'analyst')
     and (select count(*) from memberships m
           where m.org_id = v_org and m.role in ('owner', 'approver', 'analyst')) < 2 then
    raise exception 'that would leave fewer than two people who can write: nobody could approve what the other prepared'
      using errcode = 'RCT05';
  end if;

  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
  values (v_org, app.current_user_id(), 'membership.role_changed', 'memberships',
          member_user_id::text, jsonb_build_object('from', v_was, 'to', new_role));

  return v_was;
end
$$;

comment on function app.change_member_role(uuid, membership_role) is
  'An owner changes a member''s role in their own workspace (ADR 0051), and '
  'returns the role it was. Refuses a non-owner, a user who is not a member '
  'here, demoting whoever a QuickBooks connection or a live email address acts '
  'as, and leaving fewer than two writers; the trigger refuses leaving no owner.';

revoke all on function app.change_member_role(uuid, membership_role) from public;
grant execute on function app.change_member_role(uuid, membership_role) to app_rw;

-- ---------------------------------------------------------------------------
-- 5. Remove: the membership, and nothing else
-- ---------------------------------------------------------------------------
create or replace function app.remove_member(member_user_id uuid)
  returns membership_role
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  v_org uuid := app.team_owner_org('remove a member');
  v_was membership_role;
begin
  if member_user_id is null then
    raise exception 'a member is required' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('team:' || v_org::text, 4));

  select m.role into v_was from memberships m
   where m.org_id = v_org and m.user_id = member_user_id
     for update;
  if v_was is null then
    raise exception 'not a member of this workspace' using errcode = 'RCT03';
  end if;

  if app.team_member_holds(v_org, member_user_id, 'ledger') then
    raise exception 'holds this workspace''s QuickBooks connection: another owner must press Connect QuickBooks first'
      using errcode = 'RCT04';
  end if;
  if app.team_member_holds(v_org, member_user_id, 'email') then
    raise exception 'a live email address acts as this member: another owner must Adopt it first'
      using errcode = 'RCT04';
  end if;

  -- The users row stays: decisions, approvals and events name it, and it may
  -- be another workspace's member.
  delete from memberships m where m.org_id = v_org and m.user_id = member_user_id;

  if v_was in ('owner', 'approver', 'analyst')
     and (select count(*) from memberships m
           where m.org_id = v_org and m.role in ('owner', 'approver', 'analyst')) < 2 then
    raise exception 'that would leave fewer than two people who can write: nobody could approve what the other prepared'
      using errcode = 'RCT05';
  end if;

  insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
  values (v_org, app.current_user_id(), 'membership.removed', 'memberships',
          member_user_id::text, jsonb_build_object('role', v_was));

  return v_was;
end
$$;

comment on function app.remove_member(uuid) is
  'An owner removes a member from their own workspace (ADR 0051): deletes the '
  'membership, never the users row, and returns the role it held. Refuses what '
  'app.change_member_role refuses for a demotion to nothing.';

revoke all on function app.remove_member(uuid) from public;
grant execute on function app.remove_member(uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- 6. The end state, re-read. Abort, do not warn.
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
begin
  for fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'app'
       and p.proname in ('invite_member', 'change_member_role', 'remove_member',
                         'team_owner_org', 'team_member_holds', 'membership_keeps_an_owner')
  loop
    if not coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false) then
      raise exception '0035: app.% has no pinned search_path', fn.proname;
    end if;
    if has_function_privilege('public', fn.oid, 'execute')
       or has_function_privilege('app_ro', fn.oid, 'execute') then
      raise exception '0035: app.% is executable beyond app_rw', fn.proname;
    end if;
    if fn.proname in ('invite_member', 'change_member_role', 'remove_member') then
      if not fn.prosecdef then
        raise exception '0035: app.% is not security definer', fn.proname;
      end if;
      if not has_function_privilege('app_rw', fn.oid, 'execute') then
        raise exception '0035: app_rw cannot execute app.%', fn.proname;
      end if;
    elsif fn.prosecdef then
      raise exception '0035: app.% must not be security definer', fn.proname;
    end if;
  end loop;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'memberships'::regclass
                    and tgname = 'membership_keeps_an_owner' and not tgisinternal) then
    raise exception '0035: memberships has no membership_keeps_an_owner trigger';
  end if;
end
$$;
