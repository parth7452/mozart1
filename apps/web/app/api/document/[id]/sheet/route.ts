import { NextResponse } from 'next/server';
import { isSpreadsheetMime, parseWorkbook } from '@recouple/ingest';
import { sheetHtml } from '../../../../../lib/sheet-html';
import { refusedDocument } from '../../../../../lib/serve-document';
import { requireSession, storeFor } from '../../../../../lib/session';

/**
 * A stored spreadsheet as an escaped HTML table (ADR 0056): the way a
 * reviewer looks at one, since the original only downloads. Gated exactly as
 * `/api/document/[id]` is — `servableDocument` decides and fetches in one
 * snapshot, RLS's 404 first, a refusal a 409 — and sandboxed with no script.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('not found', { status: 404 });

  const session = await requireSession();
  const store = storeFor(session);
  try {
    const served = await store.servableDocument(id);
    if (served === undefined) return new NextResponse('not found', { status: 404 });
    if (served.refusal !== undefined) return refusedDocument(served.refusal);
    const { document } = served;
    if (!isSpreadsheetMime(document.mimeType)) return new NextResponse('not a spreadsheet', { status: 404 });

    const rowParam = new URL(request.url).searchParams.get('row');
    const highlight = rowParam !== null && /^[1-9]\d{0,6}$/.test(rowParam) ? Number.parseInt(rowParam, 10) : undefined;
    const html = sheetHtml(parseWorkbook(document.bytes, document.mimeType), document.filename, highlight);
    return new NextResponse(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, max-age=3600',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  } finally {
    await store.close();
  }
}
