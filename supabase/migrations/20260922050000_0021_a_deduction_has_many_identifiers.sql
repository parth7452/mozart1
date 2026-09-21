-- 0021 — A deduction has many identifiers and one row (ADR 0027).
--
-- The same deduction reaches us under up to four different names: a credit memo
-- in the accounting ledger, an adjustment line on an EDI 812, a claim id in the
-- retailer's portal, and the claim id printed on a notice somebody uploaded.
-- `deductions` holds one nullable `claim_id` (migration 0003), so the second
-- source has nowhere to put what it knows. It then either opens a second case
-- for a deduction we already have, or folds itself into a row it does not
-- belong to — and the second failure is the dangerous one, because the
-- deduction that arrived is then never disputed and nothing records that it was
-- ever seen (docs/STRATEGY.md §5.2, CH-3).
--
-- So identifiers become their own table, and the resolution gate that reads it
-- is asymmetric: an exact match resolves, a probable match is held for a human,
-- and nothing else is merged. `packages/core-domain/src/identity.ts` is that
-- matcher — deterministic code, no model, no I/O.
--
-- What is deliberately NOT here:
--
--   * No change to `deductions.claim_id` and no change to
--     `unique (org_id, debtor_id, claim_id)`. A merged migration is never
--     edited (CLAUDE.md), and that constraint is the only thing that currently
--     catches a re-upload (ADR 0019). This table is additive; the column is one
--     special case of it, and the backfill below makes the two agree from the
--     first day.
--   * No change to `app.require_approval()`, to any existing grant, or to any
--     existing policy. Nothing here can insert a submission, a write-back or a
--     write-off.
--
-- Idempotent throughout — `if not exists`, drop-then-create, and a backfill that
-- conflicts away to nothing on a second pass — because `scripts/db-test.sh`
-- applies every migration twice in one run and proves exactly that.

-- ---------------------------------------------------------------------------
-- 0. The tenancy tie a foreign key does not carry
-- ---------------------------------------------------------------------------
-- An identifier row names an org and a deduction. Two separate foreign keys say
-- each id exists; neither says they are the same tenant's, and RLS does not
-- either — it asks whether `org_id` is mine, not whether `deduction_id` is. The
-- hole migration 0016 closed for `packets` with a trigger closes here
-- declaratively, because identity is the one place where pointing at the wrong
-- row is catastrophic: an identifier this tenant can read, hung off another
-- tenant's deduction, would make the matcher resolve onto a case the tenant
-- cannot open.
--
-- `unique (org_id, id)` on `deductions` is implied by the primary key and costs
-- one index. It is additive: no column, no grant and no policy changes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'deductions'::regclass
       and conname = 'deductions_org_id_id_key'
  ) then
    alter table deductions add constraint deductions_org_id_id_key unique (org_id, id);
  end if;
end
$$;

comment on constraint deductions_org_id_id_key on deductions is
  'Lets a child table key on (org_id, deduction_id) and get the tenancy tie '
  'with it, rather than trusting two independent foreign keys (ADR 0027 §7).';

-- ---------------------------------------------------------------------------
-- 1. The identifiers a deduction is known by
-- ---------------------------------------------------------------------------
-- Append-only, like every other record of a fact here (invariant 2, ADR 0004).
-- "This deduction was called CM-8812 in the ledger" is true of a moment and
-- stays true; learning a better name is a second row, not an edit of the first.
-- It is also the post-audit defence: which deduction a packet was arguing has to
-- be reconstructible two years later, and a mutable identity table would make
-- every such reconstruction a matter of trust.
create table if not exists deduction_identifiers (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  deduction_id    uuid not null references deductions(id),
  -- Which source said so. The same set `uploads.source` admits: a source that
  -- can deliver a deduction can name one. Migration 0014 owns this list — add a
  -- source there and here in the same change, or the door opens on one side
  -- only.
  source          text not null check (
    source in (
      'web_upload',   -- a person added it
      'email_in',     -- an attachment on an inbound email
      'email_body',   -- the message itself was the notice (ADR 0016)
      'erp_sync',     -- found in the accounting ledger, never surfaced by anyone
      'portal_fetch', -- pulled from the retailer's own portal
      'edi_812'       -- the debit advice, which is the deduction document itself
    )
  ),
  -- What kind of name it is. A portal claim id and a ledger invoice id are not
  -- comparable even when they read alike, so the kind travels with the value
  -- and the matcher compares within a kind.
  identifier_kind text not null check (
    identifier_kind in (
      'claim_id',           -- what a deduction notice prints
      'invoice_number',     -- the invoice the deduction was taken against
      'credit_memo_id',     -- the accounting ledger's own handle
      'edi_812_reference',  -- the adjustment line's reference
      'portal_claim_id',    -- the retailer portal's handle
      'ledger_invoice_id'   -- the invoice as the ledger numbers it
    )
  ),
  -- Verbatim, exactly as the source printed or returned it — never a cleaned-up
  -- version. Normalisation is a comparison, not a rewrite (ADR 0027 §4), the
  -- same rule `retailer_name_as_printed` follows.
  --
  -- Untrusted text, so it is bounded, and an over-long one is refused rather
  -- than truncated: half an identifier is not an identifier, and a truncated one
  -- would go on to match a deduction the source never named (ADR 0019 §1).
  identifier      text not null check (
    length(identifier) between 1 and 200 and btrim(identifier) <> ''
  ),
  first_seen_at   timestamptz not null default now(),
  -- One identifier resolves to one deduction, per tenant and per source.
  -- *Per source* on purpose: two sources printing the same string is the normal
  -- case — the portal's claim id is often the notice's — and it is evidence
  -- rather than a collision. What must never happen is one source handing the
  -- same name to two deductions, and that is what this refuses.
  unique (org_id, source, identifier_kind, identifier),
  -- The tenancy tie (§0). `deduction_id`'s own foreign key above says the
  -- deduction exists; this says it is this tenant's.
  constraint deduction_identifiers_same_org
    foreign key (org_id, deduction_id) references deductions (org_id, id)
);

comment on table deduction_identifiers is
  'Every name a deduction is known by, source-qualified and append-only. The '
  'matcher that reads it resolves only on an exact match and holds a probable '
  'one for a human — a wrong merge silently destroys a disputable deduction '
  '(ADR 0027).';

comment on column deduction_identifiers.identifier is
  'Verbatim as the source printed or returned it. Comparison normalises (trim, '
  'case-fold, collapse whitespace) in TypeScript; the stored value never does.';

create index if not exists deduction_identifiers_deduction_idx
  on deduction_identifiers (org_id, deduction_id);

alter table deduction_identifiers enable row level security;

-- One policy per command, the pattern from ADR 0012 and migration 0014: a single
-- policy's USING clause governs reads and the row-selection half of writes
-- alike, so a role predicate there would have blocked reading too.
do $$
begin
  execute 'drop policy if exists tenant_isolation on deduction_identifiers';
  execute 'drop policy if exists tenant_read on deduction_identifiers';
  execute 'drop policy if exists tenant_insert on deduction_identifiers';
  execute 'drop policy if exists tenant_update on deduction_identifiers';
  execute 'drop policy if exists tenant_delete on deduction_identifiers';

  execute 'create policy tenant_read on deduction_identifiers for select
             using (org_id = app.current_org_id())';
  execute 'create policy tenant_insert on deduction_identifiers for insert
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_update on deduction_identifiers for update
             using (org_id = app.current_org_id() and app.member_may_write())
             with check (org_id = app.current_org_id() and app.member_may_write())';
  execute 'create policy tenant_delete on deduction_identifiers for delete
             using (org_id = app.current_org_id() and app.member_may_write())';
end
$$;

-- Insert and select only. The update/delete policies above exist so that a
-- future grant cannot silently arrive without one; the grant itself is revoked
-- and the trigger refuses regardless of role (invariant 2).
grant select, insert on deduction_identifiers to app_rw;
grant select on deduction_identifiers to app_ro;
revoke update, delete, truncate on deduction_identifiers from app_rw;
revoke update, delete, truncate on deduction_identifiers from app_ro;

drop trigger if exists no_update_delete on deduction_identifiers;
create trigger no_update_delete before update or delete on deduction_identifiers
  for each row execute function app.block_mutations();
drop trigger if exists no_truncate on deduction_identifiers;
create trigger no_truncate before truncate on deduction_identifiers
  for each statement execute function app.block_mutations();

-- ---------------------------------------------------------------------------
-- 2. Backfill: every claim id we already hold, said in the new place
-- ---------------------------------------------------------------------------
-- One row per existing non-null `deductions.claim_id`, so the table is complete
-- from its first day rather than from whenever the next source happens to write
-- to it. The column itself is untouched.
--
-- `source` is looked up rather than assumed where the database can answer it:
-- the case's earliest notice document names an `uploads` row (migration 0003's
-- `documents.upload_id`, written since 2026-09-21), and that upload knows which
-- door the notice came through. Where it cannot be known — documents ingested
-- before anything wrote `uploads` — the value is `web_upload`, which is what
-- every case in that era actually was: the app's upload route and the email
-- path are the only two ingesters that ever ran, and the email path is younger
-- than the uploads row. It is stated here rather than left to be inferred from
-- the data later.
--
-- `first_seen_at` is the deduction's own `created_at`, not `now()`. When we
-- first saw this claim id is a recorded fact, and the default would replace it
-- with the date of the migration.
--
-- It is a function rather than a bare statement for one reason: a backfill that
-- exists only as a line inside a migration cannot be tested. Running it against
-- a scratch database proves nothing, because a scratch database has no rows at
-- migration time. `supabase/tests/15_…` calls this function over rows it seeded
-- itself, so what the suite exercises is the statement that actually ran in
-- production rather than a second copy of it written out in the test.
--
-- Invoker rights, deliberately. Called here it runs as the migration's owner and
-- sees every tenant; called by anyone else it runs under RLS and can only
-- backfill what that tenant can already read. Either way it inserts nothing that
-- was not already in `deductions`.
create or replace function app.backfill_claim_id_identifiers() returns integer
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  inserted int;
  missing int;
  sample text;
begin
  insert into deduction_identifiers
    (org_id, deduction_id, source, identifier_kind, identifier, first_seen_at)
  select d.org_id,
         d.id,
         coalesce(u.source, 'web_upload'),
         'claim_id',
         d.claim_id,
         d.created_at
    from deductions d
    left join lateral (
      select up.source
        from deduction_documents dd
        join documents doc on doc.id = dd.document_id
        join uploads up on up.id = doc.upload_id
       where dd.deduction_id = d.id
         and dd.role = 'notice'
       order by dd.observed_at, dd.id
       limit 1
    ) u on true
   where d.claim_id is not null
     and length(d.claim_id) between 1 and 200
     and btrim(d.claim_id) <> ''
     -- Already said, on a re-run or on the second pass of `db:test`. The unique
     -- constraint would catch it too; this keeps the row count honest.
     and not exists (
       select 1 from deduction_identifiers i
        where i.deduction_id = d.id and i.identifier_kind = 'claim_id')
   -- Oldest case first, so that where two cases share a claim id the one that
   -- was opened first keeps it. Which one wins is not a judgement about which is
   -- right — it is only a rule that does not depend on scan order.
   order by d.created_at, d.id
  on conflict (org_id, source, identifier_kind, identifier) do nothing;

  get diagnostics inserted = row_count;

  -- A claim id that did not make it across is reported, not swallowed. There are
  -- exactly two ways to land here and neither is something a backfill may
  -- decide: another case in the same tenant already holds that identifier for
  -- that source — two cases for one deduction, which is the pair identity
  -- resolution exists to merge (STRATEGY §5.2) — or the value does not fit the
  -- column's bounds. Deduction ids only: a claim id is text off an untrusted
  -- document and does not belong in a deploy log.
  select count(*) into missing
    from deductions d
   where d.claim_id is not null
     and not exists (
       select 1 from deduction_identifiers i
        where i.deduction_id = d.id and i.identifier_kind = 'claim_id');

  if missing > 0 then
    select string_agg(s.id::text, ', ') into sample from (
      select d.id, d.created_at
        from deductions d
       where d.claim_id is not null
         and not exists (
           select 1 from deduction_identifiers i
            where i.deduction_id = d.id and i.identifier_kind = 'claim_id')
       order by d.created_at, d.id
       limit 20
    ) s;
    raise warning
      'backfill_claim_id_identifiers: % deduction(s) carry a claim id with no '
      'identifier row — either another case already holds it for that source '
      '(two cases for one deduction: merging them is STRATEGY 5.2, not this '
      'migration) or it does not fit the column bounds. First up to 20: %',
      missing, sample;
  end if;

  return inserted;
end
$$;

comment on function app.backfill_claim_id_identifiers() is
  'One identifier row per existing deductions.claim_id, with the source looked '
  'up from the notice document''s upload where that is knowable. Idempotent, '
  'and it reports rather than chooses when a claim id is already held by '
  'another case (ADR 0027).';

select app.backfill_claim_id_identifiers();
