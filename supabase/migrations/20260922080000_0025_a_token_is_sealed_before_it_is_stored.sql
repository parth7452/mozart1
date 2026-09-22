-- 0025 — A token is sealed before it is stored (ADR 0033).
--
-- ADR 0026 left `QboTokenStore` as a port with no production implementation and
-- ADR 0031 §7 built the scheduler on top of that gap, so every connection gets
-- a run row saying `not_configured` and the ERP discovery path — the coverage
-- thesis's whole numerator — is a seam with nothing in it. This is where the
-- tokens go.
--
-- **The rule this migration exists to honour is that they do not go here in
-- the clear.** CLAUDE.md puts credentials in KMS-backed storage, and Intuit
-- makes the rule bite harder than usual: a refresh token is replaced on every
-- refresh and the old one dies immediately, so a plaintext row anybody can
-- `select *` is a live credential leaked, and a row anybody can `update` is a
-- customer's connection stranded with no repair but asking for consent again.
--
-- What this table holds is ciphertext, a wrapped data key and the id of the KMS
-- key that can unwrap it. The unwrapping happens in the application, with
-- credentials this database does not have and cannot obtain. A dump of every
-- row discloses nothing (ADR 0033 §1).
--
-- Two things, and nothing else.
--
--   1. `unique (org_id, id)` on `accounting_connections`, so the table below
--      can key on `(org_id, connection_id)` and get the tenancy tie
--      declaratively — ADR 0025 §7's pattern, implied by the primary key,
--      costing one index. No column, no grant and no policy changes on that
--      table; it stays outside the append-only set for ADR 0031 §1's reason.
--
--   2. `accounting_credentials` — one row per token set, append-only on 0004's
--      pattern exactly, where **the current tokens are the latest row for the
--      connection** and a rotation is a new row.
--
-- Why append-only here is not habit. An UPDATE on this table is the one
-- statement that can destroy a customer's connection irrecoverably: a crash
-- midway through `update … set ciphertext = …` leaves either the token Intuit
-- has already killed or a half-written row, and both mean consent again. An
-- INSERT cannot do that — the previous row is still there and still
-- decryptable, and a partial write is a row that was never committed. The
-- history of rotations is the audit trail for free, and a connection whose rows
-- stop appearing hourly is visibly stuck rather than silently stale.
--
-- What is deliberately NOT here: any edit to `app.require_approval()`,
-- `app.guard_immutable_core()`, `app.member_may_write()`,
-- `app.block_mutations()` — the last is *used*, not redefined — or
-- `app.guard_threshold_direction()`. No new `security definer` function: unlike
-- 0024, nothing on this path is a refusal that must record itself, so there is
-- nothing to escape a policy for. No UPDATE or DELETE grant anywhere. No money
-- column (invariant 3 is not engaged: nothing here is an amount).
--
-- Idempotent throughout: `create table if not exists`, a guarded
-- `alter table … add constraint`, drop-then-create for every trigger and
-- policy, `create index if not exists`. `scripts/db-test.sh` applies every
-- migration twice in one run, and
-- `supabase/tests/21_a_token_is_sealed.sql` reads the end state back rather
-- than assuming it.

-- ---------------------------------------------------------------------------
-- 1. The tenancy tie a child table can key on
-- ---------------------------------------------------------------------------
-- Two independent foreign keys say "this org exists" and "this connection
-- exists". They do not say the connection is *that* org's. For a credential
-- that gap matters more than usual: a ciphertext this tenant can read, hung off
-- another tenant's connection, would be a token set decrypted under the wrong
-- encryption context — refused at KMS, but only after the call, and only
-- because the cipher happens to bind the context. The database is the referee
-- (CLAUDE.md), so it says no first.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'accounting_connections'::regclass
       and conname = 'accounting_connections_org_id_id_key'
  ) then
    alter table accounting_connections
      add constraint accounting_connections_org_id_id_key unique (org_id, id);
  end if;
end
$$;

comment on constraint accounting_connections_org_id_id_key on accounting_connections is
  'Lets accounting_credentials key on (org_id, connection_id) and get the '
  'tenancy tie with it, rather than trusting two independent foreign keys '
  '(ADR 0033 §2, ADR 0025 §7).';

-- ---------------------------------------------------------------------------
-- 2. accounting_credentials — ciphertext, and nothing that can read it
-- ---------------------------------------------------------------------------
create table if not exists accounting_credentials (
  id                 uuid primary key default gen_random_uuid(),
  -- Which row is current. `created_at` defaults to now(), which is fixed for a
  -- transaction, so two rows written in one would tie and "the latest" would be
  -- whatever the planner felt like. An identity column is written in the order
  -- the rows were, and read back in it.
  seq                bigint generated always as identity,
  org_id             uuid not null references organizations(id),
  connection_id      uuid not null references accounting_connections(id),
  -- Which cipher sealed it, by name — `aws-kms+aes-256-gcm` today. On the row
  -- rather than assumed, so a later cipher can be introduced without a
  -- migration and an old row still says how to open it. A name, not a secret.
  cipher             text not null check (btrim(cipher) <> ''),
  -- The KMS key that can unwrap `wrapped_key`. An ARN or a key id: a *name* for
  -- a key that lives in AWS, never key material. It is what makes a key
  -- rotation tractable — an old row says which key it needs.
  key_id             text not null check (btrim(key_id) <> ''),
  -- The data key, encrypted under that KMS key, base64. Useless without a
  -- kms:Decrypt call this database cannot make.
  wrapped_key        text not null check (length(wrapped_key) between 1 and 20000),
  -- The token set, encrypted under the data key with AES-256-GCM, base64. The
  -- encryption context ({org, realm}) is authenticated, so this does not
  -- decrypt for another tenant or another company even if the row is moved.
  ciphertext         text not null check (length(ciphertext) between 1 and 20000),
  -- In the clear on purpose, and neither is a credential: an operator has to be
  -- able to see which connections are about to strand without anybody
  -- decrypting anything. The sealed payload carries its own copy and is
  -- authoritative; these two are for looking at.
  --
  -- Nullable, because a connection can legitimately be stored with a refresh
  -- token and no usable access token — which is exactly what `pnpm link:qbo`
  -- writes, so the first API call refreshes before it reads.
  access_expires_at  timestamptz,
  -- Not nullable: a refresh token with no known expiry is a connection nobody
  -- can tell is dying.
  refresh_expires_at timestamptz not null,
  -- Who put it there. A person for `pnpm link:qbo`; the member the sync acts as
  -- for a rotation (ADR 0031 §3). Not nullable for that migration's reason — a
  -- write with no member behind it is the service role by another name.
  created_by         uuid not null references users(id),
  created_at         timestamptz not null default now(),
  -- The tenancy tie (§1). `connection_id`'s own foreign key says the connection
  -- exists; this says it is this tenant's.
  constraint accounting_credentials_same_org
    foreign key (org_id, connection_id) references accounting_connections (org_id, id)
);

comment on table accounting_credentials is
  'One row per accounting token set, sealed (ADR 0033). The current tokens are '
  'the latest row for the connection and a rotation is a new row — append-only, '
  'because an UPDATE here is the one statement that can strand a customer''s '
  'connection irrecoverably, and because the chain of rows is the record of '
  'every rotation. **No plaintext column of any kind, ever**: what is stored is '
  'ciphertext, a wrapped data key and the name of the KMS key that can unwrap '
  'it, and the unwrapping happens in the application with credentials this '
  'database does not have. supabase/tests/21 asserts the column list against '
  'the catalogue, in both directions, so a later migration that adds '
  'refresh_token fails there rather than in review.';

comment on column accounting_credentials.ciphertext is
  'The token set under AES-256-GCM, base64. The encryption context is '
  '{org_id, provider_account_id} and it is authenticated, so a ciphertext '
  'moved to another tenant''s row does not decrypt.';

comment on column accounting_credentials.key_id is
  'A name for a key that lives in a KMS. Never key material.';

comment on column accounting_credentials.access_expires_at is
  'A timestamp, not a credential — in the clear so an operator can see which '
  'connections are about to strand. The sealed payload carries its own copy '
  'and is the authoritative one. Null when the row holds no usable access '
  'token, which is what the first row of a connection usually is.';

-- The one question this table is asked: what is the latest row for this
-- connection?
create index if not exists accounting_credentials_latest_idx
  on accounting_credentials (org_id, connection_id, seq desc);

alter table accounting_credentials enable row level security;

-- One policy per command, the pattern from ADR 0012 and migration 0010: a
-- single policy's USING clause governs reads and the row-selection half of
-- writes alike, so a role predicate there would block reading too. A
-- `read_only` member is refused every write here before the grants are
-- consulted.
do $$
begin
  execute 'drop policy if exists tenant_isolation on accounting_credentials';
  execute 'drop policy if exists tenant_read on accounting_credentials';
  execute 'drop policy if exists tenant_insert on accounting_credentials';
  execute 'drop policy if exists tenant_update on accounting_credentials';
  execute 'drop policy if exists tenant_delete on accounting_credentials';

  execute 'create policy tenant_read on accounting_credentials for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on accounting_credentials for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  -- Present so a future grant cannot arrive without a policy behind it. The
  -- grants themselves are revoked below and the trigger refuses regardless of
  -- role (invariant 2).
  execute 'create policy tenant_update on accounting_credentials for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on accounting_credentials for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

-- Insert and select only. The revoke answers for app_rw and app_ro; it does not
-- answer for the table owner — the role migrations run as, the role a Supabase
-- SQL-editor session runs as, the role anybody with the database password gets
-- — which bypasses grants and RLS alike. 0004 pairs a revoke with a trigger for
-- exactly that reason, and the trigger is also what survives the next
-- `grant all` somebody writes in a hurry.
revoke all on accounting_credentials from app_rw;
revoke all on accounting_credentials from app_ro;
grant select, insert on accounting_credentials to app_rw;
grant select on accounting_credentials to app_ro;

drop trigger if exists no_update_delete on accounting_credentials;
create trigger no_update_delete before update or delete on accounting_credentials
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on accounting_credentials;
create trigger no_truncate before truncate on accounting_credentials
  for each statement execute function app.block_mutations();
