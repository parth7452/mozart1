import { NextResponse } from 'next/server';
import {
  hasRendition,
  RenditionError,
  renderForReading,
  renditionFilename,
} from '@recouple/ingest/rendition';
import { displaysInline } from '../../../../../lib/document-types';
import { refusedRendition, renditionRefusal } from '../../../../../lib/rendition-view';
import { requireSession, storeFor } from '../../../../../lib/session';

/**
 * Shows a document no browser can draw — a TIFF — as the rendition its read was
 * given (ADR 0054 §4): a PNG for one page, a PDF for several, made here, in
 * memory, and never stored.
 *
 * `/api/document/[id]` still serves the bytes that arrived, as a download; that
 * file is the provenance artifact and what a packet encloses. This route is
 * only a way to look at it.
 *
 * Under the same claims and the same RLS read as that route, so another
 * tenant's document is absent rather than forbidden, and under one more rule:
 * nothing is decoded unless the document's latest scan verdict is `clean`
 * (`renditionRefusal`). A type with no rendition is a 404 here, because the
 * original route already shows it.
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
    // Visible first, so a document this tenant cannot see is a 404 and never a
    // sentence about its scan.
    if (!(await store.documentIsVisible(id))) {
      return new NextResponse('not found', { status: 404 });
    }
    // Before the bytes are fetched, and long before they are decoded.
    const refusal = renditionRefusal(await store.latestScan(id));
    if (refusal !== undefined) {
      return refusedRendition(refusal);
    }

    const document = await store.getDocument(id);
    if (document === undefined || !hasRendition(document.mimeType)) {
      return new NextResponse('not found', { status: 404 });
    }

    let rendition;
    try {
      rendition = await renderForReading(document.bytes, document.mimeType);
    } catch (error) {
      if (!(error instanceof RenditionError)) throw error;
      // Ids and the class, never the file's name or anything off it.
      console.error(`[recouple] view: document ${id} will not render (${error.name})`);
      return new Response(
        'This document cannot be drawn here. Its original still downloads from the case page.',
        {
          status: 422,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        },
      );
    }

    const inline = displaysInline(rendition.mimeType);
    const safeName =
      renditionFilename(document.filename, rendition).replace(/[^\w.\- ]/g, '_') || 'document';
    return new NextResponse(Buffer.from(rendition.bytes), {
      headers: {
        'content-type': inline ? rendition.mimeType : 'application/octet-stream',
        'content-length': String(rendition.bytes.byteLength),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
        // The same bytes on every render (ADR 0054 §2), and somebody's business
        // record: the reviewer's browser may keep it, a shared cache may not.
        'cache-control': 'private, max-age=3600',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  } finally {
    await store.close();
  }
}
