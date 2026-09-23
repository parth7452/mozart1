-- Supabase's role shape, on a bare Postgres 16 (ADR 0037).
--
-- Not a migration and not a suite: `scripts/db-test.sh` runs this once, before
-- the migrations, and the leading underscore keeps it out of the suites' glob.
--
-- Why it exists. Production is Supabase, and Supabase creates three request
-- roles of its own and grants them everything in `public` by default. CI is
-- `postgres:16`, where none of them exist — so migration 0006's
-- `grant app_rw to authenticated` has never run in CI, the grants Supabase's
-- default privileges hand out on every new table have never existed in CI, and
-- a migration that revokes them (0028) would pass there by having nothing to
-- revoke. A suite that cannot fail proves nothing. This puts the pathology in
-- front of the migrations so 0028 has to repair it on every run, twice.
--
-- The shape is Supabase's catalogue, not a guess at it:
--
--   * `anon`, `authenticated`       nologin noinherit
--   * `service_role`                nologin noinherit bypassrls
--   * `authenticator`               login noinherit, granted all three — the
--                                   role PostgREST logs in as and then
--                                   `set role`s to whatever a JWT's `role`
--                                   claim names
--   * default privileges that grant the three ALL on every new table,
--     sequence and function in `public`
--
-- `noinherit` matters and is easy to get wrong. On Postgres 16 a GRANT's
-- inherit option defaults to the member's `rolinherit`, so a grant to a
-- NOINHERIT role confers SET without INHERIT. Creating these as plain `nologin`
-- roles would show CI an inheritance path the real ones do not have.
--
-- Created only if absent, so on a `supabase start` stack — where the real ones
-- already exist — this changes nothing but the default privileges of the
-- connecting role, which Supabase already sets the same way. Roles are
-- cluster-wide, like `app_rw` and `app_ro` from migration 0001: point
-- `DATABASE_URL` at a throwaway cluster, as CLAUDE.md already requires.
--
-- `authenticator` is a LOGIN role with no password. It can authenticate only
-- where pg_hba trusts the connection, which on a throwaway cluster is already
-- true of the superuser.

do $$
declare
  is_superuser boolean := (select rolsuper from pg_roles where rolname = current_user);
  request_role text;
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- BYPASSRLS needs a superuser to grant. CI and the local cluster connect as
    -- one; a developer who does not gets the role without it, which changes
    -- nothing these suites ask — every question here is about grants, and a
    -- grant is checked before a policy is.
    if is_superuser then
      create role service_role nologin noinherit bypassrls;
    else
      raise notice 'creating service_role without BYPASSRLS: % is not a superuser', current_user;
      create role service_role nologin noinherit;
    end if;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;

  foreach request_role in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (
      select 1 from pg_auth_members am
       where am.roleid = request_role::regrole and am.member = 'authenticator'::regrole
    ) then
      execute format('grant %I to authenticator', request_role);
    end if;
  end loop;
end
$$;

-- What Supabase's default privileges do to every object created in `public`:
-- the three request roles get everything. Migration 0006 revoked this from
-- `anon` once, for the tables that existed then; every table since has been
-- born with it again, which is the finding ADR 0037 records.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
