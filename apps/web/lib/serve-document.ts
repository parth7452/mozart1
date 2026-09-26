import type { ServingRefusal } from '@recouple/pipeline';

/**
 * What a reviewer is told about a document whose bytes are not served
 * (`servingRefusal`, in `@recouple/pipeline`).
 *
 * The document is named on the case page as it always was — the member can
 * see its row, and knowing the scan refused their own file is what lets them
 * act on it. What is withheld is the bytes. The answers name no filename and
 * nothing the scanner said: the signature a scanner matched is not something
 * a reviewer needs, and a filename is untrusted text off an upload.
 */
export const SERVING_REFUSED: Readonly<Record<ServingRefusal, string>> = {
  infected:
    'The malware scan found this document infected, so it is not served. Nothing was read from it.',
  unscanned:
    'This document has no clean scan verdict, so it is not served. Uploading the same file again scans it again.',
};

/**
 * The answer a route gives instead of a document's bytes: 409, plain text.
 *
 * 409 because the document exists and this member may see that it does — 404
 * stays the answer for one RLS hides, so another tenant's document is as
 * absent as ever — and what stands in the way is the document's own state,
 * which a clean verdict would change. Not 403: nobody's permission is at issue.
 * `no-store`, because the answer is not the document's for ever: a re-upload
 * that scans clean changes it, and a cached refusal would outlive that.
 */
export function refusedDocument(refusal: ServingRefusal): Response {
  return new Response(SERVING_REFUSED[refusal], {
    status: 409,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
