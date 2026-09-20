import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseNotFoundError,
  DuplicateCaseError,
  RejectedUploadError,
} from '@recouple/pipeline';
import { requireSession, storeFor } from '../../lib/session';
import { mayWrite, pipelineDepsFor, runnerFromEnv } from '../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../lib/request';

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
 *
 * Since ADR 0021 the read is not necessarily *here*. The refusals above are,
 * and so are the bytes and the scan; where the classify-and-extract half runs
 * is `runnerFromEnv`'s answer, and the only difference this handler sees is
 * whether it has a case to send the reviewer to or a sentence saying one is
 * coming.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // First, before the session is even looked up: this handler ingests a file
  // and spends money reading it, and neither should be reachable from another
  // site's page. `SameSite=Lax` on the session cookie stops it too; this does
  // not depend on that being true in a file it does not own.
  if (isCrossSite(request)) return refuseCrossSite();

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

  // Read before anything can fail on the file: a reviewer who was attaching
  // evidence to a case is sent back to that case, not to the list. Without this
  // a rejected file drops them on `/` holding a message telling them to attach
  // it from the case page they were just on.
  const attachToCase = form.get('attachToCase');
  const attachingTo = isUuid(attachToCase) ? attachToCase : undefined;
  if (attachingTo !== undefined) back.pathname = `/cases/${attachingTo}`;

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

  const store = storeFor(session);
  try {
    const outcome = await runnerFromEnv().run(
      {
        orgId: session.org.orgId,
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        ...(file.type === '' ? {} : { declaredMimeType: file.type }),
        source: 'web_upload' as const,
      },
      pipelineDepsFor(store),
      {
        actor: { userId: session.userId },
        ...(attachingTo !== undefined ? { attachToCase: attachingTo } : {}),
      },
    );

    if (outcome.kind === 'queued') {
      // The document is stored and scanned clean and a job is reading it. There
      // is no case id yet — the claim id is on a page nobody has read — so the
      // reviewer goes back where they came from, told what is happening rather
      // than sent to a case that does not exist for another minute.
      back.searchParams.set(
        'upload',
        attachingTo !== undefined
          ? 'that document is being read; it will appear on this case when it is'
          : 'that document is being read; the case will appear here when it is',
      );
      return NextResponse.redirect(back, { status: 303 });
    }

    if (outcome.kind === 'not_queued') {
      // Stored and scanned, but the queue would not take it. Saying "it is
      // being read" would be a lie, and a 500 would suggest the upload itself
      // failed when the document is safely in the database. So it says what is
      // true and what to do about it — and the same file re-uploaded dedupes to
      // this same document and is queued again.
      back.searchParams.set(
        'upload',
        'that document is stored but could not be queued for reading just now; ' +
          'it will be read when the queue is reachable — uploading the same file again re-queues it',
      );
      return NextResponse.redirect(back, { status: 303 });
    }

    if (outcome.kind === 'halted') {
      // The scan gate, in the runner that does not read here either. Stored,
      // scanned, not read, and said out loud (invariant 4).
      back.searchParams.set('upload', outcome.haltedBecause);
      return NextResponse.redirect(back, { status: 303 });
    }

    const result = outcome.result;
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
    if (cause instanceof CaseNotFoundError) {
      // A case id that is a UUID and is not a case this tenant can see: stale,
      // wrong, or another tenant's. The pipeline refuses it before it reads
      // anything, so nothing was stored and nothing was spent. Back to the
      // list, because the case page they were sent from is not theirs to
      // return to — and never told which of those it was.
      const list = new URL('/', request.url);
      list.searchParams.set(
        'upload',
        'that case is no longer available; nothing was uploaded',
      );
      return NextResponse.redirect(list, { status: 303 });
    }
    if (cause instanceof DuplicateCaseError) {
      // The same claim, already a case. Not an error the reviewer can act on and
      // not a fault either: the notice arrived twice — as a PDF and then as a
      // scan, say, which are different bytes and so are not deduplicated by
      // hash — and the second one was read before the database said so.
      //
      // The document and everything read from it are stored; the case is the
      // one that already exists, so that is where the reviewer is sent, told
      // why. Merging the two readings into one case is identity resolution's
      // job (ADR 0019, STRATEGY §5.2), not this handler's.
      const existing = new URL(`/cases/${cause.existingDeductionId}`, request.url);
      existing.searchParams.set(
        'upload',
        `claim ${cause.claimId} is already this case; the document was read but no second case was opened`,
      );
      return NextResponse.redirect(existing, { status: 303 });
    }
    throw cause;
  } finally {
    await store.close();
  }
}
