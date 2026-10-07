import type { ScanStatus } from '@recouple/ingest';
import type { UploadSource } from './ports';

/**
 * Why a stored document's bytes may not be handed to a browser, or `undefined`
 * when they may.
 *
 * The scan gate (`assertScannedClean`) fails closed for **reading**: nothing
 * becomes model input without a clean verdict. Serving is the other way bytes
 * leave the store — to a reviewer's browser, a download, a packet's zip — and it
 * fails closed the same way. A file ClamAV called infected is not offered to
 * the person most likely to open it, and neither is one that has no verdict at
 * all, or only `error`: that is a scanner that did not answer, not a file that
 * passed. The sandbox CSP and `nosniff` on `/api/document` govern what a
 * browser does with a page it shows; neither governs a download, which is the
 * file itself on somebody's disk.
 *
 * - `infected`: the latest verdict says so.
 * - `unscanned`: no verdict, or the latest is `error`. Uploading the same bytes
 *   again scans them again (ADR 0047), which is the way out.
 *
 * **One exception, by provenance.** A ledger extract (ADR 0029) is JSON our
 * own code wrote from values the ledger returned, arriving as `erp_sync`; no
 * byte of it came through a door somebody else could put a file through, and
 * nothing scans it. With no verdict it is served. A verdict, if one ever exists,
 * still decides — an extract recorded `infected` is refused like anything else.
 * The source is the document's own `uploads` row, which is append-only (ADR
 * 0024), never a caller's say-so. `portal_fetch` and `edi_812` are not
 * exempt: when they arrive they are somebody else's bytes.
 *
 * A manual entry (ADR 0070), arriving as `manual_entry`, is exempt for the
 * same reason: JSON our code wrote from the fields a member typed into the
 * open-case form. No file came through a door; a verdict, if one exists,
 * still decides.
 */
export type ServingRefusal = 'infected' | 'unscanned';

export function servingRefusal(input: {
  /** The status of the document's latest `document_scans` row, if any. */
  readonly scan: ScanStatus | null;
  /** The source of the `uploads` row `documents.upload_id` names, if any. */
  readonly source: UploadSource | null;
}): ServingRefusal | undefined {
  if (input.scan === 'clean') return undefined;
  if (input.scan === 'infected') return 'infected';
  if (input.scan === null && (input.source === 'erp_sync' || input.source === 'manual_entry')) return undefined;
  return 'unscanned';
}
