import { NextResponse } from 'next/server';
import { displaysInline } from '../../../../lib/document-types';
import { refusedDocument } from '../../../../lib/serve-document';
import { requireSession, storeFor } from '../../../../lib/session';

/**
 * Serves a document's bytes to the reviewer looking at it.
 *
 * There is no signed URL and no bucket: the bytes come back through the same
 * tenant claims as everything else, so a document belonging to another tenant is
 * absent rather than forbidden (ADR 0014). The id is a lookup key — the answer to
 * "may I see this" is the database's, not this handler's.
 *
 * **Only a document that scanned clean.** The scan gate fails closed for
 * reading; this is the other way bytes leave the store, and it fails closed
 * the same way (`servingRefusal`): an infected document, or one with no clean
 * verdict, is a 409 with a sentence saying which, asked before the bytes are
 * fetched — and the one exception is a ledger extract our own code wrote. The
 * sandbox below governs what a browser does with a page it shows; it governs
 * nothing about a download.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new NextResponse('not found', { status: 404 });
  }

  const session = await requireSession();
  const store = storeFor(session);
  try {
    const serving = await store.documentServing(id);
    if (serving === undefined) {
      return new NextResponse('not found', { status: 404 });
    }
    if (serving.refusal !== undefined) {
      return refusedDocument(serving.refusal);
    }

    const document = await store.getDocument(id);
    if (document === undefined) {
      return new NextResponse('not found', { status: 404 });
    }

    const inline = displaysInline(document.mimeType);
    const safeName = document.filename.replace(/[^\w.\- ]/g, '_') || 'document';
    return new NextResponse(Buffer.from(document.bytes), {
      headers: {
        'content-type': inline ? document.mimeType : 'application/octet-stream',
        'content-length': String(document.bytes.byteLength),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
        // A document is immutable once stored, and it is somebody's business
        // record: cache in the reviewer's browser, never in a shared cache.
        'cache-control': 'private, max-age=3600',
        // Nothing this document asks for is granted: no scripts, no network, no
        // frames. What is left is a page of pixels, which is what it should be.
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  } finally {
    await store.close();
  }
}
