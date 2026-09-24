\echo '-- 30 an email reaches a tenant only through an address it was given (ADR 0047)'
begin;
do $test$
declare
  a jsonb; org_a uuid; analyst_a uuid; approver_a uuid; owner_a uuid; owner2_a uuid; reader_a uuid;
  b jsonb; org_b uuid; owner_b uuid;
  addr_a uuid; token_a text; addr_a2 uuid; token_a2 text; addr_b uuid; token_b text;
  upload_email uuid; upload_body uuid; upload_web uuid;
  doc_email uuid; doc_body uuid; doc_web uuid; doc_b uuid;
  msg uuid; msg_again uuid;
  r record;
  n int;
  t text;
  fn record;
begin
  a := test.seed_org('inbounda');
  org_a := (a->>'org')::uuid; analyst_a := (a->>'analyst')::uuid; approver_a := (a->>'approver')::uuid;
  b := test.seed_org('inboundb');
  org_b := (b->>'org')::uuid;

  insert into users (email, full_name) values ('inbounda-owner@example.test', 'Owner')
    returning id into owner_a;
  insert into users (email, full_name) values ('inbounda-owner2@example.test', 'Second owner')
    returning id into owner2_a;
  insert into users (email, full_name) values ('inbounda-reader@example.test', 'Reader')
    returning id into reader_a;
  insert into users (email, full_name) values ('inboundb-owner@example.test', 'Owner B')
    returning id into owner_b;
  insert into memberships (org_id, user_id, role) values
    (org_a, owner_a, 'owner'), (org_a, owner2_a, 'owner'), (org_a, reader_a, 'read_only'),
    (org_b, owner_b, 'owner');

  -- Three documents in A, one per door, and one in B. Written as the table
  -- owner: how a document is stored is ingest's question, not this suite's.
  insert into uploads (org_id, source) values (org_a, 'email_in') returning id into upload_email;
  insert into uploads (org_id, source) values (org_a, 'email_body') returning id into upload_body;
  insert into uploads (org_id, source, created_by) values (org_a, 'web_upload', analyst_a)
    returning id into upload_web;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org_a, upload_email, digest('inbound-attachment', 'sha256'), 10, 'application/pdf', 'x/1')
    returning id into doc_email;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org_a, upload_body, digest('inbound-body', 'sha256'), 10, 'text/plain', 'x/2')
    returning id into doc_body;
  insert into documents (org_id, upload_id, sha256, byte_size, mime_type, storage_ref)
    values (org_a, upload_web, digest('inbound-web', 'sha256'), 10, 'application/pdf', 'x/3')
    returning id into doc_web;
  insert into documents (org_id, sha256, byte_size, mime_type, storage_ref)
    values (org_b, digest('inbound-b', 'sha256'), 10, 'application/pdf', 'x/4')
    returning id into doc_b;

  -- =========================================================================
  -- The shape, from the catalogue
  -- =========================================================================
  foreach t in array array[
    'inbound_addresses', 'inbound_address_adoptions', 'inbound_address_retirements',
    'inbound_messages', 'inbound_message_parts'
  ] loop
    perform test.ok(
      (select relrowsecurity from pg_class where oid = t::regclass),
      format('%s has RLS on', t));
    perform test.ok(
      exists (select 1 from pg_trigger where tgrelid = t::regclass and tgname = 'no_update_delete'),
      format('%s carries no_update_delete', t));
    perform test.ok(
      exists (select 1 from pg_trigger where tgrelid = t::regclass and tgname = 'no_truncate'),
      format('%s carries no_truncate', t));
    perform test.ok(has_table_privilege('app_rw', t, 'select'), format('app_rw may read %s', t));
    perform test.ok(has_table_privilege('app_ro', t, 'select'), format('app_ro may read %s', t));
    perform test.ok(not has_table_privilege('app_ro', t, 'insert'), format('app_ro may not write %s', t));
    perform test.ok(
      not has_table_privilege('app_rw', t, 'update') and not has_table_privilege('app_rw', t, 'delete')
        and not has_table_privilege('app_rw', t, 'truncate'),
      format('app_rw holds no UPDATE, DELETE or TRUNCATE on %s', t));
    if t like 'inbound_address%' then
      perform test.ok(has_table_privilege('app_rw', t, 'insert'), format('app_rw may insert into %s', t));
    else
      perform test.ok(not has_table_privilege('app_rw', t, 'insert'),
        format('app_rw may not insert into %s: the record door is the only way in', t));
    end if;
  end loop;

  for fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig, l.lanname
      from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where s.nspname = 'app' and p.proname in ('inbound_address_for', 'record_inbound_message')
  loop
    perform test.ok(fn.prosecdef, format('app.%s is security definer', fn.proname));
    perform test.ok(
      coalesce(fn.proconfig @> array['search_path=pg_catalog, public, extensions'], false),
      format('app.%s pins its search_path', fn.proname));
    perform test.ok(fn.lanname = 'plpgsql', format('app.%s is plpgsql', fn.proname));
    perform test.ok(not has_function_privilege('public', fn.oid, 'execute'),
      format('PUBLIC may not execute app.%s', fn.proname));
    perform test.ok(has_function_privilege('app_rw', fn.oid, 'execute'),
      format('app_rw may execute app.%s', fn.proname));
    perform test.ok(not has_function_privilege('app_ro', fn.oid, 'execute'),
      format('app_ro may not execute app.%s', fn.proname));
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.proname in ('inbound_address_for', 'record_inbound_message');
  perform test.ok(n = 2, format('exactly one of each function (saw %s)', n));

  set role app_rw;

  -- =========================================================================
  -- Issuing: an owner, as themselves, and never a chosen token
  -- =========================================================================
  perform test.as_member(org_a, owner_a);
  insert into inbound_addresses (org_id, created_by) values (org_a, owner_a)
    returning id, token into addr_a, token_a;
  perform test.ok(token_a ~ '^[0-9a-f]{32}$',
    format('the database generated a 32-hex token (%s chars)', length(token_a)));
  insert into inbound_addresses (org_id, created_by) values (org_a, owner_a)
    returning id, token into addr_a2, token_a2;
  perform test.ok(token_a2 <> token_a, 'a second address gets a different token');

  perform test.expect_error(
    format('insert into inbound_addresses (org_id, token, created_by) values (%L, %L, %L)',
           org_a, repeat('a', 32), owner_a),
    'never chosen', 'a token the caller supplies is refused');
  perform test.expect_error(
    format('insert into inbound_addresses (org_id, created_by) values (%L, %L)', org_a, owner2_a),
    'row-level security', 'an owner may not issue in another member''s name');

  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    format('insert into inbound_addresses (org_id, created_by) values (%L, %L)', org_a, analyst_a),
    'row-level security', 'an analyst may not issue an address');
  perform test.as_member(org_a, approver_a);
  perform test.expect_error(
    format('insert into inbound_addresses (org_id, created_by) values (%L, %L)', org_a, approver_a),
    'row-level security', 'an approver may not issue an address');
  perform test.as_member(org_a, reader_a);
  perform test.expect_error(
    format('insert into inbound_addresses (org_id, created_by) values (%L, %L)', org_a, reader_a),
    'row-level security', 'a read_only member may not issue an address');

  perform test.as_member(org_b, owner_b);
  insert into inbound_addresses (org_id, created_by) values (org_b, owner_b)
    returning id, token into addr_b, token_b;
  select count(*) into n from inbound_addresses;
  perform test.ok(n = 1, format('B''s owner sees B''s address and not A''s (saw %s)', n));

  -- =========================================================================
  -- Adopting and retiring: owner-only, as oneself, within the tenant
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    format('insert into inbound_address_adoptions (org_id, address_id, adopted_by) values (%L, %L, %L)',
           org_a, addr_a, analyst_a),
    'row-level security', 'an analyst may not adopt an address');
  perform test.expect_error(
    format('insert into inbound_address_retirements (org_id, address_id, retired_by) values (%L, %L, %L)',
           org_a, addr_a2, analyst_a),
    'row-level security', 'an analyst may not retire an address');

  perform test.as_member(org_a, owner2_a);
  insert into inbound_address_adoptions (org_id, address_id, adopted_by)
    values (org_a, addr_a, owner2_a);
  perform test.expect_error(
    format('insert into inbound_address_adoptions (org_id, address_id, adopted_by) values (%L, %L, %L)',
           org_a, addr_b, owner2_a),
    'foreign key', 'an adoption cannot name another tenant''s address');
  perform test.expect_error(
    format('insert into inbound_address_retirements (org_id, address_id, retired_by) values (%L, %L, %L)',
           org_a, addr_b, owner2_a),
    'foreign key', 'a retirement cannot name another tenant''s address');

  perform test.as_member(org_a, owner_a);
  insert into inbound_address_retirements (org_id, address_id, retired_by)
    values (org_a, addr_a2, owner_a);
  perform test.expect_error(
    format('insert into inbound_address_retirements (org_id, address_id, retired_by) values (%L, %L, %L)',
           org_a, addr_a2, owner_a),
    'duplicate', 'an address is retired once');
  perform test.expect_error(
    format('insert into inbound_address_adoptions (org_id, address_id, adopted_by) values (%L, %L, %L)',
           org_a, addr_a2, owner_a),
    'row-level security', 'a retired address cannot be adopted');

  -- A retired token is never issued again: uniqueness covers retired rows.
  reset role;
  perform test.expect_error(
    format('insert into inbound_addresses (id, org_id, token, created_by) select gen_random_uuid(), %L, token, %L from inbound_addresses where id = %L',
           org_b, owner_b, addr_a2),
    'never chosen', 'even the table owner cannot copy a retired token into a new address');
  set role app_rw;

  -- =========================================================================
  -- The lookup: no claims, one token, the right member
  -- =========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', owner_a::text)::text, true);
  perform test.expect_error(
    format('select * from app.inbound_address_for(%L)', token_a),
    'untenanted', 'the lookup is refused to a subject with no org');
  perform set_config('request.jwt.claims', json_build_object('org_id', org_a::text)::text, true);
  perform test.expect_error(
    format('select * from app.inbound_address_for(%L)', token_a),
    'untenanted', 'the lookup is refused to an org with no subject');
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format('select * from app.inbound_address_for(%L)', token_a),
    'untenanted', 'the lookup is refused to a member acting for a tenant');

  perform set_config('request.jwt.claims', '', true);
  select * into r from app.inbound_address_for(token_a);
  perform test.ok(r.address_id = addr_a and r.org_id = org_a and not r.retired,
    'a live token resolves to its address and tenant');
  perform test.ok(r.acting_member = owner2_a,
    'and acts as its latest adopter, not its issuer');
  select * into r from app.inbound_address_for(token_a2);
  perform test.ok(r.retired and r.acting_member = owner_a,
    'a retired token answers retired, as its retirer');
  select * into r from app.inbound_address_for(token_b);
  perform test.ok(r.org_id = org_b and r.acting_member = owner_b,
    'B''s token answers with B and B''s issuer, never A');
  select count(*) into n from app.inbound_address_for(repeat('0', 32));
  perform test.ok(n = 0, 'an unknown token returns nothing');
  select count(*) into n from app.inbound_address_for('%');
  perform test.ok(n = 0, 'a pattern matches nothing');
  select count(*) into n from app.inbound_address_for(upper(token_a));
  perform test.ok(n = 0, 'a token is compared whole and exactly');

  -- =========================================================================
  -- The record door
  -- =========================================================================
  perform test.as_member(org_a, analyst_a);
  perform test.expect_error(
    format('insert into inbound_messages (org_id, address_id, provider, provider_message_id, outcome, acted_as) values (%L, %L, ''postmark'', ''m-direct'', ''not_received'', %L)',
           org_a, addr_a, analyst_a),
    'permission denied', 'a writer cannot insert a message row directly');

  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', true, 'dkim', 'pass', 'dmarc', 'unknown',
        'spf', 'pass', 'verdict_source', 'postmark_spamassassin')),
    'acts as', 'a member who is not the address''s acting member is refused');

  perform test.as_member(org_a, owner2_a);
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_b, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', true, 'dkim', 'pass', 'dmarc', 'unknown',
        'spf', 'pass', 'verdict_source', 'postmark_spamassassin')),
    'not this tenant', 'another tenant''s address is refused');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', true, 'dkim', 'pass', 'dmarc', 'unknown',
        'spf', 'pass', 'verdict_source', 'somebody_else')),
    'check constraint', 'a verdict source outside the closed list is refused');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', true, 'dkim', 'fail', 'dmarc', 'unknown',
        'spf', 'pass', 'verdict_source', 'postmark_spamassassin')),
    'check constraint', '"authenticated" cannot disagree with the DKIM verdict');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, %L::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', false, 'dkim', 'none', 'dmarc', 'unknown',
        'spf', 'none', 'verdict_source', 'postmark_spamassassin'),
      jsonb_build_array(jsonb_build_object('ordinal', 0, 'kind', 'attachment',
        'outcome', 'stored', 'document_id', doc_web))),
    'did not arrive by email', 'a stored part whose document was uploaded is refused');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, %L::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', false, 'dkim', 'none', 'dmarc', 'unknown',
        'spf', 'none', 'verdict_source', 'postmark_spamassassin'),
      jsonb_build_array(jsonb_build_object('ordinal', 0, 'kind', 'attachment',
        'outcome', 'already_held', 'document_id', doc_b))),
    'foreign key', 'a part cannot name another tenant''s document');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, %L::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', false, 'dkim', 'none', 'dmarc', 'unknown',
        'spf', 'none', 'verdict_source', 'postmark_spamassassin'),
      jsonb_build_array(jsonb_build_object('ordinal', 0, 'kind', 'attachment',
        'outcome', 'inline_image', 'document_id', doc_email))),
    'check constraint', 'a part names a document exactly when one was stored');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, %L::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
        'outcome', 'received', 'authenticated', false, 'dkim', 'none', 'dmarc', 'unknown',
        'spf', 'none', 'verdict_source', 'postmark_spamassassin'),
      jsonb_build_array(jsonb_build_object('ordinal', 0, 'kind', 'attachment',
        'outcome', 'looked_fine', 'document_id', null))),
    'check constraint', 'a part outcome outside the closed list is refused');

  msg := app.record_inbound_message(
    jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
      'outcome', 'received', 'authenticated', true, 'dkim', 'pass', 'dmarc', 'unknown',
      'spf', 'pass', 'verdict_source', 'postmark_spamassassin', 'sender_domain', 'example.com'),
    jsonb_build_array(
      jsonb_build_object('ordinal', 0, 'kind', 'attachment', 'filename', 'notice.pdf',
        'outcome', 'stored', 'document_id', doc_email),
      jsonb_build_object('ordinal', 1, 'kind', 'inline', 'filename', 'logo.png',
        'outcome', 'inline_image'),
      jsonb_build_object('ordinal', 2, 'kind', 'body', 'outcome', 'stored', 'document_id', doc_body)));
  select count(*) into n from inbound_message_parts where inbound_message_id = msg;
  perform test.ok(msg is not null and n = 3, 'the acting member records an email and its three parts');
  select acted_as into r from inbound_messages where id = msg;
  perform test.ok(r.acted_as = owner2_a, 'the row names the member it was written as');

  msg_again := app.record_inbound_message(
    jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-1',
      'outcome', 'received', 'authenticated', true, 'dkim', 'pass', 'dmarc', 'unknown',
      'spf', 'pass', 'verdict_source', 'postmark_spamassassin'),
    '[]'::jsonb);
  select count(*) into n from inbound_messages where provider_message_id = 'm-1';
  perform test.ok(msg_again = msg and n = 1, 'recording the same email again writes nothing');

  -- A retired address: nothing is received, and a refusal is the retirer's.
  perform test.as_member(org_a, owner_a);
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a2, 'provider', 'postmark', 'provider_message_id', 'm-2',
        'outcome', 'received', 'authenticated', false, 'dkim', 'none', 'dmarc', 'unknown',
        'spf', 'none', 'verdict_source', 'postmark_spamassassin')),
    'retired', 'a retired address receives nothing');
  msg := app.record_inbound_message(
    jsonb_build_object('address_id', addr_a2, 'provider', 'postmark', 'provider_message_id', 'm-2',
      'outcome', 'refused_retired'), '[]'::jsonb);
  perform test.ok(msg is not null, 'the retirer records a refusal at the retired address');
  perform test.as_member(org_a, owner2_a);
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a2, 'provider', 'postmark', 'provider_message_id', 'm-3',
        'outcome', 'refused_retired')),
    'retired it', 'and nobody else does');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-4',
        'outcome', 'refused_retired')),
    'not retired', 'a live address has no refusals to record');

  -- A message that did not reach us carries Postmark's date and no verdict.
  msg := app.record_inbound_message(
    jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-5',
      'outcome', 'not_received', 'provider_received_at', '2026-09-24T10:00:00Z'), '[]'::jsonb);
  perform test.ok(msg is not null, 'a not_received row is recorded with Postmark''s date');
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-6',
        'outcome', 'not_received', 'dkim', 'pass')),
    'check constraint', 'a row that is not received carries no verdict');

  -- B sees none of A's email.
  perform test.as_member(org_b, owner_b);
  select count(*) into n from inbound_messages;
  perform test.ok(n = 0, format('B sees none of A''s messages (saw %s)', n));
  select count(*) into n from inbound_message_parts;
  perform test.ok(n = 0, format('nor their parts (saw %s)', n));

  -- A member who may no longer write records nothing.
  perform test.as_member(org_a, reader_a);
  perform test.expect_error(
    format('select app.record_inbound_message(%L::jsonb, ''[]''::jsonb)',
      jsonb_build_object('address_id', addr_a, 'provider', 'postmark', 'provider_message_id', 'm-7',
        'outcome', 'not_received')),
    'may not write', 'a read_only member records nothing');

  -- =========================================================================
  -- Append-only, table by table, for app_rw and for the owner
  -- =========================================================================
  perform test.as_member(org_a, owner_a);
  foreach t in array array[
    'inbound_addresses', 'inbound_address_adoptions', 'inbound_address_retirements',
    'inbound_messages', 'inbound_message_parts'
  ] loop
    perform test.expect_error(format('update %I set org_id = org_id', t), 'permission denied',
      format('app_rw cannot UPDATE %s', t));
    perform test.expect_error(format('delete from %I', t), 'permission denied',
      format('app_rw cannot DELETE from %s', t));
    perform test.expect_error(format('truncate %I', t), 'permission denied',
      format('app_rw cannot TRUNCATE %s', t));
  end loop;

  reset role;
  foreach t in array array[
    'inbound_addresses', 'inbound_address_adoptions', 'inbound_address_retirements',
    'inbound_messages', 'inbound_message_parts'
  ] loop
    perform test.expect_error(format('update %I set org_id = org_id', t), 'append-only',
      format('even the table owner cannot UPDATE %s', t));
    perform test.expect_error(format('delete from %I', t), 'append-only',
      format('even the table owner cannot DELETE from %s', t));
    perform test.expect_error(format('truncate %I cascade', t), 'append-only',
      format('even the table owner cannot TRUNCATE %s', t));
  end loop;
end
$test$;
rollback;
