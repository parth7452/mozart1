-- 0017 — The record of what was filed is immutable (ADR 0022).
--
-- `app.guard_immutable_core()` (migration 0010) froze the columns that decide
-- *what was authorised* — id, org_id, deduction_id, decision_id, plus one per
-- table. On `submissions` that left `packet_hash`, `confirmation_number` and
-- `submitted_at` rewritable by any writer in the tenant, and those three are the
-- record of what was *filed*:
--
--   * `packet_hash` is the contents that went out. The store refuses a
--     submission whose hash differs from its approval's (ADR 0020 §2) — once,
--     at insert. A column that can be rewritten afterwards turns that check
--     into a formality and leaves the row reading as evidence that a human
--     approved contents nobody approved.
--   * `confirmation_number` is the only handle anybody has on a dispute sitting
--     in a retailer's portal. The submit route already refuses one that is too
--     long rather than truncating it; one that can be rewritten a month later
--     is the same failure with a longer fuse.
--   * `submitted_at` is what a dispute deadline and every follow-up are counted
--     from, and what Phase 4 will attribute a contingency fee against.
--
-- Nothing in the application updates a `submissions` row — `recordSubmission`
-- writes all three once, at insert, in the same transaction as the event and the
-- state change. What is being closed is the database's permission, because the
-- database is the referee (invariant 2).
--
-- `status` stays mutable: `recorded → sent → accepted → rejected` describes
-- where a filing got to, not what was filed, and `unique (decision_id, channel)`
-- means a retailer's answer cannot be recorded as a second row.
--
-- What is deliberately NOT here: any change to `app.require_approval()`, to any
-- grant, to any policy, or to the guard's other branches. The gate keeps its one
-- rule; this is one column list getting three entries longer.
--
-- Idempotent: `create or replace` is re-runnable by construction, which
-- `scripts/db-test.sh` proves by applying every migration twice in one run.

-- ---------------------------------------------------------------------------
-- The guard, with three more columns on the submissions branch
-- ---------------------------------------------------------------------------
-- Every other branch is byte-identical to 0010's: `writebacks` keeps `method`,
-- `writeoffs` keeps `amount_cents`, the four shared columns stay shared, and the
-- comparison is still made through `to_jsonb` — plpgsql resolves a record field
-- even inside a guarded branch, so `new.method` would raise on a table that has
-- no such column.
--
-- A dedicated submissions-only trigger was the alternative and is worse in the
-- way that matters here: one function is the answer to "what can never change
-- once written", and a reviewer reads one column list to know it. Two triggers
-- would mean two lists, two messages for one rule, and a firing-order question
-- (`enforce_approval_on_update` sorts before `guard_immutable_core`, which is
-- why suite 07 expects the *gate's* words when a row is repointed at an
-- unapproved decision) that nobody should have to re-answer (ADR 0022).
--
-- `set search_path` is part of the definition rather than an ALTER afterwards:
-- CREATE OR REPLACE assigns every property from the command, so a replacement
-- that omitted it would silently drop the pin 0008 and 0010 §4 put on this
-- function — and this function decides whether a write is allowed.
create or replace function app.guard_immutable_core() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, extensions
as $$
declare
  immutable_cols text[] := array['id', 'org_id', 'deduction_id', 'decision_id'] ||
    case tg_table_name
      -- The channel it went out on, and the record of what went out: the
      -- packet's hash, the reference that came back, and when it was filed
      -- (ADR 0022). `status` is absent on purpose — it is the one legitimate
      -- update a submission has.
      when 'submissions' then array['channel', 'packet_hash', 'confirmation_number',
                                    'submitted_at']
      when 'writebacks' then array['method']
      when 'writeoffs' then array['amount_cents']
      else '{}'::text[]
    end;
  before_row jsonb := to_jsonb(old);
  after_row jsonb := to_jsonb(new);
  changed text[] := '{}';
  col text;
begin
  foreach col in array immutable_cols loop
    if before_row -> col is distinct from after_row -> col then
      changed := changed || col;
    end if;
  end loop;

  if array_length(changed, 1) is not null then
    raise exception
      '% is immutable once written (%): record a new fact, do not rewrite the old one',
      tg_table_name, array_to_string(changed, ', ')
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function app.guard_immutable_core() is
  'Refuses an update to the columns that say what was authorised and, on '
  'submissions, what was filed: the packet hash, the confirmation number and '
  'the filing date. `status` stays mutable — recorded → sent → accepted → '
  'rejected is where a filing got to, not what was filed (ADR 0022).';

-- The triggers themselves are migration 0010's and are untouched: this replaces
-- the function they already call. Nothing is granted, revoked or re-policied
-- here, and `app.require_approval()` is not edited — it still asks its one
-- question on INSERT and on UPDATE.
