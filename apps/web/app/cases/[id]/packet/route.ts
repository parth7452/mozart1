import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  DecisionNotForCaseError,
  DecisionNotFoundError,
  NothingToSendError,
  PacketAfterApprovalError,
  PacketNotBuildableError,
  WrongCaseStateError,
  WrongRoleError,
} from '@recouple/pipeline';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { noticeSentence } from '../../../../lib/notices';
import { backToCase, caseNotFound, workflowStoreFor } from '../../../../lib/workflow';

/**
 * Assembles the packet a human will be asked to approve.
 *
 * Our code builds it — the notice, the evidence attached to the case, and a
 * dispute letter composed from already-extracted, already-quote-verified
 * fields. No model reads anything here, which is why the content hash is a pure
 * function of the case and why approving *that hash* means something (ADR 0020
 * §2).
 *
 * Assembling the same contents twice returns the same packet rather than
 * failing, so a reviewer who double-submits the form has not made a second
 * packet. `unique (decision_id, content_hash)` is what makes that true.
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
      backToCase(request.url, id, 'packet_role'),
      { status: 303 },
    );
  }

  const form = await request.formData();
  const decisionId = form.get('decisionId');
  // The decision this packet is for travels with the form, from the workflow
  // the page already read. A shape that is not a UUID would reach Postgres as
  // a 500 and lose the click.
  if (!isUuid(decisionId)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'packet_no_decision'),
      { status: 303 },
    );
  }

  const store = workflowStoreFor(session);
  try {
    const packet = await store.assemblePacket({
      deductionId: id,
      decisionId,
      assembledBy: session.userId,
    });
    const files = packet.fileDocumentIds.length;
    const hash = packet.contentHash.slice(0, 12);
    return NextResponse.redirect(
      files === 1
        ? backToCase(request.url, id, 'packet_assembled_one', hash)
        : backToCase(request.url, id, 'packet_assembled', String(files), hash),
      { status: 303 },
    );
  } catch (cause) {
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof DecisionNotFoundError || cause instanceof DecisionNotForCaseError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'packet_no_decision'),
        { status: 303 },
      );
    }
    if (cause instanceof NothingToSendError) {
      // A packet with no notice is an envelope with nothing in it. The
      // reviewer can fix this: attach the notice and assemble again.
      return NextResponse.redirect(
        backToCase(request.url, id, 'packet_nothing_to_send'),
        { status: 303 },
      );
    }
    if (cause instanceof PacketAfterApprovalError) {
      // One approval per decision, so a packet assembled now could never be
      // authorised — it would sit beside an approval naming the one it
      // replaced. Said here rather than left to puzzle a reviewer at filing.
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          'packet_after_approval',
          cause.approvedPacketHash.slice(0, 12),
        ),
        { status: 303 },
      );
    }
    if (cause instanceof PacketNotBuildableError) {
      // The store's own words when they are words this app will repeat, and a
      // notice that says so plainly when they are not. Never the raw detail:
      // it travels through a query string, and what comes back out of one is
      // not necessarily what went in.
      const why = noticeSentence(cause.detail);
      return NextResponse.redirect(
        why === undefined
          ? backToCase(request.url, id, 'packet_not_buildable_unsaid')
          : backToCase(request.url, id, 'packet_not_buildable', why),
        { status: 303 },
      );
    }
    if (cause instanceof WrongCaseStateError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'packet_wrong_state', cause.state.replace(/_/g, ' ')),
        { status: 303 },
      );
    }
    if (cause instanceof WrongRoleError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'packet_role'),
        { status: 303 },
      );
    }
    throw cause;
  } finally {
    await store.close();
  }
}

/**
 * The dispute letter, as the plain text our code composed — the packet's
 * narrative byte for byte, which is what the approval's hash covers. The
 * printable view is `./letter`, and the enclosures are `./enclosures`.
 *
 * Tenant-scoped the only way anything here is: `getWorkflow` runs as `app_rw`
 * with this session's claims, so a case another tenant owns is *absent* rather
 * than forbidden, and the answer is a 404 that says nothing about whether it
 * exists. No signed URL, no bucket, same argument as the document route (ADR
 * 0014).
 *
 * Served as an attachment, `nosniff`, with everything denied: the narrative
 * quotes text read off somebody else's document, and a file the browser is
 * willing to render is a file that text can be markup in.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return caseNotFound();

  const session = await requireSession();
  const store = workflowStoreFor(session);
  try {
    const workflow = await store.getWorkflow(id);
    const packet = workflow?.packet;
    // No packet and no case look the same on purpose: one of them is a case
    // this session may not see, and which one is not this route's to say.
    if (packet === undefined) return caseNotFound();

    return new NextResponse(packet.narrative, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="dispute-letter-${id.slice(0, 8)}.txt"`,
        // A packet is what a human is about to authorise. It is not something a
        // shared cache should hold, and a stale copy of it is worse than none.
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (cause) {
    // Same answer as no packet, for the same reason: a case another tenant
    // owns is absent, and saying which of the two it was would be saying it
    // exists.
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    throw cause;
  } finally {
    await store.close();
  }
}
