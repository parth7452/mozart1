\echo '-- 24 only the app roles hold grants, and every app function pins its search_path'
begin;
do $test$
declare
  ids jsonb; org uuid; analyst uuid;
  targets text[];
  t text;
  offenders text;
  n int;
  saved_path text;
begin
  -- =========================================================================
  -- A. Every function in `app` pins its search_path — by enumeration.
  -- =========================================================================
  -- `create or replace function` assigns every property from the command, so a
  -- replacement that does not restate `set search_path` silently drops the pin
  -- migration 0008 put on it. That is what 0022 did to
  -- guard_threshold_direction, leaving invariant 7's guard resolving names
  -- through whatever path its caller set until 0028 re-pinned it. Suite 12 has
  -- asked the same question of guard_immutable_core since 0017 replaced it —
  -- of that one function. A suite that asks about one function at a time asks
  -- about the one somebody remembered. This asks the catalogue, so the next
  -- one fails here on the day it lands, and names itself.
  select count(*) into n from pg_proc where pronamespace = 'app'::regnamespace;
  perform test.ok(n >= 20, format('schema app has its functions to ask about (found %s)', n));

  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into offenders
    from pg_proc p
   where p.pronamespace = 'app'::regnamespace
     and not coalesce(p.proconfig @> array['search_path=pg_catalog, public, extensions'], false);
  perform test.ok(offenders is null, format(
    'every function in schema app pins search_path = pg_catalog, public, extensions (unpinned: %s)',
    coalesce(offenders, 'none')));

  -- The pin, not merely its presence: a caller who puts a schema of their own
  -- ahead of pg_catalog must not change what invariant 7's guard computes.
  -- Unpinned, `shadow.array_length` below answers null for the list of
  -- loosened columns, the guard concludes nothing was loosened, and a raised
  -- auto-dispute ceiling goes through with no ADR named. One name is a sample,
  -- not a proof of every name the body resolves; the enumeration above is the
  -- general half.
  ids := test.seed_org('onlyappgrants');
  org := (ids->>'org')::uuid;
  analyst := (ids->>'analyst')::uuid;

  create schema suite24_shadow;
  create function suite24_shadow.array_length(text[], integer) returns integer
    language sql immutable as 'select null::integer';
  grant usage on schema suite24_shadow to app_rw;

  set role app_rw;
  perform test.as_member(org, analyst);
  saved_path := current_setting('search_path');
  perform set_config('search_path', 'suite24_shadow, pg_catalog, public', true);
  perform test.expect_error(format(
    'update org_settings set auto_dispute_ceiling_cents = 500000 where org_id = %L', org),
    'threshold loosening blocked',
    'invariant 7''s guard still refuses a loosening when the caller shadows array_length');
  perform set_config('search_path', saved_path, true);
  reset role;

  -- Views read through the caller's policies or they do not read through them
  -- at all (ADR 0010). A `create or replace view` that leaves out
  -- `with (security_invoker = true)` resets the option exactly as a function
  -- replacement resets its search_path, so this is the same question asked of
  -- the other kind of object. A materialised view has no invoker mode — it is
  -- filled as its owner — so one appearing here is an ADR's decision, not a
  -- migration's.
  select string_agg(c.relname, ', ' order by c.relname) into offenders
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('v', 'm')
     and not coalesce(c.reloptions @> array['security_invoker=true'], false);
  perform test.ok(offenders is null, format(
    'every view in public is security_invoker (not: %s)', coalesce(offenders, 'none')));

  -- Nothing of ours lives in `public` as a function: every one there belongs to
  -- an extension (pgcrypto, locally; on Supabase it is in `extensions`).
  -- `public` is the schema a Data API exposes, and EXECUTE is PUBLIC's by
  -- default, so a function of ours there would be callable by anyone who can
  -- reach that API whatever this suite says about grants.
  select string_agg(p.oid::regprocedure::text, ', ') into offenders
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not exists (
       select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
  perform test.ok(offenders is null, format(
    'every function in public belongs to an extension (ours: %s)', coalesce(offenders, 'none')));

  -- Shadowing needs somewhere to create the shadow. The app roles may create
  -- nothing: no schema in the database, and no object in any schema. (TEMP is
  -- PUBLIC's by default and is not a way in: pg_temp is never searched for
  -- functions or operators.)
  select string_agg(format('%s on schema %s', r, ns.nspname), ', ') into offenders
    from unnest(array['app_rw', 'app_ro']) r
    cross join pg_namespace ns
   where has_schema_privilege(r, ns.oid, 'CREATE');
  perform test.ok(offenders is null, format(
    'the app roles hold CREATE on no schema (they do: %s)', coalesce(offenders, 'none')));
  perform test.ok(
    not has_database_privilege('app_rw', current_database(), 'CREATE')
      and not has_database_privilege('app_ro', current_database(), 'CREATE'),
    'and cannot create a schema of their own');

  -- =========================================================================
  -- B. Supabase's request roles hold nothing of ours.
  -- =========================================================================
  select array_agg(rolname order by rolname) into targets
    from pg_roles where rolname in ('anon', 'authenticated', 'service_role');
  perform test.ok(cardinality(coalesce(targets, '{}')) = 3,
    'anon, authenticated and service_role exist — scripts/db-test.sh creates them in '
    'supabase/tests/_supabase_shape.sql, because a suite about their grants that runs '
    'where they do not exist asserts nothing');

  -- Effective privileges, asked the way Postgres answers them: table-level and
  -- column-level, on every table, view, materialised and foreign table, in the
  -- two schemas our migrations own. Pass 1 of db:test starts with the shape
  -- fixture's ALL on every table and pass 2 re-runs 0006's grant, so this is
  -- asserting a repair, twice — not an absence that was never there.
  select string_agg(format('%s %s on %s.%s', r, priv, ns.nspname, c.relname), ', ') into offenders
    from unnest(targets) r
    cross join pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                            'TRUNCATE', 'REFERENCES', 'TRIGGER']) priv
   where ns.nspname in ('public', 'app')
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and (has_table_privilege(r, c.oid, priv)
          or (priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r, c.oid, priv)));
  perform test.ok(offenders is null, format(
    'the request roles hold no privilege on any table or view (they hold: %s)',
    coalesce(offenders, 'none')));

  select string_agg(format('%s %s on %s.%s', r, priv, ns.nspname, c.relname), ', ') into offenders
    from unnest(targets) r
    cross join pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) priv
   where ns.nspname in ('public', 'app')
     and c.relkind = 'S'
     and has_sequence_privilege(r, c.oid, priv);
  perform test.ok(offenders is null, format(
    'nor on any sequence (they hold: %s)', coalesce(offenders, 'none')));

  -- Functions are asked by ACL entry rather than by has_function_privilege:
  -- EXECUTE is PUBLIC's by default, so every role can execute an ordinary
  -- function and that answer says nothing about a grant. What is asserted is
  -- that none of ours names them — and the definer functions in `app` are
  -- fenced by USAGE on the schema, asserted below.
  select string_agg(distinct format('%s on %s', pg_get_userbyid(a.grantee), p.oid::regprocedure), ', ')
    into offenders
    from pg_proc p
    cross join lateral aclexplode(p.proacl) a
   where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
     and pg_get_userbyid(a.grantee) = any (targets);
  perform test.ok(offenders is null, format(
    'no function in public or app names them in its ACL (named: %s)', coalesce(offenders, 'none')));

  -- And no ACL entry anywhere else they could hide in: a relation's own, a
  -- column's, or a schema's.
  select string_agg(distinct format('%s on %s.%s', pg_get_userbyid(a.grantee), ns.nspname, c.relname), ', ')
    into offenders
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
   where ns.nspname in ('public', 'app')
     and pg_get_userbyid(a.grantee) = any (targets);
  perform test.ok(offenders is null, format(
    'no relation in public or app names them in its ACL (named: %s)', coalesce(offenders, 'none')));

  select string_agg(distinct format('%s on %s.%s', pg_get_userbyid(a.grantee), c.relname, att.attname), ', ')
    into offenders
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    cross join lateral aclexplode(att.attacl) a
   where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace)
     and pg_get_userbyid(a.grantee) = any (targets);
  perform test.ok(offenders is null, format(
    'nor any column (named: %s)', coalesce(offenders, 'none')));

  select string_agg(format('%s %s on schema %s', pg_get_userbyid(a.grantee), a.privilege_type,
                           ns.nspname), ', ')
    into offenders
    from pg_namespace ns
    cross join lateral aclexplode(ns.nspacl) a
   where pg_get_userbyid(a.grantee) = any (targets)
     and (ns.nspname = 'app' or (ns.nspname = 'public' and a.privilege_type = 'CREATE'));
  perform test.ok(offenders is null, format(
    'and no schema grant: nothing on app, and no CREATE on public (granted: %s)',
    coalesce(offenders, 'none')));

  -- =========================================================================
  -- Membership: the one grant 0006 made on purpose, and the reason it goes.
  -- =========================================================================
  -- `grant app_rw to authenticated` (0006) made every signed-in stranger — and
  -- sign-ups are open — a member of the application role. MEMBER here is any
  -- path, whatever its inherit and set options.
  foreach t in array targets loop
    perform test.ok(
      not pg_has_role(t, 'app_rw', 'MEMBER') and not pg_has_role(t, 'app_ro', 'MEMBER'),
      format('%s is a member of neither app role', t));
    perform test.ok(not has_schema_privilege(t, 'app', 'USAGE'),
      format('so %s cannot reach schema app, or any definer function in it', t));
  end loop;

  -- The property PostgREST's role switch turns on. `authenticator` logs in and
  -- then does `set role` to whatever the JWT's `role` claim says; while
  -- authenticated was a member of app_rw with SET, a token minted with
  -- `role: app_rw` and any `org_id` — which is what holding the JWT secret
  -- lets anyone do — read every tenant as the application.
  perform test.ok(
    not pg_has_role('authenticator', 'app_rw', 'SET')
      and not pg_has_role('authenticator', 'app_ro', 'SET'),
    'authenticator cannot set role to either app role');

  -- And the difference between the door that closed and the one that must not.
  -- Two throwaway logins, created and dropped with this transaction: one shaped
  -- exactly like production's recouple_app (docs/supabase.md), one that reaches
  -- the app roles only by way of authenticated. The first is the application;
  -- the second is what authenticator was.
  create role suite24_app_login login noinherit;
  grant app_rw to suite24_app_login with inherit false, set true;
  grant app_ro to suite24_app_login with inherit false, set true;
  create role suite24_via_authenticated login noinherit;
  grant authenticated to suite24_via_authenticated;

  perform test.ok(
    pg_has_role('suite24_app_login', 'app_rw', 'SET')
      and pg_has_role('suite24_app_login', 'app_ro', 'SET'),
    'a login with the direct grant docs/supabase.md prescribes can still become the app');
  perform test.ok(
    not pg_has_role('suite24_app_login', 'app_rw', 'USAGE'),
    'without inheriting anything until it does');
  perform test.ok(
    pg_has_role('suite24_via_authenticated', 'authenticated', 'SET')
      and not pg_has_role('suite24_via_authenticated', 'app_rw', 'SET')
      and not pg_has_role('suite24_via_authenticated', 'app_ro', 'SET'),
    'a login that reaches the app roles only through authenticated cannot');

  -- =========================================================================
  -- Default privileges: the next table must not be born with the grants.
  -- =========================================================================
  -- 0006's revoke was a snapshot of the tables that existed then, and every
  -- table since was created with the grants again — which is how
  -- accounting_credentials came to be readable by name to `anon`. Asked of
  -- every default-privilege row, per-schema and global, because a global row
  -- would re-grant in public whatever a per-schema revoke removed.
  select string_agg(distinct format('%s for %s in %s (%s)', pg_get_userbyid(a.grantee),
                           d.defaclrole::regrole,
                           coalesce(nullif(d.defaclnamespace, 0)::regnamespace::text, 'every schema'),
                           d.defaclobjtype), ', ')
    into offenders
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) a
   where pg_get_userbyid(a.grantee) = any (targets);
  perform test.ok(offenders is null, format(
    'no default privilege grants them anything (still granted: %s)', coalesce(offenders, 'none')));

  -- And behaviourally: objects created now, by the role that runs the
  -- migrations, give them nothing.
  create table public.suite24_probe (id int);
  create sequence public.suite24_probe_seq;
  create function public.suite24_probe_fn() returns int language sql as 'select 1';
  foreach t in array targets loop
    perform test.ok(
      not has_table_privilege(t, 'public.suite24_probe', 'SELECT')
        and not has_table_privilege(t, 'public.suite24_probe', 'INSERT')
        and not has_sequence_privilege(t, 'public.suite24_probe_seq', 'USAGE'),
      format('a table and a sequence created now give %s nothing', t));
  end loop;
  perform test.ok(
    not exists (
      select 1
        from pg_proc p cross join lateral aclexplode(p.proacl) a
       where p.oid = 'public.suite24_probe_fn()'::regprocedure
         and pg_get_userbyid(a.grantee) = any (targets)),
    'nor does a function');

  -- =========================================================================
  -- Invariant 2's grant half, for every role — derived from the triggers.
  -- =========================================================================
  -- Suites 01, 11, 14, 21 and 23 ask whether app_rw holds UPDATE or DELETE on
  -- the tables they were written for. Nothing asked whether anybody else did,
  -- and Supabase's defaults gave the request roles ALL on every one of them.
  --
  -- What is forbidden is read off each table's own app.block_mutations()
  -- triggers rather than assumed: `no_update_delete` forbids UPDATE and DELETE,
  -- `no_truncate` forbids TRUNCATE, and submissions, writebacks and writeoffs
  -- carry only `no_delete` and `no_truncate` (migration 0010) — their lifecycle
  -- columns are updated by app_rw on purpose, guarded column by column by
  -- app.guard_immutable_core(). tgtype's event bits are Postgres's own:
  -- DELETE = 8, UPDATE = 16, TRUNCATE = 32.
  --
  -- Every role but a superuser, the owner (or a role holding the owner's
  -- privileges), and the predefined pg_* roles. Members of pg_write_all_data
  -- hold UPDATE and DELETE everywhere by definition rather than by a grant on
  -- these tables, so they are left out of those two. The triggers refuse every
  -- one of them regardless; this is about the grants.
  select count(distinct t.tgrelid) into n
    from pg_trigger t where t.tgfoid = 'app.block_mutations'::regproc;
  perform test.ok(n >= 20, format('the append-only tables are there to ask about (%s)', n));

  with blocked as (
    select t.tgrelid as rel,
           bool_or(t.tgtype & 16 <> 0) as update_blocked,
           bool_or(t.tgtype & 8 <> 0)  as delete_blocked,
           bool_or(t.tgtype & 32 <> 0) as truncate_blocked
      from pg_trigger t
     where t.tgfoid = 'app.block_mutations'::regproc
     group by t.tgrelid
  )
  select string_agg(format('%s %s on %s', r.rolname, v.priv, c.relname), ', '
                    order by c.relname, r.rolname, v.priv)
    into offenders
    from blocked b
    join pg_class c on c.oid = b.rel
    cross join lateral (values ('UPDATE', b.update_blocked),
                               ('DELETE', b.delete_blocked),
                               ('TRUNCATE', b.truncate_blocked)) v(priv, forbidden)
    cross join pg_roles r
   where v.forbidden
     and not r.rolsuper
     and r.rolname !~ '^pg_'
     and not pg_has_role(r.oid, c.relowner, 'USAGE')
     and not (v.priv in ('UPDATE', 'DELETE') and pg_has_role(r.oid, 'pg_write_all_data', 'USAGE'))
     and case v.priv
           when 'UPDATE' then has_any_column_privilege(r.oid, c.oid, 'UPDATE')
           else has_table_privilege(r.oid, c.oid, v.priv)
         end;
  perform test.ok(offenders is null, format(
    'no role holds a privilege an append-only trigger refuses (held: %s)',
    coalesce(offenders, 'none')));

  -- The derivation is doing work, not decoration: submissions refuses DELETE
  -- and TRUNCATE and nothing else, and app_rw keeps its UPDATE (suite 12).
  perform test.ok(has_table_privilege('app_rw', 'submissions', 'UPDATE'),
    'while app_rw keeps UPDATE on submissions, whose trigger refuses only DELETE and TRUNCATE');
end
$test$;
rollback;
