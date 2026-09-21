-- 0021 — A short-paid remittance line is a discovered deduction (ADR 0026).
--
-- `openCaseFromNotice` opens a case for `deduction_notice` and for nothing
-- else, so a remittance advice is scanned, classified, read and stored — and
-- then appears nowhere in the product. In staffing, freight and foodservice the
-- remittance IS the notice: the customer pays the invoice short and no separate
-- document is ever sent. Those deductions are the coverage thesis, sitting
-- inside a document we already paid to read.
--
-- Five changes, and nothing else.
--
--   1. `deductions.discovered_via` — whether this case was named by a notice or
--      by a line on a remittance. Deliberately NOT a seventh `uploads.source`:
--      the door the bytes came through and the kind of document that named the
--      deduction are two different facts, and `uploads` is append-only since
--      ADR 0024, so a row written under a confused meaning could not be
--      relabelled. Coverage slices by both (ADR 0026 §5).
--
--   2. `deductions.invoice_number` and `deductions.reason_code_as_printed` —
--      untrusted document text, stored as printed, capped, and used only as
--      lookup keys. Plus the partial index the dedup query reads.
--
--   3. `org_settings.remittance_tolerance_cents` / `remittance_tolerance_bps` —
--      the floor under which a short-pay is noise rather than a deduction.
--
--   4. `org_settings.remittance_dedup_days` — the window inside which the same
--      invoice for the same amount is one deduction arriving twice rather than
--      two deductions. NOT in the direction guard, on purpose: see §4 below.
--
--   5. `app.guard_threshold_direction()` gains the two tolerance columns, with
--      the direction argued in ADR 0026 §3 — for a tolerance, RAISING is the
--      loosening, which is the opposite sense from a ceiling.
--
-- What is deliberately NOT here: any edit to `app.require_approval()`,
-- `app.block_mutations()`, `app.member_may_write()` or
-- `app.arrival_only_when_unknown()`; any change to `uploads`,
-- `document_arrivals` or `declined_candidates`; any new table, any new policy,
-- and any new UPDATE or DELETE grant anywhere. `deductions` and `org_settings`
-- are mutable projections (migration 0006's `mutable` list), so nullable and
-- defaulted columns on them change no grant and fire no trigger — the same
-- argument migration 0015 made for `retailer_name_as_printed`.
--
-- Idempotent throughout: `add column if not exists`, drop-then-add for every
-- constraint, `create index if not exists`, `create or replace` for the
-- function. `scripts/db-test.sh` applies every migration twice in one run and
-- `supabase/tests/16_remittance_lines.sql` reads the end state back rather than
-- assuming it.

-- ---------------------------------------------------------------------------
-- 1. How this case was discovered: by a notice, or by a remittance line
-- ---------------------------------------------------------------------------
-- `default 'notice'` back-fills every existing row with what is true of it:
-- until this migration there was no other way for a case to be opened.
alter table deductions
  add column if not exists discovered_via text not null default 'notice';

do $$
begin
  alter table deductions drop constraint if exists deductions_discovered_via_check;
  alter table deductions add constraint deductions_discovered_via_check check (
    discovered_via in (
      'notice',          -- a deduction_notice named it: a claim somebody filed
      'remittance_line'  -- a line on a remittance advice paid the invoice short
    )
  );
end
$$;

comment on column deductions.discovered_via is
  'What kind of document named this deduction: a deduction notice, or a '
  'short-paid line on a remittance advice (ADR 0026). This is NOT the channel '
  'the bytes arrived through — that is uploads.source, observed at ingest and '
  'immutable since ADR 0024, and it is what declined_candidates.discovered_from '
  'is derived from. The two are orthogonal: a remittance arrives by web upload '
  'today and by edi_812 in Phase 2.5, and coverage is sliced by both.';

-- ---------------------------------------------------------------------------
-- 2. The invoice a deduction was taken against, and the code it was taken under
-- ---------------------------------------------------------------------------
-- Both are untrusted document text (invariant 4), stored exactly as printed and
-- never rewritten. `invoice_number` is a lookup key: it selects an existing case
-- for the dedup window, the way a printed retailer name may select a debtor and
-- never mint one (ADR 0019). `reason_code_as_printed` carries its warning in its
-- name — mapping a retailer's code to a canonical one is versioned,
-- effective-dated playbook *data* with provenance (Phase 2), not a column.
alter table deductions
  add column if not exists invoice_number text;
alter table deductions
  add column if not exists reason_code_as_printed text;

-- The caps exist for the reason 0015's does: a pathological extraction must not
-- be able to store a page in a column a view renders.
do $$
begin
  alter table deductions drop constraint if exists deductions_invoice_number_len;
  alter table deductions add constraint deductions_invoice_number_len
    check (invoice_number is null or length(invoice_number) <= 200);

  alter table deductions drop constraint if exists deductions_reason_code_as_printed_len;
  alter table deductions add constraint deductions_reason_code_as_printed_len
    check (reason_code_as_printed is null or length(reason_code_as_printed) <= 200);
end
$$;

comment on column deductions.invoice_number is
  'The supplier invoice this deduction was taken against, exactly as the '
  'document printed it. Untrusted text used as a lookup key and nothing else: '
  'the dedup window matches on it so that a notice and a remittance line for '
  'the same invoice and the same amount are one case rather than two (ADR '
  '0026 §8). Null when the document printed none, and a null falls back to the '
  'claim_id dedup alone — a merge on a missing key would merge everything.';

comment on column deductions.reason_code_as_printed is
  'The reason code exactly as the document printed it, never mapped. '
  'Display and lookup only — turning a retailer''s code into a canonical one '
  'is playbook data with provenance (Phase 2), not code and not this column.';

-- The dedup read is (org_id, invoice_number) with a date bound, so the partial
-- index is exactly the query. Partial because most rows have no invoice number
-- and an index entry for each of them is a page nobody reads.
create index if not exists deductions_org_invoice_idx
  on deductions (org_id, invoice_number)
  where invoice_number is not null;

-- ---------------------------------------------------------------------------
-- 3 & 4. The tolerance and the dedup window
-- ---------------------------------------------------------------------------
-- Defaults, not a measurement: $5.00, 50 basis points and 30 days are a guess
-- about a market. The first customer's real numbers should move them, and
-- moving the two tolerances downward — which files MORE cases — needs no
-- ceremony, while moving them up does. See the guard below.
alter table org_settings
  add column if not exists remittance_tolerance_cents bigint not null default 500;
alter table org_settings
  add column if not exists remittance_tolerance_bps integer not null default 50;
alter table org_settings
  add column if not exists remittance_dedup_days integer not null default 30;

do $$
begin
  alter table org_settings drop constraint if exists org_settings_remittance_tolerance_cents_check;
  alter table org_settings add constraint org_settings_remittance_tolerance_cents_check
    check (remittance_tolerance_cents >= 0);

  alter table org_settings drop constraint if exists org_settings_remittance_tolerance_bps_check;
  alter table org_settings add constraint org_settings_remittance_tolerance_bps_check
    check (remittance_tolerance_bps between 0 and 10000);

  alter table org_settings drop constraint if exists org_settings_remittance_dedup_days_check;
  alter table org_settings add constraint org_settings_remittance_dedup_days_check
    check (remittance_dedup_days >= 0);
end
$$;

comment on column org_settings.remittance_tolerance_cents is
  'The absolute floor under which a short-paid remittance line is noise rather '
  'than a deduction. A line clears the floor when delta >= this AND (the gross '
  'is unreadable OR delta * 10000 >= gross * remittance_tolerance_bps) — a '
  'cross-multiplication, so there is no division and no rounding anywhere '
  '(invariant 3). Lowering it opens MORE cases and is therefore the tightening; '
  'raising it is a loosening and needs an ADR (ADR 0026 §3).';

comment on column org_settings.remittance_tolerance_bps is
  'The proportional half of the same floor, in basis points of the invoice '
  'gross. Ignored when the line prints no readable gross: a delta over the '
  'absolute floor with nothing to proportion it against is still a deduction, '
  'and refusing it would lose a real case over a missing column. Lowering it '
  'is the tightening; raising it needs an ADR.';

comment on column org_settings.remittance_dedup_days is
  'How recently a case for the same invoice and the same exact amount must '
  'have been discovered for a second document naming it to merge into that '
  'case instead of opening another. Deliberately NOT in '
  'app.guard_threshold_direction(): neither direction is the conservative one '
  '— a longer window risks folding two different deductions into one case, a '
  'shorter one risks double-filing — so a guard here would assert a direction '
  'the mechanism does not have (ADR 0026 §4).';

-- ---------------------------------------------------------------------------
-- 5. The two tolerances join the direction guard (invariant 7)
-- ---------------------------------------------------------------------------
-- `create or replace`, in a new migration. Migration 0005 is merged and is not
-- edited (CLAUDE.md); this is how a function changes here, and db-test's second
-- pass re-applies 0005 and then this, which is why the end state is read back
-- by the suite rather than assumed.
--
-- All four of 0005's comparisons are kept verbatim. The two new ones read `>`,
-- like the ceilings — but they mean the opposite thing and the reason is worth
-- writing down where somebody editing this will see it:
--
--   * `auto_dispute_ceiling_cents` is a ceiling on what a machine may do
--     unattended. RAISING it lets a machine act on bigger claims: loosening.
--   * `min_decision_confidence` is a floor under how sure it must be. LOWERING
--     it lets a machine act on weaker evidence: loosening.
--   * `remittance_tolerance_*` is a floor under what counts as a deduction at
--     all. RAISING it makes the pipeline skip MORE short-pays — file fewer
--     cases, put fewer deductions in front of a person, and do it silently,
--     because a line that never becomes a case is a line nobody sees. That is
--     the loosening, and it is the kind whose cost only shows up months later
--     when the windows it skipped have closed.
--
-- Nothing else about the function changes: same name, same signature, same
-- `new.updated_at := now()`, same trigger (which is left in place — replacing
-- the function body is enough, and dropping the trigger would open a window in
-- which an UPDATE went unguarded).
create or replace function app.guard_threshold_direction() returns trigger
  language plpgsql as $$
declare
  adr text := nullif(current_setting('app.threshold_loosening_adr', true), '');
  loosened text[] := '{}';
begin
  if new.auto_dispute_ceiling_cents > old.auto_dispute_ceiling_cents then
    loosened := loosened || 'auto_dispute_ceiling_cents'::text;
  end if;
  if new.auto_writeoff_ceiling_cents > old.auto_writeoff_ceiling_cents then
    loosened := loosened || 'auto_writeoff_ceiling_cents'::text;
  end if;
  if new.min_classification_confidence < old.min_classification_confidence then
    loosened := loosened || 'min_classification_confidence'::text;
  end if;
  if new.min_decision_confidence < old.min_decision_confidence then
    loosened := loosened || 'min_decision_confidence'::text;
  end if;
  -- A higher tolerance skips more short-paid lines, so it is the loosening
  -- (ADR 0026 §3).
  if new.remittance_tolerance_cents > old.remittance_tolerance_cents then
    loosened := loosened || 'remittance_tolerance_cents'::text;
  end if;
  if new.remittance_tolerance_bps > old.remittance_tolerance_bps then
    loosened := loosened || 'remittance_tolerance_bps'::text;
  end if;

  if array_length(loosened, 1) is not null and adr is null then
    raise exception
      'threshold loosening blocked (%): set app.threshold_loosening_adr to the authorising ADR',
      array_to_string(loosened, ', ')
      using errcode = 'restrict_violation';
  end if;

  new.updated_at := now();
  return new;
end
$$;

comment on function app.guard_threshold_direction() is
  'Invariant 7: thresholds auto-tighten, never auto-loosen. A ceiling loosens '
  'upward, a confidence floor loosens downward, and a remittance tolerance '
  'loosens upward because raising it skips more short-paid lines silently '
  '(ADR 0026 §3). remittance_dedup_days is deliberately absent — it has no '
  'conservative direction.';
