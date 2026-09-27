# 04 — Build ADR 0056: spreadsheets at the door

Branch `claude/build-now-04-spreadsheets`. Migration 0036, SQL suite 32 (check free first). Largest item: do sub-tasks 4.1–4.13 in order, one commit each, typecheck + that sub-task's tests before each commit.

## Goal
Accept XLSX/CSV/TSV; read rows with code (no model, no formula evaluation) through a person-confirmed, versioned column mapping per tenant+debtor; open cases from rows; keep cell provenance; verify each value against the stored cell.

## Why
Remittances and deduction lists commonly arrive as spreadsheets and are refused today (ADR 0056).

## What exists today
- ADR `docs/adr/0056-a-spreadsheet-row-is-a-document-line.md` (accepted; status line :3-4 says nothing built).
- `packages/ingest/src/sniff.ts`: `MAX_UPLOAD_BYTES` :18, `ALLOWED_MIME_TYPES` :26-39, `detectMimeType` :78, `BombLimits` :241/:247, `inspectPdf` :266, `acceptUpload` :354 (`type_not_allowed` :376). `RejectionCode` `packages/ingest/src/sniff-errors.ts:7-15` (comment :2-3: migration 0034's `inbound_message_parts.outcome` check names every code; `supabase/migrations/20260924100000_0034_*.sql:203-209`).
- Email: `packages/pipeline/src/inbound.ts:137` (body pageText), :144-148 (rejection → outcome).
- Pipeline: `ingestDocument` steps.ts:185, `readDocument` :890, `openCaseFromNotice` :1248, `openCasesFromRemittance` :1590, `reconcileCase` :2318; `openHeldDocument` open-held.ts:150; `readDocumentJob` jobs.ts:264; `HOLD_REASONS` hold.ts:60; `discovered_via` union ports.ts:128; `PipelineStore` ports.ts:226.
- DB: `deductions_discovered_via_check` in 0022:72-78 ('notice','remittance_line'). `extraction_results` has **no** `unique(org_id,id)`. Latest migration 0035; suites 01…31.
- `parseMoneyToCents` money.ts:214, `parseUnitPrice` :311, `parsePrintedDate` dates.ts:92. fflate ^0.8.3 only in apps/web.

## Decisions (fixed)
Library: `fflate` for inflate; in-repo XML tokenizer and RFC 4180 CSV parser. No exceljs/SheetJS. Model mapping proposal: not built. Number cell `1234.5` accepted. Formula cached values read, marked `wasFormula`. `.xls/.xlsm/.xlsb/.ods` and cp1252 refused. Mapping per tenant+debtor. 5,000 rows. SheetMapping zod in `packages/core-domain/src/sheet-mapping.ts` (no playbooks package). `verifyCellQuote(wb, addr, quote, field, storedCents?)` — the caller parses stored bytes.

---
### 4.1 Branch, numbers, ADR note (first commit)
`git fetch origin`; confirm 0036 and suite 32 free on origin/main and in open PRs (GitHub MCP `list_pull_requests` + files). Edit ADR 0056: change status line to "Accepted 2026-09-26; build in progress on branch claude/build-now-04-spreadsheets"; append `## Build notes (2026-09-27)` recording the decisions above, migration number, the six new RejectionCodes and the outcome-check widening, and `extraction_results_org_id_id_key`. Commit. This satisfies `require-adr.sh`.

### 4.2 Limits + XML tokenizer
- `packages/ingest/package.json`: add `"fflate": "^0.8.3"`; `pnpm install`.
- `packages/ingest/src/sheet-limits.ts`:
```ts
export interface SheetLimits { maxRows: number; maxColumns: number; maxSheets: number; cellMaxChars: number; csvMaxLineBytes: number; zipMaxEntries: number; zipMaxInflatedBytes: number; zipMaxEntryRatio: number }
export const DEFAULT_SHEET_LIMITS: SheetLimits = { maxRows: 5000, maxColumns: 256, maxSheets: 32, cellMaxChars: 2000, csvMaxLineBytes: 64 * 1024, zipMaxEntries: 2000, zipMaxInflatedBytes: 200 * 1024 * 1024, zipMaxEntryRatio: 200 };
export const SHEET_ROWS_PER_STEP = 250;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv'; export const TSV_MIME = 'text/tab-separated-values';
export type SpreadsheetMime = typeof XLSX_MIME | typeof CSV_MIME | typeof TSV_MIME;
export const isSpreadsheetMime = (m: string): m is SpreadsheetMime => m === XLSX_MIME || m === CSV_MIME || m === TSV_MIME;
```
- `packages/ingest/src/sheet-xml.ts`: `export class XmlDtdRefusedError extends Error`; `export type XmlToken = {kind:'open'; name: string; attrs: Record<string,string>; selfClosing: boolean} | {kind:'close'; name: string} | {kind:'text'; text: string}`; `export function tokenizeXml(xml: string): XmlToken[]`. Throws XmlDtdRefusedError on any `<!`; skips `<?…?>`; decodes only `&amp; &lt; &gt; &quot; &apos;` and `&#n;`/`&#xh;`; any other `&name;` throws Error('unknown entity'). Tests `packages/ingest/test/sheet-xml.test.ts`: elements/attrs/text, entities, DOCTYPE/ENTITY refused, unknown entity refused.

### 4.3 XLSX door (not yet wired)
- `sniff-errors.ts`: add `'macro_enabled_spreadsheet' | 'active_content_spreadsheet' | 'legacy_or_encrypted_office' | 'xml_dtd_refused' | 'malformed_spreadsheet' | 'spreadsheet_too_large'`.
- `packages/ingest/src/xlsx.ts`: `export function inspectXlsx(bytes: Uint8Array, limits: SheetLimits = DEFAULT_SHEET_LIMITS): void` — throws `RejectedUploadError` (existing class) with:
  - entries > max, name with `..`, leading `/` or `\`, or `X:` → `malformed_spreadsheet`; nested `.zip/.jar/.xlsx` → `malformed_spreadsheet`;
  - inflate each entry with fflate streaming (`Inflate`/`Unzip`), counting **actual** output bytes; total > budget or entry out/in > ratio → `decompression_bomb` (existing code) — never trust declared sizes; abort as soon as exceeded;
  - `[Content_Types].xml` lacks `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml` → `content_does_not_match_type`;
  - `macroEnabled` in content types, `vbaProject.bin`, or `.bin` workbook (XLSB) → `macro_enabled_spreadsheet`;
  - `xl/externalLinks/`, `xl/embeddings/`, `activeX/`, or any `.rels` with `TargetMode="External"` → `active_content_spreadsheet`;
  - any `.xml`/`.rels` with `<!` → `xml_dtd_refused`;
  - sheets > max, rows > max, columns > max, cell text > chars → `spreadsheet_too_large`.
- Tests `packages/ingest/test/xlsx.test.ts` (build files with `zipSync`, like `pdf-builders.ts`): minimal valid passes; each refusal above (billion-laughs and XXE included; bomb with lying declared sizes); D0CF11E0 handled in 4.4.

### 4.4 CSV + wire into the door
- `packages/ingest/src/csv.ts`: `parseCsv(text: string, delimiter: ',' | '\t'): string[][]` (RFC 4180; throws on unterminated quote); `decodeCsvBytes(bytes, limits): string` (`new TextDecoder('utf-8', {fatal:true})`, strip BOM, refuse NUL and line > cap → throws); `csvSafe(cell: string): string` prefixes `'` if first char in `= + - @ \t \r`.
- `sniff.ts`: add three MIMEs to `ALLOWED_MIME_TYPES`; `detectMimeType`: `PK\x03\x04` → XLSX candidate; `D0 CF 11 E0` → throw `legacy_or_encrypted_office`. In `acceptUpload`: XLSX → `inspectXlsx`; no signature matched → try CSV: decode + parseCsv with `\t` iff declared filename ends `.tsv` (name picks delimiter only) → CSV_MIME/TSV_MIME; any failure → `type_not_allowed` as today.
- Tests `packages/ingest/test/csv.test.ts`: BOM accepted; invalid UTF-8/cp1252 → type_not_allowed; NUL/long line refused; quoted commas/newlines/`""`; csvSafe. Extend existing sniff tests: OLE → legacy_or_encrypted_office.

### 4.5 Parse + render
`packages/ingest/src/sheet-read.ts`:
```ts
export type CellType = 'shared_string' | 'inline_string' | 'number' | 'boolean' | 'date_serial' | 'csv_field';
export const CELL_TYPES: readonly CellType[] = ['shared_string','inline_string','number','boolean','date_serial','csv_field'];
export interface SheetCell { row: number; column: number; ref: string; type: CellType; text: string; numberFormat: string | null; wasFormula: boolean; hidden: boolean }
export interface ParsedSheet { ordinal: number; name: string; hidden: boolean; hiddenRows: number[]; cells: SheetCell[] }
export interface ParsedWorkbook { mime: SpreadsheetMime; date1904: boolean; sheets: ParsedSheet[] }
export interface CellAddress { sheetOrdinal: number; row: number; column: number }
export function parseWorkbook(bytes: Uint8Array, mime: SpreadsheetMime, delimiter?: ',' | '\t'): ParsedWorkbook;
export function renderSheetText(sheet: ParsedSheet): string;
```
Reads workbook.xml (order, state, date1904), sharedStrings, styles numFmts/cellXfs (`date_serial` when a number cell's format is a date format), sheets' `<c r t s><f><v><is>`. Formula: cached `<v>` else text `''`, wasFormula true. Render: one line per row, `REF: text` joined ` | `, hidden rows prefixed `[hidden] `. CSV: one sheet, name `Sheet1`, type `csv_field`. Export 4.2–4.5 from `packages/ingest/src/index.ts`. Tests `packages/ingest/test/sheet-read.test.ts`: verbatim text per type, formula cached/none, hidden sheet/row, date1904, deterministic render.

### 4.6 core-domain money/dates + mapping schema
- money.ts: `numberCellToMoneyText(text: string): string` — string ops only: expand exponent; `1234.5`→`1234.50`; >2 decimals unless the extra are `0`→ RangeError; float noise (`1234.4999999999998`) → RangeError.
- dates.ts: `parsePrintedDate(text, order: 'mdy'|'dmy'|'ymd' = 'mdy')` (existing behaviour default); `excelSerialToIso(serial: string, date1904: boolean): string` (integer part, 1900 leap bug: serial 60 → refuse RangeError, >60 subtract 1).
- `packages/core-domain/src/sheet-mapping.ts`: zod `SheetMappingSchema` {id, orgId, debtorId, version, effectiveFrom, headerRow, sheetName, headerFingerprint: string[], shape: 'remittance'|'deduction_list', columns: Record<string, number>, nonLineRule: {blankColumn: number} | {firstCellMatches: string[]}, sign: 'deductions_positive'|'deductions_negative', currency (3 chars), dateOrder, sourceDocumentId|null, confirmedBy}; `type SheetMapping`; `headerFingerprint(cells: readonly {text:string}[]): string[]` (trimmed, in order). Export from index.
- Tests `packages/core-domain/test/sheet-money.test.ts`: 1234.5→123450 cents via parseMoneyToCents; noise refused; `0.125` refused; exponent; fast-check decimal strings round-trip without floats; serial 60, 1904 system, dmy.

### 4.7 Migration 0036 + SQL suites
`supabase/migrations/20260927100000_0036_a_spreadsheet_row_is_a_document_line.sql`, safe to run twice, header comment listing what it does:
1. `alter table extraction_results add constraint extraction_results_org_id_id_key unique (org_id, id);` (guard with `if not exists` via DO block). Same for `debtors (org_id,id)` and `documents (org_id,id)` if absent (check catalog).
2. `sheet_mappings` (columns per 4.6; `columns jsonb`, `non_line_rule jsonb`, checks on shape/sign/date_order, `currency char(3)`, `unique(org_id,debtor_id,header_fingerprint,version)`, FK `(org_id,debtor_id)→debtors(org_id,id)`, FK `(org_id,source_document_id)→documents(org_id,id)`), trigger `app.sheet_mapping_names_its_confirmer()` (confirmed_by must equal `app.current_user_id()`, no owner exception, `set search_path` pinned; pattern of 0031's `approval_names_its_approver`).
3. `extraction_result_cells(extraction_result_id uuid primary key, org_id uuid not null, sheet_name text not null, row_number int check >0, column_number int check >0, cell_ref text, cell_type text check in the six, number_format text, was_formula bool not null, foreign key (org_id, extraction_result_id) references extraction_results(org_id,id))`.
4. Both: RLS on, tenant_read/tenant_insert policies (copy 0034's), revoke all from public/anon/authenticated/service_role, grant app_rw select,insert, app_ro select, `no_update_delete` and `no_truncate` on `app.block_mutations()`.
5. Drop/add `deductions_discovered_via_check` with `'report_row'`.
6. Widen the `inbound_message_parts` outcome check. It is an unnamed column check in 0034:203-209. First find its name: `select conname from pg_constraint where conrelid='inbound_message_parts'::regclass and contype='c' and pg_get_constraintdef(oid) like '%outcome%'` (expected `inbound_message_parts_outcome_check`). Then `alter table inbound_message_parts drop constraint if exists <name>; alter table inbound_message_parts add constraint <name> check (outcome in (<the 16 codes in 0034:203-209, exactly>, <six new>))`. Suite 32 asserts the constraint's list equals that full union (22 codes) and that only one outcome check exists.
7. End with a catalogue assertion DO block like 0028 (RLS on, no UPDATE/DELETE grants, request roles hold nothing).
Suites: `supabase/tests/32_a_spreadsheet_row_is_a_document_line.sql` (UPDATE/DELETE/TRUNCATE refused on both; confirmed_by ≠ caller refused even as owner; cross-tenant invisible; cross-org debtor refused by FK; report_row accepted; new outcome codes accepted; unique(org_id,id) exists; latest version lookup). Add both tables to `01_append_only.sql` and `24_only_the_app_roles_hold_grants.sql` lists. Run `pnpm db:test`.

### 4.8 Stores
`ports.ts`: `discovered_via` adds `'report_row'`; `PipelineStore` gains:
```ts
sheetMappingFor(orgId: string, fingerprint: readonly string[], onDate: string): Promise<SheetMapping | undefined>; // latest version, effective_from <= onDate, exact array equality
recordSheetMapping(input: Omit<SheetMapping, 'id' | 'version'>): Promise<SheetMapping>; // version = max+1 for (org,debtor,fingerprint)
recordResultCells(orgId: string, rows: readonly ResultCell[]): Promise<void>;
resultCellsFor(extractionResultIds: readonly string[]): Promise<ResultCell[]>;
export interface ResultCell { extractionResultId: string; sheetName: string; rowNumber: number; columnNumber: number; cellRef: string; cellType: CellType; numberFormat: string | null; wasFormula: boolean }
```
Implement in `packages/pipeline/src/testing/memory-store.ts` and Postgres store via `withTenant` as `app_rw`. Tests: `packages/store-postgres/test/sheet-mappings.test.ts` (DB: record/lookup, cross-org cells refused); `packages/store-postgres/test/rejection-codes.test.ts` (DB, `doc-types.test.ts` style: outcome constraint set-equals RejectionCode ∪ other outcomes; cell_type constraint == `CELL_TYPES`).

### 4.9 Reading rows
- `hold.ts:60`: add `'no_mapping'`.
- `packages/pipeline/src/sheet-reading.ts`: `readSheetRows(wb: ParsedWorkbook, mapping: SheetMapping): { reading: DocumentReading; cells: Map<string, SheetCell>; unreadable: { row: number; reason: string }[]; skipped: number[] }`; `moneyFromCell(cell): Cents` (string/csv → parseMoneyToCents; number → numberCellToMoneyText then parseMoneyToCents; then sign); `unit_cost` via parseUnitPrice; dates via excelSerialToIso / parsePrintedDate(text, mapping.dateOrder). Unreadable money → row unreadable, never zero. Non-line rule skips rows.
- `steps.ts`: `ingestDocument` passes `renderSheetText` pages as pageText for spreadsheet MIMEs (like inbound.ts:137); no OCR. `readDocument`: spreadsheet branch skips classify/extract (no `model_calls` row); finds header in rows 1..10 of each sheet, `sheetMappingFor`; none → hold `no_mapping` with audit `{header: string[] (≤50), sheet}`; emailed → still held `by_email` (checked first as today). Shape `remittance` → one `remittance_advice` reading → `openCasesFromRemittance`; `deduction_list` → per row a one-line `deduction_notice`, `claim_id` = deduction_reference cell (none → unreadable) → `openCaseFromNotice` with `discoveredVia: 'report_row'`. Classification confidence 1. Write extraction_results as today (`source_page` = sheet ordinal, `source_quote` = cell text, bbox null) then `recordResultCells`. Chunks of `SHEET_ROWS_PER_STEP` inside `withDocumentRead`; the Inngest job one step per chunk. Exact-match rows open nothing; count `seenAgain` in detail.
- `reconcileCase`: route `report_row` to new `reconcileReportRow(caseRow, reading): Finding[]` (find row by claim key, like `reconcileRemittanceLine`).
- Tests `packages/pipeline/test/sheet-reading.test.ts` (memory store): remittance with subtotals + two lines one invoice → `invoice#n` keys; deduction_list opens report_row; re-export: 90 repeated open nothing, 10 new open; no mapping → held; record mapping → `openHeldDocument` opens with no model call; emailed held by_email; unreadable money cell → row unreadable.

### 4.10 Verification switch + email
`verifyCellQuote(wb, addr, quote, field, storedCents?: Cents): boolean` in sheet-reading.ts: exact text equality at the address; money fields also `moneyFromCell === storedCents`; never null. At the grounding call site in `readDocument`, spreadsheet MIMEs use it instead of `checkQuote`, with `wb` parsed from the bytes the read already holds (scan gate already passed). Test true/false. `packages/pipeline/test/inbound.test.ts`: xlsx attachment stored and scanned; macro xlsx → part outcome `macro_enabled_spreadsheet`.

### 4.11 Web: mapping
`apps/web/components/multi-upload.tsx` accept adds `.xlsx,.csv,.tsv`. `unattached-documents.tsx`: hold `no_mapping` → link "Map these columns" to `/documents/[id]/map`. `apps/web/app/documents/[id]/map/page.tsx`: header + first 10 rows as escaped text, a `<select>` per field of the shape's schema, shape/sign/date_order/debtor selects, non-line first-cell values. `.../map/route.ts` POST: guards as `open-case` (isCrossSite, requireSession, memberMayWrite, RLS 404), `recordSheetMapping` with `confirmedBy` = session user, then `openHeldDocument`. Tests: route guards and happy path in `apps/web/test/map-route.test.tsx`.

### 4.12 Web: views, download, packet
`apps/web/components/sheet-extract.tsx` (pure): header row + case row grid, field cells outlined, `Sheet!D17` per value, badge "cell matches" / "amount not in cell" / "cell not at address", line "Read by mapping vN, confirmed by X on date". `case-review.tsx`/`page.tsx` render it instead of the embed for spreadsheet MIMEs. `apps/web/app/api/document/[id]/sheet/route.ts`: `servableDocument` gate, escaped HTML table, `?row=` highlight, hidden rows marked. `/api/document/[id]` serves spreadsheets as `application/octet-stream` + `Content-Disposition: attachment`. Packet zip: original plus text extract of the case row through `csvSafe`. Tests for each.

### 4.13 Fixtures
`packages/fixtures/src/spreadsheets.ts`: one table generates the files (xlsx via fflate, csv) and ground truth. Test `packages/fixtures/test/spreadsheets.test.ts` reads them through `parseWorkbook` + `readSheetRows` and asserts ground truth. **No eval suite and no baseline change.** Then `pnpm verify` (with DB) or typecheck + test.

## Verification
`pnpm typecheck`; `RECOUPLE_TEST_DATABASE=1 TEST_DATABASE_URL=<scratch> env -u DATABASE_URL pnpm db:test` (01, 24, 32 pass); `env -u DATABASE_URL pnpm test`; `pnpm eval` unchanged; `grep -rn "service_role\|Number(\|parseFloat" packages/ingest/src/sheet-*.ts packages/ingest/src/xlsx.ts packages/ingest/src/csv.ts packages/pipeline/src/sheet-reading.ts` → none on money paths.

## Acceptance
- [ ] ADR 0056 amended first commit
- [ ] door refusals all tested; bombs counted by real bytes
- [ ] migration 0036 with unique(org_id,id), append-only, RLS, grants, assertion block
- [ ] suites 32, 01, 24 updated
- [ ] parity tests for codes and cell types
- [ ] no_mapping hold and person mapping flow
- [ ] verifyCellQuote used for spreadsheets
- [ ] download attachment-only; csvSafe in packet
- [ ] fixture test; baseline untouched

## Pitfalls
Never `Number()` money text. Never trust zip headers. `<!` anywhere → refuse. Declared filename never picks type. Keep 250 rows/step (300 s Inngest limit). Don't edit migration 0034; widen in 0036. Scan gate unchanged.

## Out of scope
Portal fetch; .xls/.xlsm/.xlsb/.ods/Google Sheets; cp1252; shared mapping library; model proposal; automatic mapping.

## Open questions
0036 free? → next free. Model proposal → no. SheetMapping home → core-domain.

## Depends on
ADR 0044, 0047, 0028/0048, 0050 (all built).
