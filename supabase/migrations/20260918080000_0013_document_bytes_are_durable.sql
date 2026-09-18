-- 0013 — A stored document's bytes survive the process that stored them.
--
-- `BlobStore` had one implementation, `InMemoryBlobStore`, so every document
-- Phase 1 ingested existed only for the life of the Node process. The row in
-- `documents` outlived it, pointing at a `storage_ref` nothing could resolve:
-- a case whose evidence cannot be produced, which is the one thing a deductions
-- packet has to be able to do.
--
-- Bytes go in Postgres for now rather than object storage, because the request
-- path reaches Postgres as `app_rw` under RLS and that is the whole security
-- model. Supabase Storage would mean either a service-role key in a request path
-- (invariant 6) or a second, parallel authorization story to keep in step with
-- this one. A deduction notice is tens to hundreds of kilobytes; when the corpus
-- is large enough for that to matter, this table is a clean thing to move behind
-- the same `BlobStore` port (ADR 0014).

-- No foreign key to `documents` on purpose. The bytes are written first and the
-- row second, so that a `documents` row never exists without the bytes it points
-- at — the failure that matters. The reverse leaves bytes nobody references,
-- which is garbage rather than a lie, and is cleanable.
create table if not exists document_blobs (
  document_id  uuid primary key,
  org_id       uuid not null references organizations(id),
  bytes        bytea not null,
  byte_size    bigint not null check (byte_size > 0),
  created_at   timestamptz not null default now()
);

-- Same discipline as every other table here: RLS on, one policy per command,
-- and a writer role required to write.
alter table document_blobs enable row level security;

do $$
begin
  execute 'drop policy if exists tenant_read on document_blobs';
  execute 'drop policy if exists tenant_insert on document_blobs';
  execute 'drop policy if exists tenant_update on document_blobs';
  execute 'drop policy if exists tenant_delete on document_blobs';

  execute 'create policy tenant_read on document_blobs for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on document_blobs for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on document_blobs for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on document_blobs for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

-- The bytes of a document are what its hash was taken over, so rewriting them
-- would break every quote, box and reconciliation that cites it. Append-only,
-- like the document row itself.
grant select, insert on document_blobs to app_rw;
grant select on document_blobs to app_ro;
revoke update, delete, truncate on document_blobs from app_rw;

drop trigger if exists no_update_delete on document_blobs;
create trigger no_update_delete before update or delete on document_blobs
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on document_blobs;
create trigger no_truncate before truncate on document_blobs
  for each statement execute function app.block_mutations();
