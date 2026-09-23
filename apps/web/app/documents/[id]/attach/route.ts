import { NextResponse, type NextRequest } from 'next/server';
import {
  attachReadDocument,
  CaseNotFoundError,
  DocumentNotFoundError,
  DocumentNotReadError,
} from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { NOTICE_ABOUT_PARAM, type NoticeKey } from '../../../../lib/notices';

/**
 * Files a document that was already read against a case, without reading it
 * again.
 *
 * The recovery for what a reviewer met in production: a delivery receipt and a
 * rate confirmation uploaded from the case list were read, opened nothing —
 * they are evidence, not notices — and then appeared nowhere. The case list now
 * lists them, and this is the button beside each one.
 *
 * It is not a second way into the pipeline. It reads nothing and calls no
 * model: the document's reading is already recorded, a case reads a document's
 * fields by document, and a link is all that is missing (`attachReadDocument`).
 *
 * The role check here is a better error message, not the enforcement. The two
 * things that enforce are underneath it: `app.member_may_write()` asked of the
 * database, and RLS deciding whether this tenant can see the document and the
 * case at all — and refusing the insert if it cannot.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // First, before the session is even looked up: this handler writes to a case,
  // and that is not something another site's page may trigger.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  const back = new URL('/', request.url);

  // What happened travels as a key, never as a sentence (`lib/notices.ts`).
  const say = (notice: NoticeKey): NextResponse => {
    back.searchParams.set('action', notice);
    back.searchParams.delete(NOTICE_ABOUT_PARAM);
    return NextResponse.redirect(back, { status: 303 });
  };

  // A real UUID, not thirty-six characters that look like one: anything else
  // reaches Postgres as a 22P02 and comes back as a 500.
  if (!isUuid(id)) return NextResponse.redirect(back, { status: 303 });
  if (!mayWrite(session.org.role)) return say('attach_role');

  const form = await request.formData();
  const caseId = form.get('caseId');
  if (!isUuid(caseId)) return say('attach_choose_case');

  const store = storeFor(session);
  try {
    // The database's answer, not this app's: the role above is what the
    // session said when it was resolved, and this is what the policies will
    // say when the insert runs.
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return say('attach_role');
    }

    const result = await attachReadDocument(store, { documentId: id, deductionId: caseId });

    // To the case, where the document now is — told whether this press did it
    // or an earlier one had.
    const onCase = new URL(`/cases/${result.deductionId}`, request.url);
    onCase.searchParams.set('action', result.attached ? 'attach_done' : 'attach_already');
    return NextResponse.redirect(onCase, { status: 303 });
  } catch (cause) {
    if (cause instanceof CaseNotFoundError) return say('attach_case_gone');
    if (cause instanceof DocumentNotReadError) return say('attach_not_read');
    if (cause instanceof DocumentNotFoundError) {
      // A stale button, a mistyped id and another tenant's document are one
      // answer, and it says nothing about which.
      return new NextResponse('no such document', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    // A fault, not a refusal. Logged in full where an operator reads logs; the
    // reviewer is told it failed and that nothing was attached, which the one
    // transaction makes true.
    console.error(
      `[recouple] attach: filing document ${id} on case ${caseId} for org ${session.org.orgId} failed`,
      cause,
    );
    return say('attach_failed');
  } finally {
    await store.close();
  }
}
