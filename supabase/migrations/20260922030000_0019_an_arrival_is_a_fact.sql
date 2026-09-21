-- 0019 — An arrival is a fact (ADR 0024).
--
-- `uploads` has been in migration 0006's `mutable` array since Phase 0, so
-- `app_rw` holds UPDATE and DELETE on it and no trigger guards it. That was
-- harmless while nothing read the column. Since `declineCase` began deriving
-- `declined_candidates.discovered_from` from `uploads.source`, it is not: a
-- declined row is append-only and cannot be corrected, that column is the one a
-- coverage number is sliced by, and an `update uploads set source = …` re-labels
-- which channel found a deduction *after* the declines attributed to it were
-- counted.
-- No `audit_log` row is written on any `uploads` path, so the before and after
-- are indistinguishable by inspection. A published coverage number moves and
-- nothing anywhere says that it did.
--
-- Three changes, and nothing else.
--
--   1. `uploads` joins the append-only set, on 0004's pattern exactly: revoke
--      UPDATE/DELETE/TRUNCATE from app_rw and app_ro, INSERT + SELECT to app_rw,
--      SELECT to app_ro, and the `no_update_delete` row trigger plus the
--      `no_truncate` statement trigger, both on `app.block_mutations()`.
--
--   2. `document_arrivals`: somewhere for a document stored *before* provenance
--      was recorded to say which arrival it came from — write-once, refused
--      where ingest already recorded one, refused for a channel that could not
--      have delivered it, and naming the person who asserted it (ADR 0024 §3).
--      This is the migration `ProvenanceUnknownError` has been telling reviewers
--      about by name.
--
--   3. `declined_candidates.provenance_kind`: whether a declined row's channel
--      was observed at ingest or asserted afterwards, so a coverage number can
--      say that about itself instead of being three joins away from it
--      (ADR 0024 §4). Added now because production carries no declines and no
--      recorded uploads, so the default back-fills nothing.
--
-- What is deliberately NOT here: any edit to `app.require_approval()`,
-- `app.guard_immutable_core()`, `app.member_may_write()` or
-- `app.block_mutations()` — the last is *used*, not redefined — any change to
-- `uploads`' RLS policies, and any new UPDATE or DELETE grant anywhere. The only
-- grants issued are INSERT and SELECT, to roles that already read these rows.
--
-- Idempotent throughout: `create table if not exists`, `create or replace`,
-- drop-then-create for every trigger and policy, `create … if not exists` for
-- every index. `scripts/db-test.sh` applies every migration twice in one run and
-- `supabase/tests/14_an_arrival_is_a_fact.sql` reads the end state back rather
-- than assuming it.

-- ---------------------------------------------------------------------------
-- 1. uploads joins the append-only set
-- ---------------------------------------------------------------------------
-- The revoke answers for app_rw and app_ro. It does not answer for the table
-- owner — the role migrations run as, the role a Supabase SQL-editor session
-- runs as, the role anybody with the database password gets — which bypasses
-- grants and RLS alike. 0004 pairs a revoke with a trigger for exactly that
-- reason, and the trigger is also what survives the next `grant all` somebody
-- writes in a hurry. Following the whole pattern rather than half of it is the
-- point of there being one.
revoke update, delete, truncate on uploads from app_rw;
revoke update, delete, truncate on uploads from app_ro;
grant insert, select on uploads to app_rw;
grant select on uploads to app_ro;

drop trigger if exists no_update_delete on uploads;
create trigger no_update_delete before update or delete on uploads
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on uploads;
create trigger no_truncate before truncate on uploads
  for each statement execute function app.block_mutations();

comment on table uploads is
  'One row per arrival of new bytes: which channel they came through, when, '
  'and which member put them there. Append-only (ADR 0024) — this is what '
  'declined_candidates.discovered_from is derived from, which is the column a '
  'coverage number is sliced by. A source recorded wrongly at ingest '
  'cannot be corrected in place, and a second row is a row nothing joins to, '
  'because documents.upload_id is itself immutable (0004). Correcting one is a '
  'migration-backed decision, which is the same dead end '
  'ProvenanceUnknownError already names.';

comment on column uploads.source is
  'The door the bytes came through, set by ingestDocument from the entry point '
  'and never read off a document. Immutable (ADR 0024).';

-- ---------------------------------------------------------------------------
-- 2. document_arrivals — an arrival recorded after the fact, and marked as such
-- ---------------------------------------------------------------------------
-- `documents.upload_id` is the link, and it is frozen. Documents stored before
-- 2026-09-21 have it null, so their cases are refused by `declineCase` rather
-- than attributed to a guess — and §1 above freezes the only other lever. This
-- table is the one way back, and it is built so that it can only ever record an
-- assertion, never override an observation:
--
--   * at most one row per document (`unique (document_id)`), append-only, so
--     the first answer is the only answer;
--   * refused outright where ingest already recorded an arrival, by
--     `app.arrival_only_when_unknown()` below;
--   * `recorded_by` NOT NULL, so an asserted arrival always names a person —
--     an arrival recorded at ingest by an inbound email has a null
--     `uploads.created_by`, one asserted afterwards never does;
--   * and the channel itself is typed by an operator at the point of use
--     (`pnpm link:provenance --source …`), never defaulted. The fact that would
--     justify a value — ingestInboundEmail has never had a production caller,
--     so every pre-provenance production document arrived by web upload — is an
--     assertion about this deployment, not a derivation from anything here. It
--     lives in ADR 0024 and in a typed argument.
--
-- No `source` column of its own: the channel is on the `uploads` row this points
-- at, so an asserted arrival and an observed one are read through exactly the
-- same column, by the same `coalesce` in one query, rather than through two
-- lists that can drift apart.
create table if not exists document_arrivals (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  document_id  uuid not null references documents(id),
  upload_id    uuid not null references uploads(id),
  -- Who asserted it. Not nullable: an arrival nobody stands behind is the guess
  -- this whole mechanism exists to avoid recording.
  recorded_by  uuid not null references users(id),
  -- Why they believe it — a deployment fact, a mailbox export, a person's
  -- recollection written down. Free text on purpose: it is read by a human
  -- auditing a coverage number, never parsed.
  detail       text,
  recorded_at  timestamptz not null default now(),
  -- Write-once. A second assertion about the same document is refused rather
  -- than stacked, and with the append-only triggers below that makes the first
  -- one final.
  unique (document_id)
);

comment on table document_arrivals is
  'Which arrival a document stored before provenance recording came from, '
  'asserted after the fact by a named person (ADR 0024 §3). Append-only and '
  'write-once. Never an override: app.arrival_only_when_unknown() refuses a row '
  'for a document that already has an uploads row, so what ingest observed '
  'stays the only answer wherever ingest observed anything.';

comment on column document_arrivals.recorded_by is
  'The member who asserted this arrival. A declined_candidates row attributed '
  'through it says so in its own provenance_kind; this column, recorded_at, '
  'detail and the case''s own document.provenance_recorded event are what say '
  'who asserted it and why (ADR 0024).';

create index if not exists document_arrivals_org_idx
  on document_arrivals (org_id, recorded_at desc);
create index if not exists document_arrivals_upload_idx
  on document_arrivals (org_id, upload_id);

alter table document_arrivals enable row level security;

-- One policy per command, the pattern from ADR 0012: a single policy's USING
-- clause governs reads and the row-selection half of writes alike, so a role
-- predicate there would have blocked reading too. A `read_only` member is
-- refused the insert here, before the grants are consulted.
do $$
begin
  execute 'drop policy if exists tenant_isolation on document_arrivals';
  execute 'drop policy if exists tenant_read on document_arrivals';
  execute 'drop policy if exists tenant_insert on document_arrivals';
  execute 'drop policy if exists tenant_update on document_arrivals';
  execute 'drop policy if exists tenant_delete on document_arrivals';

  execute 'create policy tenant_read on document_arrivals for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on document_arrivals for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on document_arrivals for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on document_arrivals for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

-- Insert and select only. The update/delete policies above exist so that a
-- future grant cannot silently arrive without one; the grant itself is revoked
-- and the trigger refuses regardless of role.
grant select, insert on document_arrivals to app_rw;
grant select on document_arrivals to app_ro;
revoke update, delete, truncate on document_arrivals from app_rw;
revoke update, delete, truncate on document_arrivals from app_ro;

drop trigger if exists no_update_delete on document_arrivals;
create trigger no_update_delete before update or delete on document_arrivals
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on document_arrivals;
create trigger no_truncate before truncate on document_arrivals
  for each statement execute function app.block_mutations();

-- Three foreign keys say the org, the document and the upload each exist. None
-- of them says they are one tenant's — the point `packets` has to make for its
-- decision, and the same one here. And none of them says the document has no
-- arrival already, which is the rule that keeps this table an assertion about
-- the unknown rather than a way to overwrite what ingest observed.
--
-- Definer, like app.packet_matches_its_decision() and for the same reason: RLS
-- would hide another tenant's document from this lookup, and an invisible row
-- reads identically to one that does not exist — the trigger would refuse a
-- cross-tenant reference and a merely-nonexistent id with the same words.
-- Reading as definer lets each rule answer for itself: this refuses a
-- cross-tenant reference, and RLS still refuses a cross-tenant write on its own
-- terms. The function reads two columns of two rows the caller already named,
-- and returns nothing.
create or replace function app.arrival_only_when_unknown() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  doc_org uuid;
  doc_upload uuid;
  upload_org uuid;
  upload_source text;
begin
  select d.org_id, d.upload_id into doc_org, doc_upload
    from documents d where d.id = new.document_id;

  if doc_org is null then
    raise exception 'arrival blocked: document % does not exist', new.document_id
      using errcode = 'restrict_violation';
  end if;

  if doc_org <> new.org_id then
    raise exception 'arrival blocked: document % belongs to another org',
      new.document_id
      using errcode = 'restrict_violation';
  end if;

  -- The rule this table exists under. What ingest recorded is not editable and
  -- is not shadowable: a document that already names an arrival has its answer.
  if doc_upload is not null then
    raise exception
      'arrival blocked: document % already records arrival %; what ingest '
      'observed is not overwritten', new.document_id, doc_upload
      using errcode = 'restrict_violation';
  end if;

  select u.org_id, u.source into upload_org, upload_source
    from uploads u where u.id = new.upload_id;

  if upload_org is null then
    raise exception 'arrival blocked: upload % does not exist', new.upload_id
      using errcode = 'restrict_violation';
  end if;

  if upload_org <> new.org_id then
    raise exception 'arrival blocked: upload % belongs to another org',
      new.upload_id
      using errcode = 'restrict_violation';
  end if;

  -- Only a door that existed while a document could be stored with no arrival
  -- on it. `uploads.source` admits six channels; three of them — erp_sync,
  -- portal_fetch, edi_812 — are Phases 1.5, 2 and 2.5, and every one of those
  -- writes an `uploads` row at ingest like the rest, so a document of theirs
  -- never reaches this table with nothing recorded. Asserting one here would be
  -- crediting a channel that could not have delivered the bytes. `ASSERTABLE_SOURCES`
  -- in `store-postgres` refuses the same three before a round trip; this is the
  -- half that answers for the owner and for anything that never went through the
  -- store at all.
  if upload_source not in ('web_upload', 'email_in', 'email_body') then
    raise exception
      'arrival blocked: upload % records channel %, which is not one an arrival '
      'can be asserted from (web_upload, email_in, email_body)',
      new.upload_id, upload_source
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

comment on function app.arrival_only_when_unknown() is
  'A document_arrivals row records the arrival of a document that records '
  'none, within one tenant, through a door that existed while such a document '
  'could be stored. The foreign keys say each id exists; this says they are one '
  'tenant''s, that nothing was already known, and that the channel is one of '
  'web_upload, email_in, email_body (ADR 0024 §3).';

-- The pattern migration 0012 set for every definer function: nobody holds
-- EXECUTE on it. Firing a trigger does not check EXECUTE, so the function still
-- runs on every insert into document_arrivals — this only takes away the ability
-- to call it by hand, which nothing has a reason to do and a definer function
-- should never leave lying around.
revoke all on function app.arrival_only_when_unknown() from public;

drop trigger if exists arrival_only_when_unknown on document_arrivals;
create trigger arrival_only_when_unknown before insert on document_arrivals
  for each row execute function app.arrival_only_when_unknown();

-- ---------------------------------------------------------------------------
-- 3. declined_candidates says whether its channel was observed or asserted
-- ---------------------------------------------------------------------------
-- `discovered_from` is now read as `coalesce(observed, asserted)`, so two rows
-- with the same channel can have arrived at it two different ways: one the
-- pipeline watched happen, one a person supplied afterwards from a
-- `document_arrivals` row. A coverage number computed over a period that spans
-- 2026-09-21 mixes them, and nothing in the table said which was which — the
-- answer was three joins away, in ADR 0024's own "what we live with".
--
-- Adding the column is additive and it fires no trigger: `alter table … add
-- column` is DDL, `no_update_delete` is a row trigger on UPDATE and DELETE, and
-- the default is filled in by the table rewrite rather than by an UPDATE anybody
-- issues. No grant changes, no policy changes, and the append-only triggers on
-- this table are untouched.
--
-- The reason to do it *now* rather than in a later migration is that the window
-- is open and closing: production carries no `declined_candidates` rows and no
-- `uploads` rows at all, so `default 'observed'` back-fills nothing and cannot
-- mislabel anything. A migration written after the first decline would have to
-- choose between a null column on the historical rows and a default that claims
-- something about them, which is exactly the argument ADR 0024 made against the
-- column — an argument that holds when there is history and does not when there
-- is none.
alter table declined_candidates
  add column if not exists provenance_kind text not null default 'observed'
    check (provenance_kind in ('observed', 'asserted'));

comment on column declined_candidates.provenance_kind is
  'How this row''s discovered_from was arrived at: ''observed'' — the pipeline '
  'recorded the arrival at ingest (documents.upload_id) — or ''asserted'' — a '
  'person supplied it afterwards through document_arrivals, for a document '
  'stored before provenance was recorded (ADR 0024). Set by declineCase from '
  'which of the two joins answered, never passed in.';
