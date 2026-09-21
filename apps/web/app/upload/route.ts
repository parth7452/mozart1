import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseNotFoundError,
  DuplicateCaseError,
  RejectedUploadError,
} from '@recouple/pipeline';
import { requireSession, storeFor } from '../../lib/session';
import { mayWrite, pipelineDepsFor, runnerFromEnv } from '../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../lib/request';
import {
  NOTICE_ABOUT_PARAM,
  UPLOAD_MAX_BYTES as MAX_BYTES,
  noticeClaimId,
  uploadRejectionNotice,
  type NoticeKey,
} from '../../lib/notices';

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

  /**
   * What happened, as a key out of `lib/notices.ts` and never as a sentence.
   *
   * A notice used to travel as its own words, which made every page that shows
   * one a place a link could put words into — including the words of a
   * document somebody else wrote, since a rejection names the file and a
   * duplicate names the claim id off the page. A key cannot be anything but
   * one of ours, and what a key cannot say on its own follows as `about`, one
   * validated fragment per `{n}`.
   */
  const say = (notice: NoticeKey, ...about: readonly string[]): NextResponse => {
    back.searchParams.set('upload', notice);
    back.searchParams.delete(NOTICE_ABOUT_PARAM);
    for (const fragment of about) back.searchParams.append(NOTICE_ABOUT_PARAM, fragment);
    return NextResponse.redirect(back, { status: 303 });
  };

  if (!mayWrite(session.org.role)) {
    return say('upload_role');
  }

  // Before the body is touched. `formData()` materialises the whole upload in
  // memory, so checking the size after parsing is checking it after the damage:
  // a 5 GB POST would already be buffered by the time we looked.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES + FORM_OVERHEAD_BYTES) {
    return say('upload_too_large');
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
    return say('upload_no_file');
  }
  // Again on the real size: `content-length` is the client's claim, and a
  // chunked request does not send one at all.
  if (file.size > MAX_BYTES) {
    return say('upload_too_large');
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
      return say(attachingTo !== undefined ? 'upload_queued_case' : 'upload_queued_list');
    }

    if (outcome.kind === 'not_queued') {
      // Stored and scanned, but the queue would not take it. Saying "it is
      // being read" would be a lie, and a 500 would suggest the upload itself
      // failed when the document is safely in the database. So it says what is
      // true and what to do about it — and the same file re-uploaded dedupes to
      // this same document and is queued again.
      return say('upload_not_queued');
    }

    if (outcome.kind === 'already_read') {
      // These bytes are a document this tenant already has and has already
      // read, so nothing was queued. The reviewer goes where the inline path
      // sends them — to the case that first read opened, when it opened one —
      // rather than being told a read is coming that is not.
      return outcome.case === undefined
        ? say('upload_already_read')
        : NextResponse.redirect(new URL(`/cases/${outcome.case.deductionId}`, request.url), {
            status: 303,
          });
    }

    if (outcome.kind === 'halted') {
      // The scan gate, in the runner that does not read here either. Stored,
      // scanned, not read, and said out loud (invariant 4). `ingestForJob`
      // halts for the gate and for nothing else, so the key is the gate's.
      return say('upload_not_scanned_clean');
    }

    const result = outcome.result;
    if (result.case !== undefined) {
      return NextResponse.redirect(new URL(`/cases/${result.case.deductionId}`, request.url), {
        status: 303,
      });
    }

    // No case: the gate stopped it, this document had already been read, or it
    // is evidence with nowhere to go yet. All three are answers rather than
    // errors, and all three are said out loud. Which one it was is read off the
    // verdict and the classification rather than off the sentence the pipeline
    // built — a route that matched on another package's wording would go on
    // compiling after that wording changed.
    if (result.ingest.verdict.status !== 'clean') return say('upload_not_scanned_clean');
    if (result.haltedBecause !== undefined) return say('upload_already_read');
    const docType = result.classification?.docType;
    return docType === undefined
      ? say('upload_read_no_case')
      : say('upload_read_as', docType.replace(/_/g, ' '));
  } catch (cause) {
    if (cause instanceof RejectedUploadError) {
      // The door, not the pipeline: a file type we do not accept, or bytes that
      // are not what the name claims. Nothing was stored. The refusal travels
      // by its `code`, which is a closed union — its `message` is a sentence
      // built around a filename somebody else chose, and this app does not put
      // that in a URL and read it back out.
      return say(uploadRejectionNotice(cause.code));
    }
    if (cause instanceof CaseNotFoundError) {
      // A case id that is a UUID and is not a case this tenant can see: stale,
      // wrong, or another tenant's. The pipeline refuses it before it reads
      // anything, so nothing was stored and nothing was spent. Back to the
      // list, because the case page they were sent from is not theirs to
      // return to — and never told which of those it was.
      back.pathname = '/';
      return say('upload_case_gone');
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
      back.pathname = `/cases/${cause.existingDeductionId}`;
      // The claim id was read off somebody else's document. It is shown when it
      // is the shape of a claim id and left out when it is not — the notice
      // still says what happened either way.
      const claim = noticeClaimId(cause.claimId);
      return claim === undefined
        ? say('upload_duplicate_case_unsaid')
        : say('upload_duplicate_case', claim);
    }
    throw cause;
  } finally {
    await store.close();
  }
}
