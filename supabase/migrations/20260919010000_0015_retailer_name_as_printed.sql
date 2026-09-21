-- 0015 — A case keeps the retailer's name as the page printed it (ADR 0019).
--
-- `deductions.debtor_id` is a foreign key to `debtors`, whose (org_id,
-- retailer_key) is the seam Phase 2 playbooks hang off. Until a human has said
-- that "WALMART STORES, INC." and "Walmart" are the same debtor — which is what
-- `debtor_aliases` is for — an extracted name has nowhere to live, and every
-- case the pipeline opened read "Retailer unknown".
--
-- So the name is stored as display, not as identity. `openCase` looks a debtor
-- up and sets `debtor_id` only on exactly one match; it never creates one,
-- because document text is untrusted (invariant 4) and must not be able to mint
-- rows in a tenant's master data.
--
-- `deductions` is a mutable projection of the event stream, not an append-only
-- table, so a nullable column here changes no grant and no trigger.
alter table deductions
  add column if not exists retailer_name_as_printed text;

-- Untrusted text that the app renders. React escapes it and the view tests
-- assert that; the cap is so a pathological extraction cannot store a page.
do $$
begin
  alter table deductions drop constraint if exists deductions_retailer_name_as_printed_len;
  alter table deductions add constraint deductions_retailer_name_as_printed_len
    check (retailer_name_as_printed is null or length(retailer_name_as_printed) <= 500);
end
$$;

comment on column deductions.retailer_name_as_printed is
  'The retailer name exactly as extraction reported it, never rewritten. '
  'Display only — identity is debtor_id, which is set only when exactly one '
  'debtor matches (ADR 0019).';
