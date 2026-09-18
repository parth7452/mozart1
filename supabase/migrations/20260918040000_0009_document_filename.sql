-- 0009 — Documents remember what they were called (ADR 0011).
--
-- Nullable: existing rows have no filename, and a document can legitimately
-- arrive without one. The value is supplier-supplied text — display it, never
-- trust it to decide a document's type or to build a path.

alter table documents add column if not exists filename text;
