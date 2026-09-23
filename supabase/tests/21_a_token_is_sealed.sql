\echo '-- 21 a token is sealed: the credential table holds ciphertext, is append-only, and is one tenant''s'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid;
  b jsonb; org_b uuid; analyst_b uuid;
  reader uuid; owner_a uuid; owner_b uuid;
  conn_a uuid; conn_b uuid;
  cred_1 uuid; cred_2 uuid; latest uuid;
  n int; plaintextish int; missing text; extra text;
  expected text[] := array[
    'id', 'seq', 'org_id', 'connection_id', 'cipher', 'key_id', 'wrapped_key',
    'ciphertext', 'access_expires_at', 'refresh_expires_at', 'created_by', 'created_at'
  ];
  found text[];
begin
  a := test.seed_org('sealeda');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid;
  b := test.seed_org('sealedb');
  org_b := (b->>'org')::uuid; analyst_b := (b->>'analyst')::uuid;

  insert into users (email, full_name) values ('sealed-reader@example.test', 'Reader')
    returning id into reader;
  insert into memberships (org_id, user_id, role) values (org_a, reader, 'read_only');

  -- Only an owner connects a ledger (ADR 0039 §8); any writer stores a rotation.
  insert into users (email, full_name) values ('sealed-owner-a@example.test', 'Owner A')
    returning id into owner_a;
  insert into users (email, full_name) values ('sealed-owner-b@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role)
    values (org_a, owner_a, 'owner'), (org_b, owner_b, 'owner');

  -- =========================================================================
  -- The column list, against the catalogue, in both directions
  -- =========================================================================
  -- The point of asking the catalogue rather than a hand-written list of bad
  -- names: `%token%` would catch `refresh_token` and miss `oauth_blob`. Set
  -- equality catches every column that was not deliberately put here, so a
  -- later migration that adds one fails on the day it is written — the shape
  -- `packages/store-postgres/test/doc-types.test.ts` uses for DOC_TYPES.
  select array_agg(column_name order by column_name) into found
    from information_schema.columns
   where table_schema = 'public' and table_name = 'accounting_credentials';

  select string_agg(c, ', ') into missing
    from unnest(expected) c where c <> all(coalesce(found, array[]::text[]));
  select string_agg(c, ', ') into extra
    from unnest(coalesce(found, array[]::text[])) c where c <> all(expected);

  perform test.ok(missing is null,
    format('accounting_credentials has every column this migration named (missing: %s)', missing));
  perform test.ok(extra is null,
    format('and no column nobody decided on (unexpected: %s)', extra));

  -- The named check as well, because it says *why* in the failure message: a
  -- column called `refresh_token` is not a naming slip, it is the invariant.
  select count(*) into plaintextish
    from information_schema.columns
   where table_schema = 'public' and table_name = 'accounting_credentials'
     and (column_name in ('access_token', 'refresh_token', 'client_secret', 'password',
                          'plaintext', 'secret', 'token')
          or column_name ilike '%plaintext%');
  perform test.ok(plaintextish = 0,
    format('accounting_credentials carries no plaintext credential column (%s found)', plaintextish));

  -- =========================================================================
  -- A credential belongs to its connection's tenant, and the database says so
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_a, owner_a);

  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_a, 'qbo', 'realm-sealed-a', owner_a) returning id into conn_a;

  perform test.as_member(org_b, owner_b);
  insert into accounting_connections (org_id, provider, provider_account_id, created_by)
    values (org_b, 'qbo', 'realm-sealed-b', owner_b) returning id into conn_b;

  perform test.as_member(org_a, analyst_a);

  insert into accounting_credentials
    (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
     access_expires_at, refresh_expires_at, created_by)
    values (org_a, conn_a, 'aws-kms+aes-256-gcm', 'arn:aws:kms:us-east-1:1:key/k',
            'd3JhcHBlZA==', 'c2VhbGVk', now() + interval '1 hour',
            now() + interval '100 days', analyst_a)
    returning id into cred_1;
  perform test.ok(cred_1 is not null, 'a writer may store a sealed credential for their own org');

  -- The tenancy tie is a composite foreign key, so this is refused whatever the
  -- policy says — a ciphertext hung off another tenant's connection would be a
  -- row decrypted under the wrong encryption context (ADR 0033 §2).
  perform test.expect_error(
    format('insert into accounting_credentials
              (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
               refresh_expires_at, created_by)
            values (%L, %L, ''c'', ''k'', ''dw=='', ''cw=='', now() + interval ''1 day'', %L)',
           org_a, conn_b, analyst_a),
    'foreign key', 'a credential cannot point at another tenant''s connection');

  perform test.expect_error(
    format('insert into accounting_credentials
              (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
               refresh_expires_at, created_by)
            values (%L, %L, ''c'', ''k'', ''dw=='', ''cw=='', now() + interval ''1 day'', %L)',
           org_b, conn_b, analyst_a),
    'policy', 'and cannot be written for another org at all');

  -- Nothing blank stands in for a cipher or a key: a row that cannot say which
  -- key opens it is a row nobody can open.
  perform test.expect_error(
    format('insert into accounting_credentials
              (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
               refresh_expires_at, created_by)
            values (%L, %L, ''   '', ''k'', ''dw=='', ''cw=='', now() + interval ''1 day'', %L)',
           org_a, conn_a, analyst_a),
    'check', 'a blank cipher name is refused');
  perform test.expect_error(
    format('insert into accounting_credentials
              (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
               refresh_expires_at, created_by)
            values (%L, %L, ''c'', ''  '', ''dw=='', ''cw=='', now() + interval ''1 day'', %L)',
           org_a, conn_a, analyst_a),
    'check', 'and so is a blank key id');

  -- A refresh expiry is not optional: a token nobody can tell is dying is a
  -- connection that strands without warning.
  perform test.expect_error(
    format('insert into accounting_credentials
              (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext, created_by)
            values (%L, %L, ''c'', ''k'', ''dw=='', ''cw=='', %L)',
           org_a, conn_a, analyst_a),
    'null', 'and a credential with no refresh expiry');

  -- =========================================================================
  -- A read_only member may read nothing into existence
  -- =========================================================================
  perform test.as_member(org_a, reader);
  perform test.expect_error(
    format('insert into accounting_credentials
              (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
               refresh_expires_at, created_by)
            values (%L, %L, ''c'', ''k'', ''dw=='', ''cw=='', now() + interval ''1 day'', %L)',
           org_a, conn_a, reader),
    'policy', 'a read_only member cannot store a credential');
  perform test.as_member(org_a, analyst_a);

  -- =========================================================================
  -- A rotation is a new row, and the old row is still there
  -- =========================================================================
  insert into accounting_credentials
    (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
     access_expires_at, refresh_expires_at, created_by)
    values (org_a, conn_a, 'aws-kms+aes-256-gcm', 'arn:aws:kms:us-east-1:1:key/k',
            'd3JhcHBlZDI=', 'c2VhbGVkMg==', now() + interval '1 hour',
            now() + interval '100 days', analyst_a)
    returning id into cred_2;

  select count(*) into n from accounting_credentials where connection_id = conn_a;
  perform test.ok(n = 2, format('a rotation leaves both rows (saw %s)', n));

  -- Which one is current is `seq`, not `created_at`: now() is fixed for a
  -- transaction, so these two rows share a timestamp and an ordering by it
  -- would be whatever the planner felt like (ADR 0033 §2).
  select id into latest from accounting_credentials
   where connection_id = conn_a order by seq desc limit 1;
  perform test.ok(latest = cred_2,
    'and the latest row by seq is the one written last, though both share created_at');
  perform test.ok(
    (select created_at from accounting_credentials where id = cred_1)
      = (select created_at from accounting_credentials where id = cred_2),
    'which is exactly the tie seq exists to break');

  -- =========================================================================
  -- Append-only, in both layers (0004's pattern, suite 01's shape)
  -- =========================================================================
  perform test.ok(not has_table_privilege('app_rw', 'accounting_credentials', 'UPDATE'),
    'app_rw holds no UPDATE on accounting_credentials');
  perform test.ok(not has_table_privilege('app_rw', 'accounting_credentials', 'DELETE'),
    'nor DELETE');
  perform test.ok(has_table_privilege('app_rw', 'accounting_credentials', 'INSERT'),
    'it may write a rotation');
  perform test.ok(has_table_privilege('app_rw', 'accounting_credentials', 'SELECT'),
    'and read the latest row back');

  perform test.expect_error(
    format('update accounting_credentials set ciphertext = ''b3RoZXI='' where id = %L', cred_2),
    'denied', 'an update is refused for app_rw');
  perform test.expect_error(
    format('delete from accounting_credentials where id = %L', cred_1),
    'denied', 'and a delete');
  perform test.expect_error(
    'truncate accounting_credentials', 'denied', 'and a truncate');

  -- And the trigger, which is what answers for the owner — the role migrations
  -- run as, the role a Supabase SQL-editor session runs as, and anybody with
  -- the database password.
  reset role;
  perform test.expect_error(
    format('update accounting_credentials set ciphertext = ''b3RoZXI='' where id = %L', cred_2),
    'append-only', 'the trigger refuses the owner too');
  perform test.expect_error(
    format('delete from accounting_credentials where id = %L', cred_1),
    'append-only', 'for a delete as well');
  perform test.expect_error(
    'truncate accounting_credentials', 'append-only', 'and a truncate');

  -- =========================================================================
  -- RLS isolation: a tenant's ciphertext is a tenant's
  -- =========================================================================
  set role app_rw;
  perform test.as_member(org_b, analyst_b);
  select count(*) into n from accounting_credentials;
  perform test.ok(n = 0, format('org B sees none of org A''s credentials (saw %s)', n));

  perform test.as_member(org_a, analyst_a);
  select count(*) into n from accounting_credentials;
  perform test.ok(n = 2, format('and org A sees both of its own (saw %s)', n));

  perform test.as_nobody();
  select count(*) into n from accounting_credentials;
  perform test.ok(n = 0, format('a caller with no claims sees nothing (saw %s)', n));

  -- =========================================================================
  -- The registry is still what ADR 0031 §1 made it
  -- =========================================================================
  -- This migration adds a unique constraint to accounting_connections and
  -- nothing else. It must not have quietly made that table append-only (its
  -- `enabled` flips) nor added a credential column to it.
  perform test.as_member(org_a, owner_a);
  update accounting_connections set enabled = false where id = conn_a;
  perform test.ok(
    (select not enabled from accounting_connections where id = conn_a),
    'a connection can still be disabled: the registry is deliberately not append-only');
  update accounting_connections set enabled = true where id = conn_a;

  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'accounting_connections'
     and (column_name ilike '%token%' or column_name ilike '%secret%'
          or column_name ilike '%credential%' or column_name ilike '%refresh%'
          or column_name ilike '%password%');
  perform test.ok(n = 0,
    format('and still carries no credential column of its own (%s found)', n));

  perform test.ok(
    exists (
      select 1 from pg_constraint
       where conrelid = 'accounting_connections'::regclass
         and conname = 'accounting_connections_org_id_id_key'
    ),
    'the (org_id, id) unique that the credential table keys on is there');

  reset role;
end
$test$;
rollback;
