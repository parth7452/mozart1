-- 0034 — An email reaches a tenant only through an address that tenant was
-- given (ADR 0047).
--
-- Email-in had a parser and a pipeline step and no door: nothing could find
-- the tenant an email was for without already acting as that tenant, nothing
-- recorded what an email said about itself, and the address was the tenant's
-- human-readable slug. This migration is the database half of the door.
--
--   1. `unique (org_id, id)` on `documents`, so a message part can name its
--      document by a composite foreign key and cannot name another tenant's
--      (ADR 0025 §7's pattern; 0025 and 0027 did the same for their tables).
--
--   2. Three append-only address tables — issued, adopted, retired — written
--      by an owner as themselves (0030's policy for accounting_connections).
--      The token is the database's: a trigger refuses one the caller supplies
--      and fills in 32 hex characters from gen_random_uuid(). Tokens are unique
--      across retired rows, so a retired address is never issued again.
--
--   3. Two append-only message tables — the email and each of its parts —
--      that app_rw may only SELECT. Every row goes through
--      `app.record_inbound_message()`, definer and bounded by its caller the
--      way `app.record_ledger_sync_run()` is (0024): a writer cannot fabricate
--      a record of what an email said about itself.
--
--   4. `app.inbound_address_for(token)` — the one lookup that turns a token
--      into its tenant and the member the address acts as, for a caller that
--      carries no claims (the webhook has no session). Refused to any caller
--      carrying an org_id or a sub, the guard ADR 0045 put on the other two.
--
-- What is deliberately NOT here: any change to an existing function, policy,
-- grant or trigger; any UPDATE or DELETE grant; any money column. The only
-- existing table touched is `documents`, which gains a unique constraint that
-- its primary key already implies.
--
-- Idempotent throughout: `if not exists`, `create or replace`, drop-then-create
-- for every trigger and policy, and a guarded `add constraint`.
-- scripts/db-test.sh applies every migration twice, and
-- supabase/tests/30_an_email_reaches_a_tenant_through_an_address.sql reads the
-- end state back.

-- ---------------------------------------------------------------------------
-- 1. documents: (org_id, id), for the composite foreign key below
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'documents_org_id_id_key' and conrelid = 'documents'::regclass
  ) then
    alter table documents add constraint documents_org_id_id_key unique (org_id, id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Addresses: issued, adopted, retired — each a fact written once
-- ---------------------------------------------------------------------------
create table if not exists inbound_addresses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  -- Filled in by app.inbound_address_token() and never by a caller: a person
  -- who could choose an address could choose one somebody else will guess.
  token       text not null unique check (token ~ '^[0-9a-f]{32}$'),
  -- The owner who issued it, and the member it acts as until an owner adopts
  -- it (ADR 0047 §6).
  created_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  unique (org_id, id)
);

comment on table inbound_addresses is
  'An address a tenant gave its senders: <token>@<INBOUND_DOMAIN> (ADR 0047 '
  '§3). Append-only: issued once, adopted by an owner, retired once, never '
  'reissued — the token is unique across retired rows, so mail still in flight '
  'to an old address cannot land in another workspace.';

comment on column inbound_addresses.token is
  '32 lowercase hex characters the database generated. Not a secret from '
  'suppliers, but a write path into the tenant: the app shows it to writers only.';

create table if not exists inbound_address_adoptions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  address_id  uuid not null,
  adopted_by  uuid not null references users(id),
  adopted_at  timestamptz not null default now(),
  foreign key (org_id, address_id) references inbound_addresses (org_id, id)
);

comment on table inbound_address_adoptions is
  'An owner taking over the member an address acts as (ADR 0047 §4, §6): the '
  'address acts as its latest adopter, else its issuer. How an address outlives '
  'the owner who issued it without its senders learning a new one.';

create table if not exists inbound_address_retirements (
  address_id  uuid not null unique,
  org_id      uuid not null,
  retired_by  uuid not null references users(id),
  retired_at  timestamptz not null default now(),
  foreign key (org_id, address_id) references inbound_addresses (org_id, id)
);

comment on table inbound_address_retirements is
  'An address that accepts no more mail (ADR 0047 §4). Once per address, final.';

create index if not exists inbound_address_adoptions_address_idx
  on inbound_address_adoptions (address_id, adopted_at desc, id desc);
create index if not exists inbound_addresses_org_idx
  on inbound_addresses (org_id, created_at desc);

-- The token is the database's. Security invoker: it reads nothing and writes
-- only the row it is handed. Pinned, as every app.* function is (suite 24).
create or replace function app.inbound_address_token() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
begin
  if new.token is not null then
    raise exception
      'an inbound address token is generated by the database and never chosen: '
      'insert the row without one'
      using errcode = 'insufficient_privilege';
  end if;
  new.token := replace(gen_random_uuid()::text, '-', '');
  return new;
end
$$;

comment on function app.inbound_address_token() is
  'Refuses a caller-supplied inbound address token and fills in 32 hex '
  'characters from gen_random_uuid() (ADR 0047 §3).';

-- `token` is not null, so the trigger fills it in before the constraint is
-- checked; a caller that leaves it out inserts null and gets a generated one.
drop trigger if exists generate_token on inbound_addresses;
create trigger generate_token before insert on inbound_addresses
  for each row execute function app.inbound_address_token();

-- ---------------------------------------------------------------------------
-- 3. Messages and their parts — written only through the door below
-- ---------------------------------------------------------------------------
create table if not exists inbound_messages (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null,
  address_id            uuid not null,
  provider              text not null check (provider in ('postmark')),
  -- Postmark's own MessageID, a UUID. Not the Message-ID header, which is the
  -- sender's.
  provider_message_id   text not null check (btrim(provider_message_id) <> ''),
  outcome               text not null
                        check (outcome in ('received', 'not_received', 'refused_retired')),
  received_at           timestamptz not null default now(),
  -- When Postmark received a message it could not deliver to us, from its own
  -- search (ADR 0047 §12). The Date header is the sender's and is never kept.
  provider_received_at  timestamptz,
  acted_as              uuid not null references users(id),
  authenticated         boolean,
  dkim                  text check (dkim in ('pass', 'fail', 'none', 'unknown')),
  dmarc                 text check (dmarc in ('pass', 'fail', 'none', 'unknown')),
  spf                   text check (spf in ('pass', 'fail', 'softfail', 'neutral', 'none', 'unknown')),
  verdict_source        text check (verdict_source in ('postmark_spamassassin')),
  -- The domain the email claims to be from. Shown as a claim, used for nothing.
  sender_domain         text,

  unique (org_id, id),
  unique (org_id, provider, provider_message_id, outcome),
  foreign key (org_id, address_id) references inbound_addresses (org_id, id),

  -- A received email says what Postmark reported about it; nothing else does.
  check (
    (outcome = 'received'
       and authenticated is not null and dkim is not null and dmarc is not null
       and spf is not null and verdict_source is not null)
    or
    (outcome <> 'received'
       and authenticated is null and dkim is null and dmarc is null
       and spf is null and verdict_source is null and sender_domain is null)
  ),
  check (outcome = 'not_received' or provider_received_at is null),
  -- "Authenticated" is aligned DKIM as Postmark reports it, and nothing else
  -- (ADR 0047 §7). A row cannot say one and mean the other.
  check (authenticated is null or authenticated = (dkim = 'pass'))
);

comment on table inbound_messages is
  'One row per email that reached an address, or that an address was sent and '
  'we could not receive (ADR 0047 §9, §12). Written once, complete, through '
  'app.record_inbound_message(); app_rw holds SELECT only.';

comment on column inbound_messages.authenticated is
  'Aligned DKIM as Postmark''s SpamAssassin reported it (DKIM_VALID_AU). '
  'Recorded and shown; it opens nothing — no email opens a case by itself '
  '(ADR 0047 §7).';

create table if not exists inbound_message_parts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  inbound_message_id  uuid not null,
  ordinal             integer not null check (ordinal >= 0),
  kind                text not null check (kind in ('attachment', 'inline', 'body')),
  -- As the sender named it. Rendered escaped, never logged.
  filename            text,
  outcome             text not null check (outcome in (
                        'stored', 'already_held', 'over_daily_budget', 'not_clean',
                        'inline_image', 'too_many_parts', 'not_base64',
                        -- RejectedUploadError's codes (packages/ingest/src/sniff.ts)
                        'empty_file', 'body_too_short', 'too_large', 'type_not_allowed',
                        'content_does_not_match_type', 'encrypted_pdf',
                        'active_content_pdf', 'decompression_bomb', 'malformed_pdf')),
  document_id         uuid,
  unique (inbound_message_id, ordinal),
  foreign key (org_id, inbound_message_id) references inbound_messages (org_id, id),
  foreign key (org_id, document_id) references documents (org_id, id),
  -- A part names a document exactly when one was stored for it.
  check (
    (outcome in ('stored', 'already_held', 'over_daily_budget', 'not_clean'))
      = (document_id is not null)
  )
);

comment on table inbound_message_parts is
  'What became of each attachment, inline image and body an email carried '
  '(ADR 0047 §9). A refusal is a row here rather than a silence.';

create index if not exists inbound_messages_org_idx
  on inbound_messages (org_id, received_at desc);
create index if not exists inbound_messages_address_idx
  on inbound_messages (org_id, address_id, received_at desc);
create index if not exists inbound_message_parts_message_idx
  on inbound_message_parts (org_id, inbound_message_id, ordinal);
create index if not exists inbound_message_parts_document_idx
  on inbound_message_parts (org_id, document_id) where document_id is not null;

-- ---------------------------------------------------------------------------
-- RLS, grants and the append-only triggers, table by table
-- ---------------------------------------------------------------------------
alter table inbound_addresses enable row level security;
alter table inbound_address_adoptions enable row level security;
alter table inbound_address_retirements enable row level security;
alter table inbound_messages enable row level security;
alter table inbound_message_parts enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'inbound_addresses', 'inbound_address_adoptions', 'inbound_address_retirements',
    'inbound_messages', 'inbound_message_parts'
  ] loop
    execute format('drop policy if exists tenant_read on %I', t);
    execute format('drop policy if exists tenant_insert on %I', t);
    execute format('drop policy if exists tenant_update on %I', t);
    execute format('drop policy if exists tenant_delete on %I', t);
    execute format(
      'create policy tenant_read on %I for select using (org_id = app.current_org_id())', t);
  end loop;

  -- An owner, as themselves (0030's rule for accounting_connections).
  execute 'create policy tenant_insert on inbound_addresses for insert
             with check (org_id = app.current_org_id() and app.member_is_owner()
                         and created_by = app.current_user_id())';
  -- An owner, as themselves, and only while the address is live: adopting a
  -- retired address would put a person's name on a door that is shut.
  execute 'create policy tenant_insert on inbound_address_adoptions for insert
             with check (org_id = app.current_org_id() and app.member_is_owner()
                         and adopted_by = app.current_user_id()
                         and not exists (
                           select 1 from inbound_address_retirements r
                            where r.address_id = inbound_address_adoptions.address_id))';
  execute 'create policy tenant_insert on inbound_address_retirements for insert
             with check (org_id = app.current_org_id() and app.member_is_owner()
                         and retired_by = app.current_user_id())';
  -- Present and never reachable: app_rw holds no INSERT on the message tables,
  -- so every row goes through app.record_inbound_message(). A grant issued in a
  -- hurry would land on this rule rather than on nothing (0024's reasoning).
  execute 'create policy tenant_insert on inbound_messages for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_insert on inbound_message_parts for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'inbound_addresses', 'inbound_address_adoptions', 'inbound_address_retirements',
    'inbound_messages', 'inbound_message_parts'
  ] loop
    execute format('revoke all on %I from app_rw', t);
    execute format('revoke all on %I from app_ro', t);
    execute format('grant select on %I to app_rw', t);
    execute format('grant select on %I to app_ro', t);
    -- A revoke answers for the app roles; the trigger answers for the owner
    -- (0004's pairing).
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

grant insert on inbound_addresses to app_rw;
grant insert on inbound_address_adoptions to app_rw;
grant insert on inbound_address_retirements to app_rw;

-- ---------------------------------------------------------------------------
-- 4. app.inbound_address_for(token) — the tenant, for a caller with no claims
-- ---------------------------------------------------------------------------
create or replace function app.inbound_address_for(p_token text)
  returns table (address_id uuid, org_id uuid, acting_member uuid, retired boolean)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public, extensions
as $$
begin
  -- The webhook has no session: this is the query that decides which tenant
  -- it acts for. Every other caller carries a claim and reads the address
  -- tables through RLS (ADR 0045's guard, on its third function).
  if app.current_org_id() is not null or app.current_user_id() is not null then
    raise exception
      'inbound_address_for is the untenanted inbound lookup and takes no claims: '
      'a caller acting for a tenant or a subject must read inbound_addresses '
      'through RLS instead'
      using errcode = 'insufficient_privilege';
  end if;

  -- Exactly one token, compared whole. It lists nothing and matches no pattern.
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return;
  end if;

  return query
    select a.id,
           a.org_id,
           case when r.address_id is not null then r.retired_by
                else coalesce(
                  (select ad.adopted_by from inbound_address_adoptions ad
                    where ad.address_id = a.id
                    order by ad.adopted_at desc, ad.id desc
                    limit 1),
                  a.created_by)
           end,
           r.address_id is not null
      from inbound_addresses a
      left join inbound_address_retirements r on r.address_id = a.id
     where a.token = p_token;
end
$$;

comment on function app.inbound_address_for(text) is
  'The tenant an inbound address token belongs to, and the member a delivery '
  'to it acts as: the latest adopter, else the issuer; the retirer, with '
  '`retired` true, for a retired address (ADR 0047 §5). For the inbound '
  'webhook, which has no session. Refused to any caller carrying an org_id or '
  'a sub. An unknown token returns nothing.';

revoke all on function app.inbound_address_for(text) from public;
grant execute on function app.inbound_address_for(text) to app_rw;

-- ---------------------------------------------------------------------------
-- 5. app.record_inbound_message() — the one door into the message tables
-- ---------------------------------------------------------------------------
-- Definer because app_rw holds SELECT only on inbound_messages and
-- inbound_message_parts, so that no writer can fabricate a record of what an
-- email said about itself. Bounded by its caller: the caller's own org claim,
-- its own subject as `acted_as`, and the member the address acts as.
--
-- p_message: {address_id, provider, provider_message_id, outcome,
--             provider_received_at?, authenticated?, dkim?, dmarc?, spf?,
--             verdict_source?, sender_domain?}
-- p_parts:   [{ordinal, kind, filename?, outcome, document_id?}, ...]
--
-- A second call for the same (org, provider, message id, outcome) writes
-- nothing and returns the first row's id, so a repeated sweep is free.
create or replace function app.record_inbound_message(p_message jsonb, p_parts jsonb)
  returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  caller_org uuid := app.current_org_id();
  caller_sub uuid := app.current_user_id();
  v_address uuid := (p_message ->> 'address_id')::uuid;
  v_outcome text := p_message ->> 'outcome';
  v_provider text := p_message ->> 'provider';
  v_message_id text := p_message ->> 'provider_message_id';
  address_org uuid;
  issuer uuid;
  adopter uuid;
  retirer uuid;
  acting uuid;
  existing uuid;
  new_id uuid;
  part jsonb;
  part_outcome text;
  part_kind text;
  part_doc uuid;
  doc_source text;
begin
  if caller_org is null or caller_sub is null then
    raise exception
      'inbound message blocked: no tenant claims are set; an email is recorded '
      'as the member its address acts as, never as nobody'
      using errcode = 'insufficient_privilege';
  end if;

  if not app.member_may_write() then
    raise exception
      'inbound message blocked: the member these claims name may not write here'
      using errcode = 'insufficient_privilege';
  end if;

  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then
    raise exception 'inbound message blocked: parts must be an array'
      using errcode = 'invalid_parameter_value';
  end if;

  select a.org_id, a.created_by into address_org, issuer
    from inbound_addresses a where a.id = v_address;

  if address_org is null or address_org <> caller_org then
    raise exception
      'inbound message blocked: address % is not this tenant''s', v_address
      using errcode = 'insufficient_privilege';
  end if;

  select r.retired_by into retirer
    from inbound_address_retirements r where r.address_id = v_address;
  select ad.adopted_by into adopter
    from inbound_address_adoptions ad where ad.address_id = v_address
    order by ad.adopted_at desc, ad.id desc limit 1;
  acting := coalesce(adopter, issuer);

  if v_outcome = 'refused_retired' then
    if retirer is null then
      raise exception
        'inbound message blocked: address % is not retired', v_address
        using errcode = 'check_violation';
    end if;
    if retirer <> caller_sub then
      raise exception
        'inbound message blocked: a refusal at a retired address is recorded as '
        'the owner who retired it'
        using errcode = 'insufficient_privilege';
    end if;
  else
    if acting <> caller_sub then
      raise exception
        'inbound message blocked: an email is recorded as the member its address '
        'acts as, and these claims are not that member'
        using errcode = 'insufficient_privilege';
    end if;
    if v_outcome = 'received' and retirer is not null then
      raise exception
        'inbound message blocked: address % is retired and receives nothing',
        v_address
        using errcode = 'check_violation';
    end if;
  end if;

  select m.id into existing
    from inbound_messages m
   where m.org_id = caller_org and m.provider = v_provider
     and m.provider_message_id = v_message_id and m.outcome = v_outcome;
  if existing is not null then
    return existing;
  end if;

  insert into inbound_messages
    (org_id, address_id, provider, provider_message_id, outcome,
     provider_received_at, acted_as, authenticated, dkim, dmarc, spf,
     verdict_source, sender_domain)
  values
    (caller_org, v_address, v_provider, v_message_id, v_outcome,
     (p_message ->> 'provider_received_at')::timestamptz, caller_sub,
     (p_message ->> 'authenticated')::boolean, p_message ->> 'dkim',
     p_message ->> 'dmarc', p_message ->> 'spf', p_message ->> 'verdict_source',
     p_message ->> 'sender_domain')
  returning id into new_id;

  for part in select value from jsonb_array_elements(p_parts) loop
    part_outcome := part ->> 'outcome';
    part_kind := part ->> 'kind';
    part_doc := (part ->> 'document_id')::uuid;

    -- A part recorded as stored names a document this email delivered: its
    -- arrival is the email's door, not an upload's.
    if part_outcome = 'stored' then
      select u.source into doc_source
        from documents d join uploads u on u.id = d.upload_id
       where d.id = part_doc and d.org_id = caller_org;
      if doc_source is distinct from
           (case when part_kind = 'body' then 'email_body' else 'email_in' end) then
        raise exception
          'inbound message blocked: part % is recorded as stored by this email, '
          'and its document did not arrive by email', part ->> 'ordinal'
          using errcode = 'check_violation';
      end if;
    end if;

    insert into inbound_message_parts
      (org_id, inbound_message_id, ordinal, kind, filename, outcome, document_id)
    values
      (caller_org, new_id, (part ->> 'ordinal')::integer, part_kind,
       part ->> 'filename', part_outcome, part_doc);
  end loop;

  return new_id;
end
$$;

comment on function app.record_inbound_message(jsonb, jsonb) is
  'The only way an inbound_messages or inbound_message_parts row is written '
  '(ADR 0047 §9): as the caller''s own org and subject, only by the member the '
  'address acts as (the retirer, for a refusal at a retired address), and '
  'never for a live-only outcome at a retired address. A stored part must name '
  'a document that arrived by email. Idempotent on (org, provider, message id, '
  'outcome).';

revoke all on function app.record_inbound_message(jsonb, jsonb) from public;
grant execute on function app.record_inbound_message(jsonb, jsonb) to app_rw;
