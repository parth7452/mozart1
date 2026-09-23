import { NextResponse, type NextRequest } from 'next/server';
import { CaseNotVisibleError, MergeRefusedError, WrongRoleError } from '@recouple/pipeline';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import type { NoticeKey } from '../../../../lib/notices';
import { backToCase, caseNotFound, workflowStoreFor } from '../../../../lib/workflow';

/**
 * Undoes the merge of this case into another (ADR 0042 §5).
 *
 * One `unmerge` row: the database puts the case back exactly where it was and
 * withdraws the "same deduction" verdict, so the pair is an open question again
 * rather than a pair that says "one deduction" and can never be merged. Once
 * per pair — the database refuses a second.
 *
 * The path names the merged-away case; the case it was merged into comes from
 * the database, not the form, so there is nothing here to point at the wrong
 * one.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  if (!isUuid(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }
  const back = (notice: NoticeKey): NextResponse =>
    NextResponse.redirect(backToCase(request.url, id, notice), { status: 303 });

  if (!mayWrite(session.org.role)) return back('merge_role');

  const store = workflowStoreFor(session);
  try {
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return back('merge_role');
    }
    await store.undoMerge({ deductionId: id, undoneBy: session.userId });
    return back('merge_undone');
  } catch (cause) {
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof WrongRoleError) return back('merge_role');
    if (cause instanceof MergeRefusedError) return back('merge_not_merged');
    throw cause;
  } finally {
    await store.close();
  }
}
