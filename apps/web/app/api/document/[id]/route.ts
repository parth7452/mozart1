import { NextResponse } from 'next/server';
import { requireSession, storeFor } from '../../../../lib/session';

/**
 * The types a browser may render in place. Everything else downloads.
 *
 * These bytes came from a stranger — a retailer's portal, or an email attachment.
 * A PDF can carry script and an HTML file can claim to be anything, so the set of
 * things this route will let a browser execute is the set it can afford to.
 */
const INLINE_TYPES = new Set([
  'application/pdf',
  // An email body, which arrives as text. Served with nosniff and a sandbox, so
  // a body claiming to be markup is still shown as the characters it is.
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
]);

/**
 * Serves a document's bytes to the reviewer looking at it.
 *
 * There is no signed URL and no bucket: the bytes come back through the same
 * tenant claims as everything else, so a document belonging to another tenant is
 * absent rather than forbidden (ADR 0014). The id is a lookup key — the answer to
 * "may I see this" is the database's, not this handler's.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new NextResponse('not found', { status: 404 });
  }

  const session = await requireSession();
  const store = storeFor(session);
  try {
    const document = await store.getDocument(id);
    if (document === undefined) {
      return new NextResponse('not found', { status: 404 });
    }

    const inline = INLINE_TYPES.has(document.mimeType);
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
