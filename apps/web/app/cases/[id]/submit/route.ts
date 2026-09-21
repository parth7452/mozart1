import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  ConfirmationNumberRequiredError,
  DuplicateSubmissionError,
  NoApprovalForSubmissionError,
  PacketHashMismatchError,
  PacketNotForDecisionError,
  WrongCaseStateError,
  WrongRoleError,
  type WorkflowSubmissionChannel,
} from '@recouple/pipeline';
import { ApprovalNamesNoPacketError } from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { CONFIRMATION_MAX_LENGTH } from '../../../../lib/notices';
import { backToCase, caseNotFound, sameCase, workflowStoreFor } from '../../../../lib/workflow';

/**
 * The only way a dispute is filed today: a person, on the retailer's portal.
 *
 * Fixed here rather than read from the form. The type has one member, and a
 * caller that could name `email` or `portal_agent` would be naming a way of
 * filing nothing in this system can do (ADR 0020 §6). Widening the type is the
 * change that lands with the channel.
 */
const CHANNEL: WorkflowSubmissionChannel = 'manual_portal';

/** `YYYY-MM-DD`, which is what `<input type="date">` submits, and nothing else. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The years a filing date can plausibly fall in, the same window
 * `parsePrintedDate` holds a date read off a page to (ADR 0019).
 *
 * `0001-01-01` and `9999-12-31` are both four digits and neither is a day
 * anybody filed a dispute on; a year out here is a typo or a paste, and
 * `submitted_at` is what a deadline and a follow-up are counted from.
 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * Parses the date a person says they filed on.
 *
 * Deliberately not `new Date(text)`: that accepts "yesterday-ish" strings, is
 * locale-dependent for some of them, and silently returns an Invalid Date for
 * the rest. This returns undefined and the handler says so — the same rule
 * `parsePrintedDate` follows for a date read off a page (ADR 0019).
 */
function parseSubmittedAt(text: unknown): Date | undefined {
  if (typeof text !== 'string' || !ISO_DATE.test(text)) return undefined;
  const year = Number(text.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return undefined;
  const at = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return undefined;
  // `2026-02-31` parses to March 3rd. A date that is not the date that was
  // typed is not a date we record.
  if (at.toISOString().slice(0, 10) !== text) return undefined;
  return at;
}

/**
 * Records that a human filed the dispute, and what came back as a confirmation.
 *
 * Nothing here sends anything: the filing already happened, on a portal, done
 * by a person. This is the record of it — and the record is only accepted for
 * the packet that was approved. That equality check lives in the store, not in
 * the approval trigger, so the gate keeps carrying exactly one rule (ADR 0020
 * §2); this handler's job is to show the refusal rather than swallow it.
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
  if (!mayWrite(session.org.role)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'submit_role'),
      { status: 303 },
    );
  }

  const form = await request.formData();
  const decisionId = form.get('decisionId');
  const packetId = form.get('packetId');
  const approvalId = form.get('approvalId');
  if (!isUuid(decisionId) || !isUuid(packetId) || !isUuid(approvalId)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'submit_no_approved_packet'),
      { status: 303 },
    );
  }

  const confirmation = form.get('confirmationNumber');
  const reference = typeof confirmation === 'string' ? confirmation.trim() : '';
  if (reference === '') {
    // A filing with no confirmation is a filing nobody can chase. The portal
    // gives one; recording the dispute without it loses the only handle on it.
    return NextResponse.redirect(
      backToCase(request.url, id, 'submit_confirmation'),
      { status: 303 },
    );
  }
  // Refused, not truncated. A confirmation number is the only handle anybody
  // has on a dispute sitting in a retailer's portal, and one silently cut at a
  // length this file invented is a reference that finds nothing — worse than
  // none, because it looks like one.
  if (reference.length > CONFIRMATION_MAX_LENGTH) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'submit_confirmation_too_long', String(reference.length)),
      { status: 303 },
    );
  }

  const submittedAt = parseSubmittedAt(form.get('submittedAt'));
  if (submittedAt === undefined) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'submit_date'),
      { status: 303 },
    );
  }

  const store = workflowStoreFor(session);
  try {
    const { deductionId } = await store.recordSubmission({
      decisionId,
      packetId,
      approvalId,
      channel: CHANNEL,
      confirmationNumber: reference,
      submittedAt,
      actorId: session.userId,
    });
    // The store files against the *decision's* case, which is not necessarily
    // the case in this URL: the ids come off a form, and a stale or forged one
    // can name a decision of another case this tenant owns. A case page showing
    // nothing, under a notice saying the dispute was filed, is the one answer
    // nobody could act on — so the reviewer goes where the filing actually
    // landed, which `recordSubmission` answers with rather than being asked a
    // second time.
    if (!sameCase(deductionId, id)) {
      return NextResponse.redirect(
        backToCase(request.url, deductionId, 'submit_other_case'),
        { status: 303 },
      );
    }
    return NextResponse.redirect(backToCase(request.url, id, 'submitted'), { status: 303 });
  } catch (cause) {
    if (cause instanceof PacketHashMismatchError) {
      // The packet is not the one that was approved. Never a formatting
      // problem: something was re-assembled after approval, and the approval
      // names contents that are no longer what would be filed.
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_packet_mismatch'),
        { status: 303 },
      );
    }
    if (cause instanceof DuplicateSubmissionError) {
      // Not a fault: a form still on screen, submitted twice. The first filing
      // stands, and a second row would be a second dispute for one deduction.
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_duplicate'),
        { status: 303 },
      );
    }
    if (cause instanceof WrongCaseStateError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_wrong_state', cause.state.replace(/_/g, ' ')),
        { status: 303 },
      );
    }
    if (cause instanceof WrongRoleError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_role'),
        { status: 303 },
      );
    }
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof NoApprovalForSubmissionError) {
      // The store asks first so this can be read; the gate asks last and is
      // the one that decides (invariant 1).
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_no_approval'),
        { status: 303 },
      );
    }
    if (cause instanceof ApprovalNamesNoPacketError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_approval_names_no_packet'),
        { status: 303 },
      );
    }
    if (cause instanceof PacketNotForDecisionError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_packet_not_for_decision'),
        { status: 303 },
      );
    }
    if (cause instanceof ConfirmationNumberRequiredError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'submit_confirmation'),
        { status: 303 },
      );
    }
    // Everything else fails loud, and `ApprovalGateRefusedError` deliberately
    // among it: the gate refusing a filing the store had already checked means
    // the two disagree about whether this dispute was approved, and that is
    // not a notice a reviewer should be asked to interpret.
    throw cause;
  } finally {
    await store.close();
  }
}
