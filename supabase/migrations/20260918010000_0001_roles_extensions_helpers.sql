-- 0001 — Roles, extensions and tenancy helpers.
--
-- Portability note: these migrations run unchanged on a bare Postgres 16 (local
-- tests, CI) and on Supabase. We therefore never call auth.jwt() directly; the
-- app.* helpers read the same `request.jwt.claims` GUC that Supabase sets, and
-- can be set with set_config() in tests.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_ro') then
    create role app_ro nologin;
  end if;
end
$$;

create schema if not exists app;
grant usage on schema app to app_rw, app_ro;

-- Claims of the current request, or '{}' outside a request context.
create or replace function app.jwt() returns jsonb
  language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function app.current_org_id() returns uuid
  language sql stable as $$
  select nullif(app.jwt() ->> 'org_id', '')::uuid;
$$;

create or replace function app.current_user_id() returns uuid
  language sql stable as $$
  select nullif(app.jwt() ->> 'sub', '')::uuid;
$$;

-- Canonical JSON for the tamper-evident hash chains. jsonb's text output is
-- already normalised (sorted keys, no insignificant whitespace), which is the
-- property the chain depends on.
create or replace function app.canonical(payload jsonb) returns text
  language sql immutable as $$
  select payload::text;
$$;

create or replace function app.row_hash(prev bytea, payload jsonb) returns bytea
  language sql immutable as $$
  select digest(coalesce(prev, ''::bytea) || convert_to(app.canonical(payload), 'UTF8'), 'sha256');
$$;

grant execute on function app.jwt(), app.current_org_id(), app.current_user_id(),
  app.canonical(jsonb), app.row_hash(bytea, jsonb) to app_rw, app_ro;
