# 0053 — A dense remittance is read in page ranges

- Status: accepted
- Accepted 2026-09-26 under the founder's standing authorisation for pilot
  work; recorded suite below
- Date: 2026-09-26
- Changes: how a document the reader cannot finish in one reply is read
  (`packages/extraction/src/paging.ts`, `ClaudeExtractor`). No migration, no
  new column, no new outbound side effect, no threshold.

## Context

`ClaudeExtractor.extract` reads a document in one streamed call with a
32,000-token output budget. A dense row costs about 250 output tokens (the
42-row `crosswind-dense-remittance` measured 10,871), so a document past about
120 rows stops with `stop_reason: max_tokens`, and the extractor was written
to throw `ExtractionError` "split the document and retry" (in fact the SDK
threw first, and recorded nothing of what was spent: §5). Failing is right — a
cut-off read stored as a complete one is the failure this code exists to
prevent — but nothing splits the document, so the read fails for ever. The pilot README lists
it as a limit to tell the customer, and foodservice broadline distributors'
remittances are exactly this shape: hundreds of invoices over several pages.

Three facts shape the fix:

- **The wire format already carries row numbers.** Every field of a repeating
  group comes back as `lines[i].<leaf>`, and `reassemble` rebuilds the typed
  object from the flat list. Several replies can be joined by renumbering rows
  before `reassemble`, and everything downstream — reassembly, schema
  validation, flattening, provenance, quote verification — runs unchanged on the
  joined list.
- **There is no PDF splitter in the workspace**, and adding one means parsing
  untrusted PDF structure in-process, which the upload door (`pdf-names.ts`) is
  careful to do only as far as it must. A page range can instead be *asked for*
  over the same whole document.
- **`MAX_ROWS_PER_GROUP` is 500** and stays. It is a denial-of-service cap on
  the row number, not an output budget, and it applies to the merged document
  exactly as it does to a single read.

## Decision

### 1. Paging is reactive: only a read that failed today is paged

The first call is the call made today, byte for byte: same content, same
budget, no cache marker. Only when it stops at `max_tokens` **and** all of
these hold does the extractor page instead of throwing:

- the document is a PDF (`application/pdf`) — an image is one page and cannot
  be ranged, and an email body is text with no pages;
- its text layer has two or more pages (`pageText.length`, embedded or OCR);
- its type has a top-level repeating group (`describeFields` gives a
  descriptor with a `group`). The engine is payer-agnostic: this is every type
  with lines, not a remittance special case.

Anything else throws the existing `ExtractionError`, message and outcome
unchanged. So every read that succeeds today is identical, every recorded
cassette replays identically, and the extractor stamp
(`EXTRACTION_SYSTEM` + `extractionInstruction`) does not move. The price is
one wasted budget-sized call on exactly the documents that fail today (about
$0.32 at `claude-sonnet-5`'s $10 per million output tokens); a proactive gate
by page count is a later decision, once this suite shows what paging costs.

### 2. A part is a page range over the whole document

`planPageChunks(pages, 2)` cuts the pages into ranges of two, in page order.
Each part is one call with the **same** system prompt, document block, text
layer block and extraction instruction as the first call, then one more text
block naming the range: report the repeating-group rows printed on pages
*a–b* only, numbered from `[0]` in printed order, cite the document's own page
numbers, and (only for the part that includes page 1) every field outside a
repeating group wherever it is printed; later parts are told not to report
those. A row belongs to the page its first line is printed on — a row that
starts at the foot of page *b* and ends on *b+1* is the part ending at *b*'s,
and the next part is told to skip it.

The instruction block, the last block every part shares, carries
`cache_control: ephemeral`, and the part's range block comes after the marker.
The parts of one wave are sent together, so each of them writes the prefix
rather than reading it; the marker pays for itself only on a later wave (a
halving) or a retry within five minutes. What it costs is measured below.
Invariant 4 is untouched: no call is given `tools`, the page text is inside the
same `<untrusted_document>` delimiters, and the range block is our text, not
the document's.

Two pages because a printed remittance holds 40–50 rows a page: two pages is
about 100 rows, under the budget with room. A part that still stops at
`max_tokens` is **halved** (`1–2` becomes `1–1` and `2–2`) and both halves are
asked again; a single page that stops at `max_tokens` fails loudly with the
existing `ExtractionError`, naming the page. Parts run in waves, four at a time;
a wave's halvings form the next wave.

**At most 24 calls** per read, the first included. A plan that would pass the
cap is refused before the wave that would pass it is sent — so a document of
more than about 46 pages is refused before any part is asked, and says so. At
46 rows a page that is already past `MAX_ROWS_PER_GROUP`'s 500 rows, so the cap
refuses nothing the row cap would have kept.

### 3. The merge is at wire level, before `reassemble`, and it drops out loud

`mergeChunkFields(parts, descriptors)` is pure:

- **Header fields come from the part that includes page 1 only.** A field
  outside every repeating group from any other part is dropped with an issue
  naming the path and the part's pages.
- **A row is its part's when it starts inside the part's range**: the smallest
  `source_page` among its fields is between *a* and *b*. A row that starts
  outside — the last row of the previous part read again, or a row of the next
  part read early — is dropped with an issue naming the row, the part and the
  page it starts on. This is what makes a row both parts read count once, and a
  row split across the boundary survive whole: its first field cites *b*, so
  the part ending at *b* keeps it even though its last field cites *b+1*.
- **Rows are renumbered in page order.** Parts are sorted by first page; each
  group's kept rows keep the model's own order inside a part and are offset by
  the rows kept before them. Gaps in a part's numbering are closed, never
  filled. Document order is what ADR 0048's occurrence numbering
  (`lineClaimIds`, `payment_reference:invoice#n`) counts in, so an invoice
  printed twice either side of a part boundary is `#1` and `#2` in the order
  printed.
- **Two identical rows either side of a boundary are kept and named.** Two
  lines that print the same invoice and the same amounts are two deductions
  (ADR 0048), so the merge does not guess; it says so in the call's `detail`.

Then the existing `reassemble` and `buildExtractionResult`, unchanged. A row
the merge lost is a row the schema, the quote check and the reviewer can see is
missing; a row it doubled is a second case the review queue shows. A required
field missing from a half-read row fails validation, which records the read as
`schema_mismatch` exactly as a single read would.

### 4. One `model_calls` row, whose detail names ranges only

A paged read is one `ModelCallRecord`: input, output and cached tokens summed
over every call (input counts `input_tokens + cache_read + cache_creation`,
cached counts reads), cost summed from each call's own usage with cache writes
at 1.25× and reads at 0.1× the input rate, and latency the read's wall-clock
time (the parts overlap, so a sum would overstate it). `detail` says it was
paged and why, the ranges asked, any halving, the rows kept per part and what
the merge dropped or flagged — paths, page numbers and counts, never text off
the page. A read that fails part-way throws `ExtractionError` carrying the
summed cost of every call made, so `model_calls` records what was spent.

`usageOf` now counts cache reads and writes in `inputTokens`. No existing call
sends a cache marker, so every existing record is unchanged; without the fix, a
cached call would have under-counted its input.

### 5. A cut-off is read from the stream, not from the SDK's parse

Recording this suite found that §1's backstop had never been reachable. The SDK
parses the structured output when the message stops, and a reply cut off at
`max_tokens` is unterminated JSON, so `finalMessage()` threw `Failed to parse
structured output … Unterminated string in JSON` before `stop_reason` could be
read. The dense read was recorded as outcome `error`, `costMicros: 0` — about
$0.34 spent and none of it in `model_calls` — and it could never have paged.

`request()` now keeps the message snapshot the stream hands each `streamEvent`
listener. When `finalMessage()` throws and that snapshot says the reply stopped
at `max_tokens` or was refused, the call is answered from the snapshot with no
parsed output: a cut-off is the `schema_mismatch` "cut off … split the document
and retry" (or a paged read) with its tokens and cost, and a refusal is a
`ModelRefusalError`. A reply that finished and still would not parse is thrown
exactly as before. The request itself is unchanged, and so is every read that
parses.

## Measured

The `dense_paged` suite is one five-page, 190-row remittance built by the same
generator as `dense` (`densePagedDocuments`, `packages/fixtures/src/dense.ts`):
the advice header on page 1, a continuation heading and the column heads again
on every later page, the totals under the last row, and one invoice printed
twice — the last row of page 2 and the first of page 3, where the two-page parts
meet — first with a shortage, then with a price deduction.

Recorded 2026-09-26, `claude-sonnet-5`, `pnpm record:cassettes --suite
dense_paged`:

| | |
| --- | --- |
| Classification | `remittance_advice` at 0.99 ($0.0202) |
| First call | stopped at 32,000 output tokens, as it must |
| Parts | pages 1–2, 3–4 and 5, none halved; 76, 84 and 30 rows kept; nothing dropped or flagged by the merge |
| Rows | 190 of 190, in page order; the split invoice is rows 75 and 76, `SHORT` then `PRICE` |
| Fields | 784, every quote found on the page it cites (100% grounding) |
| Recall / precision | 99.9% / 99.9%: one miss, `payer_name` read as the payee ("Pay To: Northstar Pantry Co.", 0.9), a reading error rather than a join error |
| Tokens | 83,617 input, 85,205 output, across four calls |
| Cost | $1.0503 for the extraction, $1.0706 with classification |
| Wall-clock | 344 seconds |

The first attempt at recording, before §5, spent about $0.34 on the cut-off call
and recorded nothing, which is how §5 was found. Every other suite's baseline
row is unchanged; the eval replays cassettes and never reaches `ClaudeExtractor`.

## Consequences

- A remittance past about 120 rows now reads, up to `MAX_ROWS_PER_GROUP`'s 500,
  at the cost of one wasted call plus one call per two pages: about $1.05 for
  190 rows, of which roughly a third is the wasted call.
- **Latency is now the limit, and in production it binds.** 344 seconds is past
  the Inngest route's `maxDuration` of 300 (ADR 0021). On Vercel this read
  would be killed during its parts, Inngest would retry the step, and each
  retry would pay the wasted call and the parts again until the retries ran
  out: `read-document` has `retries: 3`, so four attempts, about $4, for a
  document that never reads.
  Until that is answered, a document this dense should be expected to fail in
  production — loudly, but at a cost — and the pilot README's limit is reworded
  rather than removed. The levers, each the founder's decision: a proactive
  gate (page count or a row estimate from the text layer) that skips the wasted
  call, which alone would roughly halve this read (it runs before the parts,
  which run together); a longer
  `maxDuration` if the Vercel plan allows it; or one Inngest step per part, so a
  retry resumes rather than restarts.
- The cache marker, with parts sent together, bought nothing on this read and
  cost the write premium (a few cents at most); it is kept because a halving
  wave or a retry within five minutes reads what the first wave wrote.
- `reconcileCase` checks a remittance line's own arithmetic, not the advice's
  total against its lines, so a row the merge lost is not caught by arithmetic
  on a remittance. The row-start rule is what prevents it, and `detail` names
  every row the merge dropped; a lines-against-total check is a follow-up.
- The paged prompt is exercised by one recorded document. Real distributor
  layouts — rows wrapped across two printed lines, subtotals per page, a scan
  read through OCR — are not in it.
