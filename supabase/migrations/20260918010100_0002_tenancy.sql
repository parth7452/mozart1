-- 0002 — Organisations, users, memberships, per-tenant settings.

create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text,
  created_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_role') then
    create type membership_role as enum
      ('owner', 'approver', 'analyst', 'read_only', 'accountant_guest');
  end if;
end
$$;

create table if not exists memberships (
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references users(id),
  role        membership_role not null,
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Contract terms and safety ceilings, mirrored in-product (plan §14, §17).
create table if not exists org_settings (
  org_id                        uuid primary key references organizations(id),
  -- Ceilings: the largest claim an automated path may act on without a human.
  auto_dispute_ceiling_cents    bigint not null default 50000  check (auto_dispute_ceiling_cents >= 0),
  auto_writeoff_ceiling_cents   bigint not null default 0      check (auto_writeoff_ceiling_cents >= 0),
  -- Minimum calibrated confidence for any automated path.
  min_classification_confidence numeric(4,3) not null default 0.950
    check (min_classification_confidence between 0 and 1),
  min_decision_confidence       numeric(4,3) not null default 0.950
    check (min_decision_confidence between 0 and 1),
  -- Contract terms.
  look_back_days                integer not null default 365 check (look_back_days >= 0),
  tail_period_days              integer not null default 90  check (tail_period_days >= 0),
  min_claim_cents               bigint  not null default 2500 check (min_claim_cents >= 0),
  fee_pct_bps                   integer not null default 2500 check (fee_pct_bps between 0 and 10000),
  updated_at                    timestamptz not null default now()
);

create index if not exists memberships_user_idx on memberships (user_id);
