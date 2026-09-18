-- 0004 — Append-only truth (invariant 2) and tamper-evident hash chains.
--
-- *_events, documents and audit_log take INSERT + SELECT only. Corrections are
-- new events, bitemporal via (event_time, observed_at). Current-state tables
-- (deductions.state, …) are derived projections and may be updated.

-- Verdicts about a document, as facts rather than mutations.
create table if not exists document_scans (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references organizations(id),
  document_id  uuid not null references documents(id),
  status       text not null check (status in ('clean', 'infected', 'error')),
  scanner      text not null,
  detail       text,
  observed_at  timestamptz not null default now()
);

create table if not exists document_classifications (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references organizations(id),
  document_id  uuid not null references documents(id),
  doc_type     text not null check (doc_type in (
                 'deduction_notice', 'remittance_advice', 'invoice', 'po', 'bol',
                 'pod', 'asn', 'promo_agreement', 'price_agreement',
                 'routing_guide', 'other')),
  confidence   numeric(5,4) not null check (confidence between 0 and 1),
  decision_id  uuid references decisions(id),
  observed_at  timestamptz not null default now()
);

-- Latest verdict wins, without ever mutating a row.
create or replace view document_state as
  select d.id as document_id,
         d.org_id,
         d.sha256,
         (select s.status from document_scans s
           where s.document_id = d.id order by s.id desc limit 1) as scan_status,
         (select c.doc_type from document_classifications c
           where c.document_id = d.id order by c.id desc limit 1) as doc_type
  from documents d;

create table if not exists deduction_events (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references organizations(id),
  deduction_id  uuid not null references deductions(id),
  event_type    text not null,
  payload       jsonb not null,
  event_time    timestamptz not null,               -- when the fact was true
  observed_at   timestamptz not null default now(), -- when we recorded it
  prev_hash     bytea,
  row_hash      bytea not null,
  created_by    uuid references users(id)
);

create table if not exists audit_log (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references organizations(id),
  actor_id      uuid references users(id),
  action        text not null,
  subject_table text not null,
  subject_id    text,
  payload       jsonb not null default '{}'::jsonb,
  observed_at   timestamptz not null default now(),
  prev_hash     bytea,
  row_hash      bytea not null
);

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
create or replace function app.block_mutations() returns trigger
  language plpgsql as $$
begin
  raise exception 'append-only table %: % is not allowed', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end
$$;

do $$
declare t text;
begin
  foreach t in array array['deduction_events', 'audit_log', 'documents',
                           'document_scans', 'document_classifications']
  loop
    execute format(
      'drop trigger if exists no_update_delete on %I', t);
    execute format(
      'create trigger no_update_delete before update or delete on %I
         for each row execute function app.block_mutations()', t);
    execute format(
      'drop trigger if exists no_truncate on %I', t);
    execute format(
      'create trigger no_truncate before truncate on %I
         for each statement execute function app.block_mutations()', t);
    execute format('revoke update, delete, truncate on %I from app_rw', t);
    execute format('grant insert, select on %I to app_rw', t);
    execute format('grant select on %I to app_ro', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Hash chains: the inserter never supplies the hashes, the trigger computes
-- them. An advisory lock per chain key keeps concurrent inserts from forking
-- the chain.
-- ---------------------------------------------------------------------------
create or replace function app.chain_deduction_event() returns trigger
  language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || ':' || new.deduction_id::text, 0));
  select e.row_hash into prev from deduction_events e
    where e.org_id = new.org_id and e.deduction_id = new.deduction_id
    order by e.id desc limit 1;
  new.prev_hash := prev;
  new.row_hash := app.row_hash(prev, new.payload);
  return new;
end
$$;

create or replace function app.chain_audit_log() returns trigger
  language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('audit:' || new.org_id::text, 0));
  select a.row_hash into prev from audit_log a
    where a.org_id = new.org_id order by a.id desc limit 1;
  new.prev_hash := prev;
  new.row_hash := app.row_hash(prev, jsonb_build_object(
    'action', new.action, 'actor_id', new.actor_id,
    'subject_table', new.subject_table, 'subject_id', new.subject_id,
    'payload', new.payload));
  return new;
end
$$;

drop trigger if exists chain_hash on deduction_events;
create trigger chain_hash before insert on deduction_events
  for each row execute function app.chain_deduction_event();

drop trigger if exists chain_hash on audit_log;
create trigger chain_hash before insert on audit_log
  for each row execute function app.chain_audit_log();

create index if not exists deduction_events_case_idx on deduction_events (org_id, deduction_id, id);
create index if not exists audit_log_org_idx on audit_log (org_id, id);
create index if not exists document_scans_doc_idx on document_scans (org_id, document_id, id desc);
create index if not exists document_classifications_doc_idx
  on document_classifications (org_id, document_id, id desc);
