import { NextResponse, type NextRequest } from 'next/server';
import { RejectedUploadError, processUpload } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../lib/session';
import { mayWrite, pipelineDepsFor } from '../../lib/pipeline';

/** One document per request, and not a large one: a notice is a few pages. */
const MAX_BYTES = 25 * 1024 * 1024;

/** Multipart framing around the file itself: boundaries, headers, field names. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

/**
 * Takes a file and runs the real pipeline over it: ingest, scan, classify,
 * extract, and open a case when it turns out to be a deduction notice.
 *
 * Everything that can refuse does so before anything is read. The role check
 * here is a better error message, not the enforcement — the write policies are
 * that, and they would refuse a `read_only` member's insert whatever this
 * handler thought.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  const back = new URL('/', request.url);

  if (!mayWrite(session.org.role)) {
    back.searchParams.set('upload', 'your role can review documents but not add them');
    return NextResponse.redirect(back, { status: 303 });
  }

  // Before the body is touched. `formData()` materialises the whole upload in
  // memory, so checking the size after parsing is checking it after the damage:
  // a 5 GB POST would already be buffered by the time we looked.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES + FORM_OVERHEAD_BYTES) {
    back.searchParams.set('upload', `that file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    return NextResponse.redirect(back, { status: 303 });
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    back.searchParams.set('upload', 'choose a file first');
    return NextResponse.redirect(back, { status: 303 });
  }
  // Again on the real size: `content-length` is the client's claim, and a
  // chunked request does not send one at all.
  if (file.size > MAX_BYTES) {
    back.searchParams.set('upload', `that file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    return NextResponse.redirect(back, { status: 303 });
  }

  const attachToCase = form.get('attachToCase');
  const store = storeFor(session);
  try {
    const result = await processUpload(
      {
        orgId: session.org.orgId,
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        ...(file.type === '' ? {} : { declaredMimeType: file.type }),
        source: 'web_upload' as const,
      },
      pipelineDepsFor(store),
      typeof attachToCase === 'string' && /^[0-9a-f-]{36}$/i.test(attachToCase)
        ? { attachToCase }
        : {},
    );

    if (result.case !== undefined) {
      return NextResponse.redirect(new URL(`/cases/${result.case.deductionId}`, request.url), {
        status: 303,
      });
    }

    // No case: either the gate stopped it, or it is evidence with nowhere to go
    // yet. Both are answers rather than errors, and both are said out loud.
    back.searchParams.set(
      'upload',
      result.haltedBecause ??
        `read as a ${result.classification?.docType ?? 'document'}; ` +
          'attach it to a case from that case’s page',
    );
    return NextResponse.redirect(back, { status: 303 });
  } catch (cause) {
    if (cause instanceof RejectedUploadError) {
      // The door, not the pipeline: a file type we do not accept, or bytes that
      // are not what the name claims. Nothing was stored.
      back.searchParams.set('upload', cause.message);
      return NextResponse.redirect(back, { status: 303 });
    }
    throw cause;
  } finally {
    await store.close();
  }
}
