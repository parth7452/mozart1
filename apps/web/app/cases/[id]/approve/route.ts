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
import { NOTE_MAX_LENGTH } from '../../../../lib/notices';
import {
  backToCase,
  backToList,
  caseNotFound,
  mayApprove,
  workflowStoreFor,
} from '../../../../lib/workflow';

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
      backToCase(request.url, id, 'approve_role'),
      { status: 303 },
    );
  }

  const form = await request.formData();
  const decisionId = form.get('decisionId');
  const packetId = form.get('packetId');
  if (!isUuid(decisionId) || !isUuid(packetId)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'approve_no_packet'),
      { status: 303 },
    );
  }

  const note = form.get('note');
  const said = typeof note === 'string' ? note.trim() : '';
  // Refused, not shortened. An approval's note is part of the record of who
  // authorised money moving, and a note silently cut at a length this file
  // invented would put words on that record that nobody finished writing. The
  // form's `maxLength` stops a browser getting here; a POST that is not from
  // the form is told the number rather than quietly trimmed to it.
  if (said.length > NOTE_MAX_LENGTH) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'approve_note_too_long', String(said.length)),
      { status: 303 },
    );
  }

  const store = workflowStoreFor(session);
  try {
    const { approvalId } = await store.approve({
      decisionId,
      packetId,
      approverId: session.userId,
      ...(said === '' ? {} : { note: said }),
    });
    // The store approves the *packet's* case, which is not necessarily the case
    // in this URL: the ids come off a form, and a stale or forged one can name
    // a decision of another case this tenant owns. The write is right either
    // way — the store read the decision, not the path — but sending the
    // reviewer back to the path's case would show them a case where nothing
    // happened, with a notice saying it did.
    const landed = await store.getWorkflow(id);
    if (landed?.approval?.approvalId !== approvalId) {
      return NextResponse.redirect(backToList(request.url, 'approve_other_case'), {
        status: 303,
      });
    }
    return NextResponse.redirect(backToCase(request.url, id, 'approved'), { status: 303 });
  } catch (cause) {
    if (cause instanceof PreparerCannotApproveError) {
      // Separation of duties, refused by the database and named here. Not a
      // fault: a preparer looking at their own case and pressing the button
      // their own browser should not have shown them.
      return NextResponse.redirect(
        backToCase(request.url, id, 'approve_is_preparer'),
        { status: 303 },
      );
    }
    if (cause instanceof WrongRoleError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'approve_role'),
        { status: 303 },
      );
    }
    if (cause instanceof WrongCaseStateError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'approve_wrong_state', cause.state.replace(/_/g, ' ')),
        { status: 303 },
      );
    }
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof DuplicateApprovalError) {
      // One approval per decision, which the database holds as a unique
      // constraint. A double-clicked button is not a second authorisation.
      return NextResponse.redirect(
        backToCase(request.url, id, 'approve_duplicate'),
        { status: 303 },
      );
    }
    if (cause instanceof PacketNotForDecisionError || cause instanceof DecisionNotFoundError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'approve_no_packet'),
        { status: 303 },
      );
    }
    if (cause instanceof ApprovedPacketMissingError) {
      // The foreign key onto `packets (decision_id, content_hash)`: an approval
      // may not name a hash nothing was assembled under. Reload and assemble.
      return NextResponse.redirect(
        backToCase(request.url, id, 'approve_packet_missing'),
        { status: 303 },
      );
    }
    throw cause;
  } finally {
    await store.close();
  }
}
