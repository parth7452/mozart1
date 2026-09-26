# 0056 — A spreadsheet row is a document line, and a cell is its quote

- Status: proposed (2026-09-26). Awaiting the founder on the decisions in §11.
  Nothing here is built: no code, no migration, no fixture.
- Date: 2026-09-26
- Adds, if accepted: two accepted file types at the door (XLSX and CSV), a
  reader that is code and not a model, versioned column mappings as playbook
  data, and three append-only tables

## Context

A broadline distributor does not send a supplier its deductions one PDF at a
time. Its supplier portal lists them, and the list exports as a spreadsheet:
one row per deduction or per short-paid invoice line, with a deduction number,
an invoice, a date, an amount and a reason code in columns. For the
foodservice beachhead in `CLAUDE.md` that export is the notice, and it is how
a manufacturer or its broker would most naturally hand us a month of them.
The pilot README puts "Spreadsheet deduction reports (ADR: a cell's
provenance)" in week two and tells customers until then that XLSX and CSV are
refused.

They are refused at the door today. `ALLOWED_MIME_TYPES` in
`packages/ingest/src/sniff.ts` is PDF and four image types, checked by magic
bytes, and nothing else.

Reading a spreadsheet the way we read a PDF would be the wrong answer, for
reasons the product has already paid to learn:

- **It is already structured.** Every value sits at an address. Asking a model
  to copy it out adds a chance to miscopy and removes nothing. "Models copy,
  we compute" becomes "code reads the cell": there is nothing left for the
  model to copy.
- **It is too long.** A month's export is hundreds to thousands of rows. The
  extraction output budget runs out at about 120 rows, and a repeating group is
  capped at `MAX_ROWS_PER_GROUP` (500) with the rest dropped with an issue.
- **Its provenance is better than a page's.** A page quote is a substring we
  search for, with OCR tiers and a bounding box that is an estimate. A cell is
  one text at one address, exact. The provenance model should keep that
  exactness rather than flatten it into a page quote.
- **Which column means what is a payer's convention**, and `CLAUDE.md` says a
  payer's rules are versioned playbook data, never code.

## Options

**A. Render the sheet to a PDF and read it as a document.** No new reader. But
it throws away the addresses, hits the row budget on any real export, pays a
model per page to copy structured data, and makes a cell's provenance an OCR'd
substring of something we drew ourselves.

**B. Send the cells to the model as text and let it extract.** Cheaper than A,
same row budget, same copying risk, and it asks a model to decide which column
is the amount every time, on every file.

**C. A deterministic reader and a confirmed column mapping. Recommended.** Code
parses the file into cells. A mapping — data, versioned, confirmed by a person
— says which column is which field. Code turns rows into the same typed
readings the rest of the pipeline already consumes, with each field's
provenance being the cell it came from. A model may at most *propose* a
mapping from a header row; it never reads the rows that become money.

## Decision (proposed)

Option C.

### 1. The door

Two new accepted types, still by content, never by extension or declared type:

**XLSX** (Office Open XML workbook). The bytes begin `PK\x03\x04`, the zip's
central directory is read, and the file is XLSX only when `[Content_Types].xml`
declares the workbook part as
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml`.
Refused, each with its own `RejectionCode`:

- a macro-enabled workbook (`macroEnabled` in the content type, or any
  `vbaProject.bin` part), and XLSB;
- legacy `.xls` (an OLE compound file, `D0 CF 11 E0`) — see §11;
- external links (`xl/externalLinks/`), embedded objects (`xl/embeddings/`),
  ActiveX, and any relationship with `TargetMode="External"`;
- an encrypted workbook (an OLE container holding `EncryptionInfo`);
- zip bombs, bounded the way `inspectPdf` bounds a PDF: at most N entries, the
  sum of *inflated* bytes counted as they inflate (never the declared sizes)
  under a budget, a per-entry ratio cap, no nested archives, no entry name with
  `..` or an absolute path (nothing is written to disk, but a name we would
  never resolve is a file built to confuse);
- XML with a `<!DOCTYPE`: no DTDs at all, so no entity expansion and no
  external entities. The parser is configured so, and a test feeds it the
  billion-laughs and an XXE payload.

**CSV** (and TSV). There are no magic bytes, so a CSV is what is left when
the content is: valid UTF-8 (a BOM allowed and removed), no NUL byte, no line
past a length cap, and parseable as RFC 4180 with the delimiter the mapping
names. A file that is none of the other types and is not this is refused as
before. Windows-1252 is §11's question.

Both go through ClamAV like any other file; clamd unpacks OOXML and flags
macros. Size limits are the door's own (ADR 0055's table, once it lands),
plus caps that are a spreadsheet's: sheets per workbook, rows per sheet
(`SHEET_MAX_ROWS`, proposed 5,000), columns per row, and cell text length
(2,000 characters, the same bound `extraction_results.source_quote` has). A
file past a cap is refused whole, never read in part: a report with its last
thousand rows silently missing reads exactly like a shorter report.

**Formulas are never evaluated.** A formula cell is read by its cached value
(the `<v>` the sender's spreadsheet wrote) and nothing else; its provenance
says it was a formula. A formula cell with no cached value is unreadable. No
formula engine is a dependency. Rendered back to a person, every cell is text,
escaped; exported anywhere (a packet enclosure), a cell beginning `=`, `+`,
`-`, `@`, tab or carriage return is prefixed so it cannot become a formula in
the next person's spreadsheet.

### 2. A sheet has a text layer, and code writes it

At ingest, code parses the file into cells: for each sheet, in workbook
order, its name, visibility, and each non-empty cell's address, type, the
number format's code, and its **verbatim text** — the shared string or inline
string as stored, the `<v>` decimal text of a number exactly as written (no
float in between), or the CSV field after unquoting. That is the cell's
quote.

The stored text layer (`pageText`, what `pagesFor` returns) has one "page"
per sheet: a deterministic rendering of its cells, row by row. So
`source_page` is the sheet's 1-based ordinal and every existing reader of a
document's pages keeps working. No OCR runs and no model call is made to get
there. Hidden sheets and hidden rows are read and rendered, marked hidden:
a reviewer is shown what the file contains, not what Excel chose to show.

### 3. A cell's provenance

`extraction_results` stays as it is: `source_page` is the sheet,
`source_quote` is the cell's verbatim text, `source_bbox` is null (a grid has
no box to estimate). What a page does not have is an address, so a sibling
table carries it, one row per result:

`extraction_result_cells`: `extraction_result_id` (foreign key, unique),
`org_id` (composite key with it, ADR 0025 §7's pattern), `sheet_name`,
`row_number` and `column_number` (1-based, as the file numbers them),
`cell_ref` (`D17`, for people), `cell_type` (`shared_string`, `inline_string`,
`number`, `boolean`, `date_serial`, `csv_field`), `number_format` (the code,
nullable), `was_formula`. Append-only on 0004's pattern.

**Quote verification is equality at an address.** A cell's quote verifies when
re-parsing the stored bytes yields exactly that text at that sheet, row and
column — not a substring, no tiers, no glyph folding, because nothing between
the bytes and the text was read by a machine that guesses. On top of that, ADR
0050's money rule applies unchanged in spirit: a money field verifies only when
its cell's text parses (§5) to the stored value, to the cent, sign included. A
quote that is not at its address is `false`, never `null`: there is always a
text layer.

### 4. The mapping is playbook data

A mapping says, for one payer's export, which sheet, which row is the header,
which column is which field, how a non-line row (a subtotal, a blank, a
"Total" row) is recognised, the sheet's shape (§6), the sign convention (are
deductions printed negative), the currency, and the date order. It is:

- **Data**, in `sheet_mappings`, never a code path per payer.
- **Versioned and effective-dated**: a change is a new version; a version is
  never edited (append-only). A case names the version that read it.
- **Scoped to a tenant and a debtor**: agency A's mapping of a distributor's
  export is not agency B's. A shared library is §11's question.
- **Matched exactly**: a mapping carries its header fingerprint, the header
  row's cell texts in order, trimmed. A file applies a mapping only when its
  header row matches one exactly. A renamed, added or reordered column is no
  match. There is no fuzzy match, because a column that moved under a fuzzy
  match is an amount read from the wrong column with full confidence.
- **Confirmed by a person** before it reads anything that opens a case:
  `confirmed_by` is not null, and the confirmer must be `app.current_user_id()`
  (the authorship-trigger pattern of 0016 and 0041).

A file with no matching mapping is stored, scanned, parsed and **held**
(ADR 0044) with a new hold reason, `no_mapping`. The held-document row offers
"Map these columns": the header row and the first rows, as text, with a picker
per field. Confirming writes the mapping and then opens from the held document
exactly as `openHeldDocument` does, reading nothing again.

**The model's part, if any.** A model may propose a mapping from the header
row and a handful of sample rows, sent inside `<untrusted_document>`, with no
`tools` parameter, in the flat wire format, recorded on `model_calls` as
`playbook_draft` (a purpose the table has admitted since 0007). The proposal is
a draft a person edits and confirms; it is never applied by itself, and it
never sees the rest of the rows. It is optional: the first build can ship
with the picker alone, and §11 asks which. If it is built, it needs recorded
cassettes like every other model path.

### 5. Money, dates and identifiers from a cell

- **A text cell** (CSV fields, shared strings) goes through
  `parseMoneyToCents` exactly as a printed amount does, with every refusal it
  already makes: no fraction of a cent, no single decimal place, no three
  places after a comma.
- **A number cell** holds decimal text the sender's spreadsheet wrote. It is
  turned into money text by string operations only — expand an exponent,
  refuse more than two non-zero decimal places, refuse representation noise
  such as `1234.4999999999998` — and then goes through `parseMoneyToCents`.
  A number cell's `1234.5` is not a printed amount cut short: it is the whole
  value, typed. Reading it as $1,234.50 is a deliberate difference from a
  printed `1,234.5`, which stays refused, and §11 asks the founder to confirm it.
- **Unit prices** go through `parseUnitPrice` (ADR 0049), as on a page.
- **Sign** comes from the mapping, never guessed from the data.
- **Dates**: a text cell goes through `parsePrintedDate`; a date serial is
  converted in code, with the workbook's 1900 or 1904 date system and the 1900
  leap-year bug handled, and only when the cell's number format is a date
  format. A mapping's date order other than month-first needs
  `parsePrintedDate` to take an order, which is a small change of its own.
- **Identifiers** are the cell text, verbatim, into `deduction_identifiers`
  with the kind the mapping says (`claim_id`, `invoice_number`, and so on) and
  the `source` of the document's arrival. Nothing new about identity.

A money cell that will not read makes that row `unreadable`, counted and
shown, exactly as a remittance line that will not parse is today. It never
makes the row a zero.

### 6. Rows become cases through the paths that exist

A mapping declares one of two shapes:

**`remittance`**: rows are lines of a payment (invoice, gross, net, a printed
deduction, a payment reference per row or once for the sheet). Code builds a
typed `remittance_advice` reading — the same schema, each field with its cell
provenance — and hands it to `openCasesFromRemittance` **unchanged**. The
per-tenant floor and tolerance, `gross − net` only through `subCents`,
ADR 0048's `payment_reference:invoice#n` keys, exact-only merges, probable
matches named on the event, declines with `decided_by_version`, the
per-invoice advisory lock: all of it applies because it is the same function.
Cases are `discovered_via = 'remittance_line'` and reconcile through
`reconcileRemittanceLine` by their claim key, as ADR 0040 does.

**`deduction_list`**: each row is one deduction with its own reference (the
distributor's chargeback or debit memo number, ADR's `deduction_reference`).
Code builds, per row, a one-line `deduction_notice` reading whose claim id is
that reference and hands it to `openCaseFromNotice`. A row with no reference
opens nothing and is counted `unreadable`, as a remittance line with no invoice
is. Such a case is `discovered_via = 'report_row'`, a new value, because a
case opened from a row of a 3,000-row document must reconcile against its row
and not against the whole document as a notice: `reconcileReportRow` finds it
by the case's claim key, the way `reconcileRemittanceLine` does.

**Overlapping exports are the normal case.** A portal export next week
repeats most of this week's rows. Every row already known exact-matches its
case through `deduction_identifiers` and opens nothing; it is recorded as seen
again on the document's result, not as a new case and not as a decline. This
is the test that matters most, and the fixtures (§10) are built around it.

**No classification model runs.** The mapping match *is* the classification:
the document is typed by the mapping that matched, with confidence 1, and the
held path covers everything else. Emailed spreadsheets are still held
`by_email` (ADR 0047). A spreadsheet that opens cases is read in steps of a few
hundred rows under the document's read claim, so a 5,000-row file is not one
function invocation, and a redelivery is answered from the record as any read
is.

### 7. What a reviewer sees

- On the case page, in place of the page image: the header row and the case's
  row, as a small grid of text, with each field's cell outlined and its address
  (`Deductions!D17`) beside the value. The badge says "cell matches" or names
  the refusal, as ADR 0050's does for a page.
- "Open the sheet": the whole rendered sheet as escaped HTML text, the row
  highlighted, hidden rows shown as hidden. The original file is offered as a
  download only (`application/octet-stream`, attachment), never inline.
- Which mapping version read it, who confirmed that mapping, and when.
- In the packet: the original file enclosed as it arrived, plus a rendered
  extract of the case's row with its addresses, so the payer can find the
  line in their own export.

### 8. Schema, in the next free migration at the time

- `sheet_mappings`: append-only, RLS, tenant- and debtor-scoped, versioned and
  effective-dated, `confirmed_by` held to the caller by trigger.
- `sheet_mapping_proposals`, only if the model proposal is built: append-only
  drafts, never read by the reader.
- `extraction_result_cells` (§3).
- `deductions.discovered_via` admits `'report_row'`.
- The hold reasons gain `no_mapping` (application data; `audit_log` needs no
  change).
- Nothing on `documents` or `uploads` changes: a spreadsheet is a document
  with a MIME type and a text layer, arriving through the doors that exist.

Each new table: RLS on, one policy per command, `app_rw` SELECT and INSERT,
`app_ro` SELECT, `no_update_delete` and `no_truncate`, nothing for the request
roles; suites 01 and 24 extended, and a new suite for the mapping's authorship
trigger and exact-match lookup.

### 9. What this does not do

- No portal fetch. A spreadsheet arrives because a person uploaded it or
  emailed it. Pulling it from the portal is Phase 2's portal read.
- No `.xls`, `.xlsm`, `.xlsb`, `.ods` or Google Sheets link (§11).
- No automatic mapping, ever: a mapping reads money only after a person has
  confirmed it.

### 10. Fixtures, before the build merges

A `spreadsheets` eval suite, authored like `formats` (one table generates the
file and its ground truth): a `remittance`-shaped XLSX with subtotal rows and
two lines on one invoice; a `deduction_list` CSV; the same list re-exported a
week later with ten new rows and ninety repeated; a number cell with float
noise; a formula cell with and without a cached value; a hidden row; and
hostile files at the door (a macro workbook, a zip bomb, a DOCTYPE, an
external link). No model call is needed to score it, so recording it costs
nothing — unless the mapping proposal is built, whose cassettes are recorded
like any other.

### 11. What the founder decides

1. **Option C**, with the reader being code and the mapping data.
2. **The model's part**: ship with a person's column picker only, or with a
   model proposing the mapping for a person to confirm.
3. **A number cell's one decimal place** (`1234.5` in a number cell read as
   $1,234.50) — accepted as a typed value, or refused like printed text.
4. **Formula cells**: open a case from a cached value, marked as a formula, or
   hold every row that has one.
5. **Legacy `.xls` and Windows-1252 CSV**: refused (recommended for the first
   build), or accepted.
6. **Mapping scope**: per tenant and debtor only (recommended), or a shared
   library of payer mappings every tenant may start from, which is
   cross-tenant data and would need its own ADR.
7. **Row cap**: 5,000 rows per sheet, or another number.

## Consequences

- A distributor's export becomes cases in seconds, at no model cost, with
  every number traceable to one cell of one file we kept. For post-audit
  defence that is stronger provenance than any page gives us.
- A new payer's export is one person mapping columns once, and every later
  export with the same header reads by itself. A payer that changes its export
  is held until someone maps the new header, which is the right failure.
- The door grows: a zip and XML parser is new untrusted-input surface and gets
  the same fail-closed treatment the PDF inspector has.
- Two shapes of sheet go through the case-opening functions that already
  exist, so dedupe, tolerance and identity are not reimplemented, and a fix to
  one is a fix to both.
- `report_row` is one more `discovered_via` for coverage to group by.

## Invariants touched

- **2 (append-only)**: three new append-only tables; a mapping is corrected by
  a new version.
- **3 (money is integer cents)**: every amount reaches cents through
  `parseMoneyToCents` or `parseUnitPrice`; a number cell's text is never
  parsed as a float.
- **4 (untrusted content)**: formulas are never evaluated, DTDs never parsed,
  macros and external links refused at the door. If a model proposes a mapping
  it runs with no `tools` parameter on delimited text, and only a person's
  confirmation makes its proposal do anything.
- **6 (RLS)**: every new table has it; nothing needs the service role.
- **Playbook rule**: a payer's column layout is versioned data with
  provenance (who confirmed it, from which document), never code.

## Rollback

Take XLSX and CSV back out of the accepted types: the door refuses them again,
as it does today. The tables stay, append-only, holding the mappings and the
provenance of every case read through them; those cases remain ordinary cases
whose fields still verify against the stored file.
