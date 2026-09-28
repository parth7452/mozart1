-- 0038 — A portal is read with a sealed credential (ADR 0057 §6, §7, §13, §15;
-- ADR 0062).
--
-- ADR 0057 designed portal read, and PR #127 built its engine: the recipe
-- schema, the request guard and the read-only runner, run only against a local
-- fixture portal. Nothing could hold a connection, a credential, a recipe
-- version or a run. This migration is the database half, for the first live
-- portal (ADR 0062, SAP Business Network: sign-in plumbing only). Its names are
-- exactly `packages/portal/src/contracts.ts`'s — PORTAL_TABLES, PORTAL_COLUMNS,
-- PORTAL_CONSTRAINTS and PORTAL_FUNCTIONS — and its column checks repeat that
-- file's schemas.
--
--   1. `portal_connections` — the registry (§13), accounting_connections'
--      shape: not append-only, because `enabled` flips. Every column but the
--      label and `enabled` is frozen by trigger, because the runner types the
--      parameters into the portal's forms and a run is keyed by its
--      connection. Only an owner writes one, as themselves, and at most one is
--      enabled per portal account across the deployment.
--   2. `portal_credentials` — sealed and append-only (§7): ciphertext, a
--      wrapped data key, the name of the KMS key, and the binding the
--      credential was sealed to. The latest row by `seq` is current. Only an
--      owner stores one, as themselves; no job rotates a portal credential.
--   3. `portal_recipe_versions` and `portal_recipe_reviews` — a recipe is
--      versioned, effective-dated data, immutable once written (§3), and a
--      person promotes one with a review row, owner-only, as themselves.
--   4. `portal_read_starts` and `portal_read_runs` — a run's start, written
--      before the worker is called, and its one outcome, written when it ends
--      (§13, ADR 0023's shape). app_rw holds SELECT only on both: every row
--      goes through `app.record_portal_read_start()` and
--      `app.record_portal_read_run()`, definer and bounded to the caller's own
--      org claim and subject, as `app.record_ledger_sync_run()` is (0024).
--   5. `portal_captures` — what a run captured, stored as a document or refused
--      at the door (§9): the post-audit trail from a stored page to the run,
--      the recipe version and the step that fetched it.
--   6. `app.portal_connections_to_read()` — ids for the fan-out, refused to any
--      caller carrying a claim (0033's rule).
--
-- Who writes what is the database's rule, and it holds for every role:
--
--   * an author column — a connection's and a credential's `created_by`, a
--     version's `created_by`, a review's `reviewer` and a start's
--     `requested_by` — must be the caller, by trigger, with no exception for
--     the table owner or a session with no claims (0031's rule, which ADR 0057
--     §3 cites for reviews);
--   * an owner inserts connections, credentials and reviews, and updates
--     connections (§15); a writer adds a person's recipe version, and only an
--     owner an agent session's (§3, §5);
--   * app_rw's one UPDATE is on `portal_connections (label, enabled)`, column
--     by column, and the freeze trigger answers for the owner.
--
-- Five rules go further than a schema can, because each is about more than
-- one row, and ADR 0057 states each:
--
--   * a run acts as its connection's `created_by` (§13), so only that
--     member's claims record its start and its outcome;
--   * a read that is not a dry run names a promoted version in effect, or none
--     and ends not_configured (§3); an unpromoted, rejected or not-yet-
--     effective version may only be dry-run;
--   * a dry run captures nothing (§3): no capture row, and no capture counted;
--   * a capture names its run's own recipe version, and a stored capture its
--     document's own hash: the bytes captured are the bytes kept (§9);
--   * an agent session's draft is promoted only with no additions (§3), and
--     who drafted a version is on its row and in its recipe, agreeing.
--
-- And one goes further than contracts.ts: an account id must hold an ASCII
-- letter or digit, because one-per-account compares ids by exactly those.
--
-- The SQLSTATEs a caller can meet, for the store to name:
--   42501  not the caller's to write: RLS, an author column that is not the
--          caller, or a run function's caller refused (no claims, another
--          org, another subject, not the member the run acts as)
--   23001  a frozen registry column changed; or a start or an outcome naming a
--          connection, version or run that does not exist, is another org's
--          or another portal's, or a version a read may not run
--   23514  a CHECK, by its name; or a review, a capture or an outcome that
--          does not agree with what it names (the messages say which)
--   23505  a PORTAL_CONSTRAINTS name; or a replayed start or outcome that
--          differs from the one written
--   23503  a composite tenancy tie
--   22004  a start or an outcome with no run id
--
-- What is deliberately NOT here: any change to an existing table, function,
-- policy, trigger or grant — `documents_org_id_id_key` (0034) is referenced,
-- not added; `app.require_approval()`, `app.member_may_write()`,
-- `app.member_is_owner()`, `app.block_mutations()` and
-- `app.guard_threshold_direction()` are used or untouched. No UPDATE or DELETE
-- grant on an append-only table. No money column: every count here is a row
-- count. And no column that can hold a credential, a TOTP secret or code, a
-- cookie or page text outside the sealed `wrapped_key` and `ciphertext` (§7):
-- a run records step names and pass or fail, and a capture the page's path
-- without its query.
--
-- Idempotent throughout: `create table if not exists`, `create or replace
-- function`, `create index if not exists`, drop-then-create for every trigger
-- and policy, and revoke-then-grant. scripts/db-test.sh applies every
-- migration twice, and supabase/tests/34_portal_read.sql reads the end state
-- back; suites 01 and 24 cover the new append-only tables too.

-- ---------------------------------------------------------------------------
-- 1. What a column may hold, where a check has to walk a value
-- ---------------------------------------------------------------------------
-- Four pure functions, each the database's copy of one contracts.ts schema,
-- used by the CHECK constraints below. Immutable, invoker, pinned (suite 24).
-- A CHECK runs its functions as the role inserting the row, so app_rw may
-- execute each; nobody else needs to.
--
-- The simpler rules are written inline on their columns, in two shapes that
-- recur. "No control characters" is `[\u0001-\u001f\u007f-\u009f]`, which is
-- contracts.ts's `\p{Cc}` (text cannot hold U+0000). "Trimmed" is refused a
-- leading or trailing character from
-- `[\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`,
-- which with the control characters is exactly what JavaScript's `trim()`
-- removes. Both are spelled out rather than written as `\s` or `[:space:]`,
-- whose meaning outside ASCII depends on the database's locale.

-- A connection's run parameters (PortalRunParamsSchema): an object of at most
-- 32 strings, each 1–256 characters with no control characters, under a name
-- that starts with a letter (so `__proto__` and its kin are never a name).
create or replace function app.portal_run_params_are_valid(p jsonb) returns boolean
  language plpgsql
  immutable
  set search_path = pg_catalog, public, extensions
as $$
declare
  entry record;
  entries integer := 0;
begin
  if p is null then
    return null;
  end if;
  if jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for entry in select e.key, e.value from jsonb_each(p) e loop
    entries := entries + 1;
    if entries > 32
       or entry.key !~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'
       or jsonb_typeof(entry.value) <> 'string'
       or length(entry.value #>> '{}') not between 1 and 256
       or (entry.value #>> '{}') ~ '[\u0001-\u001f\u007f-\u009f]' then
      return false;
    end if;
  end loop;
  return true;
end
$$;

comment on function app.portal_run_params_are_valid(jsonb) is
  'portal_connections.params as PortalRunParamsSchema has it: an object of at '
  'most 32 strings of 1–256 characters, no control characters, each under a '
  'name matching ^[A-Za-z][A-Za-z0-9_.-]{0,63}$ (ADR 0057 §3).';

-- A binding's sign-in paths (PortalBindingSchema): 1–64 paths, each starting
-- with `/` and at most 2048 characters, sorted with no duplicates. Compared
-- in "C" order, which is code-point order; JavaScript's sort() compares UTF-16
-- code units, and the two disagree only between a character above U+FFFF and
-- one in U+E000–U+FFFF — never in a URL path a browser sends.
create or replace function app.portal_sign_in_paths_are_canonical(p text[]) returns boolean
  language plpgsql
  immutable
  set search_path = pg_catalog, public, extensions
as $$
declare
  path text;
  previous text;
begin
  if p is null then
    return null;
  end if;
  if coalesce(array_ndims(p), 0) <> 1 or cardinality(p) not between 1 and 64 then
    return false;
  end if;
  foreach path in array p loop
    if path is null
       or length(path) not between 1 and 2048
       or left(path, 1) <> '/'
       or (previous is not null and not (previous collate "C" < path collate "C")) then
      return false;
    end if;
    previous := path;
  end loop;
  return true;
end
$$;

comment on function app.portal_sign_in_paths_are_canonical(text[]) is
  'portal_credentials.sign_in_paths as PortalBindingSchema has it: 1–64 paths, '
  'each starting with / and at most 2048 characters, sorted, no duplicates '
  '(ADR 0057 §7).';

-- A run's step log (RunStepLogEntry[]): step names and pass or fail, and
-- nothing else — no third key, ever, because a key that can hold a value can
-- hold page text (ADR 0057 §3, §7). One line per step name.
create or replace function app.portal_step_log_is_valid(p jsonb) returns boolean
  language plpgsql
  immutable
  set search_path = pg_catalog, public, extensions
as $$
declare
  line jsonb;
  step text;
  seen text[] := '{}';
begin
  if p is null then
    return null;
  end if;
  if jsonb_typeof(p) <> 'array' then
    return false;
  end if;
  for line in select e.value from jsonb_array_elements(p) e loop
    -- Its own IF, ahead of reading keys: SQL promises no order within an OR,
    -- and jsonb_object_keys raises on anything but an object.
    if jsonb_typeof(line) <> 'object' then
      return false;
    end if;
    if (select array_agg(k collate "C" order by k collate "C") from jsonb_object_keys(line) k)
         is distinct from array['passed', 'step']
       or jsonb_typeof(line -> 'step') <> 'string'
       or jsonb_typeof(line -> 'passed') <> 'boolean' then
      return false;
    end if;
    step := line ->> 'step';
    if length(step) not between 1 and 200
       or step ~ '[\u0001-\u001f\u007f-\u009f]'
       or step = any (seen) then
      return false;
    end if;
    seen := seen || step;
  end loop;
  return true;
end
$$;

comment on function app.portal_step_log_is_valid(jsonb) is
  'portal_read_runs.step_log as RunStepLogEntry[]: objects with exactly a step '
  'name (1–200 characters, no control characters, unique) and a boolean '
  '`passed`. Names and pass or fail only, never a value (ADR 0057 §3).';

-- What a promotion names beyond the promoted version (PortalRecipeAddition[]):
-- each a host, a POST-as-read entry or a dismiss step, with exactly its
-- variant's keys.
create or replace function app.portal_recipe_additions_are_valid(p jsonb) returns boolean
  language plpgsql
  immutable
  set search_path = pg_catalog, public, extensions
as $$
declare
  addition jsonb;
  keys text[];
  discriminator jsonb;
begin
  if p is null then
    return null;
  end if;
  if jsonb_typeof(p) <> 'array' then
    return false;
  end if;
  for addition in select e.value from jsonb_array_elements(p) e loop
    if jsonb_typeof(addition) <> 'object' then
      return false;
    end if;
    select array_agg(k collate "C" order by k collate "C") into keys
      from jsonb_object_keys(addition) k;
    case addition ->> 'kind'
      when 'host' then
        if keys is distinct from array['host', 'kind']
           or jsonb_typeof(addition -> 'host') <> 'string' then
          return false;
        end if;
      when 'post_as_read' then
        discriminator := addition -> 'bodyDiscriminator';
        if keys is distinct from array['bodyDiscriminator', 'kind', 'path', 'step']
           or jsonb_typeof(addition -> 'step') <> 'string'
           or jsonb_typeof(addition -> 'path') <> 'string'
           or jsonb_typeof(discriminator) not in ('null', 'object') then
          return false;
        end if;
        if jsonb_typeof(discriminator) = 'object' then
          if (select array_agg(k collate "C" order by k collate "C")
                from jsonb_object_keys(discriminator) k)
               is distinct from array['equals', 'field']
             or jsonb_typeof(discriminator -> 'field') <> 'string'
             or jsonb_typeof(discriminator -> 'equals') <> 'string' then
            return false;
          end if;
        end if;
      when 'dismiss' then
        if keys is distinct from array['kind', 'label', 'step']
           or jsonb_typeof(addition -> 'step') <> 'string'
           or jsonb_typeof(addition -> 'label') <> 'string' then
          return false;
        end if;
      else
        return false;
    end case;
  end loop;
  return true;
end
$$;

comment on function app.portal_recipe_additions_are_valid(jsonb) is
  'portal_recipe_reviews.additions as PortalRecipeAddition[]: each a host, a '
  'POST-as-read entry or a dismiss step, with exactly its variant''s keys '
  '(ADR 0057 §3).';

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'app.portal_run_params_are_valid(jsonb)',
    'app.portal_sign_in_paths_are_canonical(text[])',
    'app.portal_step_log_is_valid(jsonb)',
    'app.portal_recipe_additions_are_valid(jsonb)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to app_rw', fn);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. portal_connections — the registry (§13)
-- ---------------------------------------------------------------------------
create table if not exists portal_connections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  -- Data naming a portal, never a code path (ADR 0057 §3).
  portal_key  text not null
                constraint portal_connections_portal_key_check
                check (portal_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- What a person calls it. The only column but `enabled` an update may change.
  label       text not null
                constraint portal_connections_label_check
                check (length(label) between 1 and 120
                       and label !~ '[\u0001-\u001f\u007f-\u009f]'
                       and label !~ '^[\u0020\u00a0\u1680\u2000-\u200a'
                                    '\u2028\u2029\u202f\u205f\u3000\ufeff]'
                       and label !~ '[\u0020\u00a0\u1680\u2000-\u200a'
                                    '\u2028\u2029\u202f\u205f\u3000\ufeff]$'),
  -- The portal account's public identifier (for SAP Business Network, the
  -- ANID), never the username. It has to hold a letter or a digit, because
  -- one-per-account (below) compares identifiers by their letters and digits,
  -- and one with none would compare equal to every other with none.
  account_id  text not null
                constraint portal_connections_account_id_check
                check (length(account_id) between 1 and 128
                       and account_id !~ '[\u0001-\u001f\u007f-\u009f]'
                       and account_id !~ '^[\u0020\u00a0\u1680\u2000-\u200a'
                                         '\u2028\u2029\u202f\u205f\u3000\ufeff]'
                       and account_id !~ '[\u0020\u00a0\u1680\u2000-\u200a'
                                         '\u2028\u2029\u202f\u205f\u3000\ufeff]$'
                       and account_id ~ '[A-Za-z0-9]'),
  -- What the recipe's `search` steps type into the portal. Shown, stored in the
  -- clear and sent in a request, so never a credential.
  params      jsonb not null default '{}'::jsonb
                constraint portal_connections_params_check
                check (app.portal_run_params_are_valid(params)),
  enabled     boolean not null default true,
  -- The owner who connected it, and the member every run of it acts as.
  created_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- For the composite foreign keys below (ADR 0025 §7).
  constraint portal_connections_org_id_id_key unique (org_id, id)
);

comment on table portal_connections is
  'Which portal accounts a tenant reads, and who connected each (ADR 0057 §13). '
  'Not append-only: `enabled` flips. Every column but label and enabled is '
  'frozen by app.touch_portal_connection(), so a run keyed by its connection '
  'always describes what it ran with; a different account, portal, parameter or '
  'member is a new connection. Owner-only, as the caller. Holds no credential '
  'of any kind: those are sealed in portal_credentials.';

comment on column portal_connections.account_id is
  'The portal account''s public identifier (an ANID, a supplier number), never '
  'the username. Every run checks it: a recipe''s first step after sign-in '
  'expects it on the page, and a mismatch ends the run account_mismatch.';

comment on column portal_connections.params is
  'The run parameters the recipe''s search steps type into the portal '
  '(PortalRunParamsSchema). Frozen with the connection, and never a credential.';

comment on column portal_connections.created_by is
  'The owner who connected it, and the member every run of it acts as: the '
  'job sets its claims and asks app.member_may_write() of them first.';

-- One enabled connection per portal account across the deployment (§13), as
-- 0030 has it for ledgers: two workspaces of one agency must not both read one
-- supplier's account. The identifier is folded to its ASCII letters and digits,
-- lower-cased, so `AN0123-4567` and `an01234567` are one account while an ANID's
-- test twin (`…-T`) is another. Stripped before it is lower-cased, so the fold
-- reads nothing the database's locale could answer differently.
create unique index if not exists portal_connections_one_enabled_per_account
  on portal_connections (portal_key, (lower(regexp_replace(account_id, '[^A-Za-z0-9]', '', 'g'))))
  where enabled;

comment on index portal_connections_one_enabled_per_account is
  'At most one enabled connection per portal account across every org (ADR '
  '0057 §13), over the portal key and the account id folded to its ASCII '
  'letters and digits, lower-cased. The store maps a 23505 on this name to '
  '"connected elsewhere" (contracts.ts PORTAL_CONSTRAINTS).';

create index if not exists portal_connections_org_idx
  on portal_connections (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. portal_credentials — sealed, and bound to where it may be typed (§7)
-- ---------------------------------------------------------------------------
create table if not exists portal_credentials (
  id              uuid primary key default gen_random_uuid(),
  -- Which row is current: `created_at` ties inside one transaction (0025).
  seq             bigint generated always as identity,
  org_id          uuid not null references organizations(id),
  connection_id   uuid not null,
  -- Names it for a person, and is never the username (Settings refuses one
  -- that contains it, which only the plaintext can check).
  label           text
                    constraint portal_credentials_label_check
                    check (label is null
                           or (length(label) between 1 and 120
                               and label !~ '[\u0001-\u001f\u007f-\u009f]'
                               and label !~ '^[\u0020\u00a0\u1680\u2000-\u200a'
                                            '\u2028\u2029\u202f\u205f\u3000\ufeff]'
                               and label !~ '[\u0020\u00a0\u1680\u2000-\u200a'
                                            '\u2028\u2029\u202f\u205f\u3000\ufeff]$')),
  -- Which cipher sealed it: a name, not a secret. Not blank: it holds a
  -- character JavaScript's trim() would keep.
  cipher          text not null
                    constraint portal_credentials_cipher_check
                    check (length(cipher) between 1 and 200
                           and cipher ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a'
                                        '\u2028\u2029\u202f\u205f\u3000\ufeff]'),
  -- The portal KMS key that can unwrap `wrapped_key`: a name for key
  -- material, never key material. Not the QuickBooks key (§7).
  key_id          text not null
                    constraint portal_credentials_key_id_check
                    check (length(key_id) between 1 and 2048
                           and key_id ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a'
                                        '\u2028\u2029\u202f\u205f\u3000\ufeff]'),
  -- The data key under that KMS key, base64. Only the worker's identity may
  -- call kms:Decrypt on it; the app's may not.
  wrapped_key     text not null
                    constraint portal_credentials_wrapped_key_check
                    check (length(wrapped_key) between 1 and 20000),
  -- Username, password and TOTP secret as one payload under the data key,
  -- base64, with the binding below authenticated in its encryption context.
  ciphertext      text not null
                    constraint portal_credentials_ciphertext_check
                    check (length(ciphertext) between 1 and 20000),
  -- The binding (PortalBinding): where the credential may be typed. It
  -- describes the portal, not the credential. `URL.origin`'s form: http(s),
  -- printable ASCII, lower-case, no path, query, fragment or user info.
  sign_in_origin  text not null
                    constraint portal_credentials_sign_in_origin_check
                    check (length(sign_in_origin) <= 2048
                           and sign_in_origin ~ '^https?://[\u0021-\u007e]+$'
                           and sign_in_origin !~ '^https?://.*[/?#@\\]'
                           and sign_in_origin = lower(sign_in_origin)),
  sign_in_paths   text[] not null
                    constraint portal_credentials_sign_in_paths_check
                    check (app.portal_sign_in_paths_are_canonical(sign_in_paths)),
  hosts_hash      text not null
                    constraint portal_credentials_hosts_hash_check
                    check (hosts_hash ~ '^[0-9a-f]{64}$'),
  -- The owner who entered it, as themselves.
  created_by      uuid not null references users(id),
  created_at      timestamptz not null default now(),
  -- The tenancy tie (ADR 0025 §7): a ciphertext hung off another tenant's
  -- connection would be one opened under the wrong encryption context.
  constraint portal_credentials_same_org
    foreign key (org_id, connection_id) references portal_connections (org_id, id)
);

comment on table portal_credentials is
  'One row per portal credential entered, sealed (ADR 0057 §7). The current '
  'credential is the latest row for the connection by seq; replacing one is a '
  'new row, and removing one disables the connection. **No plaintext column of '
  'any kind, ever**: ciphertext, a wrapped data key, the name of the portal KMS '
  'key, and the binding (sign-in origin, sign-in paths, hosts hash) it was '
  'sealed to, which is authenticated in its encryption context. Only an owner '
  'stores one, as themselves. supabase/tests/34 asserts the column list against '
  'the catalogue in both directions.';

comment on column portal_credentials.ciphertext is
  'Username, password and TOTP secret as one payload under AES-256-GCM, '
  'base64. The context {purpose portal_credential, org, connection, binding} '
  'is authenticated, so it opens for no other tenant, connection or binding, '
  'and never as a QuickBooks token.';

comment on column portal_credentials.key_id is
  'A name for the portal KMS key, never key material.';

create index if not exists portal_credentials_latest_idx
  on portal_credentials (org_id, connection_id, seq desc);

-- ---------------------------------------------------------------------------
-- 4. portal_recipe_versions and portal_recipe_reviews — data a person promotes
-- ---------------------------------------------------------------------------
create table if not exists portal_recipe_versions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id),
  portal_key        text not null
                      constraint portal_recipe_versions_portal_key_check
                      check (portal_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  version           integer not null
                      constraint portal_recipe_versions_version_check
                      check (version > 0),
  effective_from    date not null,
  -- The RecipeVersion as parseRecipe returned it. Its own portal key, version
  -- and effective date are the three columns above (checked below).
  recipe            jsonb not null,
  -- Its author, as themselves: a person, or the owner who started the agent
  -- session that drafted it (§5).
  created_by        uuid not null references users(id),
  agent_session_id  text
                      constraint portal_recipe_versions_agent_session_id_check
                      check (agent_session_id is null
                             or agent_session_id ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a'
                                                   '\u2028\u2029\u202f\u205f\u3000\ufeff]'),
  created_at        timestamptz not null default now(),
  constraint portal_recipe_versions_org_id_id_key unique (org_id, id),
  constraint portal_recipe_versions_one_per_number unique (org_id, portal_key, version),
  -- The row says what the recipe says. Each conjunct is a definite boolean,
  -- because a CHECK that comes out null passes.
  constraint portal_recipe_versions_recipe_is_its_row check (
    jsonb_typeof(recipe) = 'object'
    and (recipe ->> 'portalKey') is not distinct from portal_key
    and jsonb_typeof(recipe -> 'version') is not distinct from 'number'
    and (recipe ->> 'version') is not distinct from version::text
    and (recipe ->> 'effectiveFrom') is not distinct from to_char(effective_from, 'YYYY-MM-DD')
  ),
  -- Who drafted it is on the row and in the recipe, and the two agree: an agent
  -- session's draft cannot pass as a person's and escape the promotion rule
  -- that only an agent's draft is held to (§3).
  constraint portal_recipe_versions_drafted_by check (
    case recipe #>> '{provenance,draftedBy,kind}'
      when 'person' then agent_session_id is null
      when 'agent_session' then
        agent_session_id is not null
        and agent_session_id is not distinct from (recipe #>> '{provenance,draftedBy,id}')
      else false
    end
  )
);

comment on table portal_recipe_versions is
  'How to read one portal: versioned, effective-dated data (ADR 0057 §3). '
  'Append-only and immutable — a changed portal is a new version, never an '
  'edit — and used only once an owner has promoted it with a review row. Its '
  'author writes it, as themselves; an agent session''s draft only an owner.';

comment on column portal_recipe_versions.agent_session_id is
  'The agent session that drafted it (ADR 0057 §5), agreeing with the recipe''s '
  'provenance.draftedBy; null for a person''s version.';

create index if not exists portal_recipe_versions_in_effect_idx
  on portal_recipe_versions (org_id, portal_key, effective_from desc, version desc);

create table if not exists portal_recipe_reviews (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations(id),
  recipe_version_id         uuid not null,
  verdict                   text not null
                              constraint portal_recipe_reviews_verdict_check
                              check (verdict in ('promoted', 'rejected')),
  -- The owner who reviewed it, as themselves.
  reviewer                  uuid not null references users(id),
  -- The promoted version its additions were counted against; null for a
  -- portal's first.
  compared_with_version_id  uuid,
  additions                 jsonb not null default '[]'::jsonb
                              constraint portal_recipe_reviews_additions_check
                              check (app.portal_recipe_additions_are_valid(additions)),
  created_at                timestamptz not null default now(),
  -- One verdict per version, and it is final.
  constraint portal_recipe_reviews_one_per_version unique (recipe_version_id),
  constraint portal_recipe_reviews_version_same_org
    foreign key (org_id, recipe_version_id) references portal_recipe_versions (org_id, id),
  constraint portal_recipe_reviews_compared_same_org
    foreign key (org_id, compared_with_version_id) references portal_recipe_versions (org_id, id),
  constraint portal_recipe_reviews_not_compared_with_itself
    check (compared_with_version_id is distinct from recipe_version_id)
);

comment on table portal_recipe_reviews is
  'An owner''s one verdict on a recipe version (ADR 0057 §3): promoted or '
  'rejected, naming each host, POST-as-read entry and floor-listed dismiss it '
  'adds beyond the promoted version it was compared with. An agent session''s '
  'draft that adds any is never promoted. Append-only, owner-only, written by '
  'the reviewer it names.';

-- ---------------------------------------------------------------------------
-- 5. portal_read_starts and portal_read_runs — a run and how it ended (§13)
-- ---------------------------------------------------------------------------
create table if not exists portal_read_starts (
  -- The run id (RunRequest.runId), minted by the job, so a retried step
  -- replays this row rather than writing a second.
  id                 uuid primary key,
  org_id             uuid not null references organizations(id),
  connection_id      uuid not null,
  -- Null only for a run that found no version to run; it ends not_configured.
  recipe_version_id  uuid,
  dry_run            boolean not null,
  -- The member the run acts as: the connection's created_by, as themselves.
  requested_by       uuid not null references users(id),
  started_at         timestamptz not null default now(),
  constraint portal_read_starts_org_id_id_key unique (org_id, id),
  constraint portal_read_starts_connection_same_org
    foreign key (org_id, connection_id) references portal_connections (org_id, id),
  constraint portal_read_starts_version_same_org
    foreign key (org_id, recipe_version_id) references portal_recipe_versions (org_id, id)
);

comment on table portal_read_starts is
  'A portal read''s start, written before the worker is called (ADR 0057 §13): '
  'the connection (whose parameters are frozen), the recipe version, whether it '
  'is a dry run, and the member it acts as. A run killed mid-flight leaves this '
  'row with no outcome, and its captures still name it. Append-only; written '
  'only by app.record_portal_read_start().';

create index if not exists portal_read_starts_connection_idx
  on portal_read_starts (org_id, connection_id, started_at desc);

create table if not exists portal_read_runs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id),
  run_id              uuid not null,
  outcome             text not null
                        constraint portal_read_runs_outcome_check
                        check (outcome in ('completed', 'not_configured', 'refused',
                                           'needs_attention', 'failed')),
  -- PORTAL_REASONS_BY_OUTCOME: checked with the outcome, below.
  reason              text,
  -- A class name and never a message (invariant 4): an error off this path
  -- can quote a page.
  error_class         text
                        constraint portal_read_runs_error_class_check
                        check (error_class is null
                               or (length(error_class) <= 100
                                   and error_class ~ '^[A-Za-z_$][A-Za-z0-9_$]*$')),
  -- The recipe step the run stopped at; null when it stopped at none.
  at_step             text
                        constraint portal_read_runs_at_step_check
                        check (at_step is null
                               or (length(at_step) between 1 and 200
                                   and at_step !~ '[\u0001-\u001f\u007f-\u009f]')),
  -- Row counts, not money.
  page_count          integer not null default 0
                        constraint portal_read_runs_page_count_check check (page_count >= 0),
  capture_count       integer not null default 0
                        constraint portal_read_runs_capture_count_check check (capture_count >= 0),
  new_document_count  integer not null default 0
                        constraint portal_read_runs_new_document_count_check
                        check (new_document_count >= 0),
  deduplicated_count  integer not null default 0
                        constraint portal_read_runs_deduplicated_count_check
                        check (deduplicated_count >= 0),
  refusal_count       integer not null default 0
                        constraint portal_read_runs_refusal_count_check check (refusal_count >= 0),
  step_log            jsonb not null default '[]'::jsonb
                        constraint portal_read_runs_step_log_check
                        check (app.portal_step_log_is_valid(step_log)),
  finished_at         timestamptz not null default now(),
  constraint portal_read_runs_one_per_run unique (run_id),
  constraint portal_read_runs_start_same_org
    foreign key (org_id, run_id) references portal_read_starts (org_id, id),
  -- Which reasons each outcome takes (contracts.ts PORTAL_REASONS_BY_OUTCOME);
  -- the other three outcomes take none.
  constraint portal_read_runs_reason_fits_outcome check (
    case outcome
      when 'needs_attention' then
        reason is not null
        and reason in ('mfa_unanswerable', 'challenge', 'page_changed', 'terms_prompt',
                       'credential_rejected', 'session_expired', 'account_mismatch',
                       'binding_mismatch', 'capture_refused')
      when 'failed' then
        reason is not null
        and reason in ('guard_refused', 'never_click', 'file_input', 'cap_exceeded',
                       'sign_in_form_refused', 'error')
      else reason is null
    end
  ),
  -- PortalRunEnd: not_configured and refused say which refusal or which lack
  -- by class name, as does a failed run whose reason is `error`; nothing else
  -- carries one.
  constraint portal_read_runs_error_class_fits_outcome check (
    case
      when outcome in ('not_configured', 'refused') then error_class is not null
      when outcome = 'failed' and reason = 'error' then error_class is not null
      else error_class is null
    end
  )
);

comment on table portal_read_runs is
  'A portal read''s one outcome, written once when it ends, and complete '
  '(ADR 0057 §13, ADR 0023''s shape): outcome, reason code, error class name, '
  'the step it stopped at, counts and the step log. Never page text, a query '
  'string or anything credential-shaped. Append-only; written only by '
  'app.record_portal_read_run().';

comment on column portal_read_runs.step_log is
  'RunStepLogEntry[]: each step''s name and whether it passed, in the order '
  'each first ran, and nothing else (app.portal_step_log_is_valid).';

-- ---------------------------------------------------------------------------
-- 6. portal_captures — the trail from a stored page to the run that fetched it
-- ---------------------------------------------------------------------------
create table if not exists portal_captures (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations(id),
  run_id                 uuid not null,
  -- The run's own version (checked by trigger).
  recipe_version_id      uuid not null,
  -- The document its bytes became — a new one, or the one the tenant already
  -- held, which keeps its first arrival (§9). Null exactly when refused.
  document_id            uuid,
  -- The door's RejectionCode (packages/ingest/src/sniff-errors.ts), for a
  -- capture it refused. No bytes are kept for one.
  refusal                text
                           constraint portal_captures_refusal_check
                           check (refusal is null or refusal in (
                             'empty_file', 'body_too_short', 'too_large', 'type_not_allowed',
                             'content_does_not_match_type', 'encrypted_pdf',
                             'active_content_pdf', 'decompression_bomb', 'malformed_pdf',
                             'macro_enabled_spreadsheet', 'active_content_spreadsheet',
                             'legacy_or_encrypted_office', 'xml_dtd_refused',
                             'malformed_spreadsheet', 'spreadsheet_too_large')),
  kind                   text not null
                           constraint portal_captures_kind_check
                           check (kind in ('page_snapshot', 'download')),
  step_name              text not null
                           constraint portal_captures_step_name_check
                           check (length(step_name) between 1 and 200
                                  and step_name !~ '[\u0001-\u001f\u007f-\u009f]'),
  -- The page's path and only its path (RunCapture.pagePath): no query, no
  -- fragment, no `;` parameters (a `;jsessionid=` is a session token) and no
  -- ASP.NET cookieless segment (`/(S(…))/`, whose F form is a ticket).
  page_path              text not null
                           constraint portal_captures_page_path_check
                           check (length(page_path) between 1 and 2048
                                  and page_path ~ '^/[^?#;\u0001-\u001f\u007f-\u009f]*$'
                                  and page_path !~ '\([A-Za-z]\('),
  -- The snapshot serialiser's rule version; set exactly for a page_snapshot.
  snapshot_rule_version  integer
                           constraint portal_captures_snapshot_rule_version_check
                           check (snapshot_rule_version is null or snapshot_rule_version > 0),
  -- Of the captured bytes, stored or refused; a stored one's is its
  -- document's (checked by trigger).
  sha256                 text not null
                           constraint portal_captures_sha256_check
                           check (sha256 ~ '^[0-9a-f]{64}$'),
  captured_at            timestamptz not null,
  created_at             timestamptz not null default now(),
  constraint portal_captures_start_same_org
    foreign key (org_id, run_id) references portal_read_starts (org_id, id),
  constraint portal_captures_version_same_org
    foreign key (org_id, recipe_version_id) references portal_recipe_versions (org_id, id),
  constraint portal_captures_document_same_org
    foreign key (org_id, document_id) references documents (org_id, id),
  constraint portal_captures_stored_or_refused
    check ((document_id is null) = (refusal is not null)),
  constraint portal_captures_snapshot_names_its_rule
    check ((kind = 'page_snapshot') = (snapshot_rule_version is not null))
);

comment on table portal_captures is
  'Each page snapshot or download a portal read captured (ADR 0057 §9): the '
  'document it became or the door''s refusal, the run''s start row, the recipe '
  'version, the step, the page''s path without its query, and when. Written in '
  'the transaction that wrote its uploads row. Append-only: the post-audit '
  'trail from a number on a case to the run that fetched its page.';

create index if not exists portal_captures_run_idx
  on portal_captures (org_id, run_id, captured_at);
create index if not exists portal_captures_document_idx
  on portal_captures (org_id, document_id) where document_id is not null;

-- ---------------------------------------------------------------------------
-- 7. Triggers: an author is the caller; a connection is frozen; a review and
--    a capture agree with what they name
-- ---------------------------------------------------------------------------
-- 0031's rule, for every author column here, and with no exception for the
-- table owner or a session with no claims: whoever writes the row says whose it
-- is, in the claim every policy reads. The column is the trigger's argument.
create or replace function app.portal_row_names_its_author() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  author_column text;
  author uuid;
begin
  author_column := tg_argv[0];
  author := (to_jsonb(new) ->> author_column)::uuid;
  if author is distinct from app.current_user_id() then
    raise exception
      '% blocked: % % is not the caller %',
      tg_table_name, author_column, author,
      coalesce(app.current_user_id()::text, '(no session)')
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

comment on function app.portal_row_names_its_author() is
  'A portal row''s author column (the trigger''s argument) must be the caller, '
  'for every role, the table owner included (0031''s rule; ADR 0057 §3, §15).';

-- The registry's freeze: every column but the label and `enabled` (and
-- `updated_at`, which is this trigger's) is refused a change, by name and
-- never by value. Asked of the whole row rather than a list, so a column a
-- later migration adds is frozen until that migration says otherwise.
create or replace function app.touch_portal_connection() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  changed text;
begin
  select string_agg(o.key, ', ' order by o.key) into changed
    from jsonb_each(to_jsonb(old)) o
   where o.key not in ('label', 'enabled', 'updated_at')
     and o.value is distinct from (to_jsonb(new) -> o.key);
  if changed is not null then
    raise exception
      'portal_connections: % cannot change; only the label and enabled do. A '
      'different account, portal, parameter or member is a new connection '
      '(ADR 0057 §13)', changed
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

comment on function app.touch_portal_connection() is
  'Freezes every portal_connections column but label and enabled, and keeps '
  'updated_at honest (ADR 0057 §13; 0030''s touch_accounting_connection).';

-- A review agrees with the versions it names. The composite foreign keys say
-- each is this org's; this says the rest.
create or replace function app.portal_review_is_consistent() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  reviewed record;
  compared record;
begin
  select v.portal_key, v.agent_session_id into reviewed
    from portal_recipe_versions v
   where v.org_id = new.org_id and v.id = new.recipe_version_id;
  if not found then
    -- The foreign key refuses it, in its own words.
    return new;
  end if;

  -- Promotion refuses an agent session's draft that adds a host, a
  -- POST-as-read entry or a floor-listed dismiss beyond the promoted version
  -- (§3). The additions are counted by code; this is the floor under it.
  -- Nested rather than one AND: SQL promises no order within it, and
  -- jsonb_array_length raises on a non-array, which the additions CHECK refuses
  -- by name after this trigger.
  if new.verdict = 'promoted' and reviewed.agent_session_id is not null
     and jsonb_typeof(new.additions) = 'array' then
    if jsonb_array_length(new.additions) > 0 then
      raise exception
        'portal recipe review blocked: version % was drafted by an agent session '
        'and adds % entr% beyond the promoted version; only a person''s version '
        'may add a host, a POST-as-read entry or a floor-listed dismiss (ADR 0057 §3)',
        new.recipe_version_id, jsonb_array_length(new.additions),
        case when jsonb_array_length(new.additions) = 1 then 'y' else 'ies' end
        using errcode = 'check_violation';
    end if;
  end if;

  -- A version compared with itself is portal_recipe_reviews_not_compared_with_itself's
  -- to refuse, by name.
  if new.compared_with_version_id is not null
     and new.compared_with_version_id <> new.recipe_version_id then
    select v.portal_key,
           exists (select 1 from portal_recipe_reviews r
                    where r.recipe_version_id = v.id and r.verdict = 'promoted') as promoted
      into compared
      from portal_recipe_versions v
     where v.org_id = new.org_id and v.id = new.compared_with_version_id;
    if found then
      if compared.portal_key <> reviewed.portal_key then
        raise exception
          'portal recipe review blocked: version % is compared with a version of '
          'another portal', new.recipe_version_id
          using errcode = 'check_violation';
      end if;
      if not compared.promoted then
        raise exception
          'portal recipe review blocked: additions are counted against a promoted '
          'version, and version % was never promoted', new.compared_with_version_id
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  return new;
end
$$;

comment on function app.portal_review_is_consistent() is
  'A portal recipe review promotes no agent-drafted version with additions, and '
  'counts additions only against a promoted version of the same portal (ADR '
  '0057 §3).';

-- A capture agrees with its run and its document: a dry run captures nothing
-- (§3), a capture names its run's own recipe version, and a stored capture's
-- hash is its document's — the bytes captured are the bytes kept (§9).
create or replace function app.portal_capture_is_consistent() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  start_row record;
  document_hash text;
begin
  select s.dry_run, s.recipe_version_id into start_row
    from portal_read_starts s
   where s.org_id = new.org_id and s.id = new.run_id;
  if found then
    if start_row.dry_run then
      raise exception
        'portal capture blocked: run % is a dry run, and a dry run captures '
        'nothing (ADR 0057 §3)', new.run_id
        using errcode = 'check_violation';
    end if;
    if start_row.recipe_version_id is distinct from new.recipe_version_id then
      raise exception
        'portal capture blocked: a capture names its run''s recipe version, and '
        'run % did not run version %', new.run_id, new.recipe_version_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.document_id is not null then
    select encode(d.sha256, 'hex') into document_hash
      from documents d
     where d.org_id = new.org_id and d.id = new.document_id;
    if found and document_hash is distinct from new.sha256 then
      raise exception
        'portal capture blocked: its bytes are not document %''s; a capture '
        'names the document its own bytes became (ADR 0057 §9)', new.document_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

comment on function app.portal_capture_is_consistent() is
  'A portal capture is of a run that is not a dry run, names that run''s recipe '
  'version, and, when stored, carries its document''s own hash (ADR 0057 §3, §9).';

revoke all on function app.portal_row_names_its_author() from public;
revoke all on function app.touch_portal_connection() from public;
revoke all on function app.portal_review_is_consistent() from public;
revoke all on function app.portal_capture_is_consistent() from public;

-- Row-level BEFORE triggers fire in name order: on a review, `names_its_author`
-- runs ahead of `review_is_consistent`, so a forged review is refused as forged.
drop trigger if exists names_its_author on portal_connections;
create trigger names_its_author before insert on portal_connections
  for each row execute function app.portal_row_names_its_author('created_by');
drop trigger if exists touch_portal_connection on portal_connections;
create trigger touch_portal_connection before update on portal_connections
  for each row execute function app.touch_portal_connection();

drop trigger if exists names_its_author on portal_credentials;
create trigger names_its_author before insert on portal_credentials
  for each row execute function app.portal_row_names_its_author('created_by');

drop trigger if exists names_its_author on portal_recipe_versions;
create trigger names_its_author before insert on portal_recipe_versions
  for each row execute function app.portal_row_names_its_author('created_by');

drop trigger if exists names_its_author on portal_recipe_reviews;
create trigger names_its_author before insert on portal_recipe_reviews
  for each row execute function app.portal_row_names_its_author('reviewer');
drop trigger if exists review_is_consistent on portal_recipe_reviews;
create trigger review_is_consistent before insert on portal_recipe_reviews
  for each row execute function app.portal_review_is_consistent();

drop trigger if exists names_its_author on portal_read_starts;
create trigger names_its_author before insert on portal_read_starts
  for each row execute function app.portal_row_names_its_author('requested_by');

drop trigger if exists capture_is_consistent on portal_captures;
create trigger capture_is_consistent before insert on portal_captures
  for each row execute function app.portal_capture_is_consistent();

-- ---------------------------------------------------------------------------
-- 8. RLS, one policy per command, grants, and the append-only triggers
-- ---------------------------------------------------------------------------
alter table portal_connections enable row level security;
alter table portal_credentials enable row level security;
alter table portal_recipe_versions enable row level security;
alter table portal_recipe_reviews enable row level security;
alter table portal_read_starts enable row level security;
alter table portal_read_runs enable row level security;
alter table portal_captures enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'portal_connections', 'portal_credentials', 'portal_recipe_versions',
    'portal_recipe_reviews', 'portal_read_starts', 'portal_read_runs', 'portal_captures'
  ] loop
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('drop policy if exists tenant_read on %I', t);
    execute format('drop policy if exists tenant_insert on %I', t);
    execute format('drop policy if exists tenant_update on %I', t);
    execute format('drop policy if exists tenant_delete on %I', t);
    -- Reads are the tenant's, `read_only` included: a credential row is
    -- ciphertext only the worker can open.
    execute format(
      'create policy tenant_read on %I for select using (org_id = app.current_org_id())', t);
  end loop;

  -- The registry: an owner, as themselves (0030's rule for ledgers). An
  -- update touches only an owner's rows; there is no DELETE grant, and the
  -- delete policy is there so that a grant issued in a hurry lands on a rule.
  execute 'create policy tenant_insert on portal_connections for insert
             with check (org_id = app.current_org_id() and app.member_is_owner()
                         and created_by = app.current_user_id())';
  execute 'create policy tenant_update on portal_connections for update
             using (org_id = app.current_org_id() and app.member_is_owner())
             with check (org_id = app.current_org_id() and app.member_is_owner())';
  execute 'create policy tenant_delete on portal_connections for delete
             using (org_id = app.current_org_id() and app.member_is_owner())';

  -- Credentials and reviews: owner-only, as the caller (ADR 0057 §15, verbatim).
  -- Stricter than accounting_credentials, where the sync stores rotations as a
  -- member who may since have been demoted; no job rotates a portal credential.
  execute 'create policy tenant_insert on portal_credentials for insert
             with check (org_id = app.current_org_id() and app.member_is_owner()
                         and created_by = app.current_user_id())';
  execute 'create policy tenant_insert on portal_recipe_reviews for insert
             with check (org_id = app.current_org_id() and app.member_is_owner()
                         and reviewer = app.current_user_id())';

  -- A version: any writer, as themselves; an agent session's draft only the
  -- owner who started the session (ADR 0057 §5: only an owner starts one).
  execute 'create policy tenant_insert on portal_recipe_versions for insert
             with check (org_id = app.current_org_id() and app.member_may_write()
                         and created_by = app.current_user_id()
                         and (agent_session_id is null or app.member_is_owner()))';

  -- A capture: the writer the job acts as, in the transaction that records
  -- its upload (uploads' own rule).
  execute 'create policy tenant_insert on portal_captures for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';

  -- Present and never reachable: app_rw holds no INSERT on the run tables, so
  -- every row goes through the definer functions (0024's reasoning).
  execute 'create policy tenant_insert on portal_read_starts for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_insert on portal_read_runs for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';

  -- Present so a future grant cannot arrive without a policy behind it. No
  -- UPDATE or DELETE is granted on any of these, and the triggers below refuse
  -- both whatever the role (invariant 2).
  foreach t in array array['portal_credentials', 'portal_recipe_reviews'] loop
    execute format(
      'create policy tenant_update on %I for update
         using (org_id = app.current_org_id() and app.member_is_owner())
         with check (org_id = app.current_org_id() and app.member_is_owner())', t);
    execute format(
      'create policy tenant_delete on %I for delete
         using (org_id = app.current_org_id() and app.member_is_owner())', t);
  end loop;
  foreach t in array array[
    'portal_recipe_versions', 'portal_read_starts', 'portal_read_runs', 'portal_captures'
  ] loop
    execute format(
      'create policy tenant_update on %I for update
         using (org_id = app.current_org_id() and app.member_may_write())
         with check (org_id = app.current_org_id() and app.member_may_write())', t);
    execute format(
      'create policy tenant_delete on %I for delete
         using (org_id = app.current_org_id() and app.member_may_write())', t);
  end loop;
end
$$;

do $$
declare
  t text;
  r text;
begin
  foreach t in array array[
    'portal_connections', 'portal_credentials', 'portal_recipe_versions',
    'portal_recipe_reviews', 'portal_read_starts', 'portal_read_runs', 'portal_captures'
  ] loop
    -- Nothing for the request roles (ADR 0037), whatever defaults a platform
    -- hands out; then exactly what the app roles hold.
    execute format('revoke all on %I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', t, r);
      end if;
    end loop;
    execute format('revoke all on %I from app_rw', t);
    execute format('revoke all on %I from app_ro', t);
    execute format('grant select on %I to app_rw', t);
    execute format('grant select on %I to app_ro', t);
  end loop;

  -- The registry's two mutable columns, and no others: an UPDATE naming any
  -- other column is refused by privilege before the freeze trigger is reached.
  grant insert on portal_connections to app_rw;
  grant update (label, enabled) on portal_connections to app_rw;

  grant insert on portal_credentials to app_rw;
  grant insert on portal_recipe_versions to app_rw;
  grant insert on portal_recipe_reviews to app_rw;
  grant insert on portal_captures to app_rw;
  -- portal_read_starts and portal_read_runs: SELECT only.

  -- A revoke answers for the app roles; the trigger answers for the owner
  -- (0004's pairing).
  foreach t in array array[
    'portal_credentials', 'portal_recipe_versions', 'portal_recipe_reviews',
    'portal_read_starts', 'portal_read_runs', 'portal_captures'
  ] loop
    execute format('drop trigger if exists no_update_delete on %I', t);
    execute format(
      'create trigger no_update_delete before update or delete on %I
         for each row execute function app.block_mutations()', t);
    execute format('drop trigger if exists no_truncate on %I', t);
    execute format(
      'create trigger no_truncate before truncate on %I
         for each statement execute function app.block_mutations()', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. app.record_portal_read_start() — the one door into portal_read_starts
-- ---------------------------------------------------------------------------
-- Definer for 0024's one reason: the run that most needs recording is the one
-- whose member may no longer write, and app.member_may_write() would refuse
-- the record of its own refusal. It escapes that check and nothing else:
--
--   * no claims, no row: it is written as a member, never as nobody;
--   * p_org_id is the caller's own org claim, and p_requested_by the caller's
--     own subject;
--   * and that subject is the connection's created_by, the member every run
--     of it acts as (§13) — so a start names the member the run acted as;
--   * the connection and the version are this org's, and the version is of
--     the connection's portal;
--   * and a run that is not a dry run runs only a promoted version in effect
--     (§3): an unpromoted or rejected version, or one whose effective date has
--     not come (UTC), may only be dry-run.
--
-- It does not ask whether the connection is on: that is the job's first
-- question, and a run refused because the connection is off still records its
-- start and a `refused` outcome, as a run whose member may no longer write does.
--
-- A call repeating a start already written, argument for argument, returns its
-- id and writes nothing, so a retried job step replays the row. Any other call
-- naming a run id already written is refused.
create or replace function app.record_portal_read_start(
  p_run_id             uuid,
  p_org_id             uuid,
  p_connection_id      uuid,
  p_recipe_version_id  uuid,
  p_dry_run            boolean,
  p_requested_by       uuid
) returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  caller_org uuid := app.current_org_id();
  caller_sub uuid := app.current_user_id();
  conn record;
  ver record;
  existing record;
  new_id uuid;
begin
  if caller_org is null or caller_sub is null then
    raise exception
      'portal read start blocked: no tenant claims are set; a run is recorded '
      'as the member it acts as, never as nobody'
      using errcode = 'insufficient_privilege';
  end if;

  if p_org_id is distinct from caller_org then
    raise exception
      'portal read start blocked: org % is not the tenant these claims are for', p_org_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_requested_by is distinct from caller_sub then
    raise exception
      'portal read start blocked: a start names the member the run acts as, and '
      'these claims are not %', p_requested_by
      using errcode = 'insufficient_privilege';
  end if;

  if p_run_id is null or p_connection_id is null or p_dry_run is null then
    raise exception
      'portal read start blocked: a run id, a connection and whether it is a dry '
      'run are all required'
      using errcode = 'null_value_not_allowed';
  end if;

  select c.org_id, c.portal_key, c.created_by into conn
    from portal_connections c where c.id = p_connection_id;
  if not found then
    raise exception 'portal read start blocked: connection % does not exist', p_connection_id
      using errcode = 'restrict_violation';
  end if;
  if conn.org_id <> p_org_id then
    raise exception 'portal read start blocked: connection % belongs to another org',
      p_connection_id
      using errcode = 'restrict_violation';
  end if;
  if conn.created_by <> caller_sub then
    raise exception
      'portal read start blocked: a run of connection % acts as the member who '
      'connected it, and these claims are not that member', p_connection_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_recipe_version_id is not null then
    select v.org_id, v.portal_key, v.effective_from,
           exists (select 1 from portal_recipe_reviews r
                    where r.recipe_version_id = v.id and r.verdict = 'promoted') as promoted
      into ver
      from portal_recipe_versions v where v.id = p_recipe_version_id;
    if not found then
      raise exception 'portal read start blocked: recipe version % does not exist',
        p_recipe_version_id
        using errcode = 'restrict_violation';
    end if;
    if ver.org_id <> p_org_id then
      raise exception 'portal read start blocked: recipe version % belongs to another org',
        p_recipe_version_id
        using errcode = 'restrict_violation';
    end if;
    if ver.portal_key <> conn.portal_key then
      raise exception
        'portal read start blocked: recipe version % is for portal %, and connection '
        '% reads portal %', p_recipe_version_id, ver.portal_key, p_connection_id, conn.portal_key
        using errcode = 'restrict_violation';
    end if;
    if not p_dry_run and not ver.promoted then
      raise exception
        'portal read start blocked: recipe version % is not promoted; a version no '
        'owner promoted may only be dry-run (ADR 0057 §3)', p_recipe_version_id
        using errcode = 'restrict_violation';
    end if;
    if not p_dry_run and ver.effective_from > (now() at time zone 'utc')::date then
      raise exception
        'portal read start blocked: recipe version % is not in effect until %',
        p_recipe_version_id, ver.effective_from
        using errcode = 'restrict_violation';
    end if;
  end if;

  insert into portal_read_starts
    (id, org_id, connection_id, recipe_version_id, dry_run, requested_by)
  values
    (p_run_id, p_org_id, p_connection_id, p_recipe_version_id, p_dry_run, p_requested_by)
  on conflict (id) do nothing
  returning id into new_id;

  if new_id is not null then
    return new_id;
  end if;

  select s.org_id, s.connection_id, s.recipe_version_id, s.dry_run, s.requested_by
    into existing
    from portal_read_starts s where s.id = p_run_id;
  if existing.org_id = p_org_id
     and existing.connection_id = p_connection_id
     and existing.recipe_version_id is not distinct from p_recipe_version_id
     and existing.dry_run = p_dry_run
     and existing.requested_by = p_requested_by then
    return p_run_id;
  end if;

  raise exception
    'portal read start blocked: run % is already recorded with other arguments; '
    'a run id names one start', p_run_id
    using errcode = 'unique_violation';
end
$$;

comment on function app.record_portal_read_start(uuid, uuid, uuid, uuid, boolean, uuid) is
  'The only way a portal_read_starts row is written (ADR 0057 §13). Definer so '
  'that a run refused because its member may no longer write can still record '
  'its start; bounded to the caller''s own org claim and subject, which must be '
  'the connection''s created_by. The version is this org''s and of the '
  'connection''s portal, and a run that is not a dry run runs only a promoted '
  'version in effect. A replay of the same start returns its id and writes '
  'nothing; any other second call is refused.';

revoke all on function app.record_portal_read_start(uuid, uuid, uuid, uuid, boolean, uuid)
  from public;
grant execute on function app.record_portal_read_start(uuid, uuid, uuid, uuid, boolean, uuid)
  to app_rw;

-- ---------------------------------------------------------------------------
-- 10. app.record_portal_read_run() — the one door into portal_read_runs
-- ---------------------------------------------------------------------------
-- The start's twin. Bounded the same way — the caller's own org claim, and
-- the caller is the member its start names — and escaping
-- app.member_may_write() and nothing else. What a row may say is the table's
-- CHECK constraints: the outcome, the reason it takes, the class name it
-- carries, and a step log of names and pass or fail. One more, from the
-- start: a dry run captures nothing, so it records no capture.
--
-- One outcome per run. A call repeating the outcome already written, argument
-- for argument, returns its id and writes nothing; any other is refused.
create or replace function app.record_portal_read_run(
  p_run_id              uuid,
  p_org_id              uuid,
  p_outcome             text,
  p_reason              text,
  p_error_class         text,
  p_at_step             text,
  p_page_count          integer,
  p_capture_count       integer,
  p_new_document_count  integer,
  p_deduplicated_count  integer,
  p_refusal_count       integer,
  p_step_log            jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  caller_org uuid := app.current_org_id();
  caller_sub uuid := app.current_user_id();
  start_row record;
  existing record;
  new_id uuid;
begin
  if caller_org is null or caller_sub is null then
    raise exception
      'portal read run blocked: no tenant claims are set; an outcome is recorded '
      'as the member its run acted as, never as nobody'
      using errcode = 'insufficient_privilege';
  end if;

  if p_org_id is distinct from caller_org then
    raise exception
      'portal read run blocked: org % is not the tenant these claims are for', p_org_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_run_id is null then
    raise exception 'portal read run blocked: a run id is required'
      using errcode = 'null_value_not_allowed';
  end if;

  select s.org_id, s.requested_by, s.dry_run into start_row
    from portal_read_starts s where s.id = p_run_id;
  if not found then
    raise exception
      'portal read run blocked: run % has no start row; a start is written before '
      'the worker is called', p_run_id
      using errcode = 'restrict_violation';
  end if;
  if start_row.org_id <> p_org_id then
    raise exception 'portal read run blocked: run % belongs to another org', p_run_id
      using errcode = 'restrict_violation';
  end if;
  if start_row.requested_by <> caller_sub then
    raise exception
      'portal read run blocked: an outcome is recorded as the member run % acted '
      'as, and these claims are not that member', p_run_id
      using errcode = 'insufficient_privilege';
  end if;

  if start_row.dry_run
     and (p_capture_count <> 0 or p_new_document_count <> 0 or p_deduplicated_count <> 0) then
    raise exception
      'portal read run blocked: run % is a dry run, and a dry run captures nothing '
      '(ADR 0057 §3)', p_run_id
      using errcode = 'check_violation';
  end if;

  insert into portal_read_runs
    (org_id, run_id, outcome, reason, error_class, at_step, page_count, capture_count,
     new_document_count, deduplicated_count, refusal_count, step_log)
  values
    (p_org_id, p_run_id, p_outcome, p_reason, p_error_class, p_at_step, p_page_count,
     p_capture_count, p_new_document_count, p_deduplicated_count, p_refusal_count,
     p_step_log)
  on conflict (run_id) do nothing
  returning id into new_id;

  if new_id is not null then
    return new_id;
  end if;

  select r.id, r.outcome, r.reason, r.error_class, r.at_step, r.page_count,
         r.capture_count, r.new_document_count, r.deduplicated_count,
         r.refusal_count, r.step_log
    into existing
    from portal_read_runs r where r.run_id = p_run_id;
  if existing.outcome = p_outcome
     and existing.reason is not distinct from p_reason
     and existing.error_class is not distinct from p_error_class
     and existing.at_step is not distinct from p_at_step
     and existing.page_count = p_page_count
     and existing.capture_count = p_capture_count
     and existing.new_document_count = p_new_document_count
     and existing.deduplicated_count = p_deduplicated_count
     and existing.refusal_count = p_refusal_count
     and existing.step_log = p_step_log then
    return existing.id;
  end if;

  raise exception
    'portal read run blocked: run % already has an outcome, and it is not this '
    'one; a run ends once', p_run_id
    using errcode = 'unique_violation';
end
$$;

comment on function app.record_portal_read_run(uuid, uuid, text, text, text, text,
  integer, integer, integer, integer, integer, jsonb) is
  'The only way a portal_read_runs row is written (ADR 0057 §13): once per run, '
  'complete, as the member its start names and within the caller''s own org '
  'claim. Definer so that a refused run still records its outcome. A dry run '
  'records no capture. A replay of the same outcome returns its id and writes '
  'nothing; any other second call is refused.';

revoke all on function app.record_portal_read_run(uuid, uuid, text, text, text, text,
  integer, integer, integer, integer, integer, jsonb) from public;
grant execute on function app.record_portal_read_run(uuid, uuid, text, text, text, text,
  integer, integer, integer, integer, integer, jsonb) to app_rw;

-- ---------------------------------------------------------------------------
-- 11. app.portal_connections_to_read() — ids, across every org, for the fan-out
-- ---------------------------------------------------------------------------
-- 0024's and 0033's lister, for portals: the fan-out has no tenant, because
-- this is the query that decides which tenants it adopts. It hands back ids and
-- the portal key, never an account id, a label or a parameter, and it is
-- refused to any caller carrying an org_id or a sub (ADR 0045): those read
-- portal_connections through RLS.
create or replace function app.portal_connections_to_read()
  returns table (connection_id uuid, org_id uuid, portal_key text, created_by uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public, extensions
as $$
begin
  if app.current_org_id() is not null or app.current_user_id() is not null then
    raise exception
      'portal_connections_to_read is the untenanted fan-out query and takes no '
      'claims: a caller acting for a tenant or a subject must read '
      'portal_connections through RLS instead'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select c.id, c.org_id, c.portal_key, c.created_by
      from portal_connections c
     where c.enabled
     order by c.org_id, c.id;
end
$$;

comment on function app.portal_connections_to_read() is
  'Every enabled portal connection, as ids and its portal key, across every org '
  '— for the fan-out, which has no tenant because it decides which tenants to '
  'adopt (ADR 0057 §13). Refused to any caller carrying a claim, an org_id or a '
  'sub (ADR 0045): those read the table through RLS.';

revoke all on function app.portal_connections_to_read() from public;
grant execute on function app.portal_connections_to_read() to app_rw;

-- ---------------------------------------------------------------------------
-- 12. The end state, re-read. Abort, do not warn.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  r text;
  c text;
  f text;
  priv text;
  append_only constant text[] := array[
    'portal_credentials', 'portal_recipe_versions', 'portal_recipe_reviews',
    'portal_read_starts', 'portal_read_runs', 'portal_captures'];
  every_table constant text[] := array['portal_connections'] || append_only;
  definers constant text[] := array[
    'app.record_portal_read_start(uuid, uuid, uuid, uuid, boolean, uuid)',
    'app.record_portal_read_run(uuid, uuid, text, text, text, text, integer, integer, integer, '
      'integer, integer, jsonb)',
    'app.portal_connections_to_read()'];
  invokers constant text[] := array[
    'app.portal_run_params_are_valid(jsonb)',
    'app.portal_sign_in_paths_are_canonical(text[])',
    'app.portal_step_log_is_valid(jsonb)',
    'app.portal_recipe_additions_are_valid(jsonb)',
    'app.portal_row_names_its_author()',
    'app.touch_portal_connection()',
    'app.portal_review_is_consistent()',
    'app.portal_capture_is_consistent()'];
begin
  foreach t in array every_table loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      raise exception '0038: RLS is off on %', t;
    end if;
    if (select count(*) from pg_policy
         where polrelid = t::regclass
           and polname in ('tenant_read', 'tenant_insert', 'tenant_update', 'tenant_delete')) <> 4 then
      raise exception '0038: % lacks one of its four policies', t;
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                    'REFERENCES', 'TRIGGER'] loop
          if has_table_privilege(r, t, priv)
             or (priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                 and has_any_column_privilege(r, t, priv)) then
            raise exception '0038: request role % holds % on %', r, priv, t;
          end if;
        end loop;
      end if;
    end loop;
    if not has_table_privilege('app_rw', t, 'SELECT')
       or not has_table_privilege('app_ro', t, 'SELECT') then
      raise exception '0038: the app roles cannot read %', t;
    end if;
    if has_table_privilege('app_rw', t, 'DELETE') or has_table_privilege('app_rw', t, 'TRUNCATE')
       or has_table_privilege('app_ro', t, 'DELETE') or has_table_privilege('app_ro', t, 'TRUNCATE')
       or has_any_column_privilege('app_ro', t, 'INSERT')
       or has_any_column_privilege('app_ro', t, 'UPDATE') then
      raise exception '0038: an app role holds a write it must not on %', t;
    end if;
  end loop;

  foreach t in array append_only loop
    if (select count(*) from pg_trigger
         where tgrelid = t::regclass and tgname in ('no_update_delete', 'no_truncate')
           and tgfoid = 'app.block_mutations'::regproc) <> 2 then
      raise exception '0038: % is missing an append-only trigger', t;
    end if;
    if has_any_column_privilege('app_rw', t, 'UPDATE') then
      raise exception '0038: app_rw holds UPDATE on append-only %', t;
    end if;
    if t in ('portal_read_starts', 'portal_read_runs') then
      if has_any_column_privilege('app_rw', t, 'INSERT') then
        raise exception '0038: app_rw holds INSERT on %, which only its definer function writes', t;
      end if;
    elsif not has_table_privilege('app_rw', t, 'INSERT') then
      raise exception '0038: app_rw cannot insert into %', t;
    end if;
  end loop;

  -- The registry: INSERT, and UPDATE on exactly its two mutable columns.
  if not has_table_privilege('app_rw', 'portal_connections', 'INSERT') then
    raise exception '0038: app_rw cannot insert into portal_connections';
  end if;
  for c in
    select a.attname::text from pg_attribute a
     where a.attrelid = 'portal_connections'::regclass and a.attnum > 0 and not a.attisdropped
  loop
    if has_column_privilege('app_rw', 'portal_connections', c, 'UPDATE')
       is distinct from (c in ('label', 'enabled')) then
      raise exception '0038: app_rw''s UPDATE on portal_connections.% is wrong', c;
    end if;
  end loop;
  if exists (select 1 from pg_trigger
              where tgrelid = 'portal_connections'::regclass
                and tgfoid = 'app.block_mutations'::regproc) then
    raise exception '0038: portal_connections is not append-only: enabled flips';
  end if;

  -- The rules a trigger keeps: authors, the freeze, and what a review and a
  -- capture must agree with.
  if (select count(*) from pg_trigger tg
       where tg.tgname = 'names_its_author'
         and tg.tgfoid = 'app.portal_row_names_its_author'::regproc
         and tg.tgrelid in ('portal_connections'::regclass, 'portal_credentials'::regclass,
                            'portal_recipe_versions'::regclass, 'portal_recipe_reviews'::regclass,
                            'portal_read_starts'::regclass)) <> 5 then
    raise exception '0038: an author column is not held to the caller on every table that has one';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'touch_portal_connection' and tgrelid = 'portal_connections'::regclass
                    and tgfoid = 'app.touch_portal_connection'::regproc)
     or not exists (select 1 from pg_trigger
                     where tgname = 'review_is_consistent'
                       and tgrelid = 'portal_recipe_reviews'::regclass
                       and tgfoid = 'app.portal_review_is_consistent'::regproc)
     or not exists (select 1 from pg_trigger
                     where tgname = 'capture_is_consistent' and tgrelid = 'portal_captures'::regclass
                       and tgfoid = 'app.portal_capture_is_consistent'::regproc) then
    raise exception '0038: the freeze, review or capture trigger is missing';
  end if;

  foreach f in array definers || invokers loop
    if not coalesce((select proconfig @> array['search_path=pg_catalog, public, extensions']
                       from pg_proc where oid = f::regprocedure), false) then
      raise exception '0038: % does not pin its search_path', f;
    end if;
    if (select prosecdef from pg_proc where oid = f::regprocedure)
       is distinct from (f = any (definers)) then
      raise exception '0038: % has the wrong security', f;
    end if;
    if has_function_privilege('public', f, 'EXECUTE') then
      raise exception '0038: PUBLIC may execute %', f;
    end if;
  end loop;
  foreach f in array definers loop
    if not has_function_privilege('app_rw', f, 'EXECUTE')
       or has_function_privilege('app_ro', f, 'EXECUTE') then
      raise exception '0038: % must be executable by app_rw alone', f;
    end if;
  end loop;

  if not exists (
    select 1 from pg_index i
     where i.indexrelid = 'portal_connections_one_enabled_per_account'::regclass
       and i.indisunique and i.indpred is not null
  ) then
    raise exception '0038: portal_connections_one_enabled_per_account is not a partial unique index';
  end if;
  foreach c in array array['portal_recipe_versions_one_per_number',
                           'portal_recipe_reviews_one_per_version',
                           'portal_read_runs_one_per_run'] loop
    if not exists (select 1 from pg_constraint where conname = c and contype = 'u') then
      raise exception '0038: the unique constraint % is missing', c;
    end if;
  end loop;
end
$$;
