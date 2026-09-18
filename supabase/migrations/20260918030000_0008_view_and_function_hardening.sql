-- 0008 — Close an RLS bypass through a view, and pin function search paths.
--
-- Found by the Supabase database linter against the live project, not by the
-- local suite (ADR 0010). Both are portable: they apply identically on local
-- Postgres 16 and on Supabase's Postgres 17.

-- A view reads with its owner's permissions unless it is security_invoker, so
-- `document_state` was reading three RLS-protected tables as its owner and the
-- tenant_isolation policies did not apply to the caller.
alter view document_state set (security_invoker = true);

-- An unpinned search_path lets the caller decide how unqualified names inside a
-- function resolve. For the functions that enforce append-only storage and the
-- approval gate, that is not a detail.
--
-- `extensions` is where Supabase keeps pgcrypto; locally it lives in `public`
-- and a missing schema in the path is ignored, so one setting serves both.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
  loop
    execute format(
      'alter function %s set search_path = pg_catalog, public, extensions',
      fn.signature);
  end loop;
end
$$;
