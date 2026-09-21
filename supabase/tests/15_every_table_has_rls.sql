\echo '-- 15 every table has RLS: invariant 6, asked of the whole schema rather than of a list'
begin;
do $test$
declare
  without_rls text;
  without_policy text;
begin
  -- =========================================================================
  -- Invariant 6, by enumeration.
  -- =========================================================================
  -- Every other suite here asks about the tables it was written for. That is
  -- what makes them readable and it is also the hole: a table added next month
  -- is covered by no suite at all, and `alter table … enable row level security`
  -- is one line in a migration that is easy to leave out of a table nobody is
  -- writing a suite about yet. `document_arrivals` (migration 0019) is the
  -- occasion for this file, but the point is general — this asks the catalogue
  -- rather than a list, so a table that ships without RLS fails here on the day
  -- it is added and names itself while doing so.
  --
  -- `public` only: the `app` and `test` schemas hold functions, and `auth` and
  -- `storage` belong to Supabase. Ordinary tables and partitioned ones ('r' and
  -- 'p'); views carry no RLS of their own and are governed by
  -- `security_invoker` plus their tables' policies (ADR 0010).
  select string_agg(c.relname, ', ' order by c.relname) into without_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and not c.relrowsecurity;
  perform test.ok(without_rls is null, format(
    'every table in public has row-level security enabled (without it: %s)',
    coalesce(without_rls, 'none')));

  -- And enabled to some effect. RLS with no policy denies every row to every
  -- non-owner role, which is fail-closed and therefore not a security hole —
  -- but it is almost always a migration that got half-written, and it reads
  -- from the application as "the table is empty". Asserted separately from the
  -- line above so the two failures are told apart: one is a table nobody
  -- protected, the other is a table nobody can read.
  select string_agg(c.relname, ', ' order by c.relname) into without_policy
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  perform test.ok(without_policy is null, format(
    'and carries at least one policy, so RLS is a rule rather than a closed door (without one: %s)',
    coalesce(without_policy, 'none')));
end
$test$;
rollback;
