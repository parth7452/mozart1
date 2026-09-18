-- 0012 — Signing in resolves a tenant, without widening RLS.
--
-- The web app authenticates with Supabase Auth and reaches the database as
-- `app_rw` with the tenant's claims set transaction-locally (ADR 0006), exactly
-- the way the pipeline already does. Two things have to happen between "a
-- verified session" and "claims we can set", and neither can be a plain query:
--
--   * Which of our users is this? Supabase Auth mints its own user ids in a
--     schema that does not exist on local Postgres, so `users.id` is ours and
--     `users.auth_user_id` records the link. Resolving it is a lookup on a table
--     whose only policy is a tenant-scoped read — and we do not know the tenant
--     yet.
--   * Which tenant? `memberships` is readable only where
--     `org_id = app.current_org_id()`, which is the value we are trying to find.
--
-- Both are chicken-and-egg, and the answer is not to loosen the policies. Two
-- security definer functions answer exactly these two questions and nothing
-- else, and both take the identity from the claims rather than an argument, so a
-- caller cannot ask about somebody else.
--
-- Why not a Supabase custom access token hook putting org_id in the JWT: it
-- would work, and it would only work on Supabase. Everything here runs on a bare
-- Postgres 16 too, which is what makes the invariant suite meaningful.

alter table users add column if not exists auth_user_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_auth_user_id_key'
  ) then
    alter table users add constraint users_auth_user_id_key unique (auth_user_id);
  end if;
end
$$;

comment on column users.auth_user_id is
  'The identity provider''s subject for this person (auth.users.id on Supabase). '
  'Null until they first sign in. Our own id is what RLS and memberships use.';

-- ---------------------------------------------------------------------------
-- Who is this? — link on first sign-in, by the email they were invited at.
-- ---------------------------------------------------------------------------
-- Definer because it reads and writes `users`, which has no tenant column and
-- so no write policy. It is deliberately not a general upsert: a person must
-- already have been invited (a users row and a membership), because creating a
-- tenant is not something a request may do.
create or replace function app.link_auth_user(auth_id uuid, claimed_email text)
  returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  found_id uuid;
  linked_to uuid;
begin
  if auth_id is null or claimed_email is null or claimed_email = '' then
    raise exception 'link_auth_user needs a verified subject and email'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Already linked: the common path, and the only one that touches nothing.
  select id into found_id from users where auth_user_id = auth_id;
  if found_id is not null then
    return found_id;
  end if;

  select id, auth_user_id into found_id, linked_to
    from users where lower(email) = lower(claimed_email);

  if found_id is null then
    -- No invitation. Refusing is the point: an authenticated stranger is still a
    -- stranger, and self-service tenant creation would be a way around invariant 6.
    raise exception 'no invitation for %', claimed_email
      using errcode = 'insufficient_privilege';
  end if;

  if linked_to is not null and linked_to <> auth_id then
    -- Someone already signed in as this person. Re-pointing the row at a new
    -- subject would be an account takeover by anyone who can assert the address.
    raise exception 'account for % is already linked to another identity', claimed_email
      using errcode = 'insufficient_privilege';
  end if;

  update users set auth_user_id = auth_id where id = found_id;
  return found_id;
end
$$;

revoke all on function app.link_auth_user(uuid, text) from public;
grant execute on function app.link_auth_user(uuid, text) to app_rw;

-- ---------------------------------------------------------------------------
-- Which tenant? — the orgs of whoever the claims say is asking.
-- ---------------------------------------------------------------------------
-- No argument: the subject comes from `request.jwt.claims`, which the server
-- sets from a session it verified. A function that took a user id would let one
-- signed-in member enumerate another's tenants.
create or replace function app.my_orgs()
  returns table (org_id uuid, slug text, name text, role membership_role)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, extensions
as $$
  select o.id, o.slug, o.name, m.role
    from memberships m
    join organizations o on o.id = m.org_id
   where m.user_id = app.current_user_id()
   order by o.name;
$$;

revoke all on function app.my_orgs() from public;
grant execute on function app.my_orgs() to app_rw, app_ro;
