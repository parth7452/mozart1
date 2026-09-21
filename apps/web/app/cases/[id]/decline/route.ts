import { NextResponse, type NextRequest } from 'next/server';
import {
  AlreadyDeclinedError,
  isDeclineReason,
  isMissingEvidence,
  ProvenanceUnknownError,
} from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import {
  DECLINE_DETAIL_MAX_LENGTH,
  NOTICE_ABOUT_PARAM,
  type NoticeKey,
} from '../../../../lib/notices';

/**
 * Records a decision not to fight a case.
 *
 * This is the counterfactual log, not a delete. The case stays; a
 * `declined_candidates` row says what it was worth, what was missing and who
 * decided, because coverage is a ratio of dollars and discarding the losers
 * silently is how that ratio gets flattered (docs/STRATEGY.md, ADD-1).
 *
 * The role check here is a better error message, not the enforcement — the
 * write policy is that, and it would refuse a `read_only` member's insert
 * whatever this handler believed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // First, before the session is even looked up. This handler writes to the
  // counterfactual log, and a write another site can trigger is one nobody
  // asked for. `SameSite=Lax` on the session cookie stops it too; this does not
  // depend on that being true in a file it does not own.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  const back = new URL(`/cases/${id}`, request.url);
  // What happened travels as a key, not as a sentence: the query string is a
  // thing anybody can type, and an app that repeats what it finds there is an
  // app a link can put words into (`lib/notices.ts`).
  // Anything the key cannot say on its own — here, how long the note actually
  // was — follows as `about`, one validated fragment per `{n}`, the same way
  // every other route carries a number into a sentence.
  const say = (notice: NoticeKey, ...about: readonly string[]): NextResponse => {
    back.searchParams.set('decline', notice);
    for (const fragment of about) back.searchParams.append(NOTICE_ABOUT_PARAM, fragment);
    return NextResponse.redirect(back, { status: 303 });
  };

  // A real UUID, not 36 characters that look like one: an id that is the right
  // shape but not a UUID reaches Postgres and comes back as a 500, losing
  // whatever the reviewer typed into the form.
  if (!isUuid(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }
  if (!mayWrite(session.org.role)) {
    return say('decline_role');
  }

  const form = await request.formData();
  const reason = form.get('reason');
  if (!isDeclineReason(reason)) {
    // The database would refuse it too — the enum is there. Saying so here just
    // costs a round trip less.
    return say('decline_reason');
  }

  const detail = form.get('detail');
  const said = typeof detail === 'string' ? detail.trim() : '';
  // Refused, not cut. This note is the whole of why a case was not fought: the
  // `declined_candidates` row is append-only, there is no second chance to
  // explain, and a decline stored with its reasoning stopped mid-sentence reads
  // as a reviewer who only had that much to say. The form's `maxLength` stops a
  // browser getting here; a POST that is not from the form is told the number
  // rather than quietly trimmed to it.
  if (said.length > DECLINE_DETAIL_MAX_LENGTH) {
    return say('decline_detail_too_long', String(said.length));
  }

  // Only the evidence types coverage can add up. The column is a plain
  // `text[]`, so anything else would be stored and then never counted.
  const missing = form.getAll('missing').filter(isMissingEvidence);

  const store = storeFor(session);
  try {
    await store.declineCase({
      deductionId: id,
      reason,
      // Who decided, by the identity the session resolved — never a form field.
      decidedBy: session.email,
      // No `discovered_from` here any more. It used to be hard-coded to
      // `web_upload` on the reasoning that this route is the web app — which
      // was true of the request and not of the case: a notice that arrived by
      // email opens a case a reviewer can see on this same page, and declining
      // it credited the upload channel with a deduction email found. The store
      // derives it from the notice's own `uploads` row and refuses when there
      // is none.
      ...(missing.length > 0 ? { missingEvidence: missing } : {}),
      ...(said === '' ? {} : { detail: said }),
    });
    return say('declined');
  } catch (cause) {
    if (cause instanceof ProvenanceUnknownError) {
      // Nothing was written. The case's notice does not say which channel found
      // it, and `discovered_from` is what coverage is grouped by — so a row
      // stored here would be a number that looks right. Logged with the ids,
      // because this is somebody's to fix rather than the reviewer's, and the
      // reviewer is told plainly that the decline did not happen.
      console.error(
        `[recouple] decline: case ${id} in org ${session.org.orgId} has no recorded provenance`,
        cause,
      );
      return say('decline_no_provenance');
    }
    if (cause instanceof AlreadyDeclinedError) {
      // Not a fault: a second submit of a form that is still on screen. The
      // first decline stands, and saying so beats a 500 or a second row that
      // would count this case's dollars twice.
      return say('decline_already');
    }
    throw cause;
  } finally {
    await store.close();
  }
}
