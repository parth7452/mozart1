import type { ScanVerdict } from '@recouple/ingest';

/**
 * Whether a stored document may be rendered for viewing (ADR 0054 §4), and if
 * not, what the reviewer is told.
 *
 * A rendition is libvips decoding a stranger's file, so it runs only on a
 * document whose **latest** scan verdict is `clean` — the same rule the read
 * path's gate applies, and the rule open PR #120 gives `/api/document/[id]`.
 * That PR exempts a ledger extract (`erp_sync`) with no verdict, because our
 * own code wrote it. The exemption does not apply here: nothing our code
 * writes has a rendition, so this asks the verdict alone and never the
 * document's source.
 *
 * The sentences name no filename and nothing the scanner said: the signature a
 * scanner matched is not something a reviewer needs, and a filename is
 * untrusted text off an upload.
 */
export type RenditionRefusal = 'infected' | 'unscanned';

export function renditionRefusal(verdict: ScanVerdict | undefined): RenditionRefusal | undefined {
  if (verdict?.status === 'clean') return undefined;
  if (verdict?.status === 'infected') return 'infected';
  return 'unscanned';
}

export const RENDITION_REFUSED: Readonly<Record<RenditionRefusal, string>> = {
  infected:
    'The malware scan found this document infected, so it is not shown. Nothing was read from it.',
  unscanned:
    'This document has no clean scan verdict, so it is not shown. Uploading the same file again scans it again.',
};

/**
 * 409, plain text: the document exists and this member may see that it does —
 * 404 stays the answer for one RLS hides — and what stands in the way is the
 * document's own state, which a clean verdict would change. `no-store`, so a
 * cached refusal cannot outlive that verdict.
 */
export function refusedRendition(refusal: RenditionRefusal): Response {
  return new Response(RENDITION_REFUSED[refusal], {
    status: 409,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
