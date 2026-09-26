import { hasRendition } from '@recouple/ingest';

/**
 * The types a browser may render in place. Everything else downloads.
 *
 * These bytes came from a stranger — a retailer's portal, an email attachment,
 * a third party's ledger. A PDF can carry script and an HTML file can claim to
 * be anything, so the set of things a browser is let execute is the set it can
 * afford to. One list, read by the route that serves the bytes and by the page
 * that embeds them: an embed of a type the route will not show inline is a
 * download started by opening a case.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  // An email body, which arrives as text. Served with nosniff and a sandbox, so
  // a body claiming to be markup is still shown as the characters it is.
  'text/plain',
  // A ledger extract (ADR 0029): the canonical JSON `buildLedgerExtract` writes
  // of a short-paid invoice and the ledger rows behind it — the only "page" a
  // deduction found in the ledger has. Text, like an email body, and served the
  // same way; the customer names and memos in it are a third party's strings.
  'application/json',
  'image/jpeg',
  'image/png',
  'image/webp',
  // Not `image/tiff`: only Safari draws one, so in every other browser an
  // embed of it was a broken frame or a download. A TIFF is shown through its
  // rendition, `/api/document/[id]/view`, and its original downloads (ADR 0054).
]);

/** Whether `/api/document/[id]` serves this type inline, so a page may embed it. */
export function displaysInline(mimeType: string): boolean {
  return INLINE_TYPES.has(mimeType);
}

/**
 * Whether a document is shown through `/api/document/[id]/view` — a rendition
 * made for viewing and never stored — rather than in place (ADR 0054 §4). A
 * TIFF, today: no browser but Safari draws one.
 */
export function viewsThroughRendition(mimeType: string): boolean {
  return !displaysInline(mimeType) && hasRendition(mimeType);
}
