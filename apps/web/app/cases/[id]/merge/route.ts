import { NextResponse, type NextRequest } from 'next/server';
import { CaseNotVisibleError, MergeRefusedError, WrongRoleError } from '@recouple/pipeline';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import type { NoticeKey } from '../../../../lib/notices';
import { backToCase, caseNotFound, workflowStoreFor } from '../../../../lib/workflow';

/**
 * Merges a pair somebody already said is one deduction (ADR 0042).
 *
 * "Same deduction" merges in the same click when it can; this is the button for
 * the pairs it could not — confirmed before merging existed, or refused then and
 * allowed now (another merge undone, say). The database picks which case
 * survives, refuses what the rules refuse, moves the copy to `merged` and writes
 * both timelines; the store inserts one row and names what came back.
 *
 * The role check here is a better error message, not the enforcement:
 * `app.member_may_write()` is asked of the database before anything is written,
 * again by the row lock the store takes, and again by the insert policy.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Before the session is looked up: this changes two money-bearing cases, and
  // a write another site can trigger is one nobody asked for.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  if (!isUuid(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }
  const back = (notice: NoticeKey): NextResponse =>
    NextResponse.redirect(backToCase(request.url, id, notice), { status: 303 });

  if (!mayWrite(session.org.role)) return back('merge_role');

  const form = await request.formData();
  const other = form.get('other');
  if (!isUuid(other)) return back('merge_unknown_pair');

  const store = workflowStoreFor(session);
  try {
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return back('merge_role');
    }
    await store.mergeConfirmedDuplicate({
      deductionId: id,
      otherDeductionId: other,
      // The session's own user, never a form field; the store and the database
      // both refuse anyone else.
      mergedBy: session.userId,
    });
    return back('merge_done');
  } catch (cause) {
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof WrongRoleError) return back('merge_role');
    // The database said no, and why; the case page shows the reason beside the
    // pair, so the notice only has to say nothing changed.
    if (cause instanceof MergeRefusedError) return back('merge_refused');
    // Fail loud: a merge that did not happen must not come back looking like one
    // that did.
    throw cause;
  } finally {
    await store.close();
  }
}
