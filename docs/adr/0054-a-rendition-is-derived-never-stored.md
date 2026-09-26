# 0054 — A rendition is derived, never stored

- Status: accepted
- Date: 2026-09-26
- Decided under: the founder's standing authorisation for pilot work
- Amends: ADR 0009 (what Reducto and the model receive) and ADR 0014 (what is
  served is what is stored)

## Context

The pilot plan (`docs/plans/pilot/README.md`) tells every customer "PDF, PNG,
JPEG, GIF and WebP only. No TIFF, HEIC". It also schedules TIFF and HEIC for week
2. TIFF is the format fax servers and office scanners write. A single file often
holds several pages, compressed as CCITT Group 4 and scanned at non-square fax
resolutions (204 × 98 or 204 × 196 dpi). Foodservice and logistics still send a
lot of fax. Today every such file is refused at the door as `type_not_allowed`.

Four facts decide the shape:

1. **Neither reader takes TIFF.** The Messages API takes PDF and four image
   types: PNG, JPEG, GIF and WebP. `buildReadContent` throws on anything else.
   Reducto's documentation does not mention TIFF, and finding out would spend
   money. A TIFF therefore has to become a PNG (one page) or a PDF (several
   pages) before either reader sees it.
2. **`documents` is append-only and deduplicates on the SHA-256 of the bytes
   that arrived.** It also names the arrival that brought them
   (`documents.upload_id`, ADR 0024). Storing converted bytes as a second
   document would break three things:
   - re-upload deduplication, because the converted bytes hash differently;
   - provenance, because the converted document would have no arrival;
   - linkage, because relating the two documents would need a new table, which
     means a migration.
   It would also break the premise of a post-audit: the stored page is the page
   that arrived.
3. **Browsers do not render TIFF.** Only Safari does. `INLINE_TYPES` listed
   `image/tiff` anyway. The case page would have embedded it, and in Chrome and
   Firefox that shows a broken frame or starts a download.
4. **sharp is already in the tree**, as Next 16's own image dependency
   (0.35.4). Its prebuilt libvips reads TIFF through libtiff 4.7, which covers
   multi-page files, CCITT G3/G4, LZW, Deflate, PackBits and JPEG-in-TIFF. It
   runs on Vercel's Node runtime, and the build already traces it.

## Decision

### 1. The door accepts a classic TIFF, and checks its structure without decoding it

`ALLOWED_MIME_TYPES` gains `image/tiff`. Its signature is `II*\0` or `MM\0*`.
BigTIFF (`II+\0`) matches neither signature and is still `type_not_allowed`.

`acceptUpload` is synchronous and runs before a byte is stored, so it does not
decode anything. Instead `inspectTiff` walks the top-level IFD chain in pure
TypeScript. For each page it reads the width, the length and the resolution
tags. It refuses the file as follows:

- **`content_does_not_match_type`**: an offset outside the file, an IFD that
  loops back on the chain, or a page with no width or length.
- **`decompression_bomb`**, the door's existing code for a file that claims to
  be far larger than it is:
  - more than `MAX_PAGES_PER_READ` (100) pages;
  - a page over `MAX_TIFF_PAGE_PIXELS` (50 million);
  - pages totalling more than `MAX_TIFF_TOTAL_PIXELS` (400 million).

A 600 dpi Letter page is about 34 million pixels. A 100-page fax at 204 × 196
dpi totals about 380 million.

No `RejectionCode` is added. The codes are a closed set, which
`inbound_message_parts.outcome`'s check constraint names. A new code would mean a
migration.

The scanner is unchanged. ClamAV scans opaque bytes. The scan gate still runs
on the stored original, before anything is rendered.

### 2. A rendition is derived at read time, and never stored

`renderForReading(bytes, mimeType)` (`@recouple/ingest/rendition`) is one
function:

- **The existing types** pass through unchanged. They are the same bytes, the
  same type and the same object, so no recorded cassette and no eval number can
  move.
- **A one-page TIFF** becomes a PNG. The PNG is lossless, because a fax's text
  is the content. If the PNG exceeds the API's 5 MB image limit, a JPEG at
  quality 90 with 4:4:4 chroma is used instead. If that also exceeds the limit,
  the result is a named `RenditionError`.
- **A multi-page TIFF** becomes a PDF built with pdf-lib, one page per TIFF
  page, in order. Page *n* of the PDF is page *n* of the TIFF. A field's
  `sourcePage` therefore names a page of the stored original, and provenance
  needs no mapping. Each page is embedded by the same rule as a one-page
  TIFF: PNG, else JPEG. The page size in points comes from the page's own
  resolution. A PDF whose base64 would exceed `MAX_MODEL_PAYLOAD_BYTES` is a
  `RenditionError`.
- **Non-square pixels are made square.** A fax page at 204 × 98 dpi is
  resampled so the page is as tall as it was printed. Otherwise both readers
  would see text squashed to half height. The long edge is capped at 8000 px,
  the API's image limit. EXIF or TIFF orientation is applied.
- **The output is deterministic**:
  - fixed encoder options;
  - pdf-lib with `updateMetadata: false`, so no creation date or producer
    string is written;
  - the same libvips build.

  A replay, a "Read again" and the case page's view therefore see the same
  bytes. A test holds this byte for byte.

The rendition exists only in memory for the length of a read or a request.
Nothing writes it:

- `documents` keeps the original's type, size and hash;
- re-uploading the same TIFF still deduplicates;
- `uploads` and `document_arrivals` are untouched;
- no table, column or migration is added.

### 3. What Reducto and the model receive (amends ADR 0009)

ADR 0009 describes Reducto as reading "the document". From now on, Reducto,
the classifier and the extractor all receive the rendition. For every type that
existed before this ADR, that is the stored bytes. For a TIFF, it is the PNG or
PDF. Because Reducto reads the same pixels as the model, its boxes fall on the
pages the model cited and the reviewer is shown.

`payload.mimeType` and `payload.filename` name the rendition: `fax.tif` is sent
as `fax.pdf`. Invariant 4 is unchanged. The reader still receives only a PDF or
an image, still with no tools, and `buildReadContent` and `IMAGE_TYPES` are
untouched.

A read that rendered records the fact on its model calls' `detail`, for
example `rendition image/tiff→application/pdf 3p`. It records types and a page
count only.

A `RenditionError` can be raised when a file passed the door but libvips will
not decode it, for example a compression scheme libtiff lacks. It is a named
error. The job treats it as non-retriable, because the same bytes fail the
same way every time and a retry would only fail again.

### 4. What is served (amends ADR 0014)

ADR 0014's route, `/api/document/[id]`, keeps serving exactly the bytes that
are stored. That file is the provenance artifact, and it is what a packet
encloses. `image/tiff` leaves `INLINE_TYPES`, so the original TIFF downloads as
an attachment. Previously the route would have served it inline to browsers
that cannot draw it.

A sibling route, `/api/document/[id]/view`, serves `renderForReading`'s output
for a stored type whose rendition differs from itself. It uses:

- the same tenant claims and RLS read (another tenant's document is a 404);
- the same `nosniff` and sandbox CSP headers;
- `inline` disposition only when the rendition's type `displaysInline`.

For any other type it answers 404, because `/api/document/[id]` already shows
those.

**It renders only a document whose latest scan verdict is `clean`.** A document
that is infected, unscanned or `error` gets a 409 with a sentence, and nothing
is decoded. This matches the serving gate open PR #120 adds to
`/api/document/[id]`, with one deliberate difference: #120 exempts a ledger
extract (`erp_sync`) that has no verdict. That exemption does not apply here.
A rendition is libvips decoding a stranger's file, and no TIFF is ever written
by our own code. So this route asks the verdict alone and never asks the
source.

The case page embeds the view for a TIFF and links to "download the original"
beside it.

### 5. HEIC is the next step, not this one

HEIC has the same shape, but sharp's prebuilt libheif decodes AVIF only, not
HEVC. Decoding HEIC needs `heic-decode` / libheif-js, which is licensed
LGPL-3.0 and takes 1–3 s and a few hundred MB for a 12 MP photo. Taking on an
LGPL dependency is the founder's decision, and it is not made here. Once
approved, the work is:

- a signature;
- a structure check;
- one more branch in `renderForReading`;
- `.heic,.heif` in `UPLOAD_ACCEPT`.

The storage and serving rules this ADR sets stay as they are. Until then, HEIC
is still `type_not_allowed`. That costs less than it sounds: iOS Safari's file
picker and iPhone Mail usually transcode HEIC to JPEG already.

**Amended 2026-09-26: HEIC is in.** The founder approved the LGPL-3.0
dependency (`heic-decode`, over libheif-js) on 2026-09-26. The door accepts an
ISO-BMFF `ftyp` box whose major or a compatible brand is heic, heix, heim,
heis, hevc, hevx, mif1 or msf1, and refuses one whose only HEIF brand is
generic beside an AVIF brand; the box must be sane (`inspectHeif`), else
`content_does_not_match_type`. It is stored as `image/heic`, and a declared
`image/heif` is read as that. `renderForReading` makes it one JPEG at quality
90: decoded by `heic-decode`, encoded by sharp with fixed options and no
metadata, the long edge capped at 8000 px and the JPEG at 5 MB, and more than
50 MP refused as `decompression_bomb` before a pixel is decoded. Orientation is
libheif's `irot`/`imir`, applied once; the EXIF orientation a phone also writes
says the same turn and is not applied again. It is shown through
`/api/document/[id]/view`, and `.heic,.heif` are in `UPLOAD_ACCEPT`. Storage
and serving are unchanged.

## Options not taken

- **Store the rendition as a second document.** Rejected for the reasons in
  context item 2: provenance, deduplication and an append-only link table.
- **Convert at the door and store only the rendition.** This would discard the
  bytes that arrived, so the stored page would no longer be the one that
  arrived. That breaks the post-audit argument.
- **Send the TIFF to Reducto unconverted.** Support is unverified, it would
  cost money to find out, and Reducto's boxes would then be drawn on pixels
  the model never saw.
- **Decode at the door to validate.** This would make `acceptUpload`
  asynchronous at every caller. It would also decode twice for a file that is
  refused anyway. The IFD walk bounds the work that decoding would do, and a
  file that still will not decode fails loudly at read time.
- **Cache the rendition.** A cache is storage by another name, and nothing
  measured says a render costs enough to need one.

## Consequences

- Every read of a TIFF re-renders it. That takes tens to hundreds of
  milliseconds of CPU per page. Within one `readDocument` the rendition is
  made once and shared by OCR, the classifier and the extractor. The view
  route renders per request, and the reviewer's browser caches the result
  (`private, max-age=3600`).
- The web upload limit (4 MB) and the email limit (about 3.3 MB) are
  unchanged. A CCITT G4 fax page is tens of kilobytes. A greyscale scanned
  TIFF with no compression can hit 4 MB in a few pages, and is refused as
  `too_large` exactly as a PDF of that size would be.
- `sharp` becomes a direct dependency of `@recouple/ingest`, pinned to the
  version Next already ships so pnpm keeps one copy. It is listed in
  `serverExternalPackages`. `pdf-lib` (MIT, pure JS) is new.
- A TIFF whose top-level chain carries a thumbnail IFD as a separate image
  reads it as a page, as libvips does. The reviewer sees one extra small page.

## Invariants touched

- **2 (append-only).** Kept. Nothing is written. The rendition has no row.
- **4 (document content is untrusted).** Kept.
  - The file is decoded only after the scan gate says `clean`, and only inside
    libvips with a pixel limit.
  - The reader gets no tools and receives only PDF or image content.
  - Nothing off the page reaches a log line or `model_calls.detail`. The
    detail records types and a page count.
- **6 (RLS).** Kept. The view route reads through the same tenant claims as
  `/api/document`, and the service role appears nowhere.
- **1, 3, 5, 7.** Not in this path.

## Rollback

Remove `image/tiff` from `ALLOWED_MIME_TYPES` and `.tif,.tiff` from
`UPLOAD_ACCEPT`. New TIFFs are then refused at the door again. TIFFs already
stored stay readable and viewable, because the rendition code is
independent of the door. Removing it too makes a stored TIFF unreadable
(`cannot read image/tiff`), and its original still downloads.
