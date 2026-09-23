-- 0028 — Only the app roles hold grants, and invariant 7's guard is pinned
-- again (ADR 0037).
--
-- Two repairs, and nothing else:
--
--   §1  app.guard_threshold_direction() gets back the search_path pin that
--       migration 0022's `create or replace` silently dropped. The body,
--       trigger and comment are untouched.
--
--   §2  Supabase's request roles — anon, authenticated, service_role — lose
--       every privilege they hold on our objects, the default privileges that
--       would hand them the same on the next table, and `authenticated`'s
--       membership in app_rw (migration 0006). Nothing here reads through the
--       Data API (ADR 0015; the evidence is in ADR 0037), and the membership is
--       what let a token minted with the JWT secret become the application.
--
-- Every statement is a REVOKE, an `alter function … set`, or an
-- `alter default privileges … revoke`. Nothing is granted to anyone. No table,
-- column, policy, trigger or view changes, and no merged migration is edited —
-- 0006's and 0024's comments about `authenticated` are now wrong and stay as
-- written (ADR 0037, Consequences).
--
-- Portable: on a bare Postgres 16 without Supabase's roles §2 has nothing to
-- do and says so. `scripts/db-test.sh` creates those roles first
-- (supabase/tests/_supabase_shape.sql) precisely so that it does have work to
-- do in CI. Needs Postgres 16 or later (`pg_auth_members.set_option`,
-- `pg_has_role(…, 'SET')`); Supabase runs 17.
--
-- Idempotent: every statement is a no-op the second time. On db:test's second
-- pass, 0006 grants the membership again and 0022 unpins the guard again before
-- this runs, so the second pass is a second repair — which is the proof that
-- the repair holds whatever ran before it. Suite 24 reads the end state back.

-- ---------------------------------------------------------------------------
-- §1 Invariant 7's guard resolves names in its own search path, not its
--    caller's.
-- ---------------------------------------------------------------------------
-- By `alter function`, not a third `create or replace` of the body: one
-- property is wrong, and restating the whole of invariant 7 to fix it would be
-- one more copy to drift from.
alter function app.guard_threshold_direction()
  set search_path = pg_catalog, public, extensions;

-- ---------------------------------------------------------------------------
-- §2 The request roles hold nothing of ours.
-- ---------------------------------------------------------------------------
-- One statement, so the grants half is all or nothing: if the end-state check
-- at the bottom raises, every revoke above it is rolled back with it.
do $$
declare
  targets text[];
  target_list text;
  app_roles constant text[] := array['app_rw', 'app_ro'];
  app_role text;
  -- Logins that are the application: the one production names, and any login
  -- holding an app role directly with SET. Recorded before, checked after.
  watched_rw oid[];
  watched_ro oid[];
  m record;
  d record;
  skipped text[] := '{}';
  survived text;
  locked_out text;
begin
  select array_agg(rolname order by rolname) into targets
    from pg_roles
   where rolname in ('anon', 'authenticated', 'service_role');

  if targets is null then
    raise notice '0028: no Supabase request roles in this cluster; nothing to revoke';
    return;
  end if;

  select string_agg(quote_ident(t), ', ') into target_list from unnest(targets) t;

  -- -------------------------------------------------------------------------
  -- The lock-out tripwire, aimed at the application's logins and nothing else.
  -- -------------------------------------------------------------------------
  -- Not "every login that can set role app_rw": `authenticator` can, through
  -- authenticated, and losing that is the point of this migration. A tripwire
  -- that watched it would fire on every apply, and telling an operator to grant
  -- app_rw back to whichever role tripped would reopen the hole. What must not
  -- happen is the application losing its own door — `recouple_app` in
  -- production (docs/supabase.md), or any login that holds an app role
  -- directly — and a direct membership is not something this migration touches,
  -- so the case this exists for is `recouple_app` having reached app_rw only
  -- through authenticated. ADR 0037 records that production's is direct.
  select array_agg(r.oid) into watched_rw
    from pg_roles r
   where r.rolcanlogin
     and not r.rolsuper
     and pg_has_role(r.oid, 'app_rw', 'SET')
     and (r.rolname = 'recouple_app'
          or exists (select 1 from pg_auth_members am
                      where am.member = r.oid and am.roleid = 'app_rw'::regrole
                        and am.set_option));
  select array_agg(r.oid) into watched_ro
    from pg_roles r
   where r.rolcanlogin
     and not r.rolsuper
     and pg_has_role(r.oid, 'app_ro', 'SET')
     and (r.rolname = 'recouple_app'
          or exists (select 1 from pg_auth_members am
                      where am.member = r.oid and am.roleid = 'app_ro'::regrole
                        and am.set_option));

  -- -------------------------------------------------------------------------
  -- Object privileges, in the two schemas our migrations own.
  -- -------------------------------------------------------------------------
  -- `all tables` covers views, materialised and foreign tables; `all routines`
  -- covers functions and procedures. USAGE on public is left alone: with no
  -- privilege on anything in it, it grants nothing (ADR 0037 §2).
  execute format('revoke all on all tables in schema public from %s', target_list);
  execute format('revoke all on all sequences in schema public from %s', target_list);
  execute format('revoke all on all routines in schema public from %s', target_list);
  execute format('revoke create on schema public from %s', target_list);
  execute format('revoke all on all tables in schema app from %s', target_list);
  execute format('revoke all on all sequences in schema app from %s', target_list);
  execute format('revoke all on all routines in schema app from %s', target_list);
  execute format('revoke all on schema app from %s', target_list);

  -- -------------------------------------------------------------------------
  -- Memberships: 0006's `grant app_rw to authenticated`, and any like it.
  -- -------------------------------------------------------------------------
  -- Revoked as the grantor the catalogue recorded. A plain REVOKE by a role
  -- that did not make the grant is a WARNING and changes nothing; naming the
  -- grantor finds it. Where the migrating role may not act for that grantor,
  -- the plain form is tried and the end-state check below decides.
  for m in
    select r.rolname as app_role, mem.rolname as member, g.rolname as grantor
      from pg_auth_members am
      join pg_roles r on r.oid = am.roleid
      join pg_roles mem on mem.oid = am.member
      join pg_roles g on g.oid = am.grantor
     where r.rolname = any (app_roles)
       and mem.rolname = any (targets)
  loop
    begin
      execute format('revoke %I from %I granted by %I', m.app_role, m.member, m.grantor);
    exception when insufficient_privilege or invalid_grant_operation then
      execute format('revoke %I from %I', m.app_role, m.member);
    end;
    raise notice '0028: % is no longer a member of %', m.member, m.app_role;
  end loop;

  -- -------------------------------------------------------------------------
  -- Default privileges: the next table must not be born with the grants.
  -- -------------------------------------------------------------------------
  -- Every row for public, app or every schema (a global row grants in public
  -- whatever a per-schema revoke removes), for tables, sequences or functions,
  -- that names a request role. Revoked for the role that owns the row. A role
  -- the migrating role may not act as — on Supabase, `supabase_admin` when this
  -- runs as `postgres` — is skipped with a notice rather than failing the
  -- migration: nothing in this schema is created as that role.
  for d in
    select distinct pg_get_userbyid(dacl.defaclrole) as owner_role,
                    dacl.defaclnamespace as namespace_oid,
                    dacl.defaclobjtype as objtype
      from pg_default_acl dacl
      cross join lateral aclexplode(dacl.defaclacl) a
     where dacl.defaclobjtype in ('r', 'S', 'f')
       and dacl.defaclnamespace in (0::oid, 'public'::regnamespace::oid, 'app'::regnamespace::oid)
       and pg_get_userbyid(a.grantee) = any (targets)
  loop
    begin
      execute format('alter default privileges for role %I %s revoke all on %s from %s',
        d.owner_role,
        case when d.namespace_oid = 0 then ''
             else format('in schema %I', d.namespace_oid::regnamespace::text) end,
        case d.objtype when 'r' then 'tables' when 'S' then 'sequences' else 'functions' end,
        target_list);
      raise notice '0028: default privileges of % in % on % no longer grant %',
        d.owner_role,
        case when d.namespace_oid = 0 then 'every schema'
             else d.namespace_oid::regnamespace::text end,
        case d.objtype when 'r' then 'tables' when 'S' then 'sequences' else 'functions' end,
        target_list;
    exception when insufficient_privilege then
      skipped := skipped || d.owner_role;
      raise notice '0028: cannot change the default privileges of % as %; skipped. Nothing '
                   'in this schema is created as %, and suite 24 plus the post-apply grants '
                   'query (docs/supabase.md) are what would show otherwise',
        d.owner_role, current_user, d.owner_role;
    end;
  end loop;

  -- -------------------------------------------------------------------------
  -- The end state, re-read. Abort, do not warn.
  -- -------------------------------------------------------------------------
  select string_agg(item, '; ' order by item) into survived
    from (
      select distinct format('%s on %s', pg_get_userbyid(a.grantee), c.oid::regclass) as item
        from pg_class c
        cross join lateral aclexplode(c.relacl) a
       where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace)
         and pg_get_userbyid(a.grantee) = any (targets)
      union
      select distinct format('%s on %s.%s', pg_get_userbyid(a.grantee), c.oid::regclass,
                             quote_ident(att.attname))
        from pg_attribute att
        join pg_class c on c.oid = att.attrelid
        cross join lateral aclexplode(att.attacl) a
       where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace)
         and pg_get_userbyid(a.grantee) = any (targets)
      union
      select distinct format('%s on %s', pg_get_userbyid(a.grantee), p.oid::regprocedure)
        from pg_proc p
        cross join lateral aclexplode(p.proacl) a
       where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
         and pg_get_userbyid(a.grantee) = any (targets)
      union
      select distinct format('%s %s on schema %s', pg_get_userbyid(a.grantee),
                             a.privilege_type, ns.nspname)
        from pg_namespace ns
        cross join lateral aclexplode(ns.nspacl) a
       where pg_get_userbyid(a.grantee) = any (targets)
         and (ns.nspname = 'app' or (ns.nspname = 'public' and a.privilege_type = 'CREATE'))
      union
      select format('%s is still a member of %s', t, ar)
        from unnest(targets) t cross join unnest(app_roles) ar
       where pg_has_role(t, ar, 'MEMBER')
      union
      select distinct format('default privileges of %s grant %s', pg_get_userbyid(dacl.defaclrole),
                             pg_get_userbyid(a.grantee))
        from pg_default_acl dacl
        cross join lateral aclexplode(dacl.defaclacl) a
       where dacl.defaclobjtype in ('r', 'S', 'f')
         and dacl.defaclnamespace in (0::oid, 'public'::regnamespace::oid, 'app'::regnamespace::oid)
         and pg_get_userbyid(a.grantee) = any (targets)
         and not (pg_get_userbyid(dacl.defaclrole) = any (skipped))
    ) leftovers;

  if survived is not null then
    raise exception '0028 revoked, and these survived: %', survived
      using errcode = 'insufficient_privilege',
            hint = 'A REVOKE by a role that did not make the grant only warns. Apply this '
                   'migration as the role that owns the objects (postgres on Supabase), or '
                   'revoke the survivors as their grantor, then apply it again (ADR 0037).';
  end if;

  foreach app_role in array app_roles loop
    select string_agg(pg_get_userbyid(w), ', ') into locked_out
      from unnest(case app_role when 'app_rw' then watched_rw else watched_ro end) w
     where not pg_has_role(w, app_role, 'SET');
    if locked_out is not null then
      raise exception '0028 would lock the application out: % could set role % before this '
                      'migration and cannot now, so it reached % through a Supabase request role',
                      locked_out, app_role, app_role
        using errcode = 'object_not_in_prerequisite_state',
              hint = format('The application login holds the app roles directly: grant %s to '
                            'recouple_app with inherit false, set true (docs/supabase.md), then '
                            'apply 0028 again. Never grant an app role to authenticator or to a '
                            'request role — that is the door this migration closes (ADR 0037).',
                            app_role);
    end if;
  end loop;
end
$$;
