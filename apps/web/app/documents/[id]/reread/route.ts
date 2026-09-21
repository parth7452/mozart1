import { NextResponse, type NextRequest } from 'next/server';
import { UnscannedDocumentError } from '@recouple/ingest';
import { DuplicateCaseError } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite, pipelineDepsFor, runnerFromEnv } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { NOTICE_ABOUT_PARAM, type NoticeKey } from '../../../../lib/notices';

/**
 * Asks for a document that was stored and scanned and never read to be read.
 *
 * The recovery path for the failure production showed: an upload stored and
 * announced to the queue, the read function invoked once and never called back
 * to run its step, no error anywhere, and a document sitting in the database
 * that nobody was coming for. Nothing was broken — every step is separately
 * re-runnable — but there was no way to ask for the run again.
 *
 * It is not a second way into the pipeline. It re-drives exactly what the
 * upload would have: the same event to the same function where there is a
 * queue, and the same `readDocumentJob` inline where there is not. And it is
 * safe to press twice, because that job answers a document which already has an
 * extraction from what was recorded, without a model call or a second case.
 *
 * The role check here is a better error message, not the enforcement. The two
 * things that enforce are underneath it: `app.member_may_write()` asked of the
 * database, and RLS deciding whether this tenant can see the document at all.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // First, before the session is even looked up: this handler spends money
  // reading a document, and that is not something another site's page may
  // trigger. `SameSite=Lax` stops it too; this does not depend on that being
  // true in a file it does not own.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  const back = new URL('/', request.url);

  // What happened travels as a key, never as a sentence: the query string is a
  // thing anybody can type, and an app that repeats what it finds there is an
  // app a link can put words into (`lib/notices.ts`).
  const say = (notice: NoticeKey): NextResponse => {
    back.searchParams.set('reread', notice);
    back.searchParams.delete(NOTICE_ABOUT_PARAM);
    return NextResponse.redirect(back, { status: 303 });
  };

  // A real UUID, not thirty-six characters that look like one: anything else
  // reaches Postgres as a 22P02 and comes back to the reviewer as a 500.
  if (!isUuid(id)) {
    return NextResponse.redirect(back, { status: 303 });
  }
  if (!mayWrite(session.org.role)) {
    return say('reread_role');
  }

  const store = storeFor(session);
  try {
    // The database's answer, not this app's. A job would ask it too — but where
    // there is a queue the job runs somewhere else and minutes later, so asking
    // here is what stops the button queueing work for a member who may not
    // write, rather than finding out after the event has been sent.
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return say('reread_role');
    }

    // Is this document one this tenant can see? RLS decides, and it decides by
    // the document not being there — so a stale button, a mistyped id and
    // another tenant's document are one answer and it says nothing about which.
    // This costs a fetch of the bytes, which is the price of asking the store a
    // question it already answers rather than adding a narrower one for a
    // button somebody presses by hand.
    const document = await store.getDocument(id);
    if (document === undefined) {
      return new NextResponse('no such document', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const outcome = await runnerFromEnv().reread(id, pipelineDepsFor(store), {
      orgId: session.org.orgId,
      actor: { userId: session.userId },
    });

    if (outcome.kind === 'queued') return say('reread_queued');
    if (outcome.kind === 'not_queued') return say('reread_not_queued');

    // It ran here. Which of the three things it did is read off the result
    // rather than off a sentence another package built.
    if (outcome.result.alreadyRead) return say('reread_already_read');
    return say('reread_done');
  } catch (cause) {
    if (cause instanceof UnscannedDocumentError) {
      // The gate, between the list being drawn and the button being pressed.
      // Nothing was read (invariant 4), and the reviewer is told so.
      return say('reread_not_scanned_clean');
    }
    if (cause instanceof DuplicateCaseError) {
      // The claim on the page is already a case. Not a fault: the notice
      // arrived twice, as a PDF and then as a scan. The document and everything
      // read from it are stored; no second case was opened (ADR 0019).
      return say('reread_duplicate_case');
    }
    // Everything else is a fault, not a refusal — a vendor down, a model call
    // that failed, the database blinking. It is logged here in full, where an
    // operator reads logs, and the reviewer is told it failed rather than
    // handed a 500 that looks like the button does not exist. Nothing is
    // swallowed: the run did not happen and does not claim to have.
    console.error(
      `[recouple] reread: reading document ${id} for org ${session.org.orgId} failed`,
      cause,
    );
    return say('reread_failed');
  } finally {
    await store.close();
  }
}
