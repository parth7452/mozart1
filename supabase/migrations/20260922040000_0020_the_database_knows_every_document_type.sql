-- 0020 — The database knows every document type the reader does (ADR 0025).
--
-- `DOC_TYPES` in packages/extraction/src/ports.ts has twelve values. The check
-- constraint migration 0004 wrote on `document_classifications.doc_type` lists
-- eleven: all of them except 'correspondence'. So a classifier answering with
-- the type a waiver, an approved reschedule or a written exception arrives as
-- — the document a dispute most often turns on — produced a read that did two
-- model calls, recorded their spend, and then died on its last cheap statement
-- with SQLSTATE 23514. In production that happened four times for one JPEG,
-- because the queue treated a constraint violation as something worth trying
-- again.
--
-- This is the only place in supabase/migrations/ that constrains a doc type.
-- `grep -rn "doc_type" supabase/migrations/` finds this constraint and the
-- `document_state` view that reads the column, and nothing else;
-- `extraction_results` and `model_calls` have no such column.
--
-- One constraint, and nothing else. No grant, no policy, no trigger, no
-- function: `document_classifications` stays INSERT + SELECT for `app_rw` the
-- way 0004 and 0006 left it, and widening a CHECK says nothing about whether a
-- row may be changed once written (invariant 2). Suite 16 re-asserts both.
--
-- It only widens. Every row already in the table names one of the eleven values
-- this constraint still admits, so the ADD is validated against the existing
-- rows and passes — nothing already stored is touched, rewritten or invalidated.
--
-- Idempotent: drop-then-add inside a `do $$` block, the way 0016 and 0018 add
-- a constraint, because scripts/db-test.sh applies every migration twice in one
-- run and the second pass has to be a no-op.

do $$
begin
  -- The twelve values of DOC_TYPES, in DOC_TYPES' own order, so the two lists
  -- can be read side by side. `packages/store-postgres/test/doc-types.test.ts`
  -- reads this constraint back out of pg_constraint and asserts the two sets
  -- are equal, in both directions: a type added to the code without a
  -- migration fails CI, and so does a value admitted here that no classifier
  -- can produce.
  alter table document_classifications
    drop constraint if exists document_classifications_doc_type_check;
  alter table document_classifications
    add constraint document_classifications_doc_type_check check (doc_type in (
      'deduction_notice',
      'remittance_advice',
      'invoice',
      'po',
      'bol',
      'pod',
      'asn',
      'correspondence',
      'promo_agreement',
      'price_agreement',
      'routing_guide',
      'other'));
end
$$;

comment on constraint document_classifications_doc_type_check on document_classifications is
  'Exactly the twelve values of DOC_TYPES in packages/extraction/src/ports.ts, '
  'kept identical to it by packages/store-postgres/test/doc-types.test.ts, '
  'which reads this constraint out of pg_constraint (ADR 0025). One of the '
  'twelve, correspondence, was missing from 0004: a read that classified a '
  'document as one spent two model calls and then could not store the answer.';

comment on column document_classifications.doc_type is
  'What the classifier said the document is, from DOC_TYPES. Append-only like '
  'the rest of the table: a re-classification is a new row and the latest wins '
  '(`document_state`). Widening this set needs a migration and an ADR, because '
  'the database is the referee for what the reader may say (ADR 0025).';
