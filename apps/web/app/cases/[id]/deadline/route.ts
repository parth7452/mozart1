import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  DeadlineAlreadySetError,
  DeadlineBasisRequiredError,
  DeadlineBasisTooLongError,
  DeadlineOutOfRangeError,
  WrongCaseStateError,
  WrongRoleError,
  type DeadlineRefusal,
} from '@recouple/pipeline';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import type { NoticeKey } from '../../../../lib/notices';
import { backToCase, caseNotFound, workflowStoreFor } from '../../../../lib/workflow';

/** Which notice each way a date is refused reads as. */
const REFUSED: Readonly<Record<DeadlineRefusal, NoticeKey>> = {
  not_a_date: 'deadline_not_a_date',
  in_the_past: 'deadline_in_the_past',
  too_far_out: 'deadline_too_far',
};

/**
 * A person enters the dispute deadline a case has none of (pilot E6).
 *
 * Remittance-line and ledger cases never carry one, and most notices print
 * none, so the review queue ranks them by age. This writes the date and the
 * basis a person read it from — `deductions.dispute_deadline`, only where it
 * is null, and a `case.deadline_set` event — in one transaction in the store.
 * A printed deadline is never overwritten: the store refuses by name.
 *
 * The role check and `memberMayWrite` are a better error message, not the
 * enforcement: the row lock the store takes is gated by `tenant_update`, which
 * asks `app.member_may_write()` itself.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Before the session is looked up: this moves where a case ranks, and a
  // write another site can trigger is one nobody asked for.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  if (!isUuid(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }
  const back = (notice: NoticeKey, ...about: readonly string[]): NextResponse =>
    NextResponse.redirect(backToCase(request.url, id, notice, ...about), { status: 303 });

  if (!mayWrite(session.org.role)) return back('deadline_role');

  const form = await request.formData();
  const deadline = form.get('deadline');
  const basis = form.get('basis');
  // Shape only; the store judges the date. A field that is not text is not a
  // date, and a missing basis is the store's named refusal too.
  if (typeof deadline !== 'string' || deadline === '') return back('deadline_not_a_date');
  if (typeof basis !== 'string') return back('deadline_basis_required');

  const store = workflowStoreFor(session);
  try {
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return back('deadline_role');
    }
    await store.setDisputeDeadline({
      deductionId: id,
      deadline,
      basis,
      // The session's own user, never a form field; the store refuses anyone else.
      setBy: session.userId,
    });
    return back('deadline_set', deadline);
  } catch (cause) {
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof WrongRoleError) return back('deadline_role');
    if (cause instanceof DeadlineAlreadySetError) return back('deadline_already');
    if (cause instanceof DeadlineOutOfRangeError) return back(REFUSED[cause.refusal]);
    if (cause instanceof DeadlineBasisRequiredError) return back('deadline_basis_required');
    if (cause instanceof DeadlineBasisTooLongError) {
      return back('deadline_basis_too_long', String(cause.length));
    }
    if (cause instanceof WrongCaseStateError) {
      return back('deadline_wrong_state', cause.state.replace(/_/g, ' '));
    }
    // Fail loud: a deadline that was not recorded must not come back looking
    // like one that was.
    throw cause;
  } finally {
    await store.close();
  }
}
