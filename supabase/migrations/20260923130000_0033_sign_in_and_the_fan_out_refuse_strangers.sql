-- 0033 — Sign-in and the fan-out refuse callers they were not written for
-- (ADR 0045).
--
-- Two security definer functions read past RLS, and each was written for exactly
-- one caller that carries no claims at all:
--
--   * app.ledger_connections_to_sync() (0024) is the cron fan-out's list of every
--     enabled connection across every org. listConnectionsToSync sets
--     `set local role app_rw` and no claims. The function refused a caller with
--     an org_id, but not one with only a `sub` — which is precisely the shape of
--     a Supabase Data API request.
--   * app.link_auth_user(auth_id, claimed_email) (0012) links a verified
--     identity to an invited user on first sign-in. resolveSession calls it
--     before it knows who this is, so before it sets any claim. It takes the
--     identity as arguments, it writes users.auth_user_id, and nothing stopped
--     another caller from pairing an unlinked invitation with an identity of
--     its own choosing. It also linked one of two rows at random when two
--     addresses differed only in case (users.email is unique case-sensitively).
--
-- Neither is reachable today: migration 0028 revoked every grant the request
-- roles held, and the Data API is off (ADR 0037). This is defence in depth, and
-- it is the guard app.member_for_link() (0026) already has: a caller carrying an
-- org_id or a sub is acting for somebody, and is refused.
--
-- Each function is restated IN FULL with `create or replace`: the same
-- signature and result type, `language plpgsql`, the same volatility,
-- `security definer`, and `set search_path = pg_catalog, public, extensions`
-- restated, because `create or replace` takes every property from the command
-- that runs it and 0022 is how a pin was lost last time (suite 24 enumerates).
-- Every message and error code the callers and suites match is kept:
-- `untenanted`, `no invitation for`, `already linked to another identity`.
--
-- What is deliberately NOT here: any table, column, trigger, policy or grant on
-- a table. No append-only table is touched and no UPDATE or DELETE grant is
-- added. app.my_orgs(), app.member_for_link(), app.require_approval() and every
-- other function are untouched. EXECUTE is exactly what it was: revoked from
-- PUBLIC, granted to app_rw.
--
-- Idempotent: `create or replace`, `comment on`, and the revoke/grant pairs are
-- re-runnable. scripts/db-test.sh applies every migration twice — on the second
-- pass 0012 and 0024 put the old bodies back and this puts these back again —
-- and supabase/tests/29_sign_in_and_the_fan_out_refuse_strangers.sql reads the
-- end state.

-- ---------------------------------------------------------------------------
-- The fan-out's list: refused to any caller that carries a claim.
-- ---------------------------------------------------------------------------
create or replace function app.ledger_connections_to_sync()
  returns table (connection_id uuid, org_id uuid, provider text, created_by uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public, extensions
as $$
begin
  -- The fan-out has no claims because it has not adopted a tenant yet: this is
  -- the query that decides which tenants it adopts. Every other caller carries
  -- one — a request path sets both, a Data API request always carries `sub` —
  -- and reads accounting_connections through RLS instead.
  if app.current_org_id() is not null or app.current_user_id() is not null then
    raise exception
      'ledger_connections_to_sync is the untenanted fan-out query and takes no '
      'claims: a caller acting for a tenant or a subject must read '
      'accounting_connections through RLS instead'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select c.id, c.org_id, c.provider, c.created_by
      from accounting_connections c
     where c.enabled
     order by c.org_id, c.id;
end
$$;

comment on function app.ledger_connections_to_sync() is
  'Every enabled accounting connection, as ids, across every org — for the '
  'cron fan-out, which has no tenant because it decides which tenants to adopt '
  '(ADR 0031 §5). Ids and a closed-set provider name only, and refused outright '
  'for any caller that carries a claim, an org_id or a sub (ADR 0045): those '
  'read the table through RLS.';

revoke all on function app.ledger_connections_to_sync() from public;
grant execute on function app.ledger_connections_to_sync() to app_rw;

-- ---------------------------------------------------------------------------
-- First sign-in: refused to any caller that carries a claim, and to an address
-- two users answer to.
-- ---------------------------------------------------------------------------
-- Definer because it reads and writes `users`, which has no tenant column and
-- so no write policy. Deliberately not a general upsert: a person must already
-- have been invited (a users row and a membership), because creating a tenant
-- is not something a request may do.
create or replace function app.link_auth_user(auth_id uuid, claimed_email text)
  returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  found_id uuid;
  linked_to uuid;
  matches int;
begin
  -- The identity arrives as arguments, which is only safe because the one
  -- caller that may pass them is the server that verified them: resolveSession,
  -- which calls this before it knows who the person is and so before it sets a
  -- claim. A caller carrying a claim is acting for somebody already — a tenant's
  -- request, or a Data API request, which always carries `sub` — and has no
  -- business pairing an invitation with an identity.
  if app.current_org_id() is not null or app.current_user_id() is not null then
    raise exception
      'link_auth_user is the first-sign-in lookup and takes no claims: it runs '
      'before a session is resolved, and a caller carrying one is acting for '
      'somebody already'
      using errcode = 'insufficient_privilege';
  end if;

  if auth_id is null or claimed_email is null or claimed_email = '' then
    raise exception 'link_auth_user needs a verified subject and email'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Already linked: the common path, and the only one that touches nothing.
  -- users.auth_user_id is unique, so this can never be ambiguous, and a person
  -- who has signed in before never reaches the checks below.
  select id into found_id from users where auth_user_id = auth_id;
  if found_id is not null then
    return found_id;
  end if;

  -- `users.email` is unique case-sensitively only. Two rows whose addresses
  -- differ only in case would make this sign-in whichever of the two the
  -- planner returned first — a session resolved to the wrong person, and
  -- nothing anywhere saying so. Refused by name, as member_for_link does
  -- (ADR 0034); an operator decides which row this person is.
  select count(*) into matches from users where lower(email) = lower(claimed_email);
  if matches > 1 then
    raise exception
      'more than one user answers to %, differing only in case: an operator must '
      'decide which one this sign-in is', claimed_email
      using errcode = 'cardinality_violation';
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

comment on function app.link_auth_user(uuid, text) is
  'First sign-in: links a verified identity provider subject to the invited '
  'users row with that address, and returns our user id. Refuses an address '
  'with no invitation, an account already linked to another identity, an '
  'address two users answer to case-insensitively, and any caller carrying a '
  'claim — its one caller, resolveSession, sets none before calling it (ADR 0015, '
  'ADR 0045).';

revoke all on function app.link_auth_user(uuid, text) from public;
grant execute on function app.link_auth_user(uuid, text) to app_rw;
