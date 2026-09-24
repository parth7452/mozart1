import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseMergedAwayError,
  DocumentAlreadyOnCaseError,
  DocumentBusyError,
  DocumentNotFoundError,
  DocumentNotHeldError,
  DocumentNotReadError,
  DuplicateCaseError,
  HeldReadingUnusableError,
  openHeldDocument,
  WrongRoleError,
} from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { NOTICE_ABOUT_PARAM, type NoticeKey } from '../../../../lib/notices';

/**
 * Opens a case from a document a read held for a person (ADR 0044).
 *
 * A notice or a remittance whose classifier was below this workspace's floor
 * was read, recorded and held rather than opening a case on its own. It sits
 * under "Read, not on a case" with what the classifier said, and this is the
 * button beside it: a person looked, and says it is what it was read as.
 *
 * It is not a second way into the pipeline. It reads nothing and calls no
 * model: the recorded reading is restored and handed to the same functions the
 * read would have used (`openHeldDocument`), and the case says who confirmed it.
 *
 * The role check here is a better error message, not the enforcement. What
 * enforces is underneath it: `app.member_may_write()` asked of the database,
 * RLS deciding whether this tenant can see the document, and migration 0030's
 * policy refusing the release's audit row to anybody but a writer acting as
 * themselves.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // First, before the session is even looked up: this handler opens a case,
  // and that is not something another site's page may trigger.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  const back = new URL('/', request.url);

  // What happened travels as a key, never as a sentence (`lib/notices.ts`).
  const say = (notice: NoticeKey, ...about: readonly string[]): NextResponse => {
    back.searchParams.set('action', notice);
    back.searchParams.delete(NOTICE_ABOUT_PARAM);
    for (const fragment of about) back.searchParams.append(NOTICE_ABOUT_PARAM, fragment);
    return NextResponse.redirect(back, { status: 303 });
  };
  /** To a case, told what happened there. */
  const toCase = (deductionId: string, notice: NoticeKey): NextResponse => {
    const onCase = new URL(`/cases/${deductionId}`, request.url);
    onCase.searchParams.set('action', notice);
    return NextResponse.redirect(onCase, { status: 303 });
  };

  // A real UUID, not thirty-six characters that look like one: anything else
  // reaches Postgres as a 22P02 and comes back as a 500.
  if (!isUuid(id)) return NextResponse.redirect(back, { status: 303 });
  if (!mayWrite(session.org.role)) return say('open_held_role');

  const store = storeFor(session);
  try {
    // The database's answer, not this app's: the role above is what the
    // session said when it was resolved, and this is what the policies will
    // say when the case is opened.
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return say('open_held_role');
    }

    // A stale button, a mistyped id and another tenant's document are one
    // answer, and it says nothing about which. `select 1`, not the bytes.
    if (!(await store.documentIsVisible(id))) {
      return new NextResponse('no such document', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // The person is the session's member, never a form field: the case records
    // them as the one who confirmed a doubted reading.
    const result = await openHeldDocument(store, {
      orgId: session.org.orgId,
      documentId: id,
      confirmedBy: session.userId,
    });

    // ADR 0040's shape: exactly one case — opened or joined — is somewhere to
    // send the reviewer; several is the list, told how many; none is the list,
    // told why.
    const cases = [
      ...new Set([...result.opened.map((c) => c.deductionId), ...result.mergedInto]),
    ];
    if (cases.length === 1) return toCase(cases[0] as string, 'open_held_done');
    if (cases.length > 1) return say('open_held_cases', String(cases.length));
    return say('open_held_none');
  } catch (cause) {
    if (cause instanceof WrongRoleError) return say('open_held_role');
    if (cause instanceof DocumentAlreadyOnCaseError) {
      // A second press, or a press after somebody else's: the case exists, and
      // that is where the reviewer is sent.
      return toCase(cause.deductionId, 'open_held_already');
    }
    if (cause instanceof DocumentNotHeldError) return say('open_held_not_held');
    if (cause instanceof HeldReadingUnusableError) return say('open_held_unusable');
    if (cause instanceof DocumentBusyError) return say('open_held_busy');
    if (cause instanceof DocumentNotReadError) return say('open_held_not_read');
    if (cause instanceof DuplicateCaseError) {
      // The claim on the page is already a case. Not a fault: the hold stands,
      // and the document can go on that case as evidence (ADR 0019).
      return toCase(cause.existingDeductionId, 'open_held_duplicate');
    }
    // A line matched a case that was merged into another (ADR 0042, `RCM01`).
    if (cause instanceof CaseMergedAwayError) return say('open_held_case_merged');
    if (cause instanceof DocumentNotFoundError) {
      return new NextResponse('no such document', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    // A fault, not a refusal. Logged in full where an operator reads logs; the
    // reviewer is told it failed and that nothing was read again, which is true
    // whatever failed — nothing on this path can call a model.
    console.error(
      `[recouple] open held: opening a case from document ${id} for org ${session.org.orgId} failed`,
      cause,
    );
    return say('open_held_failed');
  } finally {
    await store.close();
  }
}
