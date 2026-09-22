-- 0026 — An operator command connects as the app (ADR 0034).
--
-- `pnpm link:retailer`, `link:provenance` and `link:qbo` each turn an org slug
-- and a member's email into ids before they can act as that member. They did it
-- on a raw connection with no role and no claims, which works only for the
-- owner login: on the prescribed login (`recouple_app`, a member of `app_rw` and
-- `app_ro` with no privileges of its own, docs/supabase.md) the first statement
-- fails with "permission denied for schema app".
--
-- The lookup cannot be done under RLS, because the policies on `organizations`
-- and `users` key on the org claim the command is trying to learn (ADR 0034,
-- option b). So one definer function answers that one question and nothing
-- else — `app.my_orgs()`'s shape (0012), with `ledger_connections_to_sync()`'s
-- guard (0024) widened to refuse any caller that carries a claim at all.
--
-- What is deliberately NOT here: any table, column, grant on a table, trigger or
-- policy. No append-only table is touched and no UPDATE or DELETE grant is
-- added. `app.require_approval()`, `app.guard_immutable_core()`,
-- `app.member_may_write()`, `app.block_mutations()` and
-- `app.guard_threshold_direction()` are not touched.
--
-- Idempotent: `create or replace function`, and the revoke/grant pair is
-- re-runnable. `scripts/db-test.sh` applies every migration twice and
-- `supabase/tests/22_an_operator_command_connects_as_the_app.sql` reads the end
-- state back.

create or replace function app.member_for_link(org_slug text, member_email text)
  returns table (org_id uuid, user_id uuid, role membership_role)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  found_org uuid;
  matches int;
begin
  -- A caller with a claim is a caller acting for somebody, which is every
  -- request path. Those read organizations and users through RLS; this is for
  -- the one caller that has no claims because it is here to learn them.
  if app.current_org_id() is not null or app.current_user_id() is not null then
    raise exception
      'member_for_link is the operator lookup and takes no claims: a caller '
      'acting for a tenant must read organizations and users through RLS instead'
      using errcode = 'insufficient_privilege';
  end if;

  if org_slug is null or btrim(org_slug) = '' or member_email is null or btrim(member_email) = '' then
    raise exception 'member_for_link needs a slug and an email'
      using errcode = 'invalid_parameter_value';
  end if;

  select o.id into found_org from organizations o where o.slug = org_slug;
  if found_org is null then
    return;  -- no row: no organization has that slug
  end if;

  -- `users.email` is unique case-sensitively only. Two members of this org
  -- whose addresses differ only in case would make the change's author a coin
  -- toss, so that is refused by name rather than resolved by the planner.
  select count(*) into matches
    from users u join memberships m on m.user_id = u.id
   where m.org_id = found_org and lower(u.email) = lower(member_email);
  if matches > 1 then
    raise exception 'more than one member of % answers to that address, differing only in case',
      org_slug using errcode = 'cardinality_violation';
  end if;

  return query
    select found_org, u.id, m.role
      from (select 1) one
      left join (users u join memberships m on m.user_id = u.id)
        on m.org_id = found_org and lower(u.email) = lower(member_email);
end
$$;

comment on function app.member_for_link(text, text) is
  'The operator commands'' lookup (ADR 0034): an org slug and a member email to '
  'ids and a role, and nothing else. No row when the slug names no org; a null '
  'user_id when the address is not a member there. Refused for any caller that '
  'carries a claim: those read organizations and users through RLS.';

revoke all on function app.member_for_link(text, text) from public;
grant execute on function app.member_for_link(text, text) to app_rw;
