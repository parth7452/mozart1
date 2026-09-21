-- 0022 — A short-paid remittance line is a discovered deduction (ADR 0028).
--
-- `openCaseFromNotice` opens a case for `deduction_notice` and for nothing
-- else, so a remittance advice is scanned, classified, read and stored — and
-- then appears nowhere in the product. In staffing, freight and foodservice the
-- remittance IS the notice: the customer pays the invoice short and no separate
-- document is ever sent. Those deductions are the coverage thesis, sitting
-- inside a document we already paid to read.
--
-- Four changes, and nothing else.
--
--   1. `deductions.discovered_via` — whether this case was named by a notice or
--      by a line on a remittance. Deliberately NOT a seventh `uploads.source`:
--      the door the bytes came through and the kind of document that named the
--      deduction are two different facts, and `uploads` is append-only since
--      ADR 0024, so a row written under a confused meaning could not be
--      relabelled. Coverage slices by both (ADR 0028 §5).
--
--   2. `deductions.reason_code_as_printed` — the code the payer printed beside
--      the short-pay, untrusted text stored verbatim and never mapped.
--
--   3. `org_settings.remittance_tolerance_cents` / `remittance_tolerance_bps` /
--      `remittance_dedup_days` — the floor under which a short-pay is noise,
--      and the window two printings of one deduction may differ by.
--
--   4. `app.guard_threshold_direction()` gains the two tolerance columns, with
--      the direction argued in ADR 0028 §3 — for a tolerance, RAISING is the
--      loosening, which is the opposite sense from a ceiling.
--
-- **There is deliberately no `deductions.invoice_number`.** Migration 0020 made
-- a deduction's names their own table: `deduction_identifiers`, source-qualified,
-- append-only, one kind per row, with `invoice_number` already among the kinds
-- it admits. A column here would be a second, mutable place for the same fact,
-- and the two would disagree the first time a portal or an EDI 812 named the
-- same invoice differently. So a remittance line writes an identifier row, the
-- notice path writes one too, and the dedup decision is `resolveIdentity` over
-- that table (ADR 0028 §6, ADR 0025). That is also why this migration adds no
-- index on an invoice number: `deduction_identifiers` carries its own, and the
-- `unique (org_id, source, identifier_kind, identifier)` it already has is the
-- one the lookup rides.
--
-- Nothing about `deduction_identifiers` changes here either. Its `source` check
-- admits the six `uploads.source` channels, and a remittance line's source is
-- the channel its document arrived through — which is one of those six. No
-- widening was needed.
--
-- What is otherwise deliberately NOT here: any edit to `app.require_approval()`,
-- `app.block_mutations()`, `app.member_may_write()` or
-- `app.arrival_only_when_unknown()`; any change to `uploads`,
-- `document_arrivals`, `declined_candidates` or `deduction_identifiers`; any new
-- table, any new policy, and any new UPDATE or DELETE grant anywhere.
-- `deductions` and `org_settings` are mutable projections (migration 0006's
-- `mutable` list), so nullable and defaulted columns on them change no grant and
-- fire no trigger — the same argument migration 0015 made for
-- `retailer_name_as_printed`.
--
-- Idempotent throughout: `add column if not exists`, drop-then-add for every
-- constraint, `create or replace` for the function. `scripts/db-test.sh` applies
-- every migration twice in one run and `supabase/tests/18_remittance_lines.sql`
-- reads the end state back rather than assuming it.

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
  'short-paid line on a remittance advice (ADR 0028). This is NOT the channel '
  'the bytes arrived through — that is uploads.source, observed at ingest and '
  'immutable since ADR 0024, and it is what declined_candidates.discovered_from '
  'is derived from. The two are orthogonal: a remittance arrives by web upload '
  'today and by edi_812 in Phase 2.5, and coverage is sliced by both.';

-- ---------------------------------------------------------------------------
-- 2. The code the short-pay was taken under
-- ---------------------------------------------------------------------------
-- Untrusted document text (invariant 4), stored exactly as printed and never
-- rewritten. Its name carries its own warning, the way `retailer_name_as_printed`
-- does: mapping a payer's code to a canonical one is versioned, effective-dated
-- playbook *data* with provenance (Phase 2), not a column and not code.
--
-- The invoice number that used to sit beside this is in `deduction_identifiers`
-- instead — see the header.
alter table deductions
  add column if not exists reason_code_as_printed text;

-- The cap exists for the reason 0015's does: a pathological extraction must not
-- be able to store a page in a column a view renders. 200, the same bound
-- `deduction_identifiers.identifier` uses, so an identifier and a code that
-- travel together on one line are measured the same way.
do $$
begin
  alter table deductions drop constraint if exists deductions_reason_code_as_printed_len;
  alter table deductions add constraint deductions_reason_code_as_printed_len
    check (reason_code_as_printed is null or length(reason_code_as_printed) <= 200);
end
$$;

comment on column deductions.reason_code_as_printed is
  'The reason code exactly as the document printed it, never mapped. '
  'Display only — turning a payer''s code into a canonical one is playbook '
  'data with provenance (Phase 2), not code and not this column.';

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
  'raising it is a loosening and needs an ADR (ADR 0028 §3).';

comment on column org_settings.remittance_tolerance_bps is
  'The proportional half of the same floor, in basis points of the invoice '
  'gross. Ignored when the line prints no readable gross: a delta over the '
  'absolute floor with nothing to proportion it against is still a deduction, '
  'and refusing it would lose a real case over a missing column. Lowering it '
  'is the tightening; raising it needs an ADR.';

comment on column org_settings.remittance_dedup_days is
  'How far apart two printings of one deduction date may be and still be one '
  'deduction — resolveIdentity''s dateToleranceDays for the probable branch '
  '(ADR 0025). Deliberately NOT in app.guard_threshold_direction(): neither '
  'direction is the conservative one — a longer window flags more probable '
  'duplicates for a person, a shorter one flags fewer — so a guard here would '
  'assert a direction the mechanism does not have (ADR 0028 §4).';

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
  -- (ADR 0028 §3).
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
  '(ADR 0028 §3). remittance_dedup_days is deliberately absent — it has no '
  'conservative direction.';
