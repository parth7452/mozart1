import { NextResponse, type NextRequest } from 'next/server';
import { isCanonicalReasonCode } from '@recouple/core-domain';
import {
  CaseAlreadyDeclinedError,
  CaseNotVisibleError,
  NotACanonicalReasonError,
  RationaleRequiredError,
  RationaleTooLongError,
  WrongCaseStateError,
  WrongRoleError,
} from '@recouple/pipeline';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { backToCase, caseNotFound, workflowStoreFor } from '../../../../lib/workflow';

/**
 * A human decides to dispute a deduction.
 *
 * This is the first thing in the system that writes a `decisions` row nobody
 * modelled: `provider = 'human'`, `prepared_by` the analyst, no probabilities
 * (ADR 0020 §1). It is not the gate and does not cross it — a decision is what
 * an approval later points at, and the database refuses a submission that has
 * no approval for this exact decision whatever this handler does.
 *
 * `preparedBy` is the session's user id and never a form field. The database
 * refuses a human decision that names anyone but its caller
 * (`app.human_decision_names_its_author()`), so a forged author is a refusal
 * rather than a lie in the column separation of duties reads — but a handler
 * that took the id from the form would be asking for that refusal.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // First, before the session is looked up: this writes to a money path, and a
  // write another site can trigger is one nobody asked for.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();

  // A real UUID, not thirty-six characters shaped like one — the loose pattern
  // reaches Postgres as a 22P02 and comes back as a 500.
  if (!isUuid(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }
  if (!mayWrite(session.org.role)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'your role can review cases but not decide them'),
      { status: 303 },
    );
  }

  const form = await request.formData();
  const reason = form.get('reason');
  // The canonical taxonomy is the referee. A retailer's own code maps onto one
  // of these; a code that is not one of them would be stored and never counted.
  if (typeof reason !== 'string' || !isCanonicalReasonCode(reason)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'choose the reason this deduction is invalid'),
      { status: 303 },
    );
  }

  const rationale = form.get('rationale');
  const said = typeof rationale === 'string' ? rationale.trim() : '';
  if (said === '') {
    return NextResponse.redirect(
      backToCase(request.url, id, 'say in one line why this deduction is worth disputing'),
      { status: 303 },
    );
  }

  const store = workflowStoreFor(session);
  try {
    await store.recordHumanDecision({
      deductionId: id,
      preparedBy: session.userId,
      reason,
      // Not truncated here. The one cap that matters is the packet narrative's
      // (`MAX_RATIONALE_LENGTH`), and the store refuses an over-long rationale
      // by name *before* the decision is written — silently cutting a money
      // path's words at some number this file invented would put a rationale on
      // the record that nobody typed.
      rationale: said,
    });
    return NextResponse.redirect(
      backToCase(
        request.url,
        id,
        'recorded: this case is yours to assemble a packet for. Nothing has been sent.',
      ),
      { status: 303 },
    );
  } catch (cause) {
    // RLS working, not a fault: a case of another tenant's is absent.
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof CaseAlreadyDeclinedError) {
      // The counterfactual log already counts this case as one we gave up on.
      // Both at once would move the one number that log exists to produce, and
      // reversing a decline is a decision of its own that does not exist yet.
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          'this case was declined, and a declined case is not disputed — the decline stands',
        ),
        { status: 303 },
      );
    }
    if (cause instanceof WrongCaseStateError) {
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          `this case is ${cause.state.replace(/_/g, ' ')}, and a decision is made from a case that has been classified`,
        ),
        { status: 303 },
      );
    }
    if (cause instanceof WrongRoleError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'your role can review cases but not decide them'),
        { status: 303 },
      );
    }
    if (cause instanceof RationaleRequiredError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'say in one line why this deduction is worth disputing'),
        { status: 303 },
      );
    }
    if (cause instanceof RationaleTooLongError) {
      // Refused before the decision is written, which is the point: `decisions`
      // is append-only, so a rationale the packet could not hold would wedge
      // the case in `analyst_review` with nothing able to move it.
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          `that rationale is ${cause.length} characters and the cover sheet holds ${cause.maxLength} — shorten it`,
        ),
        { status: 303 },
      );
    }
    if (cause instanceof NotACanonicalReasonError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'choose the reason this deduction is invalid'),
        { status: 303 },
      );
    }
    // Fail loud. A decision that did not happen must not redirect back looking
    // like one that did: `decisions` is append-only, so a missing row is not
    // something a later write repairs. `ActorIsNotTheSessionError` is here on
    // purpose — this handler always names the session's own user, so it can
    // only mean a bug, and a bug on a money path is not a notice.
    throw cause;
  } finally {
    await store.close();
  }
}
