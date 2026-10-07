-- 0042 — a person opens a case by hand (ADR 0070).
--
-- What this does, and nothing else:
--   1. uploads.source admits 'manual_entry': the member typed the deduction
--      into the open-case form, and what they typed is stored as the case's
--      notice (ADR 0070 §1).
--   2. deduction_identifiers.source admits 'manual_entry'.
--   3. declined_candidates.discovered_from admits 'manual_entry'.
--      1–3 are migration 0014's rule: one list in three places, widened in the
--      same change, or the door opens on one side only.
--   4. deductions.discovered_via admits 'manual' (ADR 0070 §2).
--
-- Not here: document_arrivals. Its channel rule is
-- app.arrival_only_when_unknown(), which admits only the three doors that
-- existed before provenance was recorded, and a manual entry always records
-- its own arrival — so it keeps refusing 'manual_entry'.
--
-- No table, no column, no grant, no function. No UPDATE or DELETE grant on any
-- append-only table. Safe to run twice.

-- 1 ---------------------------------------------------------------------------
do $$
begin
  alter table uploads drop constraint if exists uploads_source_check;
  alter table uploads add constraint uploads_source_check check (
    source in (
      'web_upload',   -- a person added it
      'email_in',     -- an attachment on an inbound email
      'email_body',   -- the message itself was the notice (ADR 0016)
      'erp_sync',     -- found in the accounting ledger, never surfaced by anyone
      'portal_fetch', -- pulled from the retailer's own portal
      'edi_812',      -- the debit advice, which is the deduction document itself
      'manual_entry'  -- a person typed it into the open-case form (ADR 0070)
    )
  );
end
$$;

-- 2 ---------------------------------------------------------------------------
-- Declared inline by 0020, so its name was generated. Found by what it says;
-- the identifier_kind check does not name 'erp_sync' and is left alone.
do $$
declare
  name text;
begin
  select conname into name
    from pg_constraint
   where conrelid = 'deduction_identifiers'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%source%'
     and pg_get_constraintdef(oid) like '%erp_sync%';
  if name is not null then
    execute format('alter table deduction_identifiers drop constraint %I', name);
  end if;
  alter table deduction_identifiers drop constraint if exists deduction_identifiers_source_check;
  alter table deduction_identifiers add constraint deduction_identifiers_source_check check (
    source in ('web_upload', 'email_in', 'email_body', 'erp_sync', 'portal_fetch',
               'edi_812', 'manual_entry')
  );
end
$$;

-- 3 ---------------------------------------------------------------------------
-- Declared inline by 0014; no later migration changed its list.
do $$
declare
  name text;
begin
  select conname into name
    from pg_constraint
   where conrelid = 'declined_candidates'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%discovered_from%'
     and pg_get_constraintdef(oid) like '%erp_sync%';
  if name is not null then
    execute format('alter table declined_candidates drop constraint %I', name);
  end if;
  alter table declined_candidates drop constraint if exists declined_candidates_discovered_from_check;
  alter table declined_candidates add constraint declined_candidates_discovered_from_check check (
    discovered_from in ('web_upload', 'email_in', 'email_body', 'erp_sync', 'portal_fetch',
                        'edi_812', 'manual_entry')
  );
end
$$;

-- 4 ---------------------------------------------------------------------------
do $$
begin
  alter table deductions drop constraint if exists deductions_discovered_via_check;
  alter table deductions add constraint deductions_discovered_via_check check (
    discovered_via in (
      'notice',           -- a deduction_notice named it
      'remittance_line',  -- a line on a remittance advice paid the invoice short
      'report_row',       -- a row of a spreadsheet, read through a sheet mapping
      'manual'            -- a person entered it by hand (ADR 0070)
    )
  );
end
$$;
