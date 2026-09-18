-- 0003 — Debtors, documents and the case + decision spine.
-- Phase 0 creates only what the invariants need to be provable. Playbooks,
-- evidence, extraction, outcomes and the fee ledger arrive in their own phases.

create table if not exists debtors (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  retailer_key  text not null,
  display_name  text not null,
  created_at    timestamptz not null default now(),
  unique (org_id, retailer_key)
);

create table if not exists debtor_aliases (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  debtor_id   uuid not null references debtors(id),
  alias       text not null,
  created_at  timestamptz not null default now()
);

create table if not exists uploads (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  source        text not null check (source in ('web_upload', 'email_in')),
  received_at   timestamptz not null default now(),
  created_by    uuid references users(id)
);

-- Append-only (immutability enforced in 0004): a document row is an immutable
-- fact about bytes we received, and nothing else. Mutable judgements about a
-- document (scan verdict, doc type) are separate append-only rows, so we never
-- need an UPDATE here. Re-uploads dedupe on (org_id, sha256).
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  upload_id     uuid references uploads(id),
  sha256        bytea not null,
  byte_size     bigint not null check (byte_size > 0),
  mime_type     text not null,
  storage_ref   text not null,
  created_at    timestamptz not null default now(),
  unique (org_id, sha256)
);

create table if not exists deductions (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id),
  debtor_id               uuid references debtors(id),
  claim_id                text,
  -- Projection of the append-only event stream (plan §6).
  state                   text not null default 'discovered' check (state in (
                            'discovered', 'classified', 'evidence_pending',
                            'evidence_complete', 'decided', 'auto_dispute_queued',
                            'analyst_review', 'auto_writeoff_queued',
                            'awaiting_approval', 'submitted', 'won', 'lost',
                            'partial', 'written_off')),
  deduction_amount_cents  bigint not null check (deduction_amount_cents > 0),
  deduction_date          date,
  dispute_deadline        date,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, debtor_id, claim_id)
);

-- Every decision persists provider, versions, input hash, raw probabilities,
-- latency and cost (invariant 5).
create table if not exists decisions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id),
  deduction_id      uuid not null references deductions(id),
  schema_id         text not null check (schema_id in ('A', 'B', 'C', 'D')),
  schema_version    text not null,
  provider          text not null check (provider in ('jev', 'claude-structured')),
  model_version     text not null,
  input_state_hash  bytea not null,
  questions         jsonb not null,
  result            jsonb not null,
  raw_probabilities jsonb not null,
  confidence        numeric(5,4) not null check (confidence between 0 and 1),
  latency_ms        integer not null check (latency_ms >= 0),
  cost_micros       bigint not null default 0 check (cost_micros >= 0),
  -- Separation of duties: whoever prepared a decision may not approve it.
  prepared_by       uuid references users(id),
  created_at        timestamptz not null default now()
);

create index if not exists debtor_aliases_debtor_idx on debtor_aliases (org_id, debtor_id);
create index if not exists documents_org_idx on documents (org_id, created_at desc);
create index if not exists deductions_org_state_idx on deductions (org_id, state);
create index if not exists deductions_deadline_idx on deductions (org_id, dispute_deadline)
  where dispute_deadline is not null;
create index if not exists decisions_deduction_idx on decisions (org_id, deduction_id, created_at desc);
