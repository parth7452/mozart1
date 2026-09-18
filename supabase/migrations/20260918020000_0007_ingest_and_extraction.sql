-- 0007 — Phase 1: ingest, classification and extraction (ADR 0007).
--
-- Every table here is append-only: an extraction is a claim about what a
-- document said at a point in time, and a re-extraction is a new claim, not an
-- edit of the old one.

-- Which case a document belongs to, and why it is there.
create table if not exists deduction_documents (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references organizations(id),
  deduction_id  uuid not null references deductions(id),
  document_id   uuid not null references documents(id),
  role          text not null check (role in ('notice', 'evidence', 'remittance', 'context')),
  observed_at   timestamptz not null default now(),
  unique (deduction_id, document_id, role)
);

-- One row per page. page_number is 1-indexed to match what a reviewer sees and
-- what the model is told to cite.
create table if not exists document_pages (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references organizations(id),
  document_id   uuid not null references documents(id),
  page_number   integer not null check (page_number >= 1),
  width_px      integer check (width_px > 0),
  height_px     integer check (height_px > 0),
  image_ref     text,
  text_layer    text,
  observed_at   timestamptz not null default now(),
  unique (document_id, page_number)
);

-- One row per extracted field.
--
-- source_page and source_quote are required: a field we cannot point at in the
-- document is a field we do not have. source_bbox is nullable by design — a
-- vision model's box is an estimate, and the reviewer UI highlights the quote
-- (ADR 0007). When present it is normalised [x0, y0, x1, y1] in 0..1.
create table if not exists extraction_results (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references organizations(id),
  document_id   uuid not null references documents(id),
  deduction_id  uuid references deductions(id),
  -- Dotted path into the extraction schema, e.g. 'lines[0].deduction_amount_cents'.
  field_path    text not null,
  value_json    jsonb not null,
  confidence    numeric(5,4) not null check (confidence between 0 and 1),
  source_page   integer not null check (source_page >= 1),
  source_quote  text not null check (length(source_quote) between 1 and 2000),
  source_bbox   numeric(6,5)[] check (
                  source_bbox is null or (
                    array_length(source_bbox, 1) = 4
                    and source_bbox[1] between 0 and 1 and source_bbox[2] between 0 and 1
                    and source_bbox[3] between 0 and 1 and source_bbox[4] between 0 and 1
                    and source_bbox[3] >= source_bbox[1] and source_bbox[4] >= source_bbox[2]
                  )),
  -- Did the quote actually appear in the page's text layer? Null when there is
  -- no text layer to check against (a scanned page).
  quote_verified boolean,
  extractor     text not null,
  model_version text not null,
  schema_version text not null,
  observed_at   timestamptz not null default now()
);

-- Every model call, not only the ones that produce a decision. This is what the
-- per-case cost model in the build plan is measured against.
create table if not exists model_calls (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references organizations(id),
  purpose         text not null check (purpose in
                    ('classify', 'extract', 'verify', 'narrative', 'decide', 'playbook_draft')),
  provider        text not null check (provider in ('anthropic', 'reducto', 'jev')),
  model_version   text not null,
  document_id     uuid references documents(id),
  deduction_id    uuid references deductions(id),
  input_tokens    integer check (input_tokens >= 0),
  output_tokens   integer check (output_tokens >= 0),
  cached_tokens   integer check (cached_tokens >= 0),
  cost_micros     bigint not null default 0 check (cost_micros >= 0),
  latency_ms      integer not null check (latency_ms >= 0),
  outcome         text not null check (outcome in ('ok', 'schema_mismatch', 'refusal', 'error', 'timeout')),
  detail          text,
  observed_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Append-only + RLS, same pattern as 0004/0006.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['deduction_documents', 'document_pages',
                           'extraction_results', 'model_calls']
  loop
    execute format('drop trigger if exists no_update_delete on %I', t);
    execute format(
      'create trigger no_update_delete before update or delete on %I
         for each row execute function app.block_mutations()', t);
    execute format('drop trigger if exists no_truncate on %I', t);
    execute format(
      'create trigger no_truncate before truncate on %I
         for each statement execute function app.block_mutations()', t);

    execute format('revoke all on %I from app_rw, app_ro', t);
    execute format('grant insert, select on %I to app_rw', t);
    execute format('grant select on %I to app_ro', t);

    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I
         using (org_id = app.current_org_id())
         with check (org_id = app.current_org_id())', t);
  end loop;
end
$$;

grant usage, select on all sequences in schema public to app_rw;

create index if not exists deduction_documents_case_idx
  on deduction_documents (org_id, deduction_id);
create index if not exists document_pages_doc_idx on document_pages (org_id, document_id, page_number);
create index if not exists extraction_results_doc_idx
  on extraction_results (org_id, document_id, id desc);
create index if not exists extraction_results_case_idx
  on extraction_results (org_id, deduction_id, field_path)
  where deduction_id is not null;
create index if not exists model_calls_org_idx on model_calls (org_id, observed_at desc);
create index if not exists model_calls_case_idx on model_calls (org_id, deduction_id)
  where deduction_id is not null;
