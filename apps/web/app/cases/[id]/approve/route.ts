import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  DecisionNotFoundError,
  DuplicateApprovalError,
  PacketNotForDecisionError,
  PreparerCannotApproveError,
  WrongCaseStateError,
  WrongRoleError,
} from '@recouple/pipeline';
import { ApprovedPacketMissingError } from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { backToCase, caseNotFound, mayApprove, workflowStoreFor } from '../../../../lib/workflow';

/** Anything a later reader would need. Longer than this is a document. */
const MAX_NOTE = 2000;

/**
 * A second person authorises a specific packet for submission.
 *
 * This is the gate. Everything before it is preparation; the `approvals` row
 * this writes is the only thing that lets a `submissions` row exist at all
 * (`app.require_approval()`, migration 0005 — invariant 1). The three refusals
 * below are the database's own, surfaced by name: the approver may not be the
 * preparer, may not be an analyst, and the case must be awaiting approval.
 *
 * `approverId` is the session's user id and never a form field. Approving is a
 * record of *who* authorised money moving, and a form that could name someone
 * else would make that record worthless.
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
  if (!mayApprove(session.org.role)) {
    return NextResponse.redirect(
      backToCase(
        request.url,
        id,
        'approving is an owner or approver’s act; your role can prepare a case but not authorise it',
      ),
      { status: 303 },
    );
  }

  const form = await request.formData();
  const decisionId = form.get('decisionId');
  const packetId = form.get('packetId');
  if (!isUuid(decisionId) || !isUuid(packetId)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'this case has no assembled packet to approve'),
      { status: 303 },
    );
  }

  const note = form.get('note');
  const said = typeof note === 'string' ? note.trim() : '';

  const store = workflowStoreFor(session);
  try {
    await store.approve({
      decisionId,
      packetId,
      approverId: session.userId,
      ...(said === '' ? {} : { note: said.slice(0, MAX_NOTE) }),
    });
    return NextResponse.redirect(
      backToCase(
        request.url,
        id,
        'approved: this packet may now be filed, and the submission you record must be this packet',
      ),
      { status: 303 },
    );
  } catch (cause) {
    if (cause instanceof PreparerCannotApproveError) {
      // Separation of duties, refused by the database and named here. Not a
      // fault: a preparer looking at their own case and pressing the button
      // their own browser should not have shown them.
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          'you prepared this decision, so you cannot approve it — a second person does that',
        ),
        { status: 303 },
      );
    }
    if (cause instanceof WrongRoleError) {
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          'approving is an owner or approver’s act; your role can prepare a case but not authorise it',
        ),
        { status: 303 },
      );
    }
    if (cause instanceof WrongCaseStateError) {
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          `this case is ${cause.state.replace(/_/g, ' ')}, and an approval is given on a case awaiting one`,
        ),
        { status: 303 },
      );
    }
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof DuplicateApprovalError) {
      // One approval per decision, which the database holds as a unique
      // constraint. A double-clicked button is not a second authorisation.
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          'this packet was already approved; the first approval stands and is the one that counts',
        ),
        { status: 303 },
      );
    }
    if (cause instanceof PacketNotForDecisionError || cause instanceof DecisionNotFoundError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'this case has no assembled packet to approve'),
        { status: 303 },
      );
    }
    if (cause instanceof ApprovedPacketMissingError) {
      // The foreign key onto `packets (decision_id, content_hash)`: an approval
      // may not name a hash nothing was assembled under. Reload and assemble.
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          'no packet with that hash was assembled for this decision — reload the case and assemble it again',
        ),
        { status: 303 },
      );
    }
    throw cause;
  } finally {
    await store.close();
  }
}
