-- 0018 — A filed record is complete when written (ADR 0023).
--
-- Migration 0017 froze the record of what was filed: `packet_hash`,
-- `confirmation_number` and `submitted_at` may not be updated once a
-- `submissions` row exists, because they are the contents that went out, the
-- handle the retailer gave back, and the date every deadline and every
-- contingency fee is counted from (ADR 0022).
--
-- All three are nullable, and have been since 0005 declared them that way while
-- `submissions` was a table nothing wrote. Those two facts together leave a
-- row that can be inserted blank and is then blank forever: the only statement
-- that could record the reference afterwards is the update 0017 refuses. That
-- row is worse than no row — it satisfies `unique (decision_id, channel)`, and
-- the state machine has already moved the case to `submitted`, so the case
-- reads as filed with no record of what was filed.
--
-- `recordSubmission` writes all three in one insert and refuses an empty
-- confirmation number before it gets there. That is the store, on the near side
-- of the gate; what is being closed here is the database's permission, because
-- the database is the referee (invariant 2).
--
-- Two constraints, and nothing else. No grant, no policy, no trigger, no
-- function: `app.require_approval()` and `app.guard_immutable_core()` are not
-- edited, and nothing here could edit them. A check constraint runs *after* a
-- row-level BEFORE trigger, so the gate still answers first when an insert is
-- both unapproved and incomplete — `13_a_filed_record_is_complete.sql` asserts
-- exactly that rather than assuming it.
--
-- Idempotent: drop-then-add inside a `do $$` block, the way 0016 adds a
-- constraint, because `scripts/db-test.sh` applies every migration twice in one
-- run and the second pass has to be a no-op.

do $$
begin
  -- ---------------------------------------------------------------------
  -- 1. A manual filing is complete when it is written
  -- ---------------------------------------------------------------------
  -- Conditional on the channel rather than three plain NOT NULLs, and that is
  -- the decision rather than a shortcut to it (ADR 0023). `channel` already
  -- admits 'email' and 'portal_agent', neither of them built. ADR 0022 flags
  -- the first by name: an email dispute may be sent and learn its reference a
  -- week later. Under a NOT NULL that channel would have to insert a
  -- placeholder to get its row written — and 0017 freezes a placeholder
  -- exactly as it freezes a real reference, leaving something indistinguishable
  -- from a portal's answer in the column every follow-up reads. A null at least
  -- says "not known".
  --
  -- So the rule says what was actually decided: a filing recorded by a person
  -- who has *already filed* is complete when written, and 'manual_portal' is
  -- the channel where that is true (ADR 0020 §3 — one human, one insert, with
  -- what the portal gave back). Each other channel answers for itself in its
  -- own ADR and its own migration, and finds this predicate naming the one
  -- channel that was settled rather than a NOT NULL pretending they all were.
  alter table submissions drop constraint if exists submissions_manual_filing_is_complete;
  alter table submissions add constraint submissions_manual_filing_is_complete check (
    channel <> 'manual_portal'
    or (packet_hash is not null
        and confirmation_number is not null
        and submitted_at is not null)
  );

  -- ---------------------------------------------------------------------
  -- 2. A confirmation number is bounded, on any channel
  -- ---------------------------------------------------------------------
  -- 120 is `CONFIRMATION_MAX_LENGTH` in apps/web/lib/notices.ts, which the
  -- submit route refuses past rather than truncating: a reference cut to fit
  -- chases nothing and looks like one that would. The column is plain `text`,
  -- so until now that cap lived in one TypeScript constant and in nothing the
  -- database knew — and since 0017 an over-long reference that got past the
  -- route is one no update can trim.
  --
  -- Not conditional on the channel, because the cap is a fact about the value
  -- and not about how it was filed. `is null or` keeps it silent about a
  -- channel that supplies no reference at all.
  alter table submissions drop constraint if exists submissions_confirmation_number_length;
  alter table submissions add constraint submissions_confirmation_number_length check (
    confirmation_number is null or length(confirmation_number) <= 120
  );
end
$$;

comment on constraint submissions_manual_filing_is_complete on submissions is
  'A manual_portal submission names what went out, the reference that came '
  'back and the date it was filed, at insert. Migration 0017 made those three '
  'columns immutable, so a row written blank could never be completed; the '
  'complement of "you may not fill it in later" is "you must supply it at '
  'insert" (ADR 0023). Other channels answer for themselves in their own ADRs.';

comment on constraint submissions_confirmation_number_length on submissions is
  'The same 120 characters the submit route refuses past — '
  'CONFIRMATION_MAX_LENGTH in apps/web/lib/notices.ts — enforced where the '
  'referee is (ADR 0023). A reference too long to be recorded is one nobody '
  'can match back to the retailer, and since 0017 it is one no update can '
  'trim.';

comment on column submissions.confirmation_number is
  'The reference the retailer''s portal gave back. Immutable once written '
  '(ADR 0022), required at insert on manual_portal and capped at 120 '
  'characters (ADR 0023).';
