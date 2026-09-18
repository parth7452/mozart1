-- 0011 — The application roles can reach pgcrypto.
--
-- Found verifying 0010 on the live project, as app_rw rather than as the owner:
--
--   insert into deduction_events … →
--     function digest(bytea, unknown) does not exist
--
-- Every hash-chained write (deduction_events, audit_log) goes through
-- app.row_hash(), which calls digest(). 0008 pinned those functions to
-- `pg_catalog, public, extensions` so one setting would serve both Postgreses,
-- because pgcrypto lives in `public` locally and in `extensions` on Supabase.
-- A schema in the search_path is still invisible without USAGE on it, and the
-- app roles had none on `extensions` — so on Supabase the application role
-- could not append an event at all. Locally it worked, which is why the local
-- suite never saw it: `public` is a schema every role may use.
--
-- The functions are security invoker on purpose (ADR 0010), so the caller needs
-- the privilege; making them definer to dodge a grant would hand the app role
-- the owner's reach for the sake of a hash.
do $$
declare
  pgcrypto_schema text;
begin
  select n.nspname into pgcrypto_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if pgcrypto_schema is null then
    raise exception 'pgcrypto is not installed: the hash chains cannot work without it';
  end if;

  -- Read from the catalogue rather than naming a schema, so this migration is
  -- correct on both Postgreses and stays correct if pgcrypto ever moves.
  execute format('grant usage on schema %I to app_rw, app_ro', pgcrypto_schema);
  execute format(
    'grant execute on function %I.digest(bytea, text), %I.digest(text, text) to app_rw, app_ro',
    pgcrypto_schema, pgcrypto_schema);
end
$$;
